'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const v8 = require('node:v8');

const {
  DISPATCH_STATES,
  MUTABLE_TRANSITION_FIELDS,
  isActiveState,
  isMutableTransitionField,
  isAllowedLifecycleTransition,
  ERROR_CODES
} = require('./contracts');

const DEFAULT_DB_DIR = path.join(os.homedir(), '.orchestrator');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'lifecycle.sqlite3');
const SCHEMA_VERSION = 1;

/**
 * Deserializes and detaches SQLite database row into standard dispatch record.
 * Uses v8.deserialize for lossless reconstruction of complex JS types.
 */
function rowToDispatch(row) {
  if (!row) return null;
  const dispatch = {
    dispatch_id: row.dispatch_id,
    project_id: row.project_id,
    work_order_id: row.work_order_id,
    expected_workspace_state_id: row.expected_workspace_state_id !== null ? row.expected_workspace_state_id : null,
    request_fingerprint: row.request_fingerprint,
    directive: row.directive,
    audit_metadata: row.audit_metadata !== null && row.audit_metadata !== undefined
      ? v8.deserialize(row.audit_metadata)
      : null,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (row.error !== null && row.error !== undefined) {
    dispatch.error = row.error;
  }
  if (row.diagnostics !== null && row.diagnostics !== undefined) {
    dispatch.diagnostics = v8.deserialize(row.diagnostics);
  }
  return dispatch;
}

/**
 * Deserializes and detaches SQLite history row.
 */
function rowToHistory(row) {
  if (!row) return null;
  return {
    project_id: row.project_id,
    dispatch_id: row.dispatch_id,
    work_order_id: row.work_order_id,
    previous_state: row.previous_state !== null ? row.previous_state : null,
    next_state: row.next_state,
    timestamp: row.timestamp,
    iso: row.iso,
    patch: row.patch !== null && row.patch !== undefined ? v8.deserialize(row.patch) : {}
  };
}

/**
 * Factory for creating a durable SQLite-backed lifecycle store (WO-V3-006P).
 *
 * Implements the exact broker lifecycle store contract while persisting state
 * to disk across separate processes, providing cross-process one-active
 * enforcement via a partial UNIQUE index, and guaranteeing write-ahead durability.
 */
function createSqliteLifecycleStore(options = {}) {
  const clock = options.clock || {
    now: () => Date.now(),
    iso: () => new Date().toISOString()
  };

  const dbPath = options.dbPath || options.path || DEFAULT_DB_PATH;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Open database connection
  const db = new DatabaseSync(dbPath);

  // Best-effort POSIX permissions (Section 28)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {}
  }

  // Local durability and concurrency settings (Section 27)
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA journal_mode = WAL;');

  // Schema version & integrity verification (Sections 8, 29)
  const userVersionRow = db.prepare('PRAGMA user_version').get();
  const userVersion = userVersionRow ? userVersionRow.user_version : 0;

  const tableCheckStmt = db.prepare(
    "SELECT count(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'dispatches'"
  );
  const hasDispatchesTable = tableCheckStmt.get().cnt > 0;

  if (!hasDispatchesTable) {
    if (userVersion !== 0) {
      db.close();
      throw new Error(`Unsupported schema version: expected 0 for uninitialized DB, found ${userVersion}`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        expected_workspace_state_id TEXT,
        request_fingerprint TEXT NOT NULL,
        directive TEXT NOT NULL,
        audit_metadata BLOB,
        state TEXT NOT NULL,
        error TEXT,
        diagnostics BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_project ON dispatches(project_id)
      WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');

      CREATE TABLE IF NOT EXISTS history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        iso TEXT NOT NULL,
        patch BLOB
      );

      PRAGMA user_version = 1;
    `);
  } else {
    // Existing database: schema version must be exactly 1 (Section 8)
    if (userVersion !== SCHEMA_VERSION) {
      db.close();
      throw new Error(`Unsupported schema version: expected ${SCHEMA_VERSION}, found ${userVersion}`);
    }

    // Fail closed if required schema objects are missing (Section 29)
    const historyCheck = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'history'"
    ).get();
    const indexCheck = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type = 'index' AND name = 'idx_active_project'"
    ).get();

    if (historyCheck.cnt === 0 || indexCheck.cnt === 0) {
      db.close();
      throw new Error('Database is missing required schema objects (history table or idx_active_project index)');
    }
  }

  // Prepared Statements
  const getDispatchStmt = db.prepare(
    `SELECT seq, dispatch_id, project_id, work_order_id, expected_workspace_state_id,
            request_fingerprint, directive, audit_metadata, state, error, diagnostics,
            created_at, updated_at
     FROM dispatches
     WHERE dispatch_id = ?`
  );

  const getActiveDispatchStmt = db.prepare(
    `SELECT seq, dispatch_id, project_id, work_order_id, expected_workspace_state_id,
            request_fingerprint, directive, audit_metadata, state, error, diagnostics,
            created_at, updated_at
     FROM dispatches
     WHERE project_id = ? AND state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN')
     LIMIT 1`
  );

  const getLatestDispatchStmt = db.prepare(
    `SELECT seq, dispatch_id, project_id, work_order_id, expected_workspace_state_id,
            request_fingerprint, directive, audit_metadata, state, error, diagnostics,
            created_at, updated_at
     FROM dispatches
     WHERE project_id = ?
     ORDER BY seq DESC
     LIMIT 1`
  );

  const insertDispatchStmt = db.prepare(
    `INSERT INTO dispatches (
       dispatch_id, project_id, work_order_id, expected_workspace_state_id,
       request_fingerprint, directive, audit_metadata, state, error, diagnostics,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const updateDispatchStmt = db.prepare(
    `UPDATE dispatches
     SET state = ?, updated_at = ?, error = ?, diagnostics = ?
     WHERE dispatch_id = ?`
  );

  const insertHistoryStmt = db.prepare(
    `INSERT INTO history (
       project_id, dispatch_id, work_order_id, previous_state, next_state,
       timestamp, iso, patch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const getProjectHistoryStmt = db.prepare(
    `SELECT project_id, dispatch_id, work_order_id, previous_state, next_state,
            timestamp, iso, patch
     FROM history
     WHERE project_id = ?
     ORDER BY history_seq ASC`
  );

  const getAllHistoryStmt = db.prepare(
    `SELECT project_id, dispatch_id, work_order_id, previous_state, next_state,
            timestamp, iso, patch
     FROM history
     ORDER BY history_seq ASC`
  );

  let closed = false;

  function ensureOpen() {
    if (closed) {
      throw new Error('Database is closed');
    }
  }

  function getDispatch(dispatchId) {
    ensureOpen();
    if (!dispatchId || typeof dispatchId !== 'string') return null;
    const row = getDispatchStmt.get(dispatchId);
    return row ? rowToDispatch(row) : null;
  }

  function getActiveDispatch(projectId) {
    ensureOpen();
    if (!projectId || typeof projectId !== 'string') return null;
    const row = getActiveDispatchStmt.get(projectId);
    return row ? rowToDispatch(row) : null;
  }

  function getLatestDispatch(projectId) {
    ensureOpen();
    if (!projectId || typeof projectId !== 'string') return null;
    const row = getLatestDispatchStmt.get(projectId);
    return row ? rowToDispatch(row) : null;
  }

  /**
   * Atomic Begin Dispatch (Sections 11-13)
   * Executes inside a single SQLite write transaction:
   * 1. Checks dispatch ID collision.
   * 2. Inspects active project dispatch for idempotent replay, duplicate conflict, or worker busy.
   * 3. Inserts dispatch record as DISPATCHING.
   * 4. Inserts history record.
   * 5. Commits before returning (write-ahead guarantee).
   */
  function beginDispatch(projectId, record) {
    ensureOpen();
    if (!record || typeof record !== 'object') {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Record must be a non-null object'
      };
    }

    if (record.project_id !== projectId) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
        error: `Project identity mismatch: argument '${projectId}' does not match record '${record.project_id}'`
      };
    }

    try {
      db.exec('BEGIN IMMEDIATE');

      // 1. Dispatch ID collision check
      const existingById = getDispatchStmt.get(record.dispatch_id);
      if (existingById) {
        db.exec('ROLLBACK');
        return {
          ok: false,
          code: ERROR_CODES.DISPATCH_ID_COLLISION,
          error: `Dispatch ID collision: '${record.dispatch_id}' already exists in lifecycle store`
        };
      }

      // 2. Active dispatch check
      const activeRow = getActiveDispatchStmt.get(projectId);
      if (activeRow) {
        const activeRecord = rowToDispatch(activeRow);
        if (activeRecord.work_order_id === record.work_order_id) {
          if (activeRecord.request_fingerprint === record.request_fingerprint) {
            db.exec('ROLLBACK');
            return {
              ok: false,
              code: ERROR_CODES.IDEMPOTENT_REPLAY,
              existing: activeRecord
            };
          }
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT,
            error: `WorkOrder '${record.work_order_id}' is already active with different parameters`,
            existing: activeRecord
          };
        }
        db.exec('ROLLBACK');
        return {
          ok: false,
          code: ERROR_CODES.WORKER_BUSY,
          error: `Project '${projectId}' currently has active dispatch '${activeRecord.dispatch_id}' (${activeRecord.state})`,
          existing: activeRecord
        };
      }

      // 3. Lossless serialization of structured fields (Section 10)
      let auditBlob = null;
      if (record.audit_metadata !== undefined && record.audit_metadata !== null) {
        auditBlob = v8.serialize(record.audit_metadata);
      }
      let diagBlob = null;
      if (record.diagnostics !== undefined && record.diagnostics !== null) {
        diagBlob = v8.serialize(record.diagnostics);
      }
      const expectedWs = record.expected_workspace_state_id !== undefined
        ? record.expected_workspace_state_id
        : null;
      const errorVal = record.error !== undefined ? record.error : null;
      const nowIso = clock.iso();
      const nowTs = clock.now();

      // 4. Insert dispatch as DISPATCHING
      insertDispatchStmt.run(
        record.dispatch_id,
        projectId,
        record.work_order_id,
        expectedWs,
        record.request_fingerprint,
        record.directive,
        auditBlob,
        DISPATCH_STATES.DISPATCHING,
        errorVal,
        diagBlob,
        nowIso,
        nowIso
      );

      // 5. Insert initial history row
      const emptyPatchBlob = v8.serialize({});
      insertHistoryStmt.run(
        projectId,
        record.dispatch_id,
        record.work_order_id,
        null,
        DISPATCH_STATES.DISPATCHING,
        nowTs,
        nowIso,
        emptyPatchBlob
      );

      db.exec('COMMIT');

      const savedRow = getDispatchStmt.get(record.dispatch_id);
      return {
        ok: true,
        dispatch: rowToDispatch(savedRow)
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}

      // Handle race condition caught by SQLite UNIQUE constraint on idx_active_project
      if (err.message && err.message.includes('idx_active_project')) {
        try {
          const activeRow = getActiveDispatchStmt.get(projectId);
          if (activeRow) {
            const activeRecord = rowToDispatch(activeRow);
            if (activeRecord.work_order_id === record.work_order_id) {
              if (activeRecord.request_fingerprint === record.request_fingerprint) {
                return {
                  ok: false,
                  code: ERROR_CODES.IDEMPOTENT_REPLAY,
                  existing: activeRecord
                };
              }
              return {
                ok: false,
                code: ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT,
                error: `WorkOrder '${record.work_order_id}' is already active with different parameters`,
                existing: activeRecord
              };
            }
            return {
              ok: false,
              code: ERROR_CODES.WORKER_BUSY,
              error: `Project '${projectId}' currently has active dispatch '${activeRecord.dispatch_id}' (${activeRecord.state})`,
              existing: activeRecord
            };
          }
        } catch {}
      }

      if (err.message && err.message.includes('dispatches.dispatch_id')) {
        return {
          ok: false,
          code: ERROR_CODES.DISPATCH_ID_COLLISION,
          error: `Dispatch ID collision: '${record.dispatch_id}' already exists in lifecycle store`
        };
      }

      throw err;
    }
  }

  /**
   * Transition Dispatch State (Sections 18-20)
   * Atomically validates patch allowlist, transition legality against shared authority,
   * updates state + mutable fields, records history, and commits.
   */
  function transition(dispatchId, nextState, patch = {}) {
    ensureOpen();
    // 1. Allowlist validation for transition patches
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(patch)) {
        if (!isMutableTransitionField(key)) {
          return {
            ok: false,
            code: ERROR_CODES.IMMUTABLE_FIELD_VIOLATION,
            field: key,
            error: `Cannot mutate field '${key}': only authorized mutable transition fields [${MUTABLE_TRANSITION_FIELDS.join(', ')}] are permitted`
          };
        }
      }
    }

    try {
      db.exec('BEGIN IMMEDIATE');

      const row = getDispatchStmt.get(dispatchId);
      if (!row) {
        db.exec('ROLLBACK');
        return {
          ok: false,
          code: ERROR_CODES.DISPATCH_NOT_FOUND,
          error: `Dispatch '${dispatchId}' not found`
        };
      }

      if (!isAllowedLifecycleTransition(row.state, nextState)) {
        db.exec('ROLLBACK');
        return {
          ok: false,
          code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
          currentState: row.state,
          targetState: nextState,
          error: `Illegal state transition: cannot transition from '${row.state}' to '${nextState}'`
        };
      }

      const previousState = row.state;
      const nowIso = clock.iso();
      const nowTs = clock.now();

      let newError = row.error;
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'error')) {
        newError = patch.error !== undefined ? patch.error : null;
      }

      let newDiagBlob = row.diagnostics;
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'diagnostics')) {
        newDiagBlob = patch.diagnostics !== undefined && patch.diagnostics !== null
          ? v8.serialize(patch.diagnostics)
          : null;
      }

      updateDispatchStmt.run(nextState, nowIso, newError, newDiagBlob, dispatchId);

      const patchBlob = v8.serialize(patch ? patch : {});
      insertHistoryStmt.run(
        row.project_id,
        row.dispatch_id,
        row.work_order_id,
        previousState,
        nextState,
        nowTs,
        nowIso,
        patchBlob
      );

      db.exec('COMMIT');

      const updatedRow = getDispatchStmt.get(dispatchId);
      return {
        ok: true,
        dispatch: rowToDispatch(updatedRow)
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function getProjectHistory(projectId) {
    ensureOpen();
    if (!projectId || typeof projectId !== 'string') return [];
    const rows = getProjectHistoryStmt.all(projectId);
    return rows.map(rowToHistory);
  }

  function getAllHistory() {
    ensureOpen();
    const rows = getAllHistoryStmt.all();
    return rows.map(rowToHistory);
  }

  function close() {
    if (!closed) {
      closed = true;
      db.close();
    }
  }

  return {
    isDurable: true,
    getDispatch,
    getActiveDispatch,
    getLatestDispatch,
    beginDispatch,
    transition,
    getProjectHistory,
    getAllHistory,
    close
  };
}

module.exports = {
  createSqliteLifecycleStore
};

'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const v8 = require('node:v8');

const {
  DISPATCH_STATES,
  ACTIVE_STATES,
  MUTABLE_TRANSITION_FIELDS,
  isActiveState,
  isMutableTransitionField,
  isAllowedLifecycleTransition,
  isRecognizedLifecycleState,
  ERROR_CODES
} = require('./contracts');

const DEFAULT_DB_DIR = path.join(os.homedir(), '.orchestrator');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'lifecycle.sqlite3');
const SCHEMA_VERSION = 1;
const ACTIVE_STATES_SQL = ACTIVE_STATES.map(s => `'${s}'`).join(', ');

/**
 * Deserializes and detaches SQLite database row into standard dispatch record.
 * Uses v8.deserialize for lossless reconstruction of complex JS types.
 * Supports backward-compatibility with plain string error values.
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
    dispatch.error = typeof row.error === 'string' ? row.error : v8.deserialize(row.error);
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
 * Validates table shapes (columns) for dispatches and history tables (LCAUTH-02).
 */
function validateSchemaShape(db) {
  const dispatchesTableInfo = db.prepare("PRAGMA table_info('dispatches')").all();
  if (!dispatchesTableInfo || dispatchesTableInfo.length === 0) {
    throw new Error("Required table 'dispatches' is missing");
  }
  const dispatchCols = new Set(dispatchesTableInfo.map(c => c.name));
  const requiredDispatchCols = [
    'seq', 'dispatch_id', 'project_id', 'work_order_id',
    'expected_workspace_state_id', 'request_fingerprint', 'directive',
    'audit_metadata', 'state', 'error', 'diagnostics',
    'created_at', 'updated_at'
  ];
  for (const col of requiredDispatchCols) {
    if (!dispatchCols.has(col)) {
      throw new Error(`Required dispatch column '${col}' is missing`);
    }
  }

  const historyTableInfo = db.prepare("PRAGMA table_info('history')").all();
  if (!historyTableInfo || historyTableInfo.length === 0) {
    throw new Error("Required table 'history' is missing");
  }
  const historyCols = new Set(historyTableInfo.map(c => c.name));
  const requiredHistoryCols = [
    'history_seq', 'project_id', 'dispatch_id', 'work_order_id',
    'previous_state', 'next_state', 'timestamp', 'iso', 'patch'
  ];
  for (const col of requiredHistoryCols) {
    if (!historyCols.has(col)) {
      throw new Error(`Required history column '${col}' is missing`);
    }
  }
}

/**
 * Validates that idx_active_project is UNIQUE, partial, on project_id,
 * and covers exactly the authoritative active states (LCAUTH-02).
 */
function validateActiveIndex(db) {
  const idxList = db.prepare("PRAGMA index_list('dispatches')").all();
  const activeIdx = idxList.find(i => i.name === 'idx_active_project');
  if (!activeIdx) {
    throw new Error("Required index 'idx_active_project' is missing");
  }
  if (activeIdx.unique !== 1) {
    throw new Error("Index 'idx_active_project' must be UNIQUE");
  }
  if (activeIdx.partial !== 1) {
    throw new Error("Index 'idx_active_project' must be a partial index");
  }

  const idxInfo = db.prepare("PRAGMA index_info('idx_active_project')").all();
  if (!idxInfo || idxInfo.length !== 1 || idxInfo[0].name !== 'project_id') {
    throw new Error("Index 'idx_active_project' must index exactly 'project_id'");
  }

  const masterRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_active_project'").get();
  if (!masterRow || !masterRow.sql) {
    throw new Error("Cannot retrieve SQL definition for 'idx_active_project'");
  }

  const match = masterRow.sql.match(/WHERE\s+state\s+IN\s*\(([^)]+)\)/i);
  if (!match) {
    throw new Error("Index 'idx_active_project' must contain a partial WHERE clause on state IN (...)");
  }
  const indexStates = match[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .sort();
  const expectedStates = [...ACTIVE_STATES].sort();
  if (indexStates.length !== expectedStates.length || !indexStates.every((s, i) => s === expectedStates[i])) {
    throw new Error(`Index 'idx_active_project' predicate must match exact ACTIVE_STATES [${expectedStates.join(', ')}], found [${indexStates.join(', ')}]`);
  }
}

/**
 * Validates open-time semantic integrity of all persisted dispatches and history rows (LCAUTH-01).
 */
function validatePersistedSemantics(db) {
  const dispatches = db.prepare('SELECT * FROM dispatches').all();
  const activeDispatchesByProject = new Map();

  for (const row of dispatches) {
    if (!isRecognizedLifecycleState(row.state)) {
      throw new Error(`Corrupt database: dispatch '${row.dispatch_id}' has unrecognized state '${row.state}'`);
    }

    if (row.audit_metadata !== null && row.audit_metadata !== undefined) {
      try {
        v8.deserialize(row.audit_metadata);
      } catch (err) {
        throw new Error(`Corrupt database: dispatch '${row.dispatch_id}' has corrupt audit_metadata: ${err.message}`);
      }
    }
    if (row.diagnostics !== null && row.diagnostics !== undefined) {
      try {
        v8.deserialize(row.diagnostics);
      } catch (err) {
        throw new Error(`Corrupt database: dispatch '${row.dispatch_id}' has corrupt diagnostics: ${err.message}`);
      }
    }
    if (row.error !== null && row.error !== undefined && typeof row.error !== 'string') {
      try {
        v8.deserialize(row.error);
      } catch (err) {
        throw new Error(`Corrupt database: dispatch '${row.dispatch_id}' has corrupt error blob: ${err.message}`);
      }
    }

    if (isActiveState(row.state)) {
      if (activeDispatchesByProject.has(row.project_id)) {
        throw new Error(`Corrupt database: project '${row.project_id}' has multiple active dispatches ('${activeDispatchesByProject.get(row.project_id)}' and '${row.dispatch_id}')`);
      }
      activeDispatchesByProject.set(row.project_id, row.dispatch_id);
    }
  }

  const historyRows = db.prepare('SELECT * FROM history ORDER BY history_seq ASC').all();
  const historyByDispatch = new Map();

  for (const h of historyRows) {
    if (!isRecognizedLifecycleState(h.next_state)) {
      throw new Error(`Corrupt database: history row '${h.history_seq}' has unrecognized next_state '${h.next_state}'`);
    }
    if (h.previous_state !== null && h.previous_state !== undefined && !isRecognizedLifecycleState(h.previous_state)) {
      throw new Error(`Corrupt database: history row '${h.history_seq}' has unrecognized previous_state '${h.previous_state}'`);
    }
    if (h.patch !== null && h.patch !== undefined) {
      try {
        v8.deserialize(h.patch);
      } catch (err) {
        throw new Error(`Corrupt database: history row '${h.history_seq}' has corrupt patch blob: ${err.message}`);
      }
    }
    if (!historyByDispatch.has(h.dispatch_id)) {
      historyByDispatch.set(h.dispatch_id, []);
    }
    historyByDispatch.get(h.dispatch_id).push(h);
  }

  // Consistency check (Section 26)
  for (const d of dispatches) {
    const dHist = historyByDispatch.get(d.dispatch_id);
    if (!dHist || dHist.length === 0) {
      throw new Error(`Corrupt database: dispatch '${d.dispatch_id}' has no matching history entries`);
    }
    const latestHist = dHist[dHist.length - 1];
    if (latestHist.next_state !== d.state) {
      throw new Error(`Corrupt database: dispatch '${d.dispatch_id}' state '${d.state}' disagrees with latest history next_state '${latestHist.next_state}'`);
    }
    if (latestHist.project_id !== d.project_id || latestHist.work_order_id !== d.work_order_id) {
      throw new Error(`Corrupt database: dispatch '${d.dispatch_id}' identity disagrees with history identity`);
    }
  }
}

/**
 * Factory for creating a durable SQLite-backed lifecycle store (WO-V3-006PF).
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
  } else if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath);

    // Best-effort POSIX permissions on database file (Section 27)
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {}
    }

    // Connection-local durability pragmas (Section 17)
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = FULL;');

    // Schema inspection
    const userVersionRow = db.prepare('PRAGMA user_version').get();
    const userVersion = userVersionRow ? userVersionRow.user_version : 0;

    const userObjects = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
    ).all();

    if (userObjects.length === 0) {
      if (userVersion !== 0) {
        throw new Error(`Corrupt database: empty schema with unsupported user_version (${userVersion})`);
      }

      // Genuinely fresh DB: initialize schema transactionally (Section 16)
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE dispatches (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            dispatch_id TEXT NOT NULL UNIQUE,
            project_id TEXT NOT NULL,
            work_order_id TEXT NOT NULL,
            expected_workspace_state_id TEXT,
            request_fingerprint TEXT NOT NULL,
            directive TEXT NOT NULL,
            audit_metadata BLOB,
            state TEXT NOT NULL,
            error BLOB,
            diagnostics BLOB,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id)
          WHERE state IN (${ACTIVE_STATES_SQL});

          CREATE TABLE history (
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
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    } else {
      // Existing DB: check user_version (Section 15, 32 / LCAUTH-03)
      if (userVersion === 0) {
        throw new Error('Corrupt or partial database: user_version is 0 but user schema objects exist');
      }
      if (userVersion !== SCHEMA_VERSION) {
        throw new Error(`Unsupported schema version: expected ${SCHEMA_VERSION}, found ${userVersion}`);
      }

      // Physical integrity check (Section 8)
      const qc = db.prepare('PRAGMA quick_check').get();
      if (!qc || qc.quick_check !== 'ok') {
        throw new Error(`Database physical integrity check failed: ${qc ? qc.quick_check : 'null'}`);
      }

      // Shape validation (Section 12 / LCAUTH-02)
      validateSchemaShape(db);

      // Active index validation (Section 13 / LCAUTH-02)
      validateActiveIndex(db);

      // Semantic authority validation (Section 7, 25, 26 / LCAUTH-01)
      validatePersistedSemantics(db);
    }

    // Apply persistent WAL mode ONLY after successful validation (Section 17)
    db.exec('PRAGMA journal_mode = WAL;');

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
       WHERE project_id = ? AND state IN (${ACTIVE_STATES_SQL})
       LIMIT 1`
    );

    const getProjectDispatchesStmt = db.prepare(
      `SELECT seq, dispatch_id, project_id, work_order_id, expected_workspace_state_id,
              request_fingerprint, directive, audit_metadata, state, error, diagnostics,
              created_at, updated_at
       FROM dispatches
       WHERE project_id = ?`
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
      if (!row) return null;
      if (!isRecognizedLifecycleState(row.state)) {
        throw new Error(`Lifecycle store corruption: dispatch '${dispatchId}' has unrecognized state '${row.state}'`);
      }
      return rowToDispatch(row);
    }

    /**
     * Active dispatch lookup (LCAUTH-01 / Section 9, 11).
     * Inspects all dispatches for project. Fails closed on any unknown state.
     * Never returns null/IDLE if a corrupt row exists.
     */
    function getActiveDispatch(projectId) {
      ensureOpen();
      if (!projectId || typeof projectId !== 'string') return null;
      const projectRows = getProjectDispatchesStmt.all(projectId);
      let activeRow = null;

      for (const row of projectRows) {
        if (!isRecognizedLifecycleState(row.state)) {
          throw new Error(`Lifecycle store corruption: project '${projectId}' contains dispatch '${row.dispatch_id}' with invalid state '${row.state}'`);
        }
        if (isActiveState(row.state)) {
          if (activeRow) {
            throw new Error(`Lifecycle store corruption: project '${projectId}' contains multiple active dispatches ('${activeRow.dispatch_id}' and '${row.dispatch_id}')`);
          }
          activeRow = row;
        }
      }

      return activeRow ? rowToDispatch(activeRow) : null;
    }

    function getLatestDispatch(projectId) {
      ensureOpen();
      if (!projectId || typeof projectId !== 'string') return null;
      const projectRows = getProjectDispatchesStmt.all(projectId);
      for (const row of projectRows) {
        if (!isRecognizedLifecycleState(row.state)) {
          throw new Error(`Lifecycle store corruption: project '${projectId}' contains dispatch '${row.dispatch_id}' with invalid state '${row.state}'`);
        }
      }
      const row = getLatestDispatchStmt.get(projectId);
      return row ? rowToDispatch(row) : null;
    }

    /**
     * Atomic Begin Dispatch (LCAUTH-01 / Section 10).
     * Inside BEGIN IMMEDIATE transaction, validates persisted state domain for project.
     * If any row has unknown state, rolls back and fails closed without inserting.
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

        // 1. Validate all existing project rows for corruption (Section 10)
        const projectRows = getProjectDispatchesStmt.all(projectId);
        let activeRow = null;

        for (const pRow of projectRows) {
          if (!isRecognizedLifecycleState(pRow.state)) {
            db.exec('ROLLBACK');
            throw new Error(`Lifecycle store corruption: project '${projectId}' contains dispatch '${pRow.dispatch_id}' with invalid state '${pRow.state}'`);
          }
          if (isActiveState(pRow.state)) {
            if (activeRow) {
              db.exec('ROLLBACK');
              throw new Error(`Lifecycle store corruption: project '${projectId}' contains multiple active dispatches`);
            }
            activeRow = pRow;
          }
        }

        // 2. Dispatch ID collision check
        const existingById = getDispatchStmt.get(record.dispatch_id);
        if (existingById) {
          if (!isRecognizedLifecycleState(existingById.state)) {
            db.exec('ROLLBACK');
            throw new Error(`Lifecycle store corruption: existing dispatch '${record.dispatch_id}' has invalid state '${existingById.state}'`);
          }
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.DISPATCH_ID_COLLISION,
            error: `Dispatch ID collision: '${record.dispatch_id}' already exists in lifecycle store`
          };
        }

        // 3. Active dispatch check
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

        // 4. Lossless serialization of structured fields (Sections 10, 19 / LCAUTH-04)
        let auditBlob = null;
        if (record.audit_metadata !== undefined && record.audit_metadata !== null) {
          auditBlob = v8.serialize(record.audit_metadata);
        }
        let diagBlob = null;
        if (record.diagnostics !== undefined && record.diagnostics !== null) {
          diagBlob = v8.serialize(record.diagnostics);
        }
        let errorBlob = null;
        if (record.error !== undefined && record.error !== null) {
          errorBlob = v8.serialize(record.error);
        }
        const expectedWs = record.expected_workspace_state_id !== undefined
          ? record.expected_workspace_state_id
          : null;
        const nowIso = clock.iso();
        const nowTs = clock.now();

        // 5. Insert dispatch as DISPATCHING
        insertDispatchStmt.run(
          record.dispatch_id,
          projectId,
          record.work_order_id,
          expectedWs,
          record.request_fingerprint,
          record.directive,
          auditBlob,
          DISPATCH_STATES.DISPATCHING,
          errorBlob,
          diagBlob,
          nowIso,
          nowIso
        );

        // 6. Insert initial history row
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
     * Transition Dispatch State (Sections 18-20, LCAUTH-04).
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

        if (!isRecognizedLifecycleState(row.state)) {
          db.exec('ROLLBACK');
          throw new Error(`Lifecycle store corruption: dispatch '${dispatchId}' has invalid current state '${row.state}'`);
        }

        if (!isRecognizedLifecycleState(nextState)) {
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
            currentState: row.state,
            targetState: nextState,
            error: `Illegal state transition: unrecognized target state '${nextState}'`
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
          newError = patch.error !== undefined ? v8.serialize(patch.error) : null;
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
      for (const h of rows) {
        if (!isRecognizedLifecycleState(h.next_state) ||
            (h.previous_state !== null && !isRecognizedLifecycleState(h.previous_state))) {
          throw new Error(`Lifecycle store corruption: history contains invalid state for project '${projectId}'`);
        }
      }
      return rows.map(rowToHistory);
    }

    function getAllHistory() {
      ensureOpen();
      const rows = getAllHistoryStmt.all();
      for (const h of rows) {
        if (!isRecognizedLifecycleState(h.next_state) ||
            (h.previous_state !== null && !isRecognizedLifecycleState(h.previous_state))) {
          throw new Error('Lifecycle store corruption: history contains invalid state');
        }
      }
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
  } catch (err) {
    if (db) {
      try {
        db.close();
      } catch {}
    }
    throw err;
  }
}

module.exports = {
  createSqliteLifecycleStore
};

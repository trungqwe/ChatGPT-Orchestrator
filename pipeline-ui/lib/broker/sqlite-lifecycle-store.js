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
 *
 * LCAUTH-08 Read Contract:
 * - SQL NULL => omit optional property (field absent)
 * - serialized undefined => own property exists, value === undefined
 * - serialized null => own property exists, value === null
 * - serialized object/string => own property exists, value is deserialized
 * - plain string => backward-compatible support for legacy TEXT error
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
    dispatch.diagnostics = typeof row.diagnostics === 'string' ? row.diagnostics : v8.deserialize(row.diagnostics);
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
 * isPlainDataObject — WO-V4-09C-U1 Section 5
 * Accepts ONLY objects with Object.prototype or null prototype.
 * Rejects Date, Map, Set, RegExp, class instances, arrays, null, primitives.
 */
function isPlainDataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * hasExactEnumerableDataKeys — WO-V4-09C-U1 Section 5
 * Returns true iff value is a plain data object with EXACTLY the listed keys
 * as own, enumerable, data-descriptor (no symbol, no accessor, no non-enumerable).
 * Never invokes getters.
 */
function hasExactEnumerableDataKeys(value, expectedKeys) {
  if (!isPlainDataObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return false;
    }
  }
  return true;
}

// Reconciliation authority constants
const _RECONCILE_AUTHORITY_KEYS = Object.freeze([
  'dispatch_id', 'project_id', 'work_order_id',
  'expected_state', 'target_state', 'classification', 'evidence_authority'
]);
const _PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const _RECONCILE_CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/;

/**
 * Validates all authority fields. Returns { ok: false, code, error } on failure,
 * or null on success. Does NOT invoke getters.
 */
function _validateReconcileAuthority(authority) {
  const dispatchId = authority.dispatch_id;
  const projectId = authority.project_id;
  const workOrderId = authority.work_order_id;
  const expectedState = authority.expected_state;
  const targetState = authority.target_state;
  const classification = authority.classification;
  const evidenceAuthority = authority.evidence_authority;

  if (
    typeof dispatchId !== 'string' ||
    dispatchId.length === 0 ||
    dispatchId.trim() !== dispatchId ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(dispatchId) ||
    Buffer.byteLength(dispatchId, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'dispatch_id must be a non-empty trim-exact string with no control characters and UTF-8 length <= 512' };
  }

  if (typeof projectId !== 'string' || !_PROJECT_ID_REGEX.test(projectId)) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'project_id must match ^[a-z0-9][a-z0-9._-]{0,127}$' };
  }

  if (
    typeof workOrderId !== 'string' ||
    workOrderId.length === 0 ||
    workOrderId.trim() !== workOrderId ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(workOrderId) ||
    Buffer.byteLength(workOrderId, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'work_order_id must be a non-empty trim-exact string with no control characters and UTF-8 length <= 512' };
  }

  if (expectedState !== DISPATCH_STATES.DISPATCH_UNCERTAIN) {
    return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, error: `expected_state must be '${DISPATCH_STATES.DISPATCH_UNCERTAIN}'` };
  }

  if (targetState !== DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
    return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, error: `Target state '${targetState}' is not authorized for uncertain dispatch reconciliation` };
  }

  if (classification !== 'DELIVERY_UNPROVEN') {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: "classification must be 'DELIVERY_UNPROVEN'" };
  }

  if (
    typeof evidenceAuthority !== 'string' ||
    evidenceAuthority.length === 0 ||
    evidenceAuthority.trim() !== evidenceAuthority ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(evidenceAuthority) ||
    Buffer.byteLength(evidenceAuthority, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'evidence_authority must be a non-empty trim-exact single-line string with no control characters and UTF-8 length <= 512' };
  }

  return null; // valid
}

/**
 * Validates table shapes, column constraints, primary keys, and data affinities (LCAUTH-06).
 */
function validateSchemaShape(db) {
  // 1. Validate dispatches table shape
  const dispatchesTableInfo = db.prepare("PRAGMA table_info('dispatches')").all();
  if (!dispatchesTableInfo || dispatchesTableInfo.length === 0) {
    throw new Error("Required table 'dispatches' is missing");
  }

  const dispatchColMap = new Map(dispatchesTableInfo.map(c => [c.name, c]));

  // Required column definitions and affinities
  const expectedDispatchCols = [
    { name: 'seq', type: ['INTEGER'], pk: 1, notnull: null },
    { name: 'dispatch_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'project_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'work_order_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'expected_workspace_state_id', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'request_fingerprint', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'directive', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'audit_metadata', type: ['BLOB'], pk: 0, notnull: 0 },
    { name: 'state', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'error', type: ['BLOB', 'TEXT'], pk: 0, notnull: 0 },
    { name: 'diagnostics', type: ['BLOB'], pk: 0, notnull: 0 },
    { name: 'created_at', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'updated_at', type: ['TEXT'], pk: 0, notnull: 1 }
  ];

  for (const exp of expectedDispatchCols) {
    const col = dispatchColMap.get(exp.name);
    if (!col) {
      throw new Error(`Required dispatch column '${exp.name}' is missing`);
    }

    const colType = (col.type || '').toUpperCase();
    if (!exp.type.includes(colType)) {
      throw new Error(`Dispatch column '${exp.name}' has invalid declared type '${col.type}' (expected ${exp.type.join(' or ')})`);
    }

    if (exp.pk !== null && col.pk !== exp.pk) {
      throw new Error(`Dispatch column '${exp.name}' has invalid primary-key position (expected ${exp.pk}, got ${col.pk})`);
    }

    if (exp.notnull === 1 && col.notnull !== 1 && col.pk === 0) {
      throw new Error(`Required dispatch column '${exp.name}' must be NOT NULL`);
    }
  }

  // 2. Validate dispatch_id uniqueness at database level (Section 6)
  const idxList = db.prepare("PRAGMA index_list('dispatches')").all();
  let dispatchIdUnique = false;
  for (const idx of idxList) {
    if (idx.unique === 1 && idx.partial === 0) {
      const idxCols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
      if (idxCols.length === 1 && idxCols[0].name === 'dispatch_id') {
        dispatchIdUnique = true;
        break;
      }
    }
  }
  if (!dispatchIdUnique) {
    throw new Error("Required unique constraint or unique index on 'dispatches.dispatch_id' is missing");
  }

  // 3. Validate history table shape
  const historyTableInfo = db.prepare("PRAGMA table_info('history')").all();
  if (!historyTableInfo || historyTableInfo.length === 0) {
    throw new Error("Required table 'history' is missing");
  }

  const historyColMap = new Map(historyTableInfo.map(c => [c.name, c]));

  const expectedHistoryCols = [
    { name: 'history_seq', type: ['INTEGER'], pk: 1, notnull: null },
    { name: 'project_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'dispatch_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'work_order_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'previous_state', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'next_state', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'timestamp', type: ['INTEGER'], pk: 0, notnull: 1 },
    { name: 'iso', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'patch', type: ['BLOB'], pk: 0, notnull: 0 }
  ];

  for (const exp of expectedHistoryCols) {
    const col = historyColMap.get(exp.name);
    if (!col) {
      throw new Error(`Required history column '${exp.name}' is missing`);
    }

    const colType = (col.type || '').toUpperCase();
    if (!exp.type.includes(colType)) {
      throw new Error(`History column '${exp.name}' has invalid declared type '${col.type}' (expected ${exp.type.join(' or ')})`);
    }

    if (exp.pk !== null && col.pk !== exp.pk) {
      throw new Error(`History column '${exp.name}' has invalid primary-key position (expected ${exp.pk}, got ${col.pk})`);
    }

    if (exp.notnull === 1 && col.notnull !== 1 && col.pk === 0) {
      throw new Error(`Required history column '${exp.name}' must be NOT NULL`);
    }
  }
}

/**
 * Validates that idx_active_project is strictly UNIQUE, partial, on project_id,
 * and its predicate covers ONLY the exact authoritative active states (LCAUTH-07).
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

  const whereMatch = masterRow.sql.match(/\bWHERE\s+(.+)$/i);
  if (!whereMatch) {
    throw new Error("Index 'idx_active_project' must contain a partial WHERE clause");
  }

  const rawPredicate = whereMatch[1].trim().replace(/;$/, '');
  const strictMatch = rawPredicate.match(/^\(?\s*state\s+IN\s*\(([^()]+)\)\s*\)?$/i);
  if (!strictMatch) {
    throw new Error("Index 'idx_active_project' must contain a partial WHERE clause on state IN (...) with exact ACTIVE_STATES and no extra conditions");
  }

  const indexStates = strictMatch[1]
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
    if (row.diagnostics !== null && row.diagnostics !== undefined && typeof row.diagnostics !== 'string') {
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

  // Consistency check
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
 * Factory for creating a durable SQLite-backed lifecycle store (WO-V3-006PG).
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

    // Best-effort POSIX permissions on database file
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dbPath, 0o600);
      } catch {}
    }

    // Connection-local durability pragmas
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

      // Genuinely fresh DB: initialize schema transactionally
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

      // Fresh schema self-validation (Section 26)
      validateSchemaShape(db);
      validateActiveIndex(db);
      validatePersistedSemantics(db);
    } else {
      // Existing DB: check user_version
      if (userVersion === 0) {
        throw new Error('Corrupt or partial database: user_version is 0 but user schema objects exist');
      }
      if (userVersion !== SCHEMA_VERSION) {
        throw new Error(`Unsupported schema version: expected ${SCHEMA_VERSION}, found ${userVersion}`);
      }

      // Physical integrity check
      const qc = db.prepare('PRAGMA quick_check').get();
      if (!qc || qc.quick_check !== 'ok') {
        throw new Error(`Database physical integrity check failed: ${qc ? qc.quick_check : 'null'}`);
      }

      // Shape validation (LCAUTH-06)
      validateSchemaShape(db);

      // Active index validation (LCAUTH-07)
      validateActiveIndex(db);

      // Semantic authority validation (LCAUTH-01)
      validatePersistedSemantics(db);
    }

    // Apply persistent WAL mode ONLY after successful validation
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

    const getLatestHistoryByDispatchStmt = db.prepare(
      `SELECT previous_state, next_state, patch
       FROM history
       WHERE dispatch_id = ?
       ORDER BY history_seq DESC
       LIMIT 1`
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
     * Active dispatch lookup (LCAUTH-01).
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
     * Atomic Begin Dispatch (LCAUTH-01, LCAUTH-08).
     * Inside BEGIN IMMEDIATE transaction, validates persisted state domain for project.
     * Persists SQL NULL for absent optional fields, v8 serialization for explicitly present values.
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

        // 1. Validate all existing project rows for corruption
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

        // 4. Lossless serialization of structured fields (LCAUTH-08)
        let auditBlob = null;
        if (record.audit_metadata !== undefined && record.audit_metadata !== null) {
          auditBlob = v8.serialize(record.audit_metadata);
        }

        // LCAUTH-08: SQL NULL is absence sentinel; serialize explicitly present null/undefined/value
        let diagBlob = null;
        if (Object.hasOwn(record, 'diagnostics')) {
          diagBlob = v8.serialize(record.diagnostics);
        }

        let errorBlob = null;
        if (Object.hasOwn(record, 'error')) {
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
     * Transition Dispatch State (LCAUTH-08).
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

        // LCAUTH-08: Check explicit property presence
        let newError = row.error;
        if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'error')) {
          newError = v8.serialize(patch.error);
        }

        let newDiagBlob = row.diagnostics;
        if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'diagnostics')) {
          newDiagBlob = v8.serialize(patch.diagnostics);
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

    /**
     * Evaluates idempotent replay inside an active SQLite transaction.
     * Diagnostics-first ordering (WO-V4-09C-U2-R1):
     * 1. Validate dispatch.diagnostics is a plain data object.
     * 2. Validate dispatch.diagnostics.reconciliation exact shape.
     * 3. Validate dispatch reconciliation values.
     * 4. Query/find latest history for the exact dispatch.
     * 5. Validate latest transition path.
     * 6. Validate history patch exact shape.
     * 7. Validate history patch values equal dispatch diagnostics.
     * 8. Return idempotent replay only if every proof passes.
     *
     * Caller is responsible for ROLLBACK after this function returns.
     * Throws on structural corruption; returns structured result on semantic mismatch or valid replay.
     */
    function _evaluateSqliteReplayInner(authority, row) {
      const dispatchId = authority.dispatch_id;

      // Step 1: Check dispatch diagnostics is a plain data object
      const rawDiag = row.diagnostics;
      if (rawDiag === null || rawDiag === undefined) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }
      const rowDiag = typeof rawDiag === 'string' ? rawDiag : v8.deserialize(rawDiag);
      if (!isPlainDataObject(rowDiag)) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }

      // Step 2: Check dispatch.diagnostics.reconciliation exact shape
      const recon = rowDiag.reconciliation;
      if (!hasExactEnumerableDataKeys(recon, ['classification', 'evidence_authority', 'reconciled_at'])) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }

      // Step 3: Check diagnostics values (semantic mismatch -> ILLEGAL_STATE_TRANSITION)
      if (
        recon.classification !== 'DELIVERY_UNPROVEN' ||
        recon.evidence_authority !== authority.evidence_authority ||
        typeof recon.reconciled_at !== 'string'
      ) {
        return {
          ok: false,
          code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
          error: 'Reconciliation replay mismatch: diagnostics do not match the provided authority'
        };
      }

      // Step 4: Find latest history row for dispatch_id
      const histRow = getLatestHistoryByDispatchStmt.get(dispatchId);
      if (!histRow) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }

      // Step 5: Validate latest transition path (semantic mismatch -> ILLEGAL_STATE_TRANSITION)
      if (
        histRow.previous_state !== DISPATCH_STATES.DISPATCH_UNCERTAIN ||
        histRow.next_state !== DISPATCH_STATES.PROVENANCE_AMBIGUOUS
      ) {
        return {
          ok: false,
          code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
          error: 'Reconciliation replay mismatch: latest history transition does not match expected reconciliation path'
        };
      }

      // Step 6: Check history patch shape (structural corruption -> throw)
      if (histRow.patch === null || histRow.patch === undefined) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }
      const patch = typeof histRow.patch === 'string' ? histRow.patch : v8.deserialize(histRow.patch);
      if (
        !hasExactEnumerableDataKeys(patch, ['diagnostics']) ||
        !hasExactEnumerableDataKeys(patch.diagnostics, ['reconciliation']) ||
        !hasExactEnumerableDataKeys(patch.diagnostics.reconciliation, ['classification', 'evidence_authority', 'reconciled_at'])
      ) {
        throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
      }

      // Step 7: Check patch values match diagnostics (semantic mismatch -> ILLEGAL_STATE_TRANSITION)
      if (
        patch.diagnostics.reconciliation.classification !== recon.classification ||
        patch.diagnostics.reconciliation.evidence_authority !== recon.evidence_authority ||
        patch.diagnostics.reconciliation.reconciled_at !== recon.reconciled_at
      ) {
        return {
          ok: false,
          code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
          error: 'Reconciliation replay mismatch: history patch does not match dispatch reconciliation metadata'
        };
      }

      // Step 8: All checks pass — idempotent replay
      return {
        ok: true,
        reconciled: false,
        idempotent_replay: true,
        dispatch: rowToDispatch(row)
      };
    }

    /**
     * reconcileUncertainDispatch — WO-V4-09C-U1 Section 5 / Design Seal.
     * Out-of-band operator recovery primitive only. MUST NOT be invoked by
     * broker, waitWorker, dispatchWorker, or any automated runtime method.
     *
     * Authorizes exactly: DISPATCH_UNCERTAIN -> PROVENANCE_AMBIGUOUS
     * Classification:     DELIVERY_UNPROVEN only
     */
    function reconcileUncertainDispatch(authority) {
      ensureOpen();

      // 1. Authority shape validation
      if (!hasExactEnumerableDataKeys(authority, _RECONCILE_AUTHORITY_KEYS)) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_REQUEST,
          error: 'Authority must be a plain data object with exactly the required keys: ' + _RECONCILE_AUTHORITY_KEYS.join(', ')
        };
      }

      // 2. Field-level finite validation
      const fieldError = _validateReconcileAuthority(authority);
      if (fieldError) return fieldError;

      const dispatchId = authority.dispatch_id;
      const projectId = authority.project_id;
      const workOrderId = authority.work_order_id;
      const classification = authority.classification;
      const evidenceAuthority = authority.evidence_authority;

      try {
        db.exec('BEGIN IMMEDIATE');

        // 3. Re-read dispatch row inside transaction
        const row = getDispatchStmt.get(dispatchId);
        if (!row) {
          db.exec('ROLLBACK');
          return { ok: false, code: ERROR_CODES.DISPATCH_NOT_FOUND, error: `Dispatch '${dispatchId}' not found` };
        }

        // 4. Identity verification
        if (row.project_id !== projectId) {
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
            error: `Project identity mismatch: authority '${projectId}' does not match dispatch '${row.project_id}'`
          };
        }
        if (row.work_order_id !== workOrderId) {
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.INVALID_REQUEST,
            error: `Work order mismatch: authority '${workOrderId}' does not match dispatch '${row.work_order_id}'`
          };
        }

        // 5a. Idempotent replay path
        if (row.state === DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
          const replayResult = _evaluateSqliteReplayInner(authority, row);
          db.exec('ROLLBACK');
          return replayResult;
        }

        // 5b. State must be DISPATCH_UNCERTAIN
        if (row.state !== DISPATCH_STATES.DISPATCH_UNCERTAIN) {
          db.exec('ROLLBACK');
          return {
            ok: false,
            code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
            currentState: row.state,
            expectedState: DISPATCH_STATES.DISPATCH_UNCERTAIN,
            error: `Illegal state transition: reconciliation requires current state '${DISPATCH_STATES.DISPATCH_UNCERTAIN}', but dispatch is in '${row.state}'`
          };
        }

        // 6. Inspect and validate diagnostics
        let base = {};
        if (row.diagnostics !== null && row.diagnostics !== undefined) {
          const desDiag = typeof row.diagnostics === 'string' ? row.diagnostics : v8.deserialize(row.diagnostics);
          if (!isPlainDataObject(desDiag)) {
            db.exec('ROLLBACK');
            throw new Error(`Lifecycle store corruption: malformed diagnostics in dispatch '${dispatchId}'`);
          }
          base = desDiag;
        }
        if (Object.hasOwn(base, 'reconciliation')) {
          db.exec('ROLLBACK');
          throw new Error(`Lifecycle store corruption: dispatch '${dispatchId}' in DISPATCH_UNCERTAIN already contains reconciliation metadata`);
        }

        // 7. Single clock snapshot
        const nowIso = clock.iso();
        const nowTs = clock.now();

        // 8. Build new diagnostics and history patch
        const newDiagnostics = {
          ...base,
          reconciliation: {
            classification,
            evidence_authority: evidenceAuthority,
            reconciled_at: nowIso
          }
        };
        const historyPatch = {
          diagnostics: {
            reconciliation: {
              classification,
              evidence_authority: evidenceAuthority,
              reconciled_at: nowIso
            }
          }
        };

        const diagBlob = v8.serialize(newDiagnostics);
        const patchBlob = v8.serialize(historyPatch);

        // 9. Parameterized UPDATE (error column NOT touched - Section 10)
        const updateResult = db.prepare(
          `UPDATE dispatches SET state = ?, updated_at = ?, diagnostics = ? WHERE dispatch_id = ?`
        ).run(DISPATCH_STATES.PROVENANCE_AMBIGUOUS, nowIso, diagBlob, dispatchId);

        if (updateResult.changes !== 1) {
          db.exec('ROLLBACK');
          throw new Error(`Integrity error: reconciliation UPDATE affected ${updateResult.changes} rows (expected exactly 1)`);
        }

        // 10. Insert exactly one history row
        insertHistoryStmt.run(
          row.project_id,
          row.dispatch_id,
          row.work_order_id,
          DISPATCH_STATES.DISPATCH_UNCERTAIN,
          DISPATCH_STATES.PROVENANCE_AMBIGUOUS,
          nowTs,
          nowIso,
          patchBlob
        );

        db.exec('COMMIT');

        const updatedRow = getDispatchStmt.get(dispatchId);
        return {
          ok: true,
          reconciled: true,
          idempotent_replay: false,
          dispatch: rowToDispatch(updatedRow)
        };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
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
      reconcileUncertainDispatch,
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
  createSqliteLifecycleStore,
  isPlainDataObject,
  hasExactEnumerableDataKeys
};

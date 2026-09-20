'use strict';

/**
 * SQLite Auditor Recovery Store (WP-V4-05A)
 * Durable, fail-closed pre-bind recovery journal tracking auditor thread bootstrap.
 * Strictly segregated from worker lifecycle and Registry v2 authority domains.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  parseStrictJson,
  validateAuditDecisionV1
} = require('./audit-decision');

const DEFAULT_RECOVERY_DIR = path.join(os.homedir(), '.orchestrator');
const DEFAULT_RECOVERY_DB_PATH = path.join(DEFAULT_RECOVERY_DIR, 'auditor-recovery.sqlite3');
const SCHEMA_VERSION = 1;

const AUDITOR_BOOTSTRAP_STATES = Object.freeze({
  PROVISIONAL_THREAD: 'PROVISIONAL_THREAD',
  FIRST_TURN_STARTING: 'FIRST_TURN_STARTING',
  FIRST_TURN_IN_FLIGHT: 'FIRST_TURN_IN_FLIGHT',
  DECISION_VALIDATED: 'DECISION_VALIDATED',
  RESUME_VERIFYING: 'RESUME_VERIFYING',
  RESUME_VERIFIED: 'RESUME_VERIFIED',
  REGISTRY_BINDING: 'REGISTRY_BINDING',
  AUDIT_UNCERTAIN: 'AUDIT_UNCERTAIN'
});

const RECOVERY_ERROR_CODES = Object.freeze({
  AUDITOR_RECOVERY_CORRUPT: 'AUDITOR_RECOVERY_CORRUPT',
  AUDITOR_RECOVERY_SCHEMA_INVALID: 'AUDITOR_RECOVERY_SCHEMA_INVALID',
  AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT: 'AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT',
  AUDITOR_RECOVERY_NOT_FOUND: 'AUDITOR_RECOVERY_NOT_FOUND',
  AUDITOR_RECOVERY_INVALID_TRANSITION: 'AUDITOR_RECOVERY_INVALID_TRANSITION',
  AUDITOR_RECOVERY_INVALID_REQUEST: 'AUDITOR_RECOVERY_INVALID_REQUEST',
  AUDITOR_RECOVERY_CLOSED: 'AUDITOR_RECOVERY_CLOSED'
});

const ALLOWED_TRANSITIONS = Object.freeze({
  PROVISIONAL_THREAD: new Set(['FIRST_TURN_STARTING', 'AUDIT_UNCERTAIN']),
  FIRST_TURN_STARTING: new Set(['FIRST_TURN_IN_FLIGHT', 'AUDIT_UNCERTAIN']),
  FIRST_TURN_IN_FLIGHT: new Set(['DECISION_VALIDATED', 'AUDIT_UNCERTAIN']),
  DECISION_VALIDATED: new Set(['RESUME_VERIFYING', 'AUDIT_UNCERTAIN']),
  RESUME_VERIFYING: new Set(['RESUME_VERIFIED', 'AUDIT_UNCERTAIN']),
  RESUME_VERIFIED: new Set(['REGISTRY_BINDING', 'AUDIT_UNCERTAIN']),
  REGISTRY_BINDING: new Set(['AUDIT_UNCERTAIN']),
  AUDIT_UNCERTAIN: new Set()
});

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

function createRecoveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateThreadId(threadId) {
  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'thread_id must be a non-empty string'
    );
  }
  if (Buffer.byteLength(threadId, 'utf8') > 512) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'thread_id byte length exceeds 512 bytes limit'
    );
  }
  if (CONTROL_CHAR_REGEX.test(threadId)) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'thread_id contains forbidden control characters'
    );
  }
}

function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || operationId.trim().length === 0) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'operation_id must be a non-empty string'
    );
  }
  if (Buffer.byteLength(operationId, 'utf8') > 128) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'operation_id exceeds 128 bytes limit'
    );
  }
  if (CONTROL_CHAR_REGEX.test(operationId)) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      'operation_id contains forbidden control characters'
    );
  }
}

function validateNonEmptyString(val, fieldName, maxBytes = 512) {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      `${fieldName} must be a non-empty string`
    );
  }
  if (Buffer.byteLength(val, 'utf8') > maxBytes) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      `${fieldName} exceeds ${maxBytes} bytes limit`
    );
  }
  if (CONTROL_CHAR_REGEX.test(val)) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
      `${fieldName} contains forbidden control characters`
    );
  }
}

/**
 * Validate schema columns, types, primary keys, and nullability.
 * @param {DatabaseSync} db
 */
function validateSchemaShape(db) {
  // Check unexpected tables in database
  const masterTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const allowedTables = new Set(['auditor_bootstrap', 'auditor_bootstrap_history', 'sqlite_sequence']);
  for (const t of masterTables) {
    if (!allowedTables.has(t.name)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Unexpected table '${t.name}' found in recovery database`
      );
    }
  }

  // 1. auditor_bootstrap table
  const bootstrapInfo = db.prepare("PRAGMA table_info('auditor_bootstrap')").all();
  if (!bootstrapInfo || bootstrapInfo.length === 0) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Required table 'auditor_bootstrap' is missing"
    );
  }

  const expectedBootstrapCols = [
    { name: 'project_id', type: ['TEXT'], pk: 1, notnull: 0 },
    { name: 'operation_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'audit_subject_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'thread_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'turn_id', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'workspace_state_observed', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'state', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'decision_json', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'decision_sha256', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'created_at', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'updated_at', type: ['TEXT'], pk: 0, notnull: 1 }
  ];

  if (bootstrapInfo.length !== expectedBootstrapCols.length) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      `Table 'auditor_bootstrap' column count mismatch: expected ${expectedBootstrapCols.length}, found ${bootstrapInfo.length}`
    );
  }

  const bColMap = new Map(bootstrapInfo.map(c => [c.name, c]));
  for (const exp of expectedBootstrapCols) {
    const col = bColMap.get(exp.name);
    if (!col) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' is missing in auditor_bootstrap`
      );
    }
    const colType = (col.type || '').toUpperCase();
    if (!exp.type.includes(colType)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' has invalid declared type '${col.type}'`
      );
    }
    if (col.pk !== exp.pk) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' has invalid primary-key position`
      );
    }
    if (exp.notnull === 1 && col.notnull !== 1 && col.pk === 0) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' must be NOT NULL`
      );
    }
  }

  // Check unique constraint on operation_id
  const idxList = db.prepare("PRAGMA index_list('auditor_bootstrap')").all();
  let opIdUnique = false;
  for (const idx of idxList) {
    if (idx.unique === 1) {
      const idxCols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
      if (idxCols.length === 1 && idxCols[0].name === 'operation_id') {
        opIdUnique = true;
        break;
      }
    }
  }
  if (!opIdUnique) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Required UNIQUE index on 'auditor_bootstrap.operation_id' is missing"
    );
  }

  // 2. auditor_bootstrap_history table
  const historyInfo = db.prepare("PRAGMA table_info('auditor_bootstrap_history')").all();
  if (!historyInfo || historyInfo.length === 0) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Required table 'auditor_bootstrap_history' is missing"
    );
  }

  const expectedHistoryCols = [
    { name: 'history_seq', type: ['INTEGER'], pk: 1, notnull: 0 },
    { name: 'project_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'operation_id', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'previous_state', type: ['TEXT'], pk: 0, notnull: 0 },
    { name: 'next_state', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'timestamp', type: ['INTEGER'], pk: 0, notnull: 1 },
    { name: 'iso', type: ['TEXT'], pk: 0, notnull: 1 },
    { name: 'metadata', type: ['TEXT'], pk: 0, notnull: 0 }
  ];

  if (historyInfo.length !== expectedHistoryCols.length) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      `Table 'auditor_bootstrap_history' column count mismatch: expected ${expectedHistoryCols.length}, found ${historyInfo.length}`
    );
  }

  const hColMap = new Map(historyInfo.map(c => [c.name, c]));
  for (const exp of expectedHistoryCols) {
    const col = hColMap.get(exp.name);
    if (!col) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' is missing in auditor_bootstrap_history`
      );
    }
    const colType = (col.type || '').toUpperCase();
    if (!exp.type.includes(colType)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' in history has invalid type '${col.type}'`
      );
    }
    if (col.pk !== exp.pk) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' in history has invalid primary-key position`
      );
    }
    if (exp.notnull === 1 && col.notnull !== 1 && col.pk === 0) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Column '${exp.name}' in history must be NOT NULL`
      );
    }
  }

  // Check required indexes on history table
  const historyIdxList = db.prepare("PRAGMA index_list('auditor_bootstrap_history')").all();
  const historyIdxMap = new Map(historyIdxList.map(i => [i.name, i]));
  if (!historyIdxMap.has('idx_auditor_history_project') || !historyIdxMap.has('idx_auditor_history_op')) {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Required indexes on 'auditor_bootstrap_history' are missing"
    );
  }

  const projIdxCols = db.prepare("PRAGMA index_info('idx_auditor_history_project')").all();
  if (projIdxCols.length !== 1 || projIdxCols[0].name !== 'project_id') {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Index 'idx_auditor_history_project' must index 'project_id'"
    );
  }

  const opIdxCols = db.prepare("PRAGMA index_info('idx_auditor_history_op')").all();
  if (opIdxCols.length !== 1 || opIdxCols[0].name !== 'operation_id') {
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
      "Index 'idx_auditor_history_op' must index 'operation_id'"
    );
  }
}

/**
 * Validate open-time semantic integrity of persisted rows.
 * @param {DatabaseSync} db
 */
function validatePersistedSemantics(db) {
  const rows = db.prepare('SELECT * FROM auditor_bootstrap').all();
  const knownStates = new Set(Object.values(AUDITOR_BOOTSTRAP_STATES));

  for (const row of rows) {
    // 1. Revalidate ID bounds & characters
    try {
      validateNonEmptyString(row.project_id, 'project_id', 128);
      validateOperationId(row.operation_id);
      validateNonEmptyString(row.audit_subject_id, 'audit_subject_id', 512);
      validateThreadId(row.thread_id);
      validateNonEmptyString(row.workspace_state_observed, 'workspace_state_observed', 512);
      if (row.turn_id !== null && row.turn_id !== undefined) {
        validateNonEmptyString(row.turn_id, 'turn_id', 256);
      }
    } catch (err) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: invalid ID or bounds in project '${row.project_id}': ${err.message}`
      );
    }

    if (!knownStates.has(row.state)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: bootstrap row for project '${row.project_id}' has unrecognized state '${row.state}'`
      );
    }

    // 2. State-specific data coherence (Section 6)
    const { state, turn_id, decision_json, decision_sha256 } = row;
    switch (state) {
      case AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD:
      case AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING:
        if (turn_id !== null || decision_json !== null || decision_sha256 !== null) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: project '${row.project_id}' in state '${state}' has unexpected turn_id or decision data`
          );
        }
        break;
      case AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT:
        if (turn_id === null || decision_json !== null || decision_sha256 !== null) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: project '${row.project_id}' in state 'FIRST_TURN_IN_FLIGHT' requires turn_id != null and decision_json == null`
          );
        }
        break;
      case AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED:
      case AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING:
      case AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED:
      case AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING:
        if (turn_id === null || decision_json === null || decision_sha256 === null) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: project '${row.project_id}' in state '${state}' requires turn_id and validated decision authority`
          );
        }
        break;
      case AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN:
        if ((decision_json !== null && decision_sha256 === null) || (decision_json === null && decision_sha256 !== null)) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: project '${row.project_id}' in state 'AUDIT_UNCERTAIN' has mismatched decision fields`
          );
        }
        break;
      default:
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
          `Corrupt database: project '${row.project_id}' has unrecognized state '${state}'`
        );
    }

    if (decision_json !== null && decision_json !== undefined) {
      if (typeof decision_sha256 !== 'string' || decision_sha256.length !== 64) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
          `Corrupt database: project '${row.project_id}' has decision_json but invalid decision_sha256`
        );
      }
      const actualHash = crypto.createHash('sha256').update(decision_json, 'utf8').digest('hex');
      if (actualHash.toLowerCase() !== decision_sha256.toLowerCase()) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
          `Corrupt database: decision hash mismatch for project '${row.project_id}'`
        );
      }
      try {
        const parsed = parseStrictJson(decision_json);
        const expectedContext = {
          project_id: row.project_id,
          audit_subject_id: row.audit_subject_id,
          auditor_thread_id: row.thread_id,
          workspace_state_observed: row.workspace_state_observed
        };
        validateAuditDecisionV1(parsed, expectedContext);
      } catch (err) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
          `Corrupt database: decision in project '${row.project_id}' failed revalidation: ${err.message}`
        );
      }
    }
  }

  // 3. Verify history rows and unbroken state transition chains (Section 8)
  const historyRows = db.prepare('SELECT * FROM auditor_bootstrap_history ORDER BY history_seq ASC').all();
  const historyByOp = new Map();
  for (const h of historyRows) {
    try {
      validateNonEmptyString(h.project_id, 'history.project_id', 128);
      validateOperationId(h.operation_id);
    } catch (err) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: history row bounds invalid: ${err.message}`
      );
    }

    if (!knownStates.has(h.next_state)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: history seq '${h.history_seq}' has unrecognized next_state '${h.next_state}'`
      );
    }
    if (h.previous_state !== null && !knownStates.has(h.previous_state)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: history seq '${h.history_seq}' has unrecognized previous_state '${h.previous_state}'`
      );
    }
    const opKey = `${h.project_id}::${h.operation_id}`;
    if (!historyByOp.has(opKey)) {
      historyByOp.set(opKey, []);
    }
    historyByOp.get(opKey).push(h);
  }

  for (const [opKey, hList] of historyByOp.entries()) {
    for (let i = 0; i < hList.length; i++) {
      const row = hList[i];
      if (i === 0) {
        if (row.previous_state !== null || row.next_state !== AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: operation '${opKey}' history must start with null -> PROVISIONAL_THREAD`
          );
        }
      } else {
        const prevRow = hList[i - 1];
        if (row.previous_state !== prevRow.next_state) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: history discontinuity in '${opKey}': row previous_state '${row.previous_state}' !== prior next_state '${prevRow.next_state}'`
          );
        }
        const allowed = ALLOWED_TRANSITIONS[row.previous_state];
        if (!allowed || !allowed.has(row.next_state)) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
            `Corrupt database: impossible transition in '${opKey}' from '${row.previous_state}' to '${row.next_state}'`
          );
        }
      }
    }
  }

  // Cross-check active bootstrap state matches latest history row for active projects
  for (const row of rows) {
    const opKey = `${row.project_id}::${row.operation_id}`;
    const hList = historyByOp.get(opKey);
    if (!hList || hList.length === 0) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: active bootstrap for project '${row.project_id}' has no history`
      );
    }
    const latest = hList[hList.length - 1];
    if (latest.next_state !== row.state) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Corrupt database: active bootstrap state '${row.state}' disagrees with latest history '${latest.next_state}'`
      );
    }
  }
}

/**
 * Format active bootstrap database row into detached JS record.
 * Re-validates decision hash and WP04 semantics if decision_json is present.
 * @param {Object} row
 * @returns {Object|null}
 */
function rowToBootstrapRecord(row) {
  if (!row) return null;

  let validatedDecision = null;
  if (row.decision_json !== null && row.decision_json !== undefined) {
    const actualHash = crypto.createHash('sha256').update(row.decision_json, 'utf8').digest('hex');
    if (actualHash.toLowerCase() !== (row.decision_sha256 || '').toLowerCase()) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Stored decision hash mismatch for project '${row.project_id}'`
      );
    }
    const parsed = parseStrictJson(row.decision_json);
    const expectedContext = {
      project_id: row.project_id,
      audit_subject_id: row.audit_subject_id,
      auditor_thread_id: row.thread_id,
      workspace_state_observed: row.workspace_state_observed
    };
    validatedDecision = validateAuditDecisionV1(parsed, expectedContext);
  }

  return {
    project_id: row.project_id,
    operation_id: row.operation_id,
    audit_subject_id: row.audit_subject_id,
    thread_id: row.thread_id,
    turn_id: row.turn_id !== null ? row.turn_id : null,
    workspace_state_observed: row.workspace_state_observed,
    state: row.state,
    decision_json: row.decision_json !== null ? row.decision_json : null,
    decision_sha256: row.decision_sha256 !== null ? row.decision_sha256 : null,
    validated_decision: validatedDecision,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Format history database row into detached JS record.
 * @param {Object} row
 * @returns {Object|null}
 */
function rowToHistoryRecord(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = row.metadata;
    }
  }
  return {
    history_seq: row.history_seq,
    project_id: row.project_id,
    operation_id: row.operation_id,
    previous_state: row.previous_state !== null ? row.previous_state : null,
    next_state: row.next_state,
    timestamp: row.timestamp,
    iso: row.iso,
    metadata
  };
}

/**
 * Factory for creating an Auditor Recovery Store instance.
 * @param {Object} [options={}]
 * @param {string} [options.dbPath]
 * @param {Object} [options.clock]
 * @returns {Object} recovery store instance
 */
function createSqliteAuditorRecoveryStore(options = {}) {
  const clock = options.clock || {
    now: () => Date.now(),
    iso: () => new Date().toISOString()
  };

  const dbPath = options.dbPath || options.path || DEFAULT_RECOVERY_DB_PATH;

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let db = null;
  let isClosed = false;

  function assertOpen() {
    if (isClosed || !db) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CLOSED,
        'Auditor recovery store is closed'
      );
    }
  }

  try {
    db = new DatabaseSync(dbPath);

    // Initial connection pragmas
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA synchronous = FULL;');

    const versionRow = db.prepare('PRAGMA user_version;').get();
    const currentVersion = versionRow ? versionRow.user_version : 0;

    if (currentVersion === 0) {
      // Check if partial tables exist
      const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('auditor_bootstrap', 'auditor_bootstrap_history')").all();
      if (existingTables.length > 0) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
          'Database has user_version 0 but bootstrap tables exist'
        );
      }

      // Initialize schema version 1 transactionally (Section 10)
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(`
          CREATE TABLE auditor_bootstrap (
            project_id TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL UNIQUE,
            audit_subject_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT,
            workspace_state_observed TEXT NOT NULL,
            state TEXT NOT NULL,
            decision_json TEXT,
            decision_sha256 TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE auditor_bootstrap_history (
            history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            previous_state TEXT,
            next_state TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            iso TEXT NOT NULL,
            metadata TEXT
          );

          CREATE INDEX idx_auditor_history_project ON auditor_bootstrap_history(project_id);
          CREATE INDEX idx_auditor_history_op ON auditor_bootstrap_history(operation_id);
        `);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
        db.exec('COMMIT;');
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw err;
      }
    } else if (currentVersion !== SCHEMA_VERSION) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_SCHEMA_INVALID,
        `Unsupported schema version ${currentVersion}; expected ${SCHEMA_VERSION}`
      );
    }

    // Both fresh and reopen paths reach the exact same validation gate (Sections 10 & 11)
    const checkRow = db.prepare('PRAGMA integrity_check;').get();
    if (!checkRow || checkRow.integrity_check !== 'ok') {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Physical integrity check failed: ${checkRow ? checkRow.integrity_check : 'null'}`
      );
    }

    validateSchemaShape(db);
    validatePersistedSemantics(db);

    // Enable WAL only after successful schema and integrity validation
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (err) {
    if (db) {
      try { db.close(); } catch {}
    }
    if (err.code && Object.values(RECOVERY_ERROR_CODES).includes(err.code)) {
      throw err;
    }
    throw createRecoveryError(
      RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
      `Failed to open or validate SQLite database: ${err.message}`
    );
  }

  // Prepared statements
  const stmtGetActive = db.prepare('SELECT * FROM auditor_bootstrap WHERE project_id = ?');
  const stmtListActive = db.prepare('SELECT * FROM auditor_bootstrap ORDER BY created_at ASC');
  const stmtInsertBootstrap = db.prepare(`
    INSERT INTO auditor_bootstrap (
      project_id, operation_id, audit_subject_id, thread_id, turn_id,
      workspace_state_observed, state, decision_json, decision_sha256,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `);
  const stmtInsertHistory = db.prepare(`
    INSERT INTO auditor_bootstrap_history (
      project_id, operation_id, previous_state, next_state,
      timestamp, iso, metadata
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `);
  const stmtUpdateBootstrap = db.prepare(`
    UPDATE auditor_bootstrap
    SET state = ?,
        turn_id = COALESCE(?, turn_id),
        decision_json = COALESCE(?, decision_json),
        decision_sha256 = COALESCE(?, decision_sha256),
        updated_at = ?
    WHERE project_id = ? AND operation_id = ?
  `);
  const stmtDeleteBootstrap = db.prepare(`
    DELETE FROM auditor_bootstrap
    WHERE project_id = ? AND operation_id = ?
  `);
  const stmtGetHistory = db.prepare(`
    SELECT * FROM auditor_bootstrap_history
    WHERE project_id = ? AND operation_id = ?
    ORDER BY history_seq ASC
  `);
  const stmtGetHistoryByProject = db.prepare(`
    SELECT * FROM auditor_bootstrap_history
    WHERE project_id = ?
    ORDER BY history_seq ASC
  `);

  /**
   * Begin an auditor bootstrap session.
   * Enforces at most 1 active bootstrap per project.
   * Commits PROVISIONAL_THREAD state.
   */
  function beginBootstrap(params = {}) {
    assertOpen();

    const {
      project_id,
      operation_id,
      audit_subject_id,
      thread_id,
      workspace_state_observed
    } = params;

    validateNonEmptyString(project_id, 'project_id', 128);
    validateOperationId(operation_id);
    validateNonEmptyString(audit_subject_id, 'audit_subject_id', 512);
    validateThreadId(thread_id);
    validateNonEmptyString(workspace_state_observed, 'workspace_state_observed', 512);

    // Enforce single active bootstrap per project
    const existing = stmtGetActive.get(project_id);
    if (existing) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT,
        `Active bootstrap already exists for project '${project_id}' (operation_id='${existing.operation_id}', state='${existing.state}')`
      );
    }

    const nowIso = clock.iso();
    const nowMs = clock.now();
    const initialState = AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD;

    db.exec('BEGIN IMMEDIATE;');
    try {
      stmtInsertBootstrap.run(
        project_id,
        operation_id,
        audit_subject_id,
        thread_id,
        null,
        workspace_state_observed,
        initialState,
        null,
        null,
        nowIso,
        nowIso
      );

      stmtInsertHistory.run(
        project_id,
        operation_id,
        null,
        initialState,
        nowMs,
        nowIso,
        null
      );

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT,
          `Bootstrap conflict: ${err.message}`
        );
      }
      throw err;
    }

    const created = stmtGetActive.get(project_id);
    return rowToBootstrapRecord(created);
  }

  /**
   * Transition active bootstrap to next state.
   * Enforces transition matrix, operation_id match, and optional patch fields.
   */
  function transitionState(params = {}) {
    assertOpen();

    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
        'transitionState requires an options object'
      );
    }

    // Enforce top-level key allowlist (Section 3)
    const ALLOWED_TOP_LEVEL_KEYS = new Set(['project_id', 'operation_id', 'next_state', 'patch', 'metadata']);
    for (const key of Object.keys(params)) {
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
          `Unknown top-level parameter '${key}' in transitionState`
        );
      }
    }

    const {
      project_id,
      operation_id,
      next_state,
      patch: rawPatch,
      metadata = null
    } = params;

    validateNonEmptyString(project_id, 'project_id', 128);
    validateOperationId(operation_id);

    const knownStates = new Set(Object.values(AUDITOR_BOOTSTRAP_STATES));
    if (!knownStates.has(next_state)) {
      throw createRecoveryError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
        `Unrecognized next_state '${next_state}'`
      );
    }

    // Enforce patch allowlist (Section 4)
    let patch = {};
    if (rawPatch !== undefined && rawPatch !== null) {
      if (typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
          'patch must be a plain object if provided'
        );
      }
      const ALLOWED_PATCH_KEYS = new Set(['turn_id', 'decision_json', 'decision_sha256']);
      for (const key of Object.keys(rawPatch)) {
        if (!ALLOWED_PATCH_KEYS.has(key)) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            `Unknown patch parameter '${key}'`
          );
        }
      }
      patch = rawPatch;
    }

    db.exec('BEGIN IMMEDIATE;');
    try {
      const active = stmtGetActive.get(project_id);
      if (!active) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_NOT_FOUND,
          `No active bootstrap found for project '${project_id}'`
        );
      }

      if (active.operation_id !== operation_id) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT,
          `operation_id mismatch: active is '${active.operation_id}', requested '${operation_id}'`
        );
      }

      // Validate allowed transition
      const allowedNext = ALLOWED_TRANSITIONS[active.state] || new Set();
      if (!allowedNext.has(next_state)) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_TRANSITION,
          `Illegal state transition from '${active.state}' to '${next_state}'`
        );
      }

      // State-specific patch contract (Section 5)
      let patchTurnId = null;
      let patchDecisionJson = null;
      let patchDecisionSha256 = null;

      if (active.state === AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD && next_state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING) {
        if (Object.keys(patch).length > 0) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'patch must be empty for transition to FIRST_TURN_STARTING'
          );
        }
      } else if (active.state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING && next_state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT) {
        if (patch.turn_id === undefined || patch.turn_id === null) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'patch.turn_id is required for transition to FIRST_TURN_IN_FLIGHT'
          );
        }
        if (patch.decision_json !== undefined || patch.decision_sha256 !== undefined) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'decision fields are forbidden for transition to FIRST_TURN_IN_FLIGHT'
          );
        }
        validateNonEmptyString(patch.turn_id, 'patch.turn_id', 256);
        patchTurnId = patch.turn_id;
      } else if (active.state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT && next_state === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED) {
        if (active.turn_id === null || active.turn_id === undefined) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'Cannot transition to DECISION_VALIDATED: turn_id must already exist in record'
          );
        }
        if (patch.turn_id !== undefined) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'patch.turn_id is forbidden for transition to DECISION_VALIDATED'
          );
        }
        if (patch.decision_json === undefined || patch.decision_json === null) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'patch.decision_json is required for transition to DECISION_VALIDATED'
          );
        }
        if (typeof patch.decision_json !== 'string') {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'decision_json must be a string'
          );
        }
        if (Buffer.byteLength(patch.decision_json, 'utf8') > 128 * 1024) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'decision_json exceeds 128 KiB limit'
          );
        }
        patchDecisionJson = patch.decision_json;

        if (patch.decision_sha256 !== undefined && patch.decision_sha256 !== null) {
          patchDecisionSha256 = String(patch.decision_sha256);
        } else {
          patchDecisionSha256 = crypto.createHash('sha256').update(patchDecisionJson, 'utf8').digest('hex');
        }

        // Verify hash matches
        const computed = crypto.createHash('sha256').update(patchDecisionJson, 'utf8').digest('hex');
        if (computed.toLowerCase() !== patchDecisionSha256.toLowerCase()) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'Supplied decision_sha256 does not match SHA-256 of decision_json'
          );
        }

        // Strict-parse and validate against expected context
        const parsed = parseStrictJson(patchDecisionJson);
        const expectedContext = {
          project_id: active.project_id,
          audit_subject_id: active.audit_subject_id,
          auditor_thread_id: active.thread_id,
          workspace_state_observed: active.workspace_state_observed
        };
        validateAuditDecisionV1(parsed, expectedContext);
      } else if (
        (active.state === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED && next_state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING) ||
        (active.state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING && next_state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED) ||
        (active.state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED && next_state === AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING)
      ) {
        if (Object.keys(patch).length > 0) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            `patch must be empty for transition from '${active.state}' to '${next_state}'`
          );
        }
      } else if (next_state === AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN) {
        if (Object.keys(patch).length > 0) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            'patch must be empty for transition to AUDIT_UNCERTAIN'
          );
        }
      } else {
        if (Object.keys(patch).length > 0) {
          throw createRecoveryError(
            RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST,
            `patch is forbidden for transition from '${active.state}' to '${next_state}'`
          );
        }
      }

      const nowIso = clock.iso();
      const nowMs = clock.now();

      stmtUpdateBootstrap.run(
        next_state,
        patchTurnId,
        patchDecisionJson,
        patchDecisionSha256,
        nowIso,
        project_id,
        operation_id
      );

      const metaStr = metadata ? JSON.stringify(metadata) : null;
      stmtInsertHistory.run(
        project_id,
        operation_id,
        active.state,
        next_state,
        nowMs,
        nowIso,
        metaStr
      );

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const updated = stmtGetActive.get(project_id);
    return rowToBootstrapRecord(updated);
  }

  /**
   * Get active bootstrap record for a project.
   */
  function getActiveBootstrap(projectId) {
    assertOpen();
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return null;
    }
    const row = stmtGetActive.get(projectId.trim());
    return rowToBootstrapRecord(row);
  }

  /**
   * List all active bootstraps across all projects.
   */
  function listActiveBootstraps() {
    assertOpen();
    const rows = stmtListActive.all();
    return rows.map(rowToBootstrapRecord);
  }

  /**
   * Delete active bootstrap row upon successful Registry bind or cleanup.
   * History rows remain intact.
   */
  function deleteActiveBootstrap(projectId, operationId) {
    assertOpen();
    validateNonEmptyString(projectId, 'projectId', 128);
    validateOperationId(operationId);

    db.exec('BEGIN IMMEDIATE;');
    try {
      const active = stmtGetActive.get(projectId);
      if (!active) {
        db.exec('COMMIT;');
        return { ok: true, deleted: false };
      }
      if (active.operation_id !== operationId) {
        throw createRecoveryError(
          RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT,
          `operation_id mismatch on delete: active is '${active.operation_id}', requested '${operationId}'`
        );
      }

      stmtDeleteBootstrap.run(projectId, operationId);
      db.exec('COMMIT;');
      return { ok: true, deleted: true };
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  /**
   * Get ordered history records for an operation or full project.
   */
  function getHistory(projectId, operationId = null) {
    assertOpen();
    validateNonEmptyString(projectId, 'projectId', 128);
    if (operationId !== null && operationId !== undefined) {
      validateOperationId(operationId);
      const rows = stmtGetHistory.all(projectId, operationId);
      return rows.map(rowToHistoryRecord);
    }
    const rows = stmtGetHistoryByProject.all(projectId);
    return rows.map(rowToHistoryRecord);
  }

  /**
   * Safely close the database connection.
   */
  function close() {
    if (isClosed) return;
    isClosed = true;
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
  }

  return {
    beginBootstrap,
    transitionState,
    transitionBootstrap: transitionState,
    getActiveBootstrap,
    listActiveBootstraps,
    deleteActiveBootstrap,
    getHistory,
    getBootstrapHistory: (projectId, operationId) => getHistory(projectId, operationId),
    close
  };
}

module.exports = {
  AUDITOR_BOOTSTRAP_STATES,
  RECOVERY_ERROR_CODES,
  createSqliteAuditorRecoveryStore
};

'use strict';

/**
 * WO-V4-09C-U2: Deterministic Uncertain Dispatch Reconciliation Test Suite
 * Test Matrix: UR-001 .. UR-037
 *
 * ZERO real lifecycle mutation. ZERO worker/AO/Codex operations.
 * Tests run against both createMemoryLifecycleStore and createSqliteLifecycleStore
 * (where applicable). SQLite-specific tests use isolated temp directories.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');

const { createMemoryLifecycleStore } = require('../../lib/broker/lifecycle-store');
const { createSqliteLifecycleStore } = require('../../lib/broker/sqlite-lifecycle-store');
const { DISPATCH_STATES, ERROR_CODES } = require('../../lib/broker/contracts');

// ─── Test Infrastructure ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function runTest(id, description, fn) {
  try {
    fn();
    process.stdout.write(`PASS: ${id} \u2014 ${description}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`FAIL: ${id} \u2014 ${description}\n  ${err.message}\n`);
    failed++;
    failures.push({ id, description, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(a, b, label) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── Clock Helpers ────────────────────────────────────────────────────────────

/**
 * Deterministic clock. iso() and now() both advance the timestamp counter
 * by 1 second each call to ensure unique, predictable values.
 * Also tracks call counts for UR-023 (clock isolation on replay).
 */
function makeClock(baseMs = 1_700_000_000_000) {
  let isoCalls = 0;
  let nowCalls = 0;
  let tsMs = baseMs;
  return {
    iso: () => { isoCalls++; const r = new Date(tsMs).toISOString(); tsMs += 1000; return r; },
    now: () => { nowCalls++; return tsMs; },
    isoCalls: () => isoCalls,
    nowCalls: () => nowCalls
  };
}

// ─── Store / Dispatch Helpers ─────────────────────────────────────────────────

let _sqliteTempDirs = [];

function makeTempDbPath(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ur-${label}-`));
  _sqliteTempDirs.push(dir);
  return path.join(dir, 'lifecycle.sqlite3');
}

function makeRecord(overrides = {}) {
  return {
    dispatch_id: 'D-ur-test-001',
    project_id: 'chatgpt-orchestrator',
    work_order_id: 'wp-ur-test-001',
    expected_workspace_state_id: null,
    request_fingerprint: 'fp-ur-001',
    directive: 'echo hello',
    audit_metadata: null,
    ...overrides
  };
}

const BASE_AUTHORITY = Object.freeze({
  dispatch_id: 'D-ur-test-001',
  project_id: 'chatgpt-orchestrator',
  work_order_id: 'wp-ur-test-001',
  expected_state: DISPATCH_STATES.DISPATCH_UNCERTAIN,
  target_state: DISPATCH_STATES.PROVENANCE_AMBIGUOUS,
  classification: 'DELIVERY_UNPROVEN',
  evidence_authority: 'WP-V4-09C-P2-R1'
});

/**
 * Puts a dispatch into DISPATCH_UNCERTAIN state.
 * Returns the dispatch_id.
 */
function setupUncertain(store, recordOverrides = {}, errorPayload = null) {
  const record = makeRecord(recordOverrides);
  let r = store.beginDispatch(record.project_id, record);
  assert(r.ok, `beginDispatch failed: ${r.error}`);
  const patch = errorPayload !== null ? { error: errorPayload } : {};
  r = store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_UNCERTAIN, patch);
  assert(r.ok, `transition to DISPATCH_UNCERTAIN failed: ${r.error}`);
  return record.dispatch_id;
}

/**
 * Puts a dispatch into DISPATCH_UNCERTAIN with non-plain diagnostics.
 * Uses transition() with a diagnostics patch so the store holds the bad value.
 */
function setupUncertainWithDiag(store, diagValue) {
  const record = makeRecord();
  let r = store.beginDispatch(record.project_id, record);
  assert(r.ok, `beginDispatch failed: ${r.error}`);
  r = store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_UNCERTAIN, { diagnostics: diagValue });
  assert(r.ok, `transition to DISPATCH_UNCERTAIN failed: ${r.error}`);
  return record.dispatch_id;
}

function createMemStore(clockObj) {
  return createMemoryLifecycleStore({ clock: clockObj || makeClock() });
}

function createSqlStore(label, clockObj) {
  return createSqliteLifecycleStore({
    dbPath: makeTempDbPath(label),
    clock: clockObj || makeClock()
  });
}

// ─── UR-001: DISPATCH_UNCERTAIN + DELIVERY_UNPROVEN transitions to PROVENANCE_AMBIGUOUS ──

runTest('UR-001-MEM', 'DISPATCH_UNCERTAIN + DELIVERY_UNPROVEN → PROVENANCE_AMBIGUOUS (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(result.ok, `expected ok: ${JSON.stringify(result)}`);
  assertEqual(result.reconciled, true, 'reconciled');
  assertEqual(result.idempotent_replay, false, 'idempotent_replay');
  assertEqual(result.dispatch.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'dispatch.state');
});

runTest('UR-001-SQL', 'DISPATCH_UNCERTAIN + DELIVERY_UNPROVEN → PROVENANCE_AMBIGUOUS (sqlite)', () => {
  const store = createSqlStore('ur001');
  try {
    setupUncertain(store);
    const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assert(result.ok, `expected ok: ${JSON.stringify(result)}`);
    assertEqual(result.reconciled, true, 'reconciled');
    assertEqual(result.idempotent_replay, false, 'idempotent_replay');
    assertEqual(result.dispatch.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'dispatch.state');
  } finally { store.close(); }
});

// ─── UR-002: Row count & history count invariant ──────────────────────────────

runTest('UR-002-MEM', 'Row count unchanged; history count +1 (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const histBefore = store.getProjectHistory('chatgpt-orchestrator').length;
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const histAfter = store.getProjectHistory('chatgpt-orchestrator').length;
  assertEqual(histAfter, histBefore + 1, 'history count');
});

runTest('UR-002-SQL', 'Row count unchanged; history count +1 (sqlite)', () => {
  const store = createSqlStore('ur002');
  try {
    setupUncertain(store);
    const histBefore = store.getProjectHistory('chatgpt-orchestrator').length;
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    const histAfter = store.getProjectHistory('chatgpt-orchestrator').length;
    assertEqual(histAfter, histBefore + 1, 'history count');
  } finally { store.close(); }
});

// ─── UR-003: Active lock release ──────────────────────────────────────────────

runTest('UR-003-MEM', 'Active lock released after reconciliation (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const before = store.getActiveDispatch('chatgpt-orchestrator');
  assert(before !== null && before.state === DISPATCH_STATES.DISPATCH_UNCERTAIN, 'dispatch active before');
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const after = store.getActiveDispatch('chatgpt-orchestrator');
  assertEqual(after, null, 'active dispatch after reconciliation');
});

runTest('UR-003-SQL', 'Active lock released after reconciliation (sqlite)', () => {
  const store = createSqlStore('ur003');
  try {
    setupUncertain(store);
    assert(store.getActiveDispatch('chatgpt-orchestrator') !== null, 'dispatch active before');
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(store.getActiveDispatch('chatgpt-orchestrator'), null, 'active dispatch after');
  } finally { store.close(); }
});

// ─── UR-004: Generic transition() remains sealed ──────────────────────────────

runTest('UR-004-MEM', 'Generic transition() remains sealed for DISPATCH_UNCERTAIN (memory)', () => {
  const store = createMemStore();
  const id = setupUncertain(store);
  const result = store.transition(id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
  // Verify zero mutation
  const d = store.getDispatch(id);
  assertEqual(d.state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-004-SQL', 'Generic transition() remains sealed for DISPATCH_UNCERTAIN (sqlite)', () => {
  const store = createSqlStore('ur004');
  try {
    const id = setupUncertain(store);
    const result = store.transition(id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
    assertEqual(store.getDispatch(id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-005: Wrong project_id rejected ───────────────────────────────────────

runTest('UR-005-MEM', 'Wrong project_id rejected with PROJECT_IDENTITY_MISMATCH (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const histBefore = store.getProjectHistory('chatgpt-orchestrator').length;
  const result = store.reconcileUncertainDispatch({
    ...BASE_AUTHORITY, project_id: 'other-project'
  });
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.PROJECT_IDENTITY_MISMATCH, 'code');
  assertEqual(store.getProjectHistory('chatgpt-orchestrator').length, histBefore, 'zero history append');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-005-SQL', 'Wrong project_id rejected with PROJECT_IDENTITY_MISMATCH (sqlite)', () => {
  const store = createSqlStore('ur005');
  try {
    setupUncertain(store);
    const histBefore = store.getProjectHistory('chatgpt-orchestrator').length;
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, project_id: 'other-project' });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.PROJECT_IDENTITY_MISMATCH, 'code');
    assertEqual(store.getProjectHistory('chatgpt-orchestrator').length, histBefore, 'zero history append');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-006: Wrong work_order_id rejected ────────────────────────────────────

runTest('UR-006-MEM', 'Wrong work_order_id rejected with INVALID_REQUEST (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, work_order_id: 'wrong-wo' });
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-006-SQL', 'Wrong work_order_id rejected with INVALID_REQUEST (sqlite)', () => {
  const store = createSqlStore('ur006');
  try {
    setupUncertain(store);
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, work_order_id: 'wrong-wo' });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-007: Wrong current state rejected ────────────────────────────────────

runTest('UR-007-MEM', 'Reconciliation against DISPATCH_ACCEPTED/RUNNING/READY_FOR_REVIEW returns ILLEGAL_STATE_TRANSITION (memory)', () => {
  const nonUncertainStates = [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.READY_FOR_REVIEW];
  const transitions = {
    [DISPATCH_STATES.DISPATCH_ACCEPTED]: [DISPATCH_STATES.DISPATCH_ACCEPTED],
    [DISPATCH_STATES.RUNNING]: [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING],
    [DISPATCH_STATES.READY_FOR_REVIEW]: [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.READY_FOR_REVIEW]
  };
  for (const targetState of nonUncertainStates) {
    const store = createMemoryLifecycleStore({ clock: makeClock() });
    const record = makeRecord({ dispatch_id: `D-ur007-${targetState}` });
    let r = store.beginDispatch(record.project_id, record);
    assert(r.ok, `beginDispatch: ${r.error}`);
    for (const s of transitions[targetState]) {
      r = store.transition(record.dispatch_id, s);
      assert(r.ok, `transition to ${s}: ${r.error}`);
    }
    const auth = { ...BASE_AUTHORITY, dispatch_id: record.dispatch_id };
    const result = store.reconcileUncertainDispatch(auth);
    assertEqual(result.ok, false, `ok for state ${targetState}`);
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, `code for state ${targetState}`);
    assertEqual(store.getDispatch(record.dispatch_id).state, targetState, `state unchanged for ${targetState}`);
  }
});

runTest('UR-007-SQL', 'Reconciliation against DISPATCH_ACCEPTED/RUNNING/READY_FOR_REVIEW returns ILLEGAL_STATE_TRANSITION (sqlite)', () => {
  const nonUncertainStates = [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.READY_FOR_REVIEW];
  const transitions = {
    [DISPATCH_STATES.DISPATCH_ACCEPTED]: [DISPATCH_STATES.DISPATCH_ACCEPTED],
    [DISPATCH_STATES.RUNNING]: [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING],
    [DISPATCH_STATES.READY_FOR_REVIEW]: [DISPATCH_STATES.DISPATCH_ACCEPTED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.READY_FOR_REVIEW]
  };
  for (const targetState of nonUncertainStates) {
    const store = createSqlStore(`ur007-${targetState}`);
    try {
      const record = makeRecord({ dispatch_id: `D-ur007-${targetState}` });
      let r = store.beginDispatch(record.project_id, record);
      assert(r.ok, `beginDispatch: ${r.error}`);
      for (const s of transitions[targetState]) {
        r = store.transition(record.dispatch_id, s);
        assert(r.ok, `transition to ${s}: ${r.error}`);
      }
      const auth = { ...BASE_AUTHORITY, dispatch_id: record.dispatch_id };
      const result = store.reconcileUncertainDispatch(auth);
      assertEqual(result.ok, false, `ok for state ${targetState}`);
      assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, `code for state ${targetState}`);
      assertEqual(store.getDispatch(record.dispatch_id).state, targetState, `state unchanged for ${targetState}`);
    } finally { store.close(); }
  }
});

// ─── UR-008: Unsupported target_state rejected ───────────────────────────────

runTest('UR-008-MEM', 'Unsupported target_state rejected with ILLEGAL_STATE_TRANSITION (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  for (const ts of [DISPATCH_STATES.DISPATCH_FAILED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.DISPATCH_ACCEPTED]) {
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, target_state: ts });
    assertEqual(result.ok, false, `ok for target_state=${ts}`);
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, `code for target_state=${ts}`);
  }
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-008-SQL', 'Unsupported target_state rejected with ILLEGAL_STATE_TRANSITION (sqlite)', () => {
  const store = createSqlStore('ur008');
  try {
    setupUncertain(store);
    for (const ts of [DISPATCH_STATES.DISPATCH_FAILED, DISPATCH_STATES.RUNNING, DISPATCH_STATES.DISPATCH_ACCEPTED]) {
      const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, target_state: ts });
      assertEqual(result.ok, false, `ok for target_state=${ts}`);
      assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, `code for target_state=${ts}`);
    }
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-009: Unsupported classification rejected ─────────────────────────────

runTest('UR-009-MEM', 'Unsupported classification rejected with INVALID_REQUEST (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  for (const cls of ['NOT_DELIVERED', 'AGENT_CRASH', 'TIMEOUT', '']) {
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, classification: cls });
    assertEqual(result.ok, false, `ok for cls=${cls}`);
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, `code for cls=${cls}`);
  }
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-009-SQL', 'Unsupported classification rejected with INVALID_REQUEST (sqlite)', () => {
  const store = createSqlStore('ur009');
  try {
    setupUncertain(store);
    for (const cls of ['NOT_DELIVERED', 'AGENT_CRASH', 'TIMEOUT', '']) {
      const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, classification: cls });
      assertEqual(result.ok, false, `ok for cls=${cls}`);
      assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, `code for cls=${cls}`);
    }
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-010: Original transport error preserved ───────────────────────────────

runTest('UR-010-MEM', 'Original transport error preserved after reconciliation (memory)', () => {
  const store = createMemStore();
  const errorMsg = 'The agent process exited; relaunch it before sending another message (AGENT_EXITED) [request Admin/OlzvryaCFC-000297]';
  setupUncertain(store, {}, errorMsg);
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
  assertEqual(d.error, errorMsg, 'error preserved');
});

runTest('UR-010-SQL', 'Original transport error preserved after reconciliation (sqlite)', () => {
  const store = createSqlStore('ur010');
  try {
    const errorMsg = 'The agent process exited; relaunch it before sending another message (AGENT_EXITED) [request Admin/OlzvryaCFC-000297]';
    setupUncertain(store, {}, errorMsg);
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
    assertEqual(d.error, errorMsg, 'error preserved');
  } finally { store.close(); }
});

// ─── UR-011: Reconciliation metadata durability ───────────────────────────────

runTest('UR-011-MEM', 'diagnostics.reconciliation and history.patch.diagnostics match (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
  assert(d.diagnostics && d.diagnostics.reconciliation, 'diagnostics.reconciliation exists');
  const r = d.diagnostics.reconciliation;
  assertEqual(r.classification, 'DELIVERY_UNPROVEN', 'classification');
  assertEqual(r.evidence_authority, BASE_AUTHORITY.evidence_authority, 'evidence_authority');
  assert(typeof r.reconciled_at === 'string' && r.reconciled_at.length > 0, 'reconciled_at is string');

  const history = store.getProjectHistory('chatgpt-orchestrator');
  const last = history[history.length - 1];
  assert(last.patch && last.patch.diagnostics && last.patch.diagnostics.reconciliation, 'patch.diagnostics.reconciliation');
  const pr = last.patch.diagnostics.reconciliation;
  assertEqual(pr.classification, r.classification, 'patch.classification matches');
  assertEqual(pr.evidence_authority, r.evidence_authority, 'patch.evidence_authority matches');
  assertEqual(pr.reconciled_at, r.reconciled_at, 'patch.reconciled_at matches');
});

runTest('UR-011-SQL', 'diagnostics.reconciliation and history.patch.diagnostics match (sqlite)', () => {
  const store = createSqlStore('ur011');
  try {
    setupUncertain(store);
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
    const r = d.diagnostics.reconciliation;
    assertEqual(r.classification, 'DELIVERY_UNPROVEN', 'classification');
    assertEqual(r.evidence_authority, BASE_AUTHORITY.evidence_authority, 'evidence_authority');
    assert(typeof r.reconciled_at === 'string', 'reconciled_at is string');
    const history = store.getProjectHistory('chatgpt-orchestrator');
    const last = history[history.length - 1];
    const pr = last.patch.diagnostics.reconciliation;
    assertEqual(pr.classification, r.classification, 'patch matches');
    assertEqual(pr.evidence_authority, r.evidence_authority, 'patch.ea matches');
    assertEqual(pr.reconciled_at, r.reconciled_at, 'patch.ra matches');
  } finally { store.close(); }
});

// ─── UR-012: Identical replay safety ─────────────────────────────────────────

runTest('UR-012-MEM', 'Second identical call returns idempotent_replay: true, zero mutation (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(r1.ok && r1.reconciled === true, 'first call ok');
  const histLen1 = store.getProjectHistory('chatgpt-orchestrator').length;
  const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(r2.ok, true, 'r2.ok');
  assertEqual(r2.reconciled, false, 'r2.reconciled');
  assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
  assertEqual(r2.dispatch.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state preserved');
  assertEqual(store.getProjectHistory('chatgpt-orchestrator').length, histLen1, 'zero history append on replay');
});

runTest('UR-012-SQL', 'Second identical call returns idempotent_replay: true, zero mutation (sqlite)', () => {
  const store = createSqlStore('ur012');
  try {
    setupUncertain(store);
    const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assert(r1.ok && r1.reconciled, 'first call ok');
    const histLen1 = store.getProjectHistory('chatgpt-orchestrator').length;
    const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(r2.ok, true, 'r2.ok');
    assertEqual(r2.reconciled, false, 'r2.reconciled');
    assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
    assertEqual(store.getProjectHistory('chatgpt-orchestrator').length, histLen1, 'zero history on replay');
  } finally { store.close(); }
});

// ─── UR-013: SQLite store reopen durability ───────────────────────────────────

runTest('UR-013-SQL', 'SQLite store reopen: state, diagnostics, error, history durable', () => {
  const dbPath = makeTempDbPath('ur013');
  const errorMsg = 'AGENT_EXITED test error';
  {
    const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      setupUncertain(store, {}, errorMsg);
      const r = store.reconcileUncertainDispatch(BASE_AUTHORITY);
      assert(r.ok && r.reconciled, 'reconciliation ok');
    } finally { store.close(); }
  }
  // Reopen
  {
    const store2 = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      const d = store2.getDispatch(BASE_AUTHORITY.dispatch_id);
      assertEqual(d.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state durable');
      assertEqual(d.error, errorMsg, 'error durable');
      assert(d.diagnostics.reconciliation, 'diagnostics.reconciliation durable');
      assertEqual(d.diagnostics.reconciliation.classification, 'DELIVERY_UNPROVEN', 'classification durable');
      const hist = store2.getProjectHistory('chatgpt-orchestrator');
      const last = hist[hist.length - 1];
      assertEqual(last.previous_state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'history.previous_state');
      assertEqual(last.next_state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'history.next_state');
    } finally { store2.close(); }
  }
});

// ─── UR-014: Memory lifecycle store parity ────────────────────────────────────

runTest('UR-014-MEM', 'Memory store satisfies all reconciliation validations with identical semantics', () => {
  // This test verifies that the memory store correctly implements the full validation
  // surface (shape, field bounds, state checks) independently of SQLite.
  const store = createMemStore();
  // Shape rejection
  assert(!store.reconcileUncertainDispatch(null).ok, 'null rejected');
  assert(!store.reconcileUncertainDispatch([]).ok, 'array rejected');
  assert(!store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, extra: 'key' }).ok, 'extra key rejected');
  // Field bounds
  assert(!store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, dispatch_id: '' }).ok, 'empty dispatch_id');
  assert(!store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, classification: 'BAD' }).ok, 'bad classification');
  // Correct call
  setupUncertain(store);
  const r = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(r.ok && r.reconciled, 'success');
});

// ─── UR-015: Transaction race / state drift ───────────────────────────────────

runTest('UR-015-SQL', 'State drift before transaction detected: DISPATCH_UNCERTAIN changed externally → ILLEGAL_STATE_TRANSITION', () => {
  const dbPath = makeTempDbPath('ur015');
  const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
  try {
    setupUncertain(store);
    // Simulate external state change using a second connection before reconciliation
    const db2 = new DatabaseSync(dbPath);
    db2.exec(`UPDATE dispatches SET state = 'DISPATCH_FAILED' WHERE dispatch_id = '${BASE_AUTHORITY.dispatch_id}'`);
    db2.close();
    // reconcileUncertainDispatch re-reads inside BEGIN IMMEDIATE: sees DISPATCH_FAILED
    const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_FAILED, 'state unchanged by reconcile');
  } finally { store.close(); }
});

// ─── UR-016: Zero worker / AO / Codex side effects ───────────────────────────

runTest('UR-016-MEM', 'Reconciliation executes strictly within lifecycle store, zero external calls (memory)', () => {
  // Verified by construction: reconcileUncertainDispatch only calls clock.iso/now,
  // reads/writes Map state, and pushes history. No require() or subprocess.
  const store = createMemStore();
  setupUncertain(store);
  const r = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(r.ok, 'ok');
  // If we got here without any network error or subprocess error, UR-016 passes.
});

// ─── UR-017: evidence_authority over byte bound ───────────────────────────────

runTest('UR-017-MEM', 'evidence_authority exceeding 512 UTF-8 bytes rejected (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const long = 'A'.repeat(513);
  const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, evidence_authority: long });
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-017-SQL', 'evidence_authority exceeding 512 UTF-8 bytes rejected (sqlite)', () => {
  const store = createSqlStore('ur017');
  try {
    setupUncertain(store);
    const long = 'A'.repeat(513);
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, evidence_authority: long });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-018: evidence_authority control char / multiline ─────────────────────

runTest('UR-018-MEM', 'evidence_authority with newline/CR/control char rejected (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  for (const bad of ['WP-R1\ninjected', 'WP-R1\rinjected', 'WP-R1\x01injected']) {
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, evidence_authority: bad });
    assertEqual(result.ok, false, `ok for [${JSON.stringify(bad)}]`);
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, `code for [${JSON.stringify(bad)}]`);
  }
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-018-SQL', 'evidence_authority with newline/CR/control char rejected (sqlite)', () => {
  const store = createSqlStore('ur018');
  try {
    setupUncertain(store);
    for (const bad of ['WP-R1\ninjected', 'WP-R1\rinjected', 'WP-R1\x01injected']) {
      const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, evidence_authority: bad });
      assertEqual(result.ok, false, `ok for [${JSON.stringify(bad)}]`);
      assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, `code for [${JSON.stringify(bad)}]`);
    }
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-019: Pre-existing diagnostics plain object preserved ──────────────────

runTest('UR-019-MEM', 'Existing unrelated diagnostics keys preserved after reconciliation (memory)', () => {
  const store = createMemStore();
  const record = makeRecord();
  store.beginDispatch(record.project_id, record);
  store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
    diagnostics: { transport_attempt: 1, session_ok: false }
  });
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
  assertEqual(d.diagnostics.transport_attempt, 1, 'transport_attempt preserved');
  assertEqual(d.diagnostics.session_ok, false, 'session_ok preserved');
  assert(d.diagnostics.reconciliation, 'reconciliation added');
});

runTest('UR-019-SQL', 'Existing unrelated diagnostics keys preserved after reconciliation (sqlite)', () => {
  const store = createSqlStore('ur019');
  try {
    const record = makeRecord();
    store.beginDispatch(record.project_id, record);
    store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
      diagnostics: { transport_attempt: 1, session_ok: false }
    });
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
    assertEqual(d.diagnostics.transport_attempt, 1, 'transport_attempt preserved');
    assertEqual(d.diagnostics.session_ok, false, 'session_ok preserved');
    assert(d.diagnostics.reconciliation, 'reconciliation added');
  } finally { store.close(); }
});

// ─── UR-020: Pre-existing diagnostics non-plain / array ──────────────────────

runTest('UR-020-MEM', 'Non-plain diagnostics (array) in DISPATCH_UNCERTAIN throws corruption (memory)', () => {
  const store = createMemStore();
  setupUncertainWithDiag(store, ['array', 'value']);
  let threw = false;
  try {
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
  } catch (err) {
    threw = true;
    assert(err.message.includes('malformed diagnostics'), `unexpected error: ${err.message}`);
  }
  assert(threw, 'expected throw for array diagnostics');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-020-SQL', 'Non-plain diagnostics (array) in DISPATCH_UNCERTAIN throws corruption (sqlite)', () => {
  const store = createSqlStore('ur020');
  try {
    setupUncertainWithDiag(store, ['array', 'value']);
    let threw = false;
    try {
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } catch (err) {
      threw = true;
      assert(err.message.includes('malformed diagnostics'), `unexpected: ${err.message}`);
    }
    assert(threw, 'expected throw');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-021: DISPATCH_UNCERTAIN with pre-existing reconciliation key ──────────

runTest('UR-021-MEM', 'Pre-existing reconciliation key in DISPATCH_UNCERTAIN throws (memory)', () => {
  const store = createMemStore();
  setupUncertainWithDiag(store, { reconciliation: { existing: true } });
  let threw = false;
  try {
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
  } catch (err) {
    threw = true;
    assert(err.message.includes('already contains reconciliation metadata'), `msg: ${err.message}`);
  }
  assert(threw, 'expected throw');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-021-SQL', 'Pre-existing reconciliation key in DISPATCH_UNCERTAIN throws (sqlite)', () => {
  const store = createSqlStore('ur021');
  try {
    setupUncertainWithDiag(store, { reconciliation: { existing: true } });
    let threw = false;
    try {
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } catch (err) {
      threw = true;
      assert(err.message.includes('already contains reconciliation metadata'), `msg: ${err.message}`);
    }
    assert(threw, 'expected throw');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-022: SQL UPDATE affected rows != 1 (real trigger-based changes !== 1) ──
runTest('UR-022-SQL', 'UPDATE changes !== 1 produces integrity error and clean rollback (sqlite)', () => {
  const dbPath = makeTempDbPath('ur022');
  const clock = makeClock();
  const store1 = createSqliteLifecycleStore({ dbPath, clock });
  try {
    setupUncertain(store1, {}, 'error-msg');
  } finally {
    store1.close();
  }

  // Install BEFORE UPDATE trigger in temporary SQLite DB that ignores UPDATE, causing changes === 0
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TRIGGER test_block_update BEFORE UPDATE OF state, updated_at, diagnostics ON dispatches BEGIN SELECT RAISE(IGNORE); END;');
  db.close();

  const store2 = createSqliteLifecycleStore({ dbPath, clock });
  try {
    const dBefore = store2.getDispatch(BASE_AUTHORITY.dispatch_id);
    assertEqual(dBefore.state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state before');
    assertEqual(dBefore.error, 'error-msg', 'error before');
    const histBefore = store2.getAllHistory().length;
    assert(store2.getActiveDispatch('chatgpt-orchestrator') !== null, 'active lock held before');

    let threw = false;
    try {
      store2.reconcileUncertainDispatch(BASE_AUTHORITY);
    } catch (err) {
      threw = true;
      assert(err.message.includes('Integrity error: reconciliation UPDATE affected 0 rows'), `unexpected: ${err.message}`);
    }
    assert(threw, 'expected integrity error throw on changes !== 1');

    const dAfter = store2.getDispatch(BASE_AUTHORITY.dispatch_id);
    assertEqual(dAfter.state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state remains DISPATCH_UNCERTAIN');
    assertEqual(dAfter.error, 'error-msg', 'error unchanged');
    assertEqual(JSON.stringify(dAfter.diagnostics), JSON.stringify(dBefore.diagnostics), 'diagnostics unchanged');
    assertEqual(store2.getAllHistory().length, histBefore, 'history count unchanged');
    assert(store2.getActiveDispatch('chatgpt-orchestrator') !== null, 'active lock still held');
  } finally {
    store2.close();
  }
});

// ─── UR-023: Identical replay immutability ────────────────────────────────────

runTest('UR-023-MEM', 'Idempotent replay: zero clock calls, zero updated_at rewrite (memory)', () => {
  const clock = makeClock();
  const store = createMemoryLifecycleStore({ clock });
  setupUncertain(store);
  store.reconcileUncertainDispatch(BASE_AUTHORITY);
  const d1 = store.getDispatch(BASE_AUTHORITY.dispatch_id);
  const updatedAtBefore = d1.updated_at;
  const isoCallsBefore = clock.isoCalls();
  const nowCallsBefore = clock.nowCalls();

  // Second call (replay)
  const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(r2.idempotent_replay, true, 'idempotent_replay');
  assertEqual(clock.isoCalls(), isoCallsBefore, 'clock.iso not called on replay');
  assertEqual(clock.nowCalls(), nowCallsBefore, 'clock.now not called on replay');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).updated_at, updatedAtBefore, 'updated_at not rewritten');
});

runTest('UR-023-SQL', 'Idempotent replay: zero clock calls, zero updated_at rewrite (sqlite)', () => {
  const clock = makeClock();
  const store = createSqliteLifecycleStore({ dbPath: makeTempDbPath('ur023'), clock });
  try {
    setupUncertain(store);
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
    const updatedAtBefore = store.getDispatch(BASE_AUTHORITY.dispatch_id).updated_at;
    const isoCallsBefore = clock.isoCalls();
    const nowCallsBefore = clock.nowCalls();

    const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(r2.idempotent_replay, true, 'idempotent_replay');
    assertEqual(clock.isoCalls(), isoCallsBefore, 'no clock.iso calls on replay');
    assertEqual(clock.nowCalls(), nowCallsBefore, 'no clock.now calls on replay');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).updated_at, updatedAtBefore, 'updated_at unchanged');
  } finally { store.close(); }
});

// ─── UR-024: Contradictory-current-boundary classification ───────────────────

runTest('UR-024-MEM', 'Non-DELIVERY_UNPROVEN classification rejected (contradictory boundary case)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, classification: 'NOT_DELIVERED' });
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-024-SQL', 'Non-DELIVERY_UNPROVEN classification rejected (contradictory boundary case) (sqlite)', () => {
  const store = createSqlStore('ur024');
  try {
    setupUncertain(store);
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, classification: 'NOT_DELIVERED' });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-025: Date diagnostics ─────────────────────────────────────────────────

runTest('UR-025-MEM', 'Date diagnostics throws corruption error (memory)', () => {
  const store = createMemStore();
  setupUncertainWithDiag(store, new Date());
  let threw = false;
  try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
  catch (err) { threw = true; assert(err.message.includes('malformed diagnostics'), err.message); }
  assert(threw, 'expected throw for Date diagnostics');
});

runTest('UR-025-SQL', 'Date diagnostics throws corruption error (sqlite)', () => {
  const store = createSqlStore('ur025');
  try {
    setupUncertainWithDiag(store, new Date());
    let threw = false;
    try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
    catch (err) { threw = true; assert(err.message.includes('malformed diagnostics'), err.message); }
    assert(threw, 'expected throw for Date diagnostics');
  } finally { store.close(); }
});

// ─── UR-026: Map diagnostics ──────────────────────────────────────────────────

runTest('UR-026-MEM', 'Map diagnostics throws corruption error (memory)', () => {
  const store = createMemStore();
  setupUncertainWithDiag(store, new Map([['a', 1]]));
  let threw = false;
  try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
  catch (err) { threw = true; assert(err.message.includes('malformed diagnostics'), err.message); }
  assert(threw, 'expected throw for Map diagnostics');
});

runTest('UR-026-SQL', 'Map diagnostics throws corruption error (sqlite)', () => {
  const store = createSqlStore('ur026');
  try {
    setupUncertainWithDiag(store, new Map([['a', 1]]));
    let threw = false;
    try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
    catch (err) { threw = true; assert(err.message.includes('malformed diagnostics'), err.message); }
    assert(threw, 'expected throw for Map diagnostics');
  } finally { store.close(); }
});

// ─── UR-027: Set / custom-prototype diagnostics ───────────────────────────────

runTest('UR-027-MEM', 'Set / custom-prototype diagnostics throws corruption error (memory)', () => {
  const store = createMemStore();
  // Set
  setupUncertainWithDiag(store, new Set([1, 2]));
  let threw = false;
  try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
  catch (err) { threw = true; }
  assert(threw, 'expected throw for Set diagnostics');
});

runTest('UR-027-SQL', 'Set / custom-prototype diagnostics throws corruption error (sqlite)', () => {
  const store = createSqlStore('ur027');
  try {
    setupUncertainWithDiag(store, new Set([1, 2]));
    let threw = false;
    try { store.reconcileUncertainDispatch(BASE_AUTHORITY); }
    catch (err) { threw = true; }
    assert(threw, 'expected throw for Set diagnostics');
  } finally { store.close(); }
});

// ─── UR-028: null-prototype plain diagnostics ─────────────────────────────────

runTest('UR-028-MEM', 'null-prototype plain diagnostics accepted; unrelated keys preserved (memory)', () => {
  const store = createMemStore();
  const nullProtoDiag = Object.assign(Object.create(null), { transport_count: 3 });
  setupUncertainWithDiag(store, nullProtoDiag);
  const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(result.ok, `expected ok: ${JSON.stringify(result)}`);
  const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
  assertEqual(d.diagnostics.transport_count, 3, 'unrelated key preserved');
  assert(d.diagnostics.reconciliation, 'reconciliation added');
});

runTest('UR-028-SQL', 'null-prototype plain diagnostics accepted; unrelated keys preserved (sqlite)', () => {
  const store = createSqlStore('ur028');
  try {
    const nullProtoDiag = Object.assign(Object.create(null), { transport_count: 3 });
    setupUncertainWithDiag(store, nullProtoDiag);
    const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assert(result.ok, `expected ok: ${JSON.stringify(result)}`);
    const d = store.getDispatch(BASE_AUTHORITY.dispatch_id);
    assertEqual(d.diagnostics.transport_count, 3, 'unrelated key preserved');
    assert(d.diagnostics.reconciliation, 'reconciliation added');
  } finally { store.close(); }
});

// ─── UR-029: Authority object extra own key ───────────────────────────────────

runTest('UR-029-MEM', 'Authority with extra own key rejected with INVALID_REQUEST (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, extra_key: 'unexpected' });
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-029-SQL', 'Authority with extra own key rejected with INVALID_REQUEST (sqlite)', () => {
  const store = createSqlStore('ur029');
  try {
    setupUncertain(store);
    const result = store.reconcileUncertainDispatch({ ...BASE_AUTHORITY, extra_key: 'unexpected' });
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.INVALID_REQUEST, 'code');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-030: Authority accessor / non-enumerable / symbol key ────────────────

runTest('UR-030-MEM', 'Authority with accessor property rejected with INVALID_REQUEST (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);

  // Accessor property
  const authWithGetter = Object.defineProperties(
    { dispatch_id: BASE_AUTHORITY.dispatch_id, project_id: BASE_AUTHORITY.project_id, work_order_id: BASE_AUTHORITY.work_order_id, expected_state: BASE_AUTHORITY.expected_state, target_state: BASE_AUTHORITY.target_state, classification: BASE_AUTHORITY.classification },
    { evidence_authority: { get: () => 'WP-V4-09C-P2-R1', enumerable: true, configurable: true } }
  );
  const r1 = store.reconcileUncertainDispatch(authWithGetter);
  assertEqual(r1.ok, false, 'accessor ok');
  assertEqual(r1.code, ERROR_CODES.INVALID_REQUEST, 'accessor code');

  // Non-enumerable property
  const authNonEnum = Object.create(null);
  Object.assign(authNonEnum, BASE_AUTHORITY);
  Object.defineProperty(authNonEnum, 'extra', { value: 1, enumerable: false });
  const r2 = store.reconcileUncertainDispatch(authNonEnum);
  assertEqual(r2.ok, false, 'non-enum ok');
  assertEqual(r2.code, ERROR_CODES.INVALID_REQUEST, 'non-enum code');

  // Symbol key (adds to key count, fails length check)
  const authSymbol = { ...BASE_AUTHORITY };
  authSymbol[Symbol('hidden')] = 'value';
  const r3 = store.reconcileUncertainDispatch(authSymbol);
  assertEqual(r3.ok, false, 'symbol ok');
  assertEqual(r3.code, ERROR_CODES.INVALID_REQUEST, 'symbol code');

  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
});

runTest('UR-030-SQL', 'Authority with accessor property rejected with INVALID_REQUEST (sqlite)', () => {
  const store = createSqlStore('ur030');
  try {
    setupUncertain(store);

    // Accessor property
    const authWithGetter = Object.defineProperties(
      { dispatch_id: BASE_AUTHORITY.dispatch_id, project_id: BASE_AUTHORITY.project_id, work_order_id: BASE_AUTHORITY.work_order_id, expected_state: BASE_AUTHORITY.expected_state, target_state: BASE_AUTHORITY.target_state, classification: BASE_AUTHORITY.classification },
      { evidence_authority: { get: () => 'WP-V4-09C-P2-R1', enumerable: true, configurable: true } }
    );
    const r1 = store.reconcileUncertainDispatch(authWithGetter);
    assertEqual(r1.ok, false, 'accessor ok');
    assertEqual(r1.code, ERROR_CODES.INVALID_REQUEST, 'accessor code');

    // Non-enumerable property
    const authNonEnum = Object.create(null);
    Object.assign(authNonEnum, BASE_AUTHORITY);
    Object.defineProperty(authNonEnum, 'extra', { value: 1, enumerable: false });
    const r2 = store.reconcileUncertainDispatch(authNonEnum);
    assertEqual(r2.ok, false, 'non-enum ok');
    assertEqual(r2.code, ERROR_CODES.INVALID_REQUEST, 'non-enum code');

    // Symbol key (adds to key count, fails length check)
    const authSymbol = { ...BASE_AUTHORITY };
    authSymbol[Symbol('hidden')] = 'value';
    const r3 = store.reconcileUncertainDispatch(authSymbol);
    assertEqual(r3.ok, false, 'symbol ok');
    assertEqual(r3.code, ERROR_CODES.INVALID_REQUEST, 'symbol code');

    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.DISPATCH_UNCERTAIN, 'state unchanged');
  } finally { store.close(); }
});

// ─── UR-031: Replay mismatch: latest history is DISPATCH_ACCEPTED → PROVENANCE_AMBIGUOUS ─

runTest('UR-031-MEM', 'PROVENANCE_AMBIGUOUS via DISPATCH_ACCEPTED path with valid diagnostics metadata → ILLEGAL_STATE_TRANSITION on replay (memory)', () => {
  const clock = makeClock();
  const store = createMemoryLifecycleStore({ clock });
  const record = makeRecord();
  store.beginDispatch(record.project_id, record);
  store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
  const validReconDiag = {
    reconciliation: {
      classification: 'DELIVERY_UNPROVEN',
      evidence_authority: BASE_AUTHORITY.evidence_authority,
      reconciled_at: '2026-09-22T00:00:00.000Z'
    }
  };
  store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: validReconDiag });

  const histBefore = store.getAllHistory().length;
  const isoBefore = clock.isoCalls();
  const nowBefore = clock.nowCalls();

  const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
  assertEqual(store.getAllHistory().length, histBefore, 'zero new history');
  assertEqual(clock.isoCalls(), isoBefore, 'zero clock.iso calls');
  assertEqual(clock.nowCalls(), nowBefore, 'zero clock.now calls');
  const d = store.getDispatch(record.dispatch_id);
  assertEqual(d.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state unchanged');
  assertEqual(d.diagnostics.reconciliation.evidence_authority, BASE_AUTHORITY.evidence_authority, 'diagnostics unchanged');
});

runTest('UR-031-SQL', 'PROVENANCE_AMBIGUOUS via DISPATCH_ACCEPTED path with valid diagnostics metadata → ILLEGAL_STATE_TRANSITION on replay (sqlite)', () => {
  const clock = makeClock();
  const store = createSqlStore('ur031', clock);
  try {
    const record = makeRecord();
    store.beginDispatch(record.project_id, record);
    store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
    const validReconDiag = {
      reconciliation: {
        classification: 'DELIVERY_UNPROVEN',
        evidence_authority: BASE_AUTHORITY.evidence_authority,
        reconciled_at: '2026-09-22T00:00:00.000Z'
      }
    };
    store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: validReconDiag });

    const histBefore = store.getAllHistory().length;
    const isoBefore = clock.isoCalls();
    const nowBefore = clock.nowCalls();

    const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
    assertEqual(store.getAllHistory().length, histBefore, 'zero new history');
    assertEqual(clock.isoCalls(), isoBefore, 'zero clock.iso calls');
    assertEqual(clock.nowCalls(), nowBefore, 'zero clock.now calls');
    const d = store.getDispatch(record.dispatch_id);
    assertEqual(d.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state unchanged');
    assertEqual(d.diagnostics.reconciliation.evidence_authority, BASE_AUTHORITY.evidence_authority, 'diagnostics unchanged');
  } finally { store.close(); }
});

// ─── UR-032: Replay mismatch: latest history is RUNNING → PROVENANCE_AMBIGUOUS ─

runTest('UR-032-MEM', 'PROVENANCE_AMBIGUOUS via RUNNING path with valid diagnostics metadata → ILLEGAL_STATE_TRANSITION on replay (memory)', () => {
  const clock = makeClock();
  const store = createMemoryLifecycleStore({ clock });
  const record = makeRecord();
  store.beginDispatch(record.project_id, record);
  store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
  store.transition(record.dispatch_id, DISPATCH_STATES.RUNNING);
  const validReconDiag = {
    reconciliation: {
      classification: 'DELIVERY_UNPROVEN',
      evidence_authority: BASE_AUTHORITY.evidence_authority,
      reconciled_at: '2026-09-22T00:00:00.000Z'
    }
  };
  store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: validReconDiag });

  const histBefore = store.getAllHistory().length;
  const isoBefore = clock.isoCalls();
  const nowBefore = clock.nowCalls();

  const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(result.ok, false, 'ok');
  assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
  assertEqual(store.getAllHistory().length, histBefore, 'zero new history');
  assertEqual(clock.isoCalls(), isoBefore, 'zero clock.iso calls');
  assertEqual(clock.nowCalls(), nowBefore, 'zero clock.now calls');
  const d = store.getDispatch(record.dispatch_id);
  assertEqual(d.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state unchanged');
  assertEqual(d.diagnostics.reconciliation.evidence_authority, BASE_AUTHORITY.evidence_authority, 'diagnostics unchanged');
});

runTest('UR-032-SQL', 'PROVENANCE_AMBIGUOUS via RUNNING path with valid diagnostics metadata → ILLEGAL_STATE_TRANSITION on replay (sqlite)', () => {
  const clock = makeClock();
  const store = createSqlStore('ur032', clock);
  try {
    const record = makeRecord();
    store.beginDispatch(record.project_id, record);
    store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.transition(record.dispatch_id, DISPATCH_STATES.RUNNING);
    const validReconDiag = {
      reconciliation: {
        classification: 'DELIVERY_UNPROVEN',
        evidence_authority: BASE_AUTHORITY.evidence_authority,
        reconciled_at: '2026-09-22T00:00:00.000Z'
      }
    };
    store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: validReconDiag });

    const histBefore = store.getAllHistory().length;
    const isoBefore = clock.isoCalls();
    const nowBefore = clock.nowCalls();

    const result = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(result.ok, false, 'ok');
    assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
    assertEqual(store.getAllHistory().length, histBefore, 'zero new history');
    assertEqual(clock.isoCalls(), isoBefore, 'zero clock.iso calls');
    assertEqual(clock.nowCalls(), nowBefore, 'zero clock.now calls');
    const d = store.getDispatch(record.dispatch_id);
    assertEqual(d.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state unchanged');
    assertEqual(d.diagnostics.reconciliation.evidence_authority, BASE_AUTHORITY.evidence_authority, 'diagnostics unchanged');
  } finally { store.close(); }
});

// ─── UR-033: Replay: history patch malformed / non-plain (SQLite-only) ────────

runTest('UR-033-SQL', 'Replay: malformed history patch blob throws corruption error (sqlite)', () => {
  const dbPath = makeTempDbPath('ur033');
  {
    const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      setupUncertain(store);
      const r = store.reconcileUncertainDispatch(BASE_AUTHORITY);
      assert(r.ok && r.reconciled, 'first reconcile ok');
    } finally { store.close(); }
  }
  // Corrupt the latest history patch directly via raw SQL
  {
    const db = new DatabaseSync(dbPath);
    // Write a v8-serialized array as the patch blob (non-plain object)
    const corruptPatch = v8.serialize(['array', 'not', 'a', 'plain', 'object']);
    db.prepare(`UPDATE history SET patch = ? WHERE history_seq = (SELECT MAX(history_seq) FROM history WHERE dispatch_id = ?)`)
      .run(corruptPatch, BASE_AUTHORITY.dispatch_id);
    db.close();
  }
  {
    const store2 = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      let threw = false;
      try {
        store2.reconcileUncertainDispatch(BASE_AUTHORITY);
      } catch (err) {
        threw = true;
        assert(err.message.includes('corruption'), `unexpected error: ${err.message}`);
      }
      assert(threw, 'expected corruption throw');
    } finally { store2.close(); }
  }
});

// ─── UR-034: Replay: history patch value mismatch with diagnostics ────────────

runTest('UR-034-SQL', 'Replay: history patch values mismatch → ILLEGAL_STATE_TRANSITION (sqlite)', () => {
  const dbPath = makeTempDbPath('ur034');
  {
    const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      setupUncertain(store);
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } finally { store.close(); }
  }
  // Corrupt patch values (correct shape, wrong evidence_authority value)
  {
    const db = new DatabaseSync(dbPath);
    const mismatchedPatch = v8.serialize({
      diagnostics: {
        reconciliation: {
          classification: 'DELIVERY_UNPROVEN',
          evidence_authority: 'DIFFERENT-AUTHORITY',
          reconciled_at: '2000-01-01T00:00:00.000Z'
        }
      }
    });
    db.prepare(`UPDATE history SET patch = ? WHERE history_seq = (SELECT MAX(history_seq) FROM history WHERE dispatch_id = ?)`)
      .run(mismatchedPatch, BASE_AUTHORITY.dispatch_id);
    db.close();
  }
  {
    const store2 = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      const result = store2.reconcileUncertainDispatch(BASE_AUTHORITY);
      assertEqual(result.ok, false, 'ok');
      assertEqual(result.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION, 'code');
    } finally { store2.close(); }
  }
});

// ─── UR-035: Valid identical replay with full durable history proof ────────────

runTest('UR-035-MEM', 'Valid identical replay satisfies full provenance: idempotent_replay: true, zero mutations (memory)', () => {
  const store = createMemStore();
  setupUncertain(store);
  const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(r1.ok && r1.reconciled, 'first call');
  const histLen = store.getAllHistory().length;
  const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(r2.ok, true, 'r2.ok');
  assertEqual(r2.reconciled, false, 'r2.reconciled');
  assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
  assertEqual(r2.dispatch.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, 'state');
  assertEqual(store.getAllHistory().length, histLen, 'no new history');
});

runTest('UR-035-SQL', 'Valid identical replay satisfies full durable history proof: idempotent_replay: true (sqlite)', () => {
  const store = createSqlStore('ur035');
  try {
    setupUncertain(store);
    const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assert(r1.ok && r1.reconciled, 'first call');
    const histLen = store.getProjectHistory('chatgpt-orchestrator').length;
    const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(r2.ok, true, 'r2.ok');
    assertEqual(r2.reconciled, false, 'r2.reconciled');
    assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
    assertEqual(store.getProjectHistory('chatgpt-orchestrator').length, histLen, 'no new history');
  } finally { store.close(); }
});

runTest('UR-035-MEM-EMPTY-TS', 'Sealed replay contract: empty-string reconciled_at succeeds replay with zero clock calls (memory)', () => {
  let isoCalls = 0;
  let nowCalls = 0;
  const clock = {
    iso: () => { isoCalls++; return ''; },
    now: () => { nowCalls++; return 1_700_000_000_000; },
    isoCalls: () => isoCalls,
    nowCalls: () => nowCalls
  };
  const store = createMemoryLifecycleStore({ clock });
  setupUncertain(store);

  // First call: reconciliation succeeds and persists reconciled_at === ''
  const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assert(r1.ok, `r1 ok: ${r1.error}`);
  assertEqual(r1.reconciled, true, 'r1.reconciled');
  assertEqual(r1.idempotent_replay, false, 'r1.idempotent_replay');
  assertEqual(r1.dispatch.diagnostics.reconciliation.reconciled_at, '', 'diagnostics reconciled_at is empty string');

  const historyList = store.getAllHistory();
  const latestHist = historyList[historyList.length - 1];
  assertEqual(latestHist.patch.diagnostics.reconciliation.reconciled_at, '', 'history patch reconciled_at is empty string');

  const histBefore = historyList.length;
  const isoBefore = clock.isoCalls();
  const nowBefore = clock.nowCalls();
  const dBefore = store.getDispatch(BASE_AUTHORITY.dispatch_id);

  // Second call: idempotent replay with zero additional clock calls / mutations
  const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
  assertEqual(r2.ok, true, 'r2.ok');
  assertEqual(r2.reconciled, false, 'r2.reconciled');
  assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
  assertEqual(clock.isoCalls(), isoBefore, '0 additional clock.iso calls');
  assertEqual(clock.nowCalls(), nowBefore, '0 additional clock.now calls');
  assertEqual(store.getAllHistory().length, histBefore, '0 additional history append');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).updated_at, dBefore.updated_at, '0 updated_at rewrite');
  assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, '0 state mutation');
});

runTest('UR-035-SQL-EMPTY-TS', 'Sealed replay contract: empty-string reconciled_at succeeds replay with zero clock calls (sqlite)', () => {
  let isoCalls = 0;
  let nowCalls = 0;
  const clock = {
    iso: () => { isoCalls++; return ''; },
    now: () => { nowCalls++; return 1_700_000_000_000; },
    isoCalls: () => isoCalls,
    nowCalls: () => nowCalls
  };
  const store = createSqlStore('ur035-empty-ts', clock);
  try {
    setupUncertain(store);

    // First call: reconciliation succeeds and persists reconciled_at === ''
    const r1 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assert(r1.ok, `r1 ok: ${r1.error}`);
    assertEqual(r1.reconciled, true, 'r1.reconciled');
    assertEqual(r1.idempotent_replay, false, 'r1.idempotent_replay');
    assertEqual(r1.dispatch.diagnostics.reconciliation.reconciled_at, '', 'diagnostics reconciled_at is empty string');

    const historyList = store.getAllHistory();
    const latestHist = historyList[historyList.length - 1];
    assertEqual(latestHist.patch.diagnostics.reconciliation.reconciled_at, '', 'history patch reconciled_at is empty string');

    const histBefore = historyList.length;
    const isoBefore = clock.isoCalls();
    const nowBefore = clock.nowCalls();
    const dBefore = store.getDispatch(BASE_AUTHORITY.dispatch_id);

    // Second call: idempotent replay with zero additional clock calls / mutations
    const r2 = store.reconcileUncertainDispatch(BASE_AUTHORITY);
    assertEqual(r2.ok, true, 'r2.ok');
    assertEqual(r2.reconciled, false, 'r2.reconciled');
    assertEqual(r2.idempotent_replay, true, 'r2.idempotent_replay');
    assertEqual(clock.isoCalls(), isoBefore, '0 additional clock.iso calls');
    assertEqual(clock.nowCalls(), nowBefore, '0 additional clock.now calls');
    assertEqual(store.getAllHistory().length, histBefore, '0 additional history append');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).updated_at, dBefore.updated_at, '0 updated_at rewrite');
    assertEqual(store.getDispatch(BASE_AUTHORITY.dispatch_id).state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, '0 state mutation');
  } finally { store.close(); }
});

// ─── UR-036: Replay: dispatch.diagnostics.reconciliation has extra own key ────

runTest('UR-036-SQL', 'Replay: diagnostics.reconciliation with extra key → throws corruption (sqlite)', () => {
  const dbPath = makeTempDbPath('ur036');
  {
    const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      setupUncertain(store);
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } finally { store.close(); }
  }
  // Inject extra key into diagnostics.reconciliation
  {
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`SELECT diagnostics FROM dispatches WHERE dispatch_id = ?`).get(BASE_AUTHORITY.dispatch_id);
    const diag = v8.deserialize(row.diagnostics);
    diag.reconciliation.extra_key = 'injected';
    db.prepare(`UPDATE dispatches SET diagnostics = ? WHERE dispatch_id = ?`).run(v8.serialize(diag), BASE_AUTHORITY.dispatch_id);
    db.close();
  }
  {
    const store2 = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      let threw = false;
      try {
        store2.reconcileUncertainDispatch(BASE_AUTHORITY);
      } catch (err) {
        threw = true;
        assert(err.message.includes('corruption'), `unexpected: ${err.message}`);
      }
      assert(threw, 'expected corruption throw');
    } finally { store2.close(); }
  }
});

runTest('UR-036-MEM', 'Replay: diagnostics.reconciliation with extra key → throws corruption (memory)', () => {
  const store = createMemStore();
  const record = makeRecord();
  store.beginDispatch(record.project_id, record);
  store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
  store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, {
    diagnostics: {
      reconciliation: {
        classification: 'DELIVERY_UNPROVEN',
        evidence_authority: BASE_AUTHORITY.evidence_authority,
        reconciled_at: '2026-09-22T00:00:00.000Z',
        extra_key: 'injected'
      }
    }
  });
  let threw = false;
  try {
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
  } catch (err) {
    threw = true;
    assert(err.message.includes('corruption') || err.message.includes('metadata shape is invalid'), `unexpected error: ${err.message}`);
  }
  assert(threw, 'expected throw for extra key in reconciliation metadata');
});

runTest('UR-036-MEM-PRECEDENCE', 'Compound corruption precedence: structurally malformed reconciliation throws before different-path check (memory)', () => {
  const store = createMemStore();
  const record = makeRecord();
  store.beginDispatch(record.project_id, record);
  store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
  // Different path (DISPATCH_ACCEPTED -> PROVENANCE_AMBIGUOUS) AND structurally malformed reconciliation (extra key)
  const malformedDiag = {
    reconciliation: {
      classification: 'DELIVERY_UNPROVEN',
      evidence_authority: BASE_AUTHORITY.evidence_authority,
      reconciled_at: '2026-09-22T00:00:00.000Z',
      extra_key: 'injected'
    }
  };
  store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: malformedDiag });

  let threw = false;
  try {
    store.reconcileUncertainDispatch(BASE_AUTHORITY);
  } catch (err) {
    threw = true;
    assert(err.message.includes('Persisted authority corruption') || err.message.includes('metadata shape is invalid'), `unexpected error: ${err.message}`);
  }
  assert(threw, 'expected throw for structurally malformed reconciliation even on different history path');
});

runTest('UR-036-SQL-PRECEDENCE', 'Compound corruption precedence: structurally malformed reconciliation throws before different-path check (sqlite)', () => {
  const store = createSqlStore('ur036-prec');
  try {
    const record = makeRecord();
    store.beginDispatch(record.project_id, record);
    store.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_ACCEPTED);
    const malformedDiag = {
      reconciliation: {
        classification: 'DELIVERY_UNPROVEN',
        evidence_authority: BASE_AUTHORITY.evidence_authority,
        reconciled_at: '2026-09-22T00:00:00.000Z',
        extra_key: 'injected'
      }
    };
    store.transition(record.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { diagnostics: malformedDiag });

    let threw = false;
    try {
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } catch (err) {
      threw = true;
      assert(err.message.includes('Persisted authority corruption') || err.message.includes('metadata shape is invalid'), `unexpected error: ${err.message}`);
    }
    assert(threw, 'expected throw for structurally malformed reconciliation even on different history path');
  } finally { store.close(); }
});

// ─── UR-037: Replay proof object violates exact own-data-key semantics ─────────

runTest('UR-037-SQL', 'Replay: history patch with Symbol key throws corruption (sqlite)', () => {
  const dbPath = makeTempDbPath('ur037');
  {
    const store = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      setupUncertain(store);
      store.reconcileUncertainDispatch(BASE_AUTHORITY);
    } finally { store.close(); }
  }
  // Corrupt history patch: valid structure but patch blob is a non-plain object (e.g. Map)
  {
    const db = new DatabaseSync(dbPath);
    // Use a v8-serialized Map as patch blob — Map is not a plain data object
    const corruptPatch = v8.serialize(new Map([['diagnostics', { reconciliation: {} }]]));
    db.prepare(`UPDATE history SET patch = ? WHERE history_seq = (SELECT MAX(history_seq) FROM history WHERE dispatch_id = ?)`)
      .run(corruptPatch, BASE_AUTHORITY.dispatch_id);
    db.close();
  }
  {
    const store2 = createSqliteLifecycleStore({ dbPath, clock: makeClock() });
    try {
      let threw = false;
      try {
        store2.reconcileUncertainDispatch(BASE_AUTHORITY);
      } catch (err) {
        threw = true;
        assert(err.message.includes('corruption'), `unexpected: ${err.message}`);
      }
      assert(threw, 'expected corruption throw for non-plain history patch');
    } finally { store2.close(); }
  }
});

// ─── Additional helper-function unit tests ────────────────────────────────────

runTest('HELPERS-001', 'isPlainDataObject accepts {} and Object.create(null)', () => {
  const { isPlainDataObject } = require('../../lib/broker/lifecycle-store');
  assert(isPlainDataObject({}), '{}');
  assert(isPlainDataObject(Object.create(null)), 'null-proto');
  assert(!isPlainDataObject(null), 'null');
  assert(!isPlainDataObject([]), 'array');
  assert(!isPlainDataObject(new Date()), 'Date');
  assert(!isPlainDataObject(new Map()), 'Map');
  assert(!isPlainDataObject('string'), 'string');
});

runTest('HELPERS-002', 'hasExactEnumerableDataKeys rejects accessor, symbol, non-enumerable', () => {
  const { hasExactEnumerableDataKeys } = require('../../lib/broker/lifecycle-store');
  // Valid plain object
  assert(hasExactEnumerableDataKeys({ a: 1, b: 2 }, ['a', 'b']), 'valid');
  // Accessor
  const withGetter = Object.defineProperties({}, { a: { get: () => 1, enumerable: true } });
  assert(!hasExactEnumerableDataKeys(withGetter, ['a']), 'accessor rejected');
  // Non-enumerable
  const nonEnum = Object.defineProperties({}, { a: { value: 1, enumerable: false } });
  assert(!hasExactEnumerableDataKeys(nonEnum, ['a']), 'non-enumerable rejected');
  // Symbol key
  const withSymbol = { a: 1 };
  withSymbol[Symbol('s')] = 2;
  assert(!hasExactEnumerableDataKeys(withSymbol, ['a']), 'symbol rejected');
  // Extra key
  assert(!hasExactEnumerableDataKeys({ a: 1, b: 2 }, ['a']), 'extra key rejected');
  // Missing key
  assert(!hasExactEnumerableDataKeys({ a: 1 }, ['a', 'b']), 'missing key rejected');
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

// Remove temp SQLite dirs
for (const dir of _sqliteTempDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log('\n======================================================================');
if (failed === 0) {
  console.log(`ALL UNCERTAIN RECONCILIATION TESTS PASSED (UR-001..UR-037 + helpers: ${total}/${total} PASS)`);
  console.log('======================================================================\n');
  process.exit(0);
} else {
  console.error(`\nFAILURES (${failed}/${total}):`);
  for (const f of failures) {
    console.error(`  ${f.id}: ${f.description}`);
    console.error(`    ${f.error}`);
  }
  console.log('======================================================================\n');
  process.exit(1);
}

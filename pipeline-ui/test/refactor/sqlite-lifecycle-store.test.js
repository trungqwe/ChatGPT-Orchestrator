'use strict';

/**
 * SQLite Lifecycle Store Test Suite (SL-001 .. SL-030)
 *
 * Validates the durable SQLite lifecycle store implementation conforming to
 * the exact existing store interface, including cross-process concurrency,
 * restart resilience, write-ahead durability, and lossless structured serialization.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const v8 = require('node:v8');

const { createSqliteLifecycleStore } = require('../../lib/broker/sqlite-lifecycle-store');
const { createMemoryLifecycleStore } = require('../../lib/broker/lifecycle-store');
const { createBroker } = require('../../lib/broker/broker');
const {
  DISPATCH_STATES,
  ERROR_CODES,
  isActiveState,
  isAllowedLifecycleTransition,
  computeRequestFingerprint
} = require('../../lib/broker/contracts');

// Temporary directory management for test isolation
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-run-'));

function getTempDbPath(name) {
  return path.join(testTempDir, `${name}.sqlite3`);
}

function cleanupTempDir() {
  try {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch {}
}

function createBrokerHarness({
  lifecycleStore,
  workerPort,
  workspaceStateId = 'ws-test-head',
  projectWorkerSession = 'sess_001',
  projectId = 'test-project'
}) {
  const project = {
    id: projectId,
    root: 'D:\\TU_CODE\\test-project',
    workerSession: projectWorkerSession
  };

  const registryPort = {
    getProject: async (id) => (id === projectId ? project : null)
  };

  const workspacePort = {
    getWorkspaceState: async (p) => ({ workspace_state_id: workspaceStateId })
  };

  let idCounter = 100;
  const idFactory = {
    nextDispatchId: () => `D-AUTO-${++idCounter}`
  };

  let simTime = 1700000000000;
  const clock = {
    now: () => simTime,
    iso: () => new Date(simTime).toISOString(),
    advance: (ms) => { simTime += ms; }
  };

  const broker = createBroker({
    registryPort,
    workspacePort,
    lifecycleStore,
    workerPort,
    clock,
    idFactory
  });

  return { broker, registryPort, workspacePort, clock, project, idFactory };
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING SQLITE LIFECYCLE STORE TEST SUITE (SL-001 .. SL-030)');
  console.log('======================================================================\n');

  // SL-001: create new DB/schema
  {
    const dbPath = getTempDbPath('sl-001');
    const store = createSqliteLifecycleStore({ dbPath });
    assert.strictEqual(store.isDurable, true);

    const directDb = new DatabaseSync(dbPath);
    const ver = directDb.prepare('PRAGMA user_version').get();
    assert.strictEqual(ver.user_version, 1);

    const tables = directDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all();
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('dispatches'), 'dispatches table must exist');
    assert.ok(tableNames.includes('history'), 'history table must exist');

    const indexes = directDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_active_project'"
    ).all();
    assert.strictEqual(indexes.length, 1, 'idx_active_project index must exist');

    directDb.close();
    store.close();
    console.log('✓ SL-001 PASSED: create new DB/schema');
  }

  // SL-002: begin persists and reopen returns same dispatch
  {
    const dbPath = getTempDbPath('sl-002');
    const store1 = createSqliteLifecycleStore({ dbPath });
    const beginRes = store1.beginDispatch('proj-1', {
      dispatch_id: 'D-002',
      project_id: 'proj-1',
      work_order_id: 'WO-002',
      expected_workspace_state_id: 'ws-002',
      request_fingerprint: 'fp-002',
      directive: 'directive-002',
      audit_metadata: { env: 'test' }
    });
    assert.strictEqual(beginRes.ok, true);
    assert.strictEqual(beginRes.dispatch.state, DISPATCH_STATES.DISPATCHING);
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-002');
    assert.ok(loaded !== null);
    assert.strictEqual(loaded.dispatch_id, 'D-002');
    assert.strictEqual(loaded.project_id, 'proj-1');
    assert.strictEqual(loaded.work_order_id, 'WO-002');
    assert.strictEqual(loaded.expected_workspace_state_id, 'ws-002');
    assert.strictEqual(loaded.directive, 'directive-002');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCHING);
    assert.deepStrictEqual(loaded.audit_metadata, { env: 'test' });

    const active = store2.getActiveDispatch('proj-1');
    assert.ok(active !== null);
    assert.strictEqual(active.dispatch_id, 'D-002');
    store2.close();
    console.log('✓ SL-002 PASSED: begin persists and reopen returns same dispatch');
  }

  // SL-003: accepted state persists across reopen
  {
    const dbPath = getTempDbPath('sl-003');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-003',
      project_id: 'proj-1',
      work_order_id: 'WO-003',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-003',
      directive: 'dir-003',
      audit_metadata: null
    });
    const tRes = store1.transition('D-003', DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(tRes.ok, true);
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-003');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    const active = store2.getActiveDispatch('proj-1');
    assert.ok(active !== null);
    assert.strictEqual(active.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    store2.close();
    console.log('✓ SL-003 PASSED: accepted state persists across reopen');
  }

  // SL-004: RUNNING persists across reopen
  {
    const dbPath = getTempDbPath('sl-004');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-004',
      project_id: 'proj-1',
      work_order_id: 'WO-004',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-004',
      directive: 'dir-004',
      audit_metadata: null
    });
    store1.transition('D-004', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store1.transition('D-004', DISPATCH_STATES.RUNNING);
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-004');
    assert.strictEqual(loaded.state, DISPATCH_STATES.RUNNING);
    const active = store2.getActiveDispatch('proj-1');
    assert.ok(active !== null);
    assert.strictEqual(active.state, DISPATCH_STATES.RUNNING);
    store2.close();
    console.log('✓ SL-004 PASSED: RUNNING persists across reopen');
  }

  // SL-005: READY_FOR_REVIEW persists and is inactive
  {
    const dbPath = getTempDbPath('sl-005');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-005',
      project_id: 'proj-1',
      work_order_id: 'WO-005',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-005',
      directive: 'dir-005',
      audit_metadata: null
    });
    store1.transition('D-005', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store1.transition('D-005', DISPATCH_STATES.READY_FOR_REVIEW);
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-005');
    assert.strictEqual(loaded.state, DISPATCH_STATES.READY_FOR_REVIEW);
    const active = store2.getActiveDispatch('proj-1');
    assert.strictEqual(active, null, 'READY_FOR_REVIEW must not be active');
    store2.close();
    console.log('✓ SL-005 PASSED: READY_FOR_REVIEW persists and is inactive');
  }

  // SL-006: DISPATCH_UNCERTAIN persists and remains active
  {
    const dbPath = getTempDbPath('sl-006');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-006',
      project_id: 'proj-1',
      work_order_id: 'WO-006',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-006',
      directive: 'dir-006',
      audit_metadata: null
    });
    store1.transition('D-006', DISPATCH_STATES.DISPATCH_UNCERTAIN, { error: 'Network timeout' });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-006');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    assert.strictEqual(loaded.error, 'Network timeout');
    const active = store2.getActiveDispatch('proj-1');
    assert.ok(active !== null, 'DISPATCH_UNCERTAIN must remain active');
    assert.strictEqual(active.dispatch_id, 'D-006');
    assert.strictEqual(active.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    store2.close();
    console.log('✓ SL-006 PASSED: DISPATCH_UNCERTAIN persists and remains active');
  }

  // SL-007: PROVENANCE_AMBIGUOUS persists and is inactive
  {
    const dbPath = getTempDbPath('sl-007');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-007',
      project_id: 'proj-1',
      work_order_id: 'WO-007',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-007',
      directive: 'dir-007',
      audit_metadata: null
    });
    store1.transition('D-007', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store1.transition('D-007', DISPATCH_STATES.PROVENANCE_AMBIGUOUS, { error: 'Identity mismatch' });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-007');
    assert.strictEqual(loaded.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
    assert.strictEqual(loaded.error, 'Identity mismatch');
    const active = store2.getActiveDispatch('proj-1');
    assert.strictEqual(active, null, 'PROVENANCE_AMBIGUOUS must be inactive');
    store2.close();
    console.log('✓ SL-007 PASSED: PROVENANCE_AMBIGUOUS persists and is inactive');
  }

  // SL-008: idempotent replay survives reopen
  {
    const dbPath = getTempDbPath('sl-008');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-008-A',
      project_id: 'proj-1',
      work_order_id: 'WO-008',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-008-exact',
      directive: 'dir-008',
      audit_metadata: null
    });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const replayRes = store2.beginDispatch('proj-1', {
      dispatch_id: 'D-008-B',
      project_id: 'proj-1',
      work_order_id: 'WO-008',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-008-exact',
      directive: 'dir-008',
      audit_metadata: null
    });
    assert.strictEqual(replayRes.ok, false);
    assert.strictEqual(replayRes.code, ERROR_CODES.IDEMPOTENT_REPLAY);
    assert.strictEqual(replayRes.existing.dispatch_id, 'D-008-A');
    store2.close();
    console.log('✓ SL-008 PASSED: idempotent replay survives reopen');
  }

  // SL-009: duplicate WorkOrder conflict survives reopen
  {
    const dbPath = getTempDbPath('sl-009');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-009-A',
      project_id: 'proj-1',
      work_order_id: 'WO-009',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-009-orig',
      directive: 'dir-009',
      audit_metadata: null
    });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const conflictRes = store2.beginDispatch('proj-1', {
      dispatch_id: 'D-009-B',
      project_id: 'proj-1',
      work_order_id: 'WO-009',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-009-modified',
      directive: 'dir-009-modified',
      audit_metadata: null
    });
    assert.strictEqual(conflictRes.ok, false);
    assert.strictEqual(conflictRes.code, ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT);
    assert.strictEqual(conflictRes.existing.dispatch_id, 'D-009-A');
    store2.close();
    console.log('✓ SL-009 PASSED: duplicate WorkOrder conflict survives reopen');
  }

  // SL-010: WORKER_BUSY survives reopen
  {
    const dbPath = getTempDbPath('sl-010');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-010-A',
      project_id: 'proj-1',
      work_order_id: 'WO-010-A',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-010-A',
      directive: 'dir-010-A',
      audit_metadata: null
    });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const busyRes = store2.beginDispatch('proj-1', {
      dispatch_id: 'D-010-B',
      project_id: 'proj-1',
      work_order_id: 'WO-010-B',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-010-B',
      directive: 'dir-010-B',
      audit_metadata: null
    });
    assert.strictEqual(busyRes.ok, false);
    assert.strictEqual(busyRes.code, ERROR_CODES.WORKER_BUSY);
    assert.strictEqual(busyRes.existing.dispatch_id, 'D-010-A');
    store2.close();
    console.log('✓ SL-010 PASSED: WORKER_BUSY survives reopen');
  }

  // SL-011: duplicate dispatch ID fails closed
  {
    const dbPath = getTempDbPath('sl-011');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-011-COLLIDE',
      project_id: 'proj-1',
      work_order_id: 'WO-011-1',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-011-1',
      directive: 'dir-1',
      audit_metadata: null
    });
    // Complete first dispatch so project is not busy
    store.transition('D-011-COLLIDE', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.transition('D-011-COLLIDE', DISPATCH_STATES.READY_FOR_REVIEW);

    // Attempt to reuse same dispatch_id
    const collideRes = store.beginDispatch('proj-1', {
      dispatch_id: 'D-011-COLLIDE',
      project_id: 'proj-1',
      work_order_id: 'WO-011-2',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-011-2',
      directive: 'dir-2',
      audit_metadata: null
    });
    assert.strictEqual(collideRes.ok, false);
    assert.strictEqual(collideRes.code, ERROR_CODES.DISPATCH_ID_COLLISION);
    store.close();
    console.log('✓ SL-011 PASSED: duplicate dispatch ID fails closed');
  }

  // SL-012: illegal transition rejected
  {
    const dbPath = getTempDbPath('sl-012');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-012',
      project_id: 'proj-1',
      work_order_id: 'WO-012',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-012',
      directive: 'dir-012',
      audit_metadata: null
    });
    // From DISPATCHING directly to RUNNING is illegal
    const illegalRes = store.transition('D-012', DISPATCH_STATES.RUNNING);
    assert.strictEqual(illegalRes.ok, false);
    assert.strictEqual(illegalRes.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION);
    assert.strictEqual(illegalRes.currentState, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(illegalRes.targetState, DISPATCH_STATES.RUNNING);

    const loaded = store.getDispatch('D-012');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCHING, 'State must remain DISPATCHING');
    store.close();
    console.log('✓ SL-012 PASSED: illegal transition rejected');
  }

  // SL-013: immutable patch rejected
  {
    const dbPath = getTempDbPath('sl-013');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-013',
      project_id: 'proj-1',
      work_order_id: 'WO-013',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-013',
      directive: 'dir-013',
      audit_metadata: null
    });
    const patchRes = store.transition('D-013', DISPATCH_STATES.DISPATCH_ACCEPTED, {
      directive: 'tampered-directive'
    });
    assert.strictEqual(patchRes.ok, false);
    assert.strictEqual(patchRes.code, ERROR_CODES.IMMUTABLE_FIELD_VIOLATION);
    assert.strictEqual(patchRes.field, 'directive');

    const loaded = store.getDispatch('D-013');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(loaded.directive, 'dir-013');
    store.close();
    console.log('✓ SL-013 PASSED: immutable patch rejected');
  }

  // SL-014: nested audit_metadata detached + persisted losslessly
  {
    const dbPath = getTempDbPath('sl-014');
    const store1 = createSqliteLifecycleStore({ dbPath });

    const complexMetadata = {
      big: 9007199254740993n,
      date: new Date('2026-09-19T04:00:00.000Z'),
      map: new Map([['key1', 'val1'], ['key2', 42]]),
      set: new Set([1, 'two', 3n]),
      buf: new Uint8Array([10, 20, 30, 40]),
      nested: { deeply: { value: true } }
    };

    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-014',
      project_id: 'proj-1',
      work_order_id: 'WO-014',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-014',
      directive: 'dir-014',
      audit_metadata: complexMetadata
    });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-014');
    const meta = loaded.audit_metadata;
    assert.ok(meta !== null);
    assert.strictEqual(meta.big, 9007199254740993n);
    assert.ok(meta.date instanceof Date);
    assert.strictEqual(meta.date.toISOString(), '2026-09-19T04:00:00.000Z');
    assert.ok(meta.map instanceof Map);
    assert.strictEqual(meta.map.get('key1'), 'val1');
    assert.strictEqual(meta.map.get('key2'), 42);
    assert.ok(meta.set instanceof Set);
    assert.ok(meta.set.has(1));
    assert.ok(meta.set.has('two'));
    assert.ok(meta.set.has(3n));
    assert.ok(meta.buf instanceof Uint8Array);
    assert.strictEqual(Buffer.compare(Buffer.from(meta.buf), Buffer.from([10, 20, 30, 40])), 0);
    assert.strictEqual(meta.nested.deeply.value, true);
    store2.close();
    console.log('✓ SL-014 PASSED: nested audit_metadata detached + persisted losslessly');
  }

  // SL-015: diagnostics detached + persisted losslessly
  {
    const dbPath = getTempDbPath('sl-015');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-015',
      project_id: 'proj-1',
      work_order_id: 'WO-015',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-015',
      directive: 'dir-015',
      audit_metadata: null
    });

    const complexDiag = {
      code: 'DIAG_FAIL',
      big: 12345678901234567890n,
      date: new Date('2026-01-01T12:00:00.000Z'),
      tags: new Set(['urgent', 'io']),
      meta: new Map([['attempt', 3]])
    };

    store1.transition('D-015', DISPATCH_STATES.DISPATCH_FAILED, {
      error: 'Definitive error',
      diagnostics: complexDiag
    });
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const loaded = store2.getDispatch('D-015');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCH_FAILED);
    assert.strictEqual(loaded.error, 'Definitive error');

    const diag = loaded.diagnostics;
    assert.ok(diag !== null);
    assert.strictEqual(diag.code, 'DIAG_FAIL');
    assert.strictEqual(diag.big, 12345678901234567890n);
    assert.ok(diag.date instanceof Date);
    assert.strictEqual(diag.date.toISOString(), '2026-01-01T12:00:00.000Z');
    assert.ok(diag.tags instanceof Set);
    assert.ok(diag.tags.has('urgent'));
    assert.ok(diag.meta instanceof Map);
    assert.strictEqual(diag.meta.get('attempt'), 3);
    store2.close();
    console.log('✓ SL-015 PASSED: diagnostics detached + persisted losslessly');
  }

  // SL-016: history persists in deterministic sequence
  {
    const dbPath = getTempDbPath('sl-016');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-016',
      project_id: 'proj-1',
      work_order_id: 'WO-016',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-016',
      directive: 'dir-016',
      audit_metadata: null
    });
    store1.transition('D-016', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store1.transition('D-016', DISPATCH_STATES.RUNNING);
    store1.transition('D-016', DISPATCH_STATES.READY_FOR_REVIEW);
    store1.close();

    const store2 = createSqliteLifecycleStore({ dbPath });
    const hist = store2.getProjectHistory('proj-1');
    assert.strictEqual(hist.length, 4);
    assert.strictEqual(hist[0].next_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(hist[0].previous_state, null);
    assert.strictEqual(hist[1].next_state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(hist[1].previous_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(hist[2].next_state, DISPATCH_STATES.RUNNING);
    assert.strictEqual(hist[2].previous_state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(hist[3].next_state, DISPATCH_STATES.READY_FOR_REVIEW);
    assert.strictEqual(hist[3].previous_state, DISPATCH_STATES.RUNNING);

    const allHist = store2.getAllHistory();
    assert.strictEqual(allHist.length, 4);
    assert.deepStrictEqual(allHist, hist);
    store2.close();
    console.log('✓ SL-016 PASSED: history persists in deterministic sequence');
  }

  // SL-017: latest dispatch uses DB sequence
  {
    const dbPath = getTempDbPath('sl-017');
    let clockTime = 2000000000000;
    const mockClock = {
      now: () => clockTime,
      iso: () => new Date(clockTime).toISOString()
    };
    const store = createSqliteLifecycleStore({ dbPath, clock: mockClock });

    // First dispatch has a future timestamp
    clockTime = 2000000000000;
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-017-FIRST',
      project_id: 'proj-1',
      work_order_id: 'WO-017-1',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-1',
      directive: 'dir-1',
      audit_metadata: null
    });
    store.transition('D-017-FIRST', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.transition('D-017-FIRST', DISPATCH_STATES.READY_FOR_REVIEW);

    // Second dispatch has an earlier timestamp (clock skewed backwards)
    clockTime = 1000000000000;
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-017-SECOND',
      project_id: 'proj-1',
      work_order_id: 'WO-017-2',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-2',
      directive: 'dir-2',
      audit_metadata: null
    });

    const latest = store.getLatestDispatch('proj-1');
    assert.strictEqual(latest.dispatch_id, 'D-017-SECOND', 'Latest dispatch must use insertion sequence, not timestamp');
    store.close();
    console.log('✓ SL-017 PASSED: latest dispatch uses DB sequence');
  }

  // SL-018: failed begin transaction leaves no partial dispatch/history
  {
    const dbPath = getTempDbPath('sl-018');
    const store = createSqliteLifecycleStore({ dbPath });

    const failRes = store.beginDispatch('proj-1', {
      dispatch_id: 'D-018-FAIL',
      project_id: 'wrong-project', // Identity mismatch
      work_order_id: 'WO-018',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-018',
      directive: 'dir-018',
      audit_metadata: null
    });
    assert.strictEqual(failRes.ok, false);
    assert.strictEqual(failRes.code, ERROR_CODES.PROJECT_IDENTITY_MISMATCH);

    const directDb = new DatabaseSync(dbPath);
    const dispCount = directDb.prepare('SELECT count(*) as cnt FROM dispatches').get().cnt;
    const histCount = directDb.prepare('SELECT count(*) as cnt FROM history').get().cnt;
    assert.strictEqual(dispCount, 0, 'No dispatches must be inserted on failed begin');
    assert.strictEqual(histCount, 0, 'No history must be inserted on failed begin');
    directDb.close();
    store.close();
    console.log('✓ SL-018 PASSED: failed begin transaction leaves no partial dispatch/history');
  }

  // SL-019: failed transition transaction preserves previous state/history
  {
    const dbPath = getTempDbPath('sl-019');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-019',
      project_id: 'proj-1',
      work_order_id: 'WO-019',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-019',
      directive: 'dir-019',
      audit_metadata: null
    });

    const failTrans = store.transition('D-019', DISPATCH_STATES.RUNNING); // Illegal
    assert.strictEqual(failTrans.ok, false);

    const failPatch = store.transition('D-019', DISPATCH_STATES.DISPATCH_ACCEPTED, { forbidden: 123 }); // Immutable violation
    assert.strictEqual(failPatch.ok, false);

    const loaded = store.getDispatch('D-019');
    assert.strictEqual(loaded.state, DISPATCH_STATES.DISPATCHING);

    const hist = store.getProjectHistory('proj-1');
    assert.strictEqual(hist.length, 1, 'Only initial beginDispatch history must exist');
    store.close();
    console.log('✓ SL-019 PASSED: failed transition transaction preserves previous state/history');
  }

  // SL-020: corrupt DB fails closed without replacement
  {
    const dbPath = getTempDbPath('sl-020');
    fs.writeFileSync(dbPath, 'MALFORMED NON-SQLITE CORRUPT DATA');

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /file is not a database|database disk image is malformed/);

    const content = fs.readFileSync(dbPath, 'utf8');
    assert.strictEqual(content, 'MALFORMED NON-SQLITE CORRUPT DATA', 'File must not be deleted or replaced');
    console.log('✓ SL-020 PASSED: corrupt DB fails closed without replacement');
  }

  // SL-021: wrong schema version fails closed
  {
    const dbPath = getTempDbPath('sl-021');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE dispatches (id INT);
      CREATE TABLE history (id INT);
      CREATE UNIQUE INDEX idx_active_project ON dispatches(id);
      PRAGMA user_version = 2;
    `);
    db.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Unsupported schema version: expected 1, found 2/);
    console.log('✓ SL-021 PASSED: wrong schema version fails closed');
  }

  // SL-022: two independent store instances see same committed state
  {
    const dbPath = getTempDbPath('sl-022');
    const storeA = createSqliteLifecycleStore({ dbPath });
    const storeB = createSqliteLifecycleStore({ dbPath });

    storeA.beginDispatch('proj-1', {
      dispatch_id: 'D-022',
      project_id: 'proj-1',
      work_order_id: 'WO-022',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-022',
      directive: 'dir-022',
      audit_metadata: null
    });

    const activeB = storeB.getActiveDispatch('proj-1');
    assert.ok(activeB !== null);
    assert.strictEqual(activeB.dispatch_id, 'D-022');
    assert.strictEqual(activeB.state, DISPATCH_STATES.DISPATCHING);

    storeA.transition('D-022', DISPATCH_STATES.DISPATCH_ACCEPTED);

    const activeB2 = storeB.getActiveDispatch('proj-1');
    assert.strictEqual(activeB2.state, DISPATCH_STATES.DISPATCH_ACCEPTED);

    storeA.close();
    storeB.close();
    console.log('✓ SL-022 PASSED: two independent store instances see same committed state');
  }

  // SL-023: cross-process same-project race permits only one active dispatch (Section 33)
  {
    const dbPath = getTempDbPath('sl-023');
    // Initialize DB schema
    const initStore = createSqliteLifecycleStore({ dbPath });
    initStore.close();

    const workerScript = path.join(testTempDir, 'worker_race_sl023.js');
    const workerCode = `
      const { createSqliteLifecycleStore } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/broker/sqlite-lifecycle-store'))});
      const [,, dbPath, projectId, workOrderId, dispatchId, fp] = process.argv;
      try {
        const store = createSqliteLifecycleStore({ dbPath });
        const res = store.beginDispatch(projectId, {
          dispatch_id: dispatchId,
          project_id: projectId,
          work_order_id: workOrderId,
          expected_workspace_state_id: 'ws-1',
          request_fingerprint: fp,
          directive: 'race directive',
          audit_metadata: null
        });
        process.stdout.write(JSON.stringify(res) + '\\n');
        store.close();
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\\n');
      }
    `;
    fs.writeFileSync(workerScript, workerCode, 'utf8');

    function runChild(woId, dId, fp) {
      return new Promise((resolve) => {
        const cp = spawn(process.execPath, [
          workerScript, dbPath, 'proj-race', woId, dId, fp
        ]);
        let stdout = '';
        cp.stdout.on('data', d => stdout += d);
        cp.on('close', code => {
          let parsed;
          try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = { ok: false, error: stdout }; }
          resolve({ exitCode: code, res: parsed });
        });
      });
    }

    const [child1, child2] = await Promise.all([
      runChild('WO-RACE-1', 'D-RACE-1', 'fp-race-1'),
      runChild('WO-RACE-2', 'D-RACE-2', 'fp-race-2')
    ]);

    const successCount = (child1.res.ok ? 1 : 0) + (child2.res.ok ? 1 : 0);
    const failCount = (!child1.res.ok ? 1 : 0) + (!child2.res.ok ? 1 : 0);
    assert.strictEqual(successCount, 1, 'Exactly one child process must succeed');
    assert.strictEqual(failCount, 1, 'Exactly one child process must fail');

    const failingChild = !child1.res.ok ? child1 : child2;
    assert.strictEqual(failingChild.res.code, ERROR_CODES.WORKER_BUSY);

    const verifyStore = createSqliteLifecycleStore({ dbPath });
    const active = verifyStore.getActiveDispatch('proj-race');
    assert.ok(active !== null);
    assert.ok(active.dispatch_id === 'D-RACE-1' || active.dispatch_id === 'D-RACE-2');

    const directDb = new DatabaseSync(dbPath);
    const dispCount = directDb.prepare("SELECT count(*) as cnt FROM dispatches WHERE project_id = 'proj-race'").get().cnt;
    assert.strictEqual(dispCount, 1, 'Database must have exactly 1 dispatch for race-project');
    directDb.close();
    verifyStore.close();
    console.log('✓ SL-023 PASSED: cross-process same-project race permits only one active dispatch');
  }

  // SL-024: cross-process different-project dispatches both succeed
  {
    const dbPath = getTempDbPath('sl-024');
    const initStore = createSqliteLifecycleStore({ dbPath });
    initStore.close();

    const workerScript = path.join(testTempDir, 'worker_race_sl024.js');
    const workerCode = `
      const { createSqliteLifecycleStore } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/broker/sqlite-lifecycle-store'))});
      const [,, dbPath, projectId, workOrderId, dispatchId, fp] = process.argv;
      try {
        const store = createSqliteLifecycleStore({ dbPath });
        const res = store.beginDispatch(projectId, {
          dispatch_id: dispatchId,
          project_id: projectId,
          work_order_id: workOrderId,
          expected_workspace_state_id: 'ws-1',
          request_fingerprint: fp,
          directive: 'directive for ' + projectId,
          audit_metadata: null
        });
        process.stdout.write(JSON.stringify(res) + '\\n');
        store.close();
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\\n');
      }
    `;
    fs.writeFileSync(workerScript, workerCode, 'utf8');

    function runChild(proj, woId, dId, fp) {
      return new Promise((resolve) => {
        const cp = spawn(process.execPath, [
          workerScript, dbPath, proj, woId, dId, fp
        ]);
        let stdout = '';
        cp.stdout.on('data', d => stdout += d);
        cp.on('close', code => {
          let parsed;
          try { parsed = JSON.parse(stdout.trim()); } catch (e) { parsed = { ok: false, error: stdout }; }
          resolve({ exitCode: code, res: parsed });
        });
      });
    }

    const [childA, childB] = await Promise.all([
      runChild('proj-alpha', 'WO-ALPHA', 'D-ALPHA', 'fp-alpha'),
      runChild('proj-beta', 'WO-BETA', 'D-BETA', 'fp-beta')
    ]);

    assert.strictEqual(childA.res.ok, true, 'proj-alpha must succeed');
    assert.strictEqual(childB.res.ok, true, 'proj-beta must succeed');

    const verifyStore = createSqliteLifecycleStore({ dbPath });
    assert.ok(verifyStore.getActiveDispatch('proj-alpha') !== null);
    assert.ok(verifyStore.getActiveDispatch('proj-beta') !== null);
    verifyStore.close();
    console.log('✓ SL-024 PASSED: cross-process different-project dispatches both succeed');
  }

  // SL-025: process exits after DISPATCHING; reopened store remains non-IDLE
  {
    const dbPath = getTempDbPath('sl-025');
    const initStore = createSqliteLifecycleStore({ dbPath });
    initStore.close();

    const crashScript = path.join(testTempDir, 'worker_crash_sl025.js');
    const crashCode = `
      const { createSqliteLifecycleStore } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/broker/sqlite-lifecycle-store'))});
      const [,, dbPath] = process.argv;
      const store = createSqliteLifecycleStore({ dbPath });
      store.beginDispatch('proj-crash', {
        dispatch_id: 'D-025-CRASH',
        project_id: 'proj-crash',
        work_order_id: 'WO-025',
        expected_workspace_state_id: 'ws-1',
        request_fingerprint: 'fp-025',
        directive: 'pre-crash directive',
        audit_metadata: null
      });
      // Exit without recording AO outcome
      process.exit(0);
    `;
    fs.writeFileSync(crashScript, crashCode, 'utf8');

    await new Promise((resolve) => {
      const cp = spawn(process.execPath, [crashScript, dbPath]);
      cp.on('close', resolve);
    });

    const store = createSqliteLifecycleStore({ dbPath });
    const active = store.getActiveDispatch('proj-crash');
    assert.ok(active !== null, 'Reopened store must NOT be IDLE');
    assert.strictEqual(active.state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(active.dispatch_id, 'D-025-CRASH');
    store.close();
    console.log('✓ SL-025 PASSED: process exits after DISPATCHING; reopened store remains non-IDLE');
  }

  // SL-026: broker reopened with durable store can worker-wait accepted dispatch (Section 34)
  {
    const dbPath = getTempDbPath('sl-026');
    const storeA = createSqliteLifecycleStore({ dbPath });

    const workerPortA = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async () => ({ ok: true }),
      status: async () => ({ ok: true })
    };

    const harnessA = createBrokerHarness({
      lifecycleStore: storeA,
      workerPort: workerPortA,
      workspaceStateId: 'ws-seal-123'
    });

    const dispRes = await harnessA.broker.dispatchWorker({
      schema_version: 1,
      project_id: 'test-project',
      work_order_id: 'WO-026',
      directive: 'test-directive',
      expected_workspace_state_id: 'ws-seal-123'
    });
    assert.strictEqual(dispRes.ok, true);
    assert.strictEqual(dispRes.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    const originalDispatchId = dispRes.dispatch_id;

    // Close store A completely
    storeA.close();

    // Reopen store B and broker B against the same DB file
    const storeB = createSqliteLifecycleStore({ dbPath });
    let capturedWaitArgs = null;
    const workerPortB = {
      dispatch: async () => { throw new Error('dispatch should not be called on wait'); },
      wait: async (args) => {
        capturedWaitArgs = args;
        return {
          ok: true,
          state: DISPATCH_STATES.READY_FOR_REVIEW,
          dispatch_id: args.dispatch_id,
          work_order_id: args.work_order_id
        };
      },
      status: async () => ({ ok: true })
    };

    const harnessB = createBrokerHarness({
      lifecycleStore: storeB,
      workerPort: workerPortB,
      workspaceStateId: 'ws-seal-123'
    });

    const waitRes = await harnessB.broker.waitWorker({
      project_id: 'test-project',
      dispatch_id: originalDispatchId,
      timeout_secs: 15
    });

    assert.strictEqual(waitRes.ok, true);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.READY_FOR_REVIEW);
    assert.ok(capturedWaitArgs !== null);
    assert.strictEqual(capturedWaitArgs.dispatch_id, originalDispatchId);
    assert.strictEqual(capturedWaitArgs.work_order_id, 'WO-026');
    assert.strictEqual(capturedWaitArgs.expected_workspace_state_id, 'ws-seal-123');

    const loaded = storeB.getDispatch(originalDispatchId);
    assert.strictEqual(loaded.state, DISPATCH_STATES.READY_FOR_REVIEW);
    assert.strictEqual(storeB.getActiveDispatch('test-project'), null);
    storeB.close();
    console.log('✓ SL-026 PASSED: broker reopened with durable store can worker-wait accepted dispatch');
  }

  // SL-027: broker reopened sees uncertain dispatch and does not call worker (Section 34)
  {
    const dbPath = getTempDbPath('sl-027');
    const storeA = createSqliteLifecycleStore({ dbPath });
    storeA.beginDispatch('test-project', {
      dispatch_id: 'D-027',
      project_id: 'test-project',
      work_order_id: 'WO-027',
      expected_workspace_state_id: 'ws-1',
      request_fingerprint: 'fp-027',
      directive: 'test',
      audit_metadata: null
    });
    storeA.transition('D-027', DISPATCH_STATES.DISPATCH_UNCERTAIN, { error: 'Transport crashed' });
    storeA.close();

    const storeB = createSqliteLifecycleStore({ dbPath });
    let waitCalled = false;
    const workerPortB = {
      dispatch: async () => { throw new Error('dispatch not expected'); },
      wait: async () => {
        waitCalled = true;
        return { ok: true, state: DISPATCH_STATES.READY_FOR_REVIEW };
      },
      status: async () => ({ ok: true })
    };

    const harnessB = createBrokerHarness({
      lifecycleStore: storeB,
      workerPort: workerPortB
    });

    const waitRes = await harnessB.broker.waitWorker({
      project_id: 'test-project',
      dispatch_id: 'D-027',
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.DISPATCH_UNCERTAIN);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    assert.strictEqual(waitCalled, false, 'workerPort.wait must NOT be called for DISPATCH_UNCERTAIN');
    storeB.close();
    console.log('✓ SL-027 PASSED: broker reopened sees uncertain dispatch and does not call worker');
  }

  // SL-028: write-ahead visible from second store before worker transport call (Section 35)
  {
    const dbPath = getTempDbPath('sl-028');
    const storeMain = createSqliteLifecycleStore({ dbPath });

    let observedStateDuringTransport = null;
    let observedWorkOrderDuringTransport = null;

    const workerPort = {
      dispatch: async (args) => {
        // Inspect database from a completely separate store instance while dispatch is ongoing
        const observerStore = createSqliteLifecycleStore({ dbPath });
        const active = observerStore.getActiveDispatch('test-project');
        if (active) {
          observedStateDuringTransport = active.state;
          observedWorkOrderDuringTransport = active.work_order_id;
        }
        observerStore.close();

        return {
          ok: true,
          state: DISPATCH_STATES.DISPATCH_ACCEPTED
        };
      },
      wait: async () => ({ ok: true }),
      status: async () => ({ ok: true })
    };

    const harness = createBrokerHarness({
      lifecycleStore: storeMain,
      workerPort
    });

    const dispRes = await harness.broker.dispatchWorker({
      schema_version: 1,
      project_id: 'test-project',
      work_order_id: 'WO-028',
      directive: 'write-ahead-directive',
      expected_workspace_state_id: 'ws-test-head'
    });

    assert.strictEqual(dispRes.ok, true);
    assert.strictEqual(observedStateDuringTransport, DISPATCH_STATES.DISPATCHING,
      'Intent must be durably committed as DISPATCHING before worker transport is invoked');
    assert.strictEqual(observedWorkOrderDuringTransport, 'WO-028');
    storeMain.close();
    console.log('✓ SL-028 PASSED: write-ahead visible from second store before worker transport call');
  }

  // SL-029: caller mutation of returned record cannot mutate DB (Section 21)
  {
    const dbPath = getTempDbPath('sl-029');
    const store = createSqliteLifecycleStore({ dbPath });
    const beginRes = store.beginDispatch('proj-1', {
      dispatch_id: 'D-029',
      project_id: 'proj-1',
      work_order_id: 'WO-029',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-029',
      directive: 'immutable directive',
      audit_metadata: { tag: 'initial' }
    });

    // Mutate returned beginDispatch record
    beginRes.dispatch.directive = 'HACKED';
    beginRes.dispatch.audit_metadata.tag = 'HACKED';
    beginRes.dispatch.state = 'HACKED';

    // Verify DB unaffected
    const fresh1 = store.getDispatch('D-029');
    assert.strictEqual(fresh1.directive, 'immutable directive');
    assert.strictEqual(fresh1.audit_metadata.tag, 'initial');
    assert.strictEqual(fresh1.state, DISPATCH_STATES.DISPATCHING);

    // Mutate getDispatch result
    fresh1.directive = 'HACKED2';
    fresh1.audit_metadata.tag = 'HACKED2';
    const fresh2 = store.getDispatch('D-029');
    assert.strictEqual(fresh2.directive, 'immutable directive');
    assert.strictEqual(fresh2.audit_metadata.tag, 'initial');

    // Mutate getActiveDispatch result
    const active = store.getActiveDispatch('proj-1');
    active.state = 'HACKED3';
    const active2 = store.getActiveDispatch('proj-1');
    assert.strictEqual(active2.state, DISPATCH_STATES.DISPATCHING);

    // Mutate getLatestDispatch result
    const latest = store.getLatestDispatch('proj-1');
    latest.directive = 'HACKED4';
    const latest2 = store.getLatestDispatch('proj-1');
    assert.strictEqual(latest2.directive, 'immutable directive');

    // Mutate history results
    const hist = store.getProjectHistory('proj-1');
    hist[0].next_state = 'HACKED5';
    hist[0].patch.tamper = true;
    const freshHist = store.getProjectHistory('proj-1');
    assert.strictEqual(freshHist[0].next_state, DISPATCH_STATES.DISPATCHING);
    assert.deepStrictEqual(freshHist[0].patch, {});

    store.close();
    console.log('✓ SL-029 PASSED: caller mutation of returned record cannot mutate DB');
  }

  // SL-030: memory store and SQLite store transition conformance
  {
    const states = Object.values(DISPATCH_STATES);

    for (const currentState of states) {
      for (const targetState of states) {
        // Memory store check
        const memStore = createMemoryLifecycleStore();
        // Force set state for testing transition logic
        memStore.beginDispatch('p', {
          dispatch_id: 'D-MEM',
          project_id: 'p',
          work_order_id: 'WO-MEM',
          expected_workspace_state_id: null,
          request_fingerprint: 'fp-mem',
          directive: 'dir',
          audit_metadata: null
        });
        if (currentState !== DISPATCH_STATES.DISPATCHING) {
          // Drive state machine forward or setup state
          if (currentState === DISPATCH_STATES.DISPATCH_ACCEPTED) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_ACCEPTED);
          } else if (currentState === DISPATCH_STATES.RUNNING) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_ACCEPTED);
            memStore.transition('D-MEM', DISPATCH_STATES.RUNNING);
          } else if (currentState === DISPATCH_STATES.READY_FOR_REVIEW) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_ACCEPTED);
            memStore.transition('D-MEM', DISPATCH_STATES.READY_FOR_REVIEW);
          } else if (currentState === DISPATCH_STATES.DISPATCH_FAILED) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_FAILED);
          } else if (currentState === DISPATCH_STATES.DISPATCH_UNCERTAIN) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_UNCERTAIN);
          } else if (currentState === DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
            memStore.transition('D-MEM', DISPATCH_STATES.DISPATCH_ACCEPTED);
            memStore.transition('D-MEM', DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
          }
        }
        const memRes = memStore.transition('D-MEM', targetState);

        // SQLite store check
        const dbPath = getTempDbPath(`sl-030-${currentState}-${targetState}`);
        const sqlStore = createSqliteLifecycleStore({ dbPath });
        sqlStore.beginDispatch('p', {
          dispatch_id: 'D-SQL',
          project_id: 'p',
          work_order_id: 'WO-SQL',
          expected_workspace_state_id: null,
          request_fingerprint: 'fp-sql',
          directive: 'dir',
          audit_metadata: null
        });
        if (currentState !== DISPATCH_STATES.DISPATCHING) {
          if (currentState === DISPATCH_STATES.DISPATCH_ACCEPTED) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_ACCEPTED);
          } else if (currentState === DISPATCH_STATES.RUNNING) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_ACCEPTED);
            sqlStore.transition('D-SQL', DISPATCH_STATES.RUNNING);
          } else if (currentState === DISPATCH_STATES.READY_FOR_REVIEW) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_ACCEPTED);
            sqlStore.transition('D-SQL', DISPATCH_STATES.READY_FOR_REVIEW);
          } else if (currentState === DISPATCH_STATES.DISPATCH_FAILED) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_FAILED);
          } else if (currentState === DISPATCH_STATES.DISPATCH_UNCERTAIN) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_UNCERTAIN);
          } else if (currentState === DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
            sqlStore.transition('D-SQL', DISPATCH_STATES.DISPATCH_ACCEPTED);
            sqlStore.transition('D-SQL', DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
          }
        }
        const sqlRes = sqlStore.transition('D-SQL', targetState);
        sqlStore.close();

        assert.strictEqual(
          sqlRes.ok,
          memRes.ok,
          `Transition ${currentState} -> ${targetState}: ok status mismatch (SQL: ${sqlRes.ok}, MEM: ${memRes.ok})`
        );
        if (!sqlRes.ok) {
          assert.strictEqual(
            sqlRes.code,
            memRes.code,
            `Transition ${currentState} -> ${targetState}: code mismatch (SQL: ${sqlRes.code}, MEM: ${memRes.code})`
          );
        }
      }
    }
    console.log('✓ SL-030 PASSED: memory store and SQLite store transition conformance');
  }

  console.log('\n======================================================================');
  console.log('ALL SQLITE LIFECYCLE STORE TESTS PASSED (SL-001 .. SL-030: 30/30 PASS)');
  console.log('======================================================================');
}

runAllTests()
  .catch((err) => {
    console.error('[TEST SUITE FAILURE]', err);
    process.exit(1);
  })
  .finally(() => {
    cleanupTempDir();
  });

'use strict';

/**
 * SQLite Lifecycle Store Test Suite (SL-001 .. SL-047)
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
  console.log('RUNNING SQLITE LIFECYCLE STORE TEST SUITE (SL-001 .. SL-047)');
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

  // SL-031: unknown active state on reopen (Section 28)
  {
    const dbPath = getTempDbPath('sl-031');
    const store1 = createSqliteLifecycleStore({ dbPath });
    store1.beginDispatch('proj-1', {
      dispatch_id: 'D-031',
      project_id: 'proj-1',
      work_order_id: 'WO-031',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-031',
      directive: 'test',
      audit_metadata: null
    });
    store1.close();

    // Directly corrupt dispatch state in SQLite
    const directDb = new DatabaseSync(dbPath);
    directDb.exec("UPDATE dispatches SET state = 'CORRUPTED_ACTIVE' WHERE dispatch_id = 'D-031'");
    directDb.close();

    // Reopen must FAIL CLOSED, never report IDLE
    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Corrupt database: dispatch 'D-031' has unrecognized state 'CORRUPTED_ACTIVE'/);

    console.log('✓ SL-031 PASSED: unknown active state on reopen fails closed');
  }

  // SL-032: unknown state after open (Section 29)
  {
    const dbPath = getTempDbPath('sl-032');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-032-1',
      project_id: 'proj-1',
      work_order_id: 'WO-032-1',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-032-1',
      directive: 'test 1',
      audit_metadata: null
    });

    // Directly corrupt state while store is already open
    const directDb = new DatabaseSync(dbPath);
    directDb.exec("UPDATE dispatches SET state = 'UNKNOWN_RUNNING' WHERE dispatch_id = 'D-032-1'");
    directDb.close();

    // getActiveDispatch must fail closed, never return null/IDLE
    assert.throws(() => {
      store.getActiveDispatch('proj-1');
    }, /Lifecycle store corruption: project 'proj-1' contains dispatch 'D-032-1' with invalid state 'UNKNOWN_RUNNING'/);

    // beginDispatch must fail closed, never insert second dispatch
    assert.throws(() => {
      store.beginDispatch('proj-1', {
        dispatch_id: 'D-032-2',
        project_id: 'proj-1',
        work_order_id: 'WO-032-2',
        expected_workspace_state_id: null,
        request_fingerprint: 'fp-032-2',
        directive: 'test 2',
        audit_metadata: null
      });
    }, /Lifecycle store corruption: project 'proj-1' contains dispatch 'D-032-1' with invalid state 'UNKNOWN_RUNNING'/);

    const checkDb = new DatabaseSync(dbPath);
    const count = checkDb.prepare("SELECT count(*) as cnt FROM dispatches WHERE project_id = 'proj-1'").get().cnt;
    assert.strictEqual(count, 1, 'Corrupt project must block new dispatches; row count must remain 1');
    checkDb.close();

    store.close();
    console.log('✓ SL-032 PASSED: unknown state after open fails closed and blocks new dispatch');
  }

  // SL-033: fake active index (Section 30)
  {
    // Sub-case A: Non-unique index
    {
      const dbPathA = getTempDbPath('sl-033-nonunique');
      const db = new DatabaseSync(dbPathA);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
          request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
          state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
          timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
        );
        CREATE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathA });
      }, /Index 'idx_active_project' must be UNIQUE/);
    }

    // Sub-case B: Non-partial index
    {
      const dbPathB = getTempDbPath('sl-033-nonpartial');
      const db = new DatabaseSync(dbPathB);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
          request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
          state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
          timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
        );
        CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id);
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathB });
      }, /Index 'idx_active_project' must be a partial index/);
    }

    // Sub-case C: Wrong predicate
    // Sub-case C: Wrong predicate clause (not state IN (...))
    {
      const dbPathC = getTempDbPath('sl-033-wrongclause');
      const db = new DatabaseSync(dbPathC);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
          request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
          state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
          timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
        );
        CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state = 'RUNNING';
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathC });
      }, /Index 'idx_active_project' must contain a partial WHERE clause on state IN/);
    }

    // Sub-case D: Wrong states in state IN (...) list
    {
      const dbPathD = getTempDbPath('sl-033-wrongstates');
      const db = new DatabaseSync(dbPathD);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
          request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
          state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
          timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
        );
        CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'RUNNING');
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathD });
      }, /Index 'idx_active_project' predicate must match exact ACTIVE_STATES/);
    }

    console.log('✓ SL-033 PASSED: fake active index rejected fail-closed');
  }

  // SL-034: wrong table shape (Section 31)
  {
    // Sub-case A: Missing column in dispatches
    {
      const dbPathA = getTempDbPath('sl-034-dispatch-col');
      const db = new DatabaseSync(dbPathA);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL,
          state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
          timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
        );
        CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathA });
      }, /Required dispatch column '.*' is missing/);
    }

    // Sub-case B: Missing column in history
    {
      const dbPathB = getTempDbPath('sl-034-history-col');
      const db = new DatabaseSync(dbPathB);
      db.exec(`
        CREATE TABLE dispatches (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
          request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
          state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE history (
          history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
          next_state TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
        PRAGMA user_version = 1;
      `);
      db.close();

      assert.throws(() => {
        createSqliteLifecycleStore({ dbPath: dbPathB });
      }, /Required history column '.*' is missing/);
    }

    console.log('✓ SL-034 PASSED: wrong table shape rejected fail-closed');
  }

  // SL-035: partial version-0 schema (Section 32)
  {
    const dbPath = getTempDbPath('sl-035');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA user_version = 0;
      CREATE TABLE leftover_partial_table (id INT, junk TEXT);
    `);
    db.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Corrupt or partial database: user_version is 0 but user schema objects exist/);

    const checkDb = new DatabaseSync(dbPath);
    const hasDispatches = checkDb.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE name = 'dispatches'").get().cnt;
    assert.strictEqual(hasDispatches, 0, 'Must NOT auto-initialize schema over partial user_version=0 database');
    checkDb.close();

    console.log('✓ SL-035 PASSED: partial version-0 schema fails closed without auto-initialization');
  }

  // SL-036: structured error parity (Section 33)
  {
    const complexError = {
      message: 'Structured error parity test',
      code: 12n,
      at: new Date('2026-09-19T05:00:00.000Z'),
      tags: new Set(['urgent', 'io']),
      meta: new Map([['retryCount', 3]])
    };

    // 1. Memory store
    const memStore = createMemoryLifecycleStore();
    memStore.beginDispatch('proj-1', {
      dispatch_id: 'D-036-M',
      project_id: 'proj-1',
      work_order_id: 'WO-036',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-036',
      directive: 'test',
      audit_metadata: null
    });
    const memTrans = memStore.transition('D-036-M', DISPATCH_STATES.DISPATCH_FAILED, {
      error: complexError
    });
    assert.strictEqual(memTrans.ok, true);

    // 2. SQLite store
    const dbPath = getTempDbPath('sl-036');
    const sqlStore1 = createSqliteLifecycleStore({ dbPath });
    sqlStore1.beginDispatch('proj-1', {
      dispatch_id: 'D-036-S',
      project_id: 'proj-1',
      work_order_id: 'WO-036',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-036',
      directive: 'test',
      audit_metadata: null
    });
    const sqlTrans = sqlStore1.transition('D-036-S', DISPATCH_STATES.DISPATCH_FAILED, {
      error: complexError
    });
    assert.strictEqual(sqlTrans.ok, true);

    // Parity check on returned dispatch error
    const mErr = memTrans.dispatch.error;
    const sErr = sqlTrans.dispatch.error;

    assert.strictEqual(sErr.message, mErr.message);
    assert.strictEqual(sErr.code, mErr.code);
    assert.strictEqual(sErr.code, 12n);
    assert.strictEqual(sErr.at.toISOString(), mErr.at.toISOString());
    assert.ok(sErr.tags instanceof Set);
    assert.ok(sErr.tags.has('urgent') && sErr.tags.has('io'));
    assert.ok(sErr.meta instanceof Map);
    assert.strictEqual(sErr.meta.get('retryCount'), 3);

    // Close SQLite store and reopen
    sqlStore1.close();
    const sqlStore2 = createSqliteLifecycleStore({ dbPath });
    const reloaded = sqlStore2.getDispatch('D-036-S');
    const rErr = reloaded.error;
    assert.strictEqual(rErr.message, complexError.message);
    assert.strictEqual(rErr.code, 12n);
    assert.strictEqual(rErr.at.toISOString(), complexError.at.toISOString());
    assert.ok(rErr.tags.has('urgent'));
    assert.strictEqual(rErr.meta.get('retryCount'), 3);

    // Detachment verification
    sErr.tags.add('mutated-tag');
    const freshCheck = sqlStore2.getDispatch('D-036-S');
    assert.strictEqual(freshCheck.error.tags.has('mutated-tag'), false);

    sqlStore2.close();
    console.log('✓ SL-036 PASSED: structured error parity between memory and SQLite stores verified');
  }

  // SL-037: corrupt history state (Section 34)
  {
    const dbPath = getTempDbPath('sl-037');
    const store = createSqliteLifecycleStore({ dbPath });
    store.beginDispatch('proj-1', {
      dispatch_id: 'D-037',
      project_id: 'proj-1',
      work_order_id: 'WO-037',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-037',
      directive: 'test',
      audit_metadata: null
    });
    store.close();

    // Corrupt history row
    const directDb = new DatabaseSync(dbPath);
    directDb.exec("UPDATE history SET next_state = 'BOGUS_HISTORY_STATE' WHERE history_seq = 1");
    directDb.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Corrupt database: history row '1' has unrecognized next_state 'BOGUS_HISTORY_STATE'/);

    console.log('✓ SL-037 PASSED: corrupt history state fails closed on reopen');
  }

  // SL-038: physical quick_check failure (Section 35)
  {
    const dbPath = getTempDbPath('sl-038');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA page_size = 4096; PRAGMA user_version = 1;');
    db.exec(`
      CREATE TABLE dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, dispatch_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, work_order_id TEXT NOT NULL, expected_workspace_state_id TEXT,
        request_fingerprint TEXT NOT NULL, directive TEXT NOT NULL, audit_metadata BLOB,
        state TEXT NOT NULL, error BLOB, diagnostics BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL,
        timestamp INTEGER NOT NULL, iso TEXT NOT NULL, patch BLOB
      );
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
    `);
    const insertStmt = db.prepare(`
      INSERT INTO dispatches (dispatch_id, project_id, work_order_id, request_fingerprint, directive, state, created_at, updated_at)
      VALUES (?, 'p', 'wo', 'fp', 'dir', 'READY_FOR_REVIEW', '2026-01-01', '2026-01-01')
    `);
    for (let i = 0; i < 500; i++) {
      insertStmt.run(`D-PAD-${i}`);
    }
    db.close();

    // Corrupt B-tree page at offset 4096
    const fileBytes = fs.readFileSync(dbPath);
    assert.ok(fileBytes.length >= 8192);
    fileBytes.fill(0x00, 4096, 4200);
    fs.writeFileSync(dbPath, fileBytes);

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Database physical integrity check failed/);

    console.log('✓ SL-038 PASSED: physical quick_check failure fails closed');
  }

  // SL-039: initialization failure closes handle (Section 36)
  {
    const dbPath = getTempDbPath('sl-039');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 99; CREATE TABLE dummy (id INT);');
    db.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Unsupported schema version: expected 1, found 99/);

    // On Windows, if the file handle were leaked open, fs.unlinkSync would throw EBUSY.
    // If handle is closed, unlink succeeds cleanly.
    assert.doesNotThrow(() => {
      fs.unlinkSync(dbPath);
    }, 'Database handle must be closed on init failure to prevent handle leak');

    console.log('✓ SL-039 PASSED: initialization failure closes handle without leak');
  }

  // SL-040: store contract patch conformance (Section 37)
  {
    const patches = [
      {},
      { error: 'plain string error' },
      { error: { code: 99n, when: new Date('2026-01-01T00:00:00.000Z') } },
      { diagnostics: { detail: 'stack trace', ids: new Set([10, 20]) } },
      { error: { tag: 'err' }, diagnostics: { tag: 'diag' } }
    ];

    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];

      // Memory store execution
      const memStore = createMemoryLifecycleStore();
      memStore.beginDispatch('p', {
        dispatch_id: `D-MEM-${i}`,
        project_id: 'p',
        work_order_id: `WO-${i}`,
        expected_workspace_state_id: null,
        request_fingerprint: `fp-${i}`,
        directive: 'dir',
        audit_metadata: null
      });
      const memRes = memStore.transition(`D-MEM-${i}`, DISPATCH_STATES.DISPATCH_FAILED, patch);

      // SQLite store execution
      const dbPath = getTempDbPath(`sl-040-${i}`);
      const sqlStore = createSqliteLifecycleStore({ dbPath });
      sqlStore.beginDispatch('p', {
        dispatch_id: `D-SQL-${i}`,
        project_id: 'p',
        work_order_id: `WO-${i}`,
        expected_workspace_state_id: null,
        request_fingerprint: `fp-${i}`,
        directive: 'dir',
        audit_metadata: null
      });
      const sqlRes = sqlStore.transition(`D-SQL-${i}`, DISPATCH_STATES.DISPATCH_FAILED, patch);

      assert.strictEqual(sqlRes.ok, memRes.ok, `Patch ${i}: ok parity`);
      assert.strictEqual(sqlRes.dispatch.state, memRes.dispatch.state, `Patch ${i}: state parity`);

      if (patch.error !== undefined) {
        if (typeof patch.error === 'string') {
          assert.strictEqual(sqlRes.dispatch.error, memRes.dispatch.error);
        } else if (typeof patch.error === 'object') {
          assert.deepStrictEqual(sqlRes.dispatch.error, memRes.dispatch.error);
        }
      } else {
        assert.strictEqual(sqlRes.dispatch.error, undefined);
        assert.strictEqual(memRes.dispatch.error, undefined);
      }

      if (patch.diagnostics !== undefined) {
        assert.deepStrictEqual(sqlRes.dispatch.diagnostics, memRes.dispatch.diagnostics);
      } else {
        assert.strictEqual(sqlRes.dispatch.diagnostics, undefined);
        assert.strictEqual(memRes.dispatch.diagnostics, undefined);
      }

      // History parity
      const memHist = memStore.getProjectHistory('p');
      const sqlHist = sqlStore.getProjectHistory('p');
      assert.strictEqual(sqlHist.length, memHist.length);
      assert.deepStrictEqual(sqlHist[1].patch, memHist[1].patch);

      // Reopen SQLite store and verify persistence matches memory store snapshot
      sqlStore.close();
      const sqlStoreReopened = createSqliteLifecycleStore({ dbPath });
      const reloaded = sqlStoreReopened.getDispatch(`D-SQL-${i}`);
      assert.strictEqual(reloaded.state, memRes.dispatch.state);
      if (patch.error !== undefined) {
        assert.deepStrictEqual(reloaded.error, memRes.dispatch.error);
      }
      if (patch.diagnostics !== undefined) {
        assert.deepStrictEqual(reloaded.diagnostics, memRes.dispatch.diagnostics);
      }
      sqlStoreReopened.close();
    }

    console.log('✓ SL-040 PASSED: store contract patch conformance (memory vs SQLite) verified');
  }

  // ------------------------------------------------------------------
  // SL-041: Extra active-index predicate rejected (LCAUTH-07)
  // ------------------------------------------------------------------
  {
    const dbPath = getTempDbPath('sl-041-extra-predicate');
    const db = new DatabaseSync(dbPath);
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
      CREATE UNIQUE INDEX idx_active_project
      ON dispatches(project_id)
      WHERE state IN (
        'DISPATCHING',
        'DISPATCH_ACCEPTED',
        'RUNNING',
        'DISPATCH_UNCERTAIN'
      )
      AND project_id <> 'bypass';
      PRAGMA user_version = 1;
    `);
    db.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /idx_active_project/i);

    console.log('✓ SL-041 PASSED: extra active-index predicate rejected');
  }

  // ------------------------------------------------------------------
  // SL-042: Sequence column not primary key (LCAUTH-06)
  // ------------------------------------------------------------------
  {
    // Subcase A: dispatches.seq is not PRIMARY KEY
    const dbPathA = getTempDbPath('sl-042-dispatches-seq-not-pk');
    const dbA = new DatabaseSync(dbPathA);
    dbA.exec(`
      CREATE TABLE dispatches (
        seq INTEGER,
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbA.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathA });
    }, /Dispatch column 'seq' has invalid primary-key position/);

    // Subcase B: history.history_seq is not PRIMARY KEY
    const dbPathB = getTempDbPath('sl-042-history-seq-not-pk');
    const dbB = new DatabaseSync(dbPathB);
    dbB.exec(`
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
      CREATE TABLE history (
        history_seq INTEGER,
        project_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        iso TEXT NOT NULL,
        patch BLOB
      );
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbB.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathB });
    }, /History column 'history_seq' has invalid primary-key position/);

    console.log('✓ SL-042 PASSED: sequence column not primary key rejected');
  }

  // ------------------------------------------------------------------
  // SL-043: Dispatch ID not unique (LCAUTH-06)
  // ------------------------------------------------------------------
  {
    const dbPath = getTempDbPath('sl-043-dispatch-id-not-unique');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL,
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    db.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath });
    }, /Required unique constraint or unique index on 'dispatches.dispatch_id' is missing/);

    console.log('✓ SL-043 PASSED: dispatch_id without unique constraint rejected');
  }

  // ------------------------------------------------------------------
  // SL-044: Required NOT-NULL contract (LCAUTH-06)
  // ------------------------------------------------------------------
  {
    // Subcase A: dispatches.project_id is nullable
    const dbPathA = getTempDbPath('sl-044-project-id-nullable');
    const dbA = new DatabaseSync(dbPathA);
    dbA.exec(`
      CREATE TABLE dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        project_id TEXT,
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbA.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathA });
    }, /Required dispatch column 'project_id' must be NOT NULL/);

    // Subcase B: dispatches.state is nullable
    const dbPathB = getTempDbPath('sl-044-state-nullable');
    const dbB = new DatabaseSync(dbPathB);
    dbB.exec(`
      CREATE TABLE dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        expected_workspace_state_id TEXT,
        request_fingerprint TEXT NOT NULL,
        directive TEXT NOT NULL,
        audit_metadata BLOB,
        state TEXT,
        error BLOB,
        diagnostics BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbB.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathB });
    }, /Required dispatch column 'state' must be NOT NULL/);

    // Subcase C: history.next_state is nullable
    const dbPathC = getTempDbPath('sl-044-next-state-nullable');
    const dbC = new DatabaseSync(dbPathC);
    dbC.exec(`
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
      CREATE TABLE history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT,
        timestamp INTEGER NOT NULL,
        iso TEXT NOT NULL,
        patch BLOB
      );
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbC.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathC });
    }, /Required history column 'next_state' must be NOT NULL/);

    console.log('✓ SL-044 PASSED: required NOT-NULL contract verified');
  }

  // ------------------------------------------------------------------
  // SL-045: Incompatible type shape (LCAUTH-06)
  // ------------------------------------------------------------------
  {
    // Subcase A: seq TEXT
    const dbPathA = getTempDbPath('sl-045-seq-text');
    const dbA = new DatabaseSync(dbPathA);
    dbA.exec(`
      CREATE TABLE dispatches (
        seq TEXT PRIMARY KEY,
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbA.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathA });
    }, /Dispatch column 'seq' has invalid declared type 'TEXT'/);

    // Subcase B: history_seq TEXT
    const dbPathB = getTempDbPath('sl-045-history-seq-text');
    const dbB = new DatabaseSync(dbPathB);
    dbB.exec(`
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
      CREATE TABLE history (
        history_seq TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        previous_state TEXT,
        next_state TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        iso TEXT NOT NULL,
        patch BLOB
      );
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbB.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathB });
    }, /History column 'history_seq' has invalid declared type 'TEXT'/);

    // Subcase C: state BLOB
    const dbPathC = getTempDbPath('sl-045-state-blob');
    const dbC = new DatabaseSync(dbPathC);
    dbC.exec(`
      CREATE TABLE dispatches (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        work_order_id TEXT NOT NULL,
        expected_workspace_state_id TEXT,
        request_fingerprint TEXT NOT NULL,
        directive TEXT NOT NULL,
        audit_metadata BLOB,
        state BLOB NOT NULL,
        error BLOB,
        diagnostics BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
      CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
      PRAGMA user_version = 1;
    `);
    dbC.close();

    assert.throws(() => {
      createSqliteLifecycleStore({ dbPath: dbPathC });
    }, /Dispatch column 'state' has invalid declared type 'BLOB'/);

    console.log('✓ SL-045 PASSED: incompatible column type shapes rejected');
  }

  // ------------------------------------------------------------------
  // SL-046: Null / undefined patch parity (LCAUTH-08)
  // ------------------------------------------------------------------
  {
    const testPatches = [
      { name: 'error: null', patch: { error: null } },
      { name: 'error: undefined', patch: { error: undefined } },
      { name: 'diagnostics: null', patch: { diagnostics: null } },
      { name: 'diagnostics: undefined', patch: { diagnostics: undefined } },
      { name: 'error: null, diagnostics: undefined', patch: { error: null, diagnostics: undefined } }
    ];

    for (let i = 0; i < testPatches.length; i++) {
      const { name, patch } = testPatches[i];
      const memStore = createMemoryLifecycleStore();
      const dbPath = getTempDbPath(`sl-046-patch-${i}`);
      const sqlStore = createSqliteLifecycleStore({ dbPath });

      const record = {
        dispatch_id: `D-PARITY-${i}`,
        project_id: `proj-p46-${i}`,
        work_order_id: `WO-P46-${i}`,
        expected_workspace_state_id: null,
        request_fingerprint: `fp-p46-${i}`,
        directive: 'parity-test',
        audit_metadata: null
      };

      const memBegin = memStore.beginDispatch(record.project_id, record);
      const sqlBegin = sqlStore.beginDispatch(record.project_id, record);
      assert.strictEqual(memBegin.ok, true);
      assert.strictEqual(sqlBegin.ok, true);

      // Verify clean initial state has neither error nor diagnostics
      assert.strictEqual(Object.hasOwn(memBegin.dispatch, 'error'), false);
      assert.strictEqual(Object.hasOwn(sqlBegin.dispatch, 'error'), false);
      assert.strictEqual(Object.hasOwn(memBegin.dispatch, 'diagnostics'), false);
      assert.strictEqual(Object.hasOwn(sqlBegin.dispatch, 'diagnostics'), false);

      // Legal transition to terminal failure state
      const memRes = memStore.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_FAILED, patch);
      const sqlRes = sqlStore.transition(record.dispatch_id, DISPATCH_STATES.DISPATCH_FAILED, patch);

      assert.strictEqual(sqlRes.ok, true);
      assert.strictEqual(memRes.ok, true);
      assert.strictEqual(sqlRes.dispatch.state, memRes.dispatch.state);

      // Compare error hasOwn & value
      assert.strictEqual(
        Object.hasOwn(sqlRes.dispatch, 'error'),
        Object.hasOwn(memRes.dispatch, 'error'),
        `error hasOwn parity for ${name}`
      );
      if (Object.hasOwn(memRes.dispatch, 'error')) {
        assert.strictEqual(sqlRes.dispatch.error, memRes.dispatch.error);
      }

      // Compare diagnostics hasOwn & value
      assert.strictEqual(
        Object.hasOwn(sqlRes.dispatch, 'diagnostics'),
        Object.hasOwn(memRes.dispatch, 'diagnostics'),
        `diagnostics hasOwn parity for ${name}`
      );
      if (Object.hasOwn(memRes.dispatch, 'diagnostics')) {
        assert.strictEqual(sqlRes.dispatch.diagnostics, memRes.dispatch.diagnostics);
      }

      // History patch parity
      const memHist = memStore.getProjectHistory(record.project_id);
      const sqlHist = sqlStore.getProjectHistory(record.project_id);
      assert.strictEqual(sqlHist.length, 2);
      assert.strictEqual(memHist.length, 2);
      const memPatch = memHist[1].patch;
      const sqlPatch = sqlHist[1].patch;
      assert.strictEqual(Object.hasOwn(sqlPatch, 'error'), Object.hasOwn(memPatch, 'error'));
      assert.strictEqual(sqlPatch.error, memPatch.error);
      assert.strictEqual(Object.hasOwn(sqlPatch, 'diagnostics'), Object.hasOwn(memPatch, 'diagnostics'));
      assert.strictEqual(sqlPatch.diagnostics, memPatch.diagnostics);

      // Close and reopen SQLite store; verify persistence parity
      sqlStore.close();
      const reopenedStore = createSqliteLifecycleStore({ dbPath });
      const reloaded = reopenedStore.getDispatch(record.dispatch_id);

      assert.strictEqual(
        Object.hasOwn(reloaded, 'error'),
        Object.hasOwn(memRes.dispatch, 'error'),
        `reloaded error hasOwn parity for ${name}`
      );
      if (Object.hasOwn(memRes.dispatch, 'error')) {
        assert.strictEqual(reloaded.error, memRes.dispatch.error);
      }

      assert.strictEqual(
        Object.hasOwn(reloaded, 'diagnostics'),
        Object.hasOwn(memRes.dispatch, 'diagnostics'),
        `reloaded diagnostics hasOwn parity for ${name}`
      );
      if (Object.hasOwn(memRes.dispatch, 'diagnostics')) {
        assert.strictEqual(reloaded.diagnostics, memRes.dispatch.diagnostics);
      }

      // Detachment verification: mutate returned object, ensure store remains unpolluted
      sqlRes.dispatch.error = 'mutated-error';
      sqlRes.dispatch.diagnostics = 'mutated-diagnostics';
      const freshLookup = reopenedStore.getDispatch(record.dispatch_id);
      assert.notStrictEqual(freshLookup.error, 'mutated-error');
      assert.notStrictEqual(freshLookup.diagnostics, 'mutated-diagnostics');

      reopenedStore.close();
    }

    console.log('✓ SL-046 PASSED: null / undefined patch parity verified across stores');
  }

  // ------------------------------------------------------------------
  // SL-047: Initial optional field parity (LCAUTH-08)
  // ------------------------------------------------------------------
  {
    const initialRecords = [
      { desc: 'no error field, no diagnostics field', rec: {} },
      { desc: 'error: undefined, no diagnostics', rec: { error: undefined } },
      { desc: 'error: null, no diagnostics', rec: { error: null } },
      { desc: 'no error field, diagnostics: undefined', rec: { diagnostics: undefined } },
      { desc: 'no error field, diagnostics: null', rec: { diagnostics: null } },
      { desc: 'error: undefined, diagnostics: null', rec: { error: undefined, diagnostics: null } },
      { desc: 'error: null, diagnostics: undefined', rec: { error: null, diagnostics: undefined } }
    ];

    for (let i = 0; i < initialRecords.length; i++) {
      const { desc, rec } = initialRecords[i];
      const memStore = createMemoryLifecycleStore();
      const dbPath = getTempDbPath(`sl-047-init-${i}`);
      const sqlStore = createSqliteLifecycleStore({ dbPath });

      const fullRecord = {
        dispatch_id: `D-INIT-${i}`,
        project_id: `proj-init-${i}`,
        work_order_id: `WO-INIT-${i}`,
        expected_workspace_state_id: null,
        request_fingerprint: `fp-init-${i}`,
        directive: 'init-parity-test',
        audit_metadata: null,
        ...rec
      };

      const memRes = memStore.beginDispatch(fullRecord.project_id, fullRecord);
      const sqlRes = sqlStore.beginDispatch(fullRecord.project_id, fullRecord);

      assert.strictEqual(memRes.ok, true, `mem beginDispatch ok for ${desc}`);
      assert.strictEqual(sqlRes.ok, true, `sql beginDispatch ok for ${desc}`);

      // Compare returned shape: error property
      assert.strictEqual(
        Object.hasOwn(sqlRes.dispatch, 'error'),
        Object.hasOwn(memRes.dispatch, 'error'),
        `error hasOwn match for ${desc}`
      );
      if (Object.hasOwn(memRes.dispatch, 'error')) {
        assert.strictEqual(sqlRes.dispatch.error, memRes.dispatch.error, `error value match for ${desc}`);
      }

      // Compare returned shape: diagnostics property
      assert.strictEqual(
        Object.hasOwn(sqlRes.dispatch, 'diagnostics'),
        Object.hasOwn(memRes.dispatch, 'diagnostics'),
        `diagnostics hasOwn match for ${desc}`
      );
      if (Object.hasOwn(memRes.dispatch, 'diagnostics')) {
        assert.strictEqual(sqlRes.dispatch.diagnostics, memRes.dispatch.diagnostics, `diagnostics value match for ${desc}`);
      }

      // Close and reopen SQLite store; check reloaded observable shape
      sqlStore.close();
      const reopenedStore = createSqliteLifecycleStore({ dbPath });
      const reloaded = reopenedStore.getDispatch(fullRecord.dispatch_id);

      assert.strictEqual(
        Object.hasOwn(reloaded, 'error'),
        Object.hasOwn(memRes.dispatch, 'error'),
        `reloaded error hasOwn match for ${desc}`
      );
      if (Object.hasOwn(memRes.dispatch, 'error')) {
        assert.strictEqual(reloaded.error, memRes.dispatch.error, `reloaded error value match for ${desc}`);
      }

      assert.strictEqual(
        Object.hasOwn(reloaded, 'diagnostics'),
        Object.hasOwn(memRes.dispatch, 'diagnostics'),
        `reloaded diagnostics hasOwn match for ${desc}`
      );
      if (Object.hasOwn(memRes.dispatch, 'diagnostics')) {
        assert.strictEqual(reloaded.diagnostics, memRes.dispatch.diagnostics, `reloaded diagnostics value match for ${desc}`);
      }

      reopenedStore.close();
    }

    console.log('✓ SL-047 PASSED: initial optional field parity verified across stores');
  }

  console.log('\n======================================================================');
  console.log('ALL SQLITE LIFECYCLE STORE TESTS PASSED (SL-001 .. SL-047: 47/47 PASS)');
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

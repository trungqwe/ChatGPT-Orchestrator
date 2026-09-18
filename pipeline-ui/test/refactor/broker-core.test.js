'use strict';

/**
 * Broker Core Unit & Characterization Test Suite (BC-001 .. BC-020)
 *
 * Validates the standalone deterministic broker core against all required
 * negative, positive, concurrency, and provenance conditions.
 * Uses 100% fake ports, deterministic clock, deterministic ID factory, and volatile store.
 */

const assert = require('node:assert');
const { createBroker } = require('../../lib/broker/broker');
const { createMemoryLifecycleStore } = require('../../lib/broker/lifecycle-store');
const { DISPATCH_STATES, ERROR_CODES } = require('../../lib/broker/contracts');

// Helper to create fresh test harness with deterministic dependencies
function createTestHarness(custom = {}) {
  let idCounter = 100;
  const idFactory = custom.idFactory || {
    nextDispatchId: () => `D-TEST-${++idCounter}`
  };

  let simulatedTime = 1700000000000;
  const clock = custom.clock || {
    now: () => simulatedTime,
    iso: () => new Date(simulatedTime).toISOString(),
    advance: (ms) => { simulatedTime += ms; }
  };

  const projects = custom.projects || {
    'ai-multi-task': { id: 'ai-multi-task', root: 'D:\\TU_CODE\\AI_Multi_Task', workerSession: 'sess_001' },
    'project-b': { id: 'project-b', root: 'D:\\TU_CODE\\ProjectB', workerSession: 'sess_002' }
  };

  const registryPort = custom.registryPort || {
    getProject: async (projectId) => projects[projectId] || null
  };

  const workspaceStates = custom.workspaceStates || {
    'ai-multi-task': { workspace_state_id: 'sha256:current-head-hash' },
    'project-b': { workspace_state_id: 'sha256:project-b-hash' }
  };

  const workspacePort = custom.workspacePort || {
    getWorkspaceState: async (project) => workspaceStates[project.id] || null
  };

  const workerCalls = {
    dispatch: [],
    wait: [],
    status: []
  };

  const workerPort = custom.workerPort || {
    dispatch: async (args) => {
      workerCalls.dispatch.push(args);
      return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
    },
    wait: async (args) => {
      workerCalls.wait.push(args);
      return {
        ok: true,
        state: DISPATCH_STATES.RUNNING,
        dispatch_id: args.dispatch_id,
        work_order_id: args.work_order_id
      };
    },
    status: async (args) => {
      workerCalls.status.push(args);
      return { ok: true, state: 'IDLE' };
    }
  };

  const lifecycleStore = custom.lifecycleStore || createMemoryLifecycleStore({ clock });

  const broker = createBroker({
    registryPort,
    workspacePort,
    workerPort,
    lifecycleStore,
    idFactory,
    clock
  });

  return {
    broker,
    lifecycleStore,
    workerCalls,
    clock,
    idFactory
  };
}

function baseValidRequest(overrides = {}) {
  return {
    schema_version: 1,
    project_id: 'ai-multi-task',
    work_order_id: 'WO-018',
    expected_workspace_state_id: 'sha256:current-head-hash',
    directive: 'Implement deterministic broker core according to architecture specification.',
    audit_metadata: {
      auditor: 'codex-full-harness',
      decision_id: 'A-001'
    },
    ...overrides
  };
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING BROKER CORE TEST SUITE (BC-001 .. BC-020)');
  console.log('======================================================================');

  // -----------------------------------------------------------------------
  // BC-001: Invalid request
  // -----------------------------------------------------------------------
  console.log('\n[BC-001] Testing invalid request rejection...');
  {
    const { broker, workerCalls } = createTestHarness();

    const resNull = await broker.dispatchWorker(null);
    assert.strictEqual(resNull.ok, false);
    assert.strictEqual(resNull.code, ERROR_CODES.INVALID_REQUEST);

    const resNoSchema = await broker.dispatchWorker({ ...baseValidRequest(), schema_version: 99 });
    assert.strictEqual(resNoSchema.ok, false);
    assert.strictEqual(resNoSchema.code, ERROR_CODES.INVALID_REQUEST);

    const resNoProject = await broker.dispatchWorker({ ...baseValidRequest(), project_id: '' });
    assert.strictEqual(resNoProject.ok, false);
    assert.strictEqual(resNoProject.code, ERROR_CODES.INVALID_REQUEST);

    const resNoWO = await broker.dispatchWorker({ ...baseValidRequest(), work_order_id: '   ' });
    assert.strictEqual(resNoWO.ok, false);
    assert.strictEqual(resNoWO.code, ERROR_CODES.INVALID_REQUEST);

    const resNoWS = await broker.dispatchWorker({ ...baseValidRequest(), expected_workspace_state_id: '' });
    assert.strictEqual(resNoWS.ok, false);
    assert.strictEqual(resNoWS.code, ERROR_CODES.INVALID_REQUEST);

    const resNoDirective = await broker.dispatchWorker({ ...baseValidRequest(), directive: '' });
    assert.strictEqual(resNoDirective.ok, false);
    assert.strictEqual(resNoDirective.code, ERROR_CODES.INVALID_REQUEST);

    assert.strictEqual(workerCalls.dispatch.length, 0, 'Worker must not be called on invalid request');
    console.log('✓ BC-001 PASSED: Invalid requests rejected with zero worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-002: Top-level command field rejected
  // -----------------------------------------------------------------------
  console.log('\n[BC-002] Testing top-level command field rejection...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req = baseValidRequest({ command: 'rm -rf /' });

    const res = await broker.dispatchWorker(req);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.INVALID_REQUEST);
    assert.strictEqual(workerCalls.dispatch.length, 0);
    console.log('✓ BC-002 PASSED: Arbitrary command field rejected with zero worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-003: Unknown project
  // -----------------------------------------------------------------------
  console.log('\n[BC-003] Testing unknown project rejection...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req = baseValidRequest({ project_id: 'non-existent-project' });

    const res = await broker.dispatchWorker(req);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.PROJECT_NOT_FOUND);
    assert.strictEqual(workerCalls.dispatch.length, 0);
    console.log('✓ BC-003 PASSED: Unknown project rejected with zero worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-004: Workspace mismatch (Stale audit state)
  // -----------------------------------------------------------------------
  console.log('\n[BC-004] Testing workspace mismatch rejection...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req = baseValidRequest({ expected_workspace_state_id: 'sha256:stale-old-hash' });

    const res = await broker.dispatchWorker(req);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.STALE_AUDIT_STATE);
    assert.strictEqual(res.expected_workspace_state_id, 'sha256:stale-old-hash');
    assert.strictEqual(res.observed_workspace_state_id, 'sha256:current-head-hash');
    assert.strictEqual(workerCalls.dispatch.length, 0);
    console.log('✓ BC-004 PASSED: Stale audit state rejected with zero worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-005: Valid dispatch transitions to DISPATCH_ACCEPTED
  // -----------------------------------------------------------------------
  console.log('\n[BC-005] Testing valid dispatch execution...');
  {
    const { broker, workerCalls, lifecycleStore } = createTestHarness();
    const req = baseValidRequest();

    const res = await broker.dispatchWorker(req);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(res.dispatch_id, 'D-TEST-101');
    assert.strictEqual(res.work_order_id, 'WO-018');
    assert.strictEqual(workerCalls.dispatch.length, 1);

    const stored = lifecycleStore.getDispatch('D-TEST-101');
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    console.log('✓ BC-005 PASSED: Valid dispatch accepted with exactly 1 worker call.');
  }

  // -----------------------------------------------------------------------
  // BC-006: Exact idempotent retry returns existing dispatch
  // -----------------------------------------------------------------------
  console.log('\n[BC-006] Testing exact idempotent retry...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req = baseValidRequest();

    const res1 = await broker.dispatchWorker(req);
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.dispatch_id, 'D-TEST-101');
    assert.strictEqual(workerCalls.dispatch.length, 1);

    const res2 = await broker.dispatchWorker(req);
    assert.strictEqual(res2.ok, true);
    assert.strictEqual(res2.idempotent_replay, true);
    assert.strictEqual(res2.dispatch_id, 'D-TEST-101');
    assert.strictEqual(res2.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(workerCalls.dispatch.length, 1, 'Worker must NOT be called a second time on retry');
    console.log('✓ BC-006 PASSED: Exact retry replayed existing dispatch without second worker send.');
  }

  // -----------------------------------------------------------------------
  // BC-007: Same WorkOrder, changed directive -> DUPLICATE_WORK_ORDER_CONFLICT
  // -----------------------------------------------------------------------
  console.log('\n[BC-007] Testing duplicate WorkOrder conflict on modified directive...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req1 = baseValidRequest({ directive: 'Directive version 1' });
    const req2 = baseValidRequest({ directive: 'Directive version 2 (changed)' });

    const res1 = await broker.dispatchWorker(req1);
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(workerCalls.dispatch.length, 1);

    const res2 = await broker.dispatchWorker(req2);
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT);
    assert.strictEqual(workerCalls.dispatch.length, 1, 'Worker call count must remain 1');
    console.log('✓ BC-007 PASSED: Conflicting WorkOrder modification rejected.');
  }

  // -----------------------------------------------------------------------
  // BC-008: Different WorkOrder while first is active -> WORKER_BUSY
  // -----------------------------------------------------------------------
  console.log('\n[BC-008] Testing worker busy on different active WorkOrder...');
  {
    const { broker, workerCalls } = createTestHarness();
    const req1 = baseValidRequest({ work_order_id: 'WO-018' });
    const req2 = baseValidRequest({ work_order_id: 'WO-019' });

    const res1 = await broker.dispatchWorker(req1);
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(workerCalls.dispatch.length, 1);

    const res2 = await broker.dispatchWorker(req2);
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, ERROR_CODES.WORKER_BUSY);
    assert.strictEqual(workerCalls.dispatch.length, 1);
    console.log('✓ BC-008 PASSED: Parallel active WorkOrder rejected as WORKER_BUSY.');
  }

  // -----------------------------------------------------------------------
  // BC-009: Definitive worker dispatch failure
  // -----------------------------------------------------------------------
  console.log('\n[BC-009] Testing definitive worker dispatch failure...');
  {
    const customWorkerPort = {
      dispatch: async () => ({
        ok: false,
        code: ERROR_CODES.DISPATCH_FAILED,
        definitive: true,
        error: 'Target worker process crashed on launch'
      }),
      wait: async () => ({ ok: false }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const res = await broker.dispatchWorker(baseValidRequest());

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.DISPATCH_FAILED);

    const stored = lifecycleStore.getDispatch(res.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_FAILED);
    assert.strictEqual(lifecycleStore.getActiveDispatch('ai-multi-task'), null, 'Failed dispatch must not block next WO');
    console.log('✓ BC-009 PASSED: Definitive failure stored as DISPATCH_FAILED.');
  }

  // -----------------------------------------------------------------------
  // BC-010: Worker dispatch throws / ambiguous transport exception
  // -----------------------------------------------------------------------
  console.log('\n[BC-010] Testing ambiguous transport exception...');
  {
    const customWorkerPort = {
      dispatch: async () => {
        throw new Error('IPC pipe broken unexpectedly during dispatch');
      },
      wait: async () => ({ ok: false }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const res = await broker.dispatchWorker(baseValidRequest());

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.DISPATCH_UNCERTAIN);

    const stored = lifecycleStore.getDispatch(res.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    // DISPATCH_UNCERTAIN must remain active/blocking for safety
    assert.notStrictEqual(lifecycleStore.getActiveDispatch('ai-multi-task'), null);
    console.log('✓ BC-010 PASSED: Transport exception stored as DISPATCH_UNCERTAIN.');
  }

  // -----------------------------------------------------------------------
  // BC-011: Two concurrent dispatchWorker calls
  // -----------------------------------------------------------------------
  console.log('\n[BC-011] Testing concurrent dispatch race condition...');
  {
    let resolveWorker;
    const workerPromise = new Promise((resolve) => { resolveWorker = resolve; });
    let workerCallCount = 0;

    const customWorkerPort = {
      dispatch: async () => {
        workerCallCount++;
        await workerPromise;
        return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
      },
      wait: async () => ({ ok: true }),
      status: async () => ({ ok: true })
    };

    const { broker } = createTestHarness({ workerPort: customWorkerPort });

    const reqA = baseValidRequest({ work_order_id: 'WO-020' });
    const reqB = baseValidRequest({ work_order_id: 'WO-021' });

    const pA = broker.dispatchWorker(reqA);
    const pB = broker.dispatchWorker(reqB);

    // Give microtasks opportunity to overlap
    await new Promise((r) => setImmediate(r));
    resolveWorker();

    const [resA, resB] = await Promise.all([pA, pB]);

    // One must succeed, other must be WORKER_BUSY
    const successCount = (resA.ok ? 1 : 0) + (resB.ok ? 1 : 0);
    const busyCount = (resA.code === ERROR_CODES.WORKER_BUSY ? 1 : 0) + (resB.code === ERROR_CODES.WORKER_BUSY ? 1 : 0);

    assert.strictEqual(successCount, 1, 'Exactly one concurrent call must succeed');
    assert.strictEqual(busyCount, 1, 'Other concurrent call must receive WORKER_BUSY');
    assert.strictEqual(workerCallCount, 1, 'Worker must only be dispatched once');
    console.log('✓ BC-011 PASSED: Concurrency race atomically resolved.');
  }

  // -----------------------------------------------------------------------
  // BC-012: workerPort.wait returns RUNNING
  // -----------------------------------------------------------------------
  console.log('\n[BC-012] Testing workerPort.wait returns RUNNING...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => ({
        ok: true,
        state: DISPATCH_STATES.RUNNING,
        dispatch_id: args.dispatch_id,
        work_order_id: args.work_order_id
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, true);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.RUNNING);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.RUNNING);
    console.log('✓ BC-012 PASSED: Nonterminal RUNNING state updated cleanly.');
  }

  // -----------------------------------------------------------------------
  // BC-013: workerPort.wait returns READY_FOR_REVIEW
  // -----------------------------------------------------------------------
  console.log('\n[BC-013] Testing workerPort.wait returns READY_FOR_REVIEW...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => ({
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: args.dispatch_id,
        work_order_id: args.work_order_id
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, true);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.READY_FOR_REVIEW);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.READY_FOR_REVIEW);
    assert.strictEqual(lifecycleStore.getActiveDispatch('ai-multi-task'), null, 'READY_FOR_REVIEW is terminal for worker active check');
    console.log('✓ BC-013 PASSED: READY_FOR_REVIEW transition recorded.');
  }

  // -----------------------------------------------------------------------
  // BC-014: Worker wait returns wrong dispatch_id
  // -----------------------------------------------------------------------
  console.log('\n[BC-014] Testing wrong dispatch_id returned by worker wait...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async () => ({
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: 'D-WRONG-FAKE-999',
        work_order_id: 'WO-018'
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.PROVENANCE_AMBIGUOUS);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
    console.log('✓ BC-014 PASSED: Mismatched dispatch_id flagged as PROVENANCE_AMBIGUOUS.');
  }

  // -----------------------------------------------------------------------
  // BC-015: Worker wait returns wrong work_order_id
  // -----------------------------------------------------------------------
  console.log('\n[BC-015] Testing wrong work_order_id returned by worker wait...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => ({
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: args.dispatch_id,
        work_order_id: 'WO-WRONG-OTHER'
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.PROVENANCE_AMBIGUOUS);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.PROVENANCE_AMBIGUOUS);
    console.log('✓ BC-015 PASSED: Mismatched work_order_id flagged as PROVENANCE_AMBIGUOUS.');
  }

  // -----------------------------------------------------------------------
  // BC-016: Timeout clamping
  // -----------------------------------------------------------------------
  console.log('\n[BC-016] Testing timeout clamping to max 30 seconds...');
  {
    let capturedTimeout;
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => {
        capturedTimeout = args.timeout_secs;
        return {
          ok: true,
          state: DISPATCH_STATES.RUNNING,
          dispatch_id: args.dispatch_id,
          work_order_id: args.work_order_id
        };
      },
      status: async () => ({ ok: true })
    };

    const { broker } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 99999
    });

    assert.strictEqual(capturedTimeout, 30, 'Timeout must be clamped to max bound 30s');
    console.log('✓ BC-016 PASSED: Excessive timeout clamped to 30 seconds.');
  }

  // -----------------------------------------------------------------------
  // BC-017: Illegal lifecycle transition rejected
  // -----------------------------------------------------------------------
  console.log('\n[BC-017] Testing illegal lifecycle transition rejection...');
  {
    const { lifecycleStore } = createTestHarness();
    const record = {
      dispatch_id: 'D-TEST-101',
      project_id: 'ai-multi-task',
      work_order_id: 'WO-018',
      request_fingerprint: 'fp',
      directive: 'test'
    };

    lifecycleStore.beginDispatch('ai-multi-task', record);
    lifecycleStore.transition('D-TEST-101', DISPATCH_STATES.DISPATCH_ACCEPTED);
    lifecycleStore.transition('D-TEST-101', DISPATCH_STATES.READY_FOR_REVIEW);

    // Attempt illegal transition: READY_FOR_REVIEW -> RUNNING
    const res = lifecycleStore.transition('D-TEST-101', DISPATCH_STATES.RUNNING);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.ILLEGAL_STATE_TRANSITION);

    const stored = lifecycleStore.getDispatch('D-TEST-101');
    assert.strictEqual(stored.state, DISPATCH_STATES.READY_FOR_REVIEW, 'State must remain READY_FOR_REVIEW');
    console.log('✓ BC-017 PASSED: Illegal resurrection rejected deterministically.');
  }

  // -----------------------------------------------------------------------
  // BC-018: Project isolation (Project A active does not block Project B)
  // -----------------------------------------------------------------------
  console.log('\n[BC-018] Testing project isolation...');
  {
    const { broker } = createTestHarness();

    const resA = await broker.dispatchWorker(baseValidRequest({ project_id: 'ai-multi-task' }));
    assert.strictEqual(resA.ok, true);

    const resB = await broker.dispatchWorker(baseValidRequest({
      project_id: 'project-b',
      work_order_id: 'WO-B-001',
      expected_workspace_state_id: 'sha256:project-b-hash'
    }));

    assert.strictEqual(resB.ok, true, 'Project B must dispatch independently from Project A');
    assert.strictEqual(resB.project_id, 'project-b');
    console.log('✓ BC-018 PASSED: Project isolation verified with zero cross-talk.');
  }

  // -----------------------------------------------------------------------
  // BC-019: Directive size exceeds configured limit (> 2 MiB)
  // -----------------------------------------------------------------------
  console.log('\n[BC-019] Testing oversized directive rejection...');
  {
    const { broker, workerCalls } = createTestHarness();
    const oversizedDirective = 'A'.repeat(2 * 1024 * 1024 + 1); // 2 MiB + 1 byte
    const req = baseValidRequest({ directive: oversizedDirective });

    const res = await broker.dispatchWorker(req);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, ERROR_CODES.PAYLOAD_TOO_LARGE);
    assert.strictEqual(workerCalls.dispatch.length, 0);
    console.log('✓ BC-019 PASSED: Oversized directive rejected with PAYLOAD_TOO_LARGE.');
  }

  // -----------------------------------------------------------------------
  // BC-020: Lifecycle event history validation
  // -----------------------------------------------------------------------
  console.log('\n[BC-020] Testing deterministic lifecycle event history...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => ({
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: args.dispatch_id,
        work_order_id: args.work_order_id
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());
    await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    const history = lifecycleStore.getProjectHistory('ai-multi-task');
    assert.strictEqual(history.length, 3);

    assert.strictEqual(history[0].previous_state, null);
    assert.strictEqual(history[0].next_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(history[0].dispatch_id, dispRes.dispatch_id);

    assert.strictEqual(history[1].previous_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(history[1].next_state, DISPATCH_STATES.DISPATCH_ACCEPTED);

    assert.strictEqual(history[2].previous_state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(history[2].next_state, DISPATCH_STATES.READY_FOR_REVIEW);

    console.log('✓ BC-020 PASSED: Ordered deterministic lifecycle transitions verified.');
  }

  console.log('\n======================================================================');
  console.log('ALL BROKER CORE TESTS PASSED (BC-001 .. BC-020: 20/20 PASS)');
  console.log('======================================================================');
}

runAllTests().catch((err) => {
  console.error('[TEST SUITE FAILURE]', err);
  process.exit(1);
});

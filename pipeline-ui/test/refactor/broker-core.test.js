'use strict';

/**
 * Broker Core Unit & Characterization Test Suite (BC-001 .. BC-034)
 *
 * Validates the standalone deterministic broker core against all required
 * negative, positive, concurrency, and provenance conditions.
 * Uses 100% fake ports, deterministic clock, deterministic ID factory, and volatile store.
 */

const assert = require('node:assert');
const { createBroker } = require('../../lib/broker/broker');
const { createMemoryLifecycleStore } = require('../../lib/broker/lifecycle-store');
const { DISPATCH_STATES, ERROR_CODES, computeRequestFingerprint } = require('../../lib/broker/contracts');

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
  console.log('RUNNING BROKER CORE TEST SUITE (BC-001 .. BC-034)');
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

  // -----------------------------------------------------------------------
  // BC-021: Transition patch cannot overwrite state (Section 37 / BCORE-01)
  // -----------------------------------------------------------------------
  console.log('\n[BC-021] Testing transition patch cannot overwrite state...');
  {
    const { lifecycleStore } = createTestHarness();
    const record = {
      dispatch_id: 'D-PATCH-01',
      project_id: 'ai-multi-task',
      work_order_id: 'WO-PATCH-01',
      expected_workspace_state_id: 'sha256:current-head-hash',
      request_fingerprint: 'fp-1',
      directive: 'test directive',
      state: DISPATCH_STATES.DISPATCHING,
      created_at: new Date().toISOString()
    };
    const beginRes = lifecycleStore.beginDispatch('ai-multi-task', record);
    assert.strictEqual(beginRes.ok, true);

    const transRes = lifecycleStore.transition('D-PATCH-01', DISPATCH_STATES.DISPATCH_ACCEPTED, {
      state: DISPATCH_STATES.READY_FOR_REVIEW
    });
    assert.strictEqual(transRes.ok, false);
    assert.strictEqual(transRes.code, ERROR_CODES.IMMUTABLE_FIELD_VIOLATION);
    assert.strictEqual(transRes.field, 'state');

    const stored = lifecycleStore.getDispatch('D-PATCH-01');
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCHING);
    console.log('✓ BC-021 PASSED: State overwrite via patch failed closed, state remains DISPATCHING.');
  }

  // -----------------------------------------------------------------------
  // BC-022: Reserved identity fields immutable in transition patch (Section 38, 52 / BCORE-01)
  // -----------------------------------------------------------------------
  console.log('\n[BC-022] Testing reserved fields immutable in transition patch & canonical fingerprint...');
  {
    const { lifecycleStore } = createTestHarness();
    const record = {
      dispatch_id: 'D-PATCH-02',
      project_id: 'ai-multi-task',
      work_order_id: 'WO-PATCH-02',
      expected_workspace_state_id: 'sha256:current-head-hash',
      request_fingerprint: 'fp-2',
      directive: 'test directive',
      state: DISPATCH_STATES.DISPATCHING,
      created_at: new Date().toISOString()
    };
    lifecycleStore.beginDispatch('ai-multi-task', record);

    const forbiddenFields = [
      'dispatch_id',
      'project_id',
      'work_order_id',
      'request_fingerprint',
      'created_at',
      'updated_at'
    ];

    for (const field of forbiddenFields) {
      const storedBefore = lifecycleStore.getDispatch('D-PATCH-02');
      const beforeValue = storedBefore[field];
      const patch = { [field]: 'illegal_value' };
      const transRes = lifecycleStore.transition('D-PATCH-02', DISPATCH_STATES.DISPATCH_ACCEPTED, patch);
      assert.strictEqual(transRes.ok, false, `Field '${field}' must fail closed`);
      assert.strictEqual(transRes.code, ERROR_CODES.IMMUTABLE_FIELD_VIOLATION);
      assert.strictEqual(transRes.field, field);

      const stored = lifecycleStore.getDispatch('D-PATCH-02');
      assert.strictEqual(stored[field], beforeValue, `Field '${field}' must remain unmodified`);
      assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCHING);
    }

    // Deterministic canonical fingerprint check (Section 52)
    const fp1 = computeRequestFingerprint({
      projectId: 'a',
      workOrderId: 'b',
      expectedWorkspaceStateId: 'c',
      directive: 'd\0e'
    });
    const fp2 = computeRequestFingerprint({
      projectId: 'a\0b',
      workOrderId: '',
      expectedWorkspaceStateId: 'c',
      directive: 'd\0e'
    });
    assert.notStrictEqual(fp1, fp2, 'Canonical JSON array encoding must prevent delimiter injection collision');

    console.log('✓ BC-022 PASSED: All reserved record fields rejected with IMMUTABLE_FIELD_VIOLATION.');
  }

  // -----------------------------------------------------------------------
  // BC-023: beginDispatch fails closed on project identity mismatch (Section 39 / BCORE-06)
  // -----------------------------------------------------------------------
  console.log('\n[BC-023] Testing beginDispatch project identity mismatch...');
  {
    const { lifecycleStore } = createTestHarness();
    const record = {
      dispatch_id: 'D-MISMATCH-01',
      project_id: 'project-b',
      work_order_id: 'WO-MISMATCH-01',
      expected_workspace_state_id: 'sha256:current-head-hash',
      request_fingerprint: 'fp-mismatch',
      directive: 'test directive',
      state: DISPATCH_STATES.DISPATCHING,
      created_at: new Date().toISOString()
    };

    const beginRes = lifecycleStore.beginDispatch('ai-multi-task', record);
    assert.strictEqual(beginRes.ok, false);
    assert.strictEqual(beginRes.code, ERROR_CODES.PROJECT_IDENTITY_MISMATCH);

    // Verify no record inserted
    assert.strictEqual(lifecycleStore.getDispatch('D-MISMATCH-01'), null);

    // Verify no active pointer for either project
    assert.strictEqual(lifecycleStore.getActiveDispatch('ai-multi-task'), null);
    assert.strictEqual(lifecycleStore.getActiveDispatch('project-b'), null);

    // Verify no history event
    assert.strictEqual(lifecycleStore.getProjectHistory('ai-multi-task').length, 0);
    assert.strictEqual(lifecycleStore.getProjectHistory('project-b').length, 0);

    console.log('✓ BC-023 PASSED: Project identity mismatch rejected with zero store side-effects.');
  }

  // -----------------------------------------------------------------------
  // BC-024: Duplicate dispatch_id collision fails closed (Section 40 / BCORE-06)
  // -----------------------------------------------------------------------
  console.log('\n[BC-024] Testing dispatch_id collision protection...');
  {
    const duplicateIdFactory = {
      nextDispatchId: () => 'D-COLLISION-STATIC-ID'
    };
    const { broker, lifecycleStore, workerCalls } = createTestHarness({ idFactory: duplicateIdFactory });

    // First dispatch succeeds
    const res1 = await broker.dispatchWorker(baseValidRequest({ work_order_id: 'WO-FIRST' }));
    assert.strictEqual(res1.ok, true);
    assert.strictEqual(res1.dispatch_id, 'D-COLLISION-STATIC-ID');
    assert.strictEqual(workerCalls.dispatch.length, 1);

    // Fast-finish the first dispatch so project is IDLE
    lifecycleStore.transition('D-COLLISION-STATIC-ID', DISPATCH_STATES.READY_FOR_REVIEW);

    // Second dispatch attempts with different work order but idFactory generates the collision
    const res2 = await broker.dispatchWorker(baseValidRequest({ work_order_id: 'WO-SECOND' }));
    assert.strictEqual(res2.ok, false);
    assert.strictEqual(res2.code, ERROR_CODES.DISPATCH_ID_COLLISION);
    assert.strictEqual(workerCalls.dispatch.length, 1, 'Worker must not be called on dispatch_id collision');

    const originalRecord = lifecycleStore.getDispatch('D-COLLISION-STATIC-ID');
    assert.strictEqual(originalRecord.work_order_id, 'WO-FIRST');
    assert.strictEqual(originalRecord.state, DISPATCH_STATES.READY_FOR_REVIEW);

    console.log('✓ BC-024 PASSED: Dispatch ID collision detected and rejected with zero worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-025: DISPATCH_UNCERTAIN resurrection blocked (Section 41 / BCORE-03)
  // -----------------------------------------------------------------------
  console.log('\n[BC-025] Testing DISPATCH_UNCERTAIN cannot be waited or resurrected...');
  {
    const customWorkerPort = {
      dispatch: async () => { throw new Error('Network timeout during dispatch'); },
      wait: async () => ({
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: 'D-ANY',
        work_order_id: 'WO-018'
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore, workerCalls } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());
    assert.strictEqual(dispRes.ok, false);
    assert.strictEqual(dispRes.code, ERROR_CODES.DISPATCH_UNCERTAIN);

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.DISPATCH_UNCERTAIN);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    assert.strictEqual(workerCalls.wait.length, 0, 'workerPort.wait must NOT be called for DISPATCH_UNCERTAIN');

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    console.log('✓ BC-025 PASSED: DISPATCH_UNCERTAIN cannot be resurrected by wait; 0 worker calls.');
  }

  // -----------------------------------------------------------------------
  // BC-026: Concurrent waitWorker on DISPATCHING returns nonterminal (Section 42 / BCORE-03)
  // -----------------------------------------------------------------------
  console.log('\n[BC-026] Testing concurrent wait on DISPATCHING state...');
  {
    let resolveWorkerDispatch;
    const workerDispatchPromise = new Promise((resolve) => {
      resolveWorkerDispatch = resolve;
    });

    const customWorkerPort = {
      dispatch: async () => {
        await workerDispatchPromise;
        return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
      },
      wait: async (args) => ({
        ok: true,
        state: DISPATCH_STATES.RUNNING,
        dispatch_id: args.dispatch_id,
        work_order_id: args.work_order_id
      }),
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore, workerCalls } = createTestHarness({ workerPort: customWorkerPort });

    // Start dispatch without awaiting immediately
    const dispatchPromise = broker.dispatchWorker(baseValidRequest());

    // Allow event loop to advance to workerPort.dispatch call
    await new Promise((r) => setImmediate(r));

    const active = lifecycleStore.getActiveDispatch('ai-multi-task');
    assert.ok(active);
    assert.strictEqual(active.state, DISPATCH_STATES.DISPATCHING);

    // Call waitWorker while dispatch is still in progress
    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: active.dispatch_id,
      timeout_secs: 5
    });

    assert.strictEqual(waitRes.ok, true);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(workerCalls.wait.length, 0, 'workerPort.wait must NOT be called while DISPATCHING');

    // Now resolve worker dispatch
    resolveWorkerDispatch();
    const dispRes = await dispatchPromise;
    assert.strictEqual(dispRes.ok, true);
    assert.strictEqual(dispRes.state, DISPATCH_STATES.DISPATCH_ACCEPTED);

    console.log('✓ BC-026 PASSED: Concurrent wait during DISPATCHING returns nonterminal DISPATCHING without wait calls.');
  }

  // -----------------------------------------------------------------------
  // BC-027: Malformed / unrecognized wait state fails closed (Section 43 / BCORE-04)
  // -----------------------------------------------------------------------
  console.log('\n[BC-027] Testing unrecognized worker wait state fails closed...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => ({
        ok: true,
        state: 'DONE',
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

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.INVALID_WORKER_RESPONSE);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_ACCEPTED, 'State must remain DISPATCH_ACCEPTED');
    console.log('✓ BC-027 PASSED: Arbitrary "DONE" worker state rejected with INVALID_WORKER_RESPONSE.');
  }

  // -----------------------------------------------------------------------
  // BC-028: Wait returning undefined fails closed (Section 44 / BCORE-04)
  // -----------------------------------------------------------------------
  console.log('\n[BC-028] Testing wait returning undefined fails closed...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async () => undefined,
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
    assert.ok(
      waitRes.code === ERROR_CODES.WORKER_WAIT_UNAVAILABLE || waitRes.code === ERROR_CODES.INVALID_WORKER_RESPONSE,
      `Expected WORKER_WAIT_UNAVAILABLE or INVALID_WORKER_RESPONSE, got ${waitRes.code}`
    );

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    console.log('✓ BC-028 PASSED: Undefined worker wait response handled with structured failure.');
  }

  // -----------------------------------------------------------------------
  // BC-029: Wait transport exception is nonterminal WORKER_WAIT_UNAVAILABLE (Section 45 / BCORE-05)
  // -----------------------------------------------------------------------
  console.log('\n[BC-029] Testing wait transport exception preserves lifecycle state...');
  {
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async () => {
        throw new Error('Transient polling network reset');
      },
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    // Advance to RUNNING first via lifecycleStore to test RUNNING preservation
    lifecycleStore.transition(dispRes.dispatch_id, DISPATCH_STATES.RUNNING);

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.WORKER_WAIT_UNAVAILABLE);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.RUNNING);

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.RUNNING, 'State must remain RUNNING, not DISPATCH_UNCERTAIN');
    console.log('✓ BC-029 PASSED: Wait transport exception returned WORKER_WAIT_UNAVAILABLE without mutating RUNNING state.');
  }

  // -----------------------------------------------------------------------
  // BC-030: Transition failure after READY_FOR_REVIEW reports LIFECYCLE_STORE_FAILURE (Section 46 / BCORE-02)
  // -----------------------------------------------------------------------
  console.log('\n[BC-030] Testing lifecycle transition failure on READY_FOR_REVIEW...');
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

    const baseStore = createMemoryLifecycleStore();
    const failingStore = {
      ...baseStore,
      transition: (dispatchId, nextState, patch) => {
        if (nextState === DISPATCH_STATES.READY_FOR_REVIEW) {
          return {
            ok: false,
            code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
            error: 'Simulated persistence failure on READY_FOR_REVIEW transition'
          };
        }
        return baseStore.transition(dispatchId, nextState, patch);
      }
    };

    const { broker } = createTestHarness({
      workerPort: customWorkerPort,
      lifecycleStore: failingStore
    });

    const dispRes = await broker.dispatchWorker(baseValidRequest());
    assert.strictEqual(dispRes.ok, true);

    const waitRes = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.LIFECYCLE_STORE_FAILURE);
    assert.strictEqual(waitRes.dispatch_id, dispRes.dispatch_id);
    console.log('✓ BC-030 PASSED: Transition failure during READY_FOR_REVIEW returned LIFECYCLE_STORE_FAILURE.');
  }

  // -----------------------------------------------------------------------
  // BC-031: Transition failure after dispatch DISPATCH_ACCEPTED reports failure (Section 47 / BCORE-02)
  // -----------------------------------------------------------------------
  console.log('\n[BC-031] Testing lifecycle transition failure on DISPATCH_ACCEPTED...');
  {
    const baseStore = createMemoryLifecycleStore();
    const failingStore = {
      ...baseStore,
      transition: (dispatchId, nextState, patch) => {
        if (nextState === DISPATCH_STATES.DISPATCH_ACCEPTED) {
          return {
            ok: false,
            code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
            error: 'Simulated persistence failure on DISPATCH_ACCEPTED transition'
          };
        }
        return baseStore.transition(dispatchId, nextState, patch);
      }
    };

    const { broker } = createTestHarness({ lifecycleStore: failingStore });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    assert.strictEqual(dispRes.ok, false);
    assert.strictEqual(dispRes.code, ERROR_CODES.LIFECYCLE_STORE_FAILURE);
    console.log('✓ BC-031 PASSED: Transition failure during DISPATCH_ACCEPTED returned LIFECYCLE_STORE_FAILURE.');
  }

  // -----------------------------------------------------------------------
  // BC-032: Registry port throws during dispatch (Section 48 / Port Safety)
  // -----------------------------------------------------------------------
  console.log('\n[BC-032] Testing registry port exception during dispatch...');
  {
    const throwingRegistryPort = {
      getProject: async () => {
        throw new Error('Database connection lost to registry');
      }
    };

    const { broker, workerCalls } = createTestHarness({ registryPort: throwingRegistryPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    assert.strictEqual(dispRes.ok, false);
    assert.strictEqual(dispRes.code, ERROR_CODES.REGISTRY_UNAVAILABLE);
    assert.strictEqual(workerCalls.dispatch.length, 0, 'Worker must not be called when registry throws');
    console.log('✓ BC-032 PASSED: Registry port exception caught and mapped to REGISTRY_UNAVAILABLE.');
  }

  // -----------------------------------------------------------------------
  // BC-033: Workspace port throws during dispatch (Section 49 / Port Safety)
  // -----------------------------------------------------------------------
  console.log('\n[BC-033] Testing workspace port exception during dispatch...');
  {
    const throwingWorkspacePort = {
      getWorkspaceState: async () => {
        throw new Error('Git repository locked or inaccessible');
      }
    };

    const { broker, workerCalls } = createTestHarness({ workspacePort: throwingWorkspacePort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    assert.strictEqual(dispRes.ok, false);
    assert.strictEqual(dispRes.code, ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE);
    assert.strictEqual(workerCalls.dispatch.length, 0, 'Worker must not be called when workspace throws');
    console.log('✓ BC-033 PASSED: Workspace port exception caught and mapped to WORKSPACE_STATE_UNAVAILABLE.');
  }

  // -----------------------------------------------------------------------
  // BC-034: Wait returns DISPATCH_ACCEPTED when already RUNNING preserves RUNNING (Section 50 / BCORE-04)
  // -----------------------------------------------------------------------
  console.log('\n[BC-034] Testing wait response DISPATCH_ACCEPTED preserves RUNNING state...');
  {
    let waitCallCount = 0;
    const customWorkerPort = {
      dispatch: async () => ({ ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED }),
      wait: async (args) => {
        waitCallCount++;
        if (waitCallCount === 1) {
          return {
            ok: true,
            state: DISPATCH_STATES.RUNNING,
            dispatch_id: args.dispatch_id,
            work_order_id: args.work_order_id
          };
        }
        return {
          ok: true,
          state: DISPATCH_STATES.DISPATCH_ACCEPTED,
          dispatch_id: args.dispatch_id,
          work_order_id: args.work_order_id
        };
      },
      status: async () => ({ ok: true })
    };

    const { broker, lifecycleStore } = createTestHarness({ workerPort: customWorkerPort });
    const dispRes = await broker.dispatchWorker(baseValidRequest());

    // First wait transitions to RUNNING
    const wait1 = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });
    assert.strictEqual(wait1.ok, true);
    assert.strictEqual(wait1.state, DISPATCH_STATES.RUNNING);

    // Second wait receives stale DISPATCH_ACCEPTED
    const wait2 = await broker.waitWorker({
      project_id: 'ai-multi-task',
      dispatch_id: dispRes.dispatch_id,
      timeout_secs: 10
    });
    assert.strictEqual(wait2.ok, true);
    assert.strictEqual(wait2.state, DISPATCH_STATES.RUNNING, 'State must remain RUNNING, never regress');

    const stored = lifecycleStore.getDispatch(dispRes.dispatch_id);
    assert.strictEqual(stored.state, DISPATCH_STATES.RUNNING);
    console.log('✓ BC-034 PASSED: Monotonic lifecycle preserved: RUNNING was not regressed to DISPATCH_ACCEPTED.');
  }

  console.log('\n======================================================================');
  console.log('ALL BROKER CORE TESTS PASSED (BC-001 .. BC-034: 34/34 PASS)');
  console.log('======================================================================');
}

runAllTests().catch((err) => {
  console.error('[TEST SUITE FAILURE]', err);
  process.exit(1);
});

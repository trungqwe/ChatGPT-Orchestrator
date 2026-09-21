'use strict';

/**
 * Worker Adapter Registry Test Suite (WREG-001 .. WREG-028)
 *
 * Validates the generic WorkerPortV1 registry facade:
 * - Exact engine selection and fail-closed resolution
 * - Construction validation and closure-private snapshot immutability
 * - Broker integration and exception-boundary conformance
 * - Runtime composition and dependency injection precedence
 */

const assert = require('node:assert');
const { createWorkerAdapterRegistry } = require('../../lib/broker/worker-adapter-registry');
const { createBrokerRuntime } = require('../../lib/broker/runtime');
const { createBroker } = require('../../lib/broker/broker');
const { createMemoryLifecycleStore } = require('../../lib/broker/lifecycle-store');
const { DISPATCH_STATES, ERROR_CODES } = require('../../lib/broker/contracts');

function createMockAdapter(overrides = {}) {
  const calls = {
    dispatch: [],
    wait: []
  };

  const adapter = {
    calls,
    dispatch: overrides.dispatch || (async (args) => {
      calls.dispatch.push(args);
      return overrides.dispatchResult || { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
    }),
    wait: overrides.wait || (async (args) => {
      calls.wait.push(args);
      return overrides.waitResult || { ok: true, state: DISPATCH_STATES.RUNNING };
    })
  };

  return adapter;
}

function createValidProject(engine = 'antigravity', enabled = true, projectId = 'proj-1') {
  return {
    project_id: projectId,
    worker: {
      engine,
      enabled
    }
  };
}

function createValidDispatchArgs(project, overrides = {}) {
  const projectId = (project && project.project_id) || 'proj-1';
  return {
    project,
    project_id: projectId,
    work_order_id: 'wo-1',
    dispatch_id: 'disp-1',
    expected_workspace_state_id: 'state-1',
    directive: 'implement something',
    ...overrides
  };
}

function createValidWaitArgs(project, overrides = {}) {
  const projectId = (project && project.project_id) || 'proj-1';
  return {
    project,
    project_id: projectId,
    work_order_id: 'wo-1',
    dispatch_id: 'disp-1',
    expected_workspace_state_id: 'state-1',
    timeout_secs: 5,
    ...overrides
  };
}

async function runTests() {
  console.log('======================================================================');
  console.log('RUNNING WORKER ADAPTER REGISTRY TEST SUITE (WREG-001 .. WREG-028)');
  console.log('======================================================================\n');

  // WREG-001: dispatch selects exact registered engine through delegation
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(adapter.calls.dispatch.length, 1);
    console.log('✓ WREG-001 PASSED: dispatch selects exact registered engine through delegation');
  }

  // WREG-002: wait selects exact registered engine through delegation
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidWaitArgs(project);
    const res = await registry.wait(args);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(adapter.calls.wait.length, 1);
    console.log('✓ WREG-002 PASSED: wait selects exact registered engine through delegation');
  }

  // WREG-003: dispatch passes same args object unchanged
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    await registry.dispatch(args);

    assert.strictEqual(adapter.calls.dispatch[0], args);
    console.log('✓ WREG-003 PASSED: dispatch passes same args object unchanged');
  }

  // WREG-004: wait passes same args object unchanged
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidWaitArgs(project);
    await registry.wait(args);

    assert.strictEqual(adapter.calls.wait[0], args);
    console.log('✓ WREG-004 PASSED: wait passes same args object unchanged');
  }

  // WREG-005: unknown dispatch engine: definitive failure, zero adapter call, zero fallback
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('unknown-engine');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.definitive, true);
    assert.strictEqual(res.error, 'Worker adapter unavailable');
    assert.strictEqual(adapter.calls.dispatch.length, 0);
    console.log('✓ WREG-005 PASSED: unknown dispatch engine yields definitive failure with zero adapter calls');
  }

  // WREG-006: case mismatch: zero fallback
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    for (const badEngine of ['Antigravity', 'ANTIGRAVITY', 'AntiGravity']) {
      const project = createValidProject(badEngine);
      const args = createValidDispatchArgs(project);
      const res = await registry.dispatch(args);

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.definitive, true);
      assert.strictEqual(res.error, 'Worker adapter unavailable');
      assert.strictEqual(adapter.calls.dispatch.length, 0);
    }
    console.log('✓ WREG-006 PASSED: case mismatch has zero fallback');
  }

  // WREG-007: runtime engine whitespace mismatch: zero fallback
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    for (const badEngine of ['antigravity ', ' antigravity', ' antigravity ']) {
      const project = createValidProject(badEngine);
      const args = createValidDispatchArgs(project);
      const res = await registry.dispatch(args);

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.definitive, true);
      assert.strictEqual(res.error, 'Worker adapter unavailable');
      assert.strictEqual(adapter.calls.dispatch.length, 0);
    }
    console.log('✓ WREG-007 PASSED: runtime engine whitespace mismatch has zero fallback');
  }

  // WREG-008: missing project.worker: fail closed before adapter call
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = { project_id: 'proj-1' }; // missing worker
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.definitive, true);
    assert.strictEqual(res.error, 'Worker adapter unavailable');
    assert.strictEqual(adapter.calls.dispatch.length, 0);
    console.log('✓ WREG-008 PASSED: missing project.worker fails closed before adapter call');
  }

  // WREG-009: worker.enabled !== true: fail closed before adapter call
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    for (const enabledVal of [false, null, undefined, 0, 'true']) {
      const project = { project_id: 'proj-1', worker: { engine: 'antigravity', enabled: enabledVal } };
      const args = createValidDispatchArgs(project);
      const res = await registry.dispatch(args);

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.definitive, true);
      assert.strictEqual(res.error, 'Worker adapter unavailable');
      assert.strictEqual(adapter.calls.dispatch.length, 0);
    }
    console.log('✓ WREG-009 PASSED: worker.enabled !== true fails closed before adapter call');
  }

  // WREG-010: project.project_id !== args.project_id: fail closed before adapter call
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity', true, 'proj-actual');
    const args = createValidDispatchArgs(project, { project_id: 'proj-mismatch' });
    const res = await registry.dispatch(args);

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.definitive, true);
    assert.strictEqual(res.error, 'Worker adapter unavailable');
    assert.strictEqual(adapter.calls.dispatch.length, 0);
    console.log('✓ WREG-010 PASSED: project.project_id !== args.project_id fails closed before adapter call');
  }

  // WREG-011: duplicate engine: construction rejects
  {
    const a1 = createMockAdapter();
    const a2 = createMockAdapter();

    assert.throws(() => {
      createWorkerAdapterRegistry({
        adapters: [
          { engine: 'antigravity', adapter: a1 },
          { engine: 'antigravity', adapter: a2 }
        ]
      });
    }, /Duplicate worker adapter engine registration/);
    console.log('✓ WREG-011 PASSED: duplicate engine registration rejected at construction');
  }

  // WREG-012: missing dispatch: construction rejects
  {
    assert.throws(() => {
      createWorkerAdapterRegistry({
        adapters: [
          { engine: 'antigravity', adapter: { wait: async () => {} } }
        ]
      });
    }, /must provide a dispatch function/);
    console.log('✓ WREG-012 PASSED: registration missing dispatch rejected at construction');
  }

  // WREG-013: missing wait: construction rejects
  {
    assert.throws(() => {
      createWorkerAdapterRegistry({
        adapters: [
          { engine: 'antigravity', adapter: { dispatch: async () => {} } }
        ]
      });
    }, /must provide a wait function/);
    console.log('✓ WREG-013 PASSED: registration missing wait rejected at construction');
  }

  // WREG-014: registration token surrounding whitespace: construction rejects
  {
    const adapter = createMockAdapter();

    for (const badToken of [' antigravity', 'antigravity ', ' antigravity ', '   ']) {
      assert.throws(() => {
        createWorkerAdapterRegistry({
          adapters: [{ engine: badToken, adapter }]
        });
      }, /whitespace/);
    }
    console.log('✓ WREG-014 PASSED: registration token surrounding whitespace rejected at construction');
  }

  // WREG-015: mutating original registration array: mapping unchanged
  {
    const a1 = createMockAdapter();
    const a2 = createMockAdapter();
    const registrationList = [{ engine: 'antigravity', adapter: a1 }];

    const registry = createWorkerAdapterRegistry({ adapters: registrationList });

    // Mutate the original array
    registrationList.push({ engine: 'codex', adapter: a2 });
    registrationList.length = 0;

    // Original registration should still work
    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(a1.calls.dispatch.length, 1);

    // Newly added element should NOT resolve
    const projectCodex = createValidProject('codex');
    const argsCodex = createValidDispatchArgs(projectCodex);
    const resCodex = await registry.dispatch(argsCodex);
    assert.strictEqual(resCodex.ok, false);
    assert.strictEqual(a2.calls.dispatch.length, 0);
    console.log('✓ WREG-015 PASSED: mutating original registration array leaves mapping unchanged');
  }

  // WREG-016: mutating entry.engine: mapping unchanged
  {
    const adapter = createMockAdapter();
    const entry = { engine: 'antigravity', adapter };
    const registry = createWorkerAdapterRegistry({ adapters: [entry] });

    // Mutate the entry engine property
    entry.engine = 'changed-engine';

    // Lookup with original engine still succeeds
    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(adapter.calls.dispatch.length, 1);

    // Lookup with mutated engine fails
    const projectChanged = createValidProject('changed-engine');
    const argsChanged = createValidDispatchArgs(projectChanged);
    const resChanged = await registry.dispatch(argsChanged);
    assert.strictEqual(resChanged.ok, false);
    console.log('✓ WREG-016 PASSED: mutating entry.engine leaves mapping unchanged');
  }

  // WREG-017: replacing entry.adapter: mapping unchanged
  {
    const originalAdapter = createMockAdapter();
    const replacementAdapter = createMockAdapter();
    const entry = { engine: 'antigravity', adapter: originalAdapter };
    const registry = createWorkerAdapterRegistry({ adapters: [entry] });

    // Mutate the entry adapter property
    entry.adapter = replacementAdapter;

    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);

    assert.strictEqual(res.ok, true);
    assert.strictEqual(originalAdapter.calls.dispatch.length, 1);
    assert.strictEqual(replacementAdapter.calls.dispatch.length, 0);
    console.log('✓ WREG-017 PASSED: replacing entry.adapter leaves mapping unchanged');
  }

  // WREG-018: facade exposes no public resolution/mutation API
  {
    const adapter = createMockAdapter();
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const keys = Object.keys(registry).sort();
    assert.deepStrictEqual(keys, ['dispatch', 'wait']);
    assert.strictEqual(typeof registry.dispatch, 'function');
    assert.strictEqual(typeof registry.wait, 'function');
    assert.strictEqual(registry.resolve, undefined);
    assert.strictEqual(registry.lookup, undefined);
    assert.strictEqual(registry.get, undefined);
    assert.strictEqual(registry.map, undefined);
    assert.strictEqual(registry.adapters, undefined);
    assert.strictEqual(registry.register, undefined);
    assert.strictEqual(registry.unregister, undefined);
    console.log('✓ WREG-018 PASSED: facade exposes no public resolution or mutation API');
  }

  // WREG-019: dispatch result passes through unchanged
  {
    const expectedResult = {
      ok: true,
      definitive: false,
      state: DISPATCH_STATES.DISPATCH_ACCEPTED,
      custom_token: 'alpha-123'
    };
    const adapter = createMockAdapter({ dispatchResult: expectedResult });
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidDispatchArgs(project);
    const res = await registry.dispatch(args);

    assert.strictEqual(res, expectedResult);
    console.log('✓ WREG-019 PASSED: dispatch result passes through unchanged');
  }

  // WREG-020: wait result passes through unchanged
  {
    const expectedResult = {
      ok: true,
      state: DISPATCH_STATES.READY_FOR_REVIEW,
      dispatch_id: 'disp-test',
      work_order_id: 'wo-test',
      custom_meta: { proof: true }
    };
    const adapter = createMockAdapter({ waitResult: expectedResult });
    const registry = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const project = createValidProject('antigravity');
    const args = createValidWaitArgs(project);
    const res = await registry.wait(args);

    assert.strictEqual(res, expectedResult);
    console.log('✓ WREG-020 PASSED: wait result passes through unchanged');
  }

  // WREG-021: wait resolution failure: throws before adapter, broker -> WORKER_WAIT_UNAVAILABLE, lifecycle unchanged
  {
    let adapterWaitCalls = 0;
    const adapter = {
      dispatch: async () => ({ ok: true }),
      wait: async () => {
        adapterWaitCalls++;
        return { ok: true, state: DISPATCH_STATES.RUNNING };
      }
    };

    const workerPort = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const memoryStore = createMemoryLifecycleStore();

    // Record initial dispatch in DISPATCHING, then transition to DISPATCH_ACCEPTED
    memoryStore.beginDispatch('proj-021', {
      dispatch_id: 'D-WREG-021',
      work_order_id: 'WO-021',
      project_id: 'proj-021',
      expected_workspace_state_id: 'state-021',
      request_fingerprint: 'fp-021',
      state: DISPATCH_STATES.DISPATCHING
    });
    memoryStore.transition('D-WREG-021', DISPATCH_STATES.DISPATCH_ACCEPTED);

    const stateBefore = memoryStore.getActiveDispatch('proj-021').state;
    assert.strictEqual(stateBefore, DISPATCH_STATES.DISPATCH_ACCEPTED);

    // Registry returns project with unmatched worker engine
    const registryPort = {
      getProject: async () => ({
        project_id: 'proj-021',
        worker: {
          engine: 'unregistered-engine',
          enabled: true
        }
      })
    };

    const workspacePort = {
      getWorkspaceState: async () => ({ workspace_state_id: 'state-021' })
    };

    const broker = createBroker({
      registryPort,
      workspacePort,
      workerPort,
      lifecycleStore: memoryStore
    });

    const waitRes = await broker.waitWorker({
      project_id: 'proj-021',
      dispatch_id: 'D-WREG-021'
    });

    assert.strictEqual(waitRes.ok, false);
    assert.strictEqual(waitRes.code, ERROR_CODES.WORKER_WAIT_UNAVAILABLE);
    assert.strictEqual(waitRes.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(adapterWaitCalls, 0);

    const stateAfter = memoryStore.getActiveDispatch('proj-021').state;
    assert.strictEqual(stateAfter, DISPATCH_STATES.DISPATCH_ACCEPTED);
    console.log('✓ WREG-021 PASSED: wait resolution failure throws, broker maps to WORKER_WAIT_UNAVAILABLE, lifecycle unchanged');
  }

  // WREG-022: dispatch resolution failure: definitive failure, broker -> DISPATCH_FAILED, zero adapter invocation
  {
    let adapterDispatchCalls = 0;
    const adapter = {
      dispatch: async () => {
        adapterDispatchCalls++;
        return { ok: true };
      },
      wait: async () => ({ ok: true })
    };

    const workerPort = createWorkerAdapterRegistry({
      adapters: [{ engine: 'antigravity', adapter }]
    });

    const memoryStore = createMemoryLifecycleStore();

    // Project has unmatched engine
    const registryPort = {
      getProject: async () => ({
        project_id: 'proj-022',
        worker: {
          engine: 'unmatched-engine',
          enabled: true
        }
      })
    };

    const workspacePort = {
      getWorkspaceState: async () => ({ workspace_state_id: 'state-022' })
    };

    let dispatchCounter = 0;
    const idFactory = {
      nextDispatchId: () => `D-WREG-022-${++dispatchCounter}`
    };

    const broker = createBroker({
      registryPort,
      workspacePort,
      workerPort,
      lifecycleStore: memoryStore,
      idFactory
    });

    const dispatchRes = await broker.dispatchWorker({
      schema_version: 1,
      project_id: 'proj-022',
      work_order_id: 'WO-022',
      expected_workspace_state_id: 'state-022',
      directive: 'test directive'
    });

    assert.strictEqual(dispatchRes.ok, false);
    assert.strictEqual(dispatchRes.code, ERROR_CODES.DISPATCH_FAILED);
    assert.strictEqual(adapterDispatchCalls, 0);

    const history = memoryStore.getProjectHistory('proj-022');
    assert.strictEqual(history.length >= 1, true);
    assert.strictEqual(history[history.length - 1].next_state, DISPATCH_STATES.DISPATCH_FAILED);
    const latest = memoryStore.getLatestDispatch('proj-022');
    assert.strictEqual(latest.state, DISPATCH_STATES.DISPATCH_FAILED);
    console.log('✓ WREG-022 PASSED: dispatch resolution failure is definitive, broker transitions to DISPATCH_FAILED');
  }

  // WREG-023: options.workerPort bypasses registry and wins over workerAdapterRegistry
  {
    const explicitPort = { dispatch: async () => {}, wait: async () => {} };
    const customRegistry = { dispatch: async () => {}, wait: async () => {} };

    const runtime = createBrokerRuntime({
      registryPort: { getProject: async () => null },
      workspacePort: { getWorkspaceState: async () => null },
      lifecycleStore: createMemoryLifecycleStore(),
      workerPort: explicitPort,
      workerAdapterRegistry: customRegistry
    });

    assert.strictEqual(runtime.workerPort, explicitPort);
    console.log('✓ WREG-023 PASSED: options.workerPort bypasses registry and wins over workerAdapterRegistry');
  }

  // WREG-024: options.workerAdapterRegistry used directly; default runtime otherwise wraps Antigravity
  {
    // Case A: workerPort absent, workerAdapterRegistry supplied
    const customRegistry = { dispatch: async () => {}, wait: async () => {} };
    const runtimeA = createBrokerRuntime({
      registryPort: { getProject: async () => null },
      workspacePort: { getWorkspaceState: async () => null },
      lifecycleStore: createMemoryLifecycleStore(),
      workerAdapterRegistry: customRegistry
    });

    assert.strictEqual(runtimeA.workerPort, customRegistry);

    // Case B: both absent -> default runtime wraps Antigravity in generic facade
    const mockSpawnSync = () => ({ status: 0, stdout: '', stderr: '' });
    const mockCompletionSource = {
      resolveSessionTranscript: () => 'mock-transcript-path',
      findSessionRow: () => ({ session_id: 'mock-session' })
    };

    const runtimeB = createBrokerRuntime({
      registryPort: { getProject: async () => null },
      workspacePort: { getWorkspaceState: async () => null },
      lifecycleStore: createMemoryLifecycleStore(),
      workerOptions: {
        spawnSync: mockSpawnSync,
        completionSource: mockCompletionSource
      }
    });

    assert.strictEqual(typeof runtimeB.workerPort.dispatch, 'function');
    assert.strictEqual(typeof runtimeB.workerPort.wait, 'function');
    // Verify facade public surface has only dispatch and wait
    const keys = Object.keys(runtimeB.workerPort).sort();
    assert.deepStrictEqual(keys, ['dispatch', 'wait']);
    console.log('✓ WREG-024 PASSED: options.workerAdapterRegistry used directly; default runtime wraps Antigravity');
  }

  // WREG-025: missing/non-array options.adapters: construction rejects
  {
    for (const invalidAdapters of [undefined, null, 'not-an-array', 123, {}]) {
      assert.throws(() => {
        createWorkerAdapterRegistry({ adapters: invalidAdapters });
      }, /options\.adapters must be an array/);
    }
    console.log('✓ WREG-025 PASSED: missing or non-array options.adapters rejected at construction');
  }

  // WREG-026: empty options.adapters: construction rejects
  {
    assert.throws(() => {
      createWorkerAdapterRegistry({ adapters: [] });
    }, /options\.adapters must be a non-empty array/);
    console.log('✓ WREG-026 PASSED: empty options.adapters rejected at construction');
  }

  // WREG-027: non-plain registration entry: construction rejects
  {
    const adapter = createMockAdapter();

    class CustomEntry {
      constructor() {
        this.engine = 'antigravity';
        this.adapter = adapter;
      }
    }

    const invalidEntries = [
      null,
      undefined,
      'string-entry',
      ['array-entry'],
      new CustomEntry()
    ];

    for (const badEntry of invalidEntries) {
      assert.throws(() => {
        createWorkerAdapterRegistry({ adapters: [badEntry] });
      }, /must be a plain object/);
    }
    console.log('✓ WREG-027 PASSED: non-plain registration entry rejected at construction');
  }

  // WREG-028: null/array/non-object adapter: construction rejects
  {
    const invalidAdapters = [
      null,
      undefined,
      ['array-adapter'],
      'string-adapter',
      123
    ];

    for (const badAdapter of invalidAdapters) {
      assert.throws(() => {
        createWorkerAdapterRegistry({
          adapters: [{ engine: 'antigravity', adapter: badAdapter }]
        });
      }, /must be a non-null object/);
    }
    console.log('✓ WREG-028 PASSED: null/array/non-object adapter rejected at construction');
  }

  console.log('\n======================================================================');
  console.log('ALL WORKER ADAPTER REGISTRY TESTS PASSED (WREG-001 .. WREG-028: 28/28 PASS)');
  console.log('======================================================================\n');
}

runTests().catch((err) => {
  console.error('WREG TEST SUITE FAILED:', err);
  process.exit(1);
});

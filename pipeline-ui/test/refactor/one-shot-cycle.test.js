'use strict';

/**
 * One-Shot Full-Cycle Coordinator Deterministic Test Suite
 * Deterministic test matrix for runOneShotCycle.
 */

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runOneShotCycle } = require('../../lib/relay/one-shot-cycle');
const { AUDIT_DECISIONS } = require('../../lib/relay/audit-decision');
const { LIMITS: BROKER_LIMITS } = require('../../lib/broker/contracts');

function textPrompt(text = 'deterministic prompt') {
  return [
    {
      type: 'text',
      text
    }
  ];
}

// Track temporary test directories to clean up
const tempDirs = [];

function createTempProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc-test-'));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup error on Windows temp files
    }
  }
}

function createSampleCatalog() {
  return [
    {
      id: 'mock-model-standard',
      model: 'mock-model-standard',
      displayName: 'Mock Standard',
      description: 'Standard model',
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Low' },
        { reasoningEffort: 'medium', description: 'Medium' },
        { reasoningEffort: 'high', description: 'High' }
      ]
    }
  ];
}

function createMockProject(projectRoot, overrides = {}) {
  return {
    project_id: 'test-proj',
    project_name: 'Test Project',
    project_root: projectRoot,
    auditor: {
      thread_id: 'thread-alpha-001',
      enabled: true,
      cwd: projectRoot,
      model_policy: 'auditor_standard'
    },
    worker: {
      enabled: true,
      engine: 'antigravity',
      session_id: 'session-worker-001',
      model_policy: 'worker_standard'
    },
    policy: {
      require_workspace_state: true,
      max_active_dispatches: 1
    },
    ...overrides
  };
}

function createMockSnapshot(projectRoot, stateId = 'snap-001') {
  return {
    workspace_state_id: stateId,
    project_id: 'test-proj',
    project_root: projectRoot
  };
}

function createDecisionTurn(decisionData, turnId = 'turn-001') {
  return {
    id: turnId,
    status: 'completed',
    itemsView: 'full',
    items: [
      {
        type: 'agentMessage',
        phase: 'final_answer',
        text: JSON.stringify(decisionData)
      }
    ]
  };
}

function createValidDecisionPayload({
  decision = AUDIT_DECISIONS.DISPATCH_WORKER,
  projectId = 'test-proj',
  auditSubjectId = 'sub-01',
  auditorThreadId = 'thread-alpha-001',
  workspaceStateObserved = 'snap-001',
  workOrderId = 'wo-001',
  directive = 'Execute task directive',
  workerModelPolicy = 'worker_standard'
} = {}) {
  const base = {
    schema_version: 1,
    decision,
    project_id: projectId,
    audit_subject_id: auditSubjectId,
    auditor_thread_id: auditorThreadId,
    workspace_state_observed: workspaceStateObserved,
    summary: 'Deterministic test rationale summary',
    independent_verification: [
      {
        kind: 'SOURCE_INSPECTION',
        evidence: 'Verified implementation',
        result: 'PASS'
      }
    ],
    work_order: null,
    requested_evidence: [],
    blocker: null
  };

  if (decision === AUDIT_DECISIONS.DISPATCH_WORKER) {
    base.work_order = {
      work_order_id: workOrderId,
      directive,
      verification: ['npm test'],
      worker_model_policy: workerModelPolicy
    };
  } else if (decision === AUDIT_DECISIONS.REQUEST_EVIDENCE) {
    base.requested_evidence = ['Need additional test output'];
  } else if (decision === AUDIT_DECISIONS.BLOCKED) {
    base.blocker = 'Missing upstream dependency';
  }

  return base;
}

function createMockAdapter({
  threadId = 'thread-alpha-001',
  catalog = createSampleCatalog(),
  turnAData = createValidDecisionPayload({ decision: AUDIT_DECISIONS.DISPATCH_WORKER, workspaceStateObserved: 'snap-001' }),
  turnBData = createValidDecisionPayload({ decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE, workspaceStateObserved: 'snap-001' }),
  closeThrows = false,
  startTurnError = null,
  awaitDecisionError = null
} = {}) {
  let initializeCalls = 0;
  let resumeCalls = 0;
  let listModelsCalls = 0;
  let startTurnCalls = 0;
  let closeCalls = 0;
  let turnCounter = 0;
  let lastWaitForTurnCompletionParams = null;

  const adapter = {
    get initializeCalls() { return initializeCalls; },
    get resumeCalls() { return resumeCalls; },
    get listModelsCalls() { return listModelsCalls; },
    get startTurnCalls() { return startTurnCalls; },
    get closeCalls() { return closeCalls; },
    get lastWaitForTurnCompletionParams() { return lastWaitForTurnCompletionParams; },

    async initialize() {
      initializeCalls++;
      return { ok: true };
    },

    async resumeThread(params) {
      resumeCalls++;
      return {
        threadId: params.threadId,
        resumed: true,
        raw: {}
      };
    },

    async listModels() {
      listModelsCalls++;
      return catalog;
    },

    async startTurn(_params) {
      startTurnCalls++;
      if (startTurnError) {
        throw startTurnError;
      }
      turnCounter++;
      return {
        turnId: `turn-mock-${turnCounter}`,
        status: 'inProgress'
      };
    },

    async waitForTurnCompletion(params) {
      lastWaitForTurnCompletionParams = params;
      if (awaitDecisionError) {
        throw awaitDecisionError;
      }
      const data = turnCounter === 1 ? turnAData : turnBData;
      return {
        status: 'completed',
        turn: createDecisionTurn(data, params.turnId)
      };
    },

    async readThread(params) {
      const data = turnCounter === 1 ? turnAData : turnBData;
      return {
        thread: {
          id: params.threadId,
          turns: [createDecisionTurn(data, `turn-mock-${turnCounter}`)]
        }
      };
    },

    async close() {
      closeCalls++;
      if (closeThrows) {
        throw new Error('Adapter close connection failure');
      }
      return { closed: true };
    }
  };

  return adapter;
}

async function runTests() {
  console.log('Starting One-Shot Full-Cycle Coordinator Deterministic Test Suite...');

  // OSC-001: Missing or invalid projectId
  {
    const res = await runOneShotCycle({ projectId: '' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(res.cleanup.auditor_close, 'NOT_REQUIRED');
    console.log('PASS: OSC-001 — Missing/empty projectId rejected pre-factory');
  }

  // OSC-002: Invalid auditSubjectId
  {
    const res1 = await runOneShotCycle({ projectId: 'p', auditSubjectId: ' has space ' });
    assert.strictEqual(res1.code, 'STARTING_STATE_INVALID');
    const res2 = await runOneShotCycle({ projectId: 'p', auditSubjectId: 'ctrl\x00char' });
    assert.strictEqual(res2.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-002 — Invalid auditSubjectId (whitespace/control characters) rejected');
  }

  // OSC-003: Empty prompt arrays
  {
    const res1 = await runOneShotCycle({ projectId: 'p', auditSubjectId: 'sub', auditPrompt: [] });
    assert.strictEqual(res1.code, 'STARTING_STATE_INVALID');
    const res2 = await runOneShotCycle({ projectId: 'p', auditSubjectId: 'sub', auditPrompt: textPrompt('prompt'), reviewPrompt: [] });
    assert.strictEqual(res2.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-003 — Empty auditPrompt/reviewPrompt rejected');
  }

  // OSC-004: Missing port/broker/factory functions
  {
    const res = await runOneShotCycle({
      projectId: 'p',
      auditSubjectId: 'sub',
      auditPrompt: textPrompt('a'),
      reviewPrompt: textPrompt('r')
      // missing ports
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-004 — Missing ports/broker/factory rejected');
  }

  // OSC-005: Missing project in registry
  {
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('test prompt'),
      reviewPrompt: textPrompt('review prompt'),
      registryPort: { getProject: async () => null },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(res.cleanup.auditor_close, 'NOT_REQUIRED');
    console.log('PASS: OSC-005 — Missing project in registry returns STARTING_STATE_INVALID (0 factory calls)');
  }

  // OSC-006: Project ID mismatch in project returned by registry
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir, { project_id: 'different-proj' });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-006 — Project ID mismatch returns STARTING_STATE_INVALID');
  }

  // OSC-007: Auditor unbound in registry
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    proj.auditor.thread_id = null;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    console.log('PASS: OSC-007 — Unbound auditor returns AUDITOR_UNAVAILABLE');
  }

  // OSC-008: Auditor disabled in registry
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    proj.auditor.enabled = false;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    console.log('PASS: OSC-008 — Disabled auditor returns AUDITOR_UNAVAILABLE');
  }

  // OSC-009: Worker not IDLE
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    let factoryCalled = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'RUNNING', active_dispatch_id: 'disp-1', active_work_order_id: 'wo-1' }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => { factoryCalled++; return {}; }
    });
    assert.strictEqual(res.code, 'WORKER_BUSY');
    assert.strictEqual(factoryCalled, 0);
    console.log('PASS: OSC-009 — Worker not IDLE returns WORKER_BUSY (0 factory calls)');
  }

  // OSC-010: Worker IDLE but active_dispatch_id non-null
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: 'ghost-dispatch', active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'WORKER_BUSY');
    console.log('PASS: OSC-010 — Worker active_dispatch_id non-null returns WORKER_BUSY');
  }

  // OSC-011: broker.getWorkerStatus returns ok: false
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: false, code: 'REGISTRY_UNAVAILABLE' }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'REGISTRY_UNAVAILABLE');
    console.log('PASS: OSC-011 — broker.getWorkerStatus failure preserves bounded code');
  }

  // OSC-012: Worker engine not antigravity
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    proj.worker.engine = 'other_engine';
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-012 — Non-antigravity worker engine rejected');
  }

  // OSC-013: Policy max_active_dispatches != 1
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    proj.policy.max_active_dispatches = 2;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-013 — Policy max_active_dispatches != 1 rejected');
  }

  // OSC-CANON-01: Runtime canonical root resolution at Gate A
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    let factoryCwd = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async (opts) => {
        factoryCwd = opts.cwd;
        return createMockAdapter();
      }
    });
    assert.strictEqual(typeof factoryCwd, 'string');
    assert.strictEqual(fs.realpathSync.native(testDir), factoryCwd);
    console.log('PASS: OSC-CANON-01 — Gate A obtains canonicalProjectRoot via runtime canonicalizeProjectRoot');
  }

  // OSC-CANON-02: auditor.cwd identity mismatch with project_root
  {
    const testDir1 = createTempProjectDir();
    const testDir2 = createTempProjectDir();
    const proj = createMockProject(testDir1);
    proj.auditor.cwd = testDir2;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({})
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    console.log('PASS: OSC-CANON-02 — Gate A auditor.cwd identity mismatch with project_root rejected');
  }

  // OSC-014: auditorFactory called at most once
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    let factoryCalls = 0;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => {
        factoryCalls++;
        return createMockAdapter();
      }
    });
    assert.strictEqual(factoryCalls, 1);
    console.log('PASS: OSC-014 — auditorFactory called exactly once');
  }

  // OSC-015: auditorFactory throws
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => { throw new Error('Spawn failure'); }
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    assert.strictEqual(res.cleanup.auditor_close, 'NOT_REQUIRED');
    console.log('PASS: OSC-015 — auditorFactory throwing returns AUDITOR_UNAVAILABLE (clean NOT_REQUIRED)');
  }

  // OSC-016: Malformed adapter without callable close
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({ initialize: () => {} })
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    console.log('PASS: OSC-016 — Malformed adapter rejected with AUDITOR_UNAVAILABLE');
  }

  // OSC-017: Malformed adapter with callable close calls close once
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    let closeCalled = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => ({
        close: async () => { closeCalled++; }
      })
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    assert.strictEqual(closeCalled, 1);
    assert.strictEqual(res.cleanup.auditor_close, 'SUCCEEDED');
    console.log('PASS: OSC-017 — Malformed adapter with close method cleans up exactly once');
  }

  // OSC-018: initialize called before resumeThread; startThread calls = 0
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    let initTimestamp = 0;
    let resumeTimestamp = 0;
    let startThreadCalls = 0;
    const adapter = createMockAdapter();
    const origInit = adapter.initialize;
    const origResume = adapter.resumeThread;
    adapter.startThread = () => { startThreadCalls++; };
    adapter.initialize = async () => { initTimestamp = Date.now(); return origInit(); };
    adapter.resumeThread = async (p) => { resumeTimestamp = Date.now(); return origResume(p); };

    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.ok(initTimestamp <= resumeTimestamp);
    assert.strictEqual(startThreadCalls, 0);
    console.log('PASS: OSC-018 — initialize precedes resumeThread; startThread calls = 0');
  }

  // OSC-019: initialize throwing returns AUDITOR_UNAVAILABLE and cleans up
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    adapter.initialize = async () => { throw new Error('Init error'); };
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUDITOR_UNAVAILABLE');
    assert.strictEqual(adapter.closeCalls, 1);
    console.log('PASS: OSC-019 — initialize throwing returns AUDITOR_UNAVAILABLE and closes adapter');
  }

  // OSC-020: resumeThread threadId mismatch returns THREAD_RESUME_MISMATCH
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    adapter.resumeThread = async () => ({ threadId: 'wrong-thread-id' });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'THREAD_RESUME_MISMATCH');
    assert.strictEqual(adapter.closeCalls, 1);
    console.log('PASS: OSC-020 — resumeThread threadId mismatch returns THREAD_RESUME_MISMATCH');
  }

  // OSC-021: resumeThread throwing returns THREAD_RESUME_MISMATCH
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    adapter.resumeThread = async () => { throw new Error('Resume network error'); };
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'THREAD_RESUME_MISMATCH');
    console.log('PASS: OSC-021 — resumeThread throwing returns THREAD_RESUME_MISMATCH');
  }

  // OSC-022: listModels throwing returns MODEL_POLICY_UNAVAILABLE
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    adapter.listModels = async () => { throw new Error('Catalog down'); };
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'MODEL_POLICY_UNAVAILABLE');
    console.log('PASS: OSC-022 — listModels throwing returns MODEL_POLICY_UNAVAILABLE');
  }

  // OSC-023: resolveAuditorModelPolicy fails (empty catalog)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({ catalog: [] });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => ({}) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'MODEL_POLICY_UNAVAILABLE');
    assert.strictEqual(adapter.startTurnCalls, 0);
    console.log('PASS: OSC-023 — Model policy resolution failure returns MODEL_POLICY_UNAVAILABLE (0 turns)');
  }

  // OSC-024: Model policy resolution called once; resolved model pinned across Turn A and B
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const capturedStartTurnParams = [];
    const origStart = adapter.startTurn;
    adapter.startTurn = async (p) => {
      capturedStartTurnParams.push(p);
      return origStart(p);
    };
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('turn A prompt'),
      reviewPrompt: textPrompt('turn B prompt'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(adapter.listModelsCalls, 1);
    assert.strictEqual(capturedStartTurnParams.length, 2);
    assert.strictEqual(capturedStartTurnParams[0].model, 'mock-model-standard');
    assert.strictEqual(capturedStartTurnParams[1].model, 'mock-model-standard');
    assert.strictEqual(capturedStartTurnParams[0].effort, 'medium');
    assert.strictEqual(capturedStartTurnParams[1].effort, 'medium');
    console.log('PASS: OSC-024 — Model policy pinned across Turn A and B with single listModels call');
  }

  // OSC-CANON-03: Gate B detects canonical project_root drift
  {
    const testDir1 = createTempProjectDir();
    const testDir2 = createTempProjectDir();
    const projA = createMockProject(testDir1);
    const projB = createMockProject(testDir2);
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          return getProjectCalls === 1 ? projA : projB;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir1) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    assert.strictEqual(adapter.startTurnCalls, 0);
    console.log('PASS: OSC-CANON-03 — Gate B canonical root drift returns AUTHORITY_DRIFT (0 turns)');
  }

  // OSC-025: Gate B config drift (e.g. auditor.thread_id changed)
  {
    const testDir = createTempProjectDir();
    const projA = createMockProject(testDir);
    const projB = createMockProject(testDir);
    projB.auditor.thread_id = 'different-thread';
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          return getProjectCalls === 1 ? projA : projB;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    console.log('PASS: OSC-025 — Gate B config drift returns AUTHORITY_DRIFT');
  }

  // OSC-026: Gate B registry read throwing returns AUTHORITY_DRIFT
  {
    const testDir = createTempProjectDir();
    const projA = createMockProject(testDir);
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          if (getProjectCalls > 1) throw new Error('Registry offline');
          return projA;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    console.log('PASS: OSC-026 — Gate B registry read throwing returns AUTHORITY_DRIFT');
  }

  // OSC-027: S0 workspace state failure
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => { throw new Error('Git failure'); } },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'WORKSPACE_STATE_FAILED');
    assert.strictEqual(adapter.startTurnCalls, 0);
    console.log('PASS: OSC-027 — S0 computation failure returns WORKSPACE_STATE_FAILED (0 turns)');
  }

  // OSC-028: Turn A startTurn receives exact auditSubjectId and auditPrompt
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let turnAInput = null;
    const origStart = adapter.startTurn;
    adapter.startTurn = async (p) => {
      if (!turnAInput) turnAInput = p.input;
      return origStart(p);
    };
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [{ type: 'text', text: 'turn A input content' }],
      reviewPrompt: textPrompt('turn B input content'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.deepStrictEqual(turnAInput, [{ type: 'text', text: 'turn A input content' }]);
    console.log('PASS: OSC-028 — Turn A uses caller auditPrompt');
  }

  // OSC-029: Turn A REQUEST_EVIDENCE decision
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.REQUEST_EVIDENCE, workspaceStateObserved: 'snap-001' })
    });
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => { dispatchCalls++; return { ok: true }; },
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'EVIDENCE_REQUIRED');
    assert.strictEqual(res.code, null);
    assert.strictEqual(dispatchCalls, 0);
    assert.strictEqual(res.turn_a_decision.decision, AUDIT_DECISIONS.REQUEST_EVIDENCE);
    console.log('PASS: OSC-029 — Turn A REQUEST_EVIDENCE terminates with EVIDENCE_REQUIRED (0 dispatches)');
  }

  // OSC-030: Turn A APPROVE_WORK_PACKAGE decision
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE, workspaceStateObserved: 'snap-001' })
    });
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => { dispatchCalls++; return { ok: true }; },
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'APPROVED_WITHOUT_DISPATCH');
    assert.strictEqual(dispatchCalls, 0);
    console.log('PASS: OSC-030 — Turn A APPROVE_WORK_PACKAGE terminates with APPROVED_WITHOUT_DISPATCH (0 dispatches)');
  }

  // OSC-031: Turn A BLOCKED decision
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.BLOCKED, workspaceStateObserved: 'snap-001' })
    });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'BLOCKED');
    console.log('PASS: OSC-031 — Turn A BLOCKED terminates with BLOCKED');
  }

  // OSC-032: Turn A STOP decision
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.STOP, workspaceStateObserved: 'snap-001' })
    });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'STOPPED');
    console.log('PASS: OSC-032 — Turn A STOP terminates with STOPPED');
  }

  // OSC-TURN-01: startTurn throws CODEX_APP_SERVER_REQUEST_UNCERTAIN
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const uncertainErr = new Error('Request uncertain');
    uncertainErr.code = 'CODEX_APP_SERVER_REQUEST_UNCERTAIN';
    const adapter = createMockAdapter({ startTurnError: uncertainErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_UNCERTAIN');
    assert.strictEqual(adapter.startTurnCalls, 1);
    console.log('PASS: OSC-TURN-01 — startTurn REQUEST_UNCERTAIN maps to AUDITOR_TURN_UNCERTAIN (0 resend)');
  }

  // OSC-TURN-02: startTurn throws definitive failure
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const defErr = new Error('Server not ready');
    defErr.code = 'CODEX_APP_SERVER_NOT_READY';
    const adapter = createMockAdapter({ startTurnError: defErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_FAILED');
    console.log('PASS: OSC-TURN-02 — startTurn definitive failure maps to AUDITOR_TURN_FAILED');
  }

  // OSC-TURN-03: awaitAuditDecisionV1 operational wait timeout
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const timeoutErr = new Error('Wait turn timeout');
    timeoutErr.code = 'WAIT_TURN_TIMEOUT';
    const adapter = createMockAdapter({ awaitDecisionError: timeoutErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_UNCERTAIN');
    console.log('PASS: OSC-TURN-03 — awaitAuditDecisionV1 WAIT_TURN_TIMEOUT maps to AUDITOR_TURN_UNCERTAIN');
  }

  // OSC-TURN-04: awaitAuditDecisionV1 AUDIT_DECISION_TURN_NOT_COMPLETED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const notCompErr = new Error('Turn failed');
    notCompErr.code = 'AUDIT_DECISION_TURN_NOT_COMPLETED';
    const adapter = createMockAdapter({ awaitDecisionError: notCompErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_FAILED');
    console.log('PASS: OSC-TURN-04 — AUDIT_DECISION_TURN_NOT_COMPLETED maps to AUDITOR_TURN_FAILED');
  }

  // OSC-TURN-05: awaitAuditDecisionV1 AUDIT_DECISION_ITEMS_INCOMPLETE
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const incErr = new Error('Hydration incomplete');
    incErr.code = 'AUDIT_DECISION_ITEMS_INCOMPLETE';
    const adapter = createMockAdapter({ awaitDecisionError: incErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DECISION_INVALID');
    console.log('PASS: OSC-TURN-05 — AUDIT_DECISION_ITEMS_INCOMPLETE maps to DECISION_INVALID');
  }

  // OSC-TURN-06: Strict decision error AUDIT_DECISION_SCHEMA_INVALID
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const schemaErr = new Error('Schema invalid');
    schemaErr.code = 'AUDIT_DECISION_SCHEMA_INVALID';
    const adapter = createMockAdapter({ awaitDecisionError: schemaErr });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DECISION_INVALID');
    console.log('PASS: OSC-TURN-06 — AUDIT_DECISION_SCHEMA_INVALID maps to DECISION_INVALID');
  }

  // OSC-TURN-07: Same turn error policy applies to Turn B (Turn B start uncertainty)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let turnCount = 0;
    const origStart = adapter.startTurn;
    adapter.startTurn = async (p) => {
      turnCount++;
      if (turnCount === 2) {
        const err = new Error('Turn B uncertain');
        err.code = 'CODEX_APP_SERVER_REQUEST_UNCERTAIN';
        throw err;
      }
      return origStart(p);
    };
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_UNCERTAIN');
    console.log('PASS: OSC-TURN-07 — Turn B start uncertainty maps to AUDITOR_TURN_UNCERTAIN');
  }

  // OSC-033: Gate C authority drift before dispatch
  {
    const testDir = createTempProjectDir();
    const projA = createMockProject(testDir);
    const projC = createMockProject(testDir);
    projC.worker.session_id = 'drifted-session';
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          return getProjectCalls === 3 ? projC : projA;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => { dispatchCalls++; return { ok: true }; },
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    assert.strictEqual(dispatchCalls, 0);
    console.log('PASS: OSC-033 — Gate C authority drift returns AUTHORITY_DRIFT (0 dispatches)');
  }

  // OSC-034: Worker model policy mismatch at Gate C
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    proj.worker.model_policy = 'worker_economy';
    // Turn A specifies worker_standard in work_order
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({
        decision: AUDIT_DECISIONS.DISPATCH_WORKER,
        workerModelPolicy: 'worker_standard',
        workspaceStateObserved: 'snap-001'
      })
    });
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => { dispatchCalls++; return { ok: true }; },
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'WORKER_POLICY_MISMATCH');
    assert.strictEqual(dispatchCalls, 0);
    console.log('PASS: OSC-034 — Worker model policy mismatch returns WORKER_POLICY_MISMATCH (0 dispatches)');
  }

  // OSC-035: S1 drift returns STALE_AUDIT_STATE
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let wsCalls = 0;
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async () => {
          wsCalls++;
          return createMockSnapshot(testDir, wsCalls === 1 ? 'snap-001' : 'snap-drifted');
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => { dispatchCalls++; return { ok: true }; },
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'STALE_AUDIT_STATE');
    assert.strictEqual(dispatchCalls, 0);
    console.log('PASS: OSC-035 — S1 drift returns STALE_AUDIT_STATE (0 dispatches)');
  }

  // OSC-036: Worker dispatch call shape verified, called at most once
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let dispatchRequest = null;
    let dispatchCalls = 0;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async (req) => {
          dispatchCalls++;
          dispatchRequest = req;
          return { ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' };
        },
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(dispatchCalls, 1);
    assert.deepStrictEqual(Object.keys(dispatchRequest).sort(), [
      'directive',
      'expected_workspace_state_id',
      'project_id',
      'schema_version',
      'work_order_id'
    ]);
    console.log('PASS: OSC-036 — Worker dispatch called at most once with exact broker request shape');
  }

  // OSC-DISP-OWN-01: Fresh broker DISPATCH_ACCEPTED is accepted as coordinator-owned dispatch
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitDispatchId = null;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'disp-fresh-99', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (req) => {
          waitDispatchId = req.dispatch_id;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'disp-fresh-99', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.dispatch_id, 'disp-fresh-99');
    assert.strictEqual(waitDispatchId, 'disp-fresh-99');
    console.log('PASS: OSC-DISP-OWN-01 — Fresh DISPATCH_ACCEPTED accepted as owned dispatch');
  }

  // OSC-DISP-OWN-02: Idempotent replay rejected with DISPATCH_REPLAY_NOT_OWNED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, idempotent_replay: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'disp-replayed', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => { waitCalls++; return { ok: true }; }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_REPLAY_NOT_OWNED');
    assert.strictEqual(waitCalls, 0);
    console.log('PASS: OSC-DISP-OWN-02 — idempotent_replay rejected with DISPATCH_REPLAY_NOT_OWNED (0 wait calls)');
  }

  // OSC-DISP-OWN-03: Malformed successful dispatch result
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: '', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => { waitCalls++; return { ok: true }; }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    assert.strictEqual(waitCalls, 0);
    console.log('PASS: OSC-DISP-OWN-03 — Malformed dispatch result returns DISPATCH_RESULT_INVALID (0 wait calls)');
  }

  // OSC-DISP-OWN-04: Broker DISPATCH_UNCERTAIN preserved exactly
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: 'DISPATCH_UNCERTAIN' }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_UNCERTAIN');
    console.log('PASS: OSC-DISP-OWN-04 — Broker DISPATCH_UNCERTAIN preserved exactly');
  }

  // OSC-WAIT-OWN-01: wait READY_FOR_REVIEW with exact dispatch identity permits Turn B
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-exact-01', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-exact-01', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(adapter.startTurnCalls, 2);
    assert.strictEqual(res.status, 'APPROVED');
    console.log('PASS: OSC-WAIT-OWN-01 — wait READY_FOR_REVIEW with exact identity permits Turn B');
  }

  // OSC-WAIT-OWN-02: wait returning RUNNING maps to WORKER_PENDING (no Turn B)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'RUNNING', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'WORKER_PENDING');
    assert.strictEqual(res.code, null);
    assert.strictEqual(res.worker_state, 'RUNNING');
    assert.strictEqual(adapter.startTurnCalls, 1);
    console.log('PASS: OSC-WAIT-OWN-02 — wait RUNNING returns WORKER_PENDING (0 Turn B)');
  }

  // OSC-WAIT-OWN-03: Unexpected successful wait state (e.g. DISPATCHING)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'DISPATCHING', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    assert.strictEqual(adapter.startTurnCalls, 1);
    console.log('PASS: OSC-WAIT-OWN-03 — Unexpected wait state DISPATCHING returns DISPATCH_RESULT_INVALID');
  }

  // OSC-WAIT-OWN-04: Wait result dispatch_id mismatch
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'wrong-dispatch', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    console.log('PASS: OSC-WAIT-OWN-04 — Wait result dispatch_id mismatch returns DISPATCH_RESULT_INVALID');
  }

  // OSC-WAIT-OWN-05: Wait result failure preserves bounded broker code
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: false, code: 'WORKER_WAIT_UNAVAILABLE' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'WORKER_WAIT_UNAVAILABLE');
    console.log('PASS: OSC-WAIT-OWN-05 — Wait failure preserves bounded broker code');
  }

  // OSC-037: READY_FOR_REVIEW alone never constitutes approval
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnBData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.STOP, workspaceStateObserved: 'snap-001' })
    });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'STOPPED');
    assert.notStrictEqual(res.status, 'APPROVED');
    console.log('PASS: OSC-037 — READY_FOR_REVIEW alone does not produce APPROVED status');
  }

  // OSC-038: Gate D authority drift
  {
    const testDir = createTempProjectDir();
    const projA = createMockProject(testDir);
    const projD = createMockProject(testDir);
    projD.auditor.enabled = false;
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          return getProjectCalls === 4 ? projD : projA;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    assert.strictEqual(adapter.startTurnCalls, 1);
    console.log('PASS: OSC-038 — Gate D authority drift returns AUTHORITY_DRIFT (0 Turn B)');
  }

  // OSC-039: S2 computed via fresh Gate D project
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnBData: createValidDecisionPayload({
        decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE,
        workspaceStateObserved: 'snap-002'
      })
    });
    let s2ProjectPassed = null;
    let wsCalls = 0;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async (p) => {
          wsCalls++;
          if (wsCalls === 3) s2ProjectPassed = p; // S0=1, S1=2, S2=3
          return createMockSnapshot(testDir, wsCalls <= 2 ? 'snap-001' : 'snap-002');
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.ok(s2ProjectPassed);
    assert.strictEqual(s2ProjectPassed.project_id, 'test-proj');
    console.log('PASS: OSC-039 — S2 computed via fresh Gate D project');
  }

  // OSC-040: Turn B executed on same adapter and same logical thread ID
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const threadIdsPassed = [];
    const origStart = adapter.startTurn;
    adapter.startTurn = async (p) => {
      threadIdsPassed.push(p.threadId);
      return origStart(p);
    };
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(threadIdsPassed.length, 2);
    assert.strictEqual(threadIdsPassed[0], 'thread-alpha-001');
    assert.strictEqual(threadIdsPassed[1], 'thread-alpha-001');
    console.log('PASS: OSC-040 — Turn B executed on same logical thread ID');
  }

  // OSC-041: Turn B uses explicit reviewPrompt; no raw worker prose
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let turnBInput = null;
    const origStart = adapter.startTurn;
    let startCalls = 0;
    adapter.startTurn = async (p) => {
      startCalls++;
      if (startCalls === 2) turnBInput = p.input;
      return origStart(p);
    };
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('turn A input'),
      reviewPrompt: [{ type: 'text', text: 'explicit review prompt' }],
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.deepStrictEqual(turnBInput, [{ type: 'text', text: 'explicit review prompt' }]);
    console.log('PASS: OSC-041 — Turn B uses explicit reviewPrompt without raw worker prose');
  }

  // OSC-042: Turn B non-approval branches (REQUEST_EVIDENCE, BLOCKED, STOP)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    for (const dec of [AUDIT_DECISIONS.REQUEST_EVIDENCE, AUDIT_DECISIONS.BLOCKED, AUDIT_DECISIONS.STOP]) {
      const adapter = createMockAdapter({
        turnBData: createValidDecisionPayload({ decision: dec, workspaceStateObserved: 'snap-001' })
      });
      const res = await runOneShotCycle({
        projectId: 'test-proj',
        auditSubjectId: 'sub-01',
        auditPrompt: textPrompt('p'),
        reviewPrompt: textPrompt('r'),
        registryPort: { getProject: async () => proj },
        workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
        broker: {
          getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
          dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
          waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
        },
        auditorFactory: async () => adapter
      });
      const expectedStatus = dec === AUDIT_DECISIONS.REQUEST_EVIDENCE
        ? 'EVIDENCE_REQUIRED'
        : (dec === AUDIT_DECISIONS.STOP ? 'STOPPED' : dec);
      assert.strictEqual(res.status, expectedStatus);
    }
    console.log('PASS: OSC-042 — Turn B non-approval branches mapped correctly');
  }

  // OSC-043: Turn B DISPATCH_WORKER yields CYCLE_LIMIT_REACHED with zero second dispatch
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnBData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.DISPATCH_WORKER, workspaceStateObserved: 'snap-001' })
    });
    let dispatchCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => {
          dispatchCalls++;
          return { ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' };
        },
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'CYCLE_LIMIT_REACHED');
    assert.strictEqual(dispatchCalls, 1); // Only initial dispatch, zero second dispatch
    console.log('PASS: OSC-043 — Turn B DISPATCH_WORKER yields CYCLE_LIMIT_REACHED (0 second dispatches)');
  }

  // OSC-044: Final Gate authority drift
  {
    const testDir = createTempProjectDir();
    const projA = createMockProject(testDir);
    const projFinal = createMockProject(testDir);
    projFinal.policy.require_workspace_state = false;
    const adapter = createMockAdapter();
    let getProjectCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: {
        getProject: async () => {
          getProjectCalls++;
          return getProjectCalls === 5 ? projFinal : projA;
        }
      },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'AUTHORITY_DRIFT');
    console.log('PASS: OSC-044 — Final gate authority drift returns AUTHORITY_DRIFT');
  }

  // OSC-045: S3 drift returns STALE_AUDIT_STATE
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let wsCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async () => {
          wsCalls++;
          // S0=1, S1=2, S2=3, S3=4 (S3 has drifted)
          return createMockSnapshot(testDir, wsCalls === 4 ? 'snap-mutated' : 'snap-001');
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'STALE_AUDIT_STATE');
    console.log('PASS: OSC-045 — S3 drift returns STALE_AUDIT_STATE');
  }

  // OSC-CLOSE-01: auditor.close() attempted exactly once on post-factory paths
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(adapter.closeCalls, 1);
    console.log('PASS: OSC-CLOSE-01 — auditor.close() called exactly once in finally block');
  }

  // OSC-CLOSE-02: Successful close marks cleanup SUCCEEDED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.deepStrictEqual(res.cleanup, { auditor_close: 'SUCCEEDED', code: null });
    console.log('PASS: OSC-CLOSE-02 — Successful close sets cleanup { auditor_close: SUCCEEDED, code: null }');
  }

  // OSC-CLOSE-PREC-01: Candidate APPROVED + close failure -> FAILED / AUDITOR_CLOSE_FAILED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({ closeThrows: true });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_CLOSE_FAILED');
    assert.strictEqual(res.cleanup.auditor_close, 'FAILED');
    assert.strictEqual(res.cleanup.code, 'AUDITOR_CLOSE_FAILED');
    assert.strictEqual(res.dispatch_id, 'd-1');
    assert.ok(res.workspace.s0);
    console.log('PASS: OSC-CLOSE-PREC-01 — Candidate APPROVED overridden by close failure; metadata preserved');
  }

  // OSC-CLOSE-PREC-02: Candidate APPROVED_WITHOUT_DISPATCH + close failure -> FAILED / AUDITOR_CLOSE_FAILED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnAData: createValidDecisionPayload({ decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE, workspaceStateObserved: 'snap-001' }),
      closeThrows: true
    });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_CLOSE_FAILED');
    console.log('PASS: OSC-CLOSE-PREC-02 — Candidate APPROVED_WITHOUT_DISPATCH overridden by close failure');
  }

  // OSC-CLOSE-PREC-03: Primary AUDITOR_TURN_UNCERTAIN + close failure preserves primary uncertainty
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const err = new Error('Turn uncertain');
    err.code = 'CODEX_APP_SERVER_REQUEST_UNCERTAIN';
    const adapter = createMockAdapter({ startTurnError: err, closeThrows: true });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'AUDITOR_TURN_UNCERTAIN'); // Primary preserved!
    assert.strictEqual(res.cleanup.auditor_close, 'FAILED');
    assert.strictEqual(res.cleanup.code, 'AUDITOR_CLOSE_FAILED');
    console.log('PASS: OSC-CLOSE-PREC-03 — Primary AUDITOR_TURN_UNCERTAIN preserved across close failure');
  }

  // OSC-CLOSE-PREC-04: Primary DISPATCH_UNCERTAIN + close failure preserves primary uncertainty
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({ closeThrows: true });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: 'DISPATCH_UNCERTAIN' }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_UNCERTAIN'); // Primary preserved!
    assert.strictEqual(res.cleanup.auditor_close, 'FAILED');
    console.log('PASS: OSC-CLOSE-PREC-04 — Primary DISPATCH_UNCERTAIN preserved across close failure');
  }

  // OSC-CLOSE-PREC-05: WORKER_PENDING + close failure preserves WORKER_PENDING status
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({ closeThrows: true });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-pending', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'RUNNING', dispatch_id: 'd-pending', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'WORKER_PENDING'); // Preserved!
    assert.strictEqual(res.code, null);
    assert.strictEqual(res.dispatch_id, 'd-pending');
    assert.strictEqual(res.cleanup.auditor_close, 'FAILED');
    assert.strictEqual(res.cleanup.code, 'AUDITOR_CLOSE_FAILED');
    console.log('PASS: OSC-CLOSE-PREC-05 — WORKER_PENDING preserved across close failure');
  }

  // OSC-HAPPY-01: Exact happy path ordering and invariants
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const order = [];

    const registryPort = {
      getProject: async () => {
        order.push('registry_read');
        return proj;
      }
    };

    let wsCount = 0;
    const workspacePort = {
      getWorkspaceState: async () => {
        wsCount++;
        order.push(`workspace_state_S${wsCount - 1}`);
        const snapId = wsCount <= 2 ? 'snap-001' : 'snap-002';
        return createMockSnapshot(testDir, snapId);
      }
    };

    let dispatchCalls = 0;
    let waitCalls = 0;
    const broker = {
      getWorkerStatus: async () => {
        order.push('get_worker_status');
        return { ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null };
      },
      dispatchWorker: async () => {
        dispatchCalls++;
        order.push('dispatch_worker');
        return {
          ok: true,
          state: 'DISPATCH_ACCEPTED',
          dispatch_id: 'disp-happy-100',
          work_order_id: 'wo-001',
          project_id: 'test-proj'
        };
      },
      waitWorker: async () => {
        waitCalls++;
        order.push('wait_worker');
        return {
          ok: true,
          state: 'READY_FOR_REVIEW',
          dispatch_id: 'disp-happy-100',
          work_order_id: 'wo-001'
        };
      }
    };

    let adapterInstance = null;
    const auditorFactory = async (opts) => {
      order.push('auditor_factory');
      adapterInstance = createMockAdapter({
        turnAData: createValidDecisionPayload({
          decision: AUDIT_DECISIONS.DISPATCH_WORKER,
          workspaceStateObserved: 'snap-001'
        }),
        turnBData: createValidDecisionPayload({
          decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE,
          workspaceStateObserved: 'snap-002' // S2 was observed snapshot
        })
      });

      const origInit = adapterInstance.initialize;
      const origResume = adapterInstance.resumeThread;
      const origList = adapterInstance.listModels;
      const origStart = adapterInstance.startTurn;
      const origWait = adapterInstance.waitForTurnCompletion;
      const origClose = adapterInstance.close;

      adapterInstance.initialize = async () => { order.push('initialize'); return origInit(); };
      adapterInstance.resumeThread = async (p) => { order.push('resume_thread'); return origResume(p); };
      adapterInstance.listModels = async () => { order.push('list_models'); return origList(); };
      adapterInstance.startTurn = async (p) => { order.push('start_turn'); return origStart(p); };
      adapterInstance.waitForTurnCompletion = async (p) => { order.push('await_decision'); return origWait(p); };
      adapterInstance.close = async () => { order.push('close'); return origClose(); };

      return adapterInstance;
    };

    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('run audit'),
      reviewPrompt: textPrompt('run review'),
      registryPort,
      workspacePort,
      broker,
      auditorFactory
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'APPROVED');
    assert.strictEqual(res.code, null);
    assert.strictEqual(res.dispatch_id, 'disp-happy-100');
    assert.strictEqual(res.worker_state, 'READY_FOR_REVIEW');
    assert.strictEqual(res.cleanup.auditor_close, 'SUCCEEDED');
    assert.strictEqual(dispatchCalls, 1);
    assert.strictEqual(waitCalls, 1);
    assert.strictEqual(adapterInstance.startTurnCalls, 2);
    assert.strictEqual(adapterInstance.closeCalls, 1);

    // Verify ordering sequence
    const expectedPrefix = [
      'registry_read',       // Gate A
      'get_worker_status',   // Worker IDLE check
      'auditor_factory',     // Factory
      'initialize',          // Adapter init
      'resume_thread',       // Resume
      'list_models',         // Catalog
      'registry_read',       // Gate B
      'workspace_state_S0',  // S0
      'start_turn',          // Turn A start
      'await_decision',      // Turn A await
      'registry_read',       // Gate C
      'workspace_state_S1',  // S1
      'dispatch_worker',     // Dispatch
      'wait_worker',         // Wait
      'registry_read',       // Gate D
      'workspace_state_S2',  // S2
      'start_turn',          // Turn B start
      'await_decision',      // Turn B await
      'registry_read',       // Final Gate
      'workspace_state_S3',  // S3
      'close'                // Adapter close
    ];
    assert.deepStrictEqual(order, expectedPrefix);
    console.log('PASS: OSC-HAPPY-01 — Happy-path exact ordering verified end-to-end');
  }

  // OSC-046: Optional timeout parameters passed to adapter / broker
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitTimeoutPassed = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      turnTimeoutMs: 45000,
      workerWaitTimeoutSecs: 25,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (p) => {
          waitTimeoutPassed = p.timeout_secs;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitTimeoutPassed, 25);
    console.log('PASS: OSC-046 — Bounded timeout parameters respected');
  }

  // OSC-047: PROVENANCE_AMBIGUOUS from waitWorker preserved
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: false, code: 'PROVENANCE_AMBIGUOUS' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'PROVENANCE_AMBIGUOUS');
    console.log('PASS: OSC-047 — PROVENANCE_AMBIGUOUS preserved from waitWorker');
  }

  // OSC-048: LIFECYCLE_STORE_FAILURE preserved from dispatchWorker
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: 'LIFECYCLE_STORE_FAILURE' }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'LIFECYCLE_STORE_FAILURE');
    console.log('PASS: OSC-048 — LIFECYCLE_STORE_FAILURE preserved from dispatchWorker');
  }

  // OSC-049: Result envelope never fabricates values when early exit
  {
    const res = await runOneShotCycle({ projectId: '' });
    assert.strictEqual(res.turn_a_decision, null);
    assert.strictEqual(res.dispatch_id, null);
    assert.strictEqual(res.worker_state, null);
    assert.strictEqual(res.turn_b_decision, null);
    assert.strictEqual(res.workspace.s0, null);
    assert.strictEqual(res.workspace.s1, null);
    assert.strictEqual(res.workspace.s2, null);
    assert.strictEqual(res.workspace.s3, null);
    console.log('PASS: OSC-049 — Unavailable fields in result envelope remain null');
  }

  // OSC-050: Public export contract — runOneShotCycle only
  {
    const mod = require('../../lib/relay/one-shot-cycle');
    assert.deepStrictEqual(Object.keys(mod), ['runOneShotCycle']);
    assert.strictEqual(typeof mod.runOneShotCycle, 'function');
    console.log('PASS: OSC-050 — Module exports runOneShotCycle only');
  }

  // OSC-051: S2 workspace state throwing returns WORKSPACE_STATE_FAILED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let wsCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async () => {
          wsCalls++;
          if (wsCalls === 3) throw new Error('S2 failed');
          return createMockSnapshot(testDir);
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'WORKSPACE_STATE_FAILED');
    console.log('PASS: OSC-051 — S2 computation failure returns WORKSPACE_STATE_FAILED');
  }

  // OSC-052: S3 workspace state throwing returns WORKSPACE_STATE_FAILED
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let wsCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async () => {
          wsCalls++;
          if (wsCalls === 4) throw new Error('S3 failed');
          return createMockSnapshot(testDir);
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'WORKSPACE_STATE_FAILED');
    console.log('PASS: OSC-052 — S3 computation failure returns WORKSPACE_STATE_FAILED');
  }

  // OSC-053: Turn A DISPATCH_WORKER with malformed work_order returns DECISION_INVALID
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const badDecision = createValidDecisionPayload({ decision: AUDIT_DECISIONS.DISPATCH_WORKER, workspaceStateObserved: 'snap-001' });
    badDecision.work_order = null;
    const adapter = createMockAdapter({ turnAData: badDecision });
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.code, 'DECISION_INVALID');
    console.log('PASS: OSC-053 — DISPATCH_WORKER with null work_order returns DECISION_INVALID');
  }

  // OSC-054: Zero raw worker transcript reads performed by coordinator
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let transcriptReadCalls = 0;
    const broker = {
      getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
      dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
      waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' }),
      readWorkerTranscript: () => { transcriptReadCalls++; }
    };
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker,
      auditorFactory: async () => adapter
    });
    assert.strictEqual(transcriptReadCalls, 0);
    console.log('PASS: OSC-054 — Exactly zero worker transcript reads performed by coordinator');
  }


  // OSC-SUBJ-01: auditSubjectId exceeding 512 UTF-8 bytes rejected with STARTING_STATE_INVALID
  {
    let registryReads = 0;
    const hugeSubjectId = 'a'.repeat(513);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: hugeSubjectId,
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { registryReads++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(registryReads, 0);
    console.log('PASS: OSC-SUBJ-01 — auditSubjectId exceeding 512 bytes rejected with 0 registry reads');
  }

  // OSC-PROMPT-01: empty auditPrompt rejected before any authority calls
  {
    let factoryCalls = 0;
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } },
      auditorFactory: async () => { factoryCalls++; }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    assert.strictEqual(factoryCalls, 0);
    console.log('PASS: OSC-PROMPT-01 — empty auditPrompt rejected with 0 authority calls');
  }

  // OSC-PROMPT-02: empty reviewPrompt rejected before any authority calls
  {
    let factoryCalls = 0;
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: [],
      registryPort: { getProject: async () => { regCalls++; } },
      auditorFactory: async () => { factoryCalls++; }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    assert.strictEqual(factoryCalls, 0);
    console.log('PASS: OSC-PROMPT-02 — empty reviewPrompt rejected with 0 authority calls');
  }

  // OSC-PROMPT-03: auditPrompt containing string item rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: ['raw string'],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-03 — auditPrompt containing string item rejected');
  }

  // OSC-PROMPT-04: reviewPrompt containing string item rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: ['raw string'],
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-04 — reviewPrompt containing string item rejected');
  }

  // OSC-PROMPT-05: null item in auditPrompt rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [null],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-05 — null item in auditPrompt rejected');
  }

  // OSC-PROMPT-06: array item in auditPrompt rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [['nested array']],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-06 — array item in auditPrompt rejected');
  }

  // OSC-PROMPT-07: wrong type token in auditPrompt rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [{ type: 'image', text: 'hi' }],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-07 — wrong type token in auditPrompt rejected');
  }

  // OSC-PROMPT-08: missing text in auditPrompt rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [{ type: 'text' }],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-08 — missing text in auditPrompt rejected');
  }

  // OSC-PROMPT-09: non-string text in auditPrompt rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [{ type: 'text', text: 12345 }],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-09 — non-string text in auditPrompt rejected');
  }

  // OSC-PROMPT-10: auditPrompt aggregate text > 1 MiB rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }],
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-10 — auditPrompt aggregate text > 1 MiB rejected');
  }

  // OSC-PROMPT-11: reviewPrompt aggregate text > 1 MiB rejected
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }],
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-PROMPT-11 — reviewPrompt aggregate text > 1 MiB rejected');
  }

  // OSC-TIME-01: turnTimeoutMs omitted defaults to 60000 at awaitAuditDecisionV1
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => ({ ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(adapter.lastWaitForTurnCompletionParams.timeoutMs, 60000);
    console.log('PASS: OSC-TIME-01 — turnTimeoutMs omitted defaults to 60000 at wait path');
  }

  // OSC-TIME-02: turnTimeoutMs = Infinity rejected pre-authority
  {
    let regCalls = 0;
    let factoryCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      turnTimeoutMs: Infinity,
      registryPort: { getProject: async () => { regCalls++; } },
      auditorFactory: async () => { factoryCalls++; }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    assert.strictEqual(factoryCalls, 0);
    console.log('PASS: OSC-TIME-02 — turnTimeoutMs = Infinity rejected with 0 authority calls');
  }

  // OSC-TIME-03: turnTimeoutMs = NaN rejected pre-authority
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      turnTimeoutMs: NaN,
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-TIME-03 — turnTimeoutMs = NaN rejected pre-authority');
  }

  // OSC-TIME-04: turnTimeoutMs = 0 rejected pre-authority
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      turnTimeoutMs: 0,
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-TIME-04 — turnTimeoutMs = 0 rejected pre-authority');
  }

  // OSC-TIME-05: turnTimeoutMs > 2147483647 rejected pre-authority
  {
    let regCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      turnTimeoutMs: 2147483648,
      registryPort: { getProject: async () => { regCalls++; } }
    });
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    console.log('PASS: OSC-TIME-05 — turnTimeoutMs > 2147483647 rejected pre-authority');
  }

  // OSC-TIME-06: workerWaitTimeoutSecs omitted defaults to broker default bound
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitTimeoutPassed = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (p) => {
          waitTimeoutPassed = p.timeout_secs;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitTimeoutPassed, BROKER_LIMITS.DEFAULT_TIMEOUT_SECS);
    console.log('PASS: OSC-TIME-06 — workerWaitTimeoutSecs omitted defaults to broker default bound');
  }

  // OSC-TIME-07: workerWaitTimeoutSecs = Infinity rejected pre-authority
  {
    let regCalls = 0;
    let factoryCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: Infinity,
      registryPort: { getProject: async () => { regCalls++; } },
      auditorFactory: async () => { factoryCalls++; }
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'STARTING_STATE_INVALID');
    assert.strictEqual(regCalls, 0);
    assert.strictEqual(factoryCalls, 0);
    console.log('PASS: OSC-TIME-07 — workerWaitTimeoutSecs = Infinity rejected pre-authority');
  }

  // OSC-TIME-08: workerWaitTimeoutSecs above broker max normalized to broker max
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitTimeoutPassed = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: 500,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (p) => {
          waitTimeoutPassed = p.timeout_secs;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitTimeoutPassed, BROKER_LIMITS.MAX_TIMEOUT_SECS);
    console.log('PASS: OSC-TIME-08 — workerWaitTimeoutSecs above broker max normalized to broker max');
  }

  // OSC-TIME-09: workerWaitTimeoutSecs below broker min normalized to broker min
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitTimeoutPassed = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: -10,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-1', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (p) => {
          waitTimeoutPassed = p.timeout_secs;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-1', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitTimeoutPassed, BROKER_LIMITS.MIN_TIMEOUT_SECS);
    console.log('PASS: OSC-TIME-09 — workerWaitTimeoutSecs below broker min normalized to broker min');
  }

  // OSC-BOUND-01: Huge broker error code falls back to stage fallback code
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const hugeCode = 'E'.repeat(200);
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: hugeCode }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    console.log('PASS: OSC-BOUND-01 — Huge broker error code falls back to DISPATCH_RESULT_INVALID');
  }

  // OSC-BOUND-02: Control-character error code falls back to stage fallback code
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: 'DISPATCH\nFAILED' }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    console.log('PASS: OSC-BOUND-02 — Control-character error code falls back to DISPATCH_RESULT_INVALID');
  }

  // OSC-BOUND-03: Whitespace-padded error code falls back to stage fallback code
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: false, code: ' DISPATCH_FAILED ' }),
        waitWorker: async () => ({ ok: true })
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.code, 'DISPATCH_RESULT_INVALID');
    console.log('PASS: OSC-BOUND-03 — Whitespace-padded error code falls back to DISPATCH_RESULT_INVALID');
  }

  // -----------------------------------------------------------------------
  // WAIT-BOUND MATRIX (WO-V4-09C-WAIT-I1)
  // -----------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log('RUNNING WAIT-BOUND TEST MATRIX (ONE-SHOT CYCLE)');
  console.log('======================================================================');

  // WAIT-BOUND-006: One-shot exact 300s wait forwarding
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitRequest = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: 300,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-006', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (req) => {
          waitRequest = req;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-wb-006', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitRequest.timeout_secs, 300);
    console.log('PASS: WAIT-BOUND-006 — One-shot cycle passes workerWaitTimeoutSecs 300 to broker.waitWorker');
  }

  // WAIT-BOUND-007: One-shot >300s timeout clamped to 300s
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitCalls = 0;
    let waitRequest = null;
    await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: 450,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-007', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (req) => {
          waitCalls++;
          waitRequest = req;
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-wb-007', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitCalls, 1);
    assert.strictEqual(waitRequest.timeout_secs, 300);
    console.log('PASS: WAIT-BOUND-007 — One-shot cycle clamps workerWaitTimeoutSecs 450 to 300');
  }

  // WAIT-BOUND-008: Exactly one wait call and 0 Turn B on RUNNING
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-008', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => {
          waitCalls++;
          return { ok: true, state: 'RUNNING', dispatch_id: 'd-wb-008', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitCalls, 1);
    assert.strictEqual(adapter.startTurnCalls, 1);
    assert.strictEqual(res.status, 'WORKER_PENDING');
    console.log('PASS: WAIT-BOUND-008 — Exactly one waitWorker call on RUNNING, Turn B not called, status WORKER_PENDING');
  }

  // WAIT-BOUND-009: RUNNING at extended deadline returns WORKER_PENDING
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: 300,
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-009', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async () => {
          waitCalls++;
          return { ok: true, state: 'RUNNING', dispatch_id: 'd-wb-009', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.status, 'WORKER_PENDING');
    assert.strictEqual(res.code, null);
    assert.strictEqual(res.worker_state, 'RUNNING');
    assert.strictEqual(adapter.startTurnCalls, 1);
    assert.strictEqual(waitCalls, 1);
    console.log('PASS: WAIT-BOUND-009 — Worker RUNNING at extended deadline returns WORKER_PENDING (code: null, wait calls: 1)');
  }

  // WAIT-BOUND-010: Late-but-in-bound completion (One-shot part)
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter({
      turnBData: createValidDecisionPayload({
        decision: AUDIT_DECISIONS.APPROVE_WORK_PACKAGE,
        workspaceStateObserved: 'snap-002'
      })
    });
    let s2Observed = false;
    let wsCalls = 0;
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      workerWaitTimeoutSecs: 300,
      registryPort: { getProject: async () => proj },
      workspacePort: {
        getWorkspaceState: async () => {
          wsCalls++;
          if (wsCalls === 3) s2Observed = true;
          return createMockSnapshot(testDir, wsCalls <= 2 ? 'snap-001' : 'snap-002');
        }
      },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => ({ ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-010', work_order_id: 'wo-001', project_id: 'test-proj' }),
        waitWorker: async (req) => {
          waitCalls++;
          assert.strictEqual(req.timeout_secs, 300);
          return { ok: true, state: 'READY_FOR_REVIEW', dispatch_id: 'd-wb-010', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'APPROVED');
    assert.strictEqual(waitCalls, 1);
    assert.strictEqual(s2Observed, true);
    assert.strictEqual(adapter.startTurnCalls, 2);
    console.log('PASS: WAIT-BOUND-010 (One-shot) — workerWaitTimeoutSecs 300 with READY_FOR_REVIEW reaches Gate D, S2, Turn B and completes APPROVED');
  }

  // WAIT-BOUND-012: No retry / no polling loop at coordinator
  {
    const testDir = createTempProjectDir();
    const proj = createMockProject(testDir);
    const adapter = createMockAdapter();
    let dispatchCalls = 0;
    let waitCalls = 0;
    const res = await runOneShotCycle({
      projectId: 'test-proj',
      auditSubjectId: 'sub-01',
      auditPrompt: textPrompt('p'),
      reviewPrompt: textPrompt('r'),
      registryPort: { getProject: async () => proj },
      workspacePort: { getWorkspaceState: async () => createMockSnapshot(testDir) },
      broker: {
        getWorkerStatus: async () => ({ ok: true, worker_state: 'IDLE', active_dispatch_id: null, active_work_order_id: null }),
        dispatchWorker: async () => {
          dispatchCalls++;
          return { ok: true, state: 'DISPATCH_ACCEPTED', dispatch_id: 'd-wb-012', work_order_id: 'wo-001', project_id: 'test-proj' };
        },
        waitWorker: async () => {
          waitCalls++;
          return { ok: true, state: 'RUNNING', dispatch_id: 'd-wb-012', work_order_id: 'wo-001' };
        }
      },
      auditorFactory: async () => adapter
    });
    assert.strictEqual(waitCalls, 1);
    assert.strictEqual(dispatchCalls, 1);
    assert.strictEqual(adapter.startTurnCalls, 1);
    assert.strictEqual(res.status, 'WORKER_PENDING');
    console.log('PASS: WAIT-BOUND-012 — Exactly 1 dispatch, 1 wait, 0 Turn B, status WORKER_PENDING (no retry/polling loop)');
  }

  // Footer dynamic count
  const testFileSrc = fs.readFileSync(__filename, 'utf8');
  const caseMatches = testFileSrc.match(/^\s*\/\/\s+(OSC[^\r\n:]*):/gm) || [];
  const totalCases = caseMatches.length;
  console.log('======================================================================');
  console.log(`ALL ONE-SHOT CYCLE TESTS PASSED (OSC ${totalCases}/${totalCases} PASS)`);
  console.log('WAIT-BOUND (One-shot): 6/6 PASS');
  console.log('======================================================================');
}

runTests()
  .catch((err) => {
    console.error('FATAL: Test failure in one-shot-cycle.test.js:', err);
    process.exit(1);
  })
  .finally(() => {
    cleanupTempDirs();
  });

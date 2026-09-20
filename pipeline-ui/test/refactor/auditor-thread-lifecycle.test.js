'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const child_process = require('child_process');
const {
  createProjectRegistry,
  REGISTRY_ERROR_CODES,
  getAuditorBindingState
} = require('../../lib/broker/registry');
const {
  createWorkspaceStatePort
} = require('../../lib/broker/workspace-state');
const {
  createSqliteAuditorRecoveryStore: createSqliteAuditorRecoveryStoreRaw,
  AUDITOR_BOOTSTRAP_STATES,
  RECOVERY_ERROR_CODES
} = require('../../lib/relay/sqlite-auditor-recovery-store');

function createSqliteAuditorRecoveryStore(opts) {
  const store = createSqliteAuditorRecoveryStoreRaw(opts);
  const origBegin = store.beginBootstrap;
  store.beginBootstrap = function(params = {}) {
    const p = { ...params };
    if (p.authority_version === undefined) {
      p.authority_version = 1;
      let foundProject = null;
      if (opts && opts.dbPath) {
        try {
          const regPath = path.join(path.dirname(opts.dbPath), 'projects.json');
          if (fs.existsSync(regPath)) {
            const rawDoc = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            if (rawDoc.projects && typeof rawDoc.projects === 'object') {
              foundProject = rawDoc.projects[p.project_id] || (Array.isArray(rawDoc.projects) ? rawDoc.projects.find(x => x?.project_id === p.project_id) : null);
            }
          }
        } catch {}
      }
      if (foundProject && foundProject.project_root) {
        try {
          const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
          const res = canonicalizeProjectRoot(foundProject.project_root);
          p.expected_project_root = p.expected_project_root || res.canonicalRoot;
          p.expected_project_root_identity = p.expected_project_root_identity || res.identityKey;
        } catch {
          p.expected_project_root = p.expected_project_root || foundProject.project_root;
          const { computeRootIdentityKey } = require('../../lib/broker/registry');
          p.expected_project_root_identity = p.expected_project_root_identity || computeRootIdentityKey(foundProject.project_root);
        }
        p.expected_auditor_model_policy = p.expected_auditor_model_policy || foundProject.auditor?.model_policy || 'auditor_standard';
      } else {
        p.expected_project_root = p.expected_project_root || 'd:/TU_CODE/Orchestrator';
        p.expected_project_root_identity = p.expected_project_root_identity || 'd:/tu_code/orchestrator';
        p.expected_auditor_model_policy = p.expected_auditor_model_policy || 'auditor_standard';
      }
    }
    return origBegin.call(store, p);
  };
  return store;
}
const {
  CodexAppServerClient
} = require('../../lib/auditor/codex-app-server-client');
const {
  CodexAuditorAdapter
} = require('../../lib/auditor/codex-auditor-adapter');
const {
  AUDIT_DECISIONS,
  awaitAuditDecisionV1
} = require('../../lib/relay/audit-decision');
const {
  bootstrapAuditorThread,
  recoverAuditorBootstrap,
  inspectAuditorBootstrap,
  resolveAuditorBootstrapUncertainty,
  retireLegacyAuditorBootstrapWithoutAuthority,
  assertBootstrapAuthorityMatchesRegistry,
  MAX_UNCERTAINTY_DIAGNOSTIC_BYTES,
  LIFECYCLE_ERROR_CODES
} = require('../../lib/relay/auditor-thread-lifecycle');

const FAKE_APP_SERVER_PATH = path.resolve(__dirname, '../fixtures/fake-codex-app-server.js');

const DEFAULT_AUDIT_PROMPT = Object.freeze([{ type: 'text', text: 'Perform audit evaluation.' }]);

function createMockWorkspacePort(wsStateId = 'ws-fixed-001') {
  return {
    getWorkspaceState: async (project) => ({
      schema_version: 1,
      workspace_state_id: wsStateId,
      project_id: project.project_id,
      project_root: project.project_root
    })
  };
}

function initGitRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  const run = (args) => {
    const res = child_process.spawnSync('git', args, { cwd: repoDir, shell: false, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Git command 'git ${args.join(' ')}' failed: ${res.stderr}`);
    }
    return res;
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Test Auditor']);
  run(['config', 'user.email', 'auditor@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
}

function commitFile(repoDir, relPath, content, msg = 'initial commit') {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  const run = (args) => {
    const res = child_process.spawnSync('git', args, { cwd: repoDir, shell: false, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Git command 'git ${args.join(' ')}' failed: ${res.stderr}`);
    }
  };
  run(['add', relPath]);
  run(['commit', '-m', msg]);
}

function createTestSandbox() {
  const dir = path.join(os.tmpdir(), `test-atl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

function makeValidProject(id, rootPath, overrides = {}) {
  return {
    project_id: id,
    project_name: overrides.project_name || `Project ${id}`,
    project_root: rootPath,
    worker: {
      engine: 'antigravity',
      session_id: `session-${id}-01`,
      enabled: true,
      model_policy: 'worker_standard',
      ...(overrides.worker || {})
    },
    auditor: {
      engine: 'codex_app_server',
      thread_id: null,
      cwd: rootPath,
      enabled: false,
      model_policy: 'auditor_standard',
      ...(overrides.auditor || {})
    },
    policy: {
      max_active_dispatches: 1,
      require_workspace_state: true,
      ...(overrides.policy || {})
    }
  };
}

function createAdapterFactory(options = {}) {
  const { scenario = 'audit_decision', durabilityFile = null, extraArgs = [] } = options;
  return async ({ phase, cwd } = {}) => {
    const args = [
      FAKE_APP_SERVER_PATH,
      `--scenario=${scenario}`,
      ...(durabilityFile ? [`--durability-state-file=${durabilityFile}`] : []),
      ...extraArgs
    ];
    const client = new CodexAppServerClient({
      codexBinary: process.execPath,
      args
    });
    return new CodexAuditorAdapter({ client });
  };
}

function advanceToState(recoveryStore, { projectId, operationId, targetState, threadId = 'thr_fake_001', subjectId = 'sub-01', wsState = 'ws-01' }) {
  recoveryStore.beginBootstrap({
    project_id: projectId,
    operation_id: operationId,
    audit_subject_id: subjectId,
    thread_id: threadId,
    workspace_state_observed: wsState
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD) return;

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING) return;

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
    patch: {
      turn_id: 'turn-test-01'
    }
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT) return;

  const decPayload = {
    schema_version: 1,
    decision: 'APPROVE_WORK_PACKAGE',
    project_id: projectId,
    audit_subject_id: subjectId,
    auditor_thread_id: threadId,
    workspace_state_observed: wsState,
    summary: 'Decision valid for test',
    independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
    work_order: null,
    requested_evidence: [],
    blocker: null
  };
  const decJson = JSON.stringify(decPayload);
  const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
    patch: {
      decision_json: decJson,
      decision_sha256: decHash
    }
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED) return;

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING) return;

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED
  });
  if (targetState === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED) return;

  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
  });
}

async function runAllTests() {
  console.log('Starting Auditor Thread Lifecycle test suite (ATL-001 .. ATL-110)...');

  // ATL-001: Complete happy-path bootstrap sequence end-to-end
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-001');
      const durabilityFile = path.join(sandbox.dir, 'durability.state');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-001', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const adapterFactory = createAdapterFactory({
        scenario: 'audit_decision',
        durabilityFile,
        extraArgs: [
          '--decision-project-id=proj-001',
          '--decision-subject-id=sub-001',
          '--decision-workspace-state=ws-fixed-001'
        ]
      });

      const workspacePort = createMockWorkspacePort('ws-fixed-001');

      const result = await bootstrapAuditorThread({
        projectId: 'proj-001',
        registryPort,
        recoveryStore,
        adapterFactory,
        workspacePort,
        auditSubjectId: 'sub-001',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'DURABLE_BOUND');
      assert.strictEqual(result.project_id, 'proj-001');
      assert.strictEqual(result.thread_id, 'thr_fake_001');
      assert.strictEqual(result.registry_binding_status, 'BOUND');
      assert.strictEqual(result.decision.decision, AUDIT_DECISIONS.DISPATCH_WORKER);
      assert.ok(result.decision_sha256);

      // Verify active bootstrap was removed from recovery journal
      const active = recoveryStore.getActiveBootstrap('proj-001');
      assert.strictEqual(active, null);

      // Verify complete history retained
      const history = recoveryStore.getBootstrapHistory('proj-001');
      assert.ok(history.length >= 6);
      const states = history.map((h) => h.next_state);
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED));
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING));

      // Verify Registry was updated and reloads cleanly
      const reloadedRegistry = createProjectRegistry({ registryFilePath: regFile });
      const boundProject = await reloadedRegistry.getProject('proj-001');
      assert.strictEqual(boundProject.auditor.thread_id, 'thr_fake_001');
      assert.strictEqual(boundProject.auditor.enabled, true);
      assert.strictEqual(getAuditorBindingState(boundProject.auditor), 'AUDITOR_BOUND_READY');

      console.log('PASS: ATL-001 — Complete happy-path bootstrap sequence end-to-end');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-002: Missing project in Registry fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'nonexistent-proj',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-001',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
      console.log('PASS: ATL-002 — Missing project in Registry fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-003: Already bound & enabled project fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-bound');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-bound', projDir, {
        auditor: {
          engine: 'codex_app_server',
          thread_id: 'thr_existing_999',
          cwd: projDir,
          enabled: true,
          model_policy: 'auditor_standard'
        }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-bound',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-001',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
      console.log('PASS: ATL-003 — Already bound & enabled project fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-004: Bound but disabled project fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-disabled');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-disabled', projDir, {
        auditor: {
          engine: 'codex_app_server',
          thread_id: 'thr_disabled_888',
          cwd: projDir,
          enabled: false,
          model_policy: 'auditor_standard'
        }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-disabled',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-001',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
      console.log('PASS: ATL-004 — Bound but disabled project fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-005: Existing active bootstrap in progress fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-active');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-active', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-active',
        operation_id: 'op-prior',
        audit_subject_id: 'sub-prior',
        thread_id: 'thr-prior',
        workspace_state_observed: 'ws-prior'
      });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-active',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-001',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS);
      console.log('PASS: ATL-005 — Existing active bootstrap in progress fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-006: Missing or invalid arguments rejected
  {
    let caught = null;
    try {
      await bootstrapAuditorThread(null);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

    caught = null;
    try {
      await bootstrapAuditorThread({ projectId: '' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

    console.log('PASS: ATL-006 — Missing or invalid arguments rejected');
  }

  // ATL-007: Thread start failure leaves no bootstrap record
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-fail-start');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-fail-start', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const failingFactory = createAdapterFactory({ scenario: 'exit_pre_init' });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-fail-start',
          registryPort,
          recoveryStore,
          adapterFactory: failingFactory,
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-fail-start',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PROVISIONAL_FAILED);

      const active = recoveryStore.getActiveBootstrap('proj-fail-start');
      assert.strictEqual(active, null);

      console.log('PASS: ATL-007 — Thread start failure leaves no bootstrap record');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-008: Turn start failure marks state AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-fail-turn-start');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-fail-turn-start', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // Mock adapter whose startTurn throws
      const failingAdapterFactory = async () => {
        const client = new CodexAppServerClient({
          codexBinary: process.execPath,
          args: [FAKE_APP_SERVER_PATH, '--scenario=default']
        });
        const adapter = new CodexAuditorAdapter({ client });
        adapter.startTurn = async () => {
          throw new Error('Synthetic network timeout during startTurn');
        };
        return adapter;
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-fail-turn-start',
          registryPort,
          recoveryStore,
          adapterFactory: failingAdapterFactory,
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-fail-turn-start',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_UNCERTAIN);

      const active = recoveryStore.getActiveBootstrap('proj-fail-turn-start');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-008 — Turn start failure marks state AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-009: Decision validation failure marks state AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-fail-decision');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-fail-decision', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // Scenario audit_decision_commentary_only produces no valid final decision
      const failingFactory = createAdapterFactory({ scenario: 'audit_decision_commentary_only' });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-fail-decision',
          registryPort,
          recoveryStore,
          adapterFactory: failingFactory,
          turnTimeoutMs: 3000,
          workspacePort: createMockWorkspacePort(),
          auditSubjectId: 'sub-fail-decision',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_FIRST_TURN_FAILED);

      const active = recoveryStore.getActiveBootstrap('proj-fail-decision');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-009 — Decision validation failure marks state AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-010: Second process resume failure halts lifecycle before Registry bind
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-fail-resume');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-fail-resume', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let callCount = 0;
      const splitFactory = async ({ phase }) => {
        callCount++;
        if (callCount === 1) {
          // Client 1 succeeds with decision
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [
              FAKE_APP_SERVER_PATH,
              '--scenario=audit_decision',
              '--decision-project-id=proj-fail-resume',
              '--decision-subject-id=sub-01',
              '--decision-workspace-state=ws-01'
            ]
          });
          return new CodexAuditorAdapter({ client });
        } else {
          // Client 2 fails thread/resume
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [FAKE_APP_SERVER_PATH, '--scenario=default']
          });
          const adapter = new CodexAuditorAdapter({ client });
          adapter.resumeThread = async () => {
            throw new Error('Synthetic rejection during thread/resume');
          };
          return adapter;
        }
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-fail-resume',
          registryPort,
          recoveryStore,
          adapterFactory: splitFactory,
          workspacePort: createMockWorkspacePort('ws-01'),
          auditSubjectId: 'sub-01',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED);

      // Registry must remain UNBOUND
      const proj = await registryPort.getProject('proj-fail-resume');
      assert.strictEqual(proj.auditor.thread_id, null);
      assert.strictEqual(proj.auditor.enabled, false);

      // Recovery store preserves DECISION_VALIDATED or RESUME_VERIFYING
      const active = recoveryStore.getActiveBootstrap('proj-fail-resume');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING);

      console.log('PASS: ATL-010 — Second process resume failure halts lifecycle before Registry bind');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-011: Cross-process thread ID mismatch halts lifecycle before Registry bind
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-mismatch-resume');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-mismatch-resume', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let callCount = 0;
      const splitFactory = async () => {
        callCount++;
        if (callCount === 1) {
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [
              FAKE_APP_SERVER_PATH,
              '--scenario=audit_decision',
              '--decision-project-id=proj-mismatch-resume',
              '--decision-subject-id=sub-01',
              '--decision-workspace-state=ws-01'
            ]
          });
          return new CodexAuditorAdapter({ client });
        } else {
          // Client 2 returns wrong thread id on resume
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [FAKE_APP_SERVER_PATH, '--scenario=resume_thread_mismatch']
          });
          return new CodexAuditorAdapter({ client });
        }
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-mismatch-resume',
          registryPort,
          recoveryStore,
          adapterFactory: splitFactory,
          workspacePort: createMockWorkspacePort('ws-01'),
          auditSubjectId: 'sub-01',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED);

      // Registry remains UNBOUND
      const proj = await registryPort.getProject('proj-mismatch-resume');
      assert.strictEqual(proj.auditor.thread_id, null);

      console.log('PASS: ATL-011 — Cross-process thread ID mismatch halts lifecycle before Registry bind');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-012: Registry binding conflict halts lifecycle
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-reg-conflict');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-reg-conflict', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // Mock registry bindAuditorThread to throw conflict
      const conflictingRegistry = {
        getProject: (id) => registryPort.getProject(id),
        bindAuditorThread: async () => {
          throw new Error('Conflicting thread bound');
        }
      };

      const factory = createAdapterFactory({
        scenario: 'audit_decision',
        extraArgs: [
          '--decision-project-id=proj-reg-conflict',
          '--decision-subject-id=sub-01',
          '--decision-workspace-state=ws-01'
        ]
      });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-reg-conflict',
          registryPort: conflictingRegistry,
          recoveryStore,
          adapterFactory: factory,
          workspacePort: createMockWorkspacePort('ws-01'),
          auditSubjectId: 'sub-01',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED);

      console.log('PASS: ATL-012 — Registry binding conflict halts lifecycle');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-013: Lazy rollout emulation proof: zero-turn thread resume fails, post-turn resume succeeds
  {
    const sandbox = createTestSandbox();
    try {
      const durabilityFile = path.join(sandbox.dir, 'lazy-rollout.state');

      // Client 1 starts thread
      const client1 = new CodexAppServerClient({
        codexBinary: process.execPath,
        args: [FAKE_APP_SERVER_PATH, `--durability-state-file=${durabilityFile}`]
      });
      const adapter1 = new CodexAuditorAdapter({ client: client1 });
      await adapter1.initialize();

      const startRes = await adapter1.startThread({ cwd: sandbox.dir, sandbox: 'read-only' });
      const thrId = startRes.threadId;

      // Client 2 attempts resume BEFORE any turn: must FAIL with provider error code -32600
      const client2 = new CodexAppServerClient({
        codexBinary: process.execPath,
        args: [FAKE_APP_SERVER_PATH, `--durability-state-file=${durabilityFile}`]
      });
      const adapter2 = new CodexAuditorAdapter({ client: client2 });
      await adapter2.initialize();

      let caught = null;
      try {
        await adapter2.resumeThread({ threadId: thrId });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, 'Zero-turn resume should fail');
      await adapter2.close();

      // Client 1 runs turn/start
      await adapter1.startTurn({
        threadId: thrId,
        input: [{ type: 'text', text: 'Initialize' }]
      });

      // Now Client 3 attempts resume AFTER turn: must SUCCEED
      const client3 = new CodexAppServerClient({
        codexBinary: process.execPath,
        args: [FAKE_APP_SERVER_PATH, `--durability-state-file=${durabilityFile}`]
      });
      const adapter3 = new CodexAuditorAdapter({ client: client3 });
      await adapter3.initialize();

      const resumeRes = await adapter3.resumeThread({ threadId: thrId });
      assert.strictEqual(resumeRes.threadId, thrId);

      await adapter1.close();
      await adapter3.close();

      console.log('PASS: ATL-013 — Lazy rollout emulation: zero-turn resume rejected, post-turn resume accepted');
    } finally {
      sandbox.cleanup();
    }
  }

  // ATL-014: Authority domain separation: Registry remains completely unbound until final bind
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-iso');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-iso', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // Before bootstrap
      const pInit = await registryPort.getProject('proj-iso');
      assert.strictEqual(pInit.auditor.thread_id, null);
      assert.strictEqual(pInit.auditor.enabled, false);

      // Create provisional record in recovery store
      recoveryStore.beginBootstrap({
        project_id: 'proj-iso',
        operation_id: 'op-iso',
        audit_subject_id: 'sub-iso',
        thread_id: 'thr-iso',
        workspace_state_observed: 'ws-iso'
      });

      // Registry still has zero authority
      const pAfterProvisional = await registryPort.getProject('proj-iso');
      assert.strictEqual(pAfterProvisional.auditor.thread_id, null);

      // Advance to DECISION_VALIDATED
      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-iso',
        audit_subject_id: 'sub-iso',
        auditor_thread_id: 'thr-iso',
        workspace_state_observed: 'ws-iso',
        summary: 'Isolation verified',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({
        project_id: 'proj-iso',
        operation_id: 'op-iso',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-iso',
        operation_id: 'op-iso',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: {
          turn_id: 'turn-iso'
        }
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-iso',
        operation_id: 'op-iso',
        next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        patch: {
          decision_json: decJson,
          decision_sha256: decHash
        }
      });

      // Registry STILL has zero authority
      const pAfterDecision = await registryPort.getProject('proj-iso');
      assert.strictEqual(pAfterDecision.auditor.thread_id, null);

      console.log('PASS: ATL-014 — Authority domain separation: Registry remains unbound across earlier states');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-015: recoverAuditorBootstrap on clean project returns NO_ACTIVE_BOOTSTRAP
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-clean',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'NO_ACTIVE_BOOTSTRAP');

      console.log('PASS: ATL-015 — recoverAuditorBootstrap on clean project returns NO_ACTIVE_BOOTSTRAP');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-016: Recovery from PROVISIONAL_THREAD cleans active record without Registry mutation
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-prov');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-prov', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-rec-prov',
        operation_id: 'op-prov',
        audit_subject_id: 'sub-prov',
        thread_id: 'thr-prov',
        workspace_state_observed: 'ws-prov'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-prov',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'RECOVERED_CLEARED');
      assert.strictEqual(res.previous_state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      // Active row deleted
      const active = recoveryStore.getActiveBootstrap('proj-rec-prov');
      assert.strictEqual(active, null);

      // Registry still unbound
      const proj = await registryPort.getProject('proj-rec-prov');
      assert.strictEqual(proj.auditor.thread_id, null);

      console.log('PASS: ATL-016 — Recovery from PROVISIONAL_THREAD cleans active record');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-017: Recovery from FIRST_TURN_STARTING preserves AUDIT_UNCERTAIN without auto-resend
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-start');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-start', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-rec-start',
        operation_id: 'op-start',
        audit_subject_id: 'sub-start',
        thread_id: 'thr-start',
        workspace_state_observed: 'ws-start'
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-rec-start',
        operation_id: 'op-start',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });

      let turnStartCalled = false;
      const trackingFactory = async () => {
        const client = new CodexAppServerClient({
          codexBinary: process.execPath,
          args: [FAKE_APP_SERVER_PATH, '--scenario=default']
        });
        const adapter = new CodexAuditorAdapter({ client });
        adapter.startTurn = async () => {
          turnStartCalled = true;
          throw new Error('Should not be called!');
        };
        return adapter;
      };

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-start',
        registryPort,
        recoveryStore,
        adapterFactory: trackingFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 'AUDIT_UNCERTAIN');
      assert.strictEqual(turnStartCalled, false);

      const active = recoveryStore.getActiveBootstrap('proj-rec-start');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-017 — Recovery from FIRST_TURN_STARTING preserves AUDIT_UNCERTAIN without auto-resend');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-018: Recovery from FIRST_TURN_IN_FLIGHT preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-flight');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-flight', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-rec-flight',
        operation_id: 'op-flight',
        audit_subject_id: 'sub-flight',
        thread_id: 'thr-flight',
        workspace_state_observed: 'ws-flight'
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-rec-flight',
        operation_id: 'op-flight',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-rec-flight',
        operation_id: 'op-flight',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        patch: {
          turn_id: 'turn-flight-1'
        }
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-flight',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 'AUDIT_UNCERTAIN');

      const active = recoveryStore.getActiveBootstrap('proj-rec-flight');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-018 — Recovery from FIRST_TURN_IN_FLIGHT preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-019: Recovery from AUDIT_UNCERTAIN remains AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-unc');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-unc', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-rec-unc',
        operation_id: 'op-unc',
        audit_subject_id: 'sub-unc',
        thread_id: 'thr-unc',
        workspace_state_observed: 'ws-unc'
      });
      recoveryStore.transitionBootstrap({
        project_id: 'proj-rec-unc',
        operation_id: 'op-unc',
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-unc',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, 'AUDIT_UNCERTAIN');

      console.log('PASS: ATL-019 — Recovery from AUDIT_UNCERTAIN remains AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-020: Recovery from DECISION_VALIDATED verifies resume and completes DURABLE_BOUND
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-dec');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-dec', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-dec',
        operationId: 'op-dec',
        targetState: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        subjectId: 'sub-dec',
        wsState: 'ws-dec'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-dec',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({ scenario: 'default' })
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');
      assert.strictEqual(res.thread_id, 'thr_fake_001');

      // Active bootstrap deleted
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-rec-dec'), null);

      // Registry bound
      const proj = await registryPort.getProject('proj-rec-dec');
      assert.strictEqual(proj.auditor.thread_id, 'thr_fake_001');
      assert.strictEqual(proj.auditor.enabled, true);

      console.log('PASS: ATL-020 — Recovery from DECISION_VALIDATED verifies resume and completes DURABLE_BOUND');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-021: Recovery from RESUME_VERIFYING retries resume and completes DURABLE_BOUND
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-res-ver');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-res-ver', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-res-ver',
        operationId: 'op-res-ver',
        targetState: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING,
        subjectId: 'sub-rv',
        wsState: 'ws-rv'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-res-ver',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({ scenario: 'default' })
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');

      const proj = await registryPort.getProject('proj-rec-res-ver');
      assert.strictEqual(proj.auditor.thread_id, 'thr_fake_001');

      console.log('PASS: ATL-021 — Recovery from RESUME_VERIFYING retries resume and completes DURABLE_BOUND');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-022: Recovery from RESUME_VERIFIED proceeds to Registry bind
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-res-ok');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-res-ok', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-res-ok',
        operationId: 'op-res-ok',
        targetState: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED,
        subjectId: 'sub-ro',
        wsState: 'ws-ro'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-res-ok',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');

      console.log('PASS: ATL-022 — Recovery from RESUME_VERIFIED proceeds to Registry bind');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-023: Recovery from REGISTRY_BINDING where Registry was already updated
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-already-bound');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      // Registry was already bound to thr_fake_001 before crash
      await registryPort.putProject(makeValidProject('proj-rec-already-bound', projDir, {
        auditor: {
          engine: 'codex_app_server',
          thread_id: 'thr_fake_001',
          cwd: projDir,
          enabled: true,
          model_policy: 'auditor_standard'
        }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-already-bound',
        operationId: 'op-already-bound',
        targetState: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING,
        subjectId: 'sub-ab',
        wsState: 'ws-ab'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-already-bound',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');
      assert.strictEqual(res.reconciled, true);
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-rec-already-bound'), null);

      console.log('PASS: ATL-023 — Recovery from REGISTRY_BINDING reconciles cleanly when already bound');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-024: Recovery from REGISTRY_BINDING where Registry is unbound binds atomically
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-unbound-bind');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-unbound-bind', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-unbound-bind',
        operationId: 'op-unbound-bind',
        targetState: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING,
        subjectId: 'sub-ub',
        wsState: 'ws-ub'
      });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-rec-unbound-bind',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory()
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');

      const proj = await registryPort.getProject('proj-rec-unbound-bind');
      assert.strictEqual(proj.auditor.thread_id, 'thr_fake_001');
      assert.strictEqual(proj.auditor.enabled, true);

      console.log('PASS: ATL-024 — Recovery from REGISTRY_BINDING where Registry is unbound binds atomically');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-025: inspectAuditorBootstrap reports full state and history
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-inspect');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-inspect', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // Before bootstrap
      let inspection = await inspectAuditorBootstrap({
        projectId: 'proj-inspect',
        recoveryStore,
        registryPort
      });
      assert.strictEqual(inspection.active_bootstrap, null);
      assert.strictEqual(inspection.history.length, 0);
      assert.strictEqual(inspection.registry_binding_state, 'AUDITOR_REGISTRATION_REQUIRED');

      // During bootstrap (PROVISIONAL_THREAD)
      recoveryStore.beginBootstrap({
        project_id: 'proj-inspect',
        operation_id: 'op-insp',
        audit_subject_id: 'sub-insp',
        thread_id: 'thr-insp',
        workspace_state_observed: 'ws-insp'
      });

      inspection = await inspectAuditorBootstrap({
        projectId: 'proj-inspect',
        recoveryStore,
        registryPort
      });
      assert.ok(inspection.active_bootstrap);
      assert.strictEqual(inspection.active_bootstrap.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      assert.strictEqual(inspection.history.length, 1);
      assert.strictEqual(inspection.registry_binding_state, 'AUDITOR_REGISTRATION_REQUIRED');

      console.log('PASS: ATL-025 — inspectAuditorBootstrap reports full state and history');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-026: inspectAuditorBootstrap rejects invalid request
  {
    let caught = null;
    try {
      await inspectAuditorBootstrap(null);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

    console.log('PASS: ATL-026 — inspectAuditorBootstrap rejects invalid request');
  }

  // ATL-027: Multiple distinct projects can bootstrap independently
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDirA = path.join(sandbox.dir, 'proj-multi-a');
      const projDirB = path.join(sandbox.dir, 'proj-multi-b');
      fs.mkdirSync(projDirA, { recursive: true });
      fs.mkdirSync(projDirB, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-multi-a', projDirA));
      await registryPort.putProject(makeValidProject('proj-multi-b', projDirB));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const resA = await bootstrapAuditorThread({
        projectId: 'proj-multi-a',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-multi-a',
            '--decision-subject-id=sub-a',
            '--decision-workspace-state=ws-a'
          ]
        }),
        workspacePort: createMockWorkspacePort('ws-a'),
        auditSubjectId: 'sub-a',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      const resB = await bootstrapAuditorThread({
        projectId: 'proj-multi-b',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-multi-b',
            '--decision-subject-id=sub-b',
            '--decision-workspace-state=ws-b'
          ]
        }),
        workspacePort: createMockWorkspacePort('ws-b'),
        auditSubjectId: 'sub-b',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(resA.ok, true);
      assert.strictEqual(resB.ok, true);

      const pA = await registryPort.getProject('proj-multi-a');
      const pB = await registryPort.getProject('proj-multi-b');
      assert.strictEqual(pA.auditor.enabled, true);
      assert.strictEqual(pB.auditor.enabled, true);

      console.log('PASS: ATL-027 — Multiple distinct projects can bootstrap independently');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-028: Concurrent bootstrap calls on same project reject second call
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-race');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-race', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const factory = createAdapterFactory({
        scenario: 'audit_decision',
        extraArgs: [
          '--decision-project-id=proj-race',
          '--decision-subject-id=sub-race',
          '--decision-workspace-state=ws-race'
        ]
      });

      const wsPort = createMockWorkspacePort('ws-race');
      const p1 = bootstrapAuditorThread({
        projectId: 'proj-race',
        registryPort,
        recoveryStore,
        adapterFactory: factory,
        workspacePort: wsPort,
        auditSubjectId: 'sub-race',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      const p2 = bootstrapAuditorThread({
        projectId: 'proj-race',
        registryPort,
        recoveryStore,
        adapterFactory: factory,
        workspacePort: wsPort,
        auditSubjectId: 'sub-race',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      const results = await Promise.allSettled([p1, p2]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.strictEqual(fulfilled.length, 1);
      assert.strictEqual(rejected.length, 1);
      assert.strictEqual(rejected[0].reason.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS);

      console.log('PASS: ATL-028 — Concurrent bootstrap calls on same project reject second call');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-029: Custom decision types accepted and persisted
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-stop-decision');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-stop-decision', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const result = await bootstrapAuditorThread({
        projectId: 'proj-stop-decision',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-stop-decision',
            '--decision-subject-id=sub-stop',
            '--decision-workspace-state=ws-stop',
            '--decision-type=STOP'
          ]
        }),
        workspacePort: createMockWorkspacePort('ws-stop'),
        auditSubjectId: 'sub-stop',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.decision.decision, AUDIT_DECISIONS.STOP);

      console.log('PASS: ATL-029 — Custom decision types accepted and persisted');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-030: Reopening recovery DB verifies persisted semantic states
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      recoveryStore.beginBootstrap({
        project_id: 'proj-sem-test',
        operation_id: 'op-sem',
        audit_subject_id: 'sub-sem',
        thread_id: 'thr-sem',
        workspace_state_observed: 'ws-sem'
      });

      recoveryStore.close();
      recoveryStore = null;

      // Reopen
      const reopened = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      const record = reopened.getActiveBootstrap('proj-sem-test');
      assert.ok(record);
      assert.strictEqual(record.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);
      reopened.close();

      console.log('PASS: ATL-030 — Reopening recovery DB verifies persisted semantic states');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-031: Custom turnPrompt forwarded to startTurn
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-prompt');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-prompt', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let receivedPrompt = null;
      const trackingFactory = async () => {
        const client = new CodexAppServerClient({
          codexBinary: process.execPath,
          args: [
            FAKE_APP_SERVER_PATH,
            '--scenario=audit_decision',
            '--decision-project-id=proj-prompt',
            '--decision-subject-id=sub-pr',
            '--decision-workspace-state=ws-pr'
          ]
        });
        const adapter = new CodexAuditorAdapter({ client });
        const origStartTurn = adapter.startTurn.bind(adapter);
        adapter.startTurn = async (params) => {
          receivedPrompt = params.input;
          return origStartTurn(params);
        };
        return adapter;
      };

      const customPrompt = [{ type: 'text', text: 'Custom audit directive 12345' }];
      await bootstrapAuditorThread({
        projectId: 'proj-prompt',
        registryPort,
        recoveryStore,
        adapterFactory: trackingFactory,
        workspacePort: createMockWorkspacePort('ws-pr'),
        auditSubjectId: 'sub-pr',
        auditPrompt: customPrompt
      });

      assert.deepStrictEqual(receivedPrompt, customPrompt);

      console.log('PASS: ATL-031 — Custom turnPrompt forwarded to startTurn');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-032: Operation ID bounds validation in bootstrapAuditorThread
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-op-bounds');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-op-bounds', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-op-bounds',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort('ws-op'),
          auditSubjectId: 'sub-op',
          auditPrompt: DEFAULT_AUDIT_PROMPT,
          operationId: 'a'.repeat(129) // exceeds 128 bytes
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_INVALID_REQUEST);

      console.log('PASS: ATL-032 — Operation ID bounds validation in bootstrapAuditorThread');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-033: Workspace state observed failure in workspacePort fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-fail');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-fail', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const failingWsPort = {
        getWorkspaceState: async () => ({
          workspace_state_id: '',
          project_id: 'proj-ws-fail',
          project_root: projDir
        })
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-fail',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: failingWsPort,
          auditSubjectId: 'sub-ws-fail',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-033 — Workspace state observed failure in workspacePort fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-034: Client 1 close failure does not abort decision persistence
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-close-fail');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-close-fail', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let callCount = 0;
      const closeFailingFactory = async () => {
        callCount++;
        const client = new CodexAppServerClient({
          codexBinary: process.execPath,
          args: [
            FAKE_APP_SERVER_PATH,
            '--scenario=audit_decision',
            '--decision-project-id=proj-close-fail',
            '--decision-subject-id=sub-cf',
            '--decision-workspace-state=ws-cf'
          ]
        });
        const adapter = new CodexAuditorAdapter({ client });
        if (callCount === 1) {
          adapter.close = async () => {
            throw new Error('Synthetic error closing client 1');
          };
        }
        return adapter;
      };

      const result = await bootstrapAuditorThread({
        projectId: 'proj-close-fail',
        registryPort,
        recoveryStore,
        adapterFactory: closeFailingFactory,
        workspacePort: createMockWorkspacePort('ws-cf'),
        auditSubjectId: 'sub-cf',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'DURABLE_BOUND');

      console.log('PASS: ATL-034 — Client 1 close failure does not abort decision persistence');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-035: Deleted project during in-flight bootstrap fails closed on Registry bind
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-del-during');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-del-during', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let callCount = 0;
      const interceptFactory = async () => {
        callCount++;
        if (callCount === 1) {
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [
              FAKE_APP_SERVER_PATH,
              '--scenario=audit_decision',
              '--decision-project-id=proj-del-during',
              '--decision-subject-id=sub-dd',
              '--decision-workspace-state=ws-dd'
            ]
          });
          return new CodexAuditorAdapter({ client });
        } else {
          // Delete project from registry before client 2 finishes
          await registryPort.removeProject('proj-del-during');
          const client = new CodexAppServerClient({
            codexBinary: process.execPath,
            args: [FAKE_APP_SERVER_PATH, '--scenario=default']
          });
          return new CodexAuditorAdapter({ client });
        }
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-del-during',
          registryPort,
          recoveryStore,
          adapterFactory: interceptFactory,
          workspacePort: createMockWorkspacePort('ws-dd'),
          auditSubjectId: 'sub-dd',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED);

      console.log('PASS: ATL-035 — Deleted project during in-flight bootstrap fails closed on Registry bind');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-036: Temporary sandbox isolation verified
  {
    const sandbox = createTestSandbox();
    const defaultHome = os.homedir();
    const realProjectsPath = path.join(defaultHome, '.orchestrator', 'projects.json');

    // Confirm real user projects.json is NOT modified
    let realMtimeBefore = null;
    if (fs.existsSync(realProjectsPath)) {
      realMtimeBefore = fs.statSync(realProjectsPath).mtimeMs;
    }

    const regFile = path.join(sandbox.dir, 'projects.json');
    const projDir = path.join(sandbox.dir, 'proj-iso-check');
    fs.mkdirSync(projDir, { recursive: true });

    const registry = createProjectRegistry({ registryFilePath: regFile });
    await registry.putProject(makeValidProject('proj-iso-check', projDir));

    if (fs.existsSync(realProjectsPath)) {
      const realMtimeAfter = fs.statSync(realProjectsPath).mtimeMs;
      assert.strictEqual(realMtimeBefore, realMtimeAfter);
    }

    sandbox.cleanup();
    console.log('PASS: ATL-036 — Temporary sandbox isolation: real user files untouched');
  }

  // ATL-037: Full trace sequential state machine integrity
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-trace');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-trace', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      await bootstrapAuditorThread({
        projectId: 'proj-trace',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-trace',
            '--decision-subject-id=sub-tr',
            '--decision-workspace-state=ws-tr'
          ]
        }),
        workspacePort: createMockWorkspacePort('ws-tr'),
        auditSubjectId: 'sub-tr',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      const history = recoveryStore.getBootstrapHistory('proj-trace');
      const expectedSequence = [
        AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD,
        AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING,
        AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
        AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING,
        AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED,
        AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
      ];

      assert.strictEqual(history.length, expectedSequence.length);
      for (let i = 0; i < expectedSequence.length; i++) {
        assert.strictEqual(history[i].next_state, expectedSequence[i]);
      }

      console.log('PASS: ATL-037 — Full trace sequential state machine integrity');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-038: Custom clock integration in recovery store persists consistent timestamps
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      let simulatedTime = 1700000000000;
      const customClock = {
        now: () => simulatedTime,
        iso: () => new Date(simulatedTime).toISOString()
      };

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile, clock: customClock });

      recoveryStore.beginBootstrap({
        project_id: 'proj-clock',
        operation_id: 'op-clock',
        audit_subject_id: 'sub-clock',
        thread_id: 'thr-clock',
        workspace_state_observed: 'ws-clock'
      });

      const active = recoveryStore.getActiveBootstrap('proj-clock');
      assert.strictEqual(active.created_at, new Date(1700000000000).toISOString());

      simulatedTime += 5000;
      recoveryStore.transitionBootstrap({
        project_id: 'proj-clock',
        operation_id: 'op-clock',
        next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
      });

      const history = recoveryStore.getBootstrapHistory('proj-clock');
      assert.strictEqual(history[1].timestamp, 1700000005000);

      console.log('PASS: ATL-038 — Custom clock integration in recovery store persists consistent timestamps');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-039: Validated decision immutability: returned object cannot mutate store
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-mut');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-mut', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const res = await bootstrapAuditorThread({
        projectId: 'proj-mut',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-mut',
            '--decision-subject-id=sub-mut',
            '--decision-workspace-state=ws-mut'
          ]
        }),
        workspacePort: createMockWorkspacePort('ws-mut'),
        auditSubjectId: 'sub-mut',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      // Attempt mutating returned decision
      assert.throws(() => {
        res.decision.summary = 'HACKED SUMMARY';
      }, /TypeError/);

      console.log('PASS: ATL-039 — Validated decision immutability: returned object is frozen');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-040: Oversized turn timeout configuration honored
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-timeout');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-timeout', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let passedTimeout = null;
      const customAwait = async (adapter, opts) => {
        passedTimeout = opts.timeoutMs;
        return awaitAuditDecisionV1(adapter, opts);
      };

      await bootstrapAuditorThread({
        projectId: 'proj-timeout',
        registryPort,
        recoveryStore,
        adapterFactory: createAdapterFactory({
          scenario: 'audit_decision',
          extraArgs: [
            '--decision-project-id=proj-timeout',
            '--decision-subject-id=sub-to',
            '--decision-workspace-state=ws-to'
          ]
        }),
        awaitAuditDecision: customAwait,
        workspacePort: createMockWorkspacePort('ws-to'),
        auditSubjectId: 'sub-to',
        auditPrompt: DEFAULT_AUDIT_PROMPT,
        turnTimeoutMs: 12345
      });

      assert.strictEqual(passedTimeout, 12345);

      console.log('PASS: ATL-040 — Custom turn timeout configuration honored');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-041: inspectAuditorBootstrap on unknown project returns PROJECT_NOT_FOUND state
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const inspection = await inspectAuditorBootstrap({
        projectId: 'proj-ghost',
        recoveryStore,
        registryPort
      });

      assert.strictEqual(inspection.active_bootstrap, null);
      assert.strictEqual(inspection.registry_binding_state, 'PROJECT_NOT_FOUND');
      assert.strictEqual(inspection.registry_project, null);

      console.log('PASS: ATL-041 — inspectAuditorBootstrap on unknown project returns PROJECT_NOT_FOUND state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-042: recoverAuditorBootstrap with missing options object throws AUDITOR_LIFECYCLE_INVALID_REQUEST
  {
    let caught = null;
    try {
      await recoverAuditorBootstrap(null);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

    console.log('PASS: ATL-042 — recoverAuditorBootstrap with missing options throws AUDITOR_LIFECYCLE_INVALID_REQUEST');
  }

  // ATL-043: recoverAuditorBootstrap with empty projectId throws AUDITOR_LIFECYCLE_INVALID_REQUEST
  {
    let caught = null;
    try {
      await recoverAuditorBootstrap({ projectId: '   ' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

    console.log('PASS: ATL-043 — recoverAuditorBootstrap with empty projectId throws AUDITOR_LIFECYCLE_INVALID_REQUEST');
  }

  // ATL-044: inspectAuditorBootstrap without registryPort safely defaults
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const inspection = await inspectAuditorBootstrap({
        projectId: 'proj-no-reg',
        recoveryStore
      });

      assert.strictEqual(inspection.project_id, 'proj-no-reg');
      assert.strictEqual(inspection.registry_binding_state, 'UNKNOWN');
      assert.strictEqual(inspection.registry_project, null);

      console.log('PASS: ATL-044 — inspectAuditorBootstrap without registryPort safely defaults');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-045: recoverAuditorBootstrap in RESUME_VERIFYING when resume fails throws AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-res-fail');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-res-fail', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-res-fail',
        operationId: 'op-res-fail',
        targetState: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING,
        subjectId: 'sub-rf',
        wsState: 'ws-rf'
      });

      const failingFactory = async () => {
        const client = new CodexAppServerClient({
          codexBinary: process.execPath,
          args: [FAKE_APP_SERVER_PATH, '--scenario=default']
        });
        const adapter = new CodexAuditorAdapter({ client });
        adapter.resumeThread = async () => {
          throw new Error('Synthetic network outage on resume');
        };
        return adapter;
      };

      let caught = null;
      try {
        await recoverAuditorBootstrap({
          projectId: 'proj-rec-res-fail',
          registryPort,
          recoveryStore,
          adapterFactory: failingFactory
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED);

      // State remains in RESUME_VERIFYING
      const active = recoveryStore.getActiveBootstrap('proj-rec-res-fail');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING);

      console.log('PASS: ATL-045 — recoverAuditorBootstrap in RESUME_VERIFYING when resume fails throws fail-closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-046: Real createWorkspaceStatePort integration against isolated temporary Git repository (Section 17)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const gitRepoDir = path.join(sandbox.dir, 'git-repo-real');
      fs.mkdirSync(gitRepoDir, { recursive: true });

      initGitRepo(gitRepoDir);
      commitFile(gitRepoDir, 'README.md', '# Real Git Repo for Auditor Durability\n');

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-real-git', gitRepoDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const realWorkspacePort = createWorkspaceStatePort();
      const projectRecord = await registryPort.getProject('proj-real-git');
      const expectedWsSnapshot = await realWorkspacePort.getWorkspaceState(projectRecord);

      assert.ok(expectedWsSnapshot.workspace_state_id);
      assert.strictEqual(expectedWsSnapshot.project_id, 'proj-real-git');

      const adapterFactory = createAdapterFactory({
        scenario: 'audit_decision',
        extraArgs: [
          '--decision-project-id=proj-real-git',
          '--decision-subject-id=sub-real-git',
          `--decision-workspace-state=${expectedWsSnapshot.workspace_state_id}`
        ]
      });

      const result = await bootstrapAuditorThread({
        projectId: 'proj-real-git',
        registryPort,
        recoveryStore,
        adapterFactory,
        workspacePort: realWorkspacePort,
        auditSubjectId: 'sub-real-git',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'DURABLE_BOUND');
      assert.strictEqual(result.decision.workspace_state_observed, expectedWsSnapshot.workspace_state_id);

      console.log('PASS: ATL-046 — Real createWorkspaceStatePort integration against isolated temporary Git repository');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-047: Crash recovery authority: lifecycle interrupted after DECISION_VALIDATED preserves authority and recovers (Section 26)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-crash-rec');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-crash-rec', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      const adapterFactory = createAdapterFactory({
        scenario: 'audit_decision',
        extraArgs: [
          '--decision-project-id=proj-crash-rec',
          '--decision-subject-id=sub-crash',
          '--decision-workspace-state=ws-crash'
        ]
      });

      const origTransition = recoveryStore.transitionBootstrap.bind(recoveryStore);
      recoveryStore.transitionBootstrap = (params) => {
        const ret = origTransition(params);
        if (params.next_state === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED) {
          throw new Error('SIMULATED_CRASH_AFTER_DECISION_VALIDATED');
        }
        return ret;
      };

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-crash-rec',
          registryPort,
          recoveryStore,
          adapterFactory,
          workspacePort: createMockWorkspacePort('ws-crash'),
          auditSubjectId: 'sub-crash',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.message, 'SIMULATED_CRASH_AFTER_DECISION_VALIDATED');

      // Close store and reopen from disk
      recoveryStore.close();
      recoveryStore = null;

      const reopenedStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      const record = reopenedStore.getActiveBootstrap('proj-crash-rec');

      // Verify exact authority fields persisted by production lifecycle calls
      assert.strictEqual(record.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.ok(record.turn_id, 'turn_id must be non-null');
      assert.ok(record.decision_json, 'decision_json must be non-null');
      assert.ok(record.decision_sha256, 'decision_sha256 must be non-null');
      assert.ok(record.validated_decision, 'validated_decision must be non-null');

      const expectedSha256 = crypto.createHash('sha256').update(record.decision_json, 'utf8').digest('hex');
      assert.strictEqual(record.decision_sha256, expectedSha256);

      // Now recover through exact resume
      const recoverResult = await recoverAuditorBootstrap({
        projectId: 'proj-crash-rec',
        registryPort,
        recoveryStore: reopenedStore,
        adapterFactory: createAdapterFactory({
          scenario: 'default'
        })
      });

      assert.strictEqual(recoverResult.ok, true);
      assert.strictEqual(recoverResult.status, 'DURABLE_BOUND');
      assert.strictEqual(recoverResult.thread_id, record.thread_id);
      assert.strictEqual(recoverResult.decision.project_id, 'proj-crash-rec');

      reopenedStore.close();
      console.log('PASS: ATL-047 — Crash recovery authority: interrupted after DECISION_VALIDATED recovers authority');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-048: Missing workspacePort rejected before thread start (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg1');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg1', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg1',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          auditSubjectId: 'sub-ws-neg1',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

      console.log('PASS: ATL-048 — Missing workspacePort rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-049: workspacePort returning string rejected before thread start (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg2');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg2', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg2',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: { getWorkspaceState: async () => 'ws-legacy-string' },
          auditSubjectId: 'sub-ws-neg2',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-049 — workspacePort returning string rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-050: workspacePort returning null rejected (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg3');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg3', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg3',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: { getWorkspaceState: async () => null },
          auditSubjectId: 'sub-ws-neg3',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-050 — workspacePort returning null rejected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-051: workspacePort returning wrong project_id rejected (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg4');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg4', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg4',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: {
            getWorkspaceState: async () => ({
              workspace_state_id: 'ws-valid',
              project_id: 'wrong-proj-id',
              project_root: projDir
            })
          },
          auditSubjectId: 'sub-ws-neg4',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-051 — workspacePort returning wrong project_id rejected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-052: workspacePort returning wrong project_root rejected (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg5');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg5', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg5',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: {
            getWorkspaceState: async () => ({
              workspace_state_id: 'ws-valid',
              project_id: 'proj-ws-neg5',
              project_root: path.join(sandbox.dir, 'completely-different-root')
            })
          },
          auditSubjectId: 'sub-ws-neg5',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-052 — workspacePort returning wrong project_root rejected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-053: workspacePort returning missing or empty workspace_state_id rejected (Section 31)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-ws-neg6');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-ws-neg6', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-ws-neg6',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: {
            getWorkspaceState: async () => ({
              workspace_state_id: '   ',
              project_id: 'proj-ws-neg6',
              project_root: projDir
            })
          },
          auditSubjectId: 'sub-ws-neg6',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);

      console.log('PASS: ATL-053 — workspacePort returning whitespace workspace_state_id rejected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-054: Missing auditSubjectId rejected before thread start (Section 32)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-inp-neg1');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-inp-neg1', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-inp-neg1',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort('ws-inp1'),
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

      console.log('PASS: ATL-054 — Missing auditSubjectId rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-055: Empty or whitespace auditSubjectId rejected before thread start (Section 32)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-inp-neg2');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-inp-neg2', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-inp-neg2',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort('ws-inp2'),
          auditSubjectId: '   ',
          auditPrompt: DEFAULT_AUDIT_PROMPT
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

      console.log('PASS: ATL-055 — Empty auditSubjectId rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-056: Missing auditPrompt rejected before thread start (Section 32)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-inp-neg3');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-inp-neg3', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-inp-neg3',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort('ws-inp3'),
          auditSubjectId: 'sub-inp3'
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

      console.log('PASS: ATL-056 — Missing auditPrompt rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-057: Empty auditPrompt array rejected before thread start (Section 32)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-inp-neg4');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-inp-neg4', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      let caught = null;
      try {
        await bootstrapAuditorThread({
          projectId: 'proj-inp-neg4',
          registryPort,
          recoveryStore,
          adapterFactory: createAdapterFactory(),
          workspacePort: createMockWorkspacePort('ws-inp4'),
          auditSubjectId: 'sub-inp4',
          auditPrompt: []
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST);

      console.log('PASS: ATL-057 — Empty auditPrompt array rejected before thread start');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-058: recoverAuditorBootstrap fails closed with AUDITOR_RECOVERY_CORRUPT if state is DECISION_VALIDATED but turn_id is NULL (Section 7, 28)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-corrupt1');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-corrupt1', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-corrupt1',
        operationId: 'op-rec-c1',
        targetState: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        subjectId: 'sub-c1',
        wsState: 'ws-c1'
      });

      // Directly nullify turn_id in the database using raw SQLite connection
      const rawDb = new DatabaseSync(dbFile);
      rawDb.prepare("UPDATE auditor_bootstrap SET turn_id = NULL WHERE project_id = 'proj-rec-corrupt1'").run();
      rawDb.close();

      recoveryStore.close();
      recoveryStore = null;

      // Reopening directly triggers open-time semantic validation failure
      assert.throws(() => {
        createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      }, (err) => {
        assert.strictEqual(err.code, 'AUDITOR_RECOVERY_CORRUPT');
        return true;
      });

      console.log('PASS: ATL-058 — Recovery fails closed with AUDITOR_RECOVERY_CORRUPT if state is DECISION_VALIDATED but turn_id is NULL');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-059: recoverAuditorBootstrap fails closed with AUDITOR_RECOVERY_CORRUPT if state is DECISION_VALIDATED but decision_json is NULL (Section 7, 27)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-corrupt2');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-corrupt2', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-corrupt2',
        operationId: 'op-rec-c2',
        targetState: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        subjectId: 'sub-c2',
        wsState: 'ws-c2'
      });

      // Directly nullify decision_json in the database using raw SQLite connection
      const rawDb = new DatabaseSync(dbFile);
      rawDb.prepare("UPDATE auditor_bootstrap SET decision_json = NULL, decision_sha256 = NULL WHERE project_id = 'proj-rec-corrupt2'").run();
      rawDb.close();

      recoveryStore.close();
      recoveryStore = null;

      // Reopening directly triggers open-time semantic validation failure
      assert.throws(() => {
        createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      }, (err) => {
        assert.strictEqual(err.code, 'AUDITOR_RECOVERY_CORRUPT');
        return true;
      });

      console.log('PASS: ATL-059 — Recovery fails closed with AUDITOR_RECOVERY_CORRUPT if state is DECISION_VALIDATED but decision_json is NULL');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-060: recoverAuditorBootstrap fails closed with AUDITOR_RECOVERY_CORRUPT if decision_sha256 is tampered (Section 7)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-rec-corrupt3');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-rec-corrupt3', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      advanceToState(recoveryStore, {
        projectId: 'proj-rec-corrupt3',
        operationId: 'op-rec-c3',
        targetState: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
        subjectId: 'sub-c3',
        wsState: 'ws-c3'
      });

      // Tamper decision_sha256 in the database using raw SQLite connection
      const rawDb = new DatabaseSync(dbFile);
      rawDb.prepare("UPDATE auditor_bootstrap SET decision_sha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' WHERE project_id = 'proj-rec-corrupt3'").run();
      rawDb.close();

      recoveryStore.close();
      recoveryStore = null;

      // Reopening directly triggers open-time semantic validation failure
      assert.throws(() => {
        createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      }, (err) => {
        assert.strictEqual(err.code, 'AUDITOR_RECOVERY_CORRUPT');
        return true;
      });

      console.log('PASS: ATL-060 — Recovery fails closed with AUDITOR_RECOVERY_CORRUPT if decision_sha256 is tampered');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // Helper for ATL-061 .. ATL-083
  function makeDecisionPayload(ctx = {}) {
    return {
      schema_version: 1,
      decision: 'APPROVE_WORK_PACKAGE',
      project_id: ctx.project_id || 'proj-01',
      audit_subject_id: ctx.audit_subject_id || 'sub-01',
      auditor_thread_id: ctx.auditor_thread_id || 'thr-01',
      workspace_state_observed: ctx.workspace_state_observed || 'ws-01',
      summary: 'Audit passed cleanly.',
      independent_verification: [
        {
          kind: 'SOURCE_INSPECTION',
          result: 'PASS',
          evidence: 'Source and git evidence inspected.'
        }
      ],
      work_order: null,
      requested_evidence: [],
      blocker: null
    };
  }

  function createTrackingAdapterFactory(threadResponse, tracking = {}) {
    tracking.calls = {
      initialize: 0,
      readThread: 0,
      startThread: 0,
      startTurn: 0,
      interruptTurn: 0,
      startReview: 0,
      close: 0
    };
    return async ({ phase, cwd }) => {
      tracking.phase = phase;
      tracking.cwd = cwd;
      return {
        isInitialized: false,
        initialize: async () => { tracking.calls.initialize++; },
        readThread: async (params) => {
          tracking.calls.readThread++;
          if (typeof threadResponse === 'function') {
            return threadResponse(params);
          }
          return threadResponse;
        },
        startThread: async () => { tracking.calls.startThread++; throw new Error('startThread forbidden'); },
        startTurn: async () => { tracking.calls.startTurn++; throw new Error('startTurn forbidden'); },
        interruptTurn: async () => { tracking.calls.interruptTurn++; throw new Error('interruptTurn forbidden'); },
        startReview: async () => { tracking.calls.startReview++; throw new Error('startReview forbidden'); },
        close: async () => { tracking.calls.close++; }
      };
    };
  }

  // ATL-061: AUDIT_UNCERTAIN + exact read thread + exact turn interrupted = AUDIT_TERMINAL_NO_DECISION
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-61');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-61', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-61',
        operation_id: 'op-61',
        audit_subject_id: 'sub-61',
        thread_id: 'thr_61',
        workspace_state_observed: 'ws-61'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-61', operation_id: 'op-61', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-61', operation_id: 'op-61', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_61' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-61', operation_id: 'op-61', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_61',
          turns: [
            { id: 'turn_61', status: 'interrupted', itemsView: 'full', items: [] }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-61',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(res.turn_status, 'interrupted');

      const active = recoveryStore.getActiveBootstrap('proj-atl-61');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-061 — AUDIT_UNCERTAIN + exact turn interrupted = AUDIT_TERMINAL_NO_DECISION');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-062: Interrupted turn containing decision-looking content still produces AUDIT_TERMINAL_NO_DECISION
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-62');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-62', projDir));

      const ctx = { project_id: 'proj-atl-62', audit_subject_id: 'sub-62', auditor_thread_id: 'thr_62', workspace_state_observed: 'ws-62' };
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-62',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-62', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-62', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_62' } });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-62', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: ctx.auditor_thread_id,
          turns: [
            {
              id: 'turn_62',
              status: 'interrupted',
              itemsView: 'full',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(makeDecisionPayload(ctx)) }]
            }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: ctx.project_id,
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      const active = recoveryStore.getActiveBootstrap(ctx.project_id);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(active.decision_json, null);

      console.log('PASS: ATL-062 — Interrupted turn containing decision-looking content still produces AUDIT_TERMINAL_NO_DECISION');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-063: AUDIT_UNCERTAIN + exact turn failed = AUDIT_TERMINAL_NO_DECISION
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-63');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-63', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-63',
        operation_id: 'op-63',
        audit_subject_id: 'sub-63',
        thread_id: 'thr_63',
        workspace_state_observed: 'ws-63'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-63', operation_id: 'op-63', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-63', operation_id: 'op-63', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_63' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-63', operation_id: 'op-63', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_63',
          turns: [{ id: 'turn_63', status: 'failed', itemsView: 'full', items: [] }]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-63',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(res.turn_status, 'failed');

      console.log('PASS: ATL-063 — AUDIT_UNCERTAIN + exact turn failed = AUDIT_TERMINAL_NO_DECISION');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-064: resolveAuditorBootstrapUncertainty leaves active row present in AUDIT_TERMINAL_NO_DECISION
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-64');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-64', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-64',
        operation_id: 'op-64',
        audit_subject_id: 'sub-64',
        thread_id: 'thr_64',
        workspace_state_observed: 'ws-64'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-64', operation_id: 'op-64', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-64', operation_id: 'op-64', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_64' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-64', operation_id: 'op-64', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_64',
          turns: [{ id: 'turn_64', status: 'interrupted', itemsView: 'full', items: [] }]
        }
      });

      await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-64',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      const active = recoveryStore.getActiveBootstrap('proj-atl-64');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-064 — resolveAuditorBootstrapUncertainty leaves active row present in AUDIT_TERMINAL_NO_DECISION');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-065: Only subsequent recoverAuditorBootstrap clears active row, retains history, leaves Registry unbound
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-65');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-65', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-65',
        operation_id: 'op-65',
        audit_subject_id: 'sub-65',
        thread_id: 'thr_65',
        workspace_state_observed: 'ws-65'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-65', operation_id: 'op-65', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-65', operation_id: 'op-65', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_65' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-65', operation_id: 'op-65', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-65', operation_id: 'op-65', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      const tracking = {};
      const recoveryAdapterFactory = createTrackingAdapterFactory({}, tracking);

      const recRes = await recoverAuditorBootstrap({
        projectId: 'proj-atl-65',
        registryPort,
        recoveryStore,
        adapterFactory: recoveryAdapterFactory
      });

      assert.strictEqual(recRes.ok, true);
      assert.strictEqual(recRes.status, 'RECOVERED_TERMINAL_NO_DECISION_CLEARED');
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-atl-65'), null);

      const history = recoveryStore.getBootstrapHistory('proj-atl-65', 'op-65');
      assert.strictEqual(history.length, 5);

      const proj = await registryPort.getProject('proj-atl-65');
      assert.strictEqual(proj.auditor.thread_id, null);
      assert.strictEqual(proj.auditor.enabled, false);

      assert.strictEqual(tracking.calls.readThread, 0);
      assert.strictEqual(tracking.calls.startThread, 0);

      console.log('PASS: ATL-065 — Only subsequent recoverAuditorBootstrap clears active row, retains history, leaves Registry unbound');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-066: Crash/reopen between resolution and recovery remains recoverable
  {
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-66');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-66', projDir));

      let store1 = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      store1.beginBootstrap({
        project_id: 'proj-atl-66',
        operation_id: 'op-66',
        audit_subject_id: 'sub-66',
        thread_id: 'thr_66',
        workspace_state_observed: 'ws-66'
      });
      store1.transitionBootstrap({ project_id: 'proj-atl-66', operation_id: 'op-66', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      store1.transitionBootstrap({ project_id: 'proj-atl-66', operation_id: 'op-66', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_66' } });
      store1.transitionBootstrap({ project_id: 'proj-atl-66', operation_id: 'op-66', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      store1.transitionBootstrap({ project_id: 'proj-atl-66', operation_id: 'op-66', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });
      store1.close();

      // "Reopen after crash"
      let store2 = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      const recRes = await recoverAuditorBootstrap({
        projectId: 'proj-atl-66',
        registryPort,
        recoveryStore: store2,
        adapterFactory: createTrackingAdapterFactory({})
      });

      assert.strictEqual(recRes.ok, true);
      assert.strictEqual(recRes.status, 'RECOVERED_TERMINAL_NO_DECISION_CLEARED');
      assert.strictEqual(store2.getActiveBootstrap('proj-atl-66'), null);
      store2.close();

      console.log('PASS: ATL-066 — Crash/reopen between resolution and recovery remains recoverable');
    } finally {
      sandbox.cleanup();
    }
  }

  // ATL-067: Exact completed + itemsView == full + valid AuditDecisionV1 = DECISION_VALIDATED
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-67');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-67', projDir));

      const ctx = { project_id: 'proj-atl-67', audit_subject_id: 'sub-67', auditor_thread_id: 'thr_67', workspace_state_observed: 'ws-67' };
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-67',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-67', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-67', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_67' } });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-67', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: ctx.auditor_thread_id,
          turns: [
            {
              id: 'turn_67',
              status: 'completed',
              itemsView: 'full',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(makeDecisionPayload(ctx)) }]
            }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: ctx.project_id,
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.ok(res.decision);
      assert.ok(res.decision_sha256);

      const active = recoveryStore.getActiveBootstrap(ctx.project_id);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);
      assert.strictEqual(active.decision_sha256, res.decision_sha256);

      console.log('PASS: ATL-067 — Exact completed + itemsView == full + valid AuditDecisionV1 = DECISION_VALIDATED');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-068: After recovered DECISION_VALIDATED, recoverAuditorBootstrap reaches DURABLE_BOUND without rerun
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-68');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-68', projDir));

      const ctx = { project_id: 'proj-atl-68', audit_subject_id: 'sub-68', auditor_thread_id: 'thr_68', workspace_state_observed: 'ws-68' };
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: ctx.project_id,
        operation_id: 'op-68',
        audit_subject_id: ctx.audit_subject_id,
        thread_id: ctx.auditor_thread_id,
        workspace_state_observed: ctx.workspace_state_observed
      });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-68', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-68', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_68' } });
      recoveryStore.transitionBootstrap({ project_id: ctx.project_id, operation_id: 'op-68', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      // Step 1: Resolve uncertainty
      const inspectAdapterFactory = createTrackingAdapterFactory({
        thread: {
          id: ctx.auditor_thread_id,
          turns: [
            {
              id: 'turn_68',
              status: 'completed',
              itemsView: 'full',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(makeDecisionPayload(ctx)) }]
            }
          ]
        }
      });
      const resolveRes = await resolveAuditorBootstrapUncertainty({
        projectId: ctx.project_id,
        registryPort,
        recoveryStore,
        adapterFactory: inspectAdapterFactory
      });
      assert.strictEqual(resolveRes.status, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);

      // Step 2: Recover bootstrap
      const tracking = {};
      const resumeAdapterFactory = async ({ phase, cwd }) => {
        tracking.phase = phase;
        return {
          isInitialized: false,
          initialize: async () => {},
          resumeThread: async ({ threadId }) => ({ threadId }),
          close: async () => {}
        };
      };

      const recRes = await recoverAuditorBootstrap({
        projectId: ctx.project_id,
        registryPort,
        recoveryStore,
        adapterFactory: resumeAdapterFactory
      });

      assert.strictEqual(recRes.ok, true);
      assert.strictEqual(recRes.status, 'DURABLE_BOUND');
      assert.strictEqual(recoveryStore.getActiveBootstrap(ctx.project_id), null);

      const boundProj = await registryPort.getProject(ctx.project_id);
      assert.strictEqual(boundProj.auditor.thread_id, 'thr_68');
      assert.strictEqual(boundProj.auditor.enabled, true);

      console.log('PASS: ATL-068 — After recovered DECISION_VALIDATED, recoverAuditorBootstrap reaches DURABLE_BOUND without rerun');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-069: inProgress turn preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-69');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-69', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-69',
        operation_id: 'op-69',
        audit_subject_id: 'sub-69',
        thread_id: 'thr_69',
        workspace_state_observed: 'ws-69'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-69', operation_id: 'op-69', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-69', operation_id: 'op-69', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_69' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-69', operation_id: 'op-69', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_69',
          turns: [{ id: 'turn_69', status: 'inProgress', itemsView: 'partial', items: [] }]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-69',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      const active = recoveryStore.getActiveBootstrap('proj-atl-69');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-069 — inProgress turn preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-070: Missing persisted turn_id in recovery store preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-70');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-70', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-70',
        operation_id: 'op-70',
        audit_subject_id: 'sub-70',
        thread_id: 'thr_70',
        workspace_state_observed: 'ws-70'
      });
      // Transition directly to AUDIT_UNCERTAIN without turn_id
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-70', operation_id: 'op-70', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const tracking = {};
      const adapterFactory = createTrackingAdapterFactory({}, tracking);

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-70',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      assert.strictEqual(tracking.calls.readThread, 0);

      console.log('PASS: ATL-070 — Missing persisted turn_id preserves AUDIT_UNCERTAIN without adapter call');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-071: Target turn absent from provider thread response preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-71');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-71', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-71',
        operation_id: 'op-71',
        audit_subject_id: 'sub-71',
        thread_id: 'thr_71',
        workspace_state_observed: 'ws-71'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-71', operation_id: 'op-71', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-71', operation_id: 'op-71', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_71' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-71', operation_id: 'op-71', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_71',
          turns: [{ id: 'other_turn_id', status: 'interrupted', itemsView: 'full', items: [] }]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-71',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      const active = recoveryStore.getActiveBootstrap('proj-atl-71');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-071 — Target turn absent preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-072: Duplicate target turn preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-72');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-72', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-72',
        operation_id: 'op-72',
        audit_subject_id: 'sub-72',
        thread_id: 'thr_72',
        workspace_state_observed: 'ws-72'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-72', operation_id: 'op-72', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-72', operation_id: 'op-72', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_72' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-72', operation_id: 'op-72', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_72',
          turns: [
            { id: 'turn_72', status: 'interrupted', itemsView: 'full', items: [] },
            { id: 'turn_72', status: 'interrupted', itemsView: 'full', items: [] }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-72',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-072 — Duplicate target turn preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-073: Additional foreign turn preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-73');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-73', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-73',
        operation_id: 'op-73',
        audit_subject_id: 'sub-73',
        thread_id: 'thr_73',
        workspace_state_observed: 'ws-73'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-73', operation_id: 'op-73', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-73', operation_id: 'op-73', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_73' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-73', operation_id: 'op-73', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_73',
          turns: [
            { id: 'turn_73', status: 'interrupted', itemsView: 'full', items: [] },
            { id: 'turn_foreign', status: 'completed', itemsView: 'full', items: [] }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-73',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-073 — Additional foreign turn preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-074: Completed turn with itemsView != full preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-74');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-74', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-74',
        operation_id: 'op-74',
        audit_subject_id: 'sub-74',
        thread_id: 'thr_74',
        workspace_state_observed: 'ws-74'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-74', operation_id: 'op-74', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-74', operation_id: 'op-74', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_74' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-74', operation_id: 'op-74', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_74',
          turns: [{ id: 'turn_74', status: 'completed', itemsView: 'partial', items: [] }]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-74',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-074 — Completed turn with itemsView != full preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-075: Completed turn with invalid/ambiguous decision preserves AUDIT_UNCERTAIN
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-75');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-75', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-75',
        operation_id: 'op-75',
        audit_subject_id: 'sub-75',
        thread_id: 'thr_75',
        workspace_state_observed: 'ws-75'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-75', operation_id: 'op-75', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-75', operation_id: 'op-75', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_75' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-75', operation_id: 'op-75', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      // Malformed decision text in agentMessage
      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_75',
          turns: [
            {
              id: 'turn_75',
              status: 'completed',
              itemsView: 'full',
              items: [{ type: 'agentMessage', phase: 'final_answer', text: 'NOT_VALID_JSON' }]
            }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-75',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-075 — Completed turn with invalid decision preserves AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-076: Wrong provider thread identity returned by readThread fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-76');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-76', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-76',
        operation_id: 'op-76',
        audit_subject_id: 'sub-76',
        thread_id: 'thr_76',
        workspace_state_observed: 'ws-76'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-76', operation_id: 'op-76', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-76', operation_id: 'op-76', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_76' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-76', operation_id: 'op-76', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'wrong_thread_id',
          turns: [{ id: 'turn_76', status: 'interrupted', itemsView: 'full', items: [] }]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-76',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-076 — Wrong provider thread identity fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-077: Registry already bound or conflicting fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-77');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      // Already bound project
      await registryPort.putProject(makeValidProject('proj-atl-77', projDir, {
        auditor: { thread_id: 'thr_already_bound', enabled: true, engine: 'codex_app_server', cwd: projDir, model_policy: 'auditor_standard' }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'proj-atl-77',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      console.log('PASS: ATL-077 — Registry already bound or conflicting fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-078: Provider read failure leaves AUDIT_UNCERTAIN unchanged and fails closed
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-78');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-78', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-78',
        operation_id: 'op-78',
        audit_subject_id: 'sub-78',
        thread_id: 'thr_78',
        workspace_state_observed: 'ws-78'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-78', operation_id: 'op-78', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-78', operation_id: 'op-78', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_78' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-78', operation_id: 'op-78', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const failingAdapterFactory = createTrackingAdapterFactory(() => {
        throw new Error('Connection reset by provider');
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-78',
        registryPort,
        recoveryStore,
        adapterFactory: failingAdapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      const active = recoveryStore.getActiveBootstrap('proj-atl-78');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-078 — Provider read failure leaves AUDIT_UNCERTAIN unchanged and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-079: Resolver never calls startThread, startTurn, interruptTurn, or startReview
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-79');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-79', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-79',
        operation_id: 'op-79',
        audit_subject_id: 'sub-79',
        thread_id: 'thr_79',
        workspace_state_observed: 'ws-79'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-79', operation_id: 'op-79', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-79', operation_id: 'op-79', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_79' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-79', operation_id: 'op-79', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const tracking = {};
      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: 'thr_79',
          turns: [{ id: 'turn_79', status: 'interrupted', itemsView: 'full', items: [] }]
        }
      }, tracking);

      await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-79',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(tracking.calls.startThread, 0);
      assert.strictEqual(tracking.calls.startTurn, 0);
      assert.strictEqual(tracking.calls.interruptTurn, 0);
      assert.strictEqual(tracking.calls.startReview, 0);
      assert.strictEqual(tracking.calls.readThread, 1);
      assert.strictEqual(tracking.calls.close, 1);

      console.log('PASS: ATL-079 — Resolver never calls startThread, startTurn, interruptTurn, or startReview');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-080: Real R7 shape characterization: thread.status.type: 'notLoaded' resolves to AUDIT_TERMINAL_NO_DECISION
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-80');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-80', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-80',
        operation_id: 'op-80',
        audit_subject_id: 'sub-80',
        thread_id: '01a0bd4a-abc8-7a90-8e89-6ac0f33d00fd',
        workspace_state_observed: 'ws-80'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-80', operation_id: 'op-80', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-80', operation_id: 'op-80', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: '01a0bd4a-ac83-7a03-aed1-c0f922ba91f4' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-80', operation_id: 'op-80', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      // Exact R7 response shape
      const adapterFactory = createTrackingAdapterFactory({
        thread: {
          id: '01a0bd4a-abc8-7a90-8e89-6ac0f33d00fd',
          status: { type: 'notLoaded' },
          turns: [
            {
              id: '01a0bd4a-ac83-7a03-aed1-c0f922ba91f4',
              status: 'interrupted',
              itemsView: 'full',
              items: [
                { type: 'commandExecution' },
                { type: 'reasoning' },
                { type: 'commandExecution' }
              ]
            }
          ]
        }
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-80',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);
      assert.strictEqual(res.turn_status, 'interrupted');

      console.log('PASS: ATL-080 — Real R7 shape characterization: notLoaded thread status resolves to AUDIT_TERMINAL_NO_DECISION');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-081: Missing project in Registry fails closed with AUDITOR_LIFECYCLE_PRECONDITION_FAILED
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'non-existent-proj',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      console.log('PASS: ATL-081 — Missing project in Registry fails closed with AUDITOR_LIFECYCLE_PRECONDITION_FAILED');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-082: Active bootstrap missing or not in AUDIT_UNCERTAIN fails closed with AUDITOR_LIFECYCLE_PRECONDITION_FAILED
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-82');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-82', projDir));
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      // No active bootstrap
      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'proj-atl-82',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      // Active bootstrap in PROVISIONAL_THREAD
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-82',
        operation_id: 'op-82',
        audit_subject_id: 'sub-82',
        thread_id: 'thr_82',
        workspace_state_observed: 'ws-82'
      });
      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'proj-atl-82',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      console.log('PASS: ATL-082 — Active bootstrap missing or not in AUDIT_UNCERTAIN fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-083: Caller-supplied threadId, turnId, turnStatus, or decision rejected with AUDITOR_LIFECYCLE_INVALID_REQUEST
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });

      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'proj-atl-83',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({}),
          threadId: 'injected-thread'
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST }
      );

      await assert.rejects(
        () => resolveAuditorBootstrapUncertainty({
          projectId: 'proj-atl-83',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({}),
          turnId: 'injected-turn'
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST }
      );

      console.log('PASS: ATL-083 — Caller-supplied threadId, turnId, turnStatus, or decision rejected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-084: AUDIT_TERMINAL_NO_DECISION + fresh Registry UNBOUND => cleanup succeeds
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-84');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-84', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-84',
        operation_id: 'op-84',
        audit_subject_id: 'sub-84',
        thread_id: 'thr_84',
        workspace_state_observed: 'ws-84'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-84', operation_id: 'op-84', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-84', operation_id: 'op-84', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_84' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-84', operation_id: 'op-84', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-84', operation_id: 'op-84', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-atl-84',
        registryPort,
        recoveryStore,
        adapterFactory: createTrackingAdapterFactory({})
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'RECOVERED_TERMINAL_NO_DECISION_CLEARED');
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-atl-84'), null);

      const history = recoveryStore.getBootstrapHistory('proj-atl-84', 'op-84');
      assert.strictEqual(history.length, 5);

      const proj = await registryPort.getProject('proj-atl-84');
      assert.strictEqual(proj.auditor.thread_id, null);
      assert.strictEqual(proj.auditor.enabled, false);

      console.log('PASS: ATL-084 — AUDIT_TERMINAL_NO_DECISION + fresh Registry UNBOUND => cleanup succeeds');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-085: Registry becomes bound to the same historical thread before cleanup => cleanup rejected => active row remains
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-85');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-85', projDir, {
        auditor: { thread_id: 'thr_85', enabled: true }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-85',
        operation_id: 'op-85',
        audit_subject_id: 'sub-85',
        thread_id: 'thr_85',
        workspace_state_observed: 'ws-85'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-85', operation_id: 'op-85', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-85', operation_id: 'op-85', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_85' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-85', operation_id: 'op-85', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-85', operation_id: 'op-85', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      await assert.rejects(
        () => recoverAuditorBootstrap({
          projectId: 'proj-atl-85',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      const active = recoveryStore.getActiveBootstrap('proj-atl-85');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-085 — Registry becomes bound to the same historical thread before cleanup => cleanup rejected => active terminal-no-decision row remains');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-086: Registry becomes bound to a different thread before cleanup => cleanup rejected => active row remains
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-86');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-86', projDir, {
        auditor: { thread_id: 'thr_foreign_86', enabled: true }
      }));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-86',
        operation_id: 'op-86',
        audit_subject_id: 'sub-86',
        thread_id: 'thr_86',
        workspace_state_observed: 'ws-86'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-86', operation_id: 'op-86', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-86', operation_id: 'op-86', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_86' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-86', operation_id: 'op-86', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-86', operation_id: 'op-86', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      await assert.rejects(
        () => recoverAuditorBootstrap({
          projectId: 'proj-atl-86',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      const active = recoveryStore.getActiveBootstrap('proj-atl-86');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-086 — Registry becomes bound to a different thread before cleanup => cleanup rejected => active row remains');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-087: Registry project missing at cleanup => cleanup rejected => active row remains
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');

      const registryPort = createProjectRegistry({ registryFilePath: regFile });

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-87',
        operation_id: 'op-87',
        audit_subject_id: 'sub-87',
        thread_id: 'thr_87',
        workspace_state_observed: 'ws-87'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-87', operation_id: 'op-87', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-87', operation_id: 'op-87', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_87' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-87', operation_id: 'op-87', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-87', operation_id: 'op-87', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      await assert.rejects(
        () => recoverAuditorBootstrap({
          projectId: 'proj-atl-87',
          registryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      const active = recoveryStore.getActiveBootstrap('proj-atl-87');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-087 — Registry project missing at cleanup => cleanup rejected => active row remains');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-088: Registry getProject failure at cleanup => cleanup rejected => active row remains
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const dbFile = path.join(sandbox.dir, 'recovery.db');

      const faultyRegistryPort = {
        getProject: async () => {
          throw new Error('Database disk I/O failure');
        }
      };

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-88',
        operation_id: 'op-88',
        audit_subject_id: 'sub-88',
        thread_id: 'thr_88',
        workspace_state_observed: 'ws-88'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-88', operation_id: 'op-88', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-88', operation_id: 'op-88', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_88' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-88', operation_id: 'op-88', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-88', operation_id: 'op-88', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION });

      await assert.rejects(
        () => recoverAuditorBootstrap({
          projectId: 'proj-atl-88',
          registryPort: faultyRegistryPort,
          recoveryStore,
          adapterFactory: createTrackingAdapterFactory({})
        }),
        { code: LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED }
      );

      const active = recoveryStore.getActiveBootstrap('proj-atl-88');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION);

      console.log('PASS: ATL-088 — Registry getProject failure at cleanup => cleanup rejected => active row remains');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-089: provider inspection throws an extremely large error message => result remains AUDIT_UNCERTAIN => diagnostic <= configured UTF-8 byte bound => active state unchanged
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-89');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-89', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-89',
        operation_id: 'op-89',
        audit_subject_id: 'sub-89',
        thread_id: 'thr_89',
        workspace_state_observed: 'ws-89'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-89', operation_id: 'op-89', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-89', operation_id: 'op-89', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_89' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-89', operation_id: 'op-89', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      const hugeErrorMessage = 'PROVIDER_ERR_'.repeat(5000);
      const adapterFactory = async () => ({
        initialize: async () => {},
        readThread: async () => {
          throw new Error(hugeErrorMessage);
        },
        close: async () => {}
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-89',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      assert.ok(typeof res.reason === 'string');
      assert.ok(res.reason.startsWith('PROVIDER_INSPECTION_FAILED:'));
      assert.ok(Buffer.byteLength(res.reason, 'utf8') <= MAX_UNCERTAINTY_DIAGNOSTIC_BYTES);

      const active = recoveryStore.getActiveBootstrap('proj-atl-89');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-089 — provider inspection throws an extremely large error message => result remains AUDIT_UNCERTAIN => diagnostic <= configured UTF-8 byte bound => active state unchanged');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-090: provider/mismatch diagnostic containing multibyte Unicode => UTF-8 truncation remains valid => byte bound respected
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-90');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-90', projDir));

      recoveryStore = createSqliteAuditorRecoveryStore({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-90',
        operation_id: 'op-90',
        audit_subject_id: 'sub-90',
        thread_id: 'thr_90',
        workspace_state_observed: 'ws-90'
      });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-90', operation_id: 'op-90', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-90', operation_id: 'op-90', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn_90' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-90', operation_id: 'op-90', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      // Multi-byte Unicode payload: 4-byte rocket emoji + 3-byte Vietnamese chars + 2-byte greek letters
      const unicodeString = '🚀 Tiếng Việt Kiểm Định Σ '.repeat(500);
      const adapterFactory = async () => ({
        initialize: async () => {},
        readThread: async () => {
          throw new Error(unicodeString);
        },
        close: async () => {}
      });

      const res = await resolveAuditorBootstrapUncertainty({
        projectId: 'proj-atl-90',
        registryPort,
        recoveryStore,
        adapterFactory
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.status, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);
      assert.ok(typeof res.reason === 'string');
      const reasonByteLen = Buffer.byteLength(res.reason, 'utf8');
      assert.ok(reasonByteLen <= MAX_UNCERTAINTY_DIAGNOSTIC_BYTES);

      // Verify UTF-8 integrity: re-encoding to buffer and decoding back to string must not produce \uFFFD replacement characters
      const roundtrip = Buffer.from(res.reason, 'utf8').toString('utf8');
      assert.strictEqual(roundtrip, res.reason);
      assert.strictEqual(res.reason.includes('\uFFFD'), false);

      const active = recoveryStore.getActiveBootstrap('proj-atl-90');
      assert.notStrictEqual(active, null);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-090 — provider/mismatch diagnostic containing multibyte Unicode => UTF-8 truncation remains valid => byte bound respected');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }


  // Helper to create genuine V1 database with pre-migration data and full schema
  function createGenuineV1Database(dbPath, {
    projectId = 'proj-legacy-01',
    operationId = 'op-legacy-01',
    subjectId = 'sub-legacy-01',
    threadId = 'thr-legacy-01',
    turnId = 'turn-legacy-01',
    wsState = 'ws-legacy-01',
    state = 'DECISION_VALIDATED',
    decision = null
  } = {}) {
    const { DatabaseSync } = require('node:sqlite');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      PRAGMA user_version = 1;
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
      CREATE UNIQUE INDEX idx_auditor_bootstrap_op
        ON auditor_bootstrap(operation_id);
      CREATE INDEX idx_auditor_history_project
        ON auditor_bootstrap_history(project_id);
      CREATE INDEX idx_auditor_history_op
        ON auditor_bootstrap_history(operation_id);
    `);

    let decJson = null;
    let decHash = null;
    if (decision !== null) {
      decJson = JSON.stringify(decision);
      decHash = crypto.createHash('sha256').update(decJson, 'utf8').digest('hex');
    } else if (state === 'DECISION_VALIDATED' || state === 'RESUME_VERIFYING' || state === 'RESUME_VERIFIED' || state === 'REGISTRY_BINDING') {
      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: projectId,
        audit_subject_id: subjectId,
        auditor_thread_id: threadId,
        workspace_state_observed: wsState,
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      decJson = JSON.stringify(decPayload);
      decHash = crypto.createHash('sha256').update(decJson, 'utf8').digest('hex');
    }

    const nowIso = new Date().toISOString();
    rawDb.prepare(`
      INSERT INTO auditor_bootstrap VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, operationId, subjectId, threadId,
      (state === 'PROVISIONAL_THREAD' || state === 'FIRST_TURN_STARTING') ? null : turnId,
      wsState, state, decJson, decHash, nowIso, nowIso
    );

    let seq = 1;
    rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, NULL, 'PROVISIONAL_THREAD', ?, ?, NULL)`).run(seq++, projectId, operationId, 1, nowIso);
    if (state !== 'PROVISIONAL_THREAD') {
      rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'PROVISIONAL_THREAD', 'FIRST_TURN_STARTING', ?, ?, NULL)`).run(seq++, projectId, operationId, 2, nowIso);
      if (state !== 'FIRST_TURN_STARTING') {
        rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'FIRST_TURN_STARTING', 'FIRST_TURN_IN_FLIGHT', ?, ?, NULL)`).run(seq++, projectId, operationId, 3, nowIso);
        if (state === 'AUDIT_UNCERTAIN') {
          rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'FIRST_TURN_IN_FLIGHT', 'AUDIT_UNCERTAIN', ?, ?, NULL)`).run(seq++, projectId, operationId, 4, nowIso);
        } else if (state === 'AUDIT_TERMINAL_NO_DECISION') {
          rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'FIRST_TURN_IN_FLIGHT', 'AUDIT_UNCERTAIN', ?, ?, NULL)`).run(seq++, projectId, operationId, 4, nowIso);
          rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'AUDIT_UNCERTAIN', 'AUDIT_TERMINAL_NO_DECISION', ?, ?, NULL)`).run(seq++, projectId, operationId, 5, nowIso);
        } else {
          rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'FIRST_TURN_IN_FLIGHT', 'DECISION_VALIDATED', ?, ?, NULL)`).run(seq++, projectId, operationId, 4, nowIso);
          if (state === 'RESUME_VERIFYING' || state === 'RESUME_VERIFIED' || state === 'REGISTRY_BINDING') {
            rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'DECISION_VALIDATED', 'RESUME_VERIFYING', ?, ?, NULL)`).run(seq++, projectId, operationId, 5, nowIso);
            if (state === 'RESUME_VERIFIED' || state === 'REGISTRY_BINDING') {
              rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'RESUME_VERIFYING', 'RESUME_VERIFIED', ?, ?, NULL)`).run(seq++, projectId, operationId, 6, nowIso);
              if (state === 'REGISTRY_BINDING') {
                rawDb.prepare(`INSERT INTO auditor_bootstrap_history VALUES (?, ?, ?, 'RESUME_VERIFIED', 'REGISTRY_BINDING', ?, ?, NULL)`).run(seq++, projectId, operationId, 7, nowIso);
              }
            }
          }
        }
      }
    }

    rawDb.close();
  }

  // ATL-091: bootstrapAuditorThread captures authority_version = 1 and canonical root/identity/model_policy atomically in recovery store
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-91');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-91', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let capturedActiveDuringBootstrap = null;
      const trackingFactory = async ({ phase, cwd }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-91' }),
            startTurn: async () => {
              capturedActiveDuringBootstrap = recoveryStore.getActiveBootstrap('proj-atl-91');
              return { turnId: 'turn-atl-91' };
            },
            close: async () => {}
          };
        }
        return {
          initialize: async () => {},
          resumeThread: async () => ({ threadId: 'thr-atl-91' }),
          close: async () => {}
        };
      };

      const mockAwaitDecision = async () => ({
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-91',
        audit_subject_id: 'sub-91',
        auditor_thread_id: 'thr-atl-91',
        workspace_state_observed: 'ws-91',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      });

      const res = await bootstrapAuditorThread({
        projectId: 'proj-atl-91',
        registryPort,
        recoveryStore,
        adapterFactory: trackingFactory,
        awaitAuditDecision: mockAwaitDecision,
        workspacePort: createMockWorkspacePort('ws-91'),
        auditSubjectId: 'sub-91',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');

      assert.ok(capturedActiveDuringBootstrap);
      assert.strictEqual(capturedActiveDuringBootstrap.authority_version, 1);
      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir);
      assert.strictEqual(capturedActiveDuringBootstrap.expected_project_root, canonicalRoot);
      assert.strictEqual(capturedActiveDuringBootstrap.expected_project_root_identity, identityKey);
      assert.strictEqual(capturedActiveDuringBootstrap.expected_auditor_model_policy, 'auditor_standard');

      console.log('PASS: ATL-091 — bootstrapAuditorThread captures authority_version = 1 and canonical root/identity/model_policy atomically');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-092: bootstrapAuditorThread fails closed before provider call if project_root cannot be canonicalized
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let adapterFactoryCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-dir-92');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-92', projDir));
      // Remove directory so canonicalizeProjectRoot fails at bootstrap time
      fs.rmSync(projDir, { recursive: true, force: true });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-92',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              adapterFactoryCalled = true;
              throw new Error('Should not be called');
            },
            workspacePort: createMockWorkspacePort('ws-92'),
            auditSubjectId: 'sub-92',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      assert.strictEqual(adapterFactoryCalled, false);
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-atl-92'), null);

      console.log('PASS: ATL-092 — bootstrapAuditorThread fails closed before provider call if project_root cannot be canonicalized');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-093: live bootstrap detects project_root drift before second-process resume and fails closed with zero thread/resume
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir1 = path.join(sandbox.dir, 'proj-atl-93-a');
      const projDir2 = path.join(sandbox.dir, 'proj-atl-93-b');
      fs.mkdirSync(projDir1, { recursive: true });
      fs.mkdirSync(projDir2, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-93', projDir1));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-93' }),
            startTurn: async () => ({ turnId: 'turn-atl-93' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          resumeCalled = true;
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-93' }),
            close: async () => {}
          };
        }
      };

      const mockAwaitDecision = async () => {
        // Mutate registry project_root before resume step
        await registryPort.putProject(makeValidProject('proj-atl-93', projDir2));
        return {
          schema_version: 1,
          decision: 'APPROVE_WORK_PACKAGE',
          project_id: 'proj-atl-93',
          audit_subject_id: 'sub-93',
          auditor_thread_id: 'thr-atl-93',
          workspace_state_observed: 'ws-93',
          summary: 'Decision valid',
          independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
          work_order: null,
          requested_evidence: [],
          blocker: null
        };
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-93',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: mockAwaitDecision,
            workspacePort: createMockWorkspacePort('ws-93'),
            auditSubjectId: 'sub-93',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('drift detected'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);
      const projAfter = await registryPort.getProject('proj-atl-93');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-093 — live bootstrap detects project_root drift before second-process resume and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-094: live bootstrap detects model_policy drift before second-process resume and fails closed with zero thread/resume
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-94');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-94', projDir, { auditor: { model_policy: 'auditor_standard' } }));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-94' }),
            startTurn: async () => ({ turnId: 'turn-atl-94' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          resumeCalled = true;
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-94' }),
            close: async () => {}
          };
        }
      };

      const mockAwaitDecision = async () => {
        // Mutate model_policy before resume
        await registryPort.putProject(makeValidProject('proj-atl-94', projDir, { auditor: { model_policy: 'auditor_deep' } }));
        return {
          schema_version: 1,
          decision: 'APPROVE_WORK_PACKAGE',
          project_id: 'proj-atl-94',
          audit_subject_id: 'sub-94',
          auditor_thread_id: 'thr-atl-94',
          workspace_state_observed: 'ws-94',
          summary: 'Decision valid',
          independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
          work_order: null,
          requested_evidence: [],
          blocker: null
        };
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-94',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: mockAwaitDecision,
            workspacePort: createMockWorkspacePort('ws-94'),
            auditSubjectId: 'sub-94',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Auditor model policy drift'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);

      console.log('PASS: ATL-094 — live bootstrap detects model_policy drift before second-process resume and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-095: live bootstrap detects auditor.cwd drift before second-process resume and fails closed with zero thread/resume
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-95');
      const otherDir = path.join(sandbox.dir, 'other-dir');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(otherDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-95', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-95' }),
            startTurn: async () => ({ turnId: 'turn-atl-95' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          resumeCalled = true;
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-95' }),
            close: async () => {}
          };
        }
      };

      const origGetProject = registryPort.getProject;
      let mutateCwd = false;
      registryPort.getProject = async (id) => {
        const p = await origGetProject.call(registryPort, id);
        if (mutateCwd && p && p.auditor) {
          p.auditor = { ...p.auditor, cwd: otherDir };
        }
        return p;
      };

      const mockAwaitDecision = async () => {
        // Trigger cwd mutation on next getProject
        mutateCwd = true;
        return {
          schema_version: 1,
          decision: 'APPROVE_WORK_PACKAGE',
          project_id: 'proj-atl-95',
          audit_subject_id: 'sub-95',
          auditor_thread_id: 'thr-atl-95',
          workspace_state_observed: 'ws-95',
          summary: 'Decision valid',
          independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
          work_order: null,
          requested_evidence: [],
          blocker: null
        };
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-95',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: mockAwaitDecision,
            workspacePort: createMockWorkspacePort('ws-95'),
            auditSubjectId: 'sub-95',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Auditor cwd drift'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);

      console.log('PASS: ATL-095 — live bootstrap detects auditor.cwd drift before second-process resume and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-096: live bootstrap detects project_root drift before Registry bind and fails closed with zero bindAuditorThread calls
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir1 = path.join(sandbox.dir, 'proj-atl-96-a');
      const projDir2 = path.join(sandbox.dir, 'proj-atl-96-b');
      fs.mkdirSync(projDir1, { recursive: true });
      fs.mkdirSync(projDir2, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-96', projDir1));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-96' }),
            startTurn: async () => ({ turnId: 'turn-atl-96' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          // Mutate registry between resume and bind
          await registryPort.putProject(makeValidProject('proj-atl-96', projDir2));
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-96' }),
            close: async () => {}
          };
        }
      };

      const mockAwaitDecision = async () => ({
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-96',
        audit_subject_id: 'sub-96',
        auditor_thread_id: 'thr-atl-96',
        workspace_state_observed: 'ws-96',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      });

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-96',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: mockAwaitDecision,
            workspacePort: createMockWorkspacePort('ws-96'),
            auditSubjectId: 'sub-96',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED);
          return true;
        }
      );

      const projAfter = await registryPort.getProject('proj-atl-96');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-096 — live bootstrap detects project_root drift before Registry bind and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-097: live bootstrap detects model_policy drift before Registry bind and fails closed with zero bindAuditorThread calls
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-97');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-97', projDir, { auditor: { model_policy: 'auditor_standard' } }));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-97' }),
            startTurn: async () => ({ turnId: 'turn-atl-97' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          // Mutate model_policy right before bind
          await registryPort.putProject(makeValidProject('proj-atl-97', projDir, { auditor: { model_policy: 'auditor_deep' } }));
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-97' }),
            close: async () => {}
          };
        }
      };

      const mockAwaitDecision = async () => ({
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-97',
        audit_subject_id: 'sub-97',
        auditor_thread_id: 'thr-atl-97',
        workspace_state_observed: 'ws-97',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      });

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-97',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: mockAwaitDecision,
            workspacePort: createMockWorkspacePort('ws-97'),
            auditSubjectId: 'sub-97',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED);
          return true;
        }
      );

      const projAfter = await registryPort.getProject('proj-atl-97');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-097 — live bootstrap detects model_policy drift before Registry bind and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-098: recoverAuditorBootstrap with authority_version = 0 in DECISION_VALIDATED fails closed (zero resume, zero bind, active row retained)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-98');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-98', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-98',
        operationId: 'op-atl-98',
        state: 'DECISION_VALIDATED'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      const activeMigrated = recoveryStore.getActiveBootstrap('proj-atl-98');
      assert.strictEqual(activeMigrated.authority_version, 0);

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-98',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              resumeCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('authority_version 0'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);
      const projAfter = await registryPort.getProject('proj-atl-98');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      const activeAfter = recoveryStore.getActiveBootstrap('proj-atl-98');
      assert.notStrictEqual(activeAfter, null);
      assert.strictEqual(activeAfter.state, AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED);

      console.log('PASS: ATL-098 — recoverAuditorBootstrap with authority_version = 0 in DECISION_VALIDATED fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-099: recoverAuditorBootstrap with authority_version = 0 in RESUME_VERIFYING fails closed (zero resume, zero bind, active row retained)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-99');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-99', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-99',
        operationId: 'op-atl-99',
        state: 'RESUME_VERIFYING'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-99',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              resumeCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);
      const projAfter = await registryPort.getProject('proj-atl-99');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-099 — recoverAuditorBootstrap with authority_version = 0 in RESUME_VERIFYING fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-100: recoverAuditorBootstrap with authority_version = 0 in REGISTRY_BINDING fails closed (zero bind, active row retained)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-100');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-100', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-100',
        operationId: 'op-atl-100',
        state: 'REGISTRY_BINDING'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-100',
            registryPort,
            recoveryStore,
            adapterFactory: async () => ({})
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      const projAfter = await registryPort.getProject('proj-atl-100');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-100 — recoverAuditorBootstrap with authority_version = 0 in REGISTRY_BINDING fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-101: recoverAuditorBootstrap with authority_version = 0 in AUDIT_TERMINAL_NO_DECISION cleans up active row when Registry unbound
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-101');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-101', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-101',
        operationId: 'op-atl-101',
        state: 'AUDIT_TERMINAL_NO_DECISION'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const res = await recoverAuditorBootstrap({
        projectId: 'proj-atl-101',
        registryPort,
        recoveryStore
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'RECOVERED_TERMINAL_NO_DECISION_CLEARED');
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-atl-101'), null);

      console.log('PASS: ATL-101 — recoverAuditorBootstrap with authority_version = 0 in AUDIT_TERMINAL_NO_DECISION cleans up active row');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-102: recoverAuditorBootstrap detects project_root drift before resumeThread and fails closed (zero thread/resume)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir1 = path.join(sandbox.dir, 'proj-atl-102-a');
      const projDir2 = path.join(sandbox.dir, 'proj-atl-102-b');
      fs.mkdirSync(projDir1, { recursive: true });
      fs.mkdirSync(projDir2, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir1);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      // Registry currently has projDir2 (drifted from persisted projDir1)
      await registryPort.putProject(makeValidProject('proj-atl-102', projDir2));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-102',
        operation_id: 'op-102',
        audit_subject_id: 'sub-102',
        thread_id: 'thr-102',
        workspace_state_observed: 'ws-102',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-102',
        audit_subject_id: 'sub-102',
        auditor_thread_id: 'thr-102',
        workspace_state_observed: 'ws-102',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-102', operation_id: 'op-102', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-102', operation_id: 'op-102', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-102' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-102', operation_id: 'op-102', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-102',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              resumeCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('drift detected'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);

      console.log('PASS: ATL-102 — recoverAuditorBootstrap detects project_root drift before resumeThread and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-103: recoverAuditorBootstrap detects model_policy drift before resumeThread and fails closed (zero thread/resume)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-103');
      fs.mkdirSync(projDir, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      // Registry has policy 'auditor_deep'
      await registryPort.putProject(makeValidProject('proj-atl-103', projDir, { auditor: { model_policy: 'auditor_deep' } }));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-103',
        operation_id: 'op-103',
        audit_subject_id: 'sub-103',
        thread_id: 'thr-103',
        workspace_state_observed: 'ws-103',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-103',
        audit_subject_id: 'sub-103',
        auditor_thread_id: 'thr-103',
        workspace_state_observed: 'ws-103',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-103', operation_id: 'op-103', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-103', operation_id: 'op-103', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-103' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-103', operation_id: 'op-103', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-103',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              resumeCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Auditor model policy drift'));
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);

      console.log('PASS: ATL-103 — recoverAuditorBootstrap detects model_policy drift before resumeThread and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-104: recoverAuditorBootstrap detects project_root drift before Registry bind and fails closed (zero bindAuditorThread)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir1 = path.join(sandbox.dir, 'proj-atl-104-a');
      const projDir2 = path.join(sandbox.dir, 'proj-atl-104-b');
      fs.mkdirSync(projDir1, { recursive: true });
      fs.mkdirSync(projDir2, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir1);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-104', projDir2));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-104',
        operation_id: 'op-104',
        audit_subject_id: 'sub-104',
        thread_id: 'thr-104',
        workspace_state_observed: 'ws-104',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-104',
        audit_subject_id: 'sub-104',
        auditor_thread_id: 'thr-104',
        workspace_state_observed: 'ws-104',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-104' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-104', operation_id: 'op-104', next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-104',
            registryPort,
            recoveryStore
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      const projAfter = await registryPort.getProject('proj-atl-104');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-104 — recoverAuditorBootstrap detects project_root drift before Registry bind and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-105: recoverAuditorBootstrap detects model_policy drift before Registry bind and fails closed (zero bindAuditorThread)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-105');
      fs.mkdirSync(projDir, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-105', projDir, { auditor: { model_policy: 'auditor_deep' } }));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-105',
        operation_id: 'op-105',
        audit_subject_id: 'sub-105',
        thread_id: 'thr-105',
        workspace_state_observed: 'ws-105',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-105',
        audit_subject_id: 'sub-105',
        auditor_thread_id: 'thr-105',
        workspace_state_observed: 'ws-105',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-105' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-105', operation_id: 'op-105', next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-105',
            registryPort,
            recoveryStore
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      const projAfter = await registryPort.getProject('proj-atl-105');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-105 — recoverAuditorBootstrap detects model_policy drift before Registry bind and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-106: resolveAuditorBootstrapUncertainty with authority_version = 0 fails closed before provider read
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let readThreadCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-106');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-106', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-106',
        operationId: 'op-atl-106',
        state: 'AUDIT_UNCERTAIN'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      await assert.rejects(
        async () => {
          await resolveAuditorBootstrapUncertainty({
            projectId: 'proj-atl-106',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              readThreadCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      assert.strictEqual(readThreadCalled, false);
      const activeAfter = recoveryStore.getActiveBootstrap('proj-atl-106');
      assert.strictEqual(activeAfter.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-106 — resolveAuditorBootstrapUncertainty with authority_version = 0 fails closed before provider read');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-107: resolveAuditorBootstrapUncertainty detects drift before provider read and fails closed (zero readThread calls)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let readThreadCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir1 = path.join(sandbox.dir, 'proj-atl-107-a');
      const projDir2 = path.join(sandbox.dir, 'proj-atl-107-b');
      fs.mkdirSync(projDir1, { recursive: true });
      fs.mkdirSync(projDir2, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir1);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-107', projDir2));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-107',
        operation_id: 'op-107',
        audit_subject_id: 'sub-107',
        thread_id: 'thr-107',
        workspace_state_observed: 'ws-107',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-107', operation_id: 'op-107', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-107', operation_id: 'op-107', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-107' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-107', operation_id: 'op-107', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      await assert.rejects(
        async () => {
          await resolveAuditorBootstrapUncertainty({
            projectId: 'proj-atl-107',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              readThreadCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      assert.strictEqual(readThreadCalled, false);

      console.log('PASS: ATL-107 — resolveAuditorBootstrapUncertainty detects drift before provider read and fails closed');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-108: retireLegacyAuditorBootstrapWithoutAuthority succeeds for authority_version = 0 and leaves Registry unbound
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-108');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-108', projDir));

      createGenuineV1Database(dbFile, {
        projectId: 'proj-atl-108',
        operationId: 'op-atl-108',
        state: 'DECISION_VALIDATED'
      });

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const res = await retireLegacyAuditorBootstrapWithoutAuthority({
        projectId: 'proj-atl-108',
        registryPort,
        recoveryStore,
        metadata: { operator: 'test_retirement' }
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE');
      assert.strictEqual(res.project_id, 'proj-atl-108');
      assert.strictEqual(res.operation_id, 'op-atl-108');

      // Active row deleted
      assert.strictEqual(recoveryStore.getActiveBootstrap('proj-atl-108'), null);

      // Terminal history row appended
      const history = recoveryStore.getHistory('proj-atl-108');
      const last = history[history.length - 1];
      assert.strictEqual(last.previous_state, 'DECISION_VALIDATED');
      assert.strictEqual(last.next_state, 'LEGACY_AUTHORITY_RETIRED');

      // Registry remains unbound
      const projAfter = await registryPort.getProject('proj-atl-108');
      assert.strictEqual(projAfter.auditor.thread_id, null);
      assert.strictEqual(projAfter.auditor.enabled, false);

      console.log('PASS: ATL-108 — retireLegacyAuditorBootstrapWithoutAuthority succeeds for authority_version = 0');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-109: retireLegacyAuditorBootstrapWithoutAuthority rejects authority_version = 1
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-109');
      fs.mkdirSync(projDir, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-109', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-109',
        operation_id: 'op-109',
        audit_subject_id: 'sub-109',
        thread_id: 'thr-109',
        workspace_state_observed: 'ws-109',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      await assert.rejects(
        async () => {
          await retireLegacyAuditorBootstrapWithoutAuthority({
            projectId: 'proj-atl-109',
            registryPort,
            recoveryStore
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('authority_version is 1'));
          return true;
        }
      );

      // Active row remains
      assert.notStrictEqual(recoveryStore.getActiveBootstrap('proj-atl-109'), null);

      console.log('PASS: ATL-109 — retireLegacyAuditorBootstrapWithoutAuthority rejects authority_version = 1');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-110: Exact R8 notification-shape characterization: turn/completed with incomplete itemsView hydrates via thread/read and continues normal bootstrap to DECISION_VALIDATED without AUDIT_UNCERTAIN or uncertainty resolver
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let readThreadCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-110');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-110', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const validDecision = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-110',
        audit_subject_id: 'sub-110',
        auditor_thread_id: 'thr-atl-110',
        workspace_state_observed: 'ws-110',
        summary: 'R8 Characterization Decision validated after hydration',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'Hydrated successfully' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };

      const customAdapterFactory = async ({ phase, cwd }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-110' }),
            startTurn: async () => ({ turnId: 'turn-atl-110' }),
            waitForTurnCompletion: async () => ({
              status: 'completed',
              turn: {
                id: 'turn-atl-110',
                status: 'completed',
                itemsView: 'incomplete',
                items: []
              }
            }),
            readThread: async (params) => {
              readThreadCalled = true;
              assert.strictEqual(params.threadId, 'thr-atl-110');
              assert.strictEqual(params.includeTurns, true);
              return {
                thread: {
                  id: 'thr-atl-110',
                  turns: [
                    {
                      id: 'turn-atl-110',
                      status: 'completed',
                      itemsView: 'full',
                      items: [
                        {
                          type: 'agentMessage',
                          phase: 'final_answer',
                          text: JSON.stringify(validDecision)
                        }
                      ]
                    }
                  ]
                }
              };
            },
            close: async () => {}
          };
        }

        if (phase === 'resume_verify') {
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-110' }),
            close: async () => {}
          };
        }
      };

      const res = await bootstrapAuditorThread({
        projectId: 'proj-atl-110',
        registryPort,
        recoveryStore,
        adapterFactory: customAdapterFactory,
        workspacePort: createMockWorkspacePort('ws-110'),
        auditSubjectId: 'sub-110',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.status, 'DURABLE_BOUND');
      assert.strictEqual(readThreadCalled, true);
      // Decision parser returns null-prototype objects; normalize via JSON round-trip before comparing.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(res.decision)), validDecision);

      // Verify history proves DECISION_VALIDATED was reached without AUDIT_UNCERTAIN
      const history = recoveryStore.getHistory('proj-atl-110');
      const states = history.map(h => h.next_state);
      assert.ok(states.includes(AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED));
      assert.ok(!states.includes(AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN));
      assert.ok(!states.includes(AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION));

      // Registry is durable bound
      const projAfter = await registryPort.getProject('proj-atl-110');
      assert.strictEqual(projAfter.auditor.thread_id, 'thr-atl-110');
      assert.strictEqual(projAfter.auditor.enabled, true);

      console.log('PASS: ATL-110 — Exact R8 notification-shape characterization continues to DECISION_VALIDATED without AUDIT_UNCERTAIN');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-111: recoverAuditorBootstrap fails before provider resume when stored root does not match stored identity (zero adapterFactory calls)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let adapterFactoryCalled = false;
    let resumeCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDirA = path.join(sandbox.dir, 'proj-atl-111-a');
      const projDirB = path.join(sandbox.dir, 'proj-atl-111-b');
      fs.mkdirSync(projDirA, { recursive: true });
      fs.mkdirSync(projDirB, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { identityKey: identityA } = canonicalizeProjectRoot(projDirA);
      const { canonicalRoot: canonicalB } = canonicalizeProjectRoot(projDirB);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      // Registry points to Dir A
      await registryPort.putProject(makeValidProject('proj-atl-111', projDirA));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      // Persisted authority has expected_project_root = B, but expected_project_root_identity = identity A
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-111',
        operation_id: 'op-111',
        audit_subject_id: 'sub-111',
        thread_id: 'thr-111',
        workspace_state_observed: 'ws-111',
        authority_version: 1,
        expected_project_root: canonicalB,
        expected_project_root_identity: identityA,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-111',
        audit_subject_id: 'sub-111',
        auditor_thread_id: 'thr-111',
        workspace_state_observed: 'ws-111',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-111', operation_id: 'op-111', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-111', operation_id: 'op-111', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-111' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-111', operation_id: 'op-111', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-111',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              adapterFactoryCalled = true;
              return {
                initialize: async () => {},
                resumeThread: async () => {
                  resumeCalled = true;
                  return { threadId: 'thr-111' };
                },
                close: async () => {}
              };
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Persisted project root self-verification failed'));
          return true;
        }
      );

      assert.strictEqual(adapterFactoryCalled, false);
      assert.strictEqual(resumeCalled, false);

      // Registry remains unbound
      const projAfter = await registryPort.getProject('proj-atl-111');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      // Active recovery preserved
      const activeAfter = recoveryStore.getActiveBootstrap('proj-atl-111');
      assert.notStrictEqual(activeAfter, null);
      assert.strictEqual(activeAfter.state, AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING);

      console.log('PASS: ATL-111 — recoverAuditorBootstrap fails before provider resume when stored root does not match stored identity');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-112: resolveAuditorBootstrapUncertainty fails closed before adapterFactory when stored root does not match stored identity
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let adapterFactoryCalled = false;
    let readThreadCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDirA = path.join(sandbox.dir, 'proj-atl-112-a');
      const projDirB = path.join(sandbox.dir, 'proj-atl-112-b');
      fs.mkdirSync(projDirA, { recursive: true });
      fs.mkdirSync(projDirB, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { identityKey: identityA } = canonicalizeProjectRoot(projDirA);
      const { canonicalRoot: canonicalB } = canonicalizeProjectRoot(projDirB);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-112', projDirA));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-112',
        operation_id: 'op-112',
        audit_subject_id: 'sub-112',
        thread_id: 'thr-112',
        workspace_state_observed: 'ws-112',
        authority_version: 1,
        expected_project_root: canonicalB,
        expected_project_root_identity: identityA,
        expected_auditor_model_policy: 'auditor_standard'
      });

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-112', operation_id: 'op-112', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-112', operation_id: 'op-112', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-112' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-112', operation_id: 'op-112', next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN });

      await assert.rejects(
        async () => {
          await resolveAuditorBootstrapUncertainty({
            projectId: 'proj-atl-112',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              adapterFactoryCalled = true;
              return {
                initialize: async () => {},
                readThread: async () => {
                  readThreadCalled = true;
                  throw new Error('Should not be called');
                },
                close: async () => {}
              };
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Persisted project root self-verification failed'));
          return true;
        }
      );

      assert.strictEqual(adapterFactoryCalled, false);
      assert.strictEqual(readThreadCalled, false);

      const activeAfter = recoveryStore.getActiveBootstrap('proj-atl-112');
      assert.notStrictEqual(activeAfter, null);
      assert.strictEqual(activeAfter.state, AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN);

      console.log('PASS: ATL-112 — resolveAuditorBootstrapUncertainty fails closed before adapterFactory when stored root does not match stored identity');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-113: auditor.cwd must be proven filesystem-canonical; unprovable or missing cwd fails closed with zero provider calls
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeCalled = false;
    const origStat = fs.statSync;
    const origRealpathNative = fs.realpathSync.native;
    const origRealpath = fs.realpathSync;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-113');
      fs.mkdirSync(projDir, { recursive: true });

      const { canonicalizeProjectRoot, computeRootIdentityKey } = require('../../lib/broker/registry');
      const { canonicalRoot, identityKey } = canonicalizeProjectRoot(projDir);

      // Path that lexically resolves to projDir via path.normalize/computeRootIdentityKey
      // String concatenation prevents path.join from eagerly collapsing the missing component
      const candidateCwd = projDir + path.sep + 'missing-component-atl113' + path.sep + '..';
      const lexicalKey = computeRootIdentityKey(candidateCwd);

      // Prove that old lexical check would not be sufficient (it matches!)
      assert.strictEqual(lexicalKey, identityKey);

      // Platform portability: if the OS kernel syntactically collapses .. before stat/realpath,
      // provide deterministic fallback where filesystem proof fails for the unprovable component
      let nativeThrows = false;
      try {
        canonicalizeProjectRoot(candidateCwd);
      } catch {
        nativeThrows = true;
      }

      if (!nativeThrows) {
        const failMissing = (p) => {
          if (typeof p === 'string' && p.includes('missing-component-atl113')) {
            const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
            err.code = 'ENOENT';
            throw err;
          }
        };
        fs.statSync = (p, ...args) => {
          failMissing(p);
          return origStat.call(fs, p, ...args);
        };
        if (fs.realpathSync.native) {
          fs.realpathSync.native = (p, ...args) => {
            failMissing(p);
            return origRealpathNative.call(fs, p, ...args);
          };
        }
        fs.realpathSync = (p, ...args) => {
          failMissing(p);
          return origRealpath.call(fs, p, ...args);
        };
      }

      // Prove that new canonical check fails closed
      assert.throws(
        () => canonicalizeProjectRoot(candidateCwd),
        (err) => err.code === 'INVALID_PROJECT_ROOT' || err.code === 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED' || err.message.includes('Cannot prove canonical') || err.message.includes('does not exist')
      );

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-113', projDir));

      // Inject Registry getProject response with unprovable cwd
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        const p = await origGetProject.call(registryPort, id);
        if (p && p.auditor) {
          p.auditor = { ...p.auditor, cwd: candidateCwd };
        }
        return p;
      };

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });
      recoveryStore.beginBootstrap({
        project_id: 'proj-atl-113',
        operation_id: 'op-113',
        audit_subject_id: 'sub-113',
        thread_id: 'thr-113',
        workspace_state_observed: 'ws-113',
        authority_version: 1,
        expected_project_root: canonicalRoot,
        expected_project_root_identity: identityKey,
        expected_auditor_model_policy: 'auditor_standard'
      });

      const decPayload = {
        schema_version: 1,
        decision: 'APPROVE_WORK_PACKAGE',
        project_id: 'proj-atl-113',
        audit_subject_id: 'sub-113',
        auditor_thread_id: 'thr-113',
        workspace_state_observed: 'ws-113',
        summary: 'Decision valid',
        independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
        work_order: null,
        requested_evidence: [],
        blocker: null
      };
      const decJson = JSON.stringify(decPayload);
      const decHash = crypto.createHash('sha256').update(decJson).digest('hex');

      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-113', operation_id: 'op-113', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-113', operation_id: 'op-113', next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT, patch: { turn_id: 'turn-113' } });
      recoveryStore.transitionBootstrap({ project_id: 'proj-atl-113', operation_id: 'op-113', next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED, patch: { decision_json: decJson, decision_sha256: decHash } });

      await assert.rejects(
        async () => {
          await recoverAuditorBootstrap({
            projectId: 'proj-atl-113',
            registryPort,
            recoveryStore,
            adapterFactory: async () => {
              resumeCalled = true;
              throw new Error('Should not be called');
            }
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          return true;
        }
      );

      assert.strictEqual(resumeCalled, false);

      const projAfter = await origGetProject.call(registryPort, 'proj-atl-113');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-113 — auditor.cwd must be proven filesystem-canonical; unprovable or missing cwd fails closed with zero provider calls');
    } finally {
      fs.statSync = origStat;
      if (origRealpathNative) fs.realpathSync.native = origRealpathNative;
      fs.realpathSync = origRealpath;
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-114: bootstrapAuditorThread re-reads persisted authority row and fails closed if persisted authority disagrees with captured local variables
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let resumeVerifyCalled = false;
    let bindAuditorCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-114');
      const otherDir = path.join(sandbox.dir, 'proj-atl-114-other');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(otherDir, { recursive: true });

      const { canonicalizeProjectRoot } = require('../../lib/broker/registry');
      const { canonicalRoot: otherCanonical, identityKey: otherIdentity } = canonicalizeProjectRoot(otherDir);

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-114', projDir));

      // Wrap bindAuditorThread to track whether Registry bind is attempted
      const origBind = registryPort.bindAuditorThread;
      registryPort.bindAuditorThread = async (...args) => {
        bindAuditorCalled = true;
        return origBind.apply(registryPort, args);
      };

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      // Wrap beginBootstrap to inject an altered authority row into the database
      // while bootstrapAuditorThread's local captured variables remain correct
      const origBeginBootstrap = recoveryStore.beginBootstrap;
      recoveryStore.beginBootstrap = function(record) {
        return origBeginBootstrap.call(recoveryStore, {
          ...record,
          expected_project_root: otherCanonical,
          expected_project_root_identity: otherIdentity
        });
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-114' }),
            startTurn: async () => ({ turnId: 'turn-atl-114' }),
            close: async () => {}
          };
        }
        if (phase === 'resume_verify') {
          resumeVerifyCalled = true;
          return {
            initialize: async () => {},
            resumeThread: async () => ({ threadId: 'thr-atl-114' }),
            close: async () => {}
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-114',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => ({
              schema_version: 1,
              decision: 'APPROVE_WORK_PACKAGE',
              project_id: 'proj-atl-114',
              audit_subject_id: 'sub-114',
              auditor_thread_id: 'thr-atl-114',
              workspace_state_observed: 'ws-114',
              summary: 'Decision valid',
              independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
              work_order: null,
              requested_evidence: [],
              blocker: null
            }),
            workspacePort: createMockWorkspacePort('ws-114'),
            auditSubjectId: 'sub-114',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(
            err.message.includes('disagrees with captured bootstrap authority') ||
            err.message.includes('drift detected') ||
            err.message.includes('self-verification failed')
          );
          return true;
        }
      );

      assert.strictEqual(resumeVerifyCalled, false);
      assert.strictEqual(bindAuditorCalled, false);

      const projAfter = await registryPort.getProject('proj-atl-114');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-114 — bootstrapAuditorThread re-reads persisted authority row and fails closed if persisted authority disagrees with captured local variables');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-115: Project root drift after beginBootstrap() but before fresh pre-turn Registry read
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startThreadCalls = 0;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    let bindAuditorCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-115');
      const driftedDir = path.join(sandbox.dir, 'proj-atl-115-drifted');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(driftedDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-115', projDir));

      const origBind = registryPort.bindAuditorThread;
      registryPort.bindAuditorThread = async (...args) => {
        bindAuditorCalled = true;
        return origBind.apply(registryPort, args);
      };

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        if (getProjectCalls === 2) {
          return makeValidProject('proj-atl-115', driftedDir);
        }
        return origGetProject.call(registryPort, id);
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => {
              startThreadCalls++;
              return { threadId: 'thr-atl-115' };
            },
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-115' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-115',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-115'),
            auditSubjectId: 'sub-115',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Project root drift detected') || err.message.includes('drift detected'));
          return true;
        }
      );

      assert.strictEqual(startThreadCalls, 1);
      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);
      assert.strictEqual(bindAuditorCalled, false);

      const active = recoveryStore.getActiveBootstrap('proj-atl-115');
      assert.ok(active, 'Active bootstrap must still exist in SQLite recovery store');
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      const projAfter = await origGetProject.call(registryPort, 'proj-atl-115');
      assert.strictEqual(projAfter.auditor.thread_id, null);

      console.log('PASS: ATL-115 — project root drift before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-116: Auditor cwd drift after persistence
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-116');
      const driftedCwdDir = path.join(sandbox.dir, 'proj-atl-116-drifted-cwd');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(driftedCwdDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-116', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        const p = await origGetProject.call(registryPort, id);
        if (getProjectCalls === 2) {
          return {
            ...p,
            auditor: {
              ...p.auditor,
              cwd: driftedCwdDir
            }
          };
        }
        return p;
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-116' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-116' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-116',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-116'),
            auditSubjectId: 'sub-116',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Auditor cwd drift detected') || err.message.includes('cwd drift'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);

      const active = recoveryStore.getActiveBootstrap('proj-atl-116');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-116 — auditor.cwd drift before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-117: Model policy drift after persistence
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    let bindAuditorCalled = false;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-117');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-117', projDir));

      const origBind = registryPort.bindAuditorThread;
      registryPort.bindAuditorThread = async (...args) => {
        bindAuditorCalled = true;
        return origBind.apply(registryPort, args);
      };

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        const p = await origGetProject.call(registryPort, id);
        if (getProjectCalls === 2) {
          return {
            ...p,
            auditor: {
              ...p.auditor,
              model_policy: 'auditor_mutated_policy'
            }
          };
        }
        return p;
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-117' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-117' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-117',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-117'),
            auditSubjectId: 'sub-117',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Auditor model policy drift detected') || err.message.includes('model policy drift'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);
      assert.strictEqual(bindAuditorCalled, false);

      const active = recoveryStore.getActiveBootstrap('proj-atl-117');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-117 — auditor.model_policy drift before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-118: Auditor becomes bound in Registry after persistence
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-118');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-118', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        const p = await origGetProject.call(registryPort, id);
        if (getProjectCalls === 2) {
          return {
            ...p,
            auditor: {
              ...p.auditor,
              thread_id: 'some-other-thread',
              enabled: false
            }
          };
        }
        return p;
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-118' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-118' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-118',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-118'),
            auditSubjectId: 'sub-118',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('auditor became bound before first turn'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);

      const active = recoveryStore.getActiveBootstrap('proj-atl-118');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-118 — auditor becomes bound before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-119: Auditor enabled drift (thread_id == null, enabled == true)
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-119');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-119', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        const proj = await origGetProject.call(registryPort, id);
        if (getProjectCalls === 2) {
          return {
            ...proj,
            auditor: {
              ...proj.auditor,
              thread_id: null,
              enabled: true
            }
          };
        }
        return proj;
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-119' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-119' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-119',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-119'),
            auditSubjectId: 'sub-119',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('auditor became enabled before first turn'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);

      const active = recoveryStore.getActiveBootstrap('proj-atl-119');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-119 — auditor became enabled before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-120: Project missing on fresh pre-turn Registry read
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-120');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-120', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        if (getProjectCalls === 2) {
          return null;
        }
        return origGetProject.call(registryPort, id);
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-120' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-120' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-120',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-120'),
            auditSubjectId: 'sub-120',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('missing in registry before first turn'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);

      const active = recoveryStore.getActiveBootstrap('proj-atl-120');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-120 — project missing on fresh pre-turn read fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-121: Fresh post-persistence Registry read throws
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    let startTurnCalls = 0;
    let client1CloseCalls = 0;
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-121');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-121', projDir));

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      let getProjectCalls = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCalls++;
        if (getProjectCalls === 2) {
          throw new Error('Disk I/O error reading registry');
        }
        return origGetProject.call(registryPort, id);
      };

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => ({ threadId: 'thr-atl-121' }),
            startTurn: async () => {
              startTurnCalls++;
              return { turnId: 'turn-atl-121' };
            },
            close: async () => {
              client1CloseCalls++;
            }
          };
        }
      };

      await assert.rejects(
        async () => {
          await bootstrapAuditorThread({
            projectId: 'proj-atl-121',
            registryPort,
            recoveryStore,
            adapterFactory,
            awaitAuditDecision: async () => {},
            workspacePort: createMockWorkspacePort('ws-121'),
            auditSubjectId: 'sub-121',
            auditPrompt: DEFAULT_AUDIT_PROMPT
          });
        },
        (err) => {
          assert.strictEqual(err.code, LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED);
          assert.ok(err.message.includes('Failed to read fresh registry state before first turn'));
          return true;
        }
      );

      assert.strictEqual(startTurnCalls, 0);
      assert.strictEqual(client1CloseCalls, 1);

      const active = recoveryStore.getActiveBootstrap('proj-atl-121');
      assert.ok(active);
      assert.strictEqual(active.state, AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD);

      console.log('PASS: ATL-121 — fresh registry read failure before first turn fails closed with 0 turns and PROVISIONAL_THREAD state');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  // ATL-122: Success path proves fresh Registry read before first turn, reaching DURABLE_BOUND
  {
    const sandbox = createTestSandbox();
    let recoveryStore = null;
    const eventSequence = [];
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const dbFile = path.join(sandbox.dir, 'recovery.db');
      const projDir = path.join(sandbox.dir, 'proj-atl-122');
      fs.mkdirSync(projDir, { recursive: true });

      const registryPort = createProjectRegistry({ registryFilePath: regFile });
      await registryPort.putProject(makeValidProject('proj-atl-122', projDir));

      let getProjectCount = 0;
      const origGetProject = registryPort.getProject;
      registryPort.getProject = async (id) => {
        getProjectCount++;
        eventSequence.push(`getProject_${getProjectCount}`);
        return origGetProject.call(registryPort, id);
      };

      recoveryStore = createSqliteAuditorRecoveryStoreRaw({ dbPath: dbFile });

      const origBeginBootstrap = recoveryStore.beginBootstrap;
      recoveryStore.beginBootstrap = function(record) {
        eventSequence.push('beginBootstrap');
        return origBeginBootstrap.call(recoveryStore, record);
      };

      const origTransition = recoveryStore.transitionBootstrap;
      recoveryStore.transitionBootstrap = function(record) {
        eventSequence.push(`transition_${record.next_state}`);
        return origTransition.call(recoveryStore, record);
      };

      let freshReadObservedInStartTurn = false;
      let stateInStartTurn = null;

      const adapterFactory = async ({ phase }) => {
        if (phase === 'provisional') {
          return {
            initialize: async () => {},
            startThread: async () => {
              eventSequence.push('startThread');
              return { threadId: 'thr-atl-122' };
            },
            startTurn: async () => {
              eventSequence.push('startTurn');
              freshReadObservedInStartTurn = (getProjectCount >= 2);
              const active = recoveryStore.getActiveBootstrap('proj-atl-122');
              stateInStartTurn = active ? active.state : null;
              return { turnId: 'turn-atl-122' };
            },
            close: async () => {
              eventSequence.push('close_client1');
            }
          };
        }
        if (phase === 'resume_verify') {
          return {
            initialize: async () => {},
            resumeThread: async () => {
              eventSequence.push('resumeThread');
              return { threadId: 'thr-atl-122' };
            },
            close: async () => {
              eventSequence.push('close_client2');
            }
          };
        }
      };

      const result = await bootstrapAuditorThread({
        projectId: 'proj-atl-122',
        registryPort,
        recoveryStore,
        adapterFactory,
        awaitAuditDecision: async () => ({
          schema_version: 1,
          decision: 'APPROVE_WORK_PACKAGE',
          project_id: 'proj-atl-122',
          audit_subject_id: 'sub-122',
          auditor_thread_id: 'thr-atl-122',
          workspace_state_observed: 'ws-122',
          summary: 'Decision valid',
          independent_verification: [{ kind: 'SOURCE_INSPECTION', result: 'PASS', evidence: 'OK' }],
          work_order: null,
          requested_evidence: [],
          blocker: null
        }),
        workspacePort: createMockWorkspacePort('ws-122'),
        auditSubjectId: 'sub-122',
        auditPrompt: DEFAULT_AUDIT_PROMPT
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.status, 'DURABLE_BOUND');
      assert.strictEqual(result.thread_id, 'thr-atl-122');

      assert.strictEqual(freshReadObservedInStartTurn, true, 'startTurn must see that fresh pre-turn read (getProject_2) already occurred');
      assert.strictEqual(stateInStartTurn, AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING, 'startTurn must occur after transition to FIRST_TURN_STARTING');

      // Verify sequence: getProject_1 -> startThread -> beginBootstrap -> getProject_2 -> transition_FIRST_TURN_STARTING -> startTurn
      const idxP1 = eventSequence.indexOf('getProject_1');
      const idxST = eventSequence.indexOf('startThread');
      const idxBB = eventSequence.indexOf('beginBootstrap');
      const idxP2 = eventSequence.indexOf('getProject_2');
      const idxTrFTS = eventSequence.indexOf('transition_FIRST_TURN_STARTING');
      const idxTurn = eventSequence.indexOf('startTurn');

      assert.ok(idxP1 !== -1 && idxST !== -1 && idxBB !== -1 && idxP2 !== -1 && idxTrFTS !== -1 && idxTurn !== -1);
      assert.ok(idxP1 < idxST, 'initial getProject must precede startThread');
      assert.ok(idxST < idxBB, 'startThread must precede beginBootstrap');
      assert.ok(idxBB < idxP2, 'beginBootstrap must precede second getProject');
      assert.ok(idxP2 < idxTrFTS, 'second getProject must precede transition to FIRST_TURN_STARTING');
      assert.ok(idxTrFTS < idxTurn, 'transition to FIRST_TURN_STARTING must precede startTurn');

      // Verify active recovery row is deleted on success
      const activeAfter = recoveryStore.getActiveBootstrap('proj-atl-122');
      assert.strictEqual(activeAfter, null);

      // Verify registry has bound thread
      const projAfter = await registryPort.getProject('proj-atl-122');
      assert.strictEqual(projAfter.auditor.thread_id, 'thr-atl-122');
      assert.strictEqual(projAfter.auditor.enabled, true);

      console.log('PASS: ATL-122 — success path proves fresh Registry read before FIRST_TURN_STARTING and turn/start, reaching DURABLE_BOUND');
    } finally {
      if (recoveryStore) recoveryStore.close();
      sandbox.cleanup();
    }
  }

  console.log('\n======================================================================');
  console.log('ALL AUDITOR THREAD LIFECYCLE TESTS PASSED (ATL-001 .. ATL-122: 122/122 PASS)');
  console.log('======================================================================\n');
}

runAllTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('[TEST SUITE FAILURE]', err);
    process.exit(1);
  });

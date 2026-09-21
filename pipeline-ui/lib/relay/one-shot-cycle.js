'use strict';

const { canonicalizeProjectRoot } = require('../broker/registry');
const {
  AUDIT_DECISIONS,
  buildAuditDecisionV1OutputSchema,
  awaitAuditDecisionV1
} = require('./audit-decision');
const { resolveAuditorModelPolicy } = require('../auditor/model-policy-resolver');
const { LIMITS: BROKER_LIMITS } = require('../broker/contracts');

const MAX_AUDIT_SUBJECT_ID_BYTES = 512;
const MAX_PROMPT_TEXT_BYTES = 1024 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 60000;
const MIN_TURN_TIMEOUT_MS = 1;
const MAX_TURN_TIMEOUT_MS = 2147483647;
const MAX_RESULT_CODE_BYTES = 128;

/**
 * Validate and bound external / propagated result code.
 */
function sanitizePropagatedCode(code, fallbackCode) {
  if (
    typeof code === 'string' &&
    code.length > 0 &&
    code.trim() === code &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(code) &&
    Buffer.byteLength(code, 'utf8') <= MAX_RESULT_CODE_BYTES
  ) {
    return code;
  }
  return fallbackCode;
}

/**
 * Validate that prompt items conform to production adapter text-input contract.
 */
function validatePrompt(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    return false;
  }
  let totalBytes = 0;
  for (let i = 0; i < prompt.length; i++) {
    const item = prompt[i];
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.type !== 'text' ||
      typeof item.text !== 'string'
    ) {
      return false;
    }
    totalBytes += Buffer.byteLength(item.text, 'utf8');
    if (totalBytes > MAX_PROMPT_TEXT_BYTES) {
      return false;
    }
  }
  return true;
}

/**
 * Deep equality helper for bounded configuration comparison.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Validate that a fresh registry project matches captured Gate-A authority.
 */
function validateRegistryAuthority(project, captured) {
  if (!project || typeof project !== 'object') return false;
  if (project.project_id !== captured.project_id) return false;

  if (!project.auditor || typeof project.auditor !== 'object') return false;
  if (project.auditor.thread_id !== captured.auditor_thread_id) return false;
  if (project.auditor.enabled !== captured.auditor_enabled) return false;
  if (!deepEqual(project.auditor.model_policy, captured.auditor_model_policy)) return false;

  if (!project.worker || typeof project.worker !== 'object') return false;
  if (project.worker.engine !== captured.worker_engine) return false;
  if (project.worker.session_id !== captured.worker_session_id) return false;
  if (project.worker.enabled !== captured.worker_enabled) return false;
  if (!deepEqual(project.worker.model_policy, captured.worker_model_policy)) return false;

  if (!project.policy || typeof project.policy !== 'object') return false;
  if (project.policy.require_workspace_state !== captured.policy_require_workspace_state) return false;
  if (project.policy.max_active_dispatches !== captured.policy_max_active_dispatches) return false;

  try {
    const rootAuth = canonicalizeProjectRoot(project.project_root);
    const cwdAuth = canonicalizeProjectRoot(project.auditor.cwd);
    if (!rootAuth || !cwdAuth) return false;
    if (rootAuth.identityKey !== captured.canonicalProjectRootIdentity) return false;
    if (cwdAuth.identityKey !== captured.canonicalProjectRootIdentity) return false;
  } catch (_err) {
    return false;
  }

  return true;
}

/**
 * Validate that a workspace state snapshot conforms to expected bounded shape.
 */
function validateWorkspaceSnapshot(snapshot, expectedProjectId, canonicalProjectRootIdentity) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (
    !snapshot.workspace_state_id ||
    typeof snapshot.workspace_state_id !== 'string' ||
    snapshot.workspace_state_id.trim().length === 0
  ) {
    return false;
  }
  if (snapshot.project_id !== expectedProjectId) return false;

  try {
    const rootAuth = canonicalizeProjectRoot(snapshot.project_root);
    if (!rootAuth || rootAuth.identityKey !== canonicalProjectRootIdentity) return false;
  } catch (_err) {
    return false;
  }
  return true;
}

/**
 * Classify startTurn errors.
 */
function classifyStartTurnError(err) {
  if (err && err.code === 'CODEX_APP_SERVER_REQUEST_UNCERTAIN') {
    return { status: 'FAILED', code: 'AUDITOR_TURN_UNCERTAIN' };
  }
  return { status: 'FAILED', code: 'AUDITOR_TURN_FAILED' };
}

/**
 * Classify awaitAuditDecisionV1 errors.
 */
function classifyAwaitDecisionError(err) {
  if (err && err.code === 'AUDIT_DECISION_TURN_NOT_COMPLETED') {
    return { status: 'FAILED', code: 'AUDITOR_TURN_FAILED' };
  }
  if (err && typeof err.code === 'string' && err.code.startsWith('AUDIT_DECISION_')) {
    return { status: 'FAILED', code: 'DECISION_INVALID' };
  }
  return { status: 'FAILED', code: 'AUDITOR_TURN_UNCERTAIN' };
}

/**
 * Construct the bounded result envelope.
 */
function buildEnvelope({
  status,
  code = null,
  projectId = null,
  auditSubjectId = null,
  auditorThreadId = null,
  turnADecision = null,
  dispatchId = null,
  workerState = null,
  turnBDecision = null,
  s0 = null,
  s1 = null,
  s2 = null,
  s3 = null,
  cleanup = { auditor_close: 'NOT_REQUIRED', code: null }
}) {
  return {
    ok: status !== 'FAILED',
    status,
    code: status === 'FAILED' ? (typeof code === 'string' ? sanitizePropagatedCode(code, 'FAILED') : null) : null,
    project_id: projectId,
    audit_subject_id: auditSubjectId,
    auditor_thread_id: auditorThreadId,
    turn_a_decision: turnADecision,
    dispatch_id: dispatchId,
    worker_state: workerState,
    turn_b_decision: turnBDecision,
    workspace: {
      s0,
      s1,
      s2,
      s3
    },
    cleanup
  };
}

/**
 * Orchestrate a complete one-shot cycle across Native Codex auditor and generic worker.
 *
 * @param {Object} options Coordinator options
 * @returns {Promise<Object>} Bounded result envelope
 */
async function runOneShotCycle(options = {}) {
  const {
    projectId,
    auditSubjectId,
    auditPrompt,
    reviewPrompt,
    registryPort,
    workspacePort,
    broker,
    auditorFactory,
    turnTimeoutMs: rawTurnTimeoutMs,
    workerWaitTimeoutSecs: rawWorkerWaitTimeoutSecs
  } = options || {};

  // Validate semantic inputs before any side effect
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId: null,
      auditSubjectId: null
    });
  }

  if (
    typeof auditSubjectId !== 'string' ||
    auditSubjectId.length === 0 ||
    auditSubjectId.trim() !== auditSubjectId ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(auditSubjectId) ||
    Buffer.byteLength(auditSubjectId, 'utf8') > MAX_AUDIT_SUBJECT_ID_BYTES
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId: null
    });
  }

  if (!validatePrompt(auditPrompt)) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  if (!validatePrompt(reviewPrompt)) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  if (
    !registryPort ||
    typeof registryPort.getProject !== 'function' ||
    !workspacePort ||
    typeof workspacePort.getWorkspaceState !== 'function' ||
    !broker ||
    typeof broker.getWorkerStatus !== 'function' ||
    typeof broker.dispatchWorker !== 'function' ||
    typeof broker.waitWorker !== 'function' ||
    typeof auditorFactory !== 'function'
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS;
  if (rawTurnTimeoutMs !== undefined) {
    if (
      typeof rawTurnTimeoutMs !== 'number' ||
      !Number.isFinite(rawTurnTimeoutMs) ||
      !Number.isInteger(rawTurnTimeoutMs) ||
      rawTurnTimeoutMs < MIN_TURN_TIMEOUT_MS ||
      rawTurnTimeoutMs > MAX_TURN_TIMEOUT_MS
    ) {
      return buildEnvelope({
        status: 'FAILED',
        code: 'STARTING_STATE_INVALID',
        projectId,
        auditSubjectId
      });
    }
    turnTimeoutMs = rawTurnTimeoutMs;
  }

  let workerWaitTimeoutSecs = BROKER_LIMITS.DEFAULT_TIMEOUT_SECS;
  if (rawWorkerWaitTimeoutSecs !== undefined) {
    if (typeof rawWorkerWaitTimeoutSecs !== 'number' || !Number.isFinite(rawWorkerWaitTimeoutSecs)) {
      return buildEnvelope({
        status: 'FAILED',
        code: 'STARTING_STATE_INVALID',
        projectId,
        auditSubjectId
      });
    }
    workerWaitTimeoutSecs = Math.min(
      BROKER_LIMITS.MAX_TIMEOUT_SECS,
      Math.max(BROKER_LIMITS.MIN_TIMEOUT_SECS, rawWorkerWaitTimeoutSecs)
    );
  }

  // Gate A: Fresh Registry authority
  let projectA;
  try {
    projectA = await registryPort.getProject(projectId);
  } catch (_err) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  if (!projectA || typeof projectA !== 'object' || projectA.project_id !== projectId) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  if (!projectA.auditor || typeof projectA.auditor !== 'object') {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId
    });
  }

  if (
    !projectA.auditor.thread_id ||
    typeof projectA.auditor.thread_id !== 'string' ||
    projectA.auditor.thread_id.trim().length === 0 ||
    projectA.auditor.enabled !== true
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'AUDITOR_UNAVAILABLE',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id || null
    });
  }

  if (
    !projectA.auditor.model_policy ||
    (typeof projectA.auditor.model_policy !== 'string' && typeof projectA.auditor.model_policy !== 'object')
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  if (!projectA.worker || typeof projectA.worker !== 'object') {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  if (
    projectA.worker.enabled !== true ||
    projectA.worker.engine !== 'antigravity' ||
    typeof projectA.worker.session_id !== 'string' ||
    projectA.worker.session_id.trim().length === 0
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  if (!projectA.policy || typeof projectA.policy !== 'object') {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  if (
    projectA.policy.require_workspace_state !== true ||
    projectA.policy.max_active_dispatches !== 1
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  // Canonicalize project root and auditor cwd at Gate A
  let rootAuthorityA;
  let cwdAuthorityA;
  try {
    rootAuthorityA = canonicalizeProjectRoot(projectA.project_root);
    cwdAuthorityA = canonicalizeProjectRoot(projectA.auditor.cwd);
  } catch (_err) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  if (
    !rootAuthorityA ||
    !cwdAuthorityA ||
    rootAuthorityA.identityKey !== cwdAuthorityA.identityKey
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: 'STARTING_STATE_INVALID',
      projectId,
      auditSubjectId,
      auditorThreadId: projectA.auditor.thread_id
    });
  }

  const canonicalProjectRoot = rootAuthorityA.canonicalRoot;
  const canonicalProjectRootIdentity = rootAuthorityA.identityKey;

  // Capture immutable cycle authority
  const capturedAuthority = {
    project_id: projectA.project_id,
    canonicalProjectRootIdentity,
    auditor_thread_id: projectA.auditor.thread_id,
    auditor_enabled: projectA.auditor.enabled,
    auditor_model_policy: projectA.auditor.model_policy,
    worker_engine: projectA.worker.engine,
    worker_session_id: projectA.worker.session_id,
    worker_enabled: projectA.worker.enabled,
    worker_model_policy: projectA.worker.model_policy,
    policy_require_workspace_state: projectA.policy.require_workspace_state,
    policy_max_active_dispatches: projectA.policy.max_active_dispatches
  };

  const exactThreadId = projectA.auditor.thread_id;

  // Gate A: Worker IDLE check before factory
  let workerStatus;
  try {
    workerStatus = await broker.getWorkerStatus(projectId);
  } catch (err) {
    return buildEnvelope({
      status: 'FAILED',
      code: sanitizePropagatedCode(err?.code, 'WORKER_BUSY'),
      projectId,
      auditSubjectId,
      auditorThreadId: exactThreadId
    });
  }

  if (
    !workerStatus ||
    workerStatus.ok !== true ||
    workerStatus.worker_state !== 'IDLE' ||
    workerStatus.active_dispatch_id !== null ||
    workerStatus.active_work_order_id !== null
  ) {
    return buildEnvelope({
      status: 'FAILED',
      code: sanitizePropagatedCode(workerStatus?.code, 'WORKER_BUSY'),
      projectId,
      auditSubjectId,
      auditorThreadId: exactThreadId
    });
  }

  // Tracking state across lifecycle
  let auditor = null;
  let cleanup = {
    auditor_close: 'NOT_REQUIRED',
    code: null
  };

  let candidateResult = null;
  let s0Snapshot = null;
  let s1Snapshot = null;
  let s2Snapshot = null;
  let s3Snapshot = null;
  let turnADecision = null;
  let turnBDecision = null;
  let ownedDispatchId = null;
  let currentWorkerState = null;

  try {
    // Factory call
    try {
      auditor = await auditorFactory({
        phase: 'one_shot_cycle',
        cwd: canonicalProjectRoot
      });
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUDITOR_UNAVAILABLE' };
      return assembleFinal();
    }

    // Validate returned adapter interface
    if (
      !auditor ||
      typeof auditor !== 'object' ||
      typeof auditor.initialize !== 'function' ||
      typeof auditor.resumeThread !== 'function' ||
      typeof auditor.listModels !== 'function' ||
      typeof auditor.startTurn !== 'function' ||
      typeof auditor.waitForTurnCompletion !== 'function' ||
      typeof auditor.readThread !== 'function' ||
      typeof auditor.close !== 'function'
    ) {
      candidateResult = { status: 'FAILED', code: 'AUDITOR_UNAVAILABLE' };
      return assembleFinal();
    }

    // Initialize then exact resume
    try {
      await auditor.initialize();
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUDITOR_UNAVAILABLE' };
      return assembleFinal();
    }

    let resumed;
    try {
      resumed = await auditor.resumeThread({ threadId: exactThreadId });
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'THREAD_RESUME_MISMATCH' };
      return assembleFinal();
    }

    const resumedId = resumed?.threadId || resumed?.thread_id || resumed?.id;
    if (resumedId !== exactThreadId) {
      candidateResult = { status: 'FAILED', code: 'THREAD_RESUME_MISMATCH' };
      return assembleFinal();
    }

    // List models and pin model policy
    let resolved;
    try {
      const catalog = await auditor.listModels();
      resolved = resolveAuditorModelPolicy({
        policy: projectA.auditor.model_policy,
        models: catalog
      });
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'MODEL_POLICY_UNAVAILABLE' };
      return assembleFinal();
    }

    if (!resolved || !resolved.model || !resolved.reasoning_effort) {
      candidateResult = { status: 'FAILED', code: 'MODEL_POLICY_UNAVAILABLE' };
      return assembleFinal();
    }

    // Gate B: Fresh Registry read
    let projectB;
    try {
      projectB = await registryPort.getProject(projectId);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    if (!validateRegistryAuthority(projectB, capturedAuthority)) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    // Compute S0
    let S0;
    try {
      S0 = await workspacePort.getWorkspaceState(projectB);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (!validateWorkspaceSnapshot(S0, projectId, canonicalProjectRootIdentity)) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }
    s0Snapshot = S0;

    // Turn A context & execution
    const expectedContextA = {
      project_id: projectId,
      audit_subject_id: auditSubjectId,
      auditor_thread_id: exactThreadId,
      workspace_state_observed: S0.workspace_state_id
    };
    const outputSchemaA = buildAuditDecisionV1OutputSchema(expectedContextA);

    let startA;
    try {
      startA = await auditor.startTurn({
        threadId: exactThreadId,
        input: auditPrompt,
        outputSchema: outputSchemaA,
        model: resolved.model,
        effort: resolved.reasoning_effort
      });
    } catch (err) {
      const classified = classifyStartTurnError(err);
      candidateResult = { status: classified.status, code: classified.code };
      return assembleFinal();
    }

    if (!startA || typeof startA.turnId !== 'string' || startA.turnId.length === 0) {
      candidateResult = { status: 'FAILED', code: 'AUDITOR_TURN_FAILED' };
      return assembleFinal();
    }

    let decisionA;
    try {
      decisionA = await awaitAuditDecisionV1(auditor, {
        threadId: exactThreadId,
        turnId: startA.turnId,
        expectedContext: expectedContextA,
        timeoutMs: turnTimeoutMs
      });
    } catch (err) {
      const classified = classifyAwaitDecisionError(err);
      candidateResult = { status: classified.status, code: classified.code };
      return assembleFinal();
    }

    turnADecision = decisionA;

    // Turn A semantic branches
    if (decisionA.decision === AUDIT_DECISIONS.REQUEST_EVIDENCE) {
      candidateResult = { status: 'EVIDENCE_REQUIRED', code: null };
      return assembleFinal();
    }
    if (decisionA.decision === AUDIT_DECISIONS.APPROVE_WORK_PACKAGE) {
      candidateResult = { status: 'APPROVED_WITHOUT_DISPATCH', code: null };
      return assembleFinal();
    }
    if (decisionA.decision === AUDIT_DECISIONS.BLOCKED) {
      candidateResult = { status: 'BLOCKED', code: null };
      return assembleFinal();
    }
    if (decisionA.decision === AUDIT_DECISIONS.STOP) {
      candidateResult = { status: 'STOPPED', code: null };
      return assembleFinal();
    }
    if (decisionA.decision !== AUDIT_DECISIONS.DISPATCH_WORKER) {
      candidateResult = { status: 'FAILED', code: 'DECISION_INVALID' };
      return assembleFinal();
    }

    // DISPATCH_WORKER validation
    if (
      !decisionA.work_order ||
      typeof decisionA.work_order !== 'object' ||
      typeof decisionA.work_order.work_order_id !== 'string' ||
      decisionA.work_order.work_order_id.length === 0 ||
      typeof decisionA.work_order.directive !== 'string' ||
      decisionA.work_order.directive.length === 0
    ) {
      candidateResult = { status: 'FAILED', code: 'DECISION_INVALID' };
      return assembleFinal();
    }

    // Gate C: Fresh Registry read
    let projectC;
    try {
      projectC = await registryPort.getProject(projectId);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    if (!validateRegistryAuthority(projectC, capturedAuthority)) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    // Worker model policy check
    if (decisionA.work_order.worker_model_policy !== projectC.worker.model_policy) {
      candidateResult = { status: 'FAILED', code: 'WORKER_POLICY_MISMATCH' };
      return assembleFinal();
    }

    // S1 Freshness check
    let S1;
    try {
      S1 = await workspacePort.getWorkspaceState(projectC);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (!validateWorkspaceSnapshot(S1, projectId, canonicalProjectRootIdentity)) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (
      S1.workspace_state_id !== S0.workspace_state_id ||
      S1.workspace_state_id !== decisionA.workspace_state_observed
    ) {
      candidateResult = { status: 'FAILED', code: 'STALE_AUDIT_STATE' };
      return assembleFinal();
    }
    s1Snapshot = S1;

    // Worker Dispatch
    let dispatchResult;
    try {
      dispatchResult = await broker.dispatchWorker({
        schema_version: 1,
        project_id: projectId,
        work_order_id: decisionA.work_order.work_order_id,
        expected_workspace_state_id: S0.workspace_state_id,
        directive: decisionA.work_order.directive
      });
    } catch (err) {
      candidateResult = {
        status: 'FAILED',
        code: sanitizePropagatedCode(err?.code, 'DISPATCH_RESULT_INVALID')
      };
      return assembleFinal();
    }

    if (!dispatchResult || typeof dispatchResult !== 'object') {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    if (dispatchResult.ok === false) {
      candidateResult = {
        status: 'FAILED',
        code: sanitizePropagatedCode(dispatchResult.code, 'DISPATCH_RESULT_INVALID')
      };
      return assembleFinal();
    }

    if (dispatchResult.ok === true && dispatchResult.idempotent_replay === true) {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_REPLAY_NOT_OWNED' };
      return assembleFinal();
    }

    if (
      dispatchResult.ok !== true ||
      dispatchResult.idempotent_replay === true ||
      dispatchResult.state !== 'DISPATCH_ACCEPTED' ||
      typeof dispatchResult.dispatch_id !== 'string' ||
      dispatchResult.dispatch_id.length === 0 ||
      dispatchResult.work_order_id !== decisionA.work_order.work_order_id ||
      dispatchResult.project_id !== projectId
    ) {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    ownedDispatchId = dispatchResult.dispatch_id;
    currentWorkerState = dispatchResult.state;

    // Worker Wait
    let waitResult;
    try {
      waitResult = await broker.waitWorker({
        project_id: projectId,
        dispatch_id: ownedDispatchId,
        timeout_secs: workerWaitTimeoutSecs
      });
    } catch (err) {
      candidateResult = {
        status: 'FAILED',
        code: sanitizePropagatedCode(err?.code, 'DISPATCH_RESULT_INVALID')
      };
      return assembleFinal();
    }

    if (!waitResult || typeof waitResult !== 'object') {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    if (waitResult.ok === false) {
      candidateResult = {
        status: 'FAILED',
        code: sanitizePropagatedCode(waitResult.code, 'DISPATCH_RESULT_INVALID')
      };
      return assembleFinal();
    }

    if (waitResult.dispatch_id !== ownedDispatchId) {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    if (
      waitResult.work_order_id !== undefined &&
      waitResult.work_order_id !== null &&
      waitResult.work_order_id !== decisionA.work_order.work_order_id
    ) {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    if (waitResult.state === 'DISPATCH_ACCEPTED' || waitResult.state === 'RUNNING') {
      currentWorkerState = waitResult.state;
      candidateResult = { status: 'WORKER_PENDING', code: null };
      return assembleFinal();
    }

    if (waitResult.state !== 'READY_FOR_REVIEW') {
      candidateResult = { status: 'FAILED', code: 'DISPATCH_RESULT_INVALID' };
      return assembleFinal();
    }

    currentWorkerState = waitResult.state;

    // Gate D: Fresh Registry read
    let projectD;
    try {
      projectD = await registryPort.getProject(projectId);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    if (!validateRegistryAuthority(projectD, capturedAuthority)) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    // S2 Snapshot
    let S2;
    try {
      S2 = await workspacePort.getWorkspaceState(projectD);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (!validateWorkspaceSnapshot(S2, projectId, canonicalProjectRootIdentity)) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }
    s2Snapshot = S2;

    // Turn B: Same thread review
    const expectedContextB = {
      project_id: projectId,
      audit_subject_id: auditSubjectId,
      auditor_thread_id: exactThreadId,
      workspace_state_observed: S2.workspace_state_id
    };
    const outputSchemaB = buildAuditDecisionV1OutputSchema(expectedContextB);

    let startB;
    try {
      startB = await auditor.startTurn({
        threadId: exactThreadId,
        input: reviewPrompt,
        outputSchema: outputSchemaB,
        model: resolved.model,
        effort: resolved.reasoning_effort
      });
    } catch (err) {
      const classified = classifyStartTurnError(err);
      candidateResult = { status: classified.status, code: classified.code };
      return assembleFinal();
    }

    if (!startB || typeof startB.turnId !== 'string' || startB.turnId.length === 0) {
      candidateResult = { status: 'FAILED', code: 'AUDITOR_TURN_FAILED' };
      return assembleFinal();
    }

    let decisionB;
    try {
      decisionB = await awaitAuditDecisionV1(auditor, {
        threadId: exactThreadId,
        turnId: startB.turnId,
        expectedContext: expectedContextB,
        timeoutMs: turnTimeoutMs
      });
    } catch (err) {
      const classified = classifyAwaitDecisionError(err);
      candidateResult = { status: classified.status, code: classified.code };
      return assembleFinal();
    }

    turnBDecision = decisionB;

    if (decisionB.decision === AUDIT_DECISIONS.REQUEST_EVIDENCE) {
      candidateResult = { status: 'EVIDENCE_REQUIRED', code: null };
      return assembleFinal();
    }
    if (decisionB.decision === AUDIT_DECISIONS.BLOCKED) {
      candidateResult = { status: 'BLOCKED', code: null };
      return assembleFinal();
    }
    if (decisionB.decision === AUDIT_DECISIONS.STOP) {
      candidateResult = { status: 'STOPPED', code: null };
      return assembleFinal();
    }
    if (decisionB.decision === AUDIT_DECISIONS.DISPATCH_WORKER) {
      candidateResult = { status: 'CYCLE_LIMIT_REACHED', code: null };
      return assembleFinal();
    }
    if (decisionB.decision !== AUDIT_DECISIONS.APPROVE_WORK_PACKAGE) {
      candidateResult = { status: 'FAILED', code: 'DECISION_INVALID' };
      return assembleFinal();
    }

    // Final Gate: Fresh Registry read
    let projectFinal;
    try {
      projectFinal = await registryPort.getProject(projectId);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    if (!validateRegistryAuthority(projectFinal, capturedAuthority)) {
      candidateResult = { status: 'FAILED', code: 'AUTHORITY_DRIFT' };
      return assembleFinal();
    }

    // S3 Freshness check
    let S3;
    try {
      S3 = await workspacePort.getWorkspaceState(projectFinal);
    } catch (_err) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (!validateWorkspaceSnapshot(S3, projectId, canonicalProjectRootIdentity)) {
      candidateResult = { status: 'FAILED', code: 'WORKSPACE_STATE_FAILED' };
      return assembleFinal();
    }

    if (S3.workspace_state_id !== S2.workspace_state_id) {
      candidateResult = { status: 'FAILED', code: 'STALE_AUDIT_STATE' };
      return assembleFinal();
    }
    s3Snapshot = S3;

    candidateResult = { status: 'APPROVED', code: null };
    return assembleFinal();
  } catch (unexpectedErr) {
    if (!candidateResult) {
      candidateResult = {
        status: 'FAILED',
        code: sanitizePropagatedCode(unexpectedErr?.code, 'STARTING_STATE_INVALID')
      };
    }
    return assembleFinal();
  } finally {
    if (auditor && typeof auditor.close === 'function') {
      try {
        await auditor.close();
        cleanup.auditor_close = 'SUCCEEDED';
        cleanup.code = null;
      } catch (_closeErr) {
        cleanup.auditor_close = 'FAILED';
        cleanup.code = 'AUDITOR_CLOSE_FAILED';
      }
    }
    return assembleFinal();
  }

  function assembleFinal() {
    let finalStatus = candidateResult?.status || 'FAILED';
    let finalCode = candidateResult?.code || null;

    if (cleanup.auditor_close === 'FAILED') {
      if (finalStatus === 'FAILED') {
        // Primary operational failure is authoritative
      } else if (finalStatus === 'WORKER_PENDING') {
        // WORKER_PENDING preserved
      } else {
        // Non-operational semantic/success result overridden by close failure
        finalStatus = 'FAILED';
        finalCode = 'AUDITOR_CLOSE_FAILED';
      }
    }

    return buildEnvelope({
      status: finalStatus,
      code: finalCode,
      projectId,
      auditSubjectId,
      auditorThreadId: exactThreadId,
      turnADecision,
      dispatchId: ownedDispatchId,
      workerState: currentWorkerState,
      turnBDecision,
      s0: s0Snapshot,
      s1: s1Snapshot,
      s2: s2Snapshot,
      s3: s3Snapshot,
      cleanup
    });
  }
}

module.exports = {
  runOneShotCycle
};

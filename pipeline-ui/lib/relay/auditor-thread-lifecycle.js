'use strict';

const crypto = require('crypto');
const {
  AUDITOR_BOOTSTRAP_STATES,
  RECOVERY_ERROR_CODES
} = require('./sqlite-auditor-recovery-store');
const {
  awaitAuditDecisionV1,
  buildAuditDecisionV1OutputSchema,
  parseStrictJson,
  validateAuditDecisionV1
} = require('./audit-decision');
const {
  REGISTRY_ERROR_CODES,
  getAuditorBindingState
} = require('../broker/registry');

/**
 * Machine-readable Lifecycle Error Codes
 */
const LIFECYCLE_ERROR_CODES = Object.freeze({
  AUDITOR_LIFECYCLE_INVALID_REQUEST: 'AUDITOR_LIFECYCLE_INVALID_REQUEST',
  AUDITOR_LIFECYCLE_PRECONDITION_FAILED: 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED',
  AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS: 'AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS',
  AUDITOR_LIFECYCLE_PROVISIONAL_FAILED: 'AUDITOR_LIFECYCLE_PROVISIONAL_FAILED',
  AUDITOR_LIFECYCLE_FIRST_TURN_FAILED: 'AUDITOR_LIFECYCLE_FIRST_TURN_FAILED',
  AUDITOR_LIFECYCLE_DECISION_INVALID: 'AUDITOR_LIFECYCLE_DECISION_INVALID',
  AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED: 'AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED',
  AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED: 'AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED',
  AUDITOR_LIFECYCLE_UNCERTAIN: 'AUDITOR_LIFECYCLE_UNCERTAIN'
});

/**
 * Structured Lifecycle Error
 */
class AuditorLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuditorLifecycleError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Default workspace state probe: returns SHA-256 of project root and timestamp
 */
async function defaultGetWorkspaceState(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot + ':' + Date.now()).digest('hex').slice(0, 16);
}

/**
 * Bootstrap an auditor thread for a project with full durability and crash-safety gates.
 *
 * Sequence:
 * 1. Validate Registry preconditions (project exists, auditor unbound).
 * 2. Validate no active bootstrap in SQLite recovery journal.
 * 3. Capture workspace snapshot.
 * 4. Spawn first App Server client in sandbox 'read-only'. Call thread/start.
 * 5. Commit PROVISIONAL_THREAD in SQLite recovery journal.
 * 6. Commit FIRST_TURN_STARTING in journal before turn dispatch.
 * 7. Call turn/start with AuditDecisionV1 outputSchema. On failure -> commit AUDIT_UNCERTAIN.
 * 8. On turn accept -> commit FIRST_TURN_IN_FLIGHT with turn_id.
 * 9. Await turn completion and validate decision via awaitAuditDecisionV1.
 * 10. Commit DECISION_VALIDATED with canonical decision bytes and SHA-256 hash.
 * 11. Close first App Server client.
 * 12. Commit RESUME_VERIFYING.
 * 13. Spawn second App Server client in new independent process.
 * 14. Call thread/resume(T) and verify exact returned thread ID.
 * 15. Commit RESUME_VERIFIED.
 * 16. Close second App Server client.
 * 17. Commit REGISTRY_BINDING.
 * 18. Call registry.bindAuditorThread(T) in atomic mutation queue.
 * 19. Transactionally delete active bootstrap row from SQLite journal.
 * 20. Return DURABLE_BOUND result.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {Object} options.registryPort
 * @param {Object} options.recoveryStore
 * @param {Function} options.adapterFactory - async ({ phase, cwd }) => adapter
 * @param {Function} [options.awaitAuditDecision] - defaults to awaitAuditDecisionV1
 * @param {Object} [options.workspacePort]
 * @param {string} [options.auditSubjectId]
 * @param {Array} [options.auditPrompt]
 * @param {string} [options.operationId]
 * @param {number} [options.turnTimeoutMs]
 * @returns {Promise<Object>}
 */
async function bootstrapAuditorThread(options) {
  if (!options || typeof options !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'bootstrapAuditorThread requires an options object'
    );
  }

  const {
    projectId,
    registryPort,
    recoveryStore,
    adapterFactory,
    awaitAuditDecision = awaitAuditDecisionV1,
    workspacePort,
    auditSubjectId = `audit-bootstrap-${Date.now()}`,
    auditPrompt,
    operationId = `op-${crypto.randomBytes(8).toString('hex')}`,
    turnTimeoutMs = 60000
  } = options;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'projectId must be a non-empty string'
    );
  }
  if (!registryPort || typeof registryPort.getProject !== 'function' || typeof registryPort.bindAuditorThread !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'registryPort must provide getProject and bindAuditorThread methods'
    );
  }
  if (!recoveryStore || typeof recoveryStore.getActiveBootstrap !== 'function' || typeof recoveryStore.beginBootstrap !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'recoveryStore must provide active bootstrap operations'
    );
  }
  if (typeof adapterFactory !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'adapterFactory must be a function'
    );
  }

  // 1. Validate Registry preconditions
  let project;
  try {
    project = await registryPort.getProject(projectId);
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' not found in registry: ${err.message}`
    );
  }

  if (!project) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' not found in registry`
    );
  }

  if (project.auditor.thread_id !== null) {
    if (project.auditor.enabled) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' already has an active bound auditor thread: '${project.auditor.thread_id}'`
      );
    } else {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' auditor is disabled with thread '${project.auditor.thread_id}'`
      );
    }
  }

  // 2. Validate no active bootstrap in recovery journal
  const existingActive = recoveryStore.getActiveBootstrap(projectId);
  if (existingActive) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS,
      `Active bootstrap already exists for project '${projectId}' in state '${existingActive.state}'. Recover or resolve first.`
    );
  }

  // 3. Capture workspace snapshot
  let workspaceStateObserved;
  if (workspacePort && typeof workspacePort.getWorkspaceState === 'function') {
    workspaceStateObserved = await workspacePort.getWorkspaceState(project.project_root);
  } else {
    workspaceStateObserved = await defaultGetWorkspaceState(project.project_root);
  }

  if (typeof workspaceStateObserved !== 'string' || !workspaceStateObserved.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'Failed to obtain non-empty workspace state snapshot'
    );
  }

  // 4. Spawn first App Server client in sandbox 'read-only'
  let client1 = null;
  let threadId = null;
  try {
    client1 = await adapterFactory({ phase: 'provisional', cwd: project.project_root });
    if (typeof client1.initialize === 'function' && !client1.isInitialized) {
      await client1.initialize();
    }

    const threadRes = await client1.startThread({
      cwd: project.project_root,
      sandbox: 'read-only'
    });

    const resolvedThreadId = threadRes && (threadRes.threadId || (threadRes.thread && threadRes.thread.id));
    if (!resolvedThreadId || typeof resolvedThreadId !== 'string') {
      throw new Error('thread/start did not return a valid thread id');
    }
    threadId = resolvedThreadId;
  } catch (err) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PROVISIONAL_FAILED,
      `Failed to create provisional auditor thread: ${err.message}`
    );
  }

  // 5. Commit PROVISIONAL_THREAD in SQLite recovery journal
  try {
    recoveryStore.beginBootstrap({
      project_id: projectId,
      operation_id: operationId,
      audit_subject_id: auditSubjectId,
      thread_id: threadId,
      workspace_state_observed: workspaceStateObserved
    });
  } catch (err) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    if (err && err.code === RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS,
        `Active bootstrap already exists for project '${projectId}': ${err.message}`
      );
    }
    throw err;
  }

  const expectedContext = Object.freeze({
    project_id: projectId,
    audit_subject_id: auditSubjectId,
    auditor_thread_id: threadId,
    workspace_state_observed: workspaceStateObserved
  });

  // 6. Precommit FIRST_TURN_STARTING before calling turn/start
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING
  });

  // 7. Call turn/start
  const outputSchema = buildAuditDecisionV1OutputSchema(expectedContext);
  const turnPrompt = auditPrompt || [
    { type: 'text', text: `Execute initial auditor validation for project '${projectId}' at workspace state '${workspaceStateObserved}'.` }
  ];

  let startTurnRes;
  try {
    startTurnRes = await client1.startTurn({
      threadId,
      input: turnPrompt,
      outputSchema
    });
  } catch (err) {
    // Failure to start first turn leaves execution state uncertain
    try {
      recoveryStore.transitionBootstrap({
        project_id: projectId,
        operation_id: operationId,
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        metadata: { failure: 'turn_start_failed', error: err.message }
      });
    } catch {}
    try { await client1.close(); } catch {}
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_UNCERTAIN,
      `First turn dispatch failed or timed out; state marked AUDIT_UNCERTAIN: ${err.message}`
    );
  }

  const turnId = startTurnRes.turnId;

  // 8. On turn accept -> commit FIRST_TURN_IN_FLIGHT with turn_id
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
    turn_id: turnId
  });

  // 9. Await turn completion and validate decision
  let validatedDecision;
  try {
    validatedDecision = await awaitAuditDecision(client1, {
      threadId,
      turnId,
      expectedContext,
      timeoutMs: turnTimeoutMs
    });
  } catch (err) {
    try {
      recoveryStore.transitionBootstrap({
        project_id: projectId,
        operation_id: operationId,
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        metadata: { failure: 'turn_decision_failed', error: err.message }
      });
    } catch {}
    try { await client1.close(); } catch {}
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_FIRST_TURN_FAILED,
      `Audit decision validation failed; state marked AUDIT_UNCERTAIN: ${err.message}`
    );
  }

  // 10. Canonical JSON serialization and SHA-256 calculation
  const decisionJson = JSON.stringify(validatedDecision);
  const decisionSha256 = crypto.createHash('sha256').update(decisionJson, 'utf8').digest('hex');

  // Commit DECISION_VALIDATED
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
    decision_json: decisionJson,
    decision_sha256: decisionSha256
  });

  // 11. Close first App Server client
  try {
    await client1.close();
  } catch (err) {
    // Client close error is non-fatal to decision persistence
  }
  client1 = null;

  // 12. Commit RESUME_VERIFYING before launching second client
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING
  });

  // 13-14. Spawn second client in new independent process and verify exact thread/resume
  let client2 = null;
  try {
    client2 = await adapterFactory({ phase: 'resume_verify', cwd: project.project_root });
    if (typeof client2.initialize === 'function' && !client2.isInitialized) {
      await client2.initialize();
    }

    const resumeRes = await client2.resumeThread({ threadId });
    const returnedResumeId = resumeRes && (resumeRes.threadId || (resumeRes.thread && resumeRes.thread.id));
    if (returnedResumeId !== threadId) {
      throw new Error(`thread/resume returned mismatched thread id: '${returnedResumeId}', expected '${threadId}'`);
    }
  } catch (err) {
    if (client2) {
      try { await client2.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED,
      `Cross-process thread/resume verification failed for thread '${threadId}': ${err.message}`
    );
  }

  // 15. Commit RESUME_VERIFIED
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED
  });

  // 16. Close second client
  try {
    await client2.close();
  } catch (err) {}
  client2 = null;

  // 17. Commit REGISTRY_BINDING
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
  });

  // 18. Call atomic Registry bind API
  let bindResult;
  try {
    bindResult = await registryPort.bindAuditorThread({
      project_id: projectId,
      thread_id: threadId,
      expected_project_root: project.project_root,
      expected_model_policy: project.auditor.model_policy
    });
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED,
      `Atomic Registry binding failed for project '${projectId}' with thread '${threadId}': ${err.message}`
    );
  }

  // 19. Transactionally delete active bootstrap record from recovery journal
  recoveryStore.deleteActiveBootstrap(projectId, operationId);

  // 20. Return DURABLE_BOUND result
  return {
    ok: true,
    status: 'DURABLE_BOUND',
    project_id: projectId,
    thread_id: threadId,
    registry_binding_status: bindResult.status,
    decision: validatedDecision,
    decision_sha256: decisionSha256,
    project: bindResult.project
  };
}

/**
 * Reconcile / recover any incomplete auditor bootstrap for a project after crash or restart.
 *
 * Rules:
 * - PROVISIONAL_THREAD: Delete active record. Provider has no rollout. Clean restart allowed.
 * - FIRST_TURN_STARTING / FIRST_TURN_IN_FLIGHT / AUDIT_UNCERTAIN: Mark/keep AUDIT_UNCERTAIN. Never auto-resend turn/start.
 * - DECISION_VALIDATED / RESUME_VERIFYING: Resume verification gate (cross-process thread/resume) without rerunning model.
 * - RESUME_VERIFIED / REGISTRY_BINDING: Proceed to atomic Registry binding or check if already bound.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {Object} options.registryPort
 * @param {Object} options.recoveryStore
 * @param {Function} options.adapterFactory
 * @returns {Promise<Object>}
 */
async function recoverAuditorBootstrap(options) {
  if (!options || typeof options !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'recoverAuditorBootstrap requires an options object'
    );
  }

  const { projectId, registryPort, recoveryStore, adapterFactory } = options;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'projectId must be a non-empty string'
    );
  }

  const active = recoveryStore.getActiveBootstrap(projectId);
  if (!active) {
    return {
      ok: true,
      status: 'NO_ACTIVE_BOOTSTRAP',
      project_id: projectId
    };
  }

  const { operation_id: operationId, thread_id: threadId, state } = active;

  // Case 1: PROVISIONAL_THREAD
  if (state === AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD) {
    recoveryStore.deleteActiveBootstrap(projectId, operationId);
    return {
      ok: true,
      status: 'RECOVERED_CLEARED',
      project_id: projectId,
      previous_state: AUDITOR_BOOTSTRAP_STATES.PROVISIONAL_THREAD,
      thread_id: threadId
    };
  }

  // Case 2: FIRST_TURN_STARTING / FIRST_TURN_IN_FLIGHT / AUDIT_UNCERTAIN
  if (
    state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_STARTING ||
    state === AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT ||
    state === AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN
  ) {
    if (state !== AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN) {
      recoveryStore.transitionBootstrap({
        project_id: projectId,
        operation_id: operationId,
        next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        metadata: {
          reason: `Crash recovery detected interrupted bootstrap in state '${state}'; model uncertainty preserved`
        }
      });
    }
    return {
      ok: false,
      status: 'AUDIT_UNCERTAIN',
      project_id: projectId,
      thread_id: threadId,
      message: 'Bootstrap was interrupted during first turn execution. Automatic re-execution is forbidden.'
    };
  }

  // Case 3: DECISION_VALIDATED or RESUME_VERIFYING
  let currentState = state;
  if (currentState === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED) {
    recoveryStore.transitionBootstrap({
      project_id: projectId,
      operation_id: operationId,
      next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING
    });
    currentState = AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING;
  }

  if (currentState === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING) {
    let project;
    try {
      project = await registryPort.getProject(projectId);
    } catch (err) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' not found in registry: ${err.message}`
      );
    }

    if (!project) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' not found in registry`
      );
    }

    let client = null;
    try {
      client = await adapterFactory({ phase: 'resume_verify', cwd: project.project_root });
      if (typeof client.initialize === 'function' && !client.isInitialized) {
        await client.initialize();
      }

      const resumeRes = await client.resumeThread({ threadId });
      const returnedResumeId = resumeRes && (resumeRes.threadId || (resumeRes.thread && resumeRes.thread.id));
      if (returnedResumeId !== threadId) {
        throw new Error(`thread/resume returned mismatched thread id: '${returnedResumeId}', expected '${threadId}'`);
      }
    } catch (err) {
      if (client) {
        try { await client.close(); } catch {}
      }
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED,
        `Recovery resume verification failed for thread '${threadId}': ${err.message}`
      );
    }

    recoveryStore.transitionBootstrap({
      project_id: projectId,
      operation_id: operationId,
      next_state: AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED
    });

    try { await client.close(); } catch {}
    currentState = AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED;
  }

  // Case 4: RESUME_VERIFIED
  if (currentState === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED) {
    recoveryStore.transitionBootstrap({
      project_id: projectId,
      operation_id: operationId,
      next_state: AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
    });
    currentState = AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING;
  }

  // Case 5: REGISTRY_BINDING
  if (currentState === AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING) {
    let project;
    try {
      project = await registryPort.getProject(projectId);
    } catch (err) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' not found in registry: ${err.message}`
      );
    }

    if (!project) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' not found in registry`
      );
    }

    let bindResult;
    // If already bound to same thread: idempotent reconciliation
    if (project.auditor.thread_id === threadId && project.auditor.enabled === true) {
      bindResult = { ok: true, status: 'ALREADY_BOUND_SAME_THREAD', project };
    } else {
      try {
        bindResult = await registryPort.bindAuditorThread({
          project_id: projectId,
          thread_id: threadId,
          expected_project_root: project.project_root,
          expected_model_policy: project.auditor.model_policy
        });
      } catch (err) {
        throw new AuditorLifecycleError(
          LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED,
          `Registry bind failed during recovery: ${err.message}`
        );
      }
    }

    recoveryStore.deleteActiveBootstrap(projectId, operationId);

    return {
      ok: true,
      status: 'DURABLE_BOUND',
      project_id: projectId,
      thread_id: threadId,
      reconciled: true,
      registry_binding_status: bindResult.status,
      project: bindResult.project
    };
  }

  throw new AuditorLifecycleError(
    LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
    `Unrecognized recovery state: '${currentState}'`
  );
}

/**
 * Inspect active bootstrap and historical audit transitions for a project.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {Object} options.recoveryStore
 * @param {Object} options.registryPort
 * @returns {Promise<Object>}
 */
async function inspectAuditorBootstrap(options) {
  if (!options || typeof options !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'inspectAuditorBootstrap requires an options object'
    );
  }

  const { projectId, recoveryStore, registryPort } = options;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'projectId must be a non-empty string'
    );
  }

  const activeBootstrap = recoveryStore.getActiveBootstrap(projectId);
  const history = recoveryStore.getBootstrapHistory(projectId);

  let registryProject = null;
  let registryBindingState = 'UNKNOWN';

  if (registryPort && typeof registryPort.getProject === 'function') {
    try {
      registryProject = await registryPort.getProject(projectId);
      if (registryProject) {
        registryBindingState = getAuditorBindingState(registryProject.auditor);
      } else {
        registryBindingState = 'PROJECT_NOT_FOUND';
      }
    } catch {
      registryBindingState = 'PROJECT_NOT_FOUND';
    }
  }

  return {
    project_id: projectId,
    active_bootstrap: activeBootstrap,
    history,
    registry_binding_state: registryBindingState,
    registry_project: registryProject
  };
}

module.exports = {
  LIFECYCLE_ERROR_CODES,
  AuditorLifecycleError,
  AUDITOR_BOOTSTRAP_STATES,
  bootstrapAuditorThread,
  recoverAuditorBootstrap,
  inspectAuditorBootstrap
};

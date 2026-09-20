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
  validateAuditDecisionV1,
  extractAuditDecisionV1FromTurn
} = require('./audit-decision');
const {
  REGISTRY_ERROR_CODES,
  getAuditorBindingState,
  computeRootIdentityKey,
  canonicalizeProjectRoot
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
  AUDITOR_LIFECYCLE_UNCERTAIN: 'AUDITOR_LIFECYCLE_UNCERTAIN',
  AUDITOR_RECOVERY_CORRUPT: 'AUDITOR_RECOVERY_CORRUPT'
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
 * Verify that the active bootstrap authority matches the fresh Registry record.
 * Fails closed with AUDITOR_LIFECYCLE_PRECONDITION_FAILED if drift is detected.
 *
 * Sequence:
 * 1. active exists
 * 2. project exists
 * 3. authority_version == 1
 * 4. canonicalize active.expected_project_root
 * 5. require its canonical identity == active.expected_project_root_identity
 * 6. canonicalize current project.project_root
 * 7. require its canonical identity == active.expected_project_root_identity
 * 8. require project.auditor exists
 * 9. canonicalize project.auditor.cwd
 * 10. require its canonical identity == active.expected_project_root_identity
 * 11. require current auditor.model_policy == active.expected_auditor_model_policy
 *
 * @param {Object} active
 * @param {Object} project
 * @returns {Object} verifiedAuthority { canonicalProjectRoot, identityKey, modelPolicy }
 */
function assertBootstrapAuthorityMatchesRegistry(active, project) {
  if (!active || typeof active !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'assertBootstrapAuthorityMatchesRegistry requires an active bootstrap record'
    );
  }
  if (!project || typeof project !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'assertBootstrapAuthorityMatchesRegistry requires a project record'
    );
  }

  if (active.authority_version !== 1) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Cannot verify authority: active bootstrap has authority_version ${active.authority_version}, requires 1`
    );
  }

  // 4-5. Canonicalize persisted expected_project_root and prove filesystem identity equals expected_project_root_identity (R2-R1-01)
  if (typeof active.expected_project_root !== 'string' || !active.expected_project_root.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'Cannot verify authority: active.expected_project_root is missing or invalid'
    );
  }

  let canonicalPersistedRoot;
  let persistedIdentityKey;
  try {
    const res = canonicalizeProjectRoot(active.expected_project_root);
    canonicalPersistedRoot = res.canonicalRoot;
    persistedIdentityKey = res.identityKey;
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to canonicalize persisted expected_project_root '${active.expected_project_root}': ${err.message}`
    );
  }

  if (persistedIdentityKey !== active.expected_project_root_identity) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Persisted project root self-verification failed for project '${active.project_id}': filesystem identity '${persistedIdentityKey}' does not match stored expected_project_root_identity '${active.expected_project_root_identity}'`
    );
  }

  // 6-7. Canonicalize current registry project root using production authority and verify match
  if (typeof project.project_root !== 'string' || !project.project_root.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'Registry project_root is missing or invalid'
    );
  }

  let registryIdentityKey;
  try {
    const res = canonicalizeProjectRoot(project.project_root);
    registryIdentityKey = res.identityKey;
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to canonicalize registry project root '${project.project_root}': ${err.message}`
    );
  }

  if (registryIdentityKey !== active.expected_project_root_identity) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project root drift detected for project '${active.project_id}': registry identity '${registryIdentityKey}' does not match expected identity '${active.expected_project_root_identity}'`
    );
  }

  // 8. Require project.auditor exists
  if (!project.auditor || typeof project.auditor !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${active.project_id}' is missing auditor configuration`
    );
  }

  // 9-10. Canonicalize project.auditor.cwd and prove canonical filesystem identity equals expected_project_root_identity (R2-R1-02)
  if (typeof project.auditor.cwd !== 'string' || !project.auditor.cwd.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${active.project_id}' auditor is missing valid cwd`
    );
  }

  let cwdIdentityKey;
  try {
    const res = canonicalizeProjectRoot(project.auditor.cwd);
    cwdIdentityKey = res.identityKey;
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to canonicalize auditor cwd '${project.auditor.cwd}': ${err.message}`
    );
  }

  if (cwdIdentityKey !== active.expected_project_root_identity) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Auditor cwd drift detected for project '${active.project_id}': cwd identity '${cwdIdentityKey}' does not match expected identity '${active.expected_project_root_identity}'`
    );
  }

  // 11. Require current auditor.model_policy == active.expected_auditor_model_policy
  const currentPolicy = project.auditor.model_policy;
  if (currentPolicy !== active.expected_auditor_model_policy) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Auditor model policy drift detected for project '${active.project_id}': registry policy '${currentPolicy}' does not match expected policy '${active.expected_auditor_model_policy}'`
    );
  }

  return {
    canonicalProjectRoot: canonicalPersistedRoot,
    identityKey: persistedIdentityKey,
    modelPolicy: currentPolicy
  };
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
    auditSubjectId,
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

  // DURAUTH-03: Workspace port is required (Section 14)
  if (!workspacePort || typeof workspacePort.getWorkspaceState !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'workspacePort with getWorkspaceState method is required'
    );
  }

  // DURAUTH-04: auditSubjectId is required (Section 18 & 32)
  if (
    typeof auditSubjectId !== 'string' ||
    !auditSubjectId.trim() ||
    Buffer.byteLength(auditSubjectId, 'utf8') > 512 ||
    /[\x00-\x1f\x7f]/.test(auditSubjectId)
  ) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'auditSubjectId is required and must be a non-empty string <= 512 bytes without control characters'
    );
  }

  // DURAUTH-04: auditPrompt is required non-empty input array (Section 19 & 32)
  if (!Array.isArray(auditPrompt) || auditPrompt.length === 0) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'auditPrompt is required and must be a non-empty adapter-compatible input array'
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

  // Canonicalize bootstrap-time project root and capture bootstrap authority (Detail 3)
  let expectedProjectRoot;
  let expectedProjectRootIdentity;
  try {
    const res = canonicalizeProjectRoot(project.project_root);
    expectedProjectRoot = res.canonicalRoot;
    expectedProjectRootIdentity = res.identityKey;
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to canonicalize project root '${project.project_root}': ${err.message}`
    );
  }
  const expectedAuditorModelPolicy = project.auditor.model_policy;

  // 2. Validate no active bootstrap in recovery journal
  const existingActive = recoveryStore.getActiveBootstrap(projectId);
  if (existingActive) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS,
      `Active bootstrap already exists for project '${projectId}' in state '${existingActive.state}'. Recover or resolve first.`
    );
  }

  // 3. Capture workspace snapshot using existing production interface (Sections 15 & 16)
  let workspaceSnapshot;
  try {
    workspaceSnapshot = await workspacePort.getWorkspaceState(project);
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to obtain workspace state: ${err.message}`
    );
  }

  if (!workspaceSnapshot || typeof workspaceSnapshot !== 'object' || Array.isArray(workspaceSnapshot)) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'workspacePort.getWorkspaceState must return a state object'
    );
  }

  if (typeof workspaceSnapshot.workspace_state_id !== 'string' || !workspaceSnapshot.workspace_state_id.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      'workspace snapshot missing non-empty workspace_state_id'
    );
  }

  if (workspaceSnapshot.project_id !== project.project_id) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `workspace snapshot project_id '${workspaceSnapshot.project_id}' does not match project '${project.project_id}'`
    );
  }

  const snapshotIdentity = computeRootIdentityKey(workspaceSnapshot.project_root);
  const projectIdentity = computeRootIdentityKey(project.project_root);
  if (snapshotIdentity !== projectIdentity) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `workspace snapshot project_root does not match project canonical root`
    );
  }

  const workspaceStateObserved = workspaceSnapshot.workspace_state_id;

  // 4. Spawn first App Server client in sandbox 'read-only'
  let client1 = null;
  let threadId = null;
  try {
    client1 = await adapterFactory({ phase: 'provisional', cwd: expectedProjectRoot });
    if (typeof client1.initialize === 'function' && !client1.isInitialized) {
      await client1.initialize();
    }

    const threadRes = await client1.startThread({
      cwd: expectedProjectRoot,
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
      workspace_state_observed: workspaceStateObserved,
      authority_version: 1,
      expected_project_root: expectedProjectRoot,
      expected_project_root_identity: expectedProjectRootIdentity,
      expected_auditor_model_policy: expectedAuditorModelPolicy
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

  // R2-R1-03: Immediately re-read persisted authority from recovery journal
  const persistedBootstrap = recoveryStore.getActiveBootstrap(projectId);
  if (!persistedBootstrap) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Persisted bootstrap row missing after beginBootstrap for project '${projectId}'`
    );
  }

  if (
    persistedBootstrap.operation_id !== operationId ||
    persistedBootstrap.thread_id !== threadId ||
    persistedBootstrap.authority_version !== 1
  ) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Persisted bootstrap row does not match intended bootstrap authority for project '${projectId}'`
    );
  }

  // Original local values may be used only to verify that persistence recorded the intended bootstrap authority
  if (
    persistedBootstrap.expected_project_root !== expectedProjectRoot ||
    persistedBootstrap.expected_project_root_identity !== expectedProjectRootIdentity ||
    persistedBootstrap.expected_auditor_model_policy !== expectedAuditorModelPolicy
  ) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Persisted bootstrap authority disagrees with captured bootstrap authority for project '${projectId}'`
    );
  }

  // R3: Fresh post-persistence Registry read before first turn (Sections 2 & 3)
  let freshProjectBeforeFirstTurn;
  try {
    freshProjectBeforeFirstTurn = await registryPort.getProject(projectId);
  } catch (err) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to read fresh registry state before first turn for project '${projectId}': ${err.message}`
    );
  }

  if (!freshProjectBeforeFirstTurn) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' missing in registry before first turn`
    );
  }

  const freshProjId = freshProjectBeforeFirstTurn.project_id || freshProjectBeforeFirstTurn.id;
  if (freshProjId !== projectId) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project ID mismatch in registry before first turn: expected '${projectId}', got '${freshProjId}'`
    );
  }

  if (!freshProjectBeforeFirstTurn.auditor || typeof freshProjectBeforeFirstTurn.auditor !== 'object') {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' auditor configuration missing in registry before first turn`
    );
  }

  if (freshProjectBeforeFirstTurn.auditor.thread_id !== null) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' auditor became bound before first turn (thread_id='${freshProjectBeforeFirstTurn.auditor.thread_id}')`
    );
  }

  if (freshProjectBeforeFirstTurn.auditor.enabled !== false) {
    if (client1) {
      try { await client1.close(); } catch {}
    }
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' auditor became enabled before first turn (enabled=${freshProjectBeforeFirstTurn.auditor.enabled})`
    );
  }

  // Self-verify persisted authority against fresh Registry project record
  try {
    assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProjectBeforeFirstTurn);
  } catch (err) {
    if (client1) {
      try { await client1.close(); } catch {}
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

  // 7. Call turn/start (DURAUTH-04: first meaningful audit turn)
  const outputSchema = buildAuditDecisionV1OutputSchema(expectedContext);
  const turnPrompt = auditPrompt;

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

  // 8. On turn accept -> commit FIRST_TURN_IN_FLIGHT with turn_id in patch (Section 1 & 2)
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.FIRST_TURN_IN_FLIGHT,
    patch: {
      turn_id: turnId
    }
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

  // Commit DECISION_VALIDATED with decision in patch (Section 1 & 2)
  recoveryStore.transitionBootstrap({
    project_id: projectId,
    operation_id: operationId,
    next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
    patch: {
      decision_json: decisionJson,
      decision_sha256: decisionSha256
    }
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

  // Re-read fresh project from registry to perform drift validation before second-process resume (Detail 8)
  let freshProjectForResume;
  try {
    freshProjectForResume = await registryPort.getProject(projectId);
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to read project '${projectId}' from registry before resume: ${err.message}`
    );
  }
  if (!freshProjectForResume) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' not found in registry before resume`
    );
  }
  const verifiedResumeAuthority = assertBootstrapAuthorityMatchesRegistry(
    persistedBootstrap,
    freshProjectForResume
  );

  // 13-14. Spawn second client in new independent process and verify exact thread/resume
  let client2 = null;
  try {
    client2 = await adapterFactory({
      phase: 'resume_verify',
      cwd: verifiedResumeAuthority.canonicalProjectRoot
    });
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

  // Re-read fresh project from registry to perform drift validation before Registry bind (Detail 8)
  let freshProjectForBind;
  try {
    freshProjectForBind = await registryPort.getProject(projectId);
    if (!freshProjectForBind) {
      throw new Error(`Project '${projectId}' not found in registry before bind`);
    }
    assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProjectForBind);
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED,
      `Registry bind validation failed for project '${projectId}': ${err.message}`
    );
  }

  // 18. Call atomic Registry bind API
  let bindResult;
  try {
    bindResult = await registryPort.bindAuditorThread({
      project_id: projectId,
      thread_id: threadId,
      expected_project_root: persistedBootstrap.expected_project_root,
      expected_model_policy: persistedBootstrap.expected_auditor_model_policy
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

  // Case 1b: AUDIT_TERMINAL_NO_DECISION
  if (state === AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION) {
    if (!registryPort || typeof registryPort.getProject !== 'function') {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        'registryPort with getProject is required for terminal no-decision recovery'
      );
    }

    let project;
    try {
      project = await registryPort.getProject(projectId);
    } catch (err) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Failed to read project '${projectId}' from registry: ${err.message}`
      );
    }

    if (!project) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Project '${projectId}' not found in registry`
      );
    }

    if (!project.auditor || project.auditor.thread_id !== null || project.auditor.enabled !== false) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Cannot clear terminal no-decision recovery: project '${projectId}' auditor is not unbound in registry (thread_id='${project.auditor ? project.auditor.thread_id : 'missing'}', enabled=${project.auditor ? project.auditor.enabled : 'missing'})`
      );
    }

    recoveryStore.deleteActiveBootstrap(projectId, operationId);
    return {
      ok: true,
      status: 'RECOVERED_TERMINAL_NO_DECISION_CLEARED',
      project_id: projectId,
      previous_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION,
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

  // Enforce decision authority and bootstrap authority for advanced states (WO-V4-05AF Section 7, WO-V4-05AG-R2 Details 7-9)
  if (
    state === AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED ||
    state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFYING ||
    state === AUDITOR_BOOTSTRAP_STATES.RESUME_VERIFIED ||
    state === AUDITOR_BOOTSTRAP_STATES.REGISTRY_BINDING
  ) {
    if (active.authority_version !== 1) {
      throw new AuditorLifecycleError(
        LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
        `Cannot recover bind-capable bootstrap with authority_version ${active.authority_version}: legacy recovery record lacks bootstrap authority and cannot resume or bind. Explicit retirement required.`
      );
    }

    if (
      !active.turn_id ||
      typeof active.turn_id !== 'string' ||
      !active.decision_json ||
      typeof active.decision_json !== 'string' ||
      !active.decision_sha256 ||
      typeof active.decision_sha256 !== 'string' ||
      !active.validated_decision ||
      typeof active.validated_decision !== 'object'
    ) {
      throw new AuditorLifecycleError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Recovery in state '${state}' requires turn_id, decision_json, decision_sha256, and validated_decision`
      );
    }

    const computedHash = crypto.createHash('sha256').update(active.decision_json, 'utf8').digest('hex');
    if (computedHash !== active.decision_sha256) {
      throw new AuditorLifecycleError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Decision hash mismatch in recovery state '${state}'`
      );
    }

    try {
      const expectedContext = {
        project_id: active.project_id,
        audit_subject_id: active.audit_subject_id,
        auditor_thread_id: active.thread_id,
        workspace_state_observed: active.workspace_state_observed
      };
      validateAuditDecisionV1(active.validated_decision, expectedContext);
    } catch (err) {
      throw new AuditorLifecycleError(
        RECOVERY_ERROR_CODES.AUDITOR_RECOVERY_CORRUPT,
        `Validated decision corrupt in state '${state}': ${err.message}`
      );
    }
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

    // Drift validation before recovery thread/resume (Detail 8, R2-R1-01)
    const verifiedAuthority = assertBootstrapAuthorityMatchesRegistry(active, project);

    let client = null;
    try {
      client = await adapterFactory({ phase: 'resume_verify', cwd: verifiedAuthority.canonicalProjectRoot });
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

    // Drift validation before Registry bind (Detail 8)
    assertBootstrapAuthorityMatchesRegistry(active, project);

    let bindResult;
    // If already bound to same thread: idempotent reconciliation
    if (project.auditor.thread_id === threadId && project.auditor.enabled === true) {
      bindResult = { ok: true, status: 'ALREADY_BOUND_SAME_THREAD', project };
    } else {
      try {
        bindResult = await registryPort.bindAuditorThread({
          project_id: projectId,
          thread_id: threadId,
          expected_project_root: active.expected_project_root,
          expected_model_policy: active.expected_auditor_model_policy
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
      decision: active.validated_decision,
      decision_sha256: active.decision_sha256,
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

const MAX_UNCERTAINTY_DIAGNOSTIC_BYTES = 1024;

/**
 * Truncates a string to at most maxBytes in UTF-8 representation without splitting multibyte code points.
 *
 * @param {string} str
 * @param {number} [maxBytes=MAX_UNCERTAINTY_DIAGNOSTIC_BYTES]
 * @returns {string}
 */
function truncateUtf8Safe(str, maxBytes = MAX_UNCERTAINTY_DIAGNOSTIC_BYTES) {
  if (typeof str !== 'string') {
    str = String(str || '');
  }
  let currentBytes = 0;
  let result = '';
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + chBytes > maxBytes) {
      return result;
    }
    result += ch;
    currentBytes += chBytes;
  }
  return result;
}

/**
 * Explicit operator resolution for AUDIT_UNCERTAIN bootstrap states.
 *
 * Inspects exact stored thread/turn using non-mutating provider thread/read.
 * If turn is terminal interrupted/failed: transitions to AUDIT_TERMINAL_NO_DECISION.
 * If turn is completed with valid AuditDecisionV1: transitions to DECISION_VALIDATED.
 * If turn is non-terminal, malformed, or ambiguous: preserves AUDIT_UNCERTAIN.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {Object} options.registryPort
 * @param {Object} options.recoveryStore
 * @param {Function} options.adapterFactory
 * @returns {Promise<Object>}
 */
async function resolveAuditorBootstrapUncertainty(options) {
  if (!options || typeof options !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'resolveAuditorBootstrapUncertainty requires an options object'
    );
  }

  const { projectId, registryPort, recoveryStore, adapterFactory } = options;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'projectId must be a non-empty string'
    );
  }
  if (!registryPort || typeof registryPort.getProject !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'registryPort must provide a getProject method'
    );
  }
  if (!recoveryStore || typeof recoveryStore.getActiveBootstrap !== 'function' || typeof recoveryStore.transitionBootstrap !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'recoveryStore must provide getActiveBootstrap and transitionBootstrap methods'
    );
  }
  if (typeof adapterFactory !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'adapterFactory must be a function'
    );
  }

  // Reject caller-supplied identities/decisions
  if (
    options.threadId !== undefined ||
    options.turnId !== undefined ||
    options.turnStatus !== undefined ||
    options.decision !== undefined
  ) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'Caller-supplied threadId, turnId, turnStatus, or decision is forbidden'
    );
  }

  // Preconditions: Project exists and auditor is unbound
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

  if (project.auditor.thread_id !== null || project.auditor.enabled === true) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' auditor is not unbound: thread_id='${project.auditor.thread_id}', enabled=${project.auditor.enabled}`
    );
  }

  // Preconditions: Active bootstrap exists in AUDIT_UNCERTAIN
  const active = recoveryStore.getActiveBootstrap(projectId);
  if (!active) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `No active bootstrap record found for project '${projectId}'`
    );
  }

  if (active.state !== AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Active bootstrap for project '${projectId}' is in state '${active.state}', expected 'AUDIT_UNCERTAIN'`
    );
  }

  // If uncertainty occurred before turn_id was recorded, fail closed without mutation
  if (!active.turn_id || typeof active.turn_id !== 'string' || !active.turn_id.trim()) {
    return {
      ok: false,
      status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: null,
      reason: truncateUtf8Safe('TURN_HISTORY_INVALID: Active bootstrap lacks persisted turn_id')
    };
  }

  // Drift validation before uncertainty provider read (Detail 8, R2-R1-01)
  if (active.authority_version !== 1) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Cannot resolve uncertainty for bootstrap with authority_version ${active.authority_version}: requires authority_version === 1`
    );
  }
  const verifiedAuthority = assertBootstrapAuthorityMatchesRegistry(active, project);

  // Spawn fresh inspection client (guaranteed close in finally block)
  let client = null;
  let readRes = null;
  try {
    client = await adapterFactory({
      phase: 'uncertainty_inspect',
      cwd: verifiedAuthority.canonicalProjectRoot
    });
    if (typeof client.initialize === 'function' && !client.isInitialized) {
      await client.initialize();
    }
    readRes = await client.readThread({
      threadId: active.thread_id,
      includeTurns: true
    });
  } catch (err) {
    const rawMsg = (err && err.message) ? String(err.message) : 'Provider inspection failed';
    return {
      ok: false,
      status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: active.turn_id,
      reason: truncateUtf8Safe(`PROVIDER_INSPECTION_FAILED: ${rawMsg}`)
    };
  } finally {
    if (client && typeof client.close === 'function') {
      try { await client.close(); } catch {}
    }
    client = null;
  }

  // Validate exact returned thread identity
  const returnedThreadId = readRes?.thread?.id || readRes?.threadId || readRes?.id;
  if (returnedThreadId !== active.thread_id) {
    return {
      ok: false,
      status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: active.turn_id,
      reason: truncateUtf8Safe(`THREAD_ID_MISMATCH: expected '${active.thread_id}', got '${returnedThreadId}'`)
    };
  }

  // Validate exact turn identity: must contain exactly 1 turn whose ID matches active.turn_id
  const turns = readRes?.thread && Array.isArray(readRes.thread.turns) ? readRes.thread.turns : [];
  if (turns.length !== 1 || turns[0]?.id !== active.turn_id) {
    return {
      ok: false,
      status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: active.turn_id,
      reason: truncateUtf8Safe(`TURN_HISTORY_INVALID: expected exactly 1 turn with id '${active.turn_id}', found ${turns.length} turns`)
    };
  }

  const targetTurn = turns[0];
  const turnStatus = targetTurn.status;

  // Case A: Terminal interrupted or failed turn (never inspect model output for decision)
  if (turnStatus === 'interrupted' || turnStatus === 'failed') {
    recoveryStore.transitionBootstrap({
      project_id: projectId,
      operation_id: active.operation_id,
      next_state: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION,
      metadata: {
        resolution: 'provider_terminal_no_decision',
        turn_status: turnStatus
      }
    });
    return {
      ok: true,
      status: AUDITOR_BOOTSTRAP_STATES.AUDIT_TERMINAL_NO_DECISION,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: active.turn_id,
      resolution: 'provider_terminal_no_decision',
      turn_status: turnStatus
    };
  }

  // Case B: Completed turn
  if (turnStatus === 'completed') {
    if (targetTurn.itemsView !== 'full') {
      return {
        ok: false,
        status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        project_id: projectId,
        thread_id: active.thread_id,
        turn_id: active.turn_id,
        reason: truncateUtf8Safe(`TURN_ITEMS_INCOMPLETE: Completed turn itemsView is '${targetTurn.itemsView}', requires 'full'`)
      };
    }

    const expectedContext = Object.freeze({
      project_id: active.project_id,
      audit_subject_id: active.audit_subject_id,
      auditor_thread_id: active.thread_id,
      workspace_state_observed: active.workspace_state_observed
    });

    let validatedDecision;
    try {
      validatedDecision = extractAuditDecisionV1FromTurn(targetTurn, expectedContext);
    } catch (err) {
      const rawMsg = (err && err.message) ? String(err.message) : 'Invalid decision schema';
      return {
        ok: false,
        status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
        project_id: projectId,
        thread_id: active.thread_id,
        turn_id: active.turn_id,
        reason: truncateUtf8Safe(`DECISION_VALIDATION_FAILED: ${rawMsg}`)
      };
    }

    const decisionJson = JSON.stringify(validatedDecision);
    const decisionSha256 = crypto.createHash('sha256').update(decisionJson, 'utf8').digest('hex');

    recoveryStore.transitionBootstrap({
      project_id: projectId,
      operation_id: active.operation_id,
      next_state: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
      patch: {
        decision_json: decisionJson,
        decision_sha256: decisionSha256
      },
      metadata: {
        resolution: 'provider_turn_completed_decision_validated'
      }
    });

    return {
      ok: true,
      status: AUDITOR_BOOTSTRAP_STATES.DECISION_VALIDATED,
      project_id: projectId,
      thread_id: active.thread_id,
      turn_id: active.turn_id,
      decision: validatedDecision,
      decision_sha256: decisionSha256
    };
  }

  // Case C: In-progress or other non-terminal status
  return {
    ok: false,
    status: AUDITOR_BOOTSTRAP_STATES.AUDIT_UNCERTAIN,
    project_id: projectId,
    thread_id: active.thread_id,
    turn_id: active.turn_id,
    turn_status: turnStatus || 'unknown',
    reason: truncateUtf8Safe(`TURN_NONTERMINAL: Turn is in non-terminal or unrecognized status '${turnStatus}'`)
  };
}

/**
 * Retire a legacy auditor bootstrap (authority_version === 0) whose authority cannot be proven.
 *
 * Sequence:
 * 1. Verify active bootstrap exists and has authority_version === 0.
 * 2. Verify fresh Registry state proves project exists and auditor is unbound.
 * 3. Invoke recoveryStore.retireLegacyBootstrap transaction.
 * 4. Return { ok: true, status: 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE', project_id, operation_id }.
 *
 * @param {Object} options
 * @param {string} options.projectId
 * @param {Object} options.registryPort
 * @param {Object} options.recoveryStore
 * @param {Object} [options.metadata]
 * @returns {Promise<Object>}
 */
async function retireLegacyAuditorBootstrapWithoutAuthority(options) {
  if (!options || typeof options !== 'object') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'retireLegacyAuditorBootstrapWithoutAuthority requires an options object'
    );
  }

  const { projectId, registryPort, recoveryStore, metadata = null } = options;

  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'projectId must be a non-empty string'
    );
  }

  if (!registryPort || typeof registryPort.getProject !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'registryPort must provide a getProject method'
    );
  }

  if (!recoveryStore || typeof recoveryStore.getActiveBootstrap !== 'function' || typeof recoveryStore.retireLegacyBootstrap !== 'function') {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_INVALID_REQUEST,
      'recoveryStore must provide getActiveBootstrap and retireLegacyBootstrap methods'
    );
  }

  const active = recoveryStore.getActiveBootstrap(projectId);
  if (!active) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `No active bootstrap found for project '${projectId}'`
    );
  }

  if (active.authority_version !== 0) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Cannot retire legacy bootstrap for project '${projectId}': authority_version is ${active.authority_version}, expected 0`
    );
  }

  let project;
  try {
    project = await registryPort.getProject(projectId);
  } catch (err) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Failed to read project '${projectId}' from registry: ${err.message}`
    );
  }

  if (!project) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Project '${projectId}' not found in registry`
    );
  }

  if (project.auditor?.thread_id !== null || project.auditor?.enabled !== false) {
    throw new AuditorLifecycleError(
      LIFECYCLE_ERROR_CODES.AUDITOR_LIFECYCLE_PRECONDITION_FAILED,
      `Cannot retire legacy bootstrap: project '${projectId}' auditor is not unbound in registry (thread_id='${project.auditor?.thread_id}', enabled=${project.auditor?.enabled})`
    );
  }

  const retireRes = recoveryStore.retireLegacyBootstrap(projectId, active.operation_id, metadata);

  return {
    ok: true,
    status: 'RETIRED_LEGACY_AUTHORITY_UNAVAILABLE',
    project_id: projectId,
    operation_id: active.operation_id,
    ...retireRes
  };
}

module.exports = {
  LIFECYCLE_ERROR_CODES,
  AuditorLifecycleError,
  AUDITOR_BOOTSTRAP_STATES,
  MAX_UNCERTAINTY_DIAGNOSTIC_BYTES,
  assertBootstrapAuthorityMatchesRegistry,
  bootstrapAuditorThread,
  recoverAuditorBootstrap,
  inspectAuditorBootstrap,
  resolveAuditorBootstrapUncertainty,
  retireLegacyAuditorBootstrapWithoutAuthority,
  retireLegacyBootstrap: retireLegacyAuditorBootstrapWithoutAuthority
};

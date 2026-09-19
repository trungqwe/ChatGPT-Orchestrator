'use strict';

const crypto = require('crypto');
const {
  DISPATCH_STATES,
  isWaitableState,
  isRecognizedWaitState,
  ERROR_CODES,
  LIMITS,
  computeRequestFingerprint
} = require('./contracts');
const { createMemoryLifecycleStore } = require('./lifecycle-store');

/**
 * Standalone Deterministic Broker Core (WP-V3-02)
 *
 * Responsibilities:
 * - Accept semantic operations
 * - Validate deterministic control preconditions
 * - Enforce one active worker dispatch per project
 * - Reject stale workspace state
 * - Guarantee idempotent duplicate handling
 * - Call injected ports (registry, workspace, worker)
 * - Record deterministic lifecycle transitions
 *
 * Non-responsibilities:
 * - No Express / HTTP
 * - No Electron / UI
 * - No ChatGPT / LLM calls
 * - No Codex queue transport
 * - No AO CLI execution
 * - No WorkerReport parsing
 * - No code quality verdicts
 */
function createBroker(dependencies = {}) {
  const {
    registryPort,
    workspacePort,
    workerPort,
    lifecycleStore = createMemoryLifecycleStore({ clock: dependencies.clock }),
    idFactory = { nextDispatchId: () => `D-${crypto.randomUUID()}` },
    clock = {
      now: () => Date.now(),
      iso: () => new Date().toISOString()
    }
  } = dependencies;

  if (!registryPort) throw new Error('registryPort dependency is required');
  if (!workspacePort) throw new Error('workspacePort dependency is required');
  if (!workerPort) throw new Error('workerPort dependency is required');

  /**
   * Safe Transition Helper (BCORE-10 / Sections 27-28)
   * Catches both structured rejection results and thrown persistence exceptions,
   * returning a consistent LIFECYCLE_STORE_FAILURE.
   */
  function safeTransition(dispatchId, nextState, patch) {
    try {
      const res = lifecycleStore.transition(dispatchId, nextState, patch);
      if (!res || !res.ok) {
        return {
          ok: false,
          code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
          dispatch_id: dispatchId,
          error: res && res.error ? res.error : `Lifecycle transition to '${nextState}' failed`
        };
      }
      return res;
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
        dispatch_id: dispatchId,
        error: `Lifecycle store transition failed: ${err.message}`
      };
    }
  }

  /**
   * dispatchWorker(request)
   * Semantic worker dispatch entry point (Sections 22-38).
   */
  async function dispatchWorker(request) {
    // 1. Basic Request Validation (Section 23, 25)
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Request must be a non-null object'
      };
    }

    if (request.schema_version !== 1) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or unsupported schema_version (expected 1)'
      };
    }

    if (typeof request.project_id !== 'string' || !request.project_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty project_id'
      };
    }

    if (typeof request.work_order_id !== 'string' || !request.work_order_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty work_order_id'
      };
    }

    if (typeof request.expected_workspace_state_id !== 'string' || !request.expected_workspace_state_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty expected_workspace_state_id'
      };
    }

    if (typeof request.directive !== 'string' || !request.directive.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty directive'
      };
    }

    // Section 25: Reject arbitrary execution command field
    if ('command' in request) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: "Top-level 'command' field is strictly forbidden on semantic broker"
      };
    }

    // BCORE-08 / Section 15: Validate audit_metadata shape and cloneability
    if ('audit_metadata' in request && request.audit_metadata !== null && request.audit_metadata !== undefined) {
      if (typeof request.audit_metadata !== 'object' || Array.isArray(request.audit_metadata)) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_REQUEST,
          error: 'audit_metadata must be null or a plain object'
        };
      }
      try {
        structuredClone(request.audit_metadata);
      } catch (err) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_REQUEST,
          error: `audit_metadata cannot be safely cloned: ${err.message}`
        };
      }
    }

    // 2. Directive Payload Size Check (Section 24)
    const directiveBytes = Buffer.byteLength(request.directive, 'utf8');
    if (directiveBytes > LIMITS.MAX_DIRECTIVE_BYTES) {
      return {
        ok: false,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        error: `Directive size (${directiveBytes} bytes) exceeds maximum limit (${LIMITS.MAX_DIRECTIVE_BYTES} bytes)`
      };
    }

    // 3. Project Resolution (Sections 26, 34)
    let project;
    try {
      project = await registryPort.getProject(request.project_id);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.REGISTRY_UNAVAILABLE,
        error: `Registry lookup failed: ${err.message}`
      };
    }

    if (!project) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_NOT_FOUND,
        error: `Project '${request.project_id}' not found in registry`
      };
    }

    // 4. Compute Request Fingerprint (Section 28)
    const fingerprint = computeRequestFingerprint({
      projectId: request.project_id,
      workOrderId: request.work_order_id,
      expectedWorkspaceStateId: request.expected_workspace_state_id,
      directive: request.directive
    });

    // 5. Active Dispatch Fast-Check (Sections 27-30 / BCORE-10: Exception Safety)
    let activeDispatch;
    try {
      activeDispatch = lifecycleStore.getActiveDispatch(request.project_id);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
        error: `Lifecycle store getActiveDispatch failed: ${err.message}`
      };
    }

    if (activeDispatch) {
      if (activeDispatch.work_order_id === request.work_order_id) {
        if (activeDispatch.request_fingerprint === fingerprint) {
          return {
            ok: true,
            idempotent_replay: true,
            dispatch_id: activeDispatch.dispatch_id,
            state: activeDispatch.state
          };
        }
        return {
          ok: false,
          code: ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT,
          error: `WorkOrder '${request.work_order_id}' is already active with different directive/parameters`
        };
      }
      return {
        ok: false,
        code: ERROR_CODES.WORKER_BUSY,
        error: `Worker is currently busy on project '${request.project_id}' with active WorkOrder '${activeDispatch.work_order_id}'`
      };
    }

    // 6. Workspace Freshness Gate (Sections 31, 35)
    let currentWorkspace;
    try {
      currentWorkspace = await workspacePort.getWorkspaceState(project);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
        error: `Workspace state lookup failed: ${err.message}`
      };
    }

    const currentWsId = currentWorkspace ? currentWorkspace.workspace_state_id : null;
    if (currentWsId !== request.expected_workspace_state_id) {
      return {
        ok: false,
        code: ERROR_CODES.STALE_AUDIT_STATE,
        expected_workspace_state_id: request.expected_workspace_state_id,
        observed_workspace_state_id: currentWsId,
        error: `Stale workspace state: expected '${request.expected_workspace_state_id}', observed '${currentWsId}'`
      };
    }

    // 7. Atomic Write-Ahead State Registration (Sections 9, 10, 12, 16, 32-34 / BCORE-06, BCORE-08, BCORE-10)
    const dispatchId = idFactory.nextDispatchId();
    const dispatchRecord = {
      dispatch_id: dispatchId,
      project_id: request.project_id,
      work_order_id: request.work_order_id,
      expected_workspace_state_id: request.expected_workspace_state_id,
      request_fingerprint: fingerprint,
      directive: request.directive,
      audit_metadata: request.audit_metadata ? structuredClone(request.audit_metadata) : null,
      state: DISPATCH_STATES.DISPATCHING,
      created_at: clock.iso()
    };

    let beginRes;
    try {
      beginRes = lifecycleStore.beginDispatch(request.project_id, dispatchRecord);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
        error: `Lifecycle store beginDispatch failed: ${err.message}`
      };
    }

    if (!beginRes.ok) {
      if (beginRes.code === ERROR_CODES.IDEMPOTENT_REPLAY) {
        return {
          ok: true,
          idempotent_replay: true,
          dispatch_id: beginRes.existing.dispatch_id,
          state: beginRes.existing.state
        };
      }
      return {
        ok: false,
        code: beginRes.code,
        error: beginRes.error || `Cannot begin dispatch: ${beginRes.code}`
      };
    }

    // 8. Call Worker Port (Sections 12-14, 35-38 / BCORE-02, BCORE-10)
    let workerRes;
    try {
      workerRes = await workerPort.dispatch({
        project,
        project_id: request.project_id,
        work_order_id: request.work_order_id,
        dispatch_id: dispatchId,
        expected_workspace_state_id: request.expected_workspace_state_id,
        directive: request.directive
      });
    } catch (err) {
      // Ambiguous transport failure (Section 38 / BC-010)
      const tRes = safeTransition(dispatchId, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
        error: err.message
      });
      if (!tRes.ok) {
        return tRes;
      }
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_UNCERTAIN,
        dispatch_id: dispatchId,
        error: err.message
      };
    }

    if (workerRes && workerRes.ok && workerRes.state === DISPATCH_STATES.DISPATCH_ACCEPTED) {
      // Definitive acceptance (Section 14, 36)
      const tRes = safeTransition(dispatchId, DISPATCH_STATES.DISPATCH_ACCEPTED);
      if (!tRes.ok) {
        return tRes;
      }
      return {
        ok: true,
        state: DISPATCH_STATES.DISPATCH_ACCEPTED,
        dispatch_id: dispatchId,
        work_order_id: request.work_order_id,
        project_id: request.project_id
      };
    } else if (workerRes && workerRes.ok === false && workerRes.definitive) {
      // Definitive failure (Section 37)
      const tRes = safeTransition(dispatchId, DISPATCH_STATES.DISPATCH_FAILED, {
        error: workerRes.error || 'Worker rejected dispatch'
      });
      if (!tRes.ok) {
        return tRes;
      }
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_FAILED,
        dispatch_id: dispatchId,
        error: workerRes.error || 'Worker rejected dispatch'
      };
    } else {
      // Ambiguous / unhandled worker response (Section 38)
      const tRes = safeTransition(dispatchId, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
        error: workerRes ? workerRes.error : 'Ambiguous worker response'
      });
      if (!tRes.ok) {
        return tRes;
      }
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_UNCERTAIN,
        dispatch_id: dispatchId,
        error: workerRes ? workerRes.error : 'Ambiguous worker response'
      };
    }
  }

  /**
   * waitWorker(request)
   * Semantic wait/poll entry point (Sections 15-32, 40-45 / BCORE-02, BCORE-03, BCORE-04, BCORE-05, BCORE-10).
   */
  async function waitWorker(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Request must be a non-null object'
      };
    }

    if (typeof request.project_id !== 'string' || !request.project_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty project_id'
      };
    }

    if (typeof request.dispatch_id !== 'string' || !request.dispatch_id.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty dispatch_id'
      };
    }

    // Clamp timeout between 1 and 30 seconds (Section 41)
    let timeoutSecs = request.timeout_secs;
    if (typeof timeoutSecs !== 'number' || isNaN(timeoutSecs)) {
      timeoutSecs = LIMITS.DEFAULT_TIMEOUT_SECS;
    }
    if (timeoutSecs > LIMITS.MAX_TIMEOUT_SECS) timeoutSecs = LIMITS.MAX_TIMEOUT_SECS;
    if (timeoutSecs < LIMITS.MIN_TIMEOUT_SECS) timeoutSecs = LIMITS.MIN_TIMEOUT_SECS;

    // BCORE-10: Exception boundary for store read
    let dispatch;
    try {
      dispatch = lifecycleStore.getDispatch(request.dispatch_id);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
        dispatch_id: request.dispatch_id,
        error: `Lifecycle store getDispatch failed: ${err.message}`
      };
    }

    if (!dispatch) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_NOT_FOUND,
        error: `Dispatch '${request.dispatch_id}' not found`
      };
    }

    if (dispatch.project_id !== request.project_id) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_PROJECT_MISMATCH,
        error: `Dispatch '${request.dispatch_id}' belongs to project '${dispatch.project_id}', not '${request.project_id}'`
      };
    }

    // 1. Wait State Gate (Sections 15-21 / BCORE-03)
    // Terminal states: return stored state without worker call
    if (dispatch.state === DISPATCH_STATES.READY_FOR_REVIEW) {
      return {
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: dispatch.dispatch_id,
        work_order_id: dispatch.work_order_id
      };
    }

    if (dispatch.state === DISPATCH_STATES.DISPATCH_FAILED) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_FAILED,
        dispatch_id: dispatch.dispatch_id,
        error: dispatch.error || 'Dispatch previously failed'
      };
    }

    if (dispatch.state === DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
      return {
        ok: false,
        code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
        dispatch_id: dispatch.dispatch_id,
        error: dispatch.error || 'Dispatch provenance ambiguous'
      };
    }

    // DISPATCH_UNCERTAIN must NOT be resurrected by normal wait (Section 19 / BC-025)
    if (dispatch.state === DISPATCH_STATES.DISPATCH_UNCERTAIN) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_UNCERTAIN,
        dispatch_id: dispatch.dispatch_id,
        state: DISPATCH_STATES.DISPATCH_UNCERTAIN,
        error: dispatch.error || 'Dispatch delivery outcome is uncertain'
      };
    }

    // DISPATCHING concurrent wait returns nonterminal DISPATCHING (Section 20 / BC-026)
    if (dispatch.state === DISPATCH_STATES.DISPATCHING) {
      return {
        ok: true,
        state: DISPATCH_STATES.DISPATCHING,
        dispatch_id: dispatch.dispatch_id,
        work_order_id: dispatch.work_order_id
      };
    }

    // Only WAITABLE_STATES (DISPATCH_ACCEPTED, RUNNING) are authorized to call workerPort.wait (Section 21)
    if (!isWaitableState(dispatch.state)) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        dispatch_id: dispatch.dispatch_id,
        state: dispatch.state,
        error: `Dispatch state '${dispatch.state}' is not waitable`
      };
    }

    // 2. Project Resolution for Wait (Sections 34, 36)
    let project;
    try {
      project = await registryPort.getProject(request.project_id);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.REGISTRY_UNAVAILABLE,
        error: `Registry lookup failed: ${err.message}`
      };
    }

    if (!project) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_NOT_FOUND,
        error: `Project '${request.project_id}' not found`
      };
    }

    // 3. Worker Wait Transport (Sections 28-30 / BCORE-05 / BC-029)
    let waitRes;
    try {
      waitRes = await workerPort.wait({
        project,
        project_id: request.project_id,
        dispatch_id: request.dispatch_id,
        work_order_id: dispatch.work_order_id,
        expected_workspace_state_id: dispatch.expected_workspace_state_id,
        timeout_secs: timeoutSecs
      });
    } catch (err) {
      // Transport failure during wait does NOT mutate lifecycle to DISPATCH_UNCERTAIN
      return {
        ok: false,
        code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
        dispatch_id: request.dispatch_id,
        state: dispatch.state,
        error: err.message
      };
    }

    // 4. Validate Worker Wait Response (Sections 22-27 / BCORE-04 / BC-027, BC-028)
    if (!waitRes || typeof waitRes !== 'object') {
      return {
        ok: false,
        code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
        dispatch_id: request.dispatch_id,
        state: dispatch.state,
        error: 'Worker wait returned invalid or empty response'
      };
    }

    if (waitRes.ok === true) {
      // Validate recognized state whitelist (Section 22)
      if (!waitRes.state || typeof waitRes.state !== 'string' || !isRecognizedWaitState(waitRes.state)) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_WORKER_RESPONSE,
          dispatch_id: request.dispatch_id,
          state: dispatch.state,
          error: `Worker wait returned unrecognized state: '${waitRes.state}'`
        };
      }

      // Identity validation (Sections 24, 32 / BC-014, BC-015)
      if (waitRes.dispatch_id !== request.dispatch_id || waitRes.work_order_id !== dispatch.work_order_id) {
        const tRes = safeTransition(request.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, {
          error: `Identity mismatch: expected dispatch '${request.dispatch_id}' / work_order '${dispatch.work_order_id}', got '${waitRes.dispatch_id}' / '${waitRes.work_order_id}'`
        });
        if (!tRes.ok) {
          return tRes;
        }
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id: request.dispatch_id,
          error: 'Worker wait returned mismatched identity'
        };
      }

      // Response DISPATCH_ACCEPTED (Section 25 / BC-034):
      // If already RUNNING, maintain monotonic state (keep RUNNING, never regress)
      if (waitRes.state === DISPATCH_STATES.DISPATCH_ACCEPTED) {
        return {
          ok: true,
          state: dispatch.state === DISPATCH_STATES.RUNNING ? DISPATCH_STATES.RUNNING : DISPATCH_STATES.DISPATCH_ACCEPTED,
          dispatch_id: request.dispatch_id,
          work_order_id: dispatch.work_order_id
        };
      }

      // Response RUNNING (Section 26)
      if (waitRes.state === DISPATCH_STATES.RUNNING) {
        if (dispatch.state !== DISPATCH_STATES.RUNNING) {
          const tRes = safeTransition(request.dispatch_id, DISPATCH_STATES.RUNNING);
          if (!tRes.ok) {
            return tRes;
          }
        }
        return {
          ok: true,
          state: DISPATCH_STATES.RUNNING,
          dispatch_id: request.dispatch_id,
          work_order_id: dispatch.work_order_id
        };
      }

      // Response READY_FOR_REVIEW (Section 27 / BC-030)
      if (waitRes.state === DISPATCH_STATES.READY_FOR_REVIEW) {
        const tRes = safeTransition(request.dispatch_id, DISPATCH_STATES.READY_FOR_REVIEW);
        if (!tRes.ok) {
          return tRes;
        }
        return {
          ok: true,
          state: DISPATCH_STATES.READY_FOR_REVIEW,
          dispatch_id: request.dispatch_id,
          work_order_id: dispatch.work_order_id
        };
      }
    } else if (waitRes.ok === false) {
      if (waitRes.code === ERROR_CODES.PROVENANCE_AMBIGUOUS) {
        const tRes = safeTransition(request.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, {
          error: waitRes.error || 'Provenance ambiguous'
        });
        if (!tRes.ok) {
          return tRes;
        }
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id: request.dispatch_id,
          state: DISPATCH_STATES.PROVENANCE_AMBIGUOUS,
          error: waitRes.error || 'Provenance ambiguous'
        };
      }

      if (waitRes.definitive) {
        const tRes = safeTransition(request.dispatch_id, DISPATCH_STATES.DISPATCH_FAILED, {
          error: waitRes.error || 'Definitive worker failure'
        });
        if (!tRes.ok) {
          return tRes;
        }
        return {
          ok: false,
          code: ERROR_CODES.DISPATCH_FAILED,
          dispatch_id: request.dispatch_id,
          error: waitRes.error || 'Definitive worker failure'
        };
      }

      // Non-definitive failure without known semantic (Section 23)
      return {
        ok: false,
        code: ERROR_CODES.INVALID_WORKER_RESPONSE,
        dispatch_id: request.dispatch_id,
        state: dispatch.state,
        error: waitRes.error || 'Worker wait returned failure without definitive semantic'
      };
    }

    return {
      ok: false,
      code: ERROR_CODES.INVALID_WORKER_RESPONSE,
      dispatch_id: request.dispatch_id,
      state: dispatch.state,
      error: 'Worker wait returned malformed response without valid ok boolean'
    };
  }

  /**
   * getWorkerStatus(projectId)
   * Returns deterministic worker state (Section 39 / BCORE-10: Exception Safety).
   */
  async function getWorkerStatus(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    let active;
    try {
      active = lifecycleStore.getActiveDispatch(projectId);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.LIFECYCLE_STORE_FAILURE,
        error: `Lifecycle store getActiveDispatch failed: ${err.message}`
      };
    }

    if (active) {
      return {
        ok: true,
        project_id: projectId,
        worker_state: active.state,
        active_dispatch_id: active.dispatch_id,
        active_work_order_id: active.work_order_id
      };
    }

    return {
      ok: true,
      project_id: projectId,
      worker_state: 'IDLE',
      active_dispatch_id: null,
      active_work_order_id: null
    };
  }

  /**
   * getProject(projectId)
   * Section 36: Port exception safety.
   */
  async function getProject(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    let project;
    try {
      project = await registryPort.getProject(projectId);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.REGISTRY_UNAVAILABLE,
        error: `Registry lookup failed: ${err.message}`
      };
    }

    if (!project) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_NOT_FOUND,
        error: `Project '${projectId}' not found`
      };
    }
    return { ok: true, project };
  }

  /**
   * getWorkspaceState(projectId)
   * Section 36: Port exception safety.
   */
  async function getWorkspaceState(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    let project;
    try {
      project = await registryPort.getProject(projectId);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.REGISTRY_UNAVAILABLE,
        error: `Registry lookup failed: ${err.message}`
      };
    }

    if (!project) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_NOT_FOUND,
        error: `Project '${projectId}' not found`
      };
    }

    let wsState;
    try {
      wsState = await workspacePort.getWorkspaceState(project);
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
        error: `Workspace state lookup failed: ${err.message}`
      };
    }

    return {
      ok: true,
      project_id: projectId,
      ...wsState
    };
  }

  return {
    dispatchWorker,
    waitWorker,
    getWorkerStatus,
    getProject,
    getWorkspaceState,
    lifecycleStore
  };
}

module.exports = {
  createBroker
};

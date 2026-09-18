'use strict';

const crypto = require('crypto');
const {
  DISPATCH_STATES,
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

    // 2. Directive Payload Size Check (Section 24)
    const directiveBytes = Buffer.byteLength(request.directive, 'utf8');
    if (directiveBytes > LIMITS.MAX_DIRECTIVE_BYTES) {
      return {
        ok: false,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        error: `Directive size (${directiveBytes} bytes) exceeds maximum limit (${LIMITS.MAX_DIRECTIVE_BYTES} bytes)`
      };
    }

    // 3. Project Resolution (Section 26)
    const project = await registryPort.getProject(request.project_id);
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

    // 5. Active Dispatch Fast-Check (Sections 27-30)
    const activeDispatch = lifecycleStore.getActiveDispatch(request.project_id);
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

    // 6. Workspace Freshness Gate (Section 31)
    const currentWorkspace = await workspacePort.getWorkspaceState(project);
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

    // 7. Atomic Write-Ahead State Registration (Sections 32-34)
    const dispatchId = idFactory.nextDispatchId();
    const dispatchRecord = {
      dispatch_id: dispatchId,
      project_id: request.project_id,
      work_order_id: request.work_order_id,
      expected_workspace_state_id: request.expected_workspace_state_id,
      request_fingerprint: fingerprint,
      directive: request.directive,
      audit_metadata: request.audit_metadata || null,
      state: DISPATCH_STATES.DISPATCHING,
      created_at: clock.iso()
    };

    const beginRes = lifecycleStore.beginDispatch(request.project_id, dispatchRecord);
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

    // 8. Call Worker Port (Sections 35-38)
    let workerRes;
    try {
      workerRes = await workerPort.dispatch({
        project,
        project_id: request.project_id,
        work_order_id: request.work_order_id,
        dispatch_id: dispatchId,
        directive: request.directive
      });
    } catch (err) {
      // Ambiguous transport failure (Section 38 / BC-010)
      lifecycleStore.transition(dispatchId, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
        error: err.message
      });
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_UNCERTAIN,
        dispatch_id: dispatchId,
        error: err.message
      };
    }

    if (workerRes && workerRes.ok && workerRes.state === DISPATCH_STATES.DISPATCH_ACCEPTED) {
      // Definitive acceptance (Section 36)
      lifecycleStore.transition(dispatchId, DISPATCH_STATES.DISPATCH_ACCEPTED);
      return {
        ok: true,
        state: DISPATCH_STATES.DISPATCH_ACCEPTED,
        dispatch_id: dispatchId,
        work_order_id: request.work_order_id,
        project_id: request.project_id
      };
    } else if (workerRes && workerRes.ok === false && workerRes.definitive) {
      // Definitive failure (Section 37)
      lifecycleStore.transition(dispatchId, DISPATCH_STATES.DISPATCH_FAILED, {
        error: workerRes.error || 'Worker rejected dispatch'
      });
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_FAILED,
        dispatch_id: dispatchId,
        error: workerRes.error || 'Worker rejected dispatch'
      };
    } else {
      // Ambiguous / unhandled worker response (Section 38)
      lifecycleStore.transition(dispatchId, DISPATCH_STATES.DISPATCH_UNCERTAIN, {
        error: workerRes ? workerRes.error : 'Ambiguous worker response'
      });
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
   * Semantic wait/poll entry point (Sections 40-45).
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

    const dispatch = lifecycleStore.getDispatch(request.dispatch_id);
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

    // Short-circuit already terminal states
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

    const project = await registryPort.getProject(request.project_id);

    let waitRes;
    try {
      waitRes = await workerPort.wait({
        project,
        project_id: request.project_id,
        dispatch_id: request.dispatch_id,
        work_order_id: dispatch.work_order_id,
        timeout_secs: timeoutSecs
      });
    } catch (err) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_UNCERTAIN,
        dispatch_id: request.dispatch_id,
        error: err.message
      };
    }

    // Identity validation (Section 44 / BC-014, BC-015)
    if (waitRes && waitRes.ok) {
      if (waitRes.dispatch_id !== request.dispatch_id || waitRes.work_order_id !== dispatch.work_order_id) {
        lifecycleStore.transition(request.dispatch_id, DISPATCH_STATES.PROVENANCE_AMBIGUOUS, {
          error: `Identity mismatch: expected dispatch '${request.dispatch_id}' / work_order '${dispatch.work_order_id}', got '${waitRes.dispatch_id}' / '${waitRes.work_order_id}'`
        });
        return {
          ok: false,
          code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
          dispatch_id: request.dispatch_id,
          error: 'Worker wait returned mismatched identity'
        };
      }

      if (waitRes.state === DISPATCH_STATES.RUNNING) {
        if (dispatch.state !== DISPATCH_STATES.RUNNING) {
          lifecycleStore.transition(request.dispatch_id, DISPATCH_STATES.RUNNING);
        }
        return {
          ok: true,
          state: DISPATCH_STATES.RUNNING,
          dispatch_id: request.dispatch_id,
          work_order_id: dispatch.work_order_id
        };
      }

      if (waitRes.state === DISPATCH_STATES.READY_FOR_REVIEW) {
        lifecycleStore.transition(request.dispatch_id, DISPATCH_STATES.READY_FOR_REVIEW);
        return {
          ok: true,
          state: DISPATCH_STATES.READY_FOR_REVIEW,
          dispatch_id: request.dispatch_id,
          work_order_id: dispatch.work_order_id
        };
      }
    } else if (waitRes && waitRes.ok === false) {
      if (waitRes.definitive) {
        lifecycleStore.transition(request.dispatch_id, DISPATCH_STATES.DISPATCH_FAILED, {
          error: waitRes.error
        });
        return {
          ok: false,
          code: ERROR_CODES.DISPATCH_FAILED,
          dispatch_id: request.dispatch_id,
          error: waitRes.error
        };
      }
    }

    return waitRes;
  }

  /**
   * getWorkerStatus(projectId)
   * Returns deterministic worker state (Section 39).
   */
  async function getWorkerStatus(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    const active = lifecycleStore.getActiveDispatch(projectId);
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
   */
  async function getProject(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    const project = await registryPort.getProject(projectId);
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
   */
  async function getWorkspaceState(projectId) {
    if (typeof projectId !== 'string' || !projectId.trim()) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Missing or empty projectId'
      };
    }

    const project = await registryPort.getProject(projectId);
    if (!project) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_NOT_FOUND,
        error: `Project '${projectId}' not found`
      };
    }

    const wsState = await workspacePort.getWorkspaceState(project);
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

'use strict';

const {
  DISPATCH_STATES,
  ACTIVE_STATES,
  RESERVED_RECORD_FIELDS,
  ERROR_CODES
} = require('./contracts');

/**
 * Valid Transition Map (Section 46):
 * Enforces strict forward state-machine progression and prevents illegal resurrection.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [DISPATCH_STATES.DISPATCHING]: new Set([
    DISPATCH_STATES.DISPATCH_ACCEPTED,
    DISPATCH_STATES.DISPATCH_FAILED,
    DISPATCH_STATES.DISPATCH_UNCERTAIN
  ]),
  [DISPATCH_STATES.DISPATCH_ACCEPTED]: new Set([
    DISPATCH_STATES.RUNNING,
    DISPATCH_STATES.READY_FOR_REVIEW,
    DISPATCH_STATES.DISPATCH_FAILED,
    DISPATCH_STATES.PROVENANCE_AMBIGUOUS
  ]),
  [DISPATCH_STATES.RUNNING]: new Set([
    DISPATCH_STATES.RUNNING, // Heartbeat / progress update
    DISPATCH_STATES.READY_FOR_REVIEW,
    DISPATCH_STATES.DISPATCH_FAILED,
    DISPATCH_STATES.PROVENANCE_AMBIGUOUS
  ]),
  // Terminal and uncertain states cannot transition to normal execution without reconciliation
  [DISPATCH_STATES.READY_FOR_REVIEW]: new Set([]),
  [DISPATCH_STATES.DISPATCH_FAILED]: new Set([]),
  [DISPATCH_STATES.PROVENANCE_AMBIGUOUS]: new Set([]),
  [DISPATCH_STATES.DISPATCH_UNCERTAIN]: new Set([])
});

/**
 * Volatile / Memory-backed Lifecycle Store (Sections 16-18)
 * Explicit label: VOLATILE / NON-DURABLE reference implementation for tests.
 * Provides atomic concurrency semantics, immutable identity protection, and transition validation.
 */
function createMemoryLifecycleStore(options = {}) {
  const clock = options.clock || {
    now: () => Date.now(),
    iso: () => new Date().toISOString()
  };

  const dispatchesById = new Map();
  const activeDispatchByProject = new Map();
  const latestDispatchByProject = new Map();
  const history = [];

  function getDispatch(dispatchId) {
    const record = dispatchesById.get(dispatchId);
    return record ? { ...record } : null;
  }

  function getActiveDispatch(projectId) {
    const activeId = activeDispatchByProject.get(projectId);
    if (!activeId) return null;
    const record = dispatchesById.get(activeId);
    if (!record || !ACTIVE_STATES.has(record.state)) {
      activeDispatchByProject.delete(projectId);
      return null;
    }
    return { ...record };
  }

  function getLatestDispatch(projectId) {
    const latestId = latestDispatchByProject.get(projectId);
    if (!latestId) return null;
    const record = dispatchesById.get(latestId);
    return record ? { ...record } : null;
  }

  /**
   * Atomic Begin Dispatch (Sections 9, 10, 34 / BCORE-06):
   * 1. Validates record.project_id === projectId (fail closed on mismatch).
   * 2. Checks dispatch_id collision (fail closed on duplicate ID).
   * 3. Ensures only one active dispatch can be registered per project.
   * 4. Atomically registers DISPATCHING intent.
   */
  function beginDispatch(projectId, record) {
    if (!record || typeof record !== 'object') {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Record must be a non-null object'
      };
    }

    // BCORE-06: Project identity mismatch validation (Section 9)
    if (record.project_id !== projectId) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
        error: `Project identity mismatch: argument '${projectId}' does not match record '${record.project_id}'`
      };
    }

    // BCORE-06: Dispatch ID collision check (Section 10)
    if (dispatchesById.has(record.dispatch_id)) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_ID_COLLISION,
        error: `Dispatch ID collision: '${record.dispatch_id}' already exists in lifecycle store`
      };
    }

    // Active dispatch check
    const currentActiveId = activeDispatchByProject.get(projectId);
    if (currentActiveId) {
      const activeRecord = dispatchesById.get(currentActiveId);
      if (activeRecord && ACTIVE_STATES.has(activeRecord.state)) {
        if (activeRecord.work_order_id === record.work_order_id) {
          if (activeRecord.request_fingerprint === record.request_fingerprint) {
            return {
              ok: false,
              code: ERROR_CODES.IDEMPOTENT_REPLAY,
              existing: { ...activeRecord }
            };
          }
          return {
            ok: false,
            code: ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT,
            error: `WorkOrder '${record.work_order_id}' is already active with different parameters`,
            existing: { ...activeRecord }
          };
        }
        return {
          ok: false,
          code: ERROR_CODES.WORKER_BUSY,
          error: `Project '${projectId}' currently has active dispatch '${activeRecord.dispatch_id}' (${activeRecord.state})`,
          existing: { ...activeRecord }
        };
      }
    }

    const savedRecord = {
      ...record,
      state: DISPATCH_STATES.DISPATCHING,
      created_at: clock.iso(),
      updated_at: clock.iso()
    };

    dispatchesById.set(record.dispatch_id, savedRecord);
    activeDispatchByProject.set(projectId, record.dispatch_id);
    latestDispatchByProject.set(projectId, record.dispatch_id);

    history.push({
      project_id: projectId,
      dispatch_id: record.dispatch_id,
      work_order_id: record.work_order_id,
      previous_state: null,
      next_state: DISPATCH_STATES.DISPATCHING,
      timestamp: clock.now(),
      iso: clock.iso()
    });

    return { ok: true, dispatch: { ...savedRecord } };
  }

  /**
   * Transition Dispatch State (Sections 6, 7, 46 / BCORE-01):
   * 1. Validates that patch does NOT mutate reserved authoritative fields.
   * 2. Enforces transition legality against ALLOWED_TRANSITIONS.
   * 3. Manages active state membership.
   */
  function transition(dispatchId, nextState, patch = {}) {
    const record = dispatchesById.get(dispatchId);
    if (!record) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_NOT_FOUND,
        error: `Dispatch '${dispatchId}' not found`
      };
    }

    // BCORE-01: Immutable lifecycle identity protection (Sections 6-8)
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(patch)) {
        if (RESERVED_RECORD_FIELDS.has(key)) {
          return {
            ok: false,
            code: ERROR_CODES.IMMUTABLE_FIELD_VIOLATION,
            field: key,
            error: `Cannot mutate authoritative reserved field '${key}' in transition patch`
          };
        }
      }
    }

    const allowed = ALLOWED_TRANSITIONS[record.state];
    if (!allowed || !allowed.has(nextState)) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        currentState: record.state,
        targetState: nextState,
        error: `Illegal state transition: cannot transition from '${record.state}' to '${nextState}'`
      };
    }

    const previousState = record.state;
    record.state = nextState;
    record.updated_at = clock.iso();
    if (patch) {
      Object.assign(record, patch);
    }

    // If new state is terminal (inactive), clear from active dispatch pointer
    if (!ACTIVE_STATES.has(nextState)) {
      if (activeDispatchByProject.get(record.project_id) === dispatchId) {
        activeDispatchByProject.delete(record.project_id);
      }
    }

    history.push({
      project_id: record.project_id,
      dispatch_id: record.dispatch_id,
      work_order_id: record.work_order_id,
      previous_state: previousState,
      next_state: nextState,
      timestamp: clock.now(),
      iso: clock.iso(),
      patch: patch ? { ...patch } : {}
    });

    return { ok: true, dispatch: { ...record } };
  }

  function getProjectHistory(projectId) {
    return history
      .filter((h) => h.project_id === projectId)
      .map((h) => ({ ...h }));
  }

  function getAllHistory() {
    return history.map((h) => ({ ...h }));
  }

  return {
    isDurable: false, // Explicitly non-durable
    getDispatch,
    getActiveDispatch,
    getLatestDispatch,
    beginDispatch,
    transition,
    getProjectHistory,
    getAllHistory
  };
}

module.exports = {
  createMemoryLifecycleStore,
  createVolatileLifecycleStore: createMemoryLifecycleStore
};

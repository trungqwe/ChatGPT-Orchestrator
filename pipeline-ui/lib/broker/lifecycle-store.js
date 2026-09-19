'use strict';

const {
  DISPATCH_STATES,
  MUTABLE_TRANSITION_FIELDS,
  isActiveState,
  isMutableTransitionField,
  isAllowedLifecycleTransition,
  ERROR_CODES
} = require('./contracts');

/**
 * Safe Deep Clone Helper (BCORE-08 / Sections 11-14)
 * Uses native structuredClone to prevent object aliasing between caller and store.
 */
function safeClone(val) {
  if (val === null || val === undefined || typeof val !== 'object') return val;
  return structuredClone(val);
}

/**
 * Volatile / Memory-backed Lifecycle Store (Sections 16-18)
 * Explicit label: VOLATILE / NON-DURABLE reference implementation for tests.
 * Provides atomic concurrency semantics, immutable identity protection, deep detachment, and transition validation.
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
    return record ? safeClone(record) : null;
  }

  function getActiveDispatch(projectId) {
    const activeId = activeDispatchByProject.get(projectId);
    if (!activeId) return null;
    const record = dispatchesById.get(activeId);
    if (!record || !isActiveState(record.state)) {
      activeDispatchByProject.delete(projectId);
      return null;
    }
    return safeClone(record);
  }

  function getLatestDispatch(projectId) {
    const latestId = latestDispatchByProject.get(projectId);
    if (!latestId) return null;
    const record = dispatchesById.get(latestId);
    return record ? safeClone(record) : null;
  }

  /**
   * Atomic Begin Dispatch (Sections 9, 10, 12, 34 / BCORE-06, BCORE-08):
   * 1. Validates record.project_id === projectId (fail closed on mismatch).
   * 2. Checks dispatch_id collision (fail closed on duplicate ID).
   * 3. Ensures only one active dispatch can be registered per project.
   * 4. Deep-clones record at write boundary to detach caller references.
   * 5. Atomically registers DISPATCHING intent.
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
      if (activeRecord && isActiveState(activeRecord.state)) {
        if (activeRecord.work_order_id === record.work_order_id) {
          if (activeRecord.request_fingerprint === record.request_fingerprint) {
            return {
              ok: false,
              code: ERROR_CODES.IDEMPOTENT_REPLAY,
              existing: safeClone(activeRecord)
            };
          }
          return {
            ok: false,
            code: ERROR_CODES.DUPLICATE_WORK_ORDER_CONFLICT,
            error: `WorkOrder '${record.work_order_id}' is already active with different parameters`,
            existing: safeClone(activeRecord)
          };
        }
        return {
          ok: false,
          code: ERROR_CODES.WORKER_BUSY,
          error: `Project '${projectId}' currently has active dispatch '${activeRecord.dispatch_id}' (${activeRecord.state})`,
          existing: safeClone(activeRecord)
        };
      }
    }

    // BCORE-08: Detach input data at write boundary via safeClone
    const savedRecord = {
      ...safeClone(record),
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
      iso: clock.iso(),
      patch: {}
    });

    return { ok: true, dispatch: safeClone(savedRecord) };
  }

  /**
   * Transition Dispatch State (Sections 6-10, 13, 17 / BCORE-01, BCORE-07, BCORE-08):
   * 1. Validates that patch modifies ONLY explicitly authorized mutable fields (Allowlist).
   * 2. Enforces transition legality against ALLOWED_TRANSITIONS.
   * 3. Manages active state membership.
   * 4. Detaches history snapshots and returned dispatch data.
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

    // BCORE-07: Allowlist validation for transition patches (Sections 9-10)
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(patch)) {
        if (!isMutableTransitionField(key)) {
          return {
            ok: false,
            code: ERROR_CODES.IMMUTABLE_FIELD_VIOLATION,
            field: key,
            error: `Cannot mutate field '${key}': only authorized mutable transition fields [${MUTABLE_TRANSITION_FIELDS.join(', ')}] are permitted`
          };
        }
      }
    }

    if (!isAllowedLifecycleTransition(record.state, nextState)) {
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
    if (patch && typeof patch === 'object') {
      const clonedPatch = safeClone(patch);
      Object.assign(record, clonedPatch);
    }

    // If new state is terminal (inactive), clear from active dispatch pointer
    if (!isActiveState(nextState)) {
      if (activeDispatchByProject.get(record.project_id) === dispatchId) {
        activeDispatchByProject.delete(record.project_id);
      }
    }

    // BCORE-08: History snapshot detachment
    history.push({
      project_id: record.project_id,
      dispatch_id: record.dispatch_id,
      work_order_id: record.work_order_id,
      previous_state: previousState,
      next_state: nextState,
      timestamp: clock.now(),
      iso: clock.iso(),
      patch: patch ? safeClone(patch) : {}
    });

    return { ok: true, dispatch: safeClone(record) };
  }

  function getProjectHistory(projectId) {
    return history
      .filter((h) => h.project_id === projectId)
      .map(safeClone);
  }

  function getAllHistory() {
    return history.map(safeClone);
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

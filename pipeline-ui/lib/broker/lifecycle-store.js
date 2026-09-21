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
 * isPlainDataObject — WO-V4-09C-U1 Section 5
 * Accepts ONLY objects with Object.prototype or null prototype.
 * Rejects Date, Map, Set, RegExp, class instances, arrays, null, primitives.
 */
function isPlainDataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * hasExactEnumerableDataKeys — WO-V4-09C-U1 Section 5
 * Returns true iff value is a plain data object with EXACTLY the listed keys
 * as own, enumerable, data-descriptor (no symbol, no accessor, no non-enumerable).
 * Never invokes getters.
 */
function hasExactEnumerableDataKeys(value, expectedKeys) {
  if (!isPlainDataObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return false;
    }
  }
  return true;
}

// Reconciliation authority constants
const _RECONCILE_AUTHORITY_KEYS = Object.freeze([
  'dispatch_id', 'project_id', 'work_order_id',
  'expected_state', 'target_state', 'classification', 'evidence_authority'
]);
const _PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const _RECONCILE_CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/;

/**
 * Validates all authority fields. Returns { ok: false, code, error } on failure,
 * or null on success. Does NOT invoke getters (all fields are data descriptors
 * after hasExactEnumerableDataKeys passes).
 */
function _validateReconcileAuthority(authority) {
  const dispatchId = authority.dispatch_id;
  const projectId = authority.project_id;
  const workOrderId = authority.work_order_id;
  const expectedState = authority.expected_state;
  const targetState = authority.target_state;
  const classification = authority.classification;
  const evidenceAuthority = authority.evidence_authority;

  if (
    typeof dispatchId !== 'string' ||
    dispatchId.length === 0 ||
    dispatchId.trim() !== dispatchId ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(dispatchId) ||
    Buffer.byteLength(dispatchId, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'dispatch_id must be a non-empty trim-exact string with no control characters and UTF-8 length <= 512' };
  }

  if (typeof projectId !== 'string' || !_PROJECT_ID_REGEX.test(projectId)) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'project_id must match ^[a-z0-9][a-z0-9._-]{0,127}$' };
  }

  if (
    typeof workOrderId !== 'string' ||
    workOrderId.length === 0 ||
    workOrderId.trim() !== workOrderId ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(workOrderId) ||
    Buffer.byteLength(workOrderId, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'work_order_id must be a non-empty trim-exact string with no control characters and UTF-8 length <= 512' };
  }

  if (expectedState !== DISPATCH_STATES.DISPATCH_UNCERTAIN) {
    return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, error: `expected_state must be '${DISPATCH_STATES.DISPATCH_UNCERTAIN}'` };
  }

  if (targetState !== DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
    return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, error: `Target state '${targetState}' is not authorized for uncertain dispatch reconciliation` };
  }

  if (classification !== 'DELIVERY_UNPROVEN') {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: "classification must be 'DELIVERY_UNPROVEN'" };
  }

  if (
    typeof evidenceAuthority !== 'string' ||
    evidenceAuthority.length === 0 ||
    evidenceAuthority.trim() !== evidenceAuthority ||
    _RECONCILE_CONTROL_CHAR_REGEX.test(evidenceAuthority) ||
    Buffer.byteLength(evidenceAuthority, 'utf8') > 512
  ) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: 'evidence_authority must be a non-empty trim-exact single-line string with no control characters and UTF-8 length <= 512' };
  }

  return null; // valid
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

  /**
   * Idempotent replay evaluator for the memory store.
   * History-first ordering: check latest history transition before diagnostics shape.
   * Returns structured result or throws on structural corruption.
   */
  function _evaluateMemoryReplay(authority, record) {
    // Step 1: Find latest history row for dispatch_id (history-first ordering)
    let latestHistory = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].dispatch_id === record.dispatch_id) {
        latestHistory = history[i];
        break;
      }
    }

    if (!latestHistory) {
      throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
    }

    // Semantic mismatch: wrong transition path -> ILLEGAL_STATE_TRANSITION (no throw)
    if (
      latestHistory.previous_state !== DISPATCH_STATES.DISPATCH_UNCERTAIN ||
      latestHistory.next_state !== DISPATCH_STATES.PROVENANCE_AMBIGUOUS
    ) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        error: 'Reconciliation replay mismatch: latest history transition does not match expected reconciliation path'
      };
    }

    // Step 2: Check dispatch diagnostics shape
    const rowDiag = record.diagnostics;
    if (rowDiag === null || rowDiag === undefined || !isPlainDataObject(rowDiag)) {
      throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
    }

    const recon = rowDiag.reconciliation;
    if (!hasExactEnumerableDataKeys(recon, ['classification', 'evidence_authority', 'reconciled_at'])) {
      throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
    }

    // Step 3: Check diagnostics values (semantic mismatch -> ILLEGAL_STATE_TRANSITION)
    if (
      recon.classification !== 'DELIVERY_UNPROVEN' ||
      recon.evidence_authority !== authority.evidence_authority ||
      typeof recon.reconciled_at !== 'string'
    ) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        error: 'Reconciliation replay mismatch: diagnostics do not match the provided authority'
      };
    }

    // Step 4: Check history patch shape (structural corruption -> throw)
    const patch = latestHistory.patch;
    if (
      !hasExactEnumerableDataKeys(patch, ['diagnostics']) ||
      !hasExactEnumerableDataKeys(patch.diagnostics, ['reconciliation']) ||
      !hasExactEnumerableDataKeys(patch.diagnostics.reconciliation, ['classification', 'evidence_authority', 'reconciled_at'])
    ) {
      throw new Error('Persisted authority corruption: dispatch reconciliation metadata shape is invalid');
    }

    // Step 5: Check patch values match diagnostics (semantic mismatch -> ILLEGAL_STATE_TRANSITION)
    if (
      patch.diagnostics.reconciliation.classification !== recon.classification ||
      patch.diagnostics.reconciliation.evidence_authority !== recon.evidence_authority ||
      patch.diagnostics.reconciliation.reconciled_at !== recon.reconciled_at
    ) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        error: 'Reconciliation replay mismatch: history patch does not match dispatch reconciliation metadata'
      };
    }

    // All checks pass — idempotent replay (zero mutation, zero clock calls)
    return {
      ok: true,
      reconciled: false,
      idempotent_replay: true,
      dispatch: safeClone(record)
    };
  }

  /**
   * reconcileUncertainDispatch — WO-V4-09C-U1 Section 5 / Design Seal.
   * Out-of-band operator recovery primitive only. MUST NOT be invoked by
   * broker, waitWorker, dispatchWorker, or any automated runtime method.
   *
   * Authorizes exactly: DISPATCH_UNCERTAIN -> PROVENANCE_AMBIGUOUS
   * Classification:     DELIVERY_UNPROVEN only
   */
  function reconcileUncertainDispatch(authority) {
    // 1. Authority shape validation
    if (!hasExactEnumerableDataKeys(authority, _RECONCILE_AUTHORITY_KEYS)) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: 'Authority must be a plain data object with exactly the required keys: ' + _RECONCILE_AUTHORITY_KEYS.join(', ')
      };
    }

    // 2. Field-level finite validation
    const fieldError = _validateReconcileAuthority(authority);
    if (fieldError) return fieldError;

    const dispatchId = authority.dispatch_id;
    const projectId = authority.project_id;
    const workOrderId = authority.work_order_id;
    const classification = authority.classification;
    const evidenceAuthority = authority.evidence_authority;

    // 3. Dispatch lookup
    const record = dispatchesById.get(dispatchId);
    if (!record) {
      return {
        ok: false,
        code: ERROR_CODES.DISPATCH_NOT_FOUND,
        error: `Dispatch '${dispatchId}' not found`
      };
    }

    // 4. Identity verification
    if (record.project_id !== projectId) {
      return {
        ok: false,
        code: ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
        error: `Project identity mismatch: authority '${projectId}' does not match dispatch '${record.project_id}'`
      };
    }
    if (record.work_order_id !== workOrderId) {
      return {
        ok: false,
        code: ERROR_CODES.INVALID_REQUEST,
        error: `Work order mismatch: authority '${workOrderId}' does not match dispatch '${record.work_order_id}'`
      };
    }

    // 5. State evaluation
    if (record.state === DISPATCH_STATES.PROVENANCE_AMBIGUOUS) {
      // Idempotent replay path (Section 13)
      return _evaluateMemoryReplay(authority, record);
    }

    if (record.state !== DISPATCH_STATES.DISPATCH_UNCERTAIN) {
      return {
        ok: false,
        code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
        currentState: record.state,
        expectedState: DISPATCH_STATES.DISPATCH_UNCERTAIN,
        error: `Illegal state transition: reconciliation requires current state '${DISPATCH_STATES.DISPATCH_UNCERTAIN}', but dispatch is in '${record.state}'`
      };
    }

    // 6. Inspect and validate diagnostics
    let base = {};
    const existingDiag = record.diagnostics;
    if (existingDiag !== null && existingDiag !== undefined) {
      if (!isPlainDataObject(existingDiag)) {
        throw new Error(`Lifecycle store corruption: malformed diagnostics in dispatch '${dispatchId}'`);
      }
      base = existingDiag;
    }
    if (Object.hasOwn(base, 'reconciliation')) {
      throw new Error(`Lifecycle store corruption: dispatch '${dispatchId}' in DISPATCH_UNCERTAIN already contains reconciliation metadata`);
    }

    // 7. Single clock snapshot (only on actual mutation, never on replay)
    const nowIso = clock.iso();
    const nowTs = clock.now();

    // 8. Build new diagnostics and history patch
    const reconciliationMeta = {
      classification,
      evidence_authority: evidenceAuthority,
      reconciled_at: nowIso
    };
    const newDiagnostics = { ...base, reconciliation: reconciliationMeta };
    const historyPatch = {
      diagnostics: {
        reconciliation: {
          classification,
          evidence_authority: evidenceAuthority,
          reconciled_at: nowIso
        }
      }
    };

    // 9. Mutate stored record (error is NOT touched)
    record.state = DISPATCH_STATES.PROVENANCE_AMBIGUOUS;
    record.updated_at = nowIso;
    record.diagnostics = newDiagnostics;

    // 10. Release active dispatch lock
    if (activeDispatchByProject.get(record.project_id) === dispatchId) {
      activeDispatchByProject.delete(record.project_id);
    }

    // 11. Append exactly one history row
    history.push({
      project_id: record.project_id,
      dispatch_id: record.dispatch_id,
      work_order_id: record.work_order_id,
      previous_state: DISPATCH_STATES.DISPATCH_UNCERTAIN,
      next_state: DISPATCH_STATES.PROVENANCE_AMBIGUOUS,
      timestamp: nowTs,
      iso: nowIso,
      patch: safeClone(historyPatch)
    });

    return {
      ok: true,
      reconciled: true,
      idempotent_replay: false,
      dispatch: safeClone(record)
    };
  }

  return {
    isDurable: false, // Explicitly non-durable
    getDispatch,
    getActiveDispatch,
    getLatestDispatch,
    beginDispatch,
    transition,
    getProjectHistory,
    getAllHistory,
    reconcileUncertainDispatch
  };
}

module.exports = {
  createMemoryLifecycleStore,
  createVolatileLifecycleStore: createMemoryLifecycleStore,
  isPlainDataObject,
  hasExactEnumerableDataKeys
};

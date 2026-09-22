'use strict';

const crypto = require('crypto');

/**
 * Dispatch Lifecycle States (Section 19)
 */
const DISPATCH_STATES = Object.freeze({
  DISPATCHING: 'DISPATCHING',
  DISPATCH_ACCEPTED: 'DISPATCH_ACCEPTED',
  RUNNING: 'RUNNING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  DISPATCH_UNCERTAIN: 'DISPATCH_UNCERTAIN',
  PROVENANCE_AMBIGUOUS: 'PROVENANCE_AMBIGUOUS'
});

/**
 * Private Authority Sets (BCORE-09 / Sections 18-21)
 * Private module-internal Sets prevent external mutation of contract membership.
 */
const _ACTIVE_STATES_SET = new Set([
  DISPATCH_STATES.DISPATCHING,
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING,
  DISPATCH_STATES.DISPATCH_UNCERTAIN
]);

const _TERMINAL_STATES_SET = new Set([
  DISPATCH_STATES.READY_FOR_REVIEW,
  DISPATCH_STATES.DISPATCH_FAILED,
  DISPATCH_STATES.PROVENANCE_AMBIGUOUS
]);

const _WAITABLE_STATES_SET = new Set([
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING
]);

const _RECOGNIZED_WAIT_STATES_SET = new Set([
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING,
  DISPATCH_STATES.READY_FOR_REVIEW
]);

const _MUTABLE_TRANSITION_FIELDS_SET = new Set([
  'error',
  'diagnostics'
]);

const _RESERVED_RECORD_FIELDS_SET = new Set([
  'dispatch_id',
  'project_id',
  'work_order_id',
  'expected_workspace_state_id',
  'request_fingerprint',
  'directive',
  'audit_metadata',
  'created_at',
  'updated_at',
  'state'
]);

/**
 * Predicate Authority Functions (Option A - Preferred)
 */
function isActiveState(state) {
  return _ACTIVE_STATES_SET.has(state);
}

function isTerminalState(state) {
  return _TERMINAL_STATES_SET.has(state);
}

function isWaitableState(state) {
  return _WAITABLE_STATES_SET.has(state);
}

function isRecognizedWaitState(state) {
  return _RECOGNIZED_WAIT_STATES_SET.has(state);
}

function isMutableTransitionField(field) {
  return _MUTABLE_TRANSITION_FIELDS_SET.has(field);
}

function isReservedRecordField(field) {
  return _RESERVED_RECORD_FIELDS_SET.has(field);
}

/**
 * Shared Immutable Lifecycle Transition Authority (WO-V3-006P / Section 6)
 */
const _ALLOWED_TRANSITIONS_MAP = Object.freeze({
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

function isAllowedLifecycleTransition(currentState, nextState) {
  const allowed = _ALLOWED_TRANSITIONS_MAP[currentState];
  return Boolean(allowed && allowed.has(nextState));
}

const _RECOGNIZED_LIFECYCLE_STATES_SET = new Set(Object.values(DISPATCH_STATES));

function isRecognizedLifecycleState(state) {
  return _RECOGNIZED_LIFECYCLE_STATES_SET.has(state);
}

/**
 * Genuinely Frozen Array Exports (Sections 18-20)
 * Exported as frozen Arrays to guarantee external immutability.
 */
const ACTIVE_STATES = Object.freeze([..._ACTIVE_STATES_SET]);
const TERMINAL_STATES = Object.freeze([..._TERMINAL_STATES_SET]);
const WAITABLE_STATES = Object.freeze([..._WAITABLE_STATES_SET]);
const RECOGNIZED_WAIT_STATES = Object.freeze([..._RECOGNIZED_WAIT_STATES_SET]);
const RECOGNIZED_LIFECYCLE_STATES = Object.freeze([..._RECOGNIZED_LIFECYCLE_STATES_SET]);
const MUTABLE_TRANSITION_FIELDS = Object.freeze([..._MUTABLE_TRANSITION_FIELDS_SET]);
const RESERVED_RECORD_FIELDS = Object.freeze([..._RESERVED_RECORD_FIELDS_SET]);

/**
 * Standard Structured Error Codes
 */
const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  WORKER_BUSY: 'WORKER_BUSY',
  STALE_AUDIT_STATE: 'STALE_AUDIT_STATE',
  DUPLICATE_WORK_ORDER_CONFLICT: 'DUPLICATE_WORK_ORDER_CONFLICT',
  IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  DISPATCH_UNCERTAIN: 'DISPATCH_UNCERTAIN',
  PROVENANCE_AMBIGUOUS: 'PROVENANCE_AMBIGUOUS',
  DISPATCH_NOT_FOUND: 'DISPATCH_NOT_FOUND',
  DISPATCH_PROJECT_MISMATCH: 'DISPATCH_PROJECT_MISMATCH',
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  IMMUTABLE_FIELD_VIOLATION: 'IMMUTABLE_FIELD_VIOLATION',
  INVALID_TRANSITION_PATCH: 'INVALID_TRANSITION_PATCH',
  PROJECT_IDENTITY_MISMATCH: 'PROJECT_IDENTITY_MISMATCH',
  DISPATCH_ID_COLLISION: 'DISPATCH_ID_COLLISION',
  LIFECYCLE_STORE_FAILURE: 'LIFECYCLE_STORE_FAILURE',
  WORKER_WAIT_UNAVAILABLE: 'WORKER_WAIT_UNAVAILABLE',
  INVALID_WORKER_RESPONSE: 'INVALID_WORKER_RESPONSE',
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
  WORKSPACE_STATE_UNAVAILABLE: 'WORKSPACE_STATE_UNAVAILABLE'
});

/**
 * Broker Core Limits
 */
const LIMITS = Object.freeze({
  MAX_DIRECTIVE_BYTES: 2 * 1024 * 1024, // 2 MiB (Section 24)
  DEFAULT_TIMEOUT_SECS: 10,
  MIN_TIMEOUT_SECS: 1,
  MAX_TIMEOUT_SECS: 300 // Section 41: Clamped bounds (WO-V4-09C-WAIT-I1)
});

/**
 * Compute canonical SHA-256 fingerprint for deterministic request identity (Section 28, 52).
 * Uses canonical JSON array encoding to ensure unambiguous field boundaries.
 * Does NOT include opaque audit_metadata (Section 53).
 */
function computeRequestFingerprint({ projectId, workOrderId, expectedWorkspaceStateId, directive }) {
  const payload = JSON.stringify([
    projectId || '',
    workOrderId || '',
    expectedWorkspaceStateId || '',
    directive || ''
  ]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

module.exports = {
  DISPATCH_STATES,
  ACTIVE_STATES,
  TERMINAL_STATES,
  WAITABLE_STATES,
  RECOGNIZED_WAIT_STATES,
  RECOGNIZED_LIFECYCLE_STATES,
  MUTABLE_TRANSITION_FIELDS,
  RESERVED_RECORD_FIELDS,
  isActiveState,
  isTerminalState,
  isWaitableState,
  isRecognizedWaitState,
  isRecognizedLifecycleState,
  isMutableTransitionField,
  isReservedRecordField,
  isAllowedLifecycleTransition,
  ERROR_CODES,
  LIMITS,
  computeRequestFingerprint
};

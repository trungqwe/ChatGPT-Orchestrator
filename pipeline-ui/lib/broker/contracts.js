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
 * Active States (Section 20):
 * A project is considered busy if it has a dispatch in any of these states.
 * DISPATCH_UNCERTAIN is treated as active/blocking for safety until reconciled.
 */
const ACTIVE_STATES = Object.freeze(new Set([
  DISPATCH_STATES.DISPATCHING,
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING,
  DISPATCH_STATES.DISPATCH_UNCERTAIN
]));

/**
 * Terminal / Inactive States (Section 20)
 */
const TERMINAL_STATES = Object.freeze(new Set([
  DISPATCH_STATES.READY_FOR_REVIEW,
  DISPATCH_STATES.DISPATCH_FAILED,
  DISPATCH_STATES.PROVENANCE_AMBIGUOUS
]));

/**
 * States authorized to call workerPort.wait (Section 21)
 */
const WAITABLE_STATES = Object.freeze(new Set([
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING
]));

/**
 * Recognized Successful Worker Wait States (Section 22)
 */
const RECOGNIZED_WAIT_STATES = Object.freeze(new Set([
  DISPATCH_STATES.DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING,
  DISPATCH_STATES.READY_FOR_REVIEW
]));

/**
 * Reserved Record Fields (Section 7, BCORE-01)
 * Immutable after beginDispatch. A patch containing any of these must fail closed.
 */
const RESERVED_RECORD_FIELDS = Object.freeze(new Set([
  'dispatch_id',
  'project_id',
  'work_order_id',
  'request_fingerprint',
  'created_at',
  'updated_at',
  'state'
]));

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
  MAX_TIMEOUT_SECS: 30 // Section 41: Clamped bounds
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
  RESERVED_RECORD_FIELDS,
  ERROR_CODES,
  LIMITS,
  computeRequestFingerprint
};

'use strict';

const crypto = require('crypto');

/**
 * Dispatch Lifecycle States
 * Section 19: Minimal deterministic control states.
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
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION'
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
 * Compute canonical SHA-256 fingerprint for deterministic request identity (Section 28).
 * Fingerprint incorporates: project_id, work_order_id, expected_workspace_state_id, directive exact bytes.
 */
function computeRequestFingerprint({ projectId, workOrderId, expectedWorkspaceStateId, directive }) {
  const payload = [
    projectId || '',
    workOrderId || '',
    expectedWorkspaceStateId || '',
    directive || ''
  ].join('\0');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

module.exports = {
  DISPATCH_STATES,
  ACTIVE_STATES,
  TERMINAL_STATES,
  ERROR_CODES,
  LIMITS,
  computeRequestFingerprint
};

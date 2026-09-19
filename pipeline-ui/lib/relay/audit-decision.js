'use strict';

/**
 * AuditDecisionV1 — Structured Semantic Authority Contract (WP-V4-04)
 * Strict schema, parser, and semantic validator for Native Codex auditor turn output.
 */

const AUDIT_DECISIONS = Object.freeze({
  DISPATCH_WORKER: 'DISPATCH_WORKER',
  REQUEST_EVIDENCE: 'REQUEST_EVIDENCE',
  APPROVE_WORK_PACKAGE: 'APPROVE_WORK_PACKAGE',
  BLOCKED: 'BLOCKED',
  STOP: 'STOP'
});

const INDEPENDENT_VERIFICATION_KINDS = Object.freeze({
  SOURCE_INSPECTION: 'SOURCE_INSPECTION',
  DIFF_INSPECTION: 'DIFF_INSPECTION',
  TEST_EXECUTION: 'TEST_EXECUTION',
  PROVENANCE_CHECK: 'PROVENANCE_CHECK',
  WORKSPACE_FRESHNESS: 'WORKSPACE_FRESHNESS',
  RUNTIME_EVIDENCE: 'RUNTIME_EVIDENCE',
  OTHER: 'OTHER'
});

const VERIFICATION_RESULTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE'
});

const WORKER_MODEL_POLICIES = Object.freeze({
  WORKER_ECONOMY: 'worker_economy',
  WORKER_STANDARD: 'worker_standard'
});

const AUDIT_DECISION_LIMITS = Object.freeze({
  MAX_RAW_JSON_BYTES: 128 * 1024, // 128 KiB
  MAX_SUMMARY_BYTES: 8 * 1024, // 8 KiB
  MAX_DIRECTIVE_BYTES: 64 * 1024, // 64 KiB
  MAX_WORK_ORDER_ID_BYTES: 512, // 512 bytes
  MAX_EVIDENCE_ITEM_BYTES: 4 * 1024, // 4 KiB
  MAX_BLOCKER_BYTES: 8 * 1024, // 8 KiB
  MIN_VERIFICATION_ITEMS: 1,
  MAX_VERIFICATION_ITEMS: 32,
  MIN_WO_VERIFICATION_ITEMS: 1,
  MAX_WO_VERIFICATION_ITEMS: 32,
  MAX_REQUESTED_EVIDENCE_ITEMS: 32
});

const ERROR_CODES = Object.freeze({
  AUDIT_DECISION_INVALID_JSON: 'AUDIT_DECISION_INVALID_JSON',
  AUDIT_DECISION_DUPLICATE_KEY: 'AUDIT_DECISION_DUPLICATE_KEY',
  AUDIT_DECISION_TOO_LARGE: 'AUDIT_DECISION_TOO_LARGE',
  AUDIT_DECISION_SCHEMA_INVALID: 'AUDIT_DECISION_SCHEMA_INVALID',
  AUDIT_DECISION_CONTEXT_MISMATCH: 'AUDIT_DECISION_CONTEXT_MISMATCH',
  AUDIT_DECISION_BRANCH_INVALID: 'AUDIT_DECISION_BRANCH_INVALID',
  AUDIT_DECISION_TURN_NOT_COMPLETED: 'AUDIT_DECISION_TURN_NOT_COMPLETED',
  AUDIT_DECISION_ITEMS_INCOMPLETE: 'AUDIT_DECISION_ITEMS_INCOMPLETE',
  AUDIT_DECISION_OUTPUT_MISSING: 'AUDIT_DECISION_OUTPUT_MISSING',
  AUDIT_DECISION_OUTPUT_AMBIGUOUS: 'AUDIT_DECISION_OUTPUT_AMBIGUOUS'
});

function createAuditDecisionError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  return JSON.parse(JSON.stringify(obj));
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const val = obj[name];
    if (val && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

/**
 * Strict recursive-descent JSON parser with duplicate key detection.
 * Enforces raw size bound, RFC 8259 compliance, and single JSON document boundary.
 * @param {string} rawText
 * @param {number} [maxBytes=131072]
 * @returns {any}
 */
function parseStrictJson(rawText, maxBytes = AUDIT_DECISION_LIMITS.MAX_RAW_JSON_BYTES) {
  if (typeof rawText !== 'string') {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'JSON input must be a string');
  }

  const byteLength = Buffer.byteLength(rawText, 'utf8');
  if (byteLength > maxBytes) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_TOO_LARGE,
      `JSON input exceeds maximum size limit of ${maxBytes} bytes (received ${byteLength} bytes)`,
      { byteLength, maxBytes }
    );
  }

  let index = 0;
  const len = rawText.length;

  function skipWhitespace() {
    while (index < len) {
      const ch = rawText.charCodeAt(index);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0A || ch === 0x0D) {
        index++;
      } else {
        break;
      }
    }
  }

  function error(code, msg) {
    throw createAuditDecisionError(code, `${msg} at character ${index}`, { index });
  }

  function parseString() {
    if (rawText.charCodeAt(index) !== 0x22) { // '"'
      error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Expected string');
    }
    index++;
    let str = '';
    let start = index;

    while (index < len) {
      const code = rawText.charCodeAt(index);
      if (code < 0x20) {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unescaped control character in string');
      }
      if (code === 0x22) { // '"'
        str += rawText.slice(start, index);
        index++;
        return str;
      }
      if (code === 0x5C) { // '\'
        str += rawText.slice(start, index);
        index++;
        if (index >= len) {
          error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unterminated string escape');
        }
        const esc = rawText.charCodeAt(index);
        index++;
        switch (esc) {
          case 0x22: str += '"'; break;
          case 0x5C: str += '\\'; break;
          case 0x2F: str += '/'; break;
          case 0x62: str += '\b'; break;
          case 0x66: str += '\f'; break;
          case 0x6E: str += '\n'; break;
          case 0x72: str += '\r'; break;
          case 0x74: str += '\t'; break;
          case 0x75: { // \uXXXX
            if (index + 4 > len) {
              error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid unicode escape');
            }
            const hex = rawText.slice(index, index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, `Invalid unicode escape: \\u${hex}`);
            }
            str += String.fromCharCode(parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, `Invalid escape character: \\${String.fromCharCode(esc)}`);
        }
        start = index;
      } else {
        index++;
      }
    }
    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unterminated string');
  }

  function parseNumber() {
    const start = index;
    if (rawText.charCodeAt(index) === 0x2D) { // '-'
      index++;
    }
    if (index >= len) error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid number');

    const firstDigit = rawText.charCodeAt(index);
    if (firstDigit === 0x30) { // '0'
      index++;
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) { // '1'-'9'
      index++;
      while (index < len) {
        const d = rawText.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    } else {
      error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid number');
    }

    if (index < len && rawText.charCodeAt(index) === 0x2E) { // '.'
      index++;
      if (index >= len || rawText.charCodeAt(index) < 0x30 || rawText.charCodeAt(index) > 0x39) {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid number: expected digit after decimal point');
      }
      while (index < len) {
        const d = rawText.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    }

    if (index < len && (rawText.charCodeAt(index) === 0x65 || rawText.charCodeAt(index) === 0x45)) { // 'e' or 'E'
      index++;
      if (index < len && (rawText.charCodeAt(index) === 0x2B || rawText.charCodeAt(index) === 0x2D)) { // '+' or '-'
        index++;
      }
      if (index >= len || rawText.charCodeAt(index) < 0x30 || rawText.charCodeAt(index) > 0x39) {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid number: expected digit in exponent');
      }
      while (index < len) {
        const d = rawText.charCodeAt(index);
        if (d >= 0x30 && d <= 0x39) index++;
        else break;
      }
    }

    const numStr = rawText.slice(start, index);
    const val = Number(numStr);
    if (isNaN(val)) error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, `Invalid number: ${numStr}`);
    return val;
  }

  function parseObject() {
    index++; // skip '{'
    const obj = {};
    const seenKeys = new Set();
    skipWhitespace();

    if (index < len && rawText.charCodeAt(index) === 0x7D) { // '}'
      index++;
      return obj;
    }

    while (index < len) {
      skipWhitespace();
      if (index >= len || rawText.charCodeAt(index) !== 0x22) {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Expected string key in object');
      }
      const key = parseString();
      if (seenKeys.has(key)) {
        error(ERROR_CODES.AUDIT_DECISION_DUPLICATE_KEY, `Duplicate key '${key}' in JSON object`);
      }
      seenKeys.add(key);

      skipWhitespace();
      if (index >= len || rawText.charCodeAt(index) !== 0x3A) { // ':'
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, `Expected ':' after key '${key}'`);
      }
      index++; // skip ':'

      skipWhitespace();
      const val = parseValue();
      obj[key] = val;

      skipWhitespace();
      if (index < len && rawText.charCodeAt(index) === 0x2C) { // ','
        index++;
        skipWhitespace();
        if (index < len && rawText.charCodeAt(index) === 0x7D) {
          error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Trailing comma in object');
        }
      } else if (index < len && rawText.charCodeAt(index) === 0x7D) { // '}'
        index++;
        return obj;
      } else {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, "Expected ',' or '}' in object");
      }
    }
    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unterminated object');
  }

  function parseArray() {
    index++; // skip '['
    const arr = [];
    skipWhitespace();

    if (index < len && rawText.charCodeAt(index) === 0x5D) { // ']'
      index++;
      return arr;
    }

    while (index < len) {
      skipWhitespace();
      const val = parseValue();
      arr.push(val);

      skipWhitespace();
      if (index < len && rawText.charCodeAt(index) === 0x2C) { // ','
        index++;
        skipWhitespace();
        if (index < len && rawText.charCodeAt(index) === 0x5D) {
          error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Trailing comma in array');
        }
      } else if (index < len && rawText.charCodeAt(index) === 0x5D) { // ']'
        index++;
        return arr;
      } else {
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, "Expected ',' or ']' in array");
      }
    }
    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unterminated array');
  }

  function parseValue() {
    skipWhitespace();
    if (index >= len) error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected end of JSON');

    const ch = rawText.charCodeAt(index);
    if (ch === 0x7B) return parseObject(); // '{'
    if (ch === 0x5B) return parseArray(); // '['
    if (ch === 0x22) return parseString(); // '"'
    if (ch === 0x2D || (ch >= 0x30 && ch <= 0x39)) return parseNumber(); // '-', '0'-'9'

    if (ch === 0x74) { // 'true'
      if (rawText.slice(index, index + 4) === 'true') {
        index += 4;
        return true;
      }
      error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected token');
    }
    if (ch === 0x66) { // 'false'
      if (rawText.slice(index, index + 5) === 'false') {
        index += 5;
        return false;
      }
      error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected token');
    }
    if (ch === 0x6E) { // 'null'
      if (rawText.slice(index, index + 4) === 'null') {
        index += 4;
        return null;
      }
      error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected token');
    }

    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, `Unexpected token '${rawText[index]}'`);
  }

  skipWhitespace();
  const result = parseValue();
  skipWhitespace();

  if (index < len) {
    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected trailing data after JSON document');
  }

  return result;
}

/**
 * Validate that expected trusted context contains all 4 required identity fields.
 * @param {Object} expectedContext
 */
function assertExpectedContext(expectedContext) {
  if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'expectedContext must be a non-null object'
    );
  }

  const { project_id, audit_subject_id, auditor_thread_id, workspace_state_observed } = expectedContext;

  if (typeof project_id !== 'string' || project_id.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH, 'expectedContext.project_id must be a non-empty string');
  }
  if (typeof audit_subject_id !== 'string' || audit_subject_id.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH, 'expectedContext.audit_subject_id must be a non-empty string');
  }
  if (typeof auditor_thread_id !== 'string' || auditor_thread_id.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH, 'expectedContext.auditor_thread_id must be a non-empty string');
  }
  if (typeof workspace_state_observed !== 'string' || workspace_state_observed.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH, 'expectedContext.workspace_state_observed must be a non-empty string');
  }
}

/**
 * Build provider-friendly JSON Schema for AuditDecisionV1 outputSchema.
 * Embeds exact expected context identities as single-value enums.
 * Returns an isolated deep clone to prevent caller mutation leakage.
 * @param {Object} expectedContext
 * @returns {Object}
 */
function buildAuditDecisionV1OutputSchema(expectedContext) {
  assertExpectedContext(expectedContext);

  const schema = {
    type: 'object',
    properties: {
      schema_version: {
        type: 'integer',
        enum: [1]
      },
      decision: {
        type: 'string',
        enum: Object.values(AUDIT_DECISIONS)
      },
      project_id: {
        type: 'string',
        enum: [expectedContext.project_id]
      },
      audit_subject_id: {
        type: 'string',
        enum: [expectedContext.audit_subject_id]
      },
      auditor_thread_id: {
        type: 'string',
        enum: [expectedContext.auditor_thread_id]
      },
      workspace_state_observed: {
        type: 'string',
        enum: [expectedContext.workspace_state_observed]
      },
      summary: {
        type: 'string'
      },
      independent_verification: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: Object.values(INDEPENDENT_VERIFICATION_KINDS)
            },
            result: {
              type: 'string',
              enum: Object.values(VERIFICATION_RESULTS)
            },
            evidence: {
              type: 'string'
            }
          },
          required: ['kind', 'result', 'evidence'],
          additionalProperties: false
        }
      },
      work_order: {
        type: ['object', 'null'],
        properties: {
          work_order_id: {
            type: 'string'
          },
          directive: {
            type: 'string'
          },
          verification: {
            type: 'array',
            items: {
              type: 'string'
            }
          },
          worker_model_policy: {
            type: 'string',
            enum: Object.values(WORKER_MODEL_POLICIES)
          }
        },
        required: ['work_order_id', 'directive', 'verification', 'worker_model_policy'],
        additionalProperties: false
      },
      requested_evidence: {
        type: 'array',
        items: {
          type: 'string'
        }
      },
      blocker: {
        type: ['string', 'null']
      }
    },
    required: [
      'schema_version',
      'decision',
      'project_id',
      'audit_subject_id',
      'auditor_thread_id',
      'workspace_state_observed',
      'summary',
      'independent_verification',
      'work_order',
      'requested_evidence',
      'blocker'
    ],
    additionalProperties: false
  };

  return deepClone(schema);
}

const REQUIRED_TOP_LEVEL_KEYS = Object.freeze([
  'schema_version',
  'decision',
  'project_id',
  'audit_subject_id',
  'auditor_thread_id',
  'workspace_state_observed',
  'summary',
  'independent_verification',
  'work_order',
  'requested_evidence',
  'blocker'
]);

const REQUIRED_TOP_LEVEL_KEYS_SET = new Set(REQUIRED_TOP_LEVEL_KEYS);

/**
 * Validate a parsed object against AuditDecisionV1 shape, bounds, exact context, and branch semantics.
 * Returns an immutable deep-frozen validated decision.
 * @param {any} value
 * @param {Object} expectedContext
 * @returns {Readonly<Object>}
 */
function validateAuditDecisionV1(value, expectedContext) {
  assertExpectedContext(expectedContext);

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 must be a non-null object'
    );
  }

  // Exact top-level keys check
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== REQUIRED_TOP_LEVEL_KEYS.length) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `AuditDecisionV1 must contain exactly ${REQUIRED_TOP_LEVEL_KEYS.length} top-level keys; received ${actualKeys.length}`
    );
  }

  for (const key of actualKeys) {
    if (!REQUIRED_TOP_LEVEL_KEYS_SET.has(key)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecisionV1 contains forbidden extra top-level key '${key}'`
      );
    }
  }

  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in value)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecisionV1 missing required top-level key '${key}'`
      );
    }
  }

  // 1. schema_version
  if (value.schema_version !== 1) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `schema_version must be integer 1; received ${JSON.stringify(value.schema_version)}`
    );
  }

  // 2. decision
  if (!Object.values(AUDIT_DECISIONS).includes(value.decision)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `decision '${value.decision}' is not a recognized AuditDecisionV1 value`
    );
  }

  // 3. Exact Context Identity Matching (byte-for-byte string equality)
  if (value.project_id !== expectedContext.project_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      `project_id mismatch: expected '${expectedContext.project_id}', received '${value.project_id}'`,
      { field: 'project_id', expected: expectedContext.project_id, actual: value.project_id }
    );
  }
  if (value.audit_subject_id !== expectedContext.audit_subject_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      `audit_subject_id mismatch: expected '${expectedContext.audit_subject_id}', received '${value.audit_subject_id}'`,
      { field: 'audit_subject_id', expected: expectedContext.audit_subject_id, actual: value.audit_subject_id }
    );
  }
  if (value.auditor_thread_id !== expectedContext.auditor_thread_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      `auditor_thread_id mismatch: expected '${expectedContext.auditor_thread_id}', received '${value.auditor_thread_id}'`,
      { field: 'auditor_thread_id', expected: expectedContext.auditor_thread_id, actual: value.auditor_thread_id }
    );
  }
  if (value.workspace_state_observed !== expectedContext.workspace_state_observed) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      `workspace_state_observed mismatch: expected '${expectedContext.workspace_state_observed}', received '${value.workspace_state_observed}'`,
      { field: 'workspace_state_observed', expected: expectedContext.workspace_state_observed, actual: value.workspace_state_observed }
    );
  }

  // 4. summary
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'summary must be a non-empty string'
    );
  }
  if (Buffer.byteLength(value.summary, 'utf8') > AUDIT_DECISION_LIMITS.MAX_SUMMARY_BYTES) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `summary exceeds maximum byte length of ${AUDIT_DECISION_LIMITS.MAX_SUMMARY_BYTES} bytes`
    );
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value.summary)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'summary contains forbidden control characters'
    );
  }

  // 5. independent_verification
  if (!Array.isArray(value.independent_verification)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'independent_verification must be an array'
    );
  }
  const ivCount = value.independent_verification.length;
  if (ivCount < AUDIT_DECISION_LIMITS.MIN_VERIFICATION_ITEMS || ivCount > AUDIT_DECISION_LIMITS.MAX_VERIFICATION_ITEMS) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `independent_verification must contain between ${AUDIT_DECISION_LIMITS.MIN_VERIFICATION_ITEMS} and ${AUDIT_DECISION_LIMITS.MAX_VERIFICATION_ITEMS} items; received ${ivCount}`
    );
  }

  const REQUIRED_IV_KEYS = new Set(['kind', 'result', 'evidence']);
  for (let i = 0; i < ivCount; i++) {
    const iv = value.independent_verification[i];
    if (!iv || typeof iv !== 'object' || Array.isArray(iv)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}] must be an object`
      );
    }
    const ivKeys = Object.keys(iv);
    if (ivKeys.length !== 3 || !ivKeys.every(k => REQUIRED_IV_KEYS.has(k))) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}] must contain exactly [kind, result, evidence]`
      );
    }
    if (!Object.values(INDEPENDENT_VERIFICATION_KINDS).includes(iv.kind)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].kind '${iv.kind}' is invalid`
      );
    }
    if (!Object.values(VERIFICATION_RESULTS).includes(iv.result)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].result '${iv.result}' is invalid; must be PASS, FAIL, or INCONCLUSIVE`
      );
    }
    if (typeof iv.evidence !== 'string' || iv.evidence.trim().length === 0) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].evidence must be a non-empty string`
      );
    }
    if (Buffer.byteLength(iv.evidence, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].evidence exceeds maximum size of ${AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES} bytes`
      );
    }
  }

  // 6. work_order
  if (value.work_order !== null) {
    if (typeof value.work_order !== 'object' || Array.isArray(value.work_order)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'work_order must be an object or null'
      );
    }
    const REQUIRED_WO_KEYS = new Set(['work_order_id', 'directive', 'verification', 'worker_model_policy']);
    const woKeys = Object.keys(value.work_order);
    if (woKeys.length !== 4 || !woKeys.every(k => REQUIRED_WO_KEYS.has(k))) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'work_order must contain exactly [work_order_id, directive, verification, worker_model_policy]'
      );
    }
    const { work_order_id, directive, verification, worker_model_policy } = value.work_order;

    if (typeof work_order_id !== 'string' || work_order_id.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id must be a non-empty string');
    }
    if (Buffer.byteLength(work_order_id, 'utf8') > AUDIT_DECISION_LIMITS.MAX_WORK_ORDER_ID_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id exceeds maximum size limit of 512 bytes');
    }
    if (/[\x00-\x1F\x7F]/.test(work_order_id)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id contains forbidden control characters');
    }

    if (typeof directive !== 'string' || directive.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.directive must be a non-empty string');
    }
    if (Buffer.byteLength(directive, 'utf8') > AUDIT_DECISION_LIMITS.MAX_DIRECTIVE_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.directive exceeds maximum size limit of 64 KiB');
    }

    if (!Array.isArray(verification)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.verification must be an array');
    }
    const wovCount = verification.length;
    if (wovCount < AUDIT_DECISION_LIMITS.MIN_WO_VERIFICATION_ITEMS || wovCount > AUDIT_DECISION_LIMITS.MAX_WO_VERIFICATION_ITEMS) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `work_order.verification must contain between ${AUDIT_DECISION_LIMITS.MIN_WO_VERIFICATION_ITEMS} and ${AUDIT_DECISION_LIMITS.MAX_WO_VERIFICATION_ITEMS} items`
      );
    }
    for (let i = 0; i < wovCount; i++) {
      const v = verification[i];
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `work_order.verification[${i}] must be a non-empty string`);
      }
      if (Buffer.byteLength(v, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
        throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `work_order.verification[${i}] exceeds 4 KiB limit`);
      }
    }

    if (!Object.values(WORKER_MODEL_POLICIES).includes(worker_model_policy)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `work_order.worker_model_policy '${worker_model_policy}' is invalid; allowed: [worker_economy, worker_standard]`
      );
    }
  }

  // 7. requested_evidence
  if (!Array.isArray(value.requested_evidence)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'requested_evidence must be an array'
    );
  }
  if (value.requested_evidence.length > AUDIT_DECISION_LIMITS.MAX_REQUESTED_EVIDENCE_ITEMS) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `requested_evidence exceeds maximum of ${AUDIT_DECISION_LIMITS.MAX_REQUESTED_EVIDENCE_ITEMS} items`
    );
  }
  for (let i = 0; i < value.requested_evidence.length; i++) {
    const re = value.requested_evidence[i];
    if (typeof re !== 'string' || re.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `requested_evidence[${i}] must be a non-empty string`);
    }
    if (Buffer.byteLength(re, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `requested_evidence[${i}] exceeds 4 KiB limit`);
    }
  }

  // 8. blocker
  if (value.blocker !== null) {
    if (typeof value.blocker !== 'string' || value.blocker.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'blocker must be a non-empty string or null');
    }
    if (Buffer.byteLength(value.blocker, 'utf8') > AUDIT_DECISION_LIMITS.MAX_BLOCKER_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'blocker exceeds 8 KiB limit');
    }
  }

  // 9. Semantic Decision Branch Validation
  switch (value.decision) {
    case AUDIT_DECISIONS.DISPATCH_WORKER:
      if (value.work_order === null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires work_order != null'
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires requested_evidence to be empty'
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires blocker == null'
        );
      }
      break;

    case AUDIT_DECISIONS.REQUEST_EVIDENCE:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires work_order == null'
        );
      }
      if (value.requested_evidence.length < 1) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires at least 1 requested_evidence item'
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires blocker == null'
        );
      }
      break;

    case AUDIT_DECISIONS.APPROVE_WORK_PACKAGE:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires work_order == null'
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires requested_evidence to be empty'
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires blocker == null'
        );
      }
      for (const iv of value.independent_verification) {
        if (iv.result !== VERIFICATION_RESULTS.PASS) {
          throw createAuditDecisionError(
            ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
            `APPROVE_WORK_PACKAGE requires all independent_verification results to be PASS; found '${iv.result}'`
          );
        }
      }
      break;

    case AUDIT_DECISIONS.BLOCKED:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires work_order == null'
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires requested_evidence to be empty'
        );
      }
      if (typeof value.blocker !== 'string' || value.blocker.trim().length === 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires blocker to be a non-empty string'
        );
      }
      break;

    case AUDIT_DECISIONS.STOP:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires work_order == null'
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires requested_evidence to be empty'
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires blocker == null'
        );
      }
      break;

    default:
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `Unhandled decision type '${value.decision}'`
      );
  }

  return deepFreeze(deepClone(value));
}

/**
 * Parse raw text into JSON with strict RFC 8259 + duplicate key rules,
 * then validate against AuditDecisionV1 contract and expectedContext.
 * @param {string} text
 * @param {Object} expectedContext
 * @returns {Readonly<Object>}
 */
function parseAuditDecisionV1Text(text, expectedContext) {
  assertExpectedContext(expectedContext);

  if (typeof text !== 'string') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_INVALID_JSON,
      'Audit decision text must be a string'
    );
  }

  const parsed = parseStrictJson(text);
  return validateAuditDecisionV1(parsed, expectedContext);
}

/**
 * Extract and validate AuditDecisionV1 from a terminal Turn object snapshot.
 * Requires turn.status == 'completed' and turn.itemsView == 'full'.
 * Selects exactly one final_answer agentMessage or single null/undefined phase agentMessage.
 * @param {Object} turn
 * @param {Object} expectedContext
 * @returns {Readonly<Object>}
 */
function extractAuditDecisionV1FromTurn(turn, expectedContext) {
  assertExpectedContext(expectedContext);

  if (!turn || typeof turn !== 'object') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_TURN_NOT_COMPLETED,
      'turn must be a non-null object'
    );
  }

  if (turn.status !== 'completed') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_TURN_NOT_COMPLETED,
      `Turn is not completed (status='${turn.status}'); only status='completed' provides decision authority`,
      { status: turn.status }
    );
  }

  if (turn.itemsView !== 'full') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_ITEMS_INCOMPLETE,
      `Turn itemsView is '${turn.itemsView}'; requires itemsView='full' for complete semantic authority`,
      { itemsView: turn.itemsView }
    );
  }

  if (!Array.isArray(turn.items)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_ITEMS_INCOMPLETE,
      'turn.items must be an array'
    );
  }

  // Filter agentMessage items only
  const agentMessages = turn.items.filter(item => item && item.type === 'agentMessage');

  if (agentMessages.length === 0) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_OUTPUT_MISSING,
      'Turn contains zero agentMessage items'
    );
  }

  // 1. Look for explicit phase === 'final_answer'
  const finalAnswerMessages = agentMessages.filter(item => item.phase === 'final_answer');

  let chosenMessage = null;

  if (finalAnswerMessages.length === 1) {
    chosenMessage = finalAnswerMessages[0];
  } else if (finalAnswerMessages.length > 1) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_OUTPUT_AMBIGUOUS,
      `Turn contains ${finalAnswerMessages.length} agentMessage items with phase='final_answer'`
    );
  } else {
    // 0 final_answer messages: ignore commentary, inspect null/undefined phase
    const nonCommentaryMessages = agentMessages.filter(item => item.phase !== 'commentary');
    const unknownPhaseMessages = nonCommentaryMessages.filter(item => item.phase === null || item.phase === undefined);

    if (unknownPhaseMessages.length === 1) {
      chosenMessage = unknownPhaseMessages[0];
    } else if (unknownPhaseMessages.length === 0) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_OUTPUT_MISSING,
        'No eligible agentMessage found (all were commentary or non-final)'
      );
    } else {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_OUTPUT_AMBIGUOUS,
        `Turn contains ${unknownPhaseMessages.length} candidate agentMessages with unknown/null phase`
      );
    }
  }

  if (!chosenMessage || typeof chosenMessage.text !== 'string') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_OUTPUT_MISSING,
      'Selected agentMessage does not contain text string'
    );
  }

  return parseAuditDecisionV1Text(chosenMessage.text, expectedContext);
}

/**
 * High-level helper: await turn completion on adapter and extract validated decision.
 * Validates expectedContext.auditor_thread_id matches threadId before waiting.
 * Does NOT start the turn.
 * @param {Object} adapter
 * @param {Object} params
 * @param {string} params.threadId
 * @param {string} params.turnId
 * @param {Object} params.expectedContext
 * @param {number} [params.timeoutMs=60000]
 * @returns {Promise<Readonly<Object>>}
 */
async function awaitAuditDecisionV1(adapter, params = {}) {
  if (!adapter || typeof adapter.waitForTurnCompletion !== 'function') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
      'adapter must provide a waitForTurnCompletion function'
    );
  }

  const { threadId, turnId, expectedContext, timeoutMs = 60000 } = params;

  if (typeof threadId !== 'string' || threadId.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH, 'threadId must be a non-empty string');
  }
  if (typeof turnId !== 'string' || turnId.trim().length === 0) {
    throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID, 'turnId must be a non-empty string');
  }

  assertExpectedContext(expectedContext);

  if (expectedContext.auditor_thread_id !== threadId) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      `expectedContext.auditor_thread_id ('${expectedContext.auditor_thread_id}') does not match threadId ('${threadId}')`,
      { expected: threadId, actual: expectedContext.auditor_thread_id }
    );
  }

  const completion = await adapter.waitForTurnCompletion({
    threadId,
    turnId,
    timeoutMs
  });

  if (!completion || completion.status !== 'completed' || !completion.turn) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_TURN_NOT_COMPLETED,
      `Turn did not complete successfully (status='${completion ? completion.status : 'null'}')`,
      { completion }
    );
  }

  return extractAuditDecisionV1FromTurn(completion.turn, expectedContext);
}

module.exports = {
  AUDIT_DECISIONS,
  INDEPENDENT_VERIFICATION_KINDS,
  VERIFICATION_RESULTS,
  WORKER_MODEL_POLICIES,
  AUDIT_DECISION_LIMITS,
  ERROR_CODES,
  createAuditDecisionError,
  parseStrictJson,
  buildAuditDecisionV1OutputSchema,
  parseAuditDecisionV1Text,
  validateAuditDecisionV1,
  extractAuditDecisionV1FromTurn,
  awaitAuditDecisionV1
};

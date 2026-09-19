'use strict';

/**
 * AuditDecisionV1 — Structured Semantic Authority Contract (WP-V4-04 / WO-V4-04F)
 * Strict schema, prototype-free parser, and semantic validator for Native Codex auditor turn output.
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

const MAX_ERROR_MESSAGE_BYTES = 1024;
const MAX_DETAIL_STRING_BYTES = 128;
const FORBIDDEN_MULTILINE_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const FORBIDDEN_SINGLE_LINE_CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/**
 * Truncate a string to a safe UTF-8 byte boundary without splitting multi-byte characters.
 * @param {string} str
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(str, maxBytes) {
  if (typeof str !== 'string') return '';
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) return str;
  let sliceLen = maxBytes;
  while (sliceLen > 0 && (buf[sliceLen] & 0xC0) === 0x80) {
    sliceLen--;
  }
  return buf.toString('utf8', 0, sliceLen);
}

/**
 * Sanitize error details to ensure no nested provider objects, no unbounded strings,
 * and no prototype pollution in details.
 * @param {Object} details
 * @returns {Object}
 */
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return {};
  }
  const clean = {};
  for (const [k, v] of Object.entries(details)) {
    if (k === '__proto__') continue;
    if (typeof v === 'string') {
      clean[k] = Buffer.byteLength(v, 'utf8') > MAX_DETAIL_STRING_BYTES
        ? truncateUtf8(v, MAX_DETAIL_STRING_BYTES)
        : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Create a bounded AuditDecision error satisfying AD-AUTH-02.
 * @param {string} code
 * @param {string} message
 * @param {Object} [details={}]
 * @returns {Error}
 */
function createAuditDecisionError(code, message, details = {}) {
  let boundedMessage = message;
  if (Buffer.byteLength(boundedMessage, 'utf8') > MAX_ERROR_MESSAGE_BYTES) {
    boundedMessage = truncateUtf8(boundedMessage, MAX_ERROR_MESSAGE_BYTES);
  }
  const err = new Error(boundedMessage);
  err.code = code;
  err.details = sanitizeDetails(details);
  return err;
}

/**
 * Check if a value is a plain JSON object (either Object.prototype or null prototype).
 * Rejects class instances, custom prototype objects, arrays, Date, Map, Set, null, primitives.
 * @param {any} val
 * @returns {boolean}
 */
function isPlainJsonObject(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/**
 * Inspect a candidate JSON data object to enforce:
 * 1. Plain object (Object.prototype or null prototype).
 * 2. No symbol own properties (Reflect.ownKeys).
 * 3. No accessor properties (getter or setter) — inspected via descriptors without invoking getters.
 * 4. No non-enumerable properties.
 *
 * Returns an array of valid own enumerable string property names.
 *
 * @param {any} val
 * @param {string} path - path for diagnostic context
 * @returns {string[]} array of own string property names
 */
function inspectPlainJsonDataObject(val, path = '$') {
  if (!isPlainJsonObject(val)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `Value at ${path} must be a plain JSON object`,
      { path }
    );
  }

  const ownKeys = Reflect.ownKeys(val);
  const stringKeys = [];

  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden symbol property at ${path}`,
        { path }
      );
    }

    const desc = Object.getOwnPropertyDescriptor(val, key);
    if (!desc) {
      continue;
    }

    // AD-AUTH-03: Inspect descriptors before any access to prevent invoking getters
    if (desc.get !== undefined || desc.set !== undefined) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden accessor property at ${path}`,
        { path, property: key }
      );
    }

    if (!desc.enumerable) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden non-enumerable property at ${path}`,
        { path, property: key }
      );
    }

    stringKeys.push(key);
  }

  return stringKeys;
}

/**
 * Recursively clone an object into a clean, prototype-free representation.
 * @param {any} obj
 * @returns {any}
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(deepClone);
  }
  const copy = Object.create(null);
  for (const key of Object.keys(obj)) {
    copy[key] = deepClone(obj[key]);
  }
  return copy;
}

/**
 * Recursively freeze an object.
 * @param {any} obj
 * @returns {any}
 */
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
 * Strict recursive-descent JSON parser with duplicate key detection and prototype-free object representation.
 * Enforces raw size bound, RFC 8259 compliance, bounded diagnostics, and single JSON document boundary.
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
      `JSON input exceeds maximum size limit of ${maxBytes} bytes`,
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
              error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid unicode escape');
            }
            str += String.fromCharCode(parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid escape character');
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
    if (isNaN(val)) error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Invalid number format');
    return val;
  }

  function parseObject() {
    index++; // skip '{'
    // AD-AUTH-01: Represent all JSON objects with null prototype so no property behaves as prototype setter
    const obj = Object.create(null);
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
        // AD-AUTH-02: Bounded diagnostic, do not echo raw key
        error(ERROR_CODES.AUDIT_DECISION_DUPLICATE_KEY, 'Duplicate JSON object key');
      }
      seenKeys.add(key);

      skipWhitespace();
      if (index >= len || rawText.charCodeAt(index) !== 0x3A) { // ':'
        error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, "Expected ':' after object key");
      }
      index++; // skip ':'

      skipWhitespace();
      const val = parseValue();

      // AD-AUTH-01: Explicit own property definition ensures __proto__, constructor, etc. are normal own properties
      Object.defineProperty(obj, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true
      });

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

    error(ERROR_CODES.AUDIT_DECISION_INVALID_JSON, 'Unexpected token');
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
 * Enforces plain object (Object.prototype or null), own data properties, and no accessors.
 * @param {Object} expectedContext
 */
function assertExpectedContext(expectedContext) {
  if (!isPlainJsonObject(expectedContext)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'expectedContext must be a plain object with Object.prototype or null prototype'
    );
  }

  const requiredFields = [
    'project_id',
    'audit_subject_id',
    'auditor_thread_id',
    'workspace_state_observed'
  ];

  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(expectedContext, field)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext missing required own property '${field}'`,
        { field }
      );
    }

    const desc = Object.getOwnPropertyDescriptor(expectedContext, field);
    if (desc && (desc.get !== undefined || desc.set !== undefined)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext property '${field}' cannot be an accessor`,
        { field }
      );
    }

    const val = expectedContext[field];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext.${field} must be a non-empty string`,
        { field }
      );
    }
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

  // AD-AUTH-01 & AD-AUTH-03: Plain JSON data object with own keys inventory (no symbols, no non-enumerable, no accessors)
  const actualKeys = inspectPlainJsonDataObject(value, '$');

  const extraKeys = actualKeys.filter(k => !REQUIRED_TOP_LEVEL_KEYS_SET.has(k));
  if (extraKeys.length > 0) {
    // AD-AUTH-02: Bounded diagnostic, do not echo arbitrary extra key
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 contains forbidden extra top-level property',
      { path: '$', extra_property_count: extraKeys.length }
    );
  }

  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecisionV1 missing required top-level key '${key}'`,
        { path: '$', missing_property: key }
      );
    }
  }

  // 1. schema_version
  if (value.schema_version !== 1) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 schema_version must be integer 1',
      { path: 'schema_version' }
    );
  }

  // 2. decision
  if (!Object.values(AUDIT_DECISIONS).includes(value.decision)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 decision value is not allowed',
      { path: 'decision' }
    );
  }

  // 3. Exact Context Identity Matching (byte-for-byte string equality)
  // AD-AUTH-02: Field-only bounded diagnostics; no raw expected/actual value leakage
  if (value.project_id !== expectedContext.project_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'AuditDecisionV1 context mismatch at project_id',
      { field: 'project_id' }
    );
  }
  if (value.audit_subject_id !== expectedContext.audit_subject_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'AuditDecisionV1 context mismatch at audit_subject_id',
      { field: 'audit_subject_id' }
    );
  }
  if (value.auditor_thread_id !== expectedContext.auditor_thread_id) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'AuditDecisionV1 context mismatch at auditor_thread_id',
      { field: 'auditor_thread_id' }
    );
  }
  if (value.workspace_state_observed !== expectedContext.workspace_state_observed) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'AuditDecisionV1 context mismatch at workspace_state_observed',
      { field: 'workspace_state_observed' }
    );
  }

  // 4. summary
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 summary must be a non-empty string',
      { path: 'summary' }
    );
  }
  if (Buffer.byteLength(value.summary, 'utf8') > AUDIT_DECISION_LIMITS.MAX_SUMMARY_BYTES) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `AuditDecisionV1 summary exceeds maximum byte length of ${AUDIT_DECISION_LIMITS.MAX_SUMMARY_BYTES} bytes`,
      { path: 'summary' }
    );
  }
  if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(value.summary)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'AuditDecisionV1 summary contains forbidden control characters',
      { path: 'summary' }
    );
  }

  // 5. independent_verification
  if (!Array.isArray(value.independent_verification)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'independent_verification must be an array',
      { path: 'independent_verification' }
    );
  }
  const ivCount = value.independent_verification.length;
  if (ivCount < AUDIT_DECISION_LIMITS.MIN_VERIFICATION_ITEMS || ivCount > AUDIT_DECISION_LIMITS.MAX_VERIFICATION_ITEMS) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `independent_verification must contain between ${AUDIT_DECISION_LIMITS.MIN_VERIFICATION_ITEMS} and ${AUDIT_DECISION_LIMITS.MAX_VERIFICATION_ITEMS} items; received ${ivCount}`,
      { path: 'independent_verification' }
    );
  }

  const REQUIRED_IV_KEYS = ['kind', 'result', 'evidence'];
  const REQUIRED_IV_KEYS_SET = new Set(REQUIRED_IV_KEYS);
  for (let i = 0; i < ivCount; i++) {
    const iv = value.independent_verification[i];
    const ivPath = `independent_verification[${i}]`;
    // AD-AUTH-01 & AD-AUTH-03: verification items must be plain JSON data objects with exact own keys
    const ivKeys = inspectPlainJsonDataObject(iv, ivPath);
    if (ivKeys.length !== 3 || !ivKeys.every(k => REQUIRED_IV_KEYS_SET.has(k))) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}] contains invalid or forbidden keys`,
        { index: i, path: ivPath }
      );
    }
    for (const key of REQUIRED_IV_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(iv, key)) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
          `independent_verification[${i}] missing required key '${key}'`,
          { index: i, path: ivPath, missing_property: key }
        );
      }
    }
    if (!Object.values(INDEPENDENT_VERIFICATION_KINDS).includes(iv.kind)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'independent_verification kind is invalid',
        { index: i, path: `independent_verification[${i}].kind` }
      );
    }
    if (!Object.values(VERIFICATION_RESULTS).includes(iv.result)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'independent_verification result is invalid; must be PASS, FAIL, or INCONCLUSIVE',
        { index: i, path: `independent_verification[${i}].result` }
      );
    }
    if (typeof iv.evidence !== 'string' || iv.evidence.trim().length === 0) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].evidence must be a non-empty string`,
        { index: i, path: `independent_verification[${i}].evidence` }
      );
    }
    if (Buffer.byteLength(iv.evidence, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].evidence exceeds maximum size limit`,
        { index: i, path: `independent_verification[${i}].evidence` }
      );
    }
    if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(iv.evidence)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `independent_verification[${i}].evidence contains forbidden control characters`,
        { index: i, path: `independent_verification[${i}].evidence` }
      );
    }
  }

  // 6. work_order
  if (value.work_order !== null) {
    const woPath = 'work_order';
    // AD-AUTH-01 & AD-AUTH-03: work_order must be a plain JSON data object with exact own keys
    const woKeys = inspectPlainJsonDataObject(value.work_order, woPath);
    const REQUIRED_WO_KEYS = ['work_order_id', 'directive', 'verification', 'worker_model_policy'];
    const REQUIRED_WO_KEYS_SET = new Set(REQUIRED_WO_KEYS);
    if (woKeys.length !== 4 || !woKeys.every(k => REQUIRED_WO_KEYS_SET.has(k))) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'work_order contains invalid or forbidden keys',
        { path: woPath }
      );
    }
    for (const key of REQUIRED_WO_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(value.work_order, key)) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
          `work_order missing required key '${key}'`,
          { path: woPath, missing_property: key }
        );
      }
    }
    const { work_order_id, directive, verification, worker_model_policy } = value.work_order;

    if (typeof work_order_id !== 'string' || work_order_id.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id must be a non-empty string', { path: 'work_order.work_order_id' });
    }
    if (Buffer.byteLength(work_order_id, 'utf8') > AUDIT_DECISION_LIMITS.MAX_WORK_ORDER_ID_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id exceeds maximum size limit', { path: 'work_order.work_order_id' });
    }
    if (FORBIDDEN_SINGLE_LINE_CONTROL_CHARS.test(work_order_id)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.work_order_id contains forbidden control characters', { path: 'work_order.work_order_id' });
    }

    if (typeof directive !== 'string' || directive.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.directive must be a non-empty string', { path: 'work_order.directive' });
    }
    if (Buffer.byteLength(directive, 'utf8') > AUDIT_DECISION_LIMITS.MAX_DIRECTIVE_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.directive exceeds maximum size limit', { path: 'work_order.directive' });
    }
    if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(directive)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.directive contains forbidden control characters', { path: 'work_order.directive' });
    }

    if (!Array.isArray(verification)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'work_order.verification must be an array', { path: 'work_order.verification' });
    }
    const wovCount = verification.length;
    if (wovCount < AUDIT_DECISION_LIMITS.MIN_WO_VERIFICATION_ITEMS || wovCount > AUDIT_DECISION_LIMITS.MAX_WO_VERIFICATION_ITEMS) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'work_order.verification count is out of bounds',
        { path: 'work_order.verification' }
      );
    }
    for (let i = 0; i < wovCount; i++) {
      const v = verification[i];
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `work_order.verification[${i}] must be a non-empty string`, { path: `work_order.verification[${i}]` });
      }
      if (Buffer.byteLength(v, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
        throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `work_order.verification[${i}] exceeds size limit`, { path: `work_order.verification[${i}]` });
      }
      if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(v)) {
        throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `work_order.verification[${i}] contains forbidden control characters`, { path: `work_order.verification[${i}]` });
      }
    }

    if (!Object.values(WORKER_MODEL_POLICIES).includes(worker_model_policy)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'work_order.worker_model_policy is invalid; allowed: [worker_economy, worker_standard]',
        { path: 'work_order.worker_model_policy' }
      );
    }
  }

  // 7. requested_evidence
  if (!Array.isArray(value.requested_evidence)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'requested_evidence must be an array',
      { path: 'requested_evidence' }
    );
  }
  if (value.requested_evidence.length > AUDIT_DECISION_LIMITS.MAX_REQUESTED_EVIDENCE_ITEMS) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      'requested_evidence item count exceeds maximum limit',
      { path: 'requested_evidence' }
    );
  }
  for (let i = 0; i < value.requested_evidence.length; i++) {
    const re = value.requested_evidence[i];
    if (typeof re !== 'string' || re.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `requested_evidence[${i}] must be a non-empty string`, { path: `requested_evidence[${i}]` });
    }
    if (Buffer.byteLength(re, 'utf8') > AUDIT_DECISION_LIMITS.MAX_EVIDENCE_ITEM_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `requested_evidence[${i}] exceeds size limit`, { path: `requested_evidence[${i}]` });
    }
    if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(re)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, `requested_evidence[${i}] contains forbidden control characters`, { path: `requested_evidence[${i}]` });
    }
  }

  // 8. blocker
  if (value.blocker !== null) {
    if (typeof value.blocker !== 'string' || value.blocker.trim().length === 0) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'blocker must be a non-empty string or null', { path: 'blocker' });
    }
    if (Buffer.byteLength(value.blocker, 'utf8') > AUDIT_DECISION_LIMITS.MAX_BLOCKER_BYTES) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'blocker exceeds maximum byte limit', { path: 'blocker' });
    }
    if (FORBIDDEN_MULTILINE_CONTROL_CHARS.test(value.blocker)) {
      throw createAuditDecisionError(ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID, 'blocker contains forbidden control characters', { path: 'blocker' });
    }
  }

  // 9. Semantic Decision Branch Validation
  switch (value.decision) {
    case AUDIT_DECISIONS.DISPATCH_WORKER:
      if (value.work_order === null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires work_order != null',
          { decision: 'DISPATCH_WORKER' }
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires requested_evidence to be empty',
          { decision: 'DISPATCH_WORKER' }
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'DISPATCH_WORKER requires blocker == null',
          { decision: 'DISPATCH_WORKER' }
        );
      }
      break;

    case AUDIT_DECISIONS.REQUEST_EVIDENCE:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires work_order == null',
          { decision: 'REQUEST_EVIDENCE' }
        );
      }
      if (value.requested_evidence.length < 1) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires at least 1 requested_evidence item',
          { decision: 'REQUEST_EVIDENCE' }
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'REQUEST_EVIDENCE requires blocker == null',
          { decision: 'REQUEST_EVIDENCE' }
        );
      }
      break;

    case AUDIT_DECISIONS.APPROVE_WORK_PACKAGE:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires work_order == null',
          { decision: 'APPROVE_WORK_PACKAGE' }
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires requested_evidence to be empty',
          { decision: 'APPROVE_WORK_PACKAGE' }
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'APPROVE_WORK_PACKAGE requires blocker == null',
          { decision: 'APPROVE_WORK_PACKAGE' }
        );
      }
      for (const iv of value.independent_verification) {
        if (iv.result !== VERIFICATION_RESULTS.PASS) {
          throw createAuditDecisionError(
            ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
            'APPROVE_WORK_PACKAGE requires all independent_verification results to be PASS',
            { decision: 'APPROVE_WORK_PACKAGE' }
          );
        }
      }
      break;

    case AUDIT_DECISIONS.BLOCKED:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires work_order == null',
          { decision: 'BLOCKED' }
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires requested_evidence to be empty',
          { decision: 'BLOCKED' }
        );
      }
      if (typeof value.blocker !== 'string' || value.blocker.trim().length === 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'BLOCKED requires blocker to be a non-empty string',
          { decision: 'BLOCKED' }
        );
      }
      break;

    case AUDIT_DECISIONS.STOP:
      if (value.work_order !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires work_order == null',
          { decision: 'STOP' }
        );
      }
      if (value.requested_evidence.length !== 0) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires requested_evidence to be empty',
          { decision: 'STOP' }
        );
      }
      if (value.blocker !== null) {
        throw createAuditDecisionError(
          ERROR_CODES.AUDIT_DECISION_BRANCH_INVALID,
          'STOP requires blocker == null',
          { decision: 'STOP' }
        );
      }
      break;

    default:
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        'Unhandled decision type',
        { path: 'decision' }
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
      'Turn is not completed; only status=completed provides decision authority',
      { status: turn.status ? String(turn.status).slice(0, 32) : 'unknown' }
    );
  }

  if (turn.itemsView !== 'full') {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_ITEMS_INCOMPLETE,
      'Turn itemsView is incomplete; requires itemsView=full for decision authority',
      { itemsView: turn.itemsView ? String(turn.itemsView).slice(0, 32) : 'unknown' }
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
      'Turn contains multiple agentMessage items with phase=final_answer'
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
        'Turn contains multiple candidate agentMessages with unknown/null phase'
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
 * Wraps TURN_FAILED into bounded AUDIT_DECISION_TURN_NOT_COMPLETED failure.
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
      'AuditDecisionV1 context mismatch at auditor_thread_id',
      { field: 'auditor_thread_id' }
    );
  }

  let completion;
  try {
    completion = await adapter.waitForTurnCompletion({
      threadId,
      turnId,
      timeoutMs
    });
  } catch (err) {
    if (err && err.code === 'TURN_FAILED') {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_TURN_NOT_COMPLETED,
        'Turn failed; failed turns provide zero decision authority',
        { status: 'failed', turnId: String(turnId).slice(0, 64) }
      );
    }
    throw err;
  }

  // AD-AUTH-02: Bounded trusted metadata only, never attach completion or turn objects
  if (!completion || completion.status !== 'completed' || !completion.turn) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_TURN_NOT_COMPLETED,
      'Turn did not complete successfully; non-completed turns provide zero decision authority',
      {
        status: completion && completion.status ? String(completion.status).slice(0, 32) : 'null',
        turnId: String(turnId).slice(0, 64)
      }
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
  MAX_ERROR_MESSAGE_BYTES,
  createAuditDecisionError,
  isPlainJsonObject,
  inspectPlainJsonDataObject,
  parseStrictJson,
  buildAuditDecisionV1OutputSchema,
  parseAuditDecisionV1Text,
  validateAuditDecisionV1,
  extractAuditDecisionV1FromTurn,
  awaitAuditDecisionV1
};

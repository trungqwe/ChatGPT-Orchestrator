'use strict';

const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const MAX_ID_BYTES = 256;
const DEFAULT_MAX_THREADS = 1024;
const DEFAULT_MAX_TURNS = 4096;

const REQUIRED_COUNTERS = Object.freeze([
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens'
]);

/**
 * Helper to create typed error.
 */
function createError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

/**
 * Deep detach helper to prevent mutation of internal state or provider objects.
 */
function deepDetach(obj) {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function validateId(id, fieldName) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      `Field '${fieldName}' must be a non-empty string`
    );
  }
  if (id.trim() !== id) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      `Field '${fieldName}' must not contain surrounding whitespace`
    );
  }
  if (Buffer.byteLength(id, 'utf8') > MAX_ID_BYTES || CONTROL_CHAR_REGEX.test(id)) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      `Field '${fieldName}' exceeds maximum length of ${MAX_ID_BYTES} UTF-8 bytes or contains control characters`
    );
  }
}

/**
 * Validate a single counter value.
 */
function validateCounter(val, counterName, sectionName) {
  if (typeof val !== 'number') {
    throw createError(
      'TOKEN_USAGE_INVALID_COUNTER',
      `Counter '${sectionName}.${counterName}' must be a number; received ${typeof val}`
    );
  }
  if (!Number.isSafeInteger(val)) {
    throw createError(
      'TOKEN_USAGE_INVALID_COUNTER',
      `Counter '${sectionName}.${counterName}' must be a safe integer; received ${val}`
    );
  }
  if (val < 0) {
    throw createError(
      'TOKEN_USAGE_INVALID_COUNTER',
      `Counter '${sectionName}.${counterName}' must be non-negative; received ${val}`
    );
  }
}

/**
 * Validate a breakdown object (total or last).
 */
function validateBreakdown(breakdown, sectionName) {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      `'${sectionName}' breakdown must be a non-null object`
    );
  }
  for (const counter of REQUIRED_COUNTERS) {
    if (!(counter in breakdown) || breakdown[counter] === undefined || breakdown[counter] === null) {
      throw createError(
        'TOKEN_USAGE_INVALID_NOTIFICATION',
        `'${sectionName}' breakdown missing required counter '${counter}'`
      );
    }
    validateCounter(breakdown[counter], counter, sectionName);
  }
}

/**
 * Pure validator for thread/tokenUsage/updated notification shape.
 * Returns detached canonical snapshot if valid, throws structured error if malformed.
 */
function validateTokenUsageNotification(notif) {
  if (!notif || typeof notif !== 'object' || Array.isArray(notif)) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      'Notification must be a non-null object'
    );
  }

  validateId(notif.threadId, 'threadId');
  validateId(notif.turnId, 'turnId');

  const tokenUsage = notif.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object' || Array.isArray(tokenUsage)) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      'Notification must contain a valid tokenUsage object'
    );
  }

  validateBreakdown(tokenUsage.total, 'total');
  validateBreakdown(tokenUsage.last, 'last');

  if (!Object.prototype.hasOwnProperty.call(tokenUsage, 'modelContextWindow')) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      "Missing required property 'modelContextWindow' on tokenUsage object"
    );
  }

  const mcw = tokenUsage.modelContextWindow;
  if (mcw === undefined) {
    throw createError(
      'TOKEN_USAGE_INVALID_NOTIFICATION',
      "'modelContextWindow' cannot be undefined"
    );
  }

  if (mcw !== null) {
    if (typeof mcw !== 'number' || !Number.isSafeInteger(mcw) || mcw < 0) {
      throw createError(
        'TOKEN_USAGE_INVALID_COUNTER',
        `'modelContextWindow' must be null or a non-negative safe integer; received ${mcw}`
      );
    }
  }

  return {
    threadId: notif.threadId,
    turnId: notif.turnId,
    total: {
      totalTokens: tokenUsage.total.totalTokens,
      inputTokens: tokenUsage.total.inputTokens,
      cachedInputTokens: tokenUsage.total.cachedInputTokens,
      cacheWriteInputTokens: tokenUsage.total.cacheWriteInputTokens,
      outputTokens: tokenUsage.total.outputTokens,
      reasoningOutputTokens: tokenUsage.total.reasoningOutputTokens
    },
    last: {
      totalTokens: tokenUsage.last.totalTokens,
      inputTokens: tokenUsage.last.inputTokens,
      cachedInputTokens: tokenUsage.last.cachedInputTokens,
      cacheWriteInputTokens: tokenUsage.last.cacheWriteInputTokens,
      outputTokens: tokenUsage.last.outputTokens,
      reasoningOutputTokens: tokenUsage.last.reasoningOutputTokens
    },
    modelContextWindow: mcw
  };
}

class TokenUsageObserver {
  /**
   * @param {Object} [options]
   * @param {number} [options.maxThreads=1024]
   * @param {number} [options.maxTurns=4096]
   */
  constructor(options = {}) {
    this._maxThreads = (typeof options.maxThreads === 'number' && options.maxThreads > 0)
      ? options.maxThreads
      : DEFAULT_MAX_THREADS;
    this._maxTurns = (typeof options.maxTurns === 'number' && options.maxTurns > 0)
      ? options.maxTurns
      : DEFAULT_MAX_TURNS;

    this._threads = new Map(); // threadId -> snapshot
    this._turns = new Map();   // `${threadId}:${turnId}` -> snapshot
  }

  _recordBounded(map, key, value, limit) {
    if (map.size >= limit && !map.has(key)) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    map.set(key, value);
  }

  /**
   * Validate and record a token usage notification.
   * Preserves provider total and last snapshots exactly without summation or arithmetic derivation.
   * @param {Object} notification
   * @returns {Object} Detached recorded snapshot
   */
  record(notification) {
    const validated = validateTokenUsageNotification(notification);

    const snapshot = deepDetach({
      threadId: validated.threadId,
      turnId: validated.turnId,
      total: validated.total,
      last: validated.last,
      modelContextWindow: validated.modelContextWindow
    });

    this._recordBounded(this._threads, validated.threadId, snapshot, this._maxThreads);
    const turnKey = `${validated.threadId}:${validated.turnId}`;
    this._recordBounded(this._turns, turnKey, snapshot, this._maxTurns);

    return deepDetach(snapshot);
  }

  /**
   * Get latest snapshot for threadId.
   * @param {string} threadId
   * @returns {Object|null} Detached snapshot or null
   */
  getLatestForThread(threadId) {
    if (typeof threadId !== 'string' || threadId.trim().length === 0) return null;
    const snapshot = this._threads.get(threadId);
    if (!snapshot) return null;
    return deepDetach(snapshot);
  }

  /**
   * Get latest snapshot for exact threadId and turnId.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string} params.turnId
   * @returns {Object|null} Detached snapshot or null
   */
  getLatestForTurn(params = {}) {
    if (!params || typeof params !== 'object') return null;
    const { threadId, turnId } = params;
    if (typeof threadId !== 'string' || typeof turnId !== 'string') return null;
    if (threadId.trim().length === 0 || turnId.trim().length === 0) return null;
    const turnKey = `${threadId}:${turnId}`;
    const snapshot = this._turns.get(turnKey);
    if (!snapshot) return null;
    return deepDetach(snapshot);
  }

  /**
   * Clear all recorded usage state.
   */
  clear() {
    this._threads.clear();
    this._turns.clear();
  }
}

/**
 * Factory function.
 * @param {Object} [options]
 * @returns {TokenUsageObserver}
 */
function createTokenUsageObserver(options) {
  return new TokenUsageObserver(options);
}

module.exports = {
  TokenUsageObserver,
  createTokenUsageObserver,
  validateTokenUsageNotification,
  createError,
  deepDetach,
  REQUIRED_COUNTERS
};

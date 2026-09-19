'use strict';

const path = require('path');
const { CodexAppServerClient, createError } = require('./codex-app-server-client');

const ALLOWED_REVIEW_TARGET_TYPES = new Set([
  'uncommittedChanges',
  'baseBranch',
  'commit',
  'custom'
]);

const MAX_INPUT_TEXT_BYTES = 1024 * 1024; // 1 MiB
const MAX_OUTPUT_SCHEMA_BYTES = 512 * 1024; // 512 KiB

/**
 * Deep detach helper to prevent mutation of internal state or provider objects.
 */
function deepDetach(obj) {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

class CodexAuditorAdapter {
  /**
   * @param {Object} [options]
   * @param {CodexAppServerClient} [options.client]
   */
  constructor(options = {}) {
    this._options = options;
    this._client = options.client || new CodexAppServerClient(options);
    this._initialized = false;
  }

  /**
   * Return underlying transport client.
   * @returns {CodexAppServerClient}
   */
  getClient() {
    return this._client;
  }

  /**
   * Initialize auditor connection.
   * Idempotent: safe to call multiple times.
   * @returns {Promise<Object>}
   */
  async initialize() {
    if (this._initialized) {
      return { initialized: true, state: this._client.getState() };
    }
    const result = await this._client.initialize();
    this._initialized = true;
    return deepDetach(result);
  }

  /**
   * List available models from App Server.
   * Does NOT perform model tier resolution (reserved for WP-V4-06).
   * @returns {Promise<Object[]>}
   */
  async listModels() {
    const result = await this._client.sendRequest('model/list', {}, {
      isSideEffecting: false
    });

    if (!result || typeof result !== 'object') {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'model/list response must be a JSON object'
      );
    }

    const models = Array.isArray(result.models)
      ? result.models
      : (Array.isArray(result.data) ? result.data : []);

    return deepDetach(models);
  }

  /**
   * Start a new auditor thread with read-only security defaults.
   * Requires absolute cwd. Never writes to Registry.
   * @param {Object} params
   * @param {string} params.cwd
   * @param {boolean} [params.readOnly=true]
   * @returns {Promise<{ threadId: string, sessionId: string|null, raw: Object }>}
   */
  async startThread(params = {}) {
    if (!params || typeof params !== 'object') {
      throw createError(
        'INVALID_ARGUMENT',
        'startThread requires a parameters object'
      );
    }

    const { cwd, readOnly = true } = params;

    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw createError(
        'INVALID_ARGUMENT',
        `cwd must be an absolute path: received '${cwd}'`
      );
    }

    // Security check: reject privilege escalation attempts in auditor defaults
    if (params.dangerFullAccess === true || params.workspaceWrite === true) {
      throw createError(
        'CODEX_APP_SERVER_SECURITY_VIOLATION',
        'Auditor default policy rejects dangerFullAccess and workspaceWrite capability'
      );
    }

    const requestParams = {
      cwd,
      readOnly: readOnly !== false
    };
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('_')) {
        requestParams[k] = v;
      }
    }

    const result = await this._client.sendRequest('thread/start', requestParams, {
      isSideEffecting: true
    });

    if (!result || typeof result !== 'object') {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'thread/start response must be a JSON object'
      );
    }

    const threadObj = result.thread || result;
    const threadId = threadObj.id || threadObj.threadId;

    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'thread/start response missing valid thread id'
      );
    }

    const sessionId = threadObj.sessionId || null;

    return {
      threadId,
      sessionId,
      raw: deepDetach(result)
    };
  }

  /**
   * Resume an existing thread by exact ID.
   * Propagates error on failure; never creates a replacement thread automatically.
   * @param {Object} params
   * @param {string} params.threadId
   * @returns {Promise<{ threadId: string, resumed: boolean, raw: Object }>}
   */
  async resumeThread(params = {}) {
    if (!params || typeof params.threadId !== 'string' || params.threadId.trim().length === 0) {
      throw createError(
        'INVALID_ARGUMENT',
        'resumeThread requires an exact non-empty threadId'
      );
    }

    const { threadId } = params;
    const requestParams = { threadId };
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('_')) {
        requestParams[k] = v;
      }
    }
    const result = await this._client.sendRequest('thread/resume', requestParams, {
      isSideEffecting: false
    });

    return {
      threadId,
      resumed: true,
      raw: deepDetach(result)
    };
  }

  /**
   * Read thread by exact ID.
   * Default includeTurns = false. No implicit resume.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {boolean} [params.includeTurns=false]
   * @returns {Promise<Object>}
   */
  async readThread(params = {}) {
    if (!params || typeof params.threadId !== 'string' || params.threadId.trim().length === 0) {
      throw createError(
        'INVALID_ARGUMENT',
        'readThread requires an exact non-empty threadId'
      );
    }

    const { threadId, includeTurns = false } = params;
    const requestParams = {
      threadId,
      includeTurns: Boolean(includeTurns)
    };
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('_')) {
        requestParams[k] = v;
      }
    }
    const result = await this._client.sendRequest('thread/read', requestParams, {
      isSideEffecting: false
    });

    return deepDetach(result);
  }

  /**
   * Start turn on an existing thread.
   * Input is restricted to bounded text. Forward outputSchema if supplied.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {Array<{ type: string, text: string }>} params.input
   * @param {Object} [params.outputSchema]
   * @returns {Promise<{ turnId: string, status: string, raw: Object }>}
   */
  async startTurn(params = {}) {
    if (!params || typeof params.threadId !== 'string' || params.threadId.trim().length === 0) {
      throw createError(
        'INVALID_ARGUMENT',
        'startTurn requires an exact non-empty threadId'
      );
    }

    const { threadId, input, outputSchema } = params;

    if (!Array.isArray(input) || input.length === 0) {
      throw createError(
        'INVALID_ARGUMENT',
        'startTurn input must be a non-empty array'
      );
    }

    let totalBytes = 0;
    for (const item of input) {
      if (!item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string') {
        throw createError(
          'INPUT_TYPE_UNSUPPORTED',
          'Only text input items ({ type: "text", text: "..." }) are supported in WP03A'
        );
      }
      totalBytes += Buffer.byteLength(item.text, 'utf8');
      if (totalBytes > MAX_INPUT_TEXT_BYTES) {
        throw createError(
          'INPUT_TOO_LARGE',
          `Input text exceeded maximum allowed bound (${MAX_INPUT_TEXT_BYTES} bytes)`
        );
      }
    }

    const requestParams = {
      threadId,
      input
    };
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('_')) {
        requestParams[k] = v;
      }
    }

    if (outputSchema !== undefined) {
      if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) {
        throw createError(
          'INVALID_ARGUMENT',
          'outputSchema must be a valid JSON object'
        );
      }
      const schemaString = JSON.stringify(outputSchema);
      if (Buffer.byteLength(schemaString, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
        throw createError(
          'OUTPUT_SCHEMA_TOO_LARGE',
          `outputSchema exceeded maximum bound (${MAX_OUTPUT_SCHEMA_BYTES} bytes)`
        );
      }
      requestParams.outputSchema = outputSchema;
    }

    const result = await this._client.sendRequest('turn/start', requestParams, {
      isSideEffecting: true
    });

    if (!result || typeof result !== 'object') {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'turn/start response must be a JSON object'
      );
    }

    const turnObj = result.turn || result;
    const turnId = turnObj.id || turnObj.turnId;

    if (typeof turnId !== 'string' || turnId.trim().length === 0) {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'turn/start response missing valid turn id'
      );
    }

    const status = turnObj.status || 'in_progress';

    return {
      turnId,
      status,
      raw: deepDetach(result)
    };
  }

  /**
   * Wait for turn to complete by correlating exact threadId and turnId from turn/completed notification.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string} params.turnId
   * @param {number} [params.timeoutMs=60000]
   * @returns {Promise<{ threadId: string, turnId: string, status: string, turn: Object }>}
   */
  async waitForTurnCompletion(params = {}) {
    const { threadId, turnId, timeoutMs = 60000 } = params;

    if (typeof threadId !== 'string' || typeof turnId !== 'string') {
      throw createError(
        'INVALID_ARGUMENT',
        'waitForTurnCompletion requires valid threadId and turnId strings'
      );
    }

    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._client.removeListener('turn/completed', onTurnCompleted);
      };

      const onTurnCompleted = (notifParams) => {
        if (!notifParams || typeof notifParams !== 'object') return;

        // Correlate exact threadId and turnId
        const notifThreadId = notifParams.threadId;
        const turnObj = notifParams.turn || notifParams;
        const notifTurnId = turnObj.id || turnObj.turnId;

        if (notifThreadId !== threadId || notifTurnId !== turnId) {
          // Unrelated turn completion; ignore
          return;
        }

        cleanup();

        const status = turnObj.status;
        if (status === 'completed' || status === 'interrupted') {
          resolve({
            threadId,
            turnId,
            status,
            turn: deepDetach(turnObj)
          });
        } else if (status === 'failed') {
          reject(
            createError(
              'TURN_FAILED',
              `Turn '${turnId}' failed: ${turnObj.error?.message || 'unknown failure'}`,
              { turn: deepDetach(turnObj) }
            )
          );
        } else {
          reject(
            createError(
              'UNRECOGNIZED_TURN_STATUS',
              `Turn completed with unrecognized status '${status}'`,
              { turn: deepDetach(turnObj) }
            )
          );
        }
      };

      this._client.on('turn/completed', onTurnCompleted);

      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            createError(
              'WAIT_TURN_TIMEOUT',
              `Timed out after ${timeoutMs}ms waiting for turn '${turnId}' on thread '${threadId}' to complete`
            )
          );
        }, timeoutMs);
      }
    });
  }

  /**
   * Interrupt a running turn by exact threadId and turnId.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string} params.turnId
   * @returns {Promise<Object>}
   */
  async interruptTurn(params = {}) {
    const { threadId, turnId } = params;

    if (typeof threadId !== 'string' || typeof turnId !== 'string') {
      throw createError(
        'INVALID_ARGUMENT',
        'interruptTurn requires valid threadId and turnId strings'
      );
    }

    const result = await this._client.sendRequest('turn/interrupt', {
      threadId,
      turnId
    }, {
      isSideEffecting: true
    });

    return deepDetach(result);
  }

  /**
   * Start a review turn.
   * For v4 primary architecture, allows only inline delivery.
   * Validates target type and ensures returned reviewThreadId matches requested threadId.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string|Object} params.target
   * @param {string} [params.delivery='inline']
   * @returns {Promise<{ turnId: string, reviewThreadId: string, status: string, raw: Object }>}
   */
  async startReview(params = {}) {
    if (!params || typeof params !== 'object') {
      throw createError('INVALID_ARGUMENT', 'startReview requires a parameters object');
    }

    const { threadId, target, delivery = 'inline' } = params;

    if (typeof threadId !== 'string' || threadId.trim().length === 0) {
      throw createError('INVALID_ARGUMENT', 'startReview requires an exact threadId');
    }

    if (delivery !== 'inline') {
      throw createError(
        'DETACHED_REVIEW_UNSUPPORTED',
        `Only inline review delivery is supported in v4 architecture; received delivery='${delivery}'`
      );
    }

    // Validate review target
    let targetType;
    if (typeof target === 'string') {
      targetType = target;
    } else if (target && typeof target === 'object' && typeof target.type === 'string') {
      targetType = target.type;
    }

    if (!targetType || !ALLOWED_REVIEW_TARGET_TYPES.has(targetType)) {
      throw createError(
        'INVALID_REVIEW_TARGET',
        `Unsupported review target type '${targetType}'. Allowed: ${[...ALLOWED_REVIEW_TARGET_TYPES].join(', ')}`
      );
    }

    const requestParams = {
      threadId,
      target,
      delivery
    };
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('_')) {
        requestParams[k] = v;
      }
    }

    const result = await this._client.sendRequest('review/start', requestParams, {
      isSideEffecting: true
    });

    if (!result || typeof result !== 'object') {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'review/start response must be a JSON object'
      );
    }

    const reviewThreadId = result.reviewThreadId || result.threadId || (result.thread && result.thread.id);
    if (reviewThreadId !== threadId) {
      throw createError(
        'CODEX_APP_SERVER_THREAD_MISMATCH',
        `Inline review returned mismatched threadId '${reviewThreadId}'; expected '${threadId}'`
      );
    }

    const turnObj = result.turn || result;
    const turnId = turnObj.id || turnObj.turnId;

    if (typeof turnId !== 'string' || turnId.trim().length === 0) {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        'review/start response missing valid turn id'
      );
    }

    return {
      turnId,
      reviewThreadId,
      status: turnObj.status || 'in_progress',
      raw: deepDetach(result)
    };
  }

  /**
   * Wait for review completion.
   * Requires matching exitedReviewMode evidence and matching turn/completed notification.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string} params.turnId
   * @param {number} [params.timeoutMs=60000]
   * @returns {Promise<{ threadId: string, turnId: string, status: string, reviewEvidence: Object|null, turn: Object }>}
   */
  async waitForReviewCompletion(params = {}) {
    const { threadId, turnId, timeoutMs = 60000 } = params;

    if (typeof threadId !== 'string' || typeof turnId !== 'string') {
      throw createError(
        'INVALID_ARGUMENT',
        'waitForReviewCompletion requires valid threadId and turnId strings'
      );
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      let capturedReviewEvidence = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._client.removeListener('item/completed', onItemCompleted);
        this._client.removeListener('turn/completed', onTurnCompleted);
      };

      const onItemCompleted = (itemParams) => {
        if (!itemParams || typeof itemParams !== 'object') return;
        const item = itemParams.item || itemParams;
        if (item.type === 'exitedReviewMode') {
          capturedReviewEvidence = deepDetach(item);
        }
      };

      const onTurnCompleted = (notifParams) => {
        if (!notifParams || typeof notifParams !== 'object') return;

        const notifThreadId = notifParams.threadId;
        const turnObj = notifParams.turn || notifParams;
        const notifTurnId = turnObj.id || turnObj.turnId;

        if (notifThreadId !== threadId || notifTurnId !== turnId) {
          return;
        }

        cleanup();

        const status = turnObj.status;
        if (status === 'completed' || status === 'interrupted') {
          resolve({
            threadId,
            turnId,
            status,
            reviewEvidence: capturedReviewEvidence,
            turn: deepDetach(turnObj)
          });
        } else if (status === 'failed') {
          reject(
            createError(
              'TURN_FAILED',
              `Review turn '${turnId}' failed`,
              { turn: deepDetach(turnObj) }
            )
          );
        } else {
          reject(
            createError(
              'UNRECOGNIZED_TURN_STATUS',
              `Review turn completed with unexpected status '${status}'`,
              { turn: deepDetach(turnObj) }
            )
          );
        }
      };

      this._client.on('item/completed', onItemCompleted);
      this._client.on('turn/completed', onTurnCompleted);

      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            createError(
              'WAIT_REVIEW_TIMEOUT',
              `Timed out after ${timeoutMs}ms waiting for review turn '${turnId}' on thread '${threadId}' to complete`
            )
          );
        }, timeoutMs);
      }
    });
  }

  /**
   * Close adapter and underlying transport client cleanly.
   * @returns {Promise<void>}
   */
  async close() {
    this._initialized = false;
    await this._client.close();
  }
}

module.exports = {
  CodexAuditorAdapter,
  ALLOWED_REVIEW_TARGET_TYPES,
  MAX_INPUT_TEXT_BYTES,
  MAX_OUTPUT_SCHEMA_BYTES,
  deepDetach
};

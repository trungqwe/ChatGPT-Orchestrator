'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { CodexAppServerClient, createError } = require('./codex-app-server-client');

const ALLOWED_REVIEW_TARGET_TYPES = new Set([
  'uncommittedChanges',
  'baseBranch',
  'commit',
  'custom'
]);

/**
 * Thread lifecycle sandbox modes (ThreadStartParams.sandbox -> SandboxMode enum).
 * Uses kebab-case: 'read-only' | 'workspace-write' | 'danger-full-access'.
 * NOTE: Distinct from TurnStartParams.sandboxPolicy.type which uses camelCase SandboxPolicy ('readOnly', etc.).
 */
const THREAD_SANDBOX_MODES = Object.freeze({
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  DANGER_FULL_ACCESS: 'danger-full-access'
});

const MAX_INPUT_TEXT_BYTES = 1024 * 1024; // 1 MiB
const MAX_OUTPUT_SCHEMA_BYTES = 512 * 1024; // 512 KiB
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
const MAX_MODEL_LIST_PAGES = 50;
const MAX_MODEL_CATALOG_ENTRIES = 1000;
const MAX_CURSOR_BYTES = 512;
const MAX_MODEL_IDENTIFIER_BYTES = 256;
const MAX_EFFORT_BYTES = 64;

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

    // Bounded maps (Sections 12, 14, 15, 18)
    this._turnOwnership = new Map(); // turnId -> threadId (max 4,096)
    this._turnCompletionCache = new Map(); // turnId -> { threadId, turnId, status, turn } (max 4,096)
    this._reviewEvidenceCache = new Map(); // turnId -> item (max 4,096)
    this._emitter = new EventEmitter();

    // Listen to client notifications for early completion / evidence caching
    this._client.on('turn/completed', (notifParams) => this._onTurnCompleted(notifParams));
    this._client.on('item/completed', (itemParams) => this._onItemCompleted(itemParams));
  }

  /**
   * Return underlying transport client.
   * @returns {CodexAppServerClient}
   */
  getClient() {
    return this._client;
  }

  /**
   * Bounded map insertion helper.
   * @private
   */
  _recordBounded(map, key, value, limit = 4096) {
    if (map.size >= limit) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    map.set(key, value);
  }

  /**
   * Handle turn/completed notification from client.
   * @private
   */
  _onTurnCompleted(notifParams) {
    if (!notifParams || typeof notifParams !== 'object') return;
    const turn = notifParams.turn || notifParams;
    const turnId = turn.id || turn.turnId;
    if (!turnId) return;

    const notifThreadId = notifParams.threadId;
    const localThreadId = this._turnOwnership.get(turnId);

    // Section 13: validate optional threadId against local ownership
    if (notifThreadId && localThreadId && notifThreadId !== localThreadId) {
      const mismatchRecord = {
        turnId,
        threadId: notifThreadId,
        mismatch: true,
        error: createError(
          'CODEX_APP_SERVER_THREAD_MISMATCH',
          `Notification threadId '${notifThreadId}' does not match local threadId '${localThreadId}'`
        )
      };
      this._recordBounded(this._turnCompletionCache, turnId, mismatchRecord);
      this._emitter.emit('turn_completed_' + turnId, mismatchRecord);
      return;
    }

    const resolvedThreadId = localThreadId || notifThreadId || null;
    const record = {
      threadId: resolvedThreadId,
      turnId,
      status: turn.status,
      turn: deepDetach(turn)
    };

    this._recordBounded(this._turnCompletionCache, turnId, record);
    this._emitter.emit('turn_completed_' + turnId, record);
  }

  /**
   * Handle item/completed notification from client for review evidence.
   * @private
   */
  _onItemCompleted(itemParams) {
    if (!itemParams || typeof itemParams !== 'object') return;
    const item = itemParams.item || itemParams;
    if (item && item.type === 'exitedReviewMode' && item.id) {
      const turnId = item.id;
      const evidence = deepDetach(item);
      this._recordBounded(this._reviewEvidenceCache, turnId, evidence);
      this._emitter.emit('review_evidence_' + turnId, evidence);
    }
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
   * List available models from App Server with pagination support (WP-V4-06A).
   * Consumes complete visible catalog with bounded pages and entry limits.
   * @param {Object} [options]
   * @param {boolean} [options.includeHidden=false]
   * @param {number} [options.limit=100]
   * @returns {Promise<Object[]>}
   */
  async listModels(options = {}) {
    const includeHidden = options.includeHidden === true;
    const pageLimit = (typeof options.limit === 'number' && options.limit > 0 && options.limit <= 100)
      ? options.limit
      : 100;

    const allModels = [];
    const seenCursors = new Set();
    let currentCursor = null;
    let pageCount = 0;

    while (pageCount < MAX_MODEL_LIST_PAGES) {
      pageCount++;
      const requestParams = {
        includeHidden,
        limit: pageLimit
      };
      if (currentCursor !== null) {
        requestParams.cursor = currentCursor;
      }

      const result = await this._client.sendRequest('model/list', requestParams, {
        isSideEffecting: false
      });

      if (!result || typeof result !== 'object') {
        throw createError(
          'CODEX_APP_SERVER_INVALID_RESPONSE',
          'model/list response must be a JSON object'
        );
      }

      let pageModels;
      let hasNextCursorField = false;
      let nextCursor = null;

      if (Array.isArray(result.data)) {
        pageModels = result.data;
        if ('nextCursor' in result) {
          hasNextCursorField = true;
          nextCursor = result.nextCursor;
        }
      } else if (Array.isArray(result.models)) {
        pageModels = result.models;
        if ('nextCursor' in result) {
          hasNextCursorField = true;
          nextCursor = result.nextCursor;
        }
      } else {
        throw createError(
          'CODEX_APP_SERVER_INVALID_RESPONSE',
          'model/list response missing array catalog property (data or models)'
        );
      }

      for (const item of pageModels) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw createError(
            'CODEX_APP_SERVER_INVALID_RESPONSE',
            'model/list catalog entry must be an object'
          );
        }
        allModels.push(item);
        if (allModels.length > MAX_MODEL_CATALOG_ENTRIES) {
          throw createError(
            'CODEX_APP_SERVER_INVALID_RESPONSE',
            `model/list catalog exceeded maximum bound (${MAX_MODEL_CATALOG_ENTRIES} entries)`
          );
        }
      }

      // Check nextCursor validity
      if (!hasNextCursorField || nextCursor === null || nextCursor === undefined) {
        // Single page or terminal page reached
        break;
      }

      if (typeof nextCursor !== 'string' || nextCursor.trim().length === 0) {
        throw createError(
          'CODEX_APP_SERVER_INVALID_RESPONSE',
          'model/list nextCursor must be a non-empty string or null'
        );
      }

      if (Buffer.byteLength(nextCursor, 'utf8') > MAX_CURSOR_BYTES) {
        throw createError(
          'CODEX_APP_SERVER_INVALID_RESPONSE',
          `model/list nextCursor exceeded maximum bound (${MAX_CURSOR_BYTES} bytes)`
        );
      }

      if (seenCursors.has(nextCursor)) {
        throw createError(
          'CODEX_APP_SERVER_INVALID_RESPONSE',
          `model/list detected repeated cursor or pagination cycle: '${nextCursor}'`
        );
      }

      seenCursors.add(nextCursor);
      currentCursor = nextCursor;
    }

    if (pageCount >= MAX_MODEL_LIST_PAGES && currentCursor !== null) {
      throw createError(
        'CODEX_APP_SERVER_INVALID_RESPONSE',
        `model/list exceeded maximum page limit (${MAX_MODEL_LIST_PAGES} pages)`
      );
    }

    return deepDetach(allModels);
  }

  /**
   * Start a new auditor thread with stable security defaults.
   * Requires absolute cwd.
   * Sends approvalPolicy="never" and sandbox="readOnly" (CASPROTO-01).
   * Never writes to Registry.
   * @param {Object} params
   * @param {string} params.cwd
   * @returns {Promise<{ threadId: string, sessionId: string|null, raw: Object }>}
   */
  async startThread(params = {}) {
    if (!params || typeof params !== 'object') {
      throw createError(
        'INVALID_ARGUMENT',
        'startThread requires a parameters object'
      );
    }

    const { cwd } = params;

    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw createError(
        'INVALID_ARGUMENT',
        `cwd must be an absolute path: received '${cwd}'`
      );
    }

    // Security check: reject invented boolean fields (Sections 3, 53)
    if (
      params.readOnly !== undefined ||
      params.workspaceWrite !== undefined ||
      params.dangerFullAccess !== undefined
    ) {
      throw createError(
        'CODEX_APP_SERVER_SECURITY_VIOLATION',
        'Invented boolean protocol fields (readOnly, workspaceWrite, dangerFullAccess) are forbidden'
      );
    }

    const requestParams = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only'
    };

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
   * Validates provider response matches requested ID (Section 24).
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
    const result = await this._client.sendRequest('thread/resume', { threadId }, {
      isSideEffecting: false
    });

    // Exact-ID verification on response (Section 24)
    const returnedId = result?.thread?.id || result?.id || result?.threadId;
    if (returnedId !== threadId) {
      throw createError(
        'CODEX_APP_SERVER_THREAD_MISMATCH',
        `thread/resume returned threadId '${returnedId}', expected '${threadId}'`
      );
    }

    return {
      threadId,
      resumed: true,
      raw: deepDetach(result)
    };
  }

  /**
   * Read thread by exact ID.
   * Validates provider response matches requested ID (Section 25).
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
    const result = await this._client.sendRequest('thread/read', {
      threadId,
      includeTurns: Boolean(includeTurns)
    }, {
      isSideEffecting: false
    });

    // Exact-ID verification on response (Section 25)
    const returnedId = result?.thread?.id || result?.id || result?.threadId;
    if (returnedId !== threadId) {
      throw createError(
        'CODEX_APP_SERVER_THREAD_MISMATCH',
        `thread/read returned threadId '${returnedId}', expected '${threadId}'`
      );
    }

    return deepDetach(result);
  }

  /**
   * Start turn on an existing thread.
   * Input is restricted to bounded text. Forward outputSchema if supplied.
   * Optionally accepts model and effort pinning (WP-V4-06A).
   * Records local turn ownership (Section 12).
   * @param {Object} params
   * @param {string} params.threadId
   * @param {Array<{ type: string, text: string }>} params.input
   * @param {Object} [params.outputSchema]
   * @param {string} [params.model]
   * @param {string} [params.effort]
   * @returns {Promise<{ turnId: string, status: string, raw: Object }>}
   */
  async startTurn(params = {}) {
    if (!params || typeof params.threadId !== 'string' || params.threadId.trim().length === 0) {
      throw createError(
        'INVALID_ARGUMENT',
        'startTurn requires an exact non-empty threadId'
      );
    }

    const { threadId, input, outputSchema, model, effort } = params;

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

    if (model !== undefined) {
      if (
        typeof model !== 'string' ||
        model.trim().length === 0 ||
        model.trim() !== model ||
        Buffer.byteLength(model, 'utf8') > MAX_MODEL_IDENTIFIER_BYTES ||
        CONTROL_CHAR_REGEX.test(model)
      ) {
        throw createError(
          'INVALID_ARGUMENT',
          'model must be a bounded non-empty string without surrounding whitespace or control characters'
        );
      }
      requestParams.model = model;
    }

    if (effort !== undefined) {
      if (
        typeof effort !== 'string' ||
        effort.trim().length === 0 ||
        effort.trim() !== effort ||
        Buffer.byteLength(effort, 'utf8') > MAX_EFFORT_BYTES ||
        CONTROL_CHAR_REGEX.test(effort)
      ) {
        throw createError(
          'INVALID_ARGUMENT',
          'effort must be a bounded non-empty string without surrounding whitespace or control characters'
        );
      }
      requestParams.effort = effort;
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

    // Record local turn ownership (Section 12)
    this._recordBounded(this._turnOwnership, turnId, threadId);

    const status = turnObj.status || 'inProgress';

    return {
      turnId,
      status,
      raw: deepDetach(result)
    };
  }

  /**
   * Helper to resolve a completed turn record.
   * @private
   */
  _resolveTurnRecord(record, expectedThreadId, turnId) {
    const status = record.status;
    if (status === 'completed' || status === 'interrupted') {
      return {
        threadId: expectedThreadId,
        turnId,
        status,
        turn: record.turn
      };
    }
    if (status === 'failed') {
      throw createError(
        'TURN_FAILED',
        `Turn '${turnId}' failed: ${record.turn?.error?.message || 'unknown failure'}`,
        { turn: record.turn }
      );
    }
    throw createError(
      'UNRECOGNIZED_TURN_STATUS',
      `Turn completed with unrecognized status '${status}'`,
      { turn: record.turn }
    );
  }

  /**
   * Wait for turn to complete by correlating exact turnId and local thread ownership.
   * Eliminates early completion race via bounded cache (Sections 11, 12, 14, 16).
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

    // Section 16: validate local ownership immediately
    const ownedThread = this._turnOwnership.get(turnId);
    if (ownedThread && ownedThread !== threadId) {
      throw createError(
        'CODEX_APP_SERVER_THREAD_MISMATCH',
        `Turn '${turnId}' belongs to thread '${ownedThread}', not '${threadId}'`
      );
    }

    // Section 14: check already-cached completion
    const cached = this._turnCompletionCache.get(turnId);
    if (cached) {
      if (cached.mismatch) throw cached.error;
      return this._resolveTurnRecord(cached, threadId, turnId);
    }

    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._emitter.removeListener('turn_completed_' + turnId, onCompleted);
      };

      const onCompleted = (record) => {
        cleanup();
        if (record.mismatch) {
          return reject(record.error);
        }
        try {
          const res = this._resolveTurnRecord(record, threadId, turnId);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      };

      this._emitter.once('turn_completed_' + turnId, onCompleted);

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

    this._turnOwnership.set(turnId, threadId);

    return deepDetach(result);
  }

  /**
   * Start a review turn.
   * For v4 primary architecture, allows only inline delivery.
   * Target must be a strict structured object (Sections 21, 22).
   * @param {Object} params
   * @param {string} params.threadId
   * @param {Object} params.target
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

    // Section 21: Target must be a structured object (reject strings)
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw createError(
        'INVALID_REVIEW_TARGET',
        'Review target must be a structured object'
      );
    }

    const targetType = target.type;
    if (!ALLOWED_REVIEW_TARGET_TYPES.has(targetType)) {
      throw createError(
        'INVALID_REVIEW_TARGET',
        `Unsupported review target type '${targetType}'. Allowed: ${[...ALLOWED_REVIEW_TARGET_TYPES].join(', ')}`
      );
    }

    // Section 22: Strict field validation
    const targetKeys = Object.keys(target);
    if (targetType === 'uncommittedChanges') {
      if (targetKeys.length !== 1) {
        throw createError('INVALID_REVIEW_TARGET', 'uncommittedChanges target must not contain extra fields');
      }
    } else if (targetType === 'baseBranch') {
      if (typeof target.branch !== 'string' || !target.branch) {
        throw createError('INVALID_REVIEW_TARGET', 'baseBranch target requires a non-empty branch string');
      }
      for (const k of targetKeys) {
        if (k !== 'type' && k !== 'branch') {
          throw createError('INVALID_REVIEW_TARGET', `Unknown field '${k}' in baseBranch target`);
        }
      }
    } else if (targetType === 'commit') {
      if (typeof target.sha !== 'string' || !target.sha) {
        throw createError('INVALID_REVIEW_TARGET', 'commit target requires a non-empty sha string');
      }
      for (const k of targetKeys) {
        if (k !== 'type' && k !== 'sha' && k !== 'title') {
          throw createError('INVALID_REVIEW_TARGET', `Unknown field '${k}' in commit target`);
        }
      }
    } else if (targetType === 'custom') {
      if (typeof target.instructions !== 'string' || !target.instructions) {
        throw createError('INVALID_REVIEW_TARGET', 'custom target requires a non-empty instructions string');
      }
      for (const k of targetKeys) {
        if (k !== 'type' && k !== 'instructions') {
          throw createError('INVALID_REVIEW_TARGET', `Unknown field '${k}' in custom target`);
        }
      }
    }

    const requestParams = {
      threadId,
      target,
      delivery
    };

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

    // Record turn ownership
    this._recordBounded(this._turnOwnership, turnId, threadId);

    return {
      turnId,
      reviewThreadId,
      status: turnObj.status || 'inProgress',
      raw: deepDetach(result)
    };
  }

  /**
   * Wait for review completion.
   * Requires BOTH exact exitedReviewMode evidence and terminal turn/completed notification (Sections 17, 18, 19, 20).
   * Eliminates early evidence / early completion race via bounded caches.
   * @param {Object} params
   * @param {string} params.threadId
   * @param {string} params.turnId
   * @param {number} [params.timeoutMs=60000]
   * @returns {Promise<{ threadId: string, turnId: string, status: string, reviewEvidence: Object, turn: Object }>}
   */
  async waitForReviewCompletion(params = {}) {
    const { threadId, turnId, timeoutMs = 60000 } = params;

    if (typeof threadId !== 'string' || typeof turnId !== 'string') {
      throw createError(
        'INVALID_ARGUMENT',
        'waitForReviewCompletion requires valid threadId and turnId strings'
      );
    }

    // Validate ownership
    const ownedThread = this._turnOwnership.get(turnId);
    if (ownedThread && ownedThread !== threadId) {
      throw createError(
        'CODEX_APP_SERVER_THREAD_MISMATCH',
        `Review turn '${turnId}' belongs to thread '${ownedThread}', not '${threadId}'`
      );
    }

    const checkReady = (evidence, completion) => {
      if (evidence && completion) {
        if (completion.status === 'failed') {
          throw createError(
            'TURN_FAILED',
            `Review turn '${turnId}' failed: ${completion.turn?.error?.message || 'unknown failure'}`,
            { turn: completion.turn }
          );
        }
        return {
          threadId,
          turnId,
          status: completion.status,
          reviewEvidence: evidence,
          turn: completion.turn
        };
      }
      return null;
    };

    let existingEvidence = this._reviewEvidenceCache.get(turnId) || null;
    let existingCompletion = this._turnCompletionCache.get(turnId) || null;

    const readyNow = checkReady(existingEvidence, existingCompletion);
    if (readyNow) return readyNow;

    return new Promise((resolve, reject) => {
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._emitter.removeListener('review_evidence_' + turnId, onEvidence);
        this._emitter.removeListener('turn_completed_' + turnId, onCompleted);
      };

      const onEvidence = (evidence) => {
        existingEvidence = evidence;
        try {
          const res = checkReady(existingEvidence, existingCompletion);
          if (res) {
            cleanup();
            resolve(res);
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      const onCompleted = (record) => {
        if (record.mismatch) {
          cleanup();
          return reject(record.error);
        }
        existingCompletion = record;
        try {
          const res = checkReady(existingEvidence, existingCompletion);
          if (res) {
            cleanup();
            resolve(res);
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      this._emitter.on('review_evidence_' + turnId, onEvidence);
      this._emitter.on('turn_completed_' + turnId, onCompleted);

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
    this._emitter.removeAllListeners();
    await this._client.close();
  }
}

module.exports = {
  CodexAuditorAdapter,
  ALLOWED_REVIEW_TARGET_TYPES,
  THREAD_SANDBOX_MODES,
  MAX_INPUT_TEXT_BYTES,
  MAX_OUTPUT_SCHEMA_BYTES,
  deepDetach
};

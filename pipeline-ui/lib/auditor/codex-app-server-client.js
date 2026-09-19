'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * Transport States (Section 14)
 */
const CLIENT_STATES = Object.freeze({
  NEW: 'NEW',
  SPAWNING: 'SPAWNING',
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
  FAILED: 'FAILED'
});

/**
 * Known side-effecting methods that require uncertainty semantics on timeout/unexpected-exit.
 */
const SIDE_EFFECTING_METHODS = new Set([
  'thread/start',
  'turn/start',
  'review/start',
  'turn/interrupt'
]);

/**
 * Platform environment variables preserved for child process.
 */
const PLATFORM_ENV_VARS = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'CODEX_HOME'
];

/**
 * Helper to create typed errors.
 */
function createError(code, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

class CodexAppServerClient extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.codexBinary='codex']
   * @param {string[]} [options.args]
   * @param {Function} [options.spawn]
   * @param {string} [options.cwd]
   * @param {Object} [options.env]
   * @param {number} [options.maxLineSizeBytes=8388608] 8 MiB default
   * @param {number} [options.maxStderrBytes=65536] 64 KiB default
   * @param {Object} [options.timeouts]
   * @param {Object} [options.clientInfo]
   * @param {Function} [options.onServerRequest]
   */
  constructor(options = {}) {
    super();
    this._options = options;
    this._binary = options.codexBinary || 'codex';
    this._args = Array.isArray(options.args)
      ? [...options.args]
      : ['app-server', '--listen', 'stdio://'];
    this._spawnFn = options.spawn || spawn;
    this._cwd = options.cwd || undefined;
    this._customEnv = options.env || null;

    this._maxLineSizeBytes = options.maxLineSizeBytes || (8 * 1024 * 1024);
    this._maxStderrBytes = options.maxStderrBytes || (64 * 1024);

    this._defaultTimeouts = {
      initialize: 15000,
      read: 15000,
      interrupt: 15000,
      default: 30000,
      ...(options.timeouts || {})
    };

    this._clientInfo = options.clientInfo || {
      name: 'chatgpt_orchestrator',
      title: 'ChatGPT Orchestrator Native Codex Relay',
      version: '4'
    };

    this._onServerRequest = typeof options.onServerRequest === 'function'
      ? options.onServerRequest
      : null;

    this._state = CLIENT_STATES.NEW;
    this._child = null;
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._nextRequestId = 0;
    this._pendingRequests = new Map();
    this._completedRequestIds = new Set();
    this._exitMeta = null;
    this._initPromise = null;
    this._closePromise = null;
  }

  /**
   * Current transport state.
   * @returns {string}
   */
  getState() {
    return this._state;
  }

  /**
   * Bounded diagnostic tail from stderr.
   * @returns {string}
   */
  getStderrTail() {
    return this._stderrBuffer;
  }

  /**
   * Exit metadata if child process exited.
   * @returns {Object|null}
   */
  getExitMeta() {
    return this._exitMeta ? { ...this._exitMeta } : null;
  }

  /**
   * Set custom server request handler boundary.
   * @param {Function|null} handler
   */
  setServerRequestHandler(handler) {
    this._onServerRequest = typeof handler === 'function' ? handler : null;
  }

  /**
   * Perform initialize handshake.
   * Idempotent: calling initialize() twice returns existing result if already READY.
   * @returns {Promise<Object>}
   */
  async initialize() {
    if (this._state === CLIENT_STATES.READY) {
      return this._initResult || { ready: true };
    }
    if (this._initPromise) {
      return this._initPromise;
    }
    if (this._state !== CLIENT_STATES.NEW) {
      throw createError(
        'CODEX_APP_SERVER_INVALID_STATE',
        `Cannot initialize client in state ${this._state}`
      );
    }

    this._initPromise = this._executeInitialize();
    return this._initPromise;
  }

  async _executeInitialize() {
    this._state = CLIENT_STATES.SPAWNING;

    try {
      this._spawnChild();
    } catch (err) {
      this._state = CLIENT_STATES.FAILED;
      const spawnErr = createError(
        'CODEX_APP_SERVER_SPAWN_FAILED',
        `Failed to spawn Codex app-server: ${err.message}`,
        { originalError: err }
      );
      this._initPromise = null;
      throw spawnErr;
    }

    this._state = CLIENT_STATES.INITIALIZING;

    try {
      // Step 1: send initialize request
      const initResult = await this.sendRequest(
        'initialize',
        { clientInfo: this._clientInfo },
        { timeoutMs: this._defaultTimeouts.initialize, isSideEffecting: false }
      );

      // Step 2: send initialized notification (with params: {})
      await this._sendNotification('initialized', {});

      // Step 3: transition to READY
      this._state = CLIENT_STATES.READY;
      this._initResult = initResult;
      return initResult;
    } catch (err) {
      this._state = CLIENT_STATES.FAILED;
      this._terminateChild();
      throw err;
    } finally {
      this._initPromise = null;
    }
  }

  /**
   * Construct safe bounded environment.
   * @private
   */
  _constructEnv(customEnv) {
    const cleanEnv = {};
    const sourceEnv = customEnv || process.env;

    for (const key of PLATFORM_ENV_VARS) {
      if (sourceEnv[key] !== undefined) {
        cleanEnv[key] = sourceEnv[key];
      }
    }

    for (const [key, value] of Object.entries(sourceEnv)) {
      if (key.startsWith('CODEX_') || key.startsWith('OPENAI_')) {
        cleanEnv[key] = value;
      }
    }

    return cleanEnv;
  }

  /**
   * Spawn child process.
   * @private
   */
  _spawnChild() {
    const env = this._constructEnv(this._customEnv);

    this._child = this._spawnFn(this._binary, this._args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this._cwd,
      env
    });

    if (!this._child || !this._child.stdin || !this._child.stdout || !this._child.stderr) {
      throw new Error('Child process spawned without standard stdio streams');
    }

    this._child.on('error', (err) => this._onChildError(err));
    this._child.on('exit', (code, signal) => this._onChildExit(code, signal));

    this._child.stdout.setEncoding('utf8');
    this._child.stdout.on('data', (chunk) => this._onStdoutData(chunk));
    this._child.stdout.on('error', (err) => this._onStreamError('stdout', err));

    this._child.stderr.setEncoding('utf8');
    this._child.stderr.on('data', (chunk) => this._onStderrData(chunk));
    this._child.stderr.on('error', (err) => this._onStreamError('stderr', err));

    this._child.stdin.on('error', (err) => this._onStdinError(err));
  }

  /**
   * Send a JSON-RPC request to Codex app-server.
   * @param {string} method
   * @param {Object} [params]
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.isSideEffecting]
   * @returns {Promise<any>}
   */
  sendRequest(method, params = {}, options = {}) {
    if (this._state === CLIENT_STATES.CLOSING || this._state === CLIENT_STATES.CLOSED) {
      return Promise.reject(
        createError(
          'CODEX_APP_SERVER_CLOSED',
          `Cannot send request '${method}': transport is ${this._state}`
        )
      );
    }

    if (this._state !== CLIENT_STATES.READY && !(this._state === CLIENT_STATES.INITIALIZING && method === 'initialize')) {
      return Promise.reject(
        createError(
          'CODEX_APP_SERVER_NOT_READY',
          `Cannot send request '${method}' while client is in state ${this._state}`
        )
      );
    }

    const id = `cas_req_${++this._nextRequestId}`;
    const isSideEffecting = options.isSideEffecting !== undefined
      ? Boolean(options.isSideEffecting)
      : SIDE_EFFECTING_METHODS.has(method);

    const timeoutMs = options.timeoutMs || this._defaultTimeouts[method] || this._defaultTimeouts.default;

    return new Promise((resolve, reject) => {
      const pending = {
        id,
        method,
        isSideEffecting,
        sent: false,
        timer: null,
        resolve,
        reject
      };

      if (timeoutMs > 0 && timeoutMs !== Infinity) {
        pending.timer = setTimeout(() => {
          this._onRequestTimeout(id);
        }, timeoutMs);
      }

      this._pendingRequests.set(id, pending);

      const message = {
        id,
        method,
        params
      };

      let line;
      try {
        line = JSON.stringify(message) + '\n';
      } catch (err) {
        this._pendingRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        return reject(
          createError(
            'CODEX_APP_SERVER_SERIALIZE_ERROR',
            `Failed to serialize request '${method}': ${err.message}`,
            { originalError: err }
          )
        );
      }

      if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
        this._pendingRequests.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        return reject(
          createError(
            'CODEX_APP_SERVER_STDIN_ERROR',
            `Cannot write request '${method}': stdin is unavailable or destroyed`
          )
        );
      }

      this._child.stdin.write(line, 'utf8', (err) => {
        if (err) {
          this._pendingRequests.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          return reject(
            createError(
              'CODEX_APP_SERVER_WRITE_FAILED',
              `Failed to write request '${method}' to stdin: ${err.message}`,
              { notSent: true, originalError: err }
            )
          );
        }
        pending.sent = true;
      });
    });
  }

  /**
   * Send an authoritative notification message (no ID).
   * Awaitable to guarantee bytes are successfully written.
   * @param {string} method
   * @param {Object} [params={}]
   * @returns {Promise<void>}
   * @private
   */
  _sendNotification(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
        return reject(
          createError(
            'CODEX_APP_SERVER_STDIN_ERROR',
            `Cannot send notification '${method}': stdin is unavailable or destroyed`
          )
        );
      }
      const message = { method, params: params !== undefined ? params : {} };
      let line;
      try {
        line = JSON.stringify(message) + '\n';
      } catch (err) {
        return reject(
          createError(
            'CODEX_APP_SERVER_SERIALIZE_ERROR',
            `Failed to serialize notification '${method}': ${err.message}`,
            { originalError: err }
          )
        );
      }
      this._child.stdin.write(line, 'utf8', (err) => {
        if (err) {
          return reject(
            createError(
              'CODEX_APP_SERVER_WRITE_FAILED',
              `Failed to write notification '${method}' to stdin: ${err.message}`,
              { originalError: err }
            )
          );
        }
        resolve();
      });
    });
  }

  /**
   * Send response to a server-initiated request.
   * @private
   */
  _sendServerResponse(id, result, error) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) {
      return;
    }
    const message = { id };
    if (error !== undefined) {
      message.error = error;
    } else {
      message.result = result !== undefined ? result : {};
    }
    try {
      this._child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
    } catch {
      // ignore write error
    }
  }

  /**
   * Handle stdout data chunk with JSONL framing and bounds check.
   * @private
   */
  _onStdoutData(chunk) {
    this._stdoutBuffer += chunk;

    let newlineIndex;
    while ((newlineIndex = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIndex);
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);

      const trimmedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmedLine.trim().length === 0) {
        continue;
      }

      if (Buffer.byteLength(trimmedLine, 'utf8') > this._maxLineSizeBytes) {
        const limitErr = createError(
          'CODEX_APP_SERVER_PROTOCOL_LIMIT',
          `Message line exceeded maximum allowed bound (${this._maxLineSizeBytes} bytes)`
        );
        this._failConnection(limitErr);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmedLine);
      } catch (err) {
        const protoErr = createError(
          'CODEX_APP_SERVER_PROTOCOL_ERROR',
          `Malformed JSON line from Codex app-server: ${err.message}`,
          { line: trimmedLine.slice(0, 256), originalError: err }
        );
        this._failConnection(protoErr);
        return;
      }

      this._handleMessage(parsed);
    }

    if (Buffer.byteLength(this._stdoutBuffer, 'utf8') > this._maxLineSizeBytes) {
      const limitErr = createError(
        'CODEX_APP_SERVER_PROTOCOL_LIMIT',
        `Unterminated message line exceeded maximum allowed bound (${this._maxLineSizeBytes} bytes)`
      );
      this._failConnection(limitErr);
    }
  }

  /**
   * Dispatch parsed JSON message.
   * @private
   */
  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      const protoErr = createError(
        'CODEX_APP_SERVER_PROTOCOL_ERROR',
        'Protocol message must be a JSON object'
      );
      this._failConnection(protoErr);
      return;
    }

    // Case 1: Server-initiated Request (has BOTH id and method)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this._handleServerRequest(msg);
      return;
    }

    // Case 2: Response to Client Request (has id, no method)
    if (msg.id !== undefined && msg.method === undefined) {
      this._handleClientResponse(msg);
      return;
    }

    // Case 3: Notification (has method, no id)
    if (msg.method !== undefined && msg.id === undefined) {
      this._handleNotification(msg);
      return;
    }

    // Unrecognized message shape
    const protoErr = createError(
      'CODEX_APP_SERVER_PROTOCOL_ERROR',
      'Unrecognized message format: message must contain method or matching id'
    );
    this._failConnection(protoErr);
  }

  /**
   * Handle server-initiated request with fail-closed safety.
   * @private
   */
  async _handleServerRequest(msg) {
    this.emit('serverRequest', msg);

    if (this._onServerRequest) {
      try {
        const result = await this._onServerRequest(msg);
        this._sendServerResponse(msg.id, result, undefined);
      } catch (err) {
        this._sendServerResponse(msg.id, undefined, {
          code: -32000,
          message: err.message || 'Server request handler rejected',
          data: { details: err.details || null }
        });
      }
      return;
    }

    // Known command or file approval methods: respond with decline (Section 29)
    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'item/command/requestApproval' ||
      msg.method === 'item/fileChange/requestApproval'
    ) {
      this._sendServerResponse(msg.id, { decision: 'decline' }, undefined);
      return;
    }

    // Default: Fail closed immediately. Never auto-approve. Do not log full approval payloads.
    this._sendServerResponse(msg.id, undefined, {
      code: -32000,
      message: 'SERVER_REQUEST_REJECTED_FAIL_CLOSED',
      data: {
        reason: 'NO_OPERATOR_APPROVAL_UI',
        method: msg.method
      }
    });
  }

  /**
   * Correlate client response.
   * @private
   */
  _handleClientResponse(msg) {
    const id = msg.id;

    if (this._completedRequestIds.has(id)) {
      const duplicateErr = createError(
        'CODEX_APP_SERVER_PROTOCOL_ERROR',
        `Duplicate response received for already completed request ID '${id}'`
      );
      this._failConnection(duplicateErr);
      return;
    }

    const pending = this._pendingRequests.get(id);
    if (!pending) {
      const unknownErr = createError(
        'CODEX_APP_SERVER_PROTOCOL_ERROR',
        `Response received with unknown request ID '${id}'`
      );
      this._failConnection(unknownErr);
      return;
    }

    // Validate response shape: exactly one of result or error (Section 27)
    const hasResult = msg.result !== undefined;
    const hasError = msg.error !== undefined;
    if ((hasResult && hasError) || (!hasResult && !hasError)) {
      const protoErr = createError(
        'CODEX_APP_SERVER_PROTOCOL_ERROR',
        `Response for request ID '${id}' must contain exactly one of 'result' or 'error', not both or neither`
      );
      this._failConnection(protoErr);
      return;
    }

    this._pendingRequests.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this._recordCompletedId(id);

    if (msg.error) {
      const providerErr = createError(
        'CODEX_APP_SERVER_PROVIDER_ERROR',
        msg.error.message || `Codex app-server returned error for ${pending.method}`,
        {
          providerError: msg.error,
          method: pending.method,
          id
        }
      );
      pending.reject(providerErr);
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Handle server notifications.
   * @private
   */
  _handleNotification(msg) {
    this.emit('notification', msg.method, msg.params);
    this.emit(msg.method, msg.params);
  }

  /**
   * Handle request timeout.
   * @private
   */
  _onRequestTimeout(id) {
    const pending = this._pendingRequests.get(id);
    if (!pending) return;

    this._pendingRequests.delete(id);
    this._recordCompletedId(id);

    let err;
    if (pending.isSideEffecting && pending.sent) {
      err = createError(
        'CODEX_APP_SERVER_REQUEST_UNCERTAIN',
        `Request '${pending.method}' timed out after write; outcome is uncertain`,
        { id, method: pending.method }
      );
    } else {
      err = createError(
        'CODEX_APP_SERVER_TIMEOUT',
        `Request '${pending.method}' timed out waiting for response`,
        { id, method: pending.method }
      );
    }

    pending.reject(err);
  }

  /**
   * Handle stderr data with bounded tail.
   * @private
   */
  _onStderrData(chunk) {
    this._stderrBuffer += chunk;
    if (Buffer.byteLength(this._stderrBuffer, 'utf8') > this._maxStderrBytes) {
      // Retain last maxStderrBytes
      const buf = Buffer.from(this._stderrBuffer, 'utf8');
      this._stderrBuffer = buf.slice(buf.length - this._maxStderrBytes).toString('utf8');
    }
  }

  /**
   * Handle child process error.
   * @private
   */
  _onChildError(err) {
    if (
      this._state === CLIENT_STATES.NEW ||
      this._state === CLIENT_STATES.SPAWNING ||
      this._state === CLIENT_STATES.INITIALIZING
    ) {
      this._state = CLIENT_STATES.FAILED;
      const spawnErr = createError(
        'CODEX_APP_SERVER_SPAWN_FAILED',
        `Codex app-server child error during spawn/init: ${err.message}`,
        { originalError: err }
      );
      this._failConnection(spawnErr);
      return;
    }
    this._failConnection(
      createError(
        'CODEX_APP_SERVER_PROCESS_ERROR',
        `Codex app-server child error: ${err.message}`,
        { originalError: err }
      )
    );
  }

  /**
   * Handle child process exit.
   * @private
   */
  _onChildExit(code, signal) {
    this._exitMeta = {
      code,
      signal,
      stderrTail: this.getStderrTail()
    };

    if (this._state === CLIENT_STATES.CLOSING || this._state === CLIENT_STATES.CLOSED) {
      this._state = CLIENT_STATES.CLOSED;
      return;
    }

    const exitErr = createError(
      'CODEX_APP_SERVER_PROCESS_EXITED',
      `Codex app-server exited unexpectedly with code ${code}, signal ${signal}`,
      this._exitMeta
    );
    this._failConnection(exitErr);
  }

  /**
   * Handle stream error.
   * @private
   */
  _onStreamError(streamName, err) {
    if (this._state === CLIENT_STATES.CLOSING || this._state === CLIENT_STATES.CLOSED) {
      return;
    }
    this._failConnection(
      createError(
        'CODEX_APP_SERVER_STREAM_ERROR',
        `Stream error on ${streamName}: ${err.message}`,
        { originalError: err }
      )
    );
  }

  /**
   * Handle stdin error.
   * @private
   */
  _onStdinError(err) {
    if (this._state === CLIENT_STATES.CLOSING || this._state === CLIENT_STATES.CLOSED) {
      return;
    }
    this._failConnection(
      createError(
        'CODEX_APP_SERVER_STDIN_ERROR',
        `Stdin error: ${err.message}`,
        { originalError: err }
      )
    );
  }

  /**
   * Fail connection and reject all pending requests.
   * @private
   */
  _failConnection(err) {
    this._state = CLIENT_STATES.FAILED;

    for (const [id, pending] of this._pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this._recordCompletedId(id);

      if (pending.isSideEffecting && pending.sent) {
        pending.reject(
          createError(
            'CODEX_APP_SERVER_REQUEST_UNCERTAIN',
            `Transport failed while side-effecting request '${pending.method}' was sent; outcome is uncertain`,
            { originalError: err, id, method: pending.method }
          )
        );
      } else {
        pending.reject(err);
      }
    }
    this._pendingRequests.clear();

    this._terminateChild();

    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Terminate exact child process reference.
   * Never use taskkill or pkill by process name.
   * @private
   */
  _terminateChild() {
    if (!this._child) return;
    try {
      if (!this._child.killed) {
        this._child.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }

  /**
   * Record completed request ID in bounded set.
   * @private
   */
  _recordCompletedId(id) {
    if (this._completedRequestIds.size > 10000) {
      const firstKey = this._completedRequestIds.values().next().value;
      this._completedRequestIds.delete(firstKey);
    }
    this._completedRequestIds.add(id);
  }

  /**
   * Close client cleanly and idempotently.
   * @param {number} [gracefulTimeoutMs=500]
   * @returns {Promise<void>}
   */
  async close(gracefulTimeoutMs = 500) {
    if (this._state === CLIENT_STATES.CLOSED) {
      return;
    }
    if (this._closePromise) {
      return this._closePromise;
    }

    this._state = CLIENT_STATES.CLOSING;

    this._closePromise = (async () => {
      // Reject pending requests: sent side-effecting requests are UNCERTAIN (Sections 34, 35)
      for (const [id, pending] of this._pendingRequests.entries()) {
        if (pending.timer) clearTimeout(pending.timer);
        this._recordCompletedId(id);
        if (pending.isSideEffecting && pending.sent) {
          pending.reject(
            createError(
              'CODEX_APP_SERVER_REQUEST_UNCERTAIN',
              `Client closed while side-effecting request '${pending.method}' was sent; outcome is uncertain`,
              { id, method: pending.method }
            )
          );
        } else {
          pending.reject(
            createError(
              'CODEX_APP_SERVER_CLOSED',
              `Client closed before response arrived for '${pending.method}'`
            )
          );
        }
      }
      this._pendingRequests.clear();

      if (this._child) {
        // End stdin
        try {
          if (this._child.stdin && !this._child.stdin.destroyed) {
            this._child.stdin.end();
          }
        } catch {
          // ignore
        }

        // Wait short graceful exit
        await new Promise((resolve) => {
          let timer = null;
          const onExit = () => {
            if (timer) clearTimeout(timer);
            resolve();
          };

          if (this._child.exitCode !== null) {
            return resolve();
          }

          this._child.once('exit', onExit);

          timer = setTimeout(() => {
            this._child.removeListener('exit', onExit);
            this._terminateChild();
            // Give SIGTERM a moment, else SIGKILL
            setTimeout(() => {
              try {
                if (!this._child.killed && this._child.exitCode === null) {
                  this._child.kill('SIGKILL');
                }
              } catch {
                // ignore
              }
              resolve();
            }, 100);
          }, gracefulTimeoutMs);
        });
      }

      this._state = CLIENT_STATES.CLOSED;
      this.removeAllListeners();
    })();

    return this._closePromise;
  }
}

module.exports = {
  CodexAppServerClient,
  CLIENT_STATES,
  SIDE_EFFECTING_METHODS,
  PLATFORM_ENV_VARS,
  createError
};

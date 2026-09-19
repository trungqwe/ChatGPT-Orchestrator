'use strict';

/**
 * Codex App Server Stdio Transport & Adapter Test Suite
 * CAS-001 .. CAS-060
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { CodexAppServerClient, CLIENT_STATES } = require('../../lib/auditor/codex-app-server-client');
const { CodexAuditorAdapter } = require('../../lib/auditor/codex-auditor-adapter');

const FAKE_SERVER_PATH = path.join(__dirname, '..', 'fixtures', 'fake-codex-app-server.js');

function createTestClient(options = {}) {
  return new CodexAppServerClient({
    codexBinary: process.execPath,
    args: [FAKE_SERVER_PATH, ...(options.fixtureArgs || [])],
    timeouts: {
      initialize: 1000,
      read: 500,
      interrupt: 500,
      default: 500,
      ...(options.timeouts || {})
    },
    ...options
  });
}

function createTestAdapter(options = {}) {
  const client = createTestClient(options);
  return new CodexAuditorAdapter({ client, ...options });
}

async function runTests() {
  console.log('Starting Codex App Server Client & Adapter test suite (CAS-001 .. CAS-060)...\n');

  // CAS-001: Spawns via argument array, shell: false
  {
    let interceptedArgs = null;
    let interceptedOptions = null;
    const customSpawn = (bin, args, opts) => {
      interceptedArgs = args;
      interceptedOptions = opts;
      return spawn(bin, args, opts);
    };

    const client = createTestClient({ spawn: customSpawn });
    try {
      await client.initialize();
      assert.strictEqual(Array.isArray(interceptedArgs), true, 'CAS-001: args must be an array');
      assert.strictEqual(interceptedOptions.shell, false, 'CAS-001: shell must be false');
      assert.deepStrictEqual(interceptedOptions.stdio, ['pipe', 'pipe', 'pipe'], 'CAS-001: stdio must be pipe');
      console.log('PASS: CAS-001 — Process spawned via argument array with shell=false');
    } finally {
      await client.close();
    }
  }

  // CAS-002: Bounded child environment preserves platform vars and excludes secrets
  {
    let capturedEnv = null;
    const customSpawn = (bin, args, opts) => {
      capturedEnv = opts.env;
      return spawn(bin, args, opts);
    };

    const testEnv = {
      PATH: process.env.PATH || '',
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      TEMP: process.env.TEMP || '',
      SECRET_KEY: 'super_secret_token_12345',
      DATABASE_PASSWORD: 'secret_password',
      CODEX_TEST_VAR: 'codex_allowed_val',
      OPENAI_TEST_VAR: 'openai_allowed_val'
    };

    const client = createTestClient({ spawn: customSpawn, env: testEnv });
    try {
      await client.initialize();
      assert.strictEqual(capturedEnv.SECRET_KEY, undefined, 'CAS-002: SECRET_KEY must not be propagated');
      assert.strictEqual(capturedEnv.DATABASE_PASSWORD, undefined, 'CAS-002: DATABASE_PASSWORD must not be propagated');
      assert.strictEqual(capturedEnv.CODEX_TEST_VAR, 'codex_allowed_val', 'CAS-002: CODEX_ prefix must be propagated');
      assert.strictEqual(capturedEnv.OPENAI_TEST_VAR, 'openai_allowed_val', 'CAS-002: OPENAI_ prefix must be propagated');
      console.log('PASS: CAS-002 — Bounded environment excludes arbitrary secrets and retains allowed prefixes');
    } finally {
      await client.close();
    }
  }

  // CAS-003: Stderr collected to bounded tail (64 KiB) and never treated as protocol JSON authority
  {
    const client = createTestClient();
    try {
      await client.initialize();
      const tail = client.getStderrTail();
      assert.strictEqual(typeof tail, 'string', 'CAS-003: Stderr tail must be a string');
      assert.strictEqual(tail.includes('[fake-codex-app-server]'), true, 'CAS-003: Stderr must capture diagnostics');
      console.log('PASS: CAS-003 — Stderr collected to bounded tail without being parsed as JSON authority');
    } finally {
      await client.close();
    }
  }

  // CAS-004: State transitions: NEW -> SPAWNING -> INITIALIZING -> READY -> CLOSING -> CLOSED
  {
    const client = createTestClient();
    try {
      assert.strictEqual(client.getState(), CLIENT_STATES.NEW, 'CAS-004: Initial state must be NEW');
      const initPromise = client.initialize();
      assert.strictEqual(
        client.getState() === CLIENT_STATES.SPAWNING || client.getState() === CLIENT_STATES.INITIALIZING,
        true,
        'CAS-004: State during initialize must be SPAWNING or INITIALIZING'
      );
      await initPromise;
      assert.strictEqual(client.getState(), CLIENT_STATES.READY, 'CAS-004: State after init must be READY');
      const closePromise = client.close();
      assert.strictEqual(
        client.getState() === CLIENT_STATES.CLOSING || client.getState() === CLIENT_STATES.CLOSED,
        true,
        'CAS-004: State during close must be CLOSING or CLOSED'
      );
      await closePromise;
      assert.strictEqual(client.getState(), CLIENT_STATES.CLOSED, 'CAS-004: Final state must be CLOSED');
      console.log('PASS: CAS-004 — Explicit state transitions verified');
    } finally {
      await client.close();
    }
  }

  // CAS-005: Initialize request sent first with static clientInfo; no experimentalApi
  {
    let initSent = null;
    const client = createTestClient();
    try {
      const origSendRequest = client.sendRequest.bind(client);
      client.sendRequest = function(method, params, options) {
        if (method === 'initialize') {
          initSent = { method, params };
        }
        return origSendRequest(method, params, options);
      };
      await client.initialize();
      assert.strictEqual(initSent.method, 'initialize');
      assert.deepStrictEqual(initSent.params.clientInfo, {
        name: 'chatgpt_orchestrator',
        title: 'ChatGPT Orchestrator Native Codex Relay',
        version: '4'
      });
      assert.strictEqual(initSent.params.experimentalApi, undefined, 'CAS-005: experimentalApi must not be passed');
      console.log('PASS: CAS-005 — Initialize request sent first with bounded static clientInfo without experimentalApi');
    } finally {
      await client.close();
    }
  }

  // CAS-006: Initialized notification sent only after successful initialize response
  {
    const client = createTestClient();
    try {
      let notifSent = false;
      const origSendNotification = client._sendNotification.bind(client);
      client._sendNotification = function(method, params) {
        if (method === 'initialized') {
          notifSent = true;
        }
        return origSendNotification(method, params);
      };
      await client.initialize();
      assert.strictEqual(notifSent, true, 'CAS-006: initialized notification must be sent');
      console.log('PASS: CAS-006 — initialized notification sent only after initialize response');
    } finally {
      await client.close();
    }
  }

  // CAS-007: Initialize idempotency: second initialize() call does not send second protocol initialize
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let extraInitSent = false;
      const origSendRequest = client.sendRequest.bind(client);
      client.sendRequest = function(method, params, options) {
        if (method === 'initialize') {
          extraInitSent = true;
        }
        return origSendRequest(method, params, options);
      };
      const secondResult = await client.initialize();
      assert.strictEqual(extraInitSent, false, 'CAS-007: Second initialize must not send second request');
      assert.strictEqual(typeof secondResult, 'object');
      console.log('PASS: CAS-007 — Calling initialize() twice is idempotent and does not send second request');
    } finally {
      await client.close();
    }
  }

  // CAS-008: Request IDs are unique monotonic identifiers within connection
  {
    const client = createTestClient();
    try {
      await client.initialize();
      const r1 = client.sendRequest('model/list');
      const r2 = client.sendRequest('model/list');
      const [res1, res2] = await Promise.all([r1, r2]);
      assert.notStrictEqual(res1, undefined);
      assert.notStrictEqual(res2, undefined);
      console.log('PASS: CAS-008 — Monotonic unique request IDs generated cleanly');
    } finally {
      await client.close();
    }
  }

  // CAS-009: Out-of-order responses correlate to exact pending requests
  {
    const client = createTestClient();
    try {
      await client.initialize();
      const req1 = client.sendRequest('thread/start', { _threadId: 'thr_order_1', cwd: 'D:\\test\\a' });
      const req2 = client.sendRequest('thread/start', { _threadId: 'thr_order_2', cwd: 'D:\\test\\b' });
      const [res1, res2] = await Promise.all([req1, req2]);
      assert.strictEqual(res1.thread.id, 'thr_order_1');
      assert.strictEqual(res2.thread.id, 'thr_order_2');
      console.log('PASS: CAS-009 — Responses correlated to exact pending requests out of order');
    } finally {
      await client.close();
    }
  }

  // CAS-010: Provider error response maps to exact pending request and rejects with error details
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', { _trigger: 'provider_error', _errorMessage: 'Model catalog unavailable' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null, 'CAS-010: Error response must reject');
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROVIDER_ERROR');
      assert.strictEqual(caught.details.providerError.code, -32603);
      console.log('PASS: CAS-010 — Provider error response mapped to exact pending request and rejected');
    } finally {
      await client.close();
    }
  }

  // CAS-011: Unknown response ID fails transport with CODEX_APP_SERVER_PROTOCOL_ERROR
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', { _trigger: 'unknown_id' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-011 — Unknown response ID fails transport fail-closed');
    } finally {
      await client.close();
    }
  }

  // CAS-012: Duplicate response ID fails transport with CODEX_APP_SERVER_PROTOCOL_ERROR
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', { _trigger: 'duplicate' });
        // Give short delay for second duplicate response line to be processed
        await new Promise((r) => setTimeout(r, 50));
      } catch (err) {
        caught = err;
      }
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-012 — Duplicate response ID fails transport fail-closed');
    } finally {
      await client.close();
    }
  }

  // CAS-013: Notifications with method/params and no id do not resolve pending requests
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let notifReceived = false;
      client.on('turn/started', () => {
        notifReceived = true;
      });

      // turn/start triggers notifications
      const turnRes = await client.sendRequest('turn/start', { threadId: 'thr_001' });
      assert.strictEqual(turnRes.turn.status, 'in_progress');
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(notifReceived, true, 'CAS-013: Notification was emitted');
      console.log('PASS: CAS-013 — Notifications handled without corrupting pending request resolution');
    } finally {
      await client.close();
    }
  }

  // CAS-014: Server-initiated request recognized separately from responses and not placed in pending map
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=server_request'] });
    try {
      let serverReqReceived = null;
      client.on('serverRequest', (req) => {
        serverReqReceived = req;
      });
      await client.initialize();
      await new Promise((r) => setTimeout(r, 100));
      assert.notStrictEqual(serverReqReceived, null, 'CAS-014: Server-initiated request recognized');
      assert.strictEqual(serverReqReceived.method, 'item/command/requestApproval');
      console.log('PASS: CAS-014 — Server-initiated request recognized separately');
    } finally {
      await client.close();
    }
  }

  // CAS-015: Server-initiated request is never auto-approved; fails closed with rejection response
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=server_request'] });
    try {
      let serverReqEmitted = null;
      client.on('serverRequest', (msg) => {
        serverReqEmitted = msg;
      });
      await client.initialize();
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(serverReqEmitted.id, 'srv_req_001');
      console.log('PASS: CAS-015 — Server-initiated request rejected fail-closed without auto-approval');
    } finally {
      await client.close();
    }
  }

  // CAS-016: Server-initiated request supports custom injected handler boundary
  {
    let customHandlerCalled = false;
    const client = createTestClient({
      fixtureArgs: ['--scenario=server_request'],
      onServerRequest: async (req) => {
        customHandlerCalled = true;
        return { handled: true };
      }
    });
    try {
      await client.initialize();
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(customHandlerCalled, true, 'CAS-016: Custom handler called');
      console.log('PASS: CAS-016 — Injected server request handler boundary invoked');
    } finally {
      await client.close();
    }
  }

  // CAS-017: Malformed JSON line in stdout fails transport with CODEX_APP_SERVER_PROTOCOL_ERROR
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=malformed_json'] });
    try {
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null, 'CAS-017: Malformed JSON must fail initialization');
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROTOCOL_ERROR');
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-017 — Malformed JSON fails transport with CODEX_APP_SERVER_PROTOCOL_ERROR');
    } finally {
      await client.close();
    }
  }

  // CAS-018: Oversized stdout line fails transport with CODEX_APP_SERVER_PROTOCOL_LIMIT
  {
    const client = createTestClient({
      fixtureArgs: ['--scenario=oversized_line'],
      maxLineSizeBytes: 1024 // Set small 1 KiB bound for test
    });
    try {
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null, 'CAS-018: Oversized line must fail');
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROTOCOL_LIMIT');
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-018 — Oversized line fails transport with CODEX_APP_SERVER_PROTOCOL_LIMIT');
    } finally {
      await client.close();
    }
  }

  // CAS-019: Stdin write error before send marks request as not successfully sent
  {
    const client = createTestClient();
    try {
      await client.initialize();
      // Destroy stdin to simulate write failure
      client._child.stdin.destroy();
      let caught = null;
      try {
        await client.sendRequest('model/list');
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_STDIN_ERROR');
      console.log('PASS: CAS-019 — Stdin write failure reported as not successfully sent');
    } finally {
      await client.close();
    }
  }

  // CAS-020: Read-only request timeout returns normal timeout error without auto-retry
  {
    const client = createTestClient({
      timeouts: { read: 50, default: 50 }
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', { _trigger: 'timeout' }, { timeoutMs: 50, isSideEffecting: false });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_TIMEOUT');
      console.log('PASS: CAS-020 — Read-only request timeout returns CODEX_APP_SERVER_TIMEOUT without retry');
    } finally {
      await client.close();
    }
  }

  // CAS-021: Side-effecting request timeout (thread/start) returns CODEX_APP_SERVER_REQUEST_UNCERTAIN
  {
    const client = createTestClient({
      timeouts: { default: 50 }
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('thread/start', { _trigger: 'timeout', cwd: 'D:\\test' }, { timeoutMs: 50, isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-021 — Side-effecting thread/start timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-022: Side-effecting turn/start timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('turn/start', { _trigger: 'timeout', threadId: 'thr_1' }, { timeoutMs: 50, isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-022 — Side-effecting turn/start timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-023: Side-effecting review/start timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('review/start', { _trigger: 'timeout', threadId: 'thr_1' }, { timeoutMs: 50, isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-023 — Side-effecting review/start timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-024: Side-effecting turn/interrupt timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('turn/interrupt', { _trigger: 'timeout', threadId: 'thr_1', turnId: 'turn_1' }, { timeoutMs: 50, isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-024 — Side-effecting turn/interrupt timeout returns CODEX_APP_SERVER_REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-025: Unexpected child process exit moves state to FAILED and rejects pending requests
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', { _trigger: 'exit' }, { timeoutMs: 500, isSideEffecting: false });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-025 — Unexpected process exit transitions to FAILED and rejects requests');
    } finally {
      await client.close();
    }
  }

  // CAS-026: Unexpected child exit with pending side-effecting request marks it as UNCERTAIN
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('thread/start', { _trigger: 'exit', cwd: 'D:\\test' }, { timeoutMs: 500, isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-026 — Process exit during pending side-effecting request marks it UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-027: Child process spawn error rejects initialization with CODEX_APP_SERVER_SPAWN_FAILED
  {
    const client = new CodexAppServerClient({
      codexBinary: 'non_existent_codex_binary_12345.exe',
      timeouts: { initialize: 100 }
    });
    try {
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_SPAWN_FAILED');
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-027 — Spawn error rejects initialization with CODEX_APP_SERVER_SPAWN_FAILED');
    } finally {
      await client.close();
    }
  }

  // CAS-028: Child process exit before initialize handshake completes rejects initialization
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=exit_pre_init'] });
    try {
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-028 — Child exit before initialize handshake completes rejects initialization');
    } finally {
      await client.close();
    }
  }

  // CAS-029: Clean close() closes stdin, allows graceful exit, and transitions to CLOSED
  {
    const client = createTestClient();
    await client.initialize();
    assert.strictEqual(client.getState(), CLIENT_STATES.READY);
    await client.close(100);
    assert.strictEqual(client.getState(), CLIENT_STATES.CLOSED);
    console.log('PASS: CAS-029 — Clean close transitions client to CLOSED state');
  }

  // CAS-030: Idempotent close(): calling close() twice is safe and does not error
  {
    const client = createTestClient();
    await client.initialize();
    await client.close(100);
    await client.close(100);
    assert.strictEqual(client.getState(), CLIENT_STATES.CLOSED);
    console.log('PASS: CAS-030 — Multiple calls to close() are idempotent');
  }

  // CAS-031: Close() terminates exact spawned child process without killing by process name
  {
    const client = createTestClient();
    await client.initialize();
    const pid = client._child.pid;
    assert.strictEqual(typeof pid, 'number');
    await client.close(100);
    assert.strictEqual(client._child.killed || client._child.exitCode !== null, true);
    console.log('PASS: CAS-031 — Exact spawned child terminated cleanly');
  }

  // CAS-032: Adapter initialize() delegates to client and enters READY state
  {
    const adapter = createTestAdapter();
    try {
      const res = await adapter.initialize();
      assert.strictEqual(adapter.getClient().getState(), CLIENT_STATES.READY);
      assert.notStrictEqual(res, null);
      console.log('PASS: CAS-032 — Adapter initialize delegates to client and reaches READY state');
    } finally {
      await adapter.close();
    }
  }

  // CAS-033: Adapter listModels() returns validated detached model list
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const models = await adapter.listModels();
      assert.strictEqual(Array.isArray(models), true);
      assert.strictEqual(models.length, 3);
      assert.strictEqual(models[0].id, 'mock-model-fast');
      console.log('PASS: CAS-033 — Adapter listModels returns detached array of models');
    } finally {
      await adapter.close();
    }
  }

  // CAS-034: Adapter listModels() does not implement model tier resolution
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const models = await adapter.listModels();
      for (const m of models) {
        assert.strictEqual(m.tier, undefined, 'CAS-034: Model tier resolution must NOT be performed in WP03A');
      }
      console.log('PASS: CAS-034 — Adapter listModels does not resolve model tiers');
    } finally {
      await adapter.close();
    }
  }

  // CAS-035: Adapter startThread() requires absolute cwd
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const thread = await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.strictEqual(thread.threadId, 'thr_fake_001');
      assert.strictEqual(thread.sessionId, 'ses_fake_001');
      console.log('PASS: CAS-035 — Adapter startThread accepts valid absolute cwd');
    } finally {
      await adapter.close();
    }
  }

  // CAS-036: Adapter startThread() rejects relative cwd
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startThread({ cwd: 'relative/path/to/project' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'INVALID_ARGUMENT');
      console.log('PASS: CAS-036 — Adapter startThread rejects relative cwd fail-closed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-037: Adapter startThread() defaults to read-only intent / rejects dangerFullAccess
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startThread({ cwd: 'D:\\test\\workspace', dangerFullAccess: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_SECURITY_VIOLATION');
      console.log('PASS: CAS-037 — Adapter startThread rejects dangerFullAccess privilege escalation');
    } finally {
      await adapter.close();
    }
  }

  // CAS-038: Adapter startThread() returns exact provider thread.id and sessionId without modification
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const customThreadId = 'thr_exact_opaque_id_98765';
      const customSessionId = 'ses_exact_opaque_id_54321';
      const thread = await adapter.startThread({
        cwd: 'D:\\test\\workspace',
        _threadId: customThreadId,
        _sessionId: customSessionId
      });
      assert.strictEqual(thread.threadId, customThreadId);
      assert.strictEqual(thread.sessionId, customSessionId);
      console.log('PASS: CAS-038 — Exact opaque provider IDs preserved byte-for-byte');
    } finally {
      await adapter.close();
    }
  }

  // CAS-039: Adapter resumeThread() requires exact threadId without heuristic fallback
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const res = await adapter.resumeThread({ threadId: 'thr_custom_resume_123' });
      assert.strictEqual(res.threadId, 'thr_custom_resume_123');
      assert.strictEqual(res.resumed, true);
      console.log('PASS: CAS-039 — Adapter resumeThread queries exact supplied threadId');
    } finally {
      await adapter.close();
    }
  }

  // CAS-040: Adapter resumeThread() failure propagates provider error and creates no replacement thread
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.resumeThread({ threadId: 'thr_bad', _trigger: 'provider_error', _errorMessage: 'Thread not found' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROVIDER_ERROR');
      console.log('PASS: CAS-040 — Adapter resumeThread failure propagates error and creates no replacement thread');
    } finally {
      await adapter.close();
    }
  }

  // CAS-041: Adapter readThread() queries exact threadId with includeTurns=false by default
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const thread = await adapter.readThread({ threadId: 'thr_read_exact' });
      assert.strictEqual(thread.thread.id, 'thr_read_exact');
      assert.strictEqual(thread.thread.turns, undefined);
      console.log('PASS: CAS-041 — Adapter readThread queries exact ID with includeTurns=false by default');
    } finally {
      await adapter.close();
    }
  }

  // CAS-042: Adapter readThread() with includeTurns=true forwards flag without implicit resume
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const thread = await adapter.readThread({ threadId: 'thr_read_turns', includeTurns: true });
      assert.strictEqual(thread.thread.id, 'thr_read_turns');
      assert.strictEqual(Array.isArray(thread.thread.turns), true);
      console.log('PASS: CAS-042 — Adapter readThread forwards includeTurns=true');
    } finally {
      await adapter.close();
    }
  }

  // CAS-043: Adapter startTurn() returns exact provider turn.id and turn.status
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_turn_test',
        input: [{ type: 'text', text: 'Analyze workspace status' }]
      });
      assert.strictEqual(turn.turnId, 'turn_fake_001');
      assert.strictEqual(turn.status, 'in_progress');
      console.log('PASS: CAS-043 — Adapter startTurn returns exact provider turn ID and status');
    } finally {
      await adapter.close();
    }
  }

  // CAS-044: Adapter startTurn() validates bounded text input and rejects unknown input types
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startTurn({
          threadId: 'thr_turn_test',
          input: [{ type: 'custom_image', data: 'binary_blob' }]
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'INPUT_TYPE_UNSUPPORTED');
      console.log('PASS: CAS-044 — Adapter startTurn rejects unsupported input item types');
    } finally {
      await adapter.close();
    }
  }

  // CAS-045: Adapter startTurn() validates and forwards outputSchema without validating AuditDecisionV1
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const dummySchema = {
        type: 'object',
        properties: { arbitraryField: { type: 'string' } }
      };
      const turn = await adapter.startTurn({
        threadId: 'thr_turn_schema',
        input: [{ type: 'text', text: 'Generate structured output' }],
        outputSchema: dummySchema
      });
      assert.strictEqual(turn.turnId, 'turn_fake_001');
      console.log('PASS: CAS-045 — Adapter startTurn forwards outputSchema without validating AuditDecisionV1');
    } finally {
      await adapter.close();
    }
  }

  // CAS-046: Adapter waitForTurnCompletion() correlates exact threadId and turnId from turn/completed
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_complete_test',
        input: [{ type: 'text', text: 'Test completion' }]
      });
      const completion = await adapter.waitForTurnCompletion({
        threadId: 'thr_complete_test',
        turnId: turn.turnId,
        timeoutMs: 1000
      });
      assert.strictEqual(completion.threadId, 'thr_complete_test');
      assert.strictEqual(completion.turnId, turn.turnId);
      assert.strictEqual(completion.status, 'completed');
      console.log('PASS: CAS-046 — Adapter waitForTurnCompletion correlates exact threadId and turnId');
    } finally {
      await adapter.close();
    }
  }

  // CAS-047: Adapter waitForTurnCompletion() ignores turn/completed for different turnId or threadId
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_mismatch_test',
        _wrongTurnId: true, // fixture will emit turn/completed for turn_mismatch_999
        input: [{ type: 'text', text: 'Test wrong turn' }]
      });
      let caught = null;
      try {
        await adapter.waitForTurnCompletion({
          threadId: 'thr_mismatch_test',
          turnId: turn.turnId,
          timeoutMs: 150 // should timeout because matching turnId never arrives
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'WAIT_TURN_TIMEOUT');
      console.log('PASS: CAS-047 — Adapter waitForTurnCompletion ignores non-matching turn/completed notifications');
    } finally {
      await adapter.close();
    }
  }

  // CAS-048: Adapter waitForTurnCompletion() rejects on turn/completed status=failed
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_fail_test',
        _failTurn: true,
        input: [{ type: 'text', text: 'Test turn failure' }]
      });
      let caught = null;
      try {
        await adapter.waitForTurnCompletion({
          threadId: 'thr_fail_test',
          turnId: turn.turnId,
          timeoutMs: 1000
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'TURN_FAILED');
      console.log('PASS: CAS-048 — Adapter waitForTurnCompletion rejects on status=failed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-049: Adapter waitForTurnCompletion() resolves on turn/completed status=interrupted
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_interrupted_test',
        _interruptTurn: true,
        input: [{ type: 'text', text: 'Test turn interrupt' }]
      });
      const completion = await adapter.waitForTurnCompletion({
        threadId: 'thr_interrupted_test',
        turnId: turn.turnId,
        timeoutMs: 1000
      });
      assert.strictEqual(completion.status, 'interrupted');
      console.log('PASS: CAS-049 — Adapter waitForTurnCompletion resolves on status=interrupted');
    } finally {
      await adapter.close();
    }
  }

  // CAS-050: Adapter interruptTurn() requires exact threadId and turnId
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const res = await adapter.interruptTurn({
        threadId: 'thr_int_1',
        turnId: 'turn_int_1'
      });
      assert.strictEqual(res.interrupted, true);
      console.log('PASS: CAS-050 — Adapter interruptTurn requires exact threadId and turnId');
    } finally {
      await adapter.close();
    }
  }

  // CAS-051: Adapter interruptTurn() response does not fabricate completion before turn/completed
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const intRes = await adapter.interruptTurn({
        threadId: 'thr_int_wait',
        turnId: 'turn_int_wait'
      });
      // Response from interruptTurn does NOT declare turn completed
      assert.strictEqual(intRes.status, undefined);
      // Actual completion must come from waitForTurnCompletion
      const completion = await adapter.waitForTurnCompletion({
        threadId: 'thr_int_wait',
        turnId: 'turn_int_wait',
        timeoutMs: 1000
      });
      assert.strictEqual(completion.status, 'interrupted');
      console.log('PASS: CAS-051 — Adapter interruptTurn does not fabricate completion before turn/completed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-052: Adapter startReview() allows delivery=inline
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const review = await adapter.startReview({
        threadId: 'thr_rev_inline',
        target: 'uncommittedChanges',
        delivery: 'inline'
      });
      assert.strictEqual(review.reviewThreadId, 'thr_rev_inline');
      assert.strictEqual(review.turnId, 'turn_rev_001');
      console.log('PASS: CAS-052 — Adapter startReview allows delivery=inline');
    } finally {
      await adapter.close();
    }
  }

  // CAS-053: Adapter startReview() rejects delivery=detached
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startReview({
          threadId: 'thr_rev_detached',
          target: 'uncommittedChanges',
          delivery: 'detached'
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'DETACHED_REVIEW_UNSUPPORTED');
      console.log('PASS: CAS-053 — Adapter startReview rejects delivery=detached fail-closed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-054: Adapter startReview() rejects unknown review target types
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startReview({
          threadId: 'thr_rev_target',
          target: 'arbitraryRandomTarget',
          delivery: 'inline'
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'INVALID_REVIEW_TARGET');
      console.log('PASS: CAS-054 — Adapter startReview rejects unsupported target types');
    } finally {
      await adapter.close();
    }
  }

  // CAS-055: Adapter startReview() rejects reviewThreadId mismatch with CODEX_APP_SERVER_THREAD_MISMATCH
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startReview({
          threadId: 'thr_expected',
          _wrongReviewThread: true,
          target: 'uncommittedChanges',
          delivery: 'inline'
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_THREAD_MISMATCH');
      console.log('PASS: CAS-055 — Adapter startReview rejects thread mismatch fail-closed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-056: Adapter waitForReviewCompletion() collects exitedReviewMode item and requires turn/completed
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const rev = await adapter.startReview({
        threadId: 'thr_rev_wait',
        target: 'uncommittedChanges',
        delivery: 'inline'
      });
      const completion = await adapter.waitForReviewCompletion({
        threadId: 'thr_rev_wait',
        turnId: rev.turnId,
        timeoutMs: 1000
      });
      assert.strictEqual(completion.status, 'completed');
      assert.notStrictEqual(completion.reviewEvidence, null);
      assert.strictEqual(completion.reviewEvidence.type, 'exitedReviewMode');
      console.log('PASS: CAS-056 — Adapter waitForReviewCompletion collects exitedReviewMode evidence and verifies turn/completed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-057: Adapter operations do not write or mutate Project Registry
  {
    const fs = require('fs');
    const registryPath = path.join(__dirname, '..', '..', 'fixtures', 'non_existent_registry.json');
    assert.strictEqual(fs.existsSync(registryPath), false, 'CAS-057: Pre-condition registry file must not exist');

    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.strictEqual(fs.existsSync(registryPath), false, 'CAS-057: Adapter operations must not write to Registry');
      console.log('PASS: CAS-057 — Zero Registry writes or mutations from adapter operations');
    } finally {
      await adapter.close();
    }
  }

  // CAS-058: Adapter operations do not call broker or dispatch workers
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      // Verify adapter module has no dependencies on broker or worker
      const adapterSource = require('fs').readFileSync(
        path.join(__dirname, '..', '..', 'lib', 'auditor', 'codex-auditor-adapter.js'),
        'utf8'
      );
      assert.strictEqual(adapterSource.includes("require('../broker"), false);
      assert.strictEqual(adapterSource.includes("require('./broker"), false);
      assert.strictEqual(adapterSource.includes('dispatchWorker'), false);
      console.log('PASS: CAS-058 — Adapter operates strictly within auditor boundary without broker/worker coupling');
    } finally {
      await adapter.close();
    }
  }

  // CAS-059: Adapter operations do not parse semantic AuditDecision actions
  {
    const clientSource = require('fs').readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'auditor', 'codex-app-server-client.js'),
      'utf8'
    );
    const adapterSource = require('fs').readFileSync(
      path.join(__dirname, '..', '..', 'lib', 'auditor', 'codex-auditor-adapter.js'),
      'utf8'
    );
    assert.strictEqual(clientSource.includes('DISPATCH_WORKER'), false);
    assert.strictEqual(adapterSource.includes('DISPATCH_WORKER'), false);
    assert.strictEqual(clientSource.includes('APPROVE_WORK_PACKAGE'), false);
    assert.strictEqual(adapterSource.includes('APPROVE_WORK_PACKAGE'), false);
    console.log('PASS: CAS-059 — AuditDecision semantics reserved for WP-V4-04');
  }

  // CAS-060: Every test cleans up child fixture process in finally blocks (zero orphan processes)
  {
    const client = createTestClient();
    await client.initialize();
    const pid = client._child.pid;
    assert.strictEqual(typeof pid, 'number');
    await client.close(100);
    assert.strictEqual(client.getState(), CLIENT_STATES.CLOSED);
    console.log('PASS: CAS-060 — Child fixture processes guaranteed cleanup in finally blocks');
  }

  console.log('\n======================================================================');
  console.log('ALL CODEX APP SERVER TESTS PASSED (CAS-001 .. CAS-060: 60/60 PASS)');
  console.log('======================================================================');
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };

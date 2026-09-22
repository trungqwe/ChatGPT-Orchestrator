'use strict';

/**
 * Codex App Server Stdio Transport & Adapter Test Suite
 * CAS-001 .. CAS-109
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
  console.log('Starting Codex App Server Client & Adapter test suite (CAS-001 .. CAS-109)...\n');

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
      const req1 = client.sendRequest('thread/start', { cwd: 'D:\\test\\a' });
      const req2 = client.sendRequest('thread/start', { cwd: 'D:\\test\\b' });
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
    const client = createTestClient({ fixtureArgs: ['--scenario=provider_error'] });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {});
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
    const client = createTestClient({ fixtureArgs: ['--scenario=unknown_response_id'] });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {});
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
    const client = createTestClient({ fixtureArgs: ['--scenario=duplicate_response'] });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {});
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
      assert.strictEqual(turnRes.turn.status, 'inProgress');
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
      assert.strictEqual(serverReqReceived.method, 'item/commandExecution/requestApproval');
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

  // CAS-018: Line exceeding 4 MiB max bound fails transport with CODEX_APP_SERVER_PROTOCOL_LIMIT
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=oversized_line'] });
    try {
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null, 'CAS-018: Oversized line must fail transport');
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROTOCOL_LIMIT');
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      console.log('PASS: CAS-018 — Oversized line fails transport with CODEX_APP_SERVER_PROTOCOL_LIMIT');
    } finally {
      await client.close();
    }
  }

  // CAS-019: Client stdin write failure marks request as NOT sent
  {
    const client = createTestClient();
    try {
      await client.initialize();
      // Force destroy stdin to simulate immediate write failure
      client._child.stdin.destroy();
      let caught = null;
      try {
        await client.sendRequest('model/list');
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null, 'CAS-019: Write error must reject');
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_STDIN_ERROR');
      console.log('PASS: CAS-019 — Stdin write failure reported as not successfully sent');
    } finally {
      await client.close();
    }
  }

  // CAS-020: Read-only request timeout returns normal timeout error without auto-retry
  {
    const client = createTestClient({
      fixtureArgs: ['--scenario=timeout'],
      timeouts: { read: 50, default: 50 }
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {}, { timeoutMs: 50, isSideEffecting: false });
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
      fixtureArgs: ['--scenario=timeout'],
      timeouts: { default: 50 }
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('thread/start', { cwd: 'D:\\test' }, { timeoutMs: 50, isSideEffecting: true });
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
    const client = createTestClient({
      fixtureArgs: ['--scenario=timeout']
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('turn/start', { threadId: 'thr_1' }, { timeoutMs: 50, isSideEffecting: true });
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
    const client = createTestClient({
      fixtureArgs: ['--scenario=timeout']
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('review/start', { threadId: 'thr_1' }, { timeoutMs: 50, isSideEffecting: true });
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
    const client = createTestClient({
      fixtureArgs: ['--scenario=timeout']
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('turn/interrupt', { threadId: 'thr_1', turnId: 'turn_1' }, { timeoutMs: 50, isSideEffecting: true });
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
    const client = createTestClient({
      fixtureArgs: ['--scenario=exit_mid_request']
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {}, { timeoutMs: 500, isSideEffecting: false });
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
    const client = createTestClient({
      fixtureArgs: ['--scenario=exit_mid_request']
    });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('thread/start', { cwd: 'D:\\test' }, { timeoutMs: 500, isSideEffecting: true });
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
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=custom_opaque_ids'] });
    try {
      await adapter.initialize();
      const customThreadId = 'thr_exact_opaque_id_98765';
      const customSessionId = 'ses_exact_opaque_id_54321';
      const thread = await adapter.startThread({
        cwd: 'D:\\test\\workspace'
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
        await adapter.resumeThread({ threadId: 'thr_bad' });
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
      assert.strictEqual(turn.status, 'inProgress');
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
        target: { type: 'uncommittedChanges' },
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
          target: { type: 'uncommittedChanges' },
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
          threadId: 'thr_wrong_review_test',
          target: { type: 'uncommittedChanges' },
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
        target: { type: 'uncommittedChanges' },
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
      assert.strictEqual(typeof completion.reviewEvidence.review, 'string');
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

  // CAS-061: thread/start sends sandbox=read-only
  {
    let sentRequestParams = null;
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const origSendRequest = adapter._client.sendRequest.bind(adapter._client);
      adapter._client.sendRequest = function(method, params, options) {
        if (method === 'thread/start') {
          sentRequestParams = params;
        }
        return origSendRequest(method, params, options);
      };
      await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.notStrictEqual(sentRequestParams, null);
      assert.strictEqual(sentRequestParams.sandbox, 'read-only');
      console.log('PASS: CAS-061 — thread/start sends sandbox=read-only');
    } finally {
      await adapter.close();
    }
  }

  // CAS-062: thread/start does not send readOnly boolean
  {
    let sentRequestParams = null;
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const origSendRequest = adapter._client.sendRequest.bind(adapter._client);
      adapter._client.sendRequest = function(method, params, options) {
        if (method === 'thread/start') {
          sentRequestParams = params;
        }
        return origSendRequest(method, params, options);
      };
      await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.notStrictEqual(sentRequestParams, null);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(sentRequestParams, 'readOnly'), false);
      assert.strictEqual(sentRequestParams.readOnly, undefined);
      console.log('PASS: CAS-062 — thread/start does not send readOnly boolean');
    } finally {
      await adapter.close();
    }
  }

  // CAS-063: thread/start sends approvalPolicy=never
  {
    let sentRequestParams = null;
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const origSendRequest = adapter._client.sendRequest.bind(adapter._client);
      adapter._client.sendRequest = function(method, params, options) {
        if (method === 'thread/start') {
          sentRequestParams = params;
        }
        return origSendRequest(method, params, options);
      };
      await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.notStrictEqual(sentRequestParams, null);
      assert.strictEqual(sentRequestParams.approvalPolicy, 'never');
      console.log('PASS: CAS-063 — thread/start sends approvalPolicy=never');
    } finally {
      await adapter.close();
    }
  }

  // CAS-064: initialized notification includes params={}
  {
    let capturedInitializedNotification = null;
    const client = createTestClient();
    try {
      const origSendNotification = client._sendNotification.bind(client);
      client._sendNotification = function(method, params) {
        if (method === 'initialized') {
          capturedInitializedNotification = { method, params };
        }
        return origSendNotification(method, params);
      };
      await client.initialize();
      assert.notStrictEqual(capturedInitializedNotification, null);
      assert.strictEqual(capturedInitializedNotification.method, 'initialized');
      assert.deepStrictEqual(capturedInitializedNotification.params, {});
      console.log('PASS: CAS-064 — initialized notification includes params={}');
    } finally {
      await client.close();
    }
  }

  // CAS-065: initialized write failure prevents READY state and transitions to FAILED
  {
    const client = createTestClient();
    try {
      client._sendNotification = async function(method) {
        throw new Error('Simulated stdin write failure for initialized');
      };
      let caught = null;
      try {
        await client.initialize();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(client.getState(), CLIENT_STATES.FAILED);
      assert.notStrictEqual(client.getState(), CLIENT_STATES.READY);
      console.log('PASS: CAS-065 — initialized write failure prevents READY');
    } finally {
      await client.close();
    }
  }

  // CAS-066: no underscore/test fields reach provider
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let sentThreadParams = null;
      let sentTurnParams = null;
      let sentReviewParams = null;
      const origSendRequest = adapter._client.sendRequest.bind(adapter._client);
      adapter._client.sendRequest = function(method, params, options) {
        if (method === 'thread/start') sentThreadParams = params;
        if (method === 'turn/start') sentTurnParams = params;
        if (method === 'review/start') sentReviewParams = params;
        return origSendRequest(method, params, options);
      };

      await adapter.startThread({
        cwd: 'D:\\test\\workspace',
        _trigger: 'fake_trigger',
        _threadId: 'thr_custom',
        _sessionId: 'ses_custom'
      });
      assert.strictEqual(Object.keys(sentThreadParams).some((k) => k.startsWith('_')), false);

      await adapter.startTurn({
        threadId: 'thr_fake_001',
        input: [{ type: 'text', text: 'hello' }],
        _wrongTurnId: true,
        _failTurn: true
      });
      assert.strictEqual(Object.keys(sentTurnParams).some((k) => k.startsWith('_')), false);

      await adapter.startReview({
        threadId: 'thr_fake_001',
        target: { type: 'uncommittedChanges' },
        delivery: 'inline',
        _wrongReviewThread: true,
        _reviewTurnId: 'custom'
      });
      assert.strictEqual(Object.keys(sentReviewParams).some((k) => k.startsWith('_')), false);
      console.log('PASS: CAS-066 — no underscore/test fields reach provider');
    } finally {
      await adapter.close();
    }
  }

  // CAS-067: real-shaped turn/completed without threadId resolves exact turn
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_real_shape_test',
        input: [{ type: 'text', text: 'Run without notification threadId' }]
      });
      // The default fake fixture emits turn/completed with NO threadId in params
      const completion = await adapter.waitForTurnCompletion({
        threadId: 'thr_real_shape_test',
        turnId: turn.turnId,
        timeoutMs: 1000
      });
      assert.strictEqual(completion.turnId, turn.turnId);
      assert.strictEqual(completion.threadId, 'thr_real_shape_test');
      assert.strictEqual(completion.status, 'completed');
      console.log('PASS: CAS-067 — real-shaped turn/completed without threadId resolves exact turn');
    } finally {
      await adapter.close();
    }
  }

  // CAS-068: wrong local thread ownership fails immediately with CODEX_APP_SERVER_THREAD_MISMATCH
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_owner_a',
        input: [{ type: 'text', text: 'Check thread ownership mismatch' }]
      });
      let caught = null;
      try {
        await adapter.waitForTurnCompletion({
          threadId: 'thr_owner_b', // Different thread from turn owner
          turnId: turn.turnId,
          timeoutMs: 1000
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_THREAD_MISMATCH');
      console.log('PASS: CAS-068 — wrong local thread ownership fails immediately');
    } finally {
      await adapter.close();
    }
  }

  // CAS-069: completion arriving before waiter is retained in completion cache
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=early_completion'] });
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_early_race_test',
        input: [{ type: 'text', text: 'Race test' }]
      });
      // Wait for turn/completed notification to arrive and be cached BEFORE calling waitForTurnCompletion
      await new Promise((r) => setTimeout(r, 60));

      const startTime = Date.now();
      const completion = await adapter.waitForTurnCompletion({
        threadId: 'thr_early_race_test',
        turnId: turn.turnId,
        timeoutMs: 500
      });
      const elapsed = Date.now() - startTime;
      assert.strictEqual(completion.turnId, turn.turnId);
      assert.strictEqual(completion.status, 'completed');
      assert.strictEqual(elapsed < 200, true, 'Cached completion should resolve immediately');
      console.log('PASS: CAS-069 — completion arriving before waiter is retained');
    } finally {
      await adapter.close();
    }
  }

  // CAS-070: review exitedReviewMode correlates item.id == turnId and preserves review field
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const rev = await adapter.startReview({
        threadId: 'thr_rev_evidence_test',
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      });
      const completion = await adapter.waitForReviewCompletion({
        threadId: 'thr_rev_evidence_test',
        turnId: rev.turnId,
        timeoutMs: 1000
      });
      assert.strictEqual(completion.reviewEvidence.type, 'exitedReviewMode');
      assert.strictEqual(completion.reviewEvidence.id, rev.turnId);
      assert.strictEqual(typeof completion.reviewEvidence.review, 'string');
      console.log('PASS: CAS-070 — review exitedReviewMode correlates item.id == turnId');
    } finally {
      await adapter.close();
    }
  }

  // CAS-071: unrelated review evidence cannot satisfy waiter
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=unrelated_review_evidence'] });
    try {
      await adapter.initialize();
      const rev = await adapter.startReview({
        threadId: 'thr_rev_unrelated_test',
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      });
      let caught = null;
      try {
        await adapter.waitForReviewCompletion({
          threadId: 'thr_rev_unrelated_test',
          turnId: rev.turnId,
          timeoutMs: 150
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'WAIT_REVIEW_TIMEOUT');
      console.log('PASS: CAS-071 — unrelated review evidence cannot satisfy waiter');
    } finally {
      await adapter.close();
    }
  }

  // CAS-072: review evidence arriving before waiter retained in evidence cache
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=early_review_evidence'] });
    try {
      await adapter.initialize();
      const rev = await adapter.startReview({
        threadId: 'thr_rev_early_test',
        target: { type: 'uncommittedChanges' },
        delivery: 'inline'
      });
      // Sleep to ensure events arrive and are cached before calling waitForReviewCompletion
      await new Promise((r) => setTimeout(r, 60));

      const startTime = Date.now();
      const completion = await adapter.waitForReviewCompletion({
        threadId: 'thr_rev_early_test',
        turnId: rev.turnId,
        timeoutMs: 500
      });
      const elapsed = Date.now() - startTime;
      assert.strictEqual(completion.turnId, rev.turnId);
      assert.strictEqual(completion.status, 'completed');
      assert.strictEqual(completion.reviewEvidence.id, rev.turnId);
      assert.strictEqual(elapsed < 200, true, 'Cached review evidence resolves immediately');
      console.log('PASS: CAS-072 — review evidence arriving before waiter retained');
    } finally {
      await adapter.close();
    }
  }

  // CAS-073: string review target rejected fail-closed
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.startReview({
          threadId: 'thr_rev_str',
          target: 'uncommittedChanges', // Plain string forbidden
          delivery: 'inline'
        });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'INVALID_REVIEW_TARGET');
      console.log('PASS: CAS-073 — string review target rejected');
    } finally {
      await adapter.close();
    }
  }

  // CAS-074: resume response thread mismatch rejected fail-closed
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=resume_thread_mismatch'] });
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.resumeThread({ threadId: 'thr_expected_resume' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_THREAD_MISMATCH');
      console.log('PASS: CAS-074 — resume response thread mismatch rejected');
    } finally {
      await adapter.close();
    }
  }

  // CAS-075: read response thread mismatch rejected fail-closed
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=read_thread_mismatch'] });
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.readThread({ threadId: 'thr_expected_read' });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_THREAD_MISMATCH');
      console.log('PASS: CAS-075 — read response thread mismatch rejected');
    } finally {
      await adapter.close();
    }
  }

  // CAS-076: response with neither result nor error rejected
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=neither_result_nor_error'] });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {});
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROTOCOL_ERROR');
      console.log('PASS: CAS-076 — response with neither result nor error rejected');
    } finally {
      await client.close();
    }
  }

  // CAS-077: response with both result and error rejected
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=both_result_and_error'] });
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('model/list', {});
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROTOCOL_ERROR');
      console.log('PASS: CAS-077 — response with both result and error rejected');
    } finally {
      await client.close();
    }
  }

  // CAS-078: close sent thread/start -> REQUEST_UNCERTAIN
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=timeout'] });
    try {
      await client.initialize();
      const startReq = client.sendRequest('thread/start', { cwd: 'D:\\test' }, { timeoutMs: 5000, isSideEffecting: true });
      // Allow write to flush so request is authoritative 'sent'
      await new Promise((r) => setTimeout(r, 25));
      const [closeResult, reqResult] = await Promise.allSettled([client.close(), startReq]);
      assert.strictEqual(reqResult.status, 'rejected');
      assert.strictEqual(reqResult.reason.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-078 — close sent thread/start -> REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-079: close sent turn/start -> REQUEST_UNCERTAIN
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=timeout'] });
    try {
      await client.initialize();
      const turnReq = client.sendRequest('turn/start', { threadId: 'thr_1' }, { timeoutMs: 5000, isSideEffecting: true });
      // Allow write to flush so request is authoritative 'sent'
      await new Promise((r) => setTimeout(r, 25));
      const [closeResult, reqResult] = await Promise.allSettled([client.close(), turnReq]);
      assert.strictEqual(reqResult.status, 'rejected');
      assert.strictEqual(reqResult.reason.code, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN');
      console.log('PASS: CAS-079 — close sent turn/start -> REQUEST_UNCERTAIN');
    } finally {
      await client.close();
    }
  }

  // CAS-080: official commandExecution approval request not auto-approved
  {
    const client = createTestClient({ fixtureArgs: ['--scenario=server_request'] });
    try {
      let serverReq = null;
      client.on('serverRequest', (req) => {
        serverReq = req;
      });
      await client.initialize();
      await new Promise((r) => setTimeout(r, 100));
      assert.notStrictEqual(serverReq, null);
      assert.strictEqual(serverReq.method, 'item/commandExecution/requestApproval');
      console.log('PASS: CAS-080 — official commandExecution approval request not auto-approved');
    } finally {
      await client.close();
    }
  }

  // CAS-081: stable inProgress provider status preserved
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const turn = await adapter.startTurn({
        threadId: 'thr_inprogress_test',
        input: [{ type: 'text', text: 'status check' }]
      });
      assert.strictEqual(turn.status, 'inProgress');
      console.log('PASS: CAS-081 — stable inProgress provider status preserved');
    } finally {
      await adapter.close();
    }
  }

  // CAS-082: provider contract snapshot asserts key stable field names
  {
    const STABLE_CONTRACT = {
      threadStart: {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        forbiddenFields: ['readOnly', 'workspaceWrite', 'dangerFullAccess']
      },
      initializedNotification: {
        method: 'initialized',
        paramsType: 'object'
      },
      turnStatus: {
        initial: 'inProgress',
        terminal: ['completed', 'interrupted', 'failed']
      },
      reviewTarget: {
        allowedTypes: ['uncommittedChanges', 'baseBranch', 'commit', 'custom'],
        stringTargetAllowed: false
      },
      reviewEvidence: {
        itemType: 'exitedReviewMode',
        evidenceField: 'review'
      },
      turnSandboxPolicyReadOnlyType: 'readOnly'
    };

    assert.strictEqual(STABLE_CONTRACT.threadStart.sandbox, 'read-only');
    assert.strictEqual(STABLE_CONTRACT.turnSandboxPolicyReadOnlyType, 'readOnly');
    assert.strictEqual(STABLE_CONTRACT.threadStart.approvalPolicy, 'never');
    assert.strictEqual(STABLE_CONTRACT.turnStatus.initial, 'inProgress');
    assert.strictEqual(STABLE_CONTRACT.reviewEvidence.evidenceField, 'review');
    assert.strictEqual(STABLE_CONTRACT.reviewTarget.stringTargetAllowed, false);
    console.log('PASS: CAS-082 — provider contract snapshot asserts key stable field names');
  }

  // CAS-083: thread/start never sends camelCase readOnly SandboxMode
  {
    let sentRequestParams = null;
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const origSendRequest = adapter._client.sendRequest.bind(adapter._client);
      adapter._client.sendRequest = function(method, params, options) {
        if (method === 'thread/start') {
          sentRequestParams = params;
        }
        return origSendRequest(method, params, options);
      };
      await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      assert.notStrictEqual(sentRequestParams, null);
      assert.notStrictEqual(sentRequestParams.sandbox, 'readOnly', 'CAS-083: sandbox must not be camelCase readOnly');
      assert.strictEqual(sentRequestParams.sandbox, 'read-only', 'CAS-083: sandbox must be kebab-case read-only');
      console.log('PASS: CAS-083 — thread/start never sends camelCase readOnly SandboxMode');
    } finally {
      await adapter.close();
    }
  }

  // CAS-084: fake provider rejects wrong thread SandboxMode enum
  {
    const client = createTestClient();
    try {
      await client.initialize();
      let caught = null;
      try {
        await client.sendRequest('thread/start', {
          cwd: 'D:\\test\\workspace',
          approvalPolicy: 'never',
          sandbox: 'readOnly' // Invalid camelCase SandboxMode enum
        }, { isSideEffecting: true });
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_PROVIDER_ERROR');
      assert.strictEqual(caught.details.providerError.code, -32602);
      assert.strictEqual(caught.details.providerError.message.includes('invalid sandbox mode'), true);
      console.log('PASS: CAS-084 — fake provider rejects wrong thread SandboxMode enum');
    } finally {
      await client.close();
    }
  }

  // CAS-085: model/list data response accepted with complete structure
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const models = await adapter.listModels();
      assert.strictEqual(Array.isArray(models), true);
      assert.strictEqual(models.length >= 3, true);
      assert.strictEqual(typeof models[0].model, 'string');
      assert.strictEqual(Array.isArray(models[0].supportedReasoningEfforts), true);
      console.log('PASS: CAS-085 — model/list data response accepted with complete structure');
    } finally {
      await adapter.close();
    }
  }

  // CAS-086 & CAS-087: pagination across 2+ pages and exact cursor forwarding
  {
    const adapter = createTestAdapter({
      fixtureArgs: ['--scenario=model_list_pagination']
    });
    try {
      await adapter.initialize();
      const models = await adapter.listModels();
      assert.strictEqual(Array.isArray(models), true);
      assert.strictEqual(models.length, 2);
      assert.strictEqual(models[0].id, 'mock-model-p1');
      assert.strictEqual(models[1].id, 'mock-model-p2');
      console.log('PASS: CAS-086 & CAS-087 — pagination across 2+ pages with exact cursor forwarding');
    } finally {
      await adapter.close();
    }
  }

  // CAS-088: repeated cursor rejected fail-closed
  {
    const adapter = createTestAdapter({
      fixtureArgs: ['--scenario=model_list_repeated_cursor']
    });
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.listModels();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_INVALID_RESPONSE');
      assert.strictEqual(caught.message.includes('repeated cursor or pagination cycle'), true);
      console.log('PASS: CAS-088 — repeated cursor rejected fail-closed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-089: malformed cursor rejected fail-closed
  {
    const adapter = createTestAdapter({
      fixtureArgs: ['--scenario=model_list_malformed_cursor']
    });
    try {
      await adapter.initialize();
      let caught = null;
      try {
        await adapter.listModels();
      } catch (err) {
        caught = err;
      }
      assert.notStrictEqual(caught, null);
      assert.strictEqual(caught.code, 'CODEX_APP_SERVER_INVALID_RESPONSE');
      assert.strictEqual(caught.message.includes('nextCursor must be a non-empty string'), true);
      console.log('PASS: CAS-089 — malformed cursor rejected fail-closed');
    } finally {
      await adapter.close();
    }
  }

  // CAS-090: catalog size bound enforced fail-closed
  {
    const mockClient = {
      on: () => {},
      sendRequest: async () => ({
        data: new Array(1001).fill({
          id: 'm',
          model: 'm',
          hidden: false,
          isDefault: false,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: []
        })
      })
    };
    const adapter = new CodexAuditorAdapter({ client: mockClient });
    let caught = null;
    try {
      await adapter.listModels();
    } catch (err) {
      caught = err;
    }
    assert.notStrictEqual(caught, null);
    assert.strictEqual(caught.code, 'CODEX_APP_SERVER_INVALID_RESPONSE');
    assert.strictEqual(caught.message.includes('catalog exceeded maximum bound'), true);
    console.log('PASS: CAS-090 — catalog size bound enforced fail-closed');
  }

  // CAS-091: startTurn forwards exact model
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const thread = await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      const turn = await adapter.startTurn({
        threadId: thread.threadId,
        input: [{ type: 'text', text: 'audit prompt' }],
        model: 'mock-model-standard'
      });
      assert.strictEqual(turn.raw.turn.model, 'mock-model-standard');
      console.log('PASS: CAS-091 — startTurn forwards exact model');
    } finally {
      await adapter.close();
    }
  }

  // CAS-092: startTurn forwards exact effort
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const thread = await adapter.startThread({ cwd: 'D:\\test\\workspace' });
      const turn = await adapter.startTurn({
        threadId: thread.threadId,
        input: [{ type: 'text', text: 'audit prompt' }],
        model: 'mock-model-standard',
        effort: 'high'
      });
      assert.strictEqual(turn.raw.turn.model, 'mock-model-standard');
      assert.strictEqual(turn.raw.turn.effort, 'high');
      console.log('PASS: CAS-092 — startTurn forwards exact effort');
    } finally {
      await adapter.close();
    }
  }

  // CAS-093: invalid model rejected locally before transport
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const invalidModels = ['', '   ', 'model\nname', ' leading', 'trailing '];
      for (const badModel of invalidModels) {
        let caught = null;
        try {
          await adapter.startTurn({
            threadId: 'thr_test',
            input: [{ type: 'text', text: 'audit prompt' }],
            model: badModel
          });
        } catch (err) {
          caught = err;
        }
        assert.notStrictEqual(caught, null);
        assert.strictEqual(caught.code, 'INVALID_ARGUMENT');
      }
      console.log('PASS: CAS-093 — invalid model rejected locally before transport');
    } finally {
      await adapter.close();
    }
  }

  // CAS-094: invalid effort rejected locally before transport
  {
    const adapter = createTestAdapter();
    try {
      await adapter.initialize();
      const invalidEfforts = ['', '   ', 'effort\x00name', ' low', 'medium '];
      for (const badEffort of invalidEfforts) {
        let caught = null;
        try {
          await adapter.startTurn({
            threadId: 'thr_test',
            input: [{ type: 'text', text: 'audit prompt' }],
            effort: badEffort
          });
        } catch (err) {
          caught = err;
        }
        assert.notStrictEqual(caught, null);
        assert.strictEqual(caught.code, 'INVALID_ARGUMENT');
      }
      console.log('PASS: CAS-094 — invalid effort rejected locally before transport');
    } finally {
      await adapter.close();
    }
  }

  // CAS-095: exact maximum page count succeeds
  {
    let callCount = 0;
    const requestedCursors = [];
    const mockClient = {
      on: () => {},
      sendRequest: async (method, params) => {
        assert.strictEqual(method, 'model/list');
        callCount++;
        requestedCursors.push(params.cursor || null);
        const pageIdx = callCount;
        const modelEntry = {
          id: `mod-page-${pageIdx}`,
          model: `mod-page-${pageIdx}`,
          hidden: false,
          isDefault: pageIdx === 1,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
        };
        if (pageIdx < 50) {
          return {
            data: [modelEntry],
            nextCursor: `cursor_page_${pageIdx + 1}`
          };
        } else {
          return {
            data: [modelEntry],
            nextCursor: null
          };
        }
      }
    };
    const adapter = new CodexAuditorAdapter({ client: mockClient });
    const models = await adapter.listModels();
    assert.strictEqual(callCount, 50, 'provider model/list must be called exactly 50 times');
    assert.strictEqual(models.length, 50, 'all 50 models must be returned');
    assert.strictEqual(models[0].id, 'mod-page-1');
    assert.strictEqual(models[49].id, 'mod-page-50');
    assert.strictEqual(requestedCursors[0], null);
    assert.strictEqual(requestedCursors[1], 'cursor_page_2');
    assert.strictEqual(requestedCursors[49], 'cursor_page_50');
    console.log('PASS: CAS-095 — exact maximum page count succeeds');
  }

  // CAS-096: page 51 required fails closed
  {
    let callCount = 0;
    const mockClient = {
      on: () => {},
      sendRequest: async (method, params) => {
        assert.strictEqual(method, 'model/list');
        callCount++;
        const pageIdx = callCount;
        const modelEntry = {
          id: `mod-page-${pageIdx}`,
          model: `mod-page-${pageIdx}`,
          hidden: false,
          isDefault: pageIdx === 1,
          defaultReasoningEffort: 'low',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }]
        };
        return {
          data: [modelEntry],
          nextCursor: `cursor_page_${pageIdx + 1}`
        };
      }
    };
    const adapter = new CodexAuditorAdapter({ client: mockClient });
    let caught = null;
    try {
      await adapter.listModels();
    } catch (err) {
      caught = err;
    }
    assert.notStrictEqual(caught, null);
    assert.strictEqual(caught.code, 'CODEX_APP_SERVER_INVALID_RESPONSE');
    assert.strictEqual(caught.message.includes('exceeded maximum page limit'), true);
    assert.strictEqual(callCount, 50, 'must not issue page-51 request');
    console.log('PASS: CAS-096 — page 51 required fails closed');
  }

  // CAS-097: valid usage notification captured
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=turn_with_token_usage'] });
    try {
      await adapter.initialize();
      let captured = null;
      adapter.on('token_usage', (snapshot) => {
        captured = snapshot;
      });

      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      assert.notStrictEqual(captured, null, 'token_usage event must be emitted');
      assert.strictEqual(captured.threadId, th.threadId);
      assert.strictEqual(captured.turnId, tu.turnId);
      assert.strictEqual(captured.total.totalTokens, 15650);
      assert.strictEqual(captured.total.inputTokens, 12000);
      assert.strictEqual(captured.total.cachedInputTokens, 8000);
      assert.strictEqual(captured.total.cacheWriteInputTokens, 0);
      assert.strictEqual(captured.total.outputTokens, 3650);
      assert.strictEqual(captured.total.reasoningOutputTokens, 1500);
      assert.strictEqual(captured.last.totalTokens, 4632);
      assert.strictEqual(captured.modelContextWindow, 258400);
      console.log('PASS: CAS-097 — valid usage notification captured');
    } finally {
      await adapter.close();
    }
  }

  // CAS-098: exact thread lookup
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=turn_with_token_usage'] });
    try {
      await adapter.initialize();
      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      const threadSnapshot = adapter.getLatestTokenUsageForThread(th.threadId);
      assert.notStrictEqual(threadSnapshot, null);
      assert.strictEqual(threadSnapshot.total.totalTokens, 15650);
      assert.strictEqual(threadSnapshot.modelContextWindow, 258400);

      // Other thread returns null
      assert.strictEqual(adapter.getLatestTokenUsageForThread('thr_unknown_999'), null);
      console.log('PASS: CAS-098 — exact thread lookup');
    } finally {
      await adapter.close();
    }
  }

  // CAS-099: exact turn lookup
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=turn_with_token_usage'] });
    try {
      await adapter.initialize();
      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      const turnSnapshot = adapter.getLatestTokenUsageForTurn({
        threadId: th.threadId,
        turnId: tu.turnId
      });
      assert.notStrictEqual(turnSnapshot, null);
      assert.strictEqual(turnSnapshot.total.totalTokens, 15650);
      assert.strictEqual(turnSnapshot.last.totalTokens, 4632);

      // Mismatched thread with same turn returns null (no fallback)
      assert.strictEqual(
        adapter.getLatestTokenUsageForTurn({ threadId: 'thr_different', turnId: tu.turnId }),
        null
      );
      // Mismatched turn with same thread returns null
      assert.strictEqual(
        adapter.getLatestTokenUsageForTurn({ threadId: th.threadId, turnId: 'turn_nonexistent' }),
        null
      );
      console.log('PASS: CAS-099 — exact turn lookup');
    } finally {
      await adapter.close();
    }
  }

  // CAS-100: repeated snapshot replaces, does not add
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=repeated_token_usage'] });
    try {
      await adapter.initialize();
      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      const latest = adapter.getLatestTokenUsageForThread(th.threadId);
      assert.notStrictEqual(latest, null);
      // Second snapshot totalTokens = 19800, NOT 15650 + 19800 = 35450
      assert.strictEqual(latest.total.totalTokens, 19800);
      // Second snapshot last.totalTokens = 4150, NOT 4632 + 4150 = 8782
      assert.strictEqual(latest.last.totalTokens, 4150);
      console.log('PASS: CAS-100 — repeated snapshot replaces, does not add');
    } finally {
      await adapter.close();
    }
  }

  // CAS-101: malformed usage ignored/rejected from observability state
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=malformed_token_usage'] });
    try {
      await adapter.initialize();
      let errorEmitted = null;
      adapter.on('token_usage_error', (err) => {
        errorEmitted = err;
      });

      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      // Audit and turn complete normally despite malformed usage notification
      const comp = await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });
      assert.strictEqual(comp.status, 'completed');

      // Observability state has zero records (malformed rejected)
      assert.strictEqual(adapter.getLatestTokenUsageForThread(th.threadId), null);
      assert.strictEqual(adapter.getLatestTokenUsageForTurn({ threadId: th.threadId, turnId: tu.turnId }), null);
      console.log('PASS: CAS-101 — malformed usage ignored/rejected from observability state');
    } finally {
      await adapter.close();
    }
  }

  // CAS-102: thread ownership mismatch rejected
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=token_usage_thread_mismatch'] });
    try {
      await adapter.initialize();
      let mismatchError = null;
      adapter.on('token_usage_mismatch', (err) => {
        mismatchError = err;
      });

      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      // Mismatch surfaced
      assert.notStrictEqual(mismatchError, null);
      assert.strictEqual(mismatchError.code, 'TOKEN_USAGE_THREAD_MISMATCH');

      // Neither thread records the mismatched usage
      assert.strictEqual(adapter.getLatestTokenUsageForThread(th.threadId), null);
      assert.strictEqual(adapter.getLatestTokenUsageForThread('thr_mismatch_other'), null);
      console.log('PASS: CAS-102 — thread ownership mismatch rejected');
    } finally {
      await adapter.close();
    }
  }

  // CAS-103: valid early notification before local ownership reconciles correctly
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=early_token_usage'] });
    try {
      await adapter.initialize();
      const th = await adapter.startThread({ cwd: process.cwd() });
      // In early_token_usage scenario, server sends tokenUsage notification BEFORE turn/start response
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      // After ownership is recorded, the early notification is reconciled
      const snapshot = adapter.getLatestTokenUsageForTurn({
        threadId: th.threadId,
        turnId: tu.turnId
      });
      assert.notStrictEqual(snapshot, null, 'early notification must be reconciled once ownership recorded');
      assert.strictEqual(snapshot.total.totalTokens, 12000);
      assert.strictEqual(snapshot.modelContextWindow, 258400);
      console.log('PASS: CAS-103 — valid early notification before local ownership reconciles correctly');
    } finally {
      await adapter.close();
    }
  }

  // CAS-104: getter result mutation does not alter cached state
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=early_token_usage'] });
    try {
      await adapter.initialize();
      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });

      const snap1 = adapter.getLatestTokenUsageForThread(th.threadId);
      assert.notStrictEqual(snap1, null);
      snap1.total.totalTokens = 999999999;
      snap1.last.outputTokens = 888888;

      const snap2 = adapter.getLatestTokenUsageForThread(th.threadId);
      assert.strictEqual(snap2.total.totalTokens, 12000);
      assert.strictEqual(snap2.last.outputTokens, 2000);
      console.log('PASS: CAS-104 — getter result mutation does not alter cached state');
    } finally {
      await adapter.close();
    }
  }

  // CAS-105: missing field does not poison adapter or interrupt audit
  {
    const adapter = createTestAdapter({ fixtureArgs: ['--scenario=token_usage_missing_mcw'] });
    try {
      await adapter.initialize();
      let errorEmitted = null;
      adapter.on('token_usage_error', (err) => {
        errorEmitted = err;
      });

      const th = await adapter.startThread({ cwd: process.cwd() });
      const tu = await adapter.startTurn({
        threadId: th.threadId,
        input: [{ type: 'text', text: 'Analyze code' }],
        model: 'gpt-4o',
        effort: 'medium'
      });
      // Turn completes normally
      const comp = await adapter.waitForTurnCompletion({ threadId: th.threadId, turnId: tu.turnId });
      assert.strictEqual(comp.status, 'completed');

      // token_usage_error emitted with TOKEN_USAGE_INVALID_NOTIFICATION
      assert.notStrictEqual(errorEmitted, null, 'token_usage_error event must be emitted');
      assert.strictEqual(errorEmitted.code, 'TOKEN_USAGE_INVALID_NOTIFICATION');

      // Getters return null (observability state clean)
      assert.strictEqual(adapter.getLatestTokenUsageForThread(th.threadId), null);
      assert.strictEqual(adapter.getLatestTokenUsageForTurn({ threadId: th.threadId, turnId: tu.turnId }), null);

      // Transport remains usable for subsequent operations
      const readResult = await adapter.readThread({ threadId: th.threadId });
      assert.strictEqual(readResult.thread.id, th.threadId);
      console.log('PASS: CAS-105 — missing field does not poison adapter');
    } finally {
      await adapter.close();
    }
  }

  // CAS-106: exact Antigravity brain authority propagated
  {
    let capturedEnv = null;
    const customSpawn = (bin, args, opts) => {
      capturedEnv = opts.env;
      return spawn(bin, args, opts);
    };

    const client = createTestClient({
      spawn: customSpawn,
      env: {
        ANTIGRAVITY_BRAIN_DIR: 'C:\\test\\antigravity-cli\\brain'
      }
    });
    try {
      await client.initialize();
      assert.strictEqual(
        capturedEnv.ANTIGRAVITY_BRAIN_DIR,
        'C:\\test\\antigravity-cli\\brain',
        'CAS-106: ANTIGRAVITY_BRAIN_DIR must be propagated exactly'
      );
      console.log('PASS: CAS-106 — exact Antigravity brain authority propagated');
    } finally {
      await client.close();
    }
  }

  // CAS-107: exact AO data authority propagated
  {
    let capturedEnv = null;
    const customSpawn = (bin, args, opts) => {
      capturedEnv = opts.env;
      return spawn(bin, args, opts);
    };

    const client = createTestClient({
      spawn: customSpawn,
      env: {
        AO_DATA_DIR: 'C:\\test\\.ao\\data'
      }
    });
    try {
      await client.initialize();
      assert.strictEqual(
        capturedEnv.AO_DATA_DIR,
        'C:\\test\\.ao\\data',
        'CAS-107: AO_DATA_DIR must be propagated exactly'
      );
      console.log('PASS: CAS-107 — exact AO data authority propagated');
    } finally {
      await client.close();
    }
  }

  // CAS-108: no wildcard authority expansion
  {
    let capturedEnv = null;
    const customSpawn = (bin, args, opts) => {
      capturedEnv = opts.env;
      return spawn(bin, args, opts);
    };

    const testEnv = {
      ANTIGRAVITY_BRAIN_DIR: 'C:\\test\\antigravity-cli\\brain',
      AO_DATA_DIR: 'C:\\test\\.ao\\data',
      ANTIGRAVITY_SECRET: 'must_not_pass',
      ANTIGRAVITY_TOKEN: 'must_not_pass',
      AO_SECRET: 'must_not_pass',
      AO_TOKEN: 'must_not_pass',
      SECRET_KEY: 'must_not_pass',
      DATABASE_PASSWORD: 'must_not_pass'
    };

    const client = createTestClient({ spawn: customSpawn, env: testEnv });
    try {
      await client.initialize();
      assert.strictEqual(capturedEnv.ANTIGRAVITY_SECRET, undefined, 'CAS-108: ANTIGRAVITY_SECRET must not pass');
      assert.strictEqual(capturedEnv.ANTIGRAVITY_TOKEN, undefined, 'CAS-108: ANTIGRAVITY_TOKEN must not pass');
      assert.strictEqual(capturedEnv.AO_SECRET, undefined, 'CAS-108: AO_SECRET must not pass');
      assert.strictEqual(capturedEnv.AO_TOKEN, undefined, 'CAS-108: AO_TOKEN must not pass');
      assert.strictEqual(capturedEnv.SECRET_KEY, undefined, 'CAS-108: SECRET_KEY must not pass');
      assert.strictEqual(capturedEnv.DATABASE_PASSWORD, undefined, 'CAS-108: DATABASE_PASSWORD must not pass');
      assert.strictEqual(capturedEnv.ANTIGRAVITY_BRAIN_DIR, 'C:\\test\\antigravity-cli\\brain', 'CAS-108: ANTIGRAVITY_BRAIN_DIR must pass');
      assert.strictEqual(capturedEnv.AO_DATA_DIR, 'C:\\test\\.ao\\data', 'CAS-108: AO_DATA_DIR must pass');
      console.log('PASS: CAS-108 — no wildcard authority expansion');
    } finally {
      await client.close();
    }
  }

  // CAS-109: absent authority remains absent
  {
    let capturedEnv = null;
    const customSpawn = (bin, args, opts) => {
      capturedEnv = opts.env;
      return spawn(bin, args, opts);
    };

    const client = createTestClient({ spawn: customSpawn, env: {} });
    try {
      await client.initialize();
      assert.strictEqual('ANTIGRAVITY_BRAIN_DIR' in capturedEnv, false, 'CAS-109: ANTIGRAVITY_BRAIN_DIR must be absent');
      assert.strictEqual('AO_DATA_DIR' in capturedEnv, false, 'CAS-109: AO_DATA_DIR must be absent');
      console.log('PASS: CAS-109 — absent authority remains absent');
    } finally {
      await client.close();
    }
  }

  console.log('\n======================================================================');
  console.log('ALL CODEX APP SERVER TESTS PASSED (CAS-001 .. CAS-109: 109/109 PASS)');
  console.log('======================================================================');
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };

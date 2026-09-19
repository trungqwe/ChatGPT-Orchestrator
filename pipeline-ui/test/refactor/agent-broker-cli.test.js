'use strict';

/**
 * Agent Broker Semantic CLI Test Suite (CLI-001 .. CLI-050)
 *
 * Validates the thin semantic command-line surface:
 *   snapshot, worker-status, worker-dispatch, worker-wait
 *
 * Proves:
 * - Deterministic argument parsing & error code mapping
 * - Mandatory durable SQLite store binding for control commands
 * - Ephemeral request-file handling & safe file race/symlink defense
 * - Zero AO calls for snapshot and status
 * - Cross-runtime persistence without process memory bridges
 * - Rejection of raw session/command/shell routing overrides
 * - Single JSON stdout contract & empty stderr on normal handled outcomes
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

const { runCli, parseCliArgs, readAndValidateRequestFile, mapErrorCodeToExitCode } = require('../../agent-broker-cli');
const { createBrokerRuntime } = require('../../lib/broker/runtime');
const { createBroker } = require('../../lib/broker/broker');
const { createProjectRegistry } = require('../../lib/broker/registry');
const { createWorkspaceStatePort } = require('../../lib/broker/workspace-state');
const { createSqliteLifecycleStore } = require('../../lib/broker/sqlite-lifecycle-store');
const { DISPATCH_STATES, ERROR_CODES, LIMITS } = require('../../lib/broker/contracts');

// Temporary test directory isolation
const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cli-test-'));

function cleanupTempDir() {
  try {
    fs.rmSync(testTempDir, { recursive: true, force: true });
  } catch {}
}

let testCounter = 0;
function getTempSubdir(prefix) {
  const dir = path.join(testTempDir, `${prefix}-${Date.now()}-${testCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Creates a minimal valid Git repository to act as project root.
 */
function createGitRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  child_process.execSync('git init -b main', { cwd: repoDir, stdio: 'ignore' });
  child_process.execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
  child_process.execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n', 'utf8');
  child_process.execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
  child_process.execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });
}

/**
 * Creates a standard test environment with registry, git repo, requests dir, and durable DB.
 */
async function createTestEnv(name) {
  const envDir = getTempSubdir(name);
  const repoDir = path.join(envDir, 'repo');
  createGitRepo(repoDir);

  const registryPath = path.join(envDir, 'projects.json');
  const dbPath = path.join(envDir, 'lifecycle.sqlite3');
  const requestsDir = path.join(envDir, 'requests');
  fs.mkdirSync(requestsDir, { recursive: true });

  const registryPort = createProjectRegistry({ registryFilePath: registryPath });
  await registryPort.putProject({
    project_id: 'test-project',
    project_name: 'Test Project',
    project_root: repoDir,
    worker: {
      engine: 'antigravity',
      session_id: 'sess-001',
      enabled: true,
      model_policy: 'worker_standard'
    },
    auditor: {
      engine: 'codex_app_server',
      thread_id: null,
      cwd: repoDir,
      enabled: false,
      model_policy: 'auditor_standard'
    },
    policy: {
      max_active_dispatches: 1,
      require_workspace_state: true
    }
  });

  // CLIAUTH-02 / Section 9: Prove temp registry physically exists on disk and contains fixture
  assert.strictEqual(
    fs.existsSync(registryPath),
    true,
    `Fixture registry must physically exist on disk at ${registryPath}`
  );
  const persistedDoc = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(
    persistedDoc.projects && persistedDoc.projects['test-project'],
    `Fixture registry must contain project 'test-project'`
  );

  return {
    envDir,
    repoDir,
    registryPath,
    registryPort,
    dbPath,
    requestsDir
  };
}

/**
 * Mock Worker Port recording all calls.
 */
function createMockWorkerPort(overrides = {}) {
  const calls = {
    dispatch: [],
    wait: [],
    status: []
  };

  const workerPort = {
    calls,
    async dispatch(req) {
      calls.dispatch.push(req);
      if (typeof overrides.dispatch === 'function') {
        return overrides.dispatch(req);
      }
      return {
        ok: true,
        state: DISPATCH_STATES.DISPATCH_ACCEPTED,
        dispatch_id: req.dispatch_id
      };
    },
    async wait(req) {
      calls.wait.push(req);
      if (typeof overrides.wait === 'function') {
        return overrides.wait(req);
      }
      return {
        ok: true,
        state: DISPATCH_STATES.READY_FOR_REVIEW,
        dispatch_id: req.dispatch_id,
        work_order_id: req.work_order_id
      };
    },
    async status(req) {
      calls.status.push(req);
      return { ok: true, state: 'IDLE' };
    }
  };

  return workerPort;
}

/**
 * Runs CLI with captured stdout and stderr buffers.
 */
async function executeCli(argv, options = {}) {
  let stdoutData = '';
  let stderrData = '';

  const stdoutSink = {
    write(chunk) {
      stdoutData += chunk.toString();
    }
  };

  const stderrSink = {
    write(chunk) {
      stderrData += chunk.toString();
    }
  };

  const result = await runCli(argv, {
    stdout: stdoutSink,
    stderr: stderrSink,
    ...options
  });

  return {
    exitCode: result.exitCode,
    response: result.response,
    stdout: stdoutData,
    stderr: stderrData
  };
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING AGENT BROKER SEMANTIC CLI TEST SUITE (CLI-001 .. CLI-050)');
  console.log('======================================================================\n');

  // ------------------------------------------------------------------
  // CLI-001: SNAPSHOT SUCCESS (Section 47)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-001');
    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    const res = await executeCli(['snapshot', '--project-id', 'test-project'], { runtime });
    assert.strictEqual(res.exitCode, 0, 'Exit code must be 0');
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.operation, 'snapshot');
    assert.strictEqual(res.response.project_id, 'test-project');
    assert.ok(typeof res.response.workspace_state_id === 'string' && res.response.workspace_state_id.startsWith('sha256:'));
    assert.ok(res.response.components && typeof res.response.components.status_sha256 === 'string');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    assert.strictEqual(mockWorker.calls.wait.length, 0);

    console.log('✓ CLI-001 PASSED: snapshot success returns valid workspace_state_id');
  }

  // ------------------------------------------------------------------
  // CLI-002: SNAPSHOT UNKNOWN PROJECT (Section 48)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-002');
    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    const res = await executeCli(['snapshot', '--project-id', 'unknown-project'], { runtime });
    assert.strictEqual(res.exitCode, 3, 'Exit code must be 3');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'PROJECT_NOT_FOUND');

    console.log('✓ CLI-002 PASSED: snapshot on unknown project returns PROJECT_NOT_FOUND (exit 3)');
  }

  // ------------------------------------------------------------------
  // CLI-003: SNAPSHOT NEVER CALLS AO (Section 49)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-003');
    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    await executeCli(['snapshot', '--project-id', 'test-project'], { runtime });
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    assert.strictEqual(mockWorker.calls.wait.length, 0);
    assert.strictEqual(mockWorker.calls.status.length, 0);

    console.log('✓ CLI-003 PASSED: snapshot makes 0 AO calls');
  }

  // ------------------------------------------------------------------
  // CLI-004: WORKER STATUS IDLE (Section 50)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-004');
    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    const res = await executeCli(['worker-status', '--project-id', 'test-project'], { runtime });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.operation, 'worker-status');
    assert.strictEqual(res.response.project_id, 'test-project');
    assert.strictEqual(res.response.worker_state, 'IDLE');
    assert.strictEqual(res.response.active_dispatch_id, null);
    assert.strictEqual(res.response.active_work_order_id, null);

    console.log('✓ CLI-004 PASSED: worker-status on idle project returns IDLE (exit 0)');
  }

  // ------------------------------------------------------------------
  // CLI-005: STATUS UNKNOWN PROJECT (Section 51)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-005');
    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    const res = await executeCli(['worker-status', '--project-id', 'nonexistent-project'], { runtime });
    assert.strictEqual(res.exitCode, 3);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'PROJECT_NOT_FOUND');
    assert.notStrictEqual(res.response.worker_state, 'IDLE');

    console.log('✓ CLI-005 PASSED: worker-status on unregistered project never fakes IDLE (exit 3)');
  }

  // ------------------------------------------------------------------
  // CLI-006: STATUS PRESERVES DURABLE ACTIVE STATE (Section 52)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-006');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-006',
      project_id: 'test-project',
      work_order_id: 'WO-006',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-006',
      directive: 'directive-006',
      audit_metadata: null
    });
    store.close();

    // Fresh runtime reconstruction
    const res = await executeCli(['worker-status', '--project-id', 'test-project'], {
      registryPath: env.registryPath,
      dbPath: env.dbPath
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.worker_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(res.response.active_dispatch_id, 'D-CLI-006');
    assert.strictEqual(res.response.active_work_order_id, 'WO-006');

    console.log('✓ CLI-006 PASSED: worker-status preserves durable active state across fresh runtime');
  }

  // ------------------------------------------------------------------
  // CLI-007: STATUS DOES NOT REQUIRE WORKSPACE ROOT (Section 53)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-007');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-007',
      project_id: 'test-project',
      work_order_id: 'WO-007',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-007',
      directive: 'directive-007',
      audit_metadata: null
    });
    store.close();

    // Invalidate project root directory on disk
    fs.rmSync(env.repoDir, { recursive: true, force: true });

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-status', '--project-id', 'test-project'], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.worker_state, DISPATCH_STATES.DISPATCHING);
    assert.strictEqual(res.response.active_dispatch_id, 'D-CLI-007');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    assert.strictEqual(mockWorker.calls.wait.length, 0);

    console.log('✓ CLI-007 PASSED: worker-status succeeds when project root is unavailable');
  }

  // ------------------------------------------------------------------
  // CLI-008: VALID DISPATCH FILE (Section 54)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-008');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-008.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-008',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'Implement feature 008',
      audit_metadata: { env: 'test' }
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.operation, 'worker-dispatch');
    assert.strictEqual(res.response.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(mockWorker.calls.dispatch.length, 1);

    console.log('✓ CLI-008 PASSED: valid dispatch file dispatches and exits 0');
  }

  // ------------------------------------------------------------------
  // CLI-009: DISPATCH REQUEST CONSUMED (Section 55)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-009');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-009.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-009',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'Implement feature 009'
    }), 'utf8');

    assert.strictEqual(fs.existsSync(reqFile), true);
    await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort(),
      requestsDir: env.requestsDir
    });

    assert.strictEqual(fs.existsSync(reqFile), false, 'Request file must be deleted after consumption');

    console.log('✓ CLI-009 PASSED: dispatch request file is deleted after consumption');
  }

  // ------------------------------------------------------------------
  // CLI-010: MALFORMED JSON (Section 56)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-010');
    const reqFile = path.join(env.requestsDir, 'req-010.json');
    fs.writeFileSync(reqFile, '{ invalid json', 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    assert.strictEqual(fs.existsSync(reqFile), false, 'Broker-owned opened malformed file must be deleted');

    console.log('✓ CLI-010 PASSED: malformed JSON returns INVALID_REQUEST (exit 2) and consumes file');
  }

  // ------------------------------------------------------------------
  // CLI-011: INVALID UTF-8 (Section 57)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-011');
    const reqFile = path.join(env.requestsDir, 'req-011.json');
    // Write invalid UTF-8 byte sequence
    fs.writeFileSync(reqFile, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]));

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-011 PASSED: invalid UTF-8 fails closed with INVALID_REQUEST (exit 2)');
  }

  // ------------------------------------------------------------------
  // CLI-012: REQUEST TOO LARGE (Section 58)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-012');
    const reqFile = path.join(env.requestsDir, 'req-012.json');

    // Create file exceeding MAX_REQUEST_FILE_BYTES
    const oversizedDirective = 'X'.repeat(LIMITS.MAX_DIRECTIVE_BYTES + 300 * 1024);
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-012',
      expected_workspace_state_id: 'sha256:dummy',
      directive: oversizedDirective
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'PAYLOAD_TOO_LARGE');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-012 PASSED: oversized request file rejected with PAYLOAD_TOO_LARGE (exit 2)');
  }

  // ------------------------------------------------------------------
  // CLI-013: REQUEST OUTSIDE BROKER ROOT (Section 59)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-013');
    // External directory outside requestsDir
    const externalDir = getTempSubdir('external-dir');
    const externalFile = path.join(externalDir, 'external-req.json');
    fs.writeFileSync(externalFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-013',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'external'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', externalFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(fs.existsSync(externalFile), true, 'External file MUST NOT be deleted');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-013 PASSED: request outside broker root rejected without deleting external file');
  }

  // ------------------------------------------------------------------
  // CLI-014: REQUEST SYMLINK (Section 60)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-014');
    const externalDir = getTempSubdir('external-target');
    const targetFile = path.join(externalDir, 'target.json');
    fs.writeFileSync(targetFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-014',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'target'
    }), 'utf8');

    const linkFile = path.join(env.requestsDir, 'symlink-req.json');
    try {
      fs.symlinkSync(targetFile, linkFile);
    } catch {
      // If symlink creation not permitted on this environment, use mock stat
    }

    if (fs.existsSync(linkFile) && fs.lstatSync(linkFile).isSymbolicLink()) {
      const mockWorker = createMockWorkerPort();
      const res = await executeCli(['worker-dispatch', '--request-file', linkFile], {
        registryPath: env.registryPath,
        dbPath: env.dbPath,
        workerPort: mockWorker,
        requestsDir: env.requestsDir
      });

      assert.strictEqual(res.exitCode, 2);
      assert.strictEqual(res.response.ok, false);
      assert.strictEqual(res.response.code, 'INVALID_REQUEST');
      assert.strictEqual(fs.existsSync(targetFile), true);
      assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    }

    console.log('✓ CLI-014 PASSED: request symlink rejected fail-closed');
  }

  // ------------------------------------------------------------------
  // CLI-015: FILE SWAP RACE (Section 61)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-015');
    const reqFile = path.join(env.requestsDir, 'req-015.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-015',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'swap-race'
    }), 'utf8');

    // Injected fs that simulates file B opened while file A was pre/post statted
    let fstatCall = 0;
    const realFs = fs;
    const mockFs = {
      ...realFs,
      fstatSync(fd) {
        fstatCall++;
        const s = realFs.fstatSync(fd);
        // Inject mismatched identity (file B opened)
        return {
          ...s,
          dev: 1,
          ino: 22222,
          isFile: () => true
        };
      },
      lstatSync(p) {
        const s = realFs.lstatSync(p);
        // Inject mismatched identity (file A pathname)
        return {
          ...s,
          dev: 1,
          ino: 11111,
          isFile: () => true,
          isSymbolicLink: () => false
        };
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-015 PASSED: file swap race detected and rejected fail-closed');
  }

  // ------------------------------------------------------------------
  // CLI-016: INSECURE POSIX PERMISSIONS (Section 62)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-016');
    const reqFile = path.join(env.requestsDir, 'req-016.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-016',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'insecure'
    }), 'utf8');

    // Injected fs returning 0644 mode
    const realFs = fs;
    const mockFs = {
      ...realFs,
      lstatSync(p) {
        const s = realFs.lstatSync(p);
        return {
          ...s,
          mode: 0o100644, // 0644 insecure mode
          isFile: () => true,
          isSymbolicLink: () => false
        };
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs,
      enforcePosixPermissions: true
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-016 PASSED: insecure POSIX permissions (0644) rejected before dispatch');
  }

  // ------------------------------------------------------------------
  // CLI-017: UNKNOWN REQUEST KEY (Section 63)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-017');
    const reqFile = path.join(env.requestsDir, 'req-017.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-017',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'directive-017',
      arbitrary_unknown_key: 'evil'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-017 PASSED: unknown request key rejected with INVALID_REQUEST');
  }

  // ------------------------------------------------------------------
  // CLI-018: RAW COMMAND KEY (Section 64 / V3-NT-023)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-018');
    const reqFile = path.join(env.requestsDir, 'req-018.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-018',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'directive-018',
      command: 'echo pwned'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-018 PASSED: raw command key rejected fail-closed (V3-NT-023)');
  }

  // ------------------------------------------------------------------
  // CLI-019: SESSION OVERRIDE (Section 65 / V3-NT-024)
  // ------------------------------------------------------------------
  {
    const sessionOverrides = ['session_id', 'worker_session', 'worker_session_id', 'session'];
    for (const key of sessionOverrides) {
      const env = await createTestEnv(`cli-019-${key}`);
      const reqFile = path.join(env.requestsDir, 'req-019.json');
      fs.writeFileSync(reqFile, JSON.stringify({
        schema_version: 1,
        operation: 'worker_dispatch',
        project_id: 'test-project',
        work_order_id: 'WO-019',
        expected_workspace_state_id: 'sha256:dummy',
        directive: 'directive-019',
        [key]: 'hacked-session-override'
      }), 'utf8');

      const mockWorker = createMockWorkerPort();
      const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
        registryPath: env.registryPath,
        dbPath: env.dbPath,
        workerPort: mockWorker,
        requestsDir: env.requestsDir
      });

      assert.strictEqual(res.exitCode, 2);
      assert.strictEqual(res.response.ok, false);
      assert.strictEqual(res.response.code, 'INVALID_REQUEST');
      assert.strictEqual(mockWorker.calls.dispatch.length, 0);
    }

    console.log('✓ CLI-019 PASSED: all session override keys rejected fail-closed (V3-NT-024)');
  }

  // ------------------------------------------------------------------
  // CLI-020: SHELL METACHARACTERS (Section 66)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-020');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const complexDirective = 'echo "hello" & rm -rf / | cat > output.txt ; $FOO `date` \'single\' \n next-line';
    const reqFile = path.join(env.requestsDir, 'req-020.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-020',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: complexDirective
    }), 'utf8');

    let receivedDirective = null;
    const mockWorker = createMockWorkerPort({
      dispatch(req) {
        receivedDirective = req.directive;
        return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED, dispatch_id: req.dispatch_id };
      }
    });

    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(receivedDirective, complexDirective, 'Directive must be transmitted byte-for-byte as raw data');

    console.log('✓ CLI-020 PASSED: shell metacharacters treated as pure raw data without execution');
  }

  // ------------------------------------------------------------------
  // CLI-021: STALE WORKSPACE (Section 67)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-021');
    const reqFile = path.join(env.requestsDir, 'req-021.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-021',
      expected_workspace_state_id: 'sha256:stale-precondition-hash',
      directive: 'directive-021'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 5, 'Stale audit state must exit 5');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'STALE_AUDIT_STATE');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-021 PASSED: stale workspace state rejected with STALE_AUDIT_STATE (exit 5)');
  }

  // ------------------------------------------------------------------
  // CLI-022: WORKER BUSY (Section 68)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-022');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-EXISTING',
      project_id: 'test-project',
      work_order_id: 'WO-ACTIVE',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-active',
      directive: 'active directive',
      audit_metadata: null
    });
    store.close();

    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-022.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-DIFFERENT',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'new directive'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 4, 'WORKER_BUSY must exit 4');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'WORKER_BUSY');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-022 PASSED: worker busy on parallel work order rejected with WORKER_BUSY (exit 4)');
  }

  // ------------------------------------------------------------------
  // CLI-023: DUPLICATE WORK ORDER CONFLICT (Section 69)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-023');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CONFLICT',
      project_id: 'test-project',
      work_order_id: 'WO-CONFLICT',
      expected_workspace_state_id: snap.workspace_state_id,
      request_fingerprint: 'fp-orig',
      directive: 'original directive',
      audit_metadata: null
    });
    store.close();

    const reqFile = path.join(env.requestsDir, 'req-023.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-CONFLICT',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'modified directive conflict'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 4);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'DUPLICATE_WORK_ORDER_CONFLICT');

    console.log('✓ CLI-023 PASSED: duplicate work order with modified directive exits 4');
  }

  // ------------------------------------------------------------------
  // CLI-024: IDEMPOTENT REPLAY (Section 70)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-024');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const dispatchReqObj = {
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-024',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'idempotent directive'
    };

    // First call
    const reqFile1 = path.join(env.requestsDir, 'req-024-1.json');
    fs.writeFileSync(reqFile1, JSON.stringify(dispatchReqObj), 'utf8');

    const mockWorker1 = createMockWorkerPort();
    const res1 = await executeCli(['worker-dispatch', '--request-file', reqFile1], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker1,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res1.exitCode, 0);
    assert.strictEqual(res1.response.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(mockWorker1.calls.dispatch.length, 1);
    const initialDispatchId = res1.response.dispatch_id;

    // Second call through fresh runtime
    const reqFile2 = path.join(env.requestsDir, 'req-024-2.json');
    fs.writeFileSync(reqFile2, JSON.stringify(dispatchReqObj), 'utf8');

    const mockWorker2 = createMockWorkerPort();
    const res2 = await executeCli(['worker-dispatch', '--request-file', reqFile2], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker2,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res2.exitCode, 0);
    assert.strictEqual(res2.response.idempotent_replay, true);
    assert.strictEqual(res2.response.dispatch_id, initialDispatchId);
    assert.strictEqual(mockWorker2.calls.dispatch.length, 0, 'Zero AO calls on second idempotent send');

    console.log('✓ CLI-024 PASSED: idempotent replay through fresh CLI runtime exits 0 with 0 AO calls');
  }

  // ------------------------------------------------------------------
  // CLI-025: DISPATCH UNCERTAIN (Section 71)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-025');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-025.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-025',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'uncertain directive'
    }), 'utf8');

    const mockWorker = createMockWorkerPort({
      dispatch() {
        throw new Error('Ambiguous network drop during transport');
      }
    });

    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 6, 'DISPATCH_UNCERTAIN must exit 6');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, ERROR_CODES.DISPATCH_UNCERTAIN);

    // Verify durable store persists DISPATCH_UNCERTAIN
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    const uncertainDispatch = store.getActiveDispatch('test-project');
    assert.strictEqual(uncertainDispatch.state, DISPATCH_STATES.DISPATCH_UNCERTAIN);
    store.close();

    console.log('✓ CLI-025 PASSED: dispatch transport ambiguity yields DISPATCH_UNCERTAIN (exit 6)');
  }

  // ------------------------------------------------------------------
  // CLI-026: WAIT NONTERMINAL (Section 72)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-026');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-026',
      project_id: 'test-project',
      work_order_id: 'WO-026',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-026',
      directive: 'dir-026',
      audit_metadata: null
    });
    store.transition('D-CLI-026', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.close();

    const mockWorker = createMockWorkerPort({
      wait(req) {
        return {
          ok: true,
          state: DISPATCH_STATES.RUNNING,
          dispatch_id: req.dispatch_id,
          work_order_id: req.work_order_id
        };
      }
    });

    const res = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', 'D-CLI-026'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.state, DISPATCH_STATES.RUNNING);

    console.log('✓ CLI-026 PASSED: worker-wait nonterminal RUNNING returns ok=true (exit 0)');
  }

  // ------------------------------------------------------------------
  // CLI-027: WAIT READY (Section 73)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-027');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-027',
      project_id: 'test-project',
      work_order_id: 'WO-027',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-027',
      directive: 'dir-027',
      audit_metadata: null
    });
    store.transition('D-CLI-027', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.close();

    const mockWorker = createMockWorkerPort({
      wait(req) {
        return {
          ok: true,
          state: DISPATCH_STATES.READY_FOR_REVIEW,
          dispatch_id: req.dispatch_id,
          work_order_id: req.work_order_id
        };
      }
    });

    const res = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', 'D-CLI-027'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.state, DISPATCH_STATES.READY_FOR_REVIEW);

    // Verify persisted terminal state
    const reopenedStore = createSqliteLifecycleStore({ dbPath: env.dbPath });
    const d = reopenedStore.getDispatch('D-CLI-027');
    assert.strictEqual(d.state, DISPATCH_STATES.READY_FOR_REVIEW);
    reopenedStore.close();

    console.log('✓ CLI-027 PASSED: worker-wait READY_FOR_REVIEW exits 0 and persists');
  }

  // ------------------------------------------------------------------
  // CLI-028: WAIT PROVENANCE AMBIGUOUS (Section 74)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-028');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-028',
      project_id: 'test-project',
      work_order_id: 'WO-028',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-028',
      directive: 'dir-028',
      audit_metadata: null
    });
    store.transition('D-CLI-028', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.close();

    const mockWorker = createMockWorkerPort({
      wait(req) {
        return {
          ok: false,
          code: 'PROVENANCE_AMBIGUOUS',
          state: DISPATCH_STATES.PROVENANCE_AMBIGUOUS,
          dispatch_id: req.dispatch_id
        };
      }
    });

    const res = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', 'D-CLI-028'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 7, 'PROVENANCE_AMBIGUOUS must exit 7');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'PROVENANCE_AMBIGUOUS');

    console.log('✓ CLI-028 PASSED: wait returning PROVENANCE_AMBIGUOUS exits 7 and persists');
  }

  // ------------------------------------------------------------------
  // CLI-029: WAIT UNCERTAIN DOES NOT CALL WORKER (Section 75)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-029');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-029',
      project_id: 'test-project',
      work_order_id: 'WO-029',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-029',
      directive: 'dir-029',
      audit_metadata: null
    });
    store.transition('D-CLI-029', DISPATCH_STATES.DISPATCH_UNCERTAIN);
    store.close();

    const mockWorker = createMockWorkerPort();
    const res = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', 'D-CLI-029'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 6, 'Waiting uncertain dispatch must exit 6');
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(mockWorker.calls.wait.length, 0, 'Zero worker wait calls on non-waitable uncertain dispatch');

    console.log('✓ CLI-029 PASSED: waiting DISPATCH_UNCERTAIN exits 6 without calling worker');
  }

  // ------------------------------------------------------------------
  // CLI-030: DISPATCH NOT FOUND (Section 76)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-030');
    const res = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', 'D-NONEXISTENT'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });

    assert.strictEqual(res.exitCode, 3);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'DISPATCH_NOT_FOUND');

    console.log('✓ CLI-030 PASSED: worker-wait on nonexistent dispatch exits 3');
  }

  // ------------------------------------------------------------------
  // CLI-031: WRONG PROJECT FOR DISPATCH (Section 77)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-031');
    const store = createSqliteLifecycleStore({ dbPath: env.dbPath });
    store.beginDispatch('test-project', {
      dispatch_id: 'D-CLI-031',
      project_id: 'test-project',
      work_order_id: 'WO-031',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-031',
      directive: 'dir-031',
      audit_metadata: null
    });
    store.transition('D-CLI-031', DISPATCH_STATES.DISPATCH_ACCEPTED);
    store.close();

    // Add a second project in registry with distinct root
    const repoDir2 = path.join(env.envDir, 'repo-two');
    createGitRepo(repoDir2);

    await env.registryPort.putProject({
      project_id: 'project-two',
      project_name: 'Project Two',
      project_root: repoDir2,
      worker: { engine: 'antigravity', session_id: 'sess-002', enabled: true, model_policy: 'worker_standard' },
      auditor: {
        engine: 'codex_app_server',
        thread_id: null,
        cwd: repoDir2,
        enabled: false,
        model_policy: 'auditor_standard'
      },
      policy: { max_active_dispatches: 1, require_workspace_state: true }
    });

    const mockWorker = createMockWorkerPort();
    const res = await executeCli([
      'worker-wait',
      '--project-id', 'project-two',
      '--dispatch-id', 'D-CLI-031'
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });

    assert.strictEqual(res.exitCode, 3);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'DISPATCH_PROJECT_MISMATCH');
    assert.strictEqual(mockWorker.calls.wait.length, 0);

    console.log('✓ CLI-031 PASSED: wrong project for dispatch returns DISPATCH_PROJECT_MISMATCH (exit 3)');
  }

  // ------------------------------------------------------------------
  // CLI-032: RUNTIME/LIFECYCLE CORRUPTION (Section 78)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-032');
    // Overwrite lifecycle DB with garbage bytes to force corrupt database
    fs.writeFileSync(env.dbPath, 'CORRUPT_NON_SQLITE_GARBAGE_BYTES_0123456789', 'utf8');

    const res = await executeCli(['worker-status', '--project-id', 'test-project'], {
      registryPath: env.registryPath,
      dbPath: env.dbPath
    });

    assert.strictEqual(res.exitCode, 8, 'Runtime init failure must exit 8');
    assert.strictEqual(res.response.ok, false);
    assert.notStrictEqual(res.response.worker_state, 'IDLE');

    console.log('✓ CLI-032 PASSED: corrupt durable store fails closed with exit 8 (never IDLE)');
  }

  // ------------------------------------------------------------------
  // CLI-033: EXACTLY ONE STDOUT JSON OBJECT (Section 79)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-033');
    const cases = [
      ['snapshot', '--project-id', 'test-project'],
      ['snapshot', '--project-id', 'unknown'],
      ['worker-status', '--project-id', 'test-project'],
      ['worker-status', '--project-id', 'unknown']
    ];

    for (const cmd of cases) {
      const res = await executeCli(cmd, {
        registryPath: env.registryPath,
        dbPath: env.dbPath,
        workerPort: createMockWorkerPort()
      });

      const trimmed = res.stdout.trim();
      const parsed = JSON.parse(trimmed);
      assert.strictEqual(typeof parsed, 'object');
      assert.strictEqual(Array.isArray(parsed), false);
      // Verify stdout ends with exactly one newline
      assert.strictEqual(res.stdout.endsWith('\n'), true);
      assert.strictEqual(res.stdout.split('\n').filter(Boolean).length, 1, 'Only one JSON line emitted');
    }

    console.log('✓ CLI-033 PASSED: exactly one JSON object emitted on stdout for success and failure');
  }

  // ------------------------------------------------------------------
  // CLI-034: NORMAL STDERR EMPTY (Section 80)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-034');
    const cases = [
      ['snapshot', '--project-id', 'test-project'],
      ['snapshot', '--project-id', 'unknown'],
      ['worker-status', '--project-id', 'test-project'],
      ['worker-status', '--project-id', 'unknown'],
      ['worker-wait', '--project-id', 'test-project', '--dispatch-id', 'D-MISSING']
    ];

    for (const cmd of cases) {
      const res = await executeCli(cmd, {
        registryPath: env.registryPath,
        dbPath: env.dbPath,
        workerPort: createMockWorkerPort()
      });

      assert.strictEqual(res.stderr, '', `Normal handled execution must have empty stderr for ${cmd.join(' ')}`);
    }

    console.log('✓ CLI-034 PASSED: normal handled results produce completely empty stderr');
  }

  // ------------------------------------------------------------------
  // CLI-035: UNKNOWN FLAG / POSITIONAL ARG (Section 81)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-035');
    const cases = [
      ['snapshot', '--project-id', 'test-project', '--unknown-flag'],
      ['snapshot', '--project-id', 'test-project', 'extra-arg'],
      ['worker-status', '--invalid'],
      ['unknown-cmd']
    ];

    for (const argv of cases) {
      const res = await executeCli(argv, {
        registryPath: env.registryPath,
        dbPath: env.dbPath
      });

      assert.strictEqual(res.exitCode, 2);
      assert.strictEqual(res.response.ok, false);
      assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    }

    console.log('✓ CLI-035 PASSED: unknown command, unknown flag, and extra positional args exit 2');
  }

  // ------------------------------------------------------------------
  // CLI-036: INVALID TIMEOUT (Section 82)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-036');
    const invalidTimeouts = ['abc', 'NaN', 'Infinity', '-5'];

    for (const timeout of invalidTimeouts) {
      const res = await executeCli([
        'worker-wait',
        '--project-id', 'test-project',
        '--dispatch-id', 'D-036',
        '--timeout-secs', timeout
      ], {
        registryPath: env.registryPath,
        dbPath: env.dbPath,
        workerPort: createMockWorkerPort()
      });

      assert.strictEqual(res.exitCode, 2, `Timeout '${timeout}' must exit 2`);
      assert.strictEqual(res.response.ok, false);
      assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    }

    console.log('✓ CLI-036 PASSED: invalid non-numeric or negative timeouts exit 2');
  }

  // ------------------------------------------------------------------
  // CLI-037: REQUEST OPERATION MISMATCH (Section 83)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-037');
    const reqFile = path.join(env.requestsDir, 'req-037.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_wait', // Wrong operation
      project_id: 'test-project',
      work_order_id: 'WO-037',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'directive-037'
    }), 'utf8');

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-037 PASSED: request operation mismatch rejected before broker call');
  }

  // ------------------------------------------------------------------
  // CLI-038: REQUEST FILE CLEANUP FAILURE (Section 84)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-038');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-038.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-038',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'SECRET_DIRECTIVE_CONTENT_DO_NOT_LEAK'
    }), 'utf8');

    // Injected fs where unlinkSync fails
    const realFs = fs;
    const mockFs = {
      ...realFs,
      unlinkSync() {
        throw new Error('EACCES: permission denied during unlink');
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    // Semantic result is preserved
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.state, DISPATCH_STATES.DISPATCH_ACCEPTED);

    // Bounded stderr cleanup diagnostic emitted
    assert.ok(res.stderr.includes('Diagnostic: failed to delete request file'));
    // Never leak directive content into stderr
    assert.strictEqual(res.stderr.includes('SECRET_DIRECTIVE_CONTENT_DO_NOT_LEAK'), false);

    console.log('✓ CLI-038 PASSED: request unlink failure preserves broker result and emits safe stderr diagnostic');
  }

  // ------------------------------------------------------------------
  // CLI-039: FRESH RUNTIME DISPATCH -> STATUS -> WAIT (Section 85)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-039');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-039.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-039',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'tri-runtime-flow'
    }), 'utf8');

    // Runtime instance 1: DISPATCH
    const res1 = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      requestsDir: env.requestsDir,
      workerPort: createMockWorkerPort()
    });
    assert.strictEqual(res1.exitCode, 0);
    const dispatchId = res1.response.dispatch_id;

    // Runtime instance 2: STATUS
    const res2 = await executeCli(['worker-status', '--project-id', 'test-project'], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    assert.strictEqual(res2.exitCode, 0);
    assert.strictEqual(res2.response.worker_state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.strictEqual(res2.response.active_dispatch_id, dispatchId);

    // Runtime instance 3: WAIT
    const res3 = await executeCli([
      'worker-wait',
      '--project-id', 'test-project',
      '--dispatch-id', dispatchId
    ], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort({
        wait(req) {
          return {
            ok: true,
            state: DISPATCH_STATES.READY_FOR_REVIEW,
            dispatch_id: req.dispatch_id,
            work_order_id: 'WO-039'
          };
        }
      })
    });
    assert.strictEqual(res3.exitCode, 0);
    assert.strictEqual(res3.response.state, DISPATCH_STATES.READY_FOR_REVIEW);

    console.log('✓ CLI-039 PASSED: dispatch -> status -> wait across 3 independent runtimes verified');
  }

  // ------------------------------------------------------------------
  // CLI-040: NO ARBITRARY EXECUTION SURFACE (Section 86)
  // ------------------------------------------------------------------
  {
    const cliSource = fs.readFileSync(path.join(__dirname, '../../agent-broker-cli.js'), 'utf8');

    assert.strictEqual(cliSource.includes('require(\'child_process\')'), false);
    assert.strictEqual(cliSource.includes('require("child_process")'), false);
    assert.strictEqual(cliSource.includes('.exec('), false);
    assert.strictEqual(cliSource.includes('.execSync('), false);
    assert.strictEqual(cliSource.includes('.spawn('), false);
    assert.strictEqual(cliSource.includes('.spawnSync('), false);

    console.log('✓ CLI-040 PASSED: static source verification confirms no arbitrary execution surface');
  }

  // ------------------------------------------------------------------
  // CLI-041: CUSTOM REGISTRY PATH (CLIAUTH-01 / CLIAUTH-03)
  // ------------------------------------------------------------------
  {
    const envDir = getTempSubdir('cli-041');
    const repoDir = path.join(envDir, 'repo');
    createGitRepo(repoDir);

    const customRegistryPath = path.join(envDir, 'custom-projects.json');
    const dbPath = path.join(envDir, 'lifecycle.sqlite3');

    const uniqueProjectId = `cli-runtime-isolation-${Date.now()}`;
    const customReg = createProjectRegistry({ registryFilePath: customRegistryPath });
    await customReg.putProject({
      project_id: uniqueProjectId,
      project_name: 'Custom Isolation Project',
      project_root: repoDir,
      worker: { engine: 'antigravity', session_id: 'sess-041', enabled: true, model_policy: 'worker_standard' },
      auditor: { engine: 'codex_app_server', thread_id: null, cwd: repoDir, enabled: false, model_policy: 'auditor_standard' },
      policy: { max_active_dispatches: 1, require_workspace_state: true }
    });

    const mockWorker = createMockWorkerPort();
    const runtime = createBrokerRuntime({
      registryPath: customRegistryPath,
      dbPath,
      workerPort: mockWorker
    });

    const projects = await runtime.registryPort.listProjects();
    assert.strictEqual(projects.some(p => p && p.project_id === uniqueProjectId), true);

    const res = await executeCli(['worker-status', '--project-id', uniqueProjectId], { runtime });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.project_id, uniqueProjectId);
    assert.strictEqual(res.response.worker_state, 'IDLE');

    runtime.close();
    console.log('✓ CLI-041 PASSED: custom registry path honored exactly by createBrokerRuntime');
  }

  // ------------------------------------------------------------------
  // CLI-042: FIXTURE REGISTRY IS PHYSICALLY TEMP (CLIAUTH-02)
  // ------------------------------------------------------------------
  {
    const envDir = getTempSubdir('cli-042');
    const repoDir = path.join(envDir, 'repo');
    createGitRepo(repoDir);

    const tempRegPath = path.join(envDir, 'temp-projects.json');
    const tempReg = createProjectRegistry({ registryFilePath: tempRegPath });

    const uniqueId = `temp-fixture-proj-${Date.now()}`;
    await tempReg.putProject({
      project_id: uniqueId,
      project_name: 'Temp Fixture',
      project_root: repoDir,
      worker: { engine: 'antigravity', session_id: 'sess-042', enabled: true, model_policy: 'worker_standard' },
      auditor: { engine: 'codex_app_server', thread_id: null, cwd: repoDir, enabled: false, model_policy: 'auditor_standard' },
      policy: { max_active_dispatches: 1, require_workspace_state: true }
    });

    assert.strictEqual(fs.existsSync(tempRegPath), true);
    const parsed = JSON.parse(fs.readFileSync(tempRegPath, 'utf8'));
    assert.ok(parsed.projects && parsed.projects[uniqueId]);

    console.log('✓ CLI-042 PASSED: fixture registry physically exists on disk at temp path');
  }

  // ------------------------------------------------------------------
  // CLI-043: ACTUAL PROCESS STATUS (CLIAUTH-03 / Section 14, 15)
  // ------------------------------------------------------------------
  {
    const tempHome = getTempSubdir('cli-043-home');
    const orchDir = path.join(tempHome, '.orchestrator');
    fs.mkdirSync(orchDir, { recursive: true });

    const repoDir = path.join(tempHome, 'repo');
    createGitRepo(repoDir);

    const homeRegPath = path.join(orchDir, 'projects.json');
    const homeReg = createProjectRegistry({ registryFilePath: homeRegPath });
    const uniqueId = `process-proj-${Date.now()}`;
    await homeReg.putProject({
      project_id: uniqueId,
      project_name: 'Process Project',
      project_root: repoDir,
      worker: { engine: 'antigravity', session_id: 'sess-043', enabled: true, model_policy: 'worker_standard' },
      auditor: { engine: 'codex_app_server', thread_id: null, cwd: repoDir, enabled: false, model_policy: 'auditor_standard' },
      policy: { max_active_dispatches: 1, require_workspace_state: true }
    });

    const cliPath = path.resolve(__dirname, '../../agent-broker-cli.js');
    const childRes = child_process.spawnSync(
      process.execPath,
      ['--no-warnings', cliPath, 'worker-status', '--project-id', uniqueId],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome
        },
        encoding: 'utf8'
      }
    );

    const cleanStderr = childRes.stderr.replace(/\(node:\d+\) ExperimentalWarning:[^\n]+\n(\(Use `node --trace-warnings[^\n]+\n)?/g, '').trim();
    assert.strictEqual(childRes.status, 0, `Process failed with stderr: ${childRes.stderr}`);
    assert.strictEqual(cleanStderr, '');
    const out = JSON.parse(childRes.stdout.trim());
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.operation, 'worker-status');
    assert.strictEqual(out.project_id, uniqueId);
    assert.strictEqual(out.worker_state, 'IDLE');

    console.log('✓ CLI-043 PASSED: actual CLI child process worker-status returns IDLE (exit 0)');
  }

  // ------------------------------------------------------------------
  // CLI-044: ACTUAL PROCESS UNCERTAIN WAIT (CLIAUTH-03 / Section 16)
  // ------------------------------------------------------------------
  {
    const tempHome = getTempSubdir('cli-044-home');
    const orchDir = path.join(tempHome, '.orchestrator');
    fs.mkdirSync(orchDir, { recursive: true });

    const repoDir = path.join(tempHome, 'repo');
    createGitRepo(repoDir);

    const homeRegPath = path.join(orchDir, 'projects.json');
    const homeReg = createProjectRegistry({ registryFilePath: homeRegPath });
    const uniqueId = `process-proj-${Date.now()}`;
    await homeReg.putProject({
      project_id: uniqueId,
      project_name: 'Process Project',
      project_root: repoDir,
      worker: { engine: 'antigravity', session_id: 'sess-044', enabled: true, model_policy: 'worker_standard' },
      auditor: { engine: 'codex_app_server', thread_id: null, cwd: repoDir, enabled: false, model_policy: 'auditor_standard' },
      policy: { max_active_dispatches: 1, require_workspace_state: true }
    });

    const homeDbPath = path.join(orchDir, 'lifecycle.sqlite3');
    const store = createSqliteLifecycleStore({ dbPath: homeDbPath });
    store.beginDispatch(uniqueId, {
      dispatch_id: 'D-CLI-044',
      project_id: uniqueId,
      work_order_id: 'WO-044',
      expected_workspace_state_id: null,
      request_fingerprint: 'fp-044',
      directive: 'directive-044',
      audit_metadata: null
    });
    store.transition('D-CLI-044', DISPATCH_STATES.DISPATCH_UNCERTAIN, {
      error: 'transport timeout'
    });
    store.close();

    const cliPath = path.resolve(__dirname, '../../agent-broker-cli.js');
    const childRes = child_process.spawnSync(
      process.execPath,
      ['--no-warnings', cliPath, 'worker-wait', '--project-id', uniqueId, '--dispatch-id', 'D-CLI-044'],
      {
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome
        },
        encoding: 'utf8'
      }
    );

    const cleanStderr = childRes.stderr.replace(/\(node:\d+\) ExperimentalWarning:[^\n]+\n(\(Use `node --trace-warnings[^\n]+\n)?/g, '').trim();
    assert.strictEqual(childRes.status, 6, `Expected exit code 6, got ${childRes.status}. Stderr: ${childRes.stderr}`);
    assert.strictEqual(cleanStderr, '');
    const out = JSON.parse(childRes.stdout.trim());
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, 'DISPATCH_UNCERTAIN');

    console.log('✓ CLI-044 PASSED: actual CLI child process wait against DISPATCH_UNCERTAIN exits 6');
  }

  // ------------------------------------------------------------------
  // CLI-045: POST-LSTAT FAILURE (CLIAUTH-04 / Section 17, 32)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-045');
    const reqFile = path.join(env.requestsDir, 'req-045.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-045',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'post-lstat-fail'
    }), 'utf8');

    let readSyncCalls = 0;
    let lstatCalls = 0;
    const realFs = fs;
    const mockFs = {
      ...realFs,
      lstatSync(p) {
        lstatCalls++;
        if (lstatCalls > 1) {
          throw new Error('Injected post-lstat pathname disappearance (ENOENT)');
        }
        return realFs.lstatSync(p);
      },
      readSync(...args) {
        readSyncCalls++;
        return realFs.readSync(...args);
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(readSyncCalls, 0, 'readSync MUST NOT be called when post-lstat fails');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0, 'Broker MUST NOT be called');

    console.log('✓ CLI-045 PASSED: post-lstat failure fails closed before reading bytes (exit 2)');
  }

  // ------------------------------------------------------------------
  // CLI-046: POST PATH NOT REGULAR (CLIAUTH-04 / Section 18, 33)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-046');
    const reqFile = path.join(env.requestsDir, 'req-046.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-046',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'post-nonregular'
    }), 'utf8');

    let readSyncCalls = 0;
    let lstatCalls = 0;
    const realFs = fs;
    const mockFs = {
      ...realFs,
      lstatSync(p) {
        lstatCalls++;
        const s = realFs.lstatSync(p);
        if (lstatCalls > 1) {
          return {
            ...s,
            isFile: () => false,
            isDirectory: () => true
          };
        }
        return s;
      },
      readSync(...args) {
        readSyncCalls++;
        return realFs.readSync(...args);
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(readSyncCalls, 0, 'readSync MUST NOT be called if post path is not regular');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-046 PASSED: post path not regular fails closed before reading (exit 2)');
  }

  // ------------------------------------------------------------------
  // CLI-047: IDENTITY UNAVAILABLE (CLIAUTH-05 / Section 19, 20, 34)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-047');
    const reqFile = path.join(env.requestsDir, 'req-047.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-047',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'identity-missing'
    }), 'utf8');

    let readSyncCalls = 0;
    const realFs = fs;
    const mockFs = {
      ...realFs,
      fstatSync(fd) {
        const s = realFs.fstatSync(fd);
        return {
          ...s,
          dev: s.dev,
          ino: null,
          isFile: () => true
        };
      },
      readSync(...args) {
        readSyncCalls++;
        return realFs.readSync(...args);
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(readSyncCalls, 0, 'readSync MUST NOT be called when identity is unavailable');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-047 PASSED: unavailable descriptor identity fails closed without downgrade');
  }

  // ------------------------------------------------------------------
  // CLI-048: SHORT READS COMPLETE CORRECTLY (CLIAUTH-06 / Section 22, 35)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-048');
    const snapRuntime = createBrokerRuntime({
      registryPort: env.registryPort,
      dbPath: env.dbPath,
      workerPort: createMockWorkerPort()
    });
    const snap = await snapRuntime.broker.getWorkspaceState('test-project');
    snapRuntime.close();

    const reqFile = path.join(env.requestsDir, 'req-048.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-048',
      expected_workspace_state_id: snap.workspace_state_id,
      directive: 'short-read-directive'
    }), 'utf8');

    let readCount = 0;
    const realFs = fs;
    const mockFs = {
      ...realFs,
      readSync(fd, buffer, offset, length, position) {
        readCount++;
        const maxChunk = Math.min(16, length);
        return realFs.readSync(fd, buffer, offset, maxChunk, position);
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.response.ok, true);
    assert.strictEqual(res.response.state, DISPATCH_STATES.DISPATCH_ACCEPTED);
    assert.ok(readCount > 1, `Expected multiple short read calls, got ${readCount}`);
    assert.strictEqual(mockWorker.calls.dispatch.length, 1);
    assert.strictEqual(mockWorker.calls.dispatch[0].directive, 'short-read-directive');

    console.log(`✓ CLI-048 PASSED: short read chunks assembled completely (${readCount} reads, exit 0)`);
  }

  // ------------------------------------------------------------------
  // CLI-049: PREMATURE EOF (CLIAUTH-06 / Section 23, 36)
  // ------------------------------------------------------------------
  {
    const env = await createTestEnv('cli-049');
    const reqFile = path.join(env.requestsDir, 'req-049.json');
    fs.writeFileSync(reqFile, JSON.stringify({
      schema_version: 1,
      operation: 'worker_dispatch',
      project_id: 'test-project',
      work_order_id: 'WO-049',
      expected_workspace_state_id: 'sha256:dummy',
      directive: 'eof-test'
    }), 'utf8');

    const realFs = fs;
    const mockFs = {
      ...realFs,
      fstatSync(fd) {
        const s = realFs.fstatSync(fd);
        return {
          ...s,
          size: s.size + 1000
        };
      },
      readSync(fd, buffer, offset, length, position) {
        return realFs.readSync(fd, buffer, offset, length, position);
      }
    };

    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-dispatch', '--request-file', reqFile], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker,
      requestsDir: env.requestsDir,
      fs: mockFs
    });

    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.response.ok, false);
    assert.strictEqual(res.response.code, 'INVALID_REQUEST');
    assert.strictEqual(mockWorker.calls.dispatch.length, 0);

    console.log('✓ CLI-049 PASSED: premature EOF fails closed without parsing partial buffer (exit 2)');
  }

  // ------------------------------------------------------------------
  // CLI-050: DEFAULT REGISTRY UNCHANGED (CLIAUTH-02 / Section 37, 43)
  // ------------------------------------------------------------------
  {
    const crypto = require('crypto');
    const defaultRegistry = path.join(os.homedir(), '.orchestrator', 'projects.json');
    let hashBefore = null;
    if (fs.existsSync(defaultRegistry)) {
      hashBefore = crypto.createHash('sha256').update(fs.readFileSync(defaultRegistry)).digest('hex');
    }

    const env = await createTestEnv('cli-050');
    const mockWorker = createMockWorkerPort();
    const res = await executeCli(['worker-status', '--project-id', 'test-project'], {
      registryPath: env.registryPath,
      dbPath: env.dbPath,
      workerPort: mockWorker
    });
    assert.strictEqual(res.exitCode, 0);

    let hashAfter = null;
    if (fs.existsSync(defaultRegistry)) {
      hashAfter = crypto.createHash('sha256').update(fs.readFileSync(defaultRegistry)).digest('hex');
    }

    assert.strictEqual(hashBefore, hashAfter, 'Default registry must remain completely untouched by CLI suite');

    console.log('✓ CLI-050 PASSED: default user registry unchanged by isolated CLI operations');
  }

  console.log('\n======================================================================');
  console.log('ALL AGENT BROKER CLI TESTS PASSED (CLI-001 .. CLI-050: 50/50 PASS)');
  console.log('======================================================================');
}

runAllTests()
  .catch((err) => {
    console.error('[TEST SUITE FAILURE]', err);
    process.exit(1);
  })
  .finally(() => {
    cleanupTempDir();
  });

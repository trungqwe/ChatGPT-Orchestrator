'use strict';

/**
 * Registry Unit, Negative, Concurrency & Integration Test Suite (RG-001 .. RG-032)
 *
 * Validates the concrete persistent project/session/auditor registry against
 * all requirements in WO-V3-003 and the Human Plan Review Addendum.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  REGISTRY_ERROR_CODES,
  RegistryError,
  computeRootIdentityKey,
  validateProjectRootShape,
  canonicalizeProjectRoot,
  createProjectRegistry
} = require('../../lib/broker/registry');
const { createBroker } = require('../../lib/broker/broker');
const { DISPATCH_STATES, ERROR_CODES } = require('../../lib/broker/contracts');

// Helper to create a temporary test sandbox directory
function createTestSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

// Helper to generate a valid base project descriptor
function makeValidProject(id, rootPath, overrides = {}) {
  return {
    project_id: id,
    project_name: overrides.project_name || `Project ${id}`,
    project_root: rootPath,
    worker: {
      engine: 'antigravity',
      session_id: `session-${id}-01`,
      enabled: true,
      ...(overrides.worker || {})
    },
    auditor: {
      engine: 'codex',
      task_id: `task-${id}-01`,
      task_id_verified: false,
      expected_model_label: 'ChatGPT Web — GPT-5.6 Sol High',
      mode: 'full-harness',
      managed_by_orchestrator: false,
      ...(overrides.auditor || {})
    },
    policy: {
      max_active_dispatches: 1,
      require_workspace_state: true,
      ...(overrides.policy || {})
    }
  };
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING REGISTRY TEST SUITE (RG-001 .. RG-039)');
  console.log('======================================================================\n');

  // RG-001: Empty / nonexistent registry file
  {
    console.log('[RG-001] Nonexistent registry file returns empty valid schema without default projects...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      const projects = await registry.listProjects();
      assert.strictEqual(projects.length, 0);

      const validated = registry.validate();
      assert.strictEqual(validated.schema_version, 1);
      assert.deepStrictEqual(validated.projects, {});

      // No default projects guessed
      const orch = await registry.getProject('orchestrator');
      assert.strictEqual(orch, null);
      const calc = await registry.getProject('calc-engine');
      assert.strictEqual(calc, null);

      console.log('✓ RG-001 PASSED: Nonexistent registry defaults cleanly to empty schema.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-002: Valid record persists and reloads identically
  {
    console.log('[RG-002] Valid record persists and reloads identically in semantic fields...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'my-project');
      fs.mkdirSync(projDir, { recursive: true });

      const registry1 = createProjectRegistry({ registryFilePath: regFile });
      const record = makeValidProject('my-project', projDir);
      const saved = await registry1.putProject(record);

      assert.strictEqual(saved.project_id, 'my-project');
      assert.strictEqual(saved.worker.session_id, 'session-my-project-01');

      // Reload in fresh registry instance from disk
      const registry2 = createProjectRegistry({ registryFilePath: regFile });
      const loaded = await registry2.getProject('my-project');
      assert.ok(loaded);
      assert.strictEqual(loaded.project_id, 'my-project');
      assert.strictEqual(loaded.project_name, record.project_name);
      assert.strictEqual(loaded.worker.engine, 'antigravity');
      assert.strictEqual(loaded.worker.session_id, 'session-my-project-01');
      assert.strictEqual(loaded.worker.enabled, true);
      assert.strictEqual(loaded.auditor.engine, 'codex');
      assert.strictEqual(loaded.auditor.task_id, 'task-my-project-01');
      assert.strictEqual(loaded.auditor.task_id_verified, false);
      assert.strictEqual(loaded.auditor.expected_model_label, 'ChatGPT Web — GPT-5.6 Sol High');
      assert.strictEqual(loaded.auditor.mode, 'full-harness');
      assert.strictEqual(loaded.auditor.managed_by_orchestrator, false);
      assert.strictEqual(loaded.policy.max_active_dispatches, 1);
      assert.strictEqual(loaded.policy.require_workspace_state, true);

      console.log('✓ RG-002 PASSED: Semantic record persisted and reloaded identically.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-003: Duplicate basename with different roots and IDs accepted
  {
    console.log('[RG-003] Duplicate basename with different roots and IDs accepted...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const rootA = path.join(sandbox.dir, 'client-a', 'app');
      const rootB = path.join(sandbox.dir, 'client-b', 'app');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('client-a-app', rootA));
      await registry.putProject(makeValidProject('client-b-app', rootB));

      const projA = await registry.getProject('client-a-app');
      const projB = await registry.getProject('client-b-app');
      assert.ok(projA);
      assert.ok(projB);
      assert.notStrictEqual(projA.project_root, projB.project_root);
      assert.strictEqual(projA.project_id, 'client-a-app');
      assert.strictEqual(projB.project_id, 'client-b-app');

      console.log('✓ RG-003 PASSED: Duplicate basenames across distinct roots/IDs accepted.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-004: Two IDs attempt same canonical Windows root -> DUPLICATE_PROJECT_ROOT
  {
    console.log('[RG-004] Two IDs attempt same canonical root identity -> DUPLICATE_PROJECT_ROOT...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const root = path.join(sandbox.dir, 'shared-root');
      fs.mkdirSync(root, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('project-one', root));

      // Attempt second project using slash/case variant of the same root
      const slashVariant = root.replace(/\\/g, '/') + '/';
      let caught = null;
      try {
        await registry.putProject(makeValidProject('project-two', slashVariant));
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.DUPLICATE_PROJECT_ROOT);

      console.log('✓ RG-004 PASSED: Duplicate canonical root rejected with DUPLICATE_PROJECT_ROOT.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-005: Invalid/relative/missing project root -> INVALID_PROJECT_ROOT
  {
    console.log('[RG-005] Relative or nonexistent project root fails closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      // Relative path
      let caughtRel = null;
      try {
        await registry.putProject(makeValidProject('proj-rel', './relative/path'));
      } catch (err) {
        caughtRel = err;
      }
      assert.ok(caughtRel);
      assert.strictEqual(caughtRel.code, REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT);

      // Nonexistent absolute path
      let caughtMissing = null;
      try {
        await registry.putProject(makeValidProject('proj-missing', path.join(sandbox.dir, 'does-not-exist')));
      } catch (err) {
        caughtMissing = err;
      }
      assert.ok(caughtMissing);
      assert.strictEqual(caughtMissing.code, REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT);

      console.log('✓ RG-005 PASSED: Relative and missing roots rejected with INVALID_PROJECT_ROOT.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-006: Project root points to regular file -> INVALID_PROJECT_ROOT
  {
    console.log('[RG-006] Project root pointing to regular file fails closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const filePath = path.join(sandbox.dir, 'regular-file.txt');
      fs.writeFileSync(filePath, 'not a directory', 'utf8');

      const registry = createProjectRegistry({ registryFilePath: regFile });
      let caught = null;
      try {
        await registry.putProject(makeValidProject('proj-file', filePath));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT);

      console.log('✓ RG-006 PASSED: File root rejected with INVALID_PROJECT_ROOT.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-007: Missing/empty worker.session_id -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-007] Missing or empty worker.session_id fails schema validation...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      // Empty string
      let caughtEmpty = null;
      try {
        await registry.putProject(makeValidProject('proj-bad-worker', projDir, {
          worker: { engine: 'antigravity', session_id: '   ', enabled: true }
        }));
      } catch (err) {
        caughtEmpty = err;
      }
      assert.ok(caughtEmpty);
      assert.strictEqual(caughtEmpty.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      // Missing session_id field
      const noSessionProj = makeValidProject('proj-bad-worker-2', projDir);
      delete noSessionProj.worker.session_id;
      let caughtMissing = null;
      try {
        await registry.putProject(noSessionProj);
      } catch (err) {
        caughtMissing = err;
      }
      assert.ok(caughtMissing);
      assert.strictEqual(caughtMissing.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-007 PASSED: Missing/empty worker session rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-008: Wrong worker engine -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-008] Wrong worker engine fails schema validation...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      let caught = null;
      try {
        await registry.putProject(makeValidProject('proj-bad-engine', projDir, {
          worker: { engine: 'codex', session_id: 'sess-01', enabled: true }
        }));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-008 PASSED: Non-antigravity worker engine rejected.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-009: Invalid auditor descriptor -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-009] Invalid auditor descriptor variations fail closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      const testAuditorVariation = async (auditorPatch) => {
        let caught = null;
        try {
          await registry.putProject(makeValidProject('proj-aud', projDir, {
            auditor: auditorPatch
          }));
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, `Expected failure for auditor patch: ${JSON.stringify(auditorPatch)}`);
        assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);
      };

      // Wrong engine
      await testAuditorVariation({ engine: 'openai', task_id: 't-1', task_id_verified: false, expected_model_label: 'GPT-5', mode: 'full-harness', managed_by_orchestrator: false });
      // Wrong mode
      await testAuditorVariation({ engine: 'codex', task_id: 't-1', task_id_verified: false, expected_model_label: 'GPT-5', mode: 'autonomous', managed_by_orchestrator: false });
      // managed_by_orchestrator = true
      await testAuditorVariation({ engine: 'codex', task_id: 't-1', task_id_verified: false, expected_model_label: 'GPT-5', mode: 'full-harness', managed_by_orchestrator: true });
      // Missing expected_model_label
      await testAuditorVariation({ engine: 'codex', task_id: 't-1', task_id_verified: false, expected_model_label: '', mode: 'full-harness', managed_by_orchestrator: false });
      // Missing task_id
      await testAuditorVariation({ engine: 'codex', task_id: '   ', task_id_verified: false, expected_model_label: 'GPT-5', mode: 'full-harness', managed_by_orchestrator: false });

      console.log('✓ RG-009 PASSED: All invalid auditor variations rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-010: Unsupported policy -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-010] Unsupported policy values fail closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      // max_active_dispatches = 2
      let caughtDisp = null;
      try {
        await registry.putProject(makeValidProject('proj-pol', projDir, {
          policy: { max_active_dispatches: 2, require_workspace_state: true }
        }));
      } catch (err) {
        caughtDisp = err;
      }
      assert.ok(caughtDisp);
      assert.strictEqual(caughtDisp.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      // require_workspace_state = false
      let caughtReq = null;
      try {
        await registry.putProject(makeValidProject('proj-pol-2', projDir, {
          policy: { max_active_dispatches: 1, require_workspace_state: false }
        }));
      } catch (err) {
        caughtReq = err;
      }
      assert.ok(caughtReq);
      assert.strictEqual(caughtReq.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-010 PASSED: Unsupported policy rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-011: Unknown fields rejected (top-level and nested)
  {
    console.log('[RG-011] Unknown fields rejected at all schema levels...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      // Unknown project field
      const badProj = makeValidProject('proj-extra', projDir);
      badProj.api_key = 'sk-secret-token';
      let caughtProj = null;
      try {
        await registry.putProject(badProj);
      } catch (err) {
        caughtProj = err;
      }
      assert.ok(caughtProj);
      assert.strictEqual(caughtProj.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      // Unknown worker field
      const badWorker = makeValidProject('proj-extra-w', projDir);
      badWorker.worker.cookie = 'user-auth-cookie';
      let caughtWorker = null;
      try {
        await registry.putProject(badWorker);
      } catch (err) {
        caughtWorker = err;
      }
      assert.ok(caughtWorker);
      assert.strictEqual(caughtWorker.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-011 PASSED: Unknown fields rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-012: Malformed JSON registry file -> REGISTRY_CORRUPT
  {
    console.log('[RG-012] Malformed JSON fails closed with REGISTRY_CORRUPT and file is untouched...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const corruptContent = '{ "schema_version": 1, "projects": { bad json ';
      fs.writeFileSync(regFile, corruptContent, 'utf8');

      let caught = null;
      try {
        createProjectRegistry({ registryFilePath: regFile });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_CORRUPT);

      // Verify file is untouched
      assert.strictEqual(fs.readFileSync(regFile, 'utf8'), corruptContent);

      console.log('✓ RG-012 PASSED: Malformed JSON throws REGISTRY_CORRUPT without overwriting file.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-013: Wrong schema version -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-013] Wrong schema version fails closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      fs.writeFileSync(regFile, JSON.stringify({ schema_version: 99, projects: {} }), 'utf8');

      let caught = null;
      try {
        createProjectRegistry({ registryFilePath: regFile });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-013 PASSED: Unsupported schema version rejected.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-014: Map key / project_id mismatch -> REGISTRY_SCHEMA_INVALID
  {
    console.log('[RG-014] Map key and project_id mismatch fails closed...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const root = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(root, { recursive: true });

      const mismatchedDoc = {
        schema_version: 1,
        projects: {
          'key-alpha': makeValidProject('key-beta', root)
        }
      };
      fs.writeFileSync(regFile, JSON.stringify(mismatchedDoc), 'utf8');

      let caught = null;
      try {
        createProjectRegistry({ registryFilePath: regFile });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-014 PASSED: Map key mismatch rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-015: Persisted valid project root is deleted after load -> getProject() fails closed
  {
    console.log('[RG-015] Root deleted after load causes getProject() to fail closed while others remain usable...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const rootA = path.join(sandbox.dir, 'proj-a');
      const rootB = path.join(sandbox.dir, 'proj-b');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('proj-a', rootA));
      await registry.putProject(makeValidProject('proj-b', rootB));

      // Delete rootA from disk
      fs.rmSync(rootA, { recursive: true, force: true });

      // proj-a runtime availability fails closed (A-02)
      let caught = null;
      try {
        await registry.getProject('proj-a');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE);

      // proj-b remains fully dispatchable and usable!
      const projB = await registry.getProject('proj-b');
      assert.ok(projB);
      assert.strictEqual(projB.project_id, 'proj-b');

      console.log('✓ RG-015 PASSED: Deleted root throws PROJECT_ROOT_UNAVAILABLE without corrupting registry.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-016: Caller mutation of getProject() result does not affect internal state
  {
    console.log('[RG-016] Caller mutation of getProject() result does not mutate internal registry...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('proj-immutable', projDir));

      const fetched = await registry.getProject('proj-immutable');
      fetched.worker.session_id = 'MUTATED_SESSION';
      fetched.auditor.task_id = 'MUTATED_TASK';

      const refetched = await registry.getProject('proj-immutable');
      assert.strictEqual(refetched.worker.session_id, 'session-proj-immutable-01');
      assert.strictEqual(refetched.auditor.task_id, 'task-proj-immutable-01');

      console.log('✓ RG-016 PASSED: getProject returns deeply detached object.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-017: Caller mutation of listProjects() result does not affect internal state
  {
    console.log('[RG-017] Caller mutation of listProjects() result does not mutate internal registry...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('proj-list', projDir));

      const list = await registry.listProjects();
      list[0].worker.session_id = 'MUTATED_SESSION';
      list[0].policy.max_active_dispatches = 999;

      const refetched = await registry.getProject('proj-list');
      assert.strictEqual(refetched.worker.session_id, 'session-proj-list-01');
      assert.strictEqual(refetched.policy.max_active_dispatches, 1);

      console.log('✓ RG-017 PASSED: listProjects returns deeply detached objects.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-018: Persistence write/rename failure leaves previous state intact
  {
    console.log('[RG-018] Persistence failure preserves previous authoritative state and valid file...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDirA = path.join(sandbox.dir, 'proj-a');
      const projDirB = path.join(sandbox.dir, 'proj-b');
      fs.mkdirSync(projDirA, { recursive: true });
      fs.mkdirSync(projDirB, { recursive: true });

      let faultActive = false;
      const faultFs = {
        ...fs,
        renameSync: (oldP, newP) => {
          if (faultActive) {
            throw new Error('EACCES: Injected filesystem rename failure');
          }
          return fs.renameSync(oldP, newP);
        }
      };

      const registry = createProjectRegistry({ registryFilePath: regFile, fs: faultFs });
      await registry.putProject(makeValidProject('proj-a', projDirA));

      // Enable write fault for next mutation
      faultActive = true;
      let caught = null;
      try {
        await registry.putProject(makeValidProject('proj-b', projDirB));
      } catch (err) {
        caught = err;
      }
      faultActive = false;

      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_PERSIST_FAILED);

      // Previous state remains intact in memory
      const projA = await registry.getProject('proj-a');
      assert.ok(projA);
      const projB = await registry.getProject('proj-b');
      assert.strictEqual(projB, null);

      // Target file remains valid previous version
      const fileContent = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      assert.ok(fileContent.projects['proj-a']);
      assert.strictEqual(fileContent.projects['proj-b'], undefined);

      console.log('✓ RG-018 PASSED: Persistence failure retains previous authority and valid JSON.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-019: Two overlapping same-instance mutations serialized
  {
    console.log('[RG-019] Concurrent same-instance mutations execute sequentially without lost updates...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const root1 = path.join(sandbox.dir, 'proj-1');
      const root2 = path.join(sandbox.dir, 'proj-2');
      fs.mkdirSync(root1, { recursive: true });
      fs.mkdirSync(root2, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      // Launch two mutations concurrently
      const p1 = registry.putProject(makeValidProject('proj-1', root1));
      const p2 = registry.putProject(makeValidProject('proj-2', root2));

      const [res1, res2] = await Promise.all([p1, p2]);
      assert.strictEqual(res1.project_id, 'proj-1');
      assert.strictEqual(res2.project_id, 'proj-2');

      // Both persisted
      const fileData = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      assert.ok(fileData.projects['proj-1']);
      assert.ok(fileData.projects['proj-2']);

      console.log('✓ RG-019 PASSED: Same-instance mutations serialized cleanly.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-020: Explicit update of existing project
  {
    console.log('[RG-020] Explicit update of existing project replaces full record after complete validation...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const rootA = path.join(sandbox.dir, 'proj-orig');
      const rootB = path.join(sandbox.dir, 'proj-updated');
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('my-proj', rootA, { project_name: 'Original Name' }));

      // Update mapping
      const updatedRecord = makeValidProject('my-proj', rootB, {
        project_name: 'Updated Name',
        worker: { session_id: 'session-updated-02' }
      });
      await registry.putProject(updatedRecord);

      const loaded = await registry.getProject('my-proj');
      assert.strictEqual(loaded.project_name, 'Updated Name');
      assert.strictEqual(loaded.worker.session_id, 'session-updated-02');

      console.log('✓ RG-020 PASSED: Existing project updated after complete record revalidation.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-021: Remove existing project
  {
    console.log('[RG-021] Remove existing project removes from memory and disk...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const root = path.join(sandbox.dir, 'proj-del');
      fs.mkdirSync(root, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('proj-del', root));

      const removeRes = await registry.removeProject('proj-del');
      assert.strictEqual(removeRes.ok, true);

      assert.strictEqual(await registry.getProject('proj-del'), null);

      const fileData = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      assert.strictEqual(fileData.projects['proj-del'], undefined);

      console.log('✓ RG-021 PASSED: Project removal persisted cleanly.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-022: Remove unknown project -> PROJECT_NOT_FOUND
  {
    console.log('[RG-022] Remove unknown project throws PROJECT_NOT_FOUND...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      let caught = null;
      try {
        await registry.removeProject('unknown-project');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.PROJECT_NOT_FOUND);

      console.log('✓ RG-022 PASSED: Remove unknown project rejected with PROJECT_NOT_FOUND.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-023: Legacy preview with current-style defects
  {
    console.log('[RG-023] Legacy preview flags defects and writes nothing to disk...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      const legacyFixture = [
        { id: 'ai_multi_task', name: 'AI_Multi_Task', path: 'D:\\TU_CODE\\AI_Multi_Task' },
        { id: '', name: '', path: '\\' },
        { id: 'ai_multi_task', name: 'AI_Multi_Task', path: 'd:\\\\TU_CODE\\\\AI_Multi_Task\\' },
        { id: 'bad/id', name: 'Slash ID', path: 'D:\\TU_CODE\\App' }
      ];

      const preview = registry.previewLegacyImport(legacyFixture);
      assert.ok(preview.issues.length > 0);
      assert.ok(preview.invalid_entries.length > 0);

      // Registry remains completely unwritten and empty
      assert.strictEqual(fs.existsSync(regFile), false);
      const projects = await registry.listProjects();
      assert.strictEqual(projects.length, 0);

      console.log('✓ RG-023 PASSED: Legacy preview identifies defects with zero persistence.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-024: Legacy preview of clean project path
  {
    console.log('[RG-024] Legacy preview of clean project path yields non-authoritative candidate proposal...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      const legacyEntry = [{ id: 'clean-project', name: 'Clean Project', path: 'D:\\TU_CODE\\Clean' }];
      const preview = registry.previewLegacyImport(legacyEntry);

      assert.strictEqual(preview.candidates.length, 1);
      const candidate = preview.candidates[0];
      assert.strictEqual(candidate.project_id, 'clean-project');
      assert.strictEqual(candidate.authoritative, false);
      assert.strictEqual(candidate.worker, null);
      assert.strictEqual(candidate.auditor, null);
      assert.strictEqual(candidate.status, 'CANDIDATE_REQUIRES_COMPLETION');

      console.log('✓ RG-024 PASSED: Clean legacy preview is non-authoritative proposal.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-025: No legacy import mutation API exists (A-01)
  {
    console.log('[RG-025] No legacy apply/import mutation API exists; preview has zero side-effects...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const registry = createProjectRegistry({ registryFilePath: regFile });

      // Assert no applyLegacyImport API exists on the registry instance or module
      assert.strictEqual(registry.applyLegacyImport, undefined);
      assert.strictEqual(registry.importLegacy, undefined);

      // Assert calling previewLegacyImport produces zero side effects
      registry.previewLegacyImport([{ id: 'test-proj', name: 'Test', path: 'D:\\Test' }]);
      assert.strictEqual(fs.existsSync(regFile), false);
      assert.strictEqual((await registry.listProjects()).length, 0);

      console.log('✓ RG-025 PASSED: Preview-only verified: zero persistence side-effects and no apply API.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-026: Broker integration passes exact descriptors
  {
    console.log('[RG-026] Broker integration test: broker dispatches exact registered descriptors...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'broker-target');
      fs.mkdirSync(projDir, { recursive: true });

      const concreteRegistry = createProjectRegistry({ registryFilePath: regFile });
      await concreteRegistry.putProject(makeValidProject('broker-target', projDir, {
        worker: { session_id: 'exact-worker-sess-999' },
        auditor: { task_id: 'exact-auditor-task-888' }
      }));

      const fakeWorkspacePort = {
        getWorkspaceState: async () => ({ workspace_state_id: 'sha256:target-state-hash' })
      };

      const workerDispatchedArgs = [];
      const fakeWorkerPort = {
        dispatch: async (args) => {
          workerDispatchedArgs.push(args);
          return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
        },
        wait: async () => ({ ok: true, state: DISPATCH_STATES.RUNNING }),
        status: async () => ({ ok: true, state: 'IDLE' })
      };

      const broker = createBroker({
        registryPort: concreteRegistry,
        workspacePort: fakeWorkspacePort,
        workerPort: fakeWorkerPort
      });

      const brokerProj = await broker.getProject('broker-target');
      assert.strictEqual(brokerProj.ok, true);
      assert.strictEqual(brokerProj.project.project_id, 'broker-target');

      const dispatchRes = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'broker-target',
        work_order_id: 'WO-INT-001',
        expected_workspace_state_id: 'sha256:target-state-hash',
        directive: 'Perform broker integration verification'
      });

      assert.strictEqual(dispatchRes.ok, true);
      assert.strictEqual(workerDispatchedArgs.length, 1);
      const passedToWorker = workerDispatchedArgs[0];

      // Exact descriptors passed to worker
      assert.strictEqual(passedToWorker.project.project_id, 'broker-target');
      assert.strictEqual(passedToWorker.project.worker.session_id, 'exact-worker-sess-999');
      assert.strictEqual(passedToWorker.project.auditor.task_id, 'exact-auditor-task-888');

      console.log('✓ RG-026 PASSED: Broker integration dispatched exact registered descriptors to worker.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-027: Wrong ID does not fall back by root/basename
  {
    console.log('[RG-027] Wrong ID does not fall back by root or basename...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'app');
      fs.mkdirSync(projDir, { recursive: true });

      const concreteRegistry = createProjectRegistry({ registryFilePath: regFile });
      await concreteRegistry.putProject(makeValidProject('client-a-app', projDir, {
        project_name: 'app'
      }));

      const broker = createBroker({
        registryPort: concreteRegistry,
        workspacePort: { getWorkspaceState: async () => ({ workspace_state_id: 'hash' }) },
        workerPort: { dispatch: async () => ({ ok: true }) }
      });

      // Query by basename 'app' instead of explicit 'client-a-app'
      const res = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'app',
        work_order_id: 'WO-001',
        expected_workspace_state_id: 'hash',
        directive: 'test'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, ERROR_CODES.PROJECT_NOT_FOUND);

      console.log('✓ RG-027 PASSED: No basename fallback; PROJECT_NOT_FOUND returned.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-028: No legacy auto-import
  {
    console.log('[RG-028] Placing legacy user-projects.json does not trigger automatic migration...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const legacyFile = path.join(sandbox.dir, 'user-projects.json');
      fs.writeFileSync(legacyFile, JSON.stringify([
        { id: 'legacy-proj', name: 'Legacy', path: 'D:\\Legacy' }
      ]), 'utf8');

      // Create registry in same dir
      const registry = createProjectRegistry({ registryFilePath: regFile });
      const projects = await registry.listProjects();

      // Must remain empty
      assert.strictEqual(projects.length, 0);
      assert.strictEqual(fs.existsSync(regFile), false);

      console.log('✓ RG-028 PASSED: Registry remains unpopulated unless explicitly mutated.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-029: No secret fields round-trip
  {
    console.log('[RG-029] Secret fields rejected at schema boundary without writing to disk...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });

      const secrets = ['api_key', 'token', 'cookie', 'password', 'tunnel_key'];
      for (const secretField of secrets) {
        const candidate = makeValidProject(`proj-${secretField}`, projDir);
        candidate[secretField] = 'confidential-secret-value';

        let caught = null;
        try {
          await registry.putProject(candidate);
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, `Expected rejection for field: ${secretField}`);
        assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);
      }

      assert.strictEqual(fs.existsSync(regFile), false);

      console.log('✓ RG-029 PASSED: Secret fields rejected without persisting.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-030: Windows path normalization identity
  {
    console.log('[RG-030] Windows path normalization handles casing, slashes, trailing separator, and dots...');
    const id1 = computeRootIdentityKey('D:\\TU_CODE\\AI_Multi_Task');
    const id2 = computeRootIdentityKey('d:/TU_CODE/AI_Multi_Task/');
    const id3 = computeRootIdentityKey('d:\\tu_code\\ai_multi_task\\');
    const id4 = computeRootIdentityKey('D:/TU_CODE/sub/../AI_Multi_Task');

    assert.strictEqual(id1, id2);
    assert.strictEqual(id2, id3);
    assert.strictEqual(id3, id4);

    console.log('✓ RG-030 PASSED: Windows path variations yield identical normalized identity key.\n');
  }

  // RG-031: worker.enabled = false fails closed (A-03)
  {
    console.log('[RG-031] worker.enabled=false fails closed at schema validation without persistence...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      let caught = null;
      try {
        await registry.putProject(makeValidProject('proj-disabled', projDir, {
          worker: { engine: 'antigravity', session_id: 'sess-01', enabled: false }
        }));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);
      assert.strictEqual(fs.existsSync(regFile), false);

      console.log('✓ RG-031 PASSED: worker.enabled=false rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-032: Failed mutation does not poison subsequent mutation queue (A-05)
  {
    console.log('[RG-032] Failed mutation does not poison subsequent mutation queue...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projA = path.join(sandbox.dir, 'proj-a');
      const projB = path.join(sandbox.dir, 'proj-b');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });

      let faultActive = false;
      const faultFs = {
        ...fs,
        renameSync: (oldP, newP) => {
          if (faultActive) {
            throw new Error('EPERM: Simulating temporary lock error');
          }
          return fs.renameSync(oldP, newP);
        }
      };

      const registry = createProjectRegistry({ registryFilePath: regFile, fs: faultFs });

      // Operation A fails
      faultActive = true;
      let caughtA = null;
      try {
        await registry.putProject(makeValidProject('proj-a', projA));
      } catch (err) {
        caughtA = err;
      }
      faultActive = false;
      assert.ok(caughtA);
      assert.strictEqual(caughtA.code, REGISTRY_ERROR_CODES.REGISTRY_PERSIST_FAILED);

      // Operation B should NOT be blocked or poisoned by Operation A's rejection
      const resB = await registry.putProject(makeValidProject('proj-b', projB));
      assert.strictEqual(resB.project_id, 'proj-b');

      const loadedB = await registry.getProject('proj-b');
      assert.ok(loadedB);
      assert.strictEqual(loadedB.project_id, 'proj-b');

      console.log('✓ RG-032 PASSED: Mutation queue recovered cleanly after failed operation.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-033: validate() snapshot detached (REG-03)
  {
    console.log('[RG-033] validate() returns detached snapshot; mutations do not affect internal state or disk...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-a');
      fs.mkdirSync(projDir, { recursive: true });

      const registry = createProjectRegistry({ registryFilePath: regFile });
      await registry.putProject(makeValidProject('proj-a', projDir));

      const snapshot = registry.validate();
      snapshot.projects['proj-a'].worker.session_id = 'ATTACKER_SESSION';
      snapshot.projects['proj-a'].auditor.task_id = 'ATTACKER_TASK';
      snapshot.projects['proj-a'].policy.max_active_dispatches = 999;
      snapshot.projects['proj-a'].project_root = 'C:\\Other';

      const refetched = await registry.getProject('proj-a');
      assert.strictEqual(refetched.worker.session_id, 'session-proj-a-01');
      assert.strictEqual(refetched.auditor.task_id, 'task-proj-a-01');
      assert.strictEqual(refetched.policy.max_active_dispatches, 1);
      assert.strictEqual(refetched.project_root, projDir);

      const fileContent = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      assert.strictEqual(fileContent.projects['proj-a'].worker.session_id, 'session-proj-a-01');

      console.log('✓ RG-033 PASSED: validate() snapshot is deeply detached.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-034: Persisted relative root rejected on load (REG-01)
  {
    console.log('[RG-034] Manually persisted relative project_root rejected on load with REGISTRY_SCHEMA_INVALID...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const badDoc = {
        schema_version: 1,
        projects: {
          bad: makeValidProject('bad', '.')
        }
      };
      fs.writeFileSync(regFile, JSON.stringify(badDoc), 'utf8');

      let caught = null;
      try {
        createProjectRegistry({ registryFilePath: regFile });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-034 PASSED: Persisted relative root rejected on load with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-035: Windows root-relative path rejected (REG-01)
  {
    console.log('[RG-035] Windows root-relative project_root rejected on load with REGISTRY_SCHEMA_INVALID...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const badDoc = {
        schema_version: 1,
        projects: {
          'bad-root-rel': makeValidProject('bad-root-rel', '\\SomeFolder')
        }
      };
      fs.writeFileSync(regFile, JSON.stringify(badDoc), 'utf8');

      let caught = null;
      try {
        createProjectRegistry({ registryFilePath: regFile });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      // Verify pure helper with explicit win32 semantics
      let caughtHelper = null;
      try {
        validateProjectRootShape('\\SomeFolder', 'win32');
      } catch (err) {
        caughtHelper = err;
      }
      assert.ok(caughtHelper);
      assert.strictEqual(caughtHelper.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      let caughtRootSlash = null;
      try {
        validateProjectRootShape('\\', 'win32');
      } catch (err) {
        caughtRootSlash = err;
      }
      assert.ok(caughtRootSlash);
      assert.strictEqual(caughtRootSlash.code, REGISTRY_ERROR_CODES.REGISTRY_SCHEMA_INVALID);

      console.log('✓ RG-035 PASSED: Windows root-relative path rejected with REGISTRY_SCHEMA_INVALID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-036: Realpath failure on putProject fails closed (REG-02)
  {
    console.log('[RG-036] Realpath failure on putProject fails closed with INVALID_PROJECT_ROOT (no resolve fallback)...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      fs.mkdirSync(projDir, { recursive: true });

      const faultFs = {
        ...fs,
        realpathSync: () => {
          throw new Error('EINVAL: Injected realpath failure');
        }
      };
      faultFs.realpathSync.native = () => {
        throw new Error('EINVAL: Injected realpath failure');
      };

      const registry = createProjectRegistry({ registryFilePath: regFile, fs: faultFs });
      let caught = null;
      try {
        await registry.putProject(makeValidProject('proj-realpath-fail', projDir));
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.INVALID_PROJECT_ROOT);
      assert.strictEqual(fs.existsSync(regFile), false);
      assert.strictEqual((await registry.listProjects()).length, 0);

      console.log('✓ RG-036 PASSED: Realpath failure on putProject fails closed with INVALID_PROJECT_ROOT.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-037: Realpath failure on getProject fails closed (REG-04)
  {
    console.log('[RG-037] Realpath failure on getProject fails closed with PROJECT_ROOT_UNAVAILABLE and zero worker dispatch...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projA = path.join(sandbox.dir, 'proj-a');
      const projB = path.join(sandbox.dir, 'proj-b');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });

      let realpathFaultA = false;
      const faultFs = {
        ...fs,
        realpathSync: (p) => {
          if (realpathFaultA && typeof p === 'string' && p.includes('proj-a')) {
            throw new Error('EACCES: Injected realpath failure');
          }
          return fs.realpathSync(p);
        }
      };
      faultFs.realpathSync.native = (p) => {
        if (realpathFaultA && typeof p === 'string' && p.includes('proj-a')) {
          throw new Error('EACCES: Injected realpath failure');
        }
        return fs.realpathSync.native(p);
      };

      const registry = createProjectRegistry({ registryFilePath: regFile, fs: faultFs });
      await registry.putProject(makeValidProject('proj-a', projA));
      await registry.putProject(makeValidProject('proj-b', projB));

      // Enable realpath fault on proj-a
      realpathFaultA = true;
      let caughtA = null;
      try {
        await registry.getProject('proj-a');
      } catch (err) {
        caughtA = err;
      }
      assert.ok(caughtA);
      assert.strictEqual(caughtA.code, REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE);

      // proj-b remains unaffected
      const loadedB = await registry.getProject('proj-b');
      assert.ok(loadedB);
      assert.strictEqual(loadedB.project_id, 'proj-b');

      // Broker integration check (Section 30): broker dispatching on proj-a results in 0 worker calls
      let workerDispatchCount = 0;
      const broker = createBroker({
        registryPort: registry,
        workspacePort: { getWorkspaceState: async () => ({ workspace_state_id: 'ws-1' }) },
        workerPort: {
          dispatch: async () => {
            workerDispatchCount++;
            return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
          }
        }
      });

      const brokerRes = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'proj-a',
        work_order_id: 'WO-037',
        expected_workspace_state_id: 'ws-1',
        directive: 'test'
      });
      assert.strictEqual(brokerRes.ok, false);
      assert.strictEqual(brokerRes.code, ERROR_CODES.REGISTRY_UNAVAILABLE);
      assert.strictEqual(workerDispatchCount, 0);

      console.log('✓ RG-037 PASSED: Realpath failure on getProject fails closed; broker produces 0 worker calls.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-038: Runtime root identity drift on getProject fails closed (REG-04)
  {
    console.log('[RG-038] Runtime root identity drift fails closed with PROJECT_ROOT_UNAVAILABLE without mutation...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const projDir = path.join(sandbox.dir, 'proj-dir');
      const driftDir = path.join(sandbox.dir, 'drift-dir');
      fs.mkdirSync(projDir, { recursive: true });
      fs.mkdirSync(driftDir, { recursive: true });

      let driftActive = false;
      const driftFs = {
        ...fs,
        realpathSync: (p) => {
          if (driftActive && typeof p === 'string' && p.includes('proj-dir')) {
            return driftDir;
          }
          return fs.realpathSync(p);
        }
      };
      driftFs.realpathSync.native = (p) => {
        if (driftActive && typeof p === 'string' && p.includes('proj-dir')) {
          return driftDir;
        }
        return fs.realpathSync.native(p);
      };

      const registry = createProjectRegistry({ registryFilePath: regFile, fs: driftFs });
      await registry.putProject(makeValidProject('proj-drift', projDir));

      // Enable drift
      driftActive = true;
      let caught = null;
      try {
        await registry.getProject('proj-drift');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE);

      // Verify no silent recanonicalization or mutation occurred
      driftActive = false;
      const refetched = await registry.getProject('proj-drift');
      assert.ok(refetched);
      assert.strictEqual(refetched.project_root, projDir);

      console.log('✓ RG-038 PASSED: Runtime canonical drift fails closed without silent mutation.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // RG-039: Absolute missing root remains structurally valid on load (Section 28)
  {
    console.log('[RG-039] Absolute missing root succeeds structural load but fails runtime getProject()...');
    const sandbox = createTestSandbox();
    try {
      const regFile = path.join(sandbox.dir, 'projects.json');
      const missingAbsRoot = path.join(sandbox.dir, 'missing-folder');

      const docWithMissingAbs = {
        schema_version: 1,
        projects: {
          'proj-missing-abs': makeValidProject('proj-missing-abs', missingAbsRoot)
        }
      };
      fs.writeFileSync(regFile, JSON.stringify(docWithMissingAbs), 'utf8');

      // Structural load must succeed
      const registry = createProjectRegistry({ registryFilePath: regFile });
      const validated = registry.validate();
      assert.strictEqual(validated.schema_version, 1);
      assert.ok(validated.projects['proj-missing-abs']);

      // Runtime getProject must fail closed
      let caught = null;
      try {
        await registry.getProject('proj-missing-abs');
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, REGISTRY_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE);

      console.log('✓ RG-039 PASSED: Absolute missing root is structurally valid on load, unavailable at runtime.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  console.log('======================================================================');
  console.log('ALL REGISTRY TESTS PASSED (RG-001 .. RG-039: 39/39 PASS)');
  console.log('======================================================================\n');
}

runAllTests().catch((err) => {
  console.error('[TEST SUITE FAILURE]', err);
  process.exit(1);
});

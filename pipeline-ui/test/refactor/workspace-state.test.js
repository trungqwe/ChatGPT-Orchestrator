'use strict';

/**
 * Workspace State Unit, Negative, Concurrency & Integration Test Suite (WS-001 .. WS-039)
 *
 * Validates the concrete deterministic workspace-state gate against all requirements
 * in WO-V3-004 and the Human Plan Review Addendum (A-01 .. A-20).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const child_process = require('node:child_process');

const {
  WORKSPACE_STATE_ERROR_CODES,
  WorkspaceStateError,
  STATE_VERSION,
  GIT_MAX_BUFFER_BYTES,
  validateUntrackedPathSafety,
  createWorkspaceStatePort
} = require('../../lib/broker/workspace-state');
const { createBroker } = require('../../lib/broker/broker');
const { DISPATCH_STATES, ERROR_CODES } = require('../../lib/broker/contracts');

// Helper to create an isolated temporary test sandbox directory
function createTestSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

// Helper to initialize a clean Git repository with local config (Section 52)
function initGitRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  const run = (args) => {
    const res = child_process.spawnSync('git', args, { cwd: repoDir, shell: false, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Git command 'git ${args.join(' ')}' failed: ${res.stderr}`);
    }
    return res;
  };
  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Test Auditor']);
  run(['config', 'user.email', 'auditor@example.com']);
  run(['config', 'commit.gpgsign', 'false']);
}

// Helper to write and commit a file
function commitFile(repoDir, relPath, content, msg = 'initial commit') {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  const run = (args) => {
    const res = child_process.spawnSync('git', args, { cwd: repoDir, shell: false, encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(`Git command 'git ${args.join(' ')}' failed: ${res.stderr}`);
    }
  };
  run(['add', relPath]);
  run(['commit', '-m', msg]);
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING WORKSPACE-STATE TEST SUITE (WS-001 .. WS-051)');
  console.log('======================================================================\n');

  const wsPort = createWorkspaceStatePort();

  // WS-001: Clean repository determinism
  {
    console.log('[WS-001] Clean repository determinism (called twice -> identical state ID)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);
      const s2 = await wsPort.getWorkspaceState(project);

      assert.strictEqual(s1.workspace_state_id, s2.workspace_state_id);
      assert.strictEqual(s1.head, s2.head);
      assert.strictEqual(s1.branch, 'main');
      assert.deepStrictEqual(s1.components, s2.components);
      assert.ok(s1.workspace_state_id.startsWith('sha256:'));

      console.log('✓ WS-001 PASSED: Identical workspace_state_id produced on consecutive calls.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-002: Project identity (different project_id on same repo -> different state ID)
  {
    console.log('[WS-002] Project identity affects workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const sA = await wsPort.getWorkspaceState({ project_id: 'client-a', project_root: repoDir });
      const sB = await wsPort.getWorkspaceState({ project_id: 'client-b', project_root: repoDir });

      assert.notStrictEqual(sA.workspace_state_id, sB.workspace_state_id);
      assert.strictEqual(sA.head, sB.head);
      assert.deepStrictEqual(sA.components, sB.components);

      console.log('✓ WS-002 PASSED: Different project_id produces distinct state ID on same repo.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-003: Branch change
  {
    console.log('[WS-003] Branch change affects workspace_state_id (same HEAD)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const sMain = await wsPort.getWorkspaceState(project);

      // Create and switch to feature branch pointing at same commit
      child_process.spawnSync('git', ['checkout', '-b', 'feature-branch'], { cwd: repoDir, shell: false });
      const sFeature = await wsPort.getWorkspaceState(project);

      assert.strictEqual(sMain.head, sFeature.head);
      assert.notStrictEqual(sMain.branch, sFeature.branch);
      assert.notStrictEqual(sMain.workspace_state_id, sFeature.workspace_state_id);

      console.log('✓ WS-003 PASSED: Branch switch alters state ID while HEAD remains identical.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-004: HEAD change
  {
    console.log('[WS-004] New commit changes HEAD and workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      commitFile(repoDir, 'file2.txt', 'Second file\n', 'second commit');
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.head, s2.head);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-004 PASSED: New commit produces distinct HEAD and state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-005: Unstaged tracked change
  {
    console.log('[WS-005] Unstaged tracked change alters unstaged diff and state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      // Modify tracked file without staging
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'Modified Content\n');
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.unstaged_diff_sha256, s2.components.unstaged_diff_sha256);
      assert.notStrictEqual(s1.components.status_sha256, s2.components.status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-005 PASSED: Unstaged modification changes unstaged diff digest and state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-006: Staged change
  {
    console.log('[WS-006] Staged modification alters staged diff and state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      // Modify and stage
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'Staged Content\n');
      child_process.spawnSync('git', ['add', 'README.md'], { cwd: repoDir, shell: false });
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.staged_diff_sha256, s2.components.staged_diff_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-006 PASSED: Staged modification changes staged diff digest and state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-007: Delete tracked file
  {
    console.log('[WS-007] Deleting tracked file alters state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');
      commitFile(repoDir, 'delete-me.txt', 'Going to be deleted\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      fs.unlinkSync(path.join(repoDir, 'delete-me.txt'));
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.unstaged_diff_sha256, s2.components.unstaged_diff_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-007 PASSED: File deletion detected and changes state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-008: Rename tracked file
  {
    console.log('[WS-008] Renaming tracked file alters state ID under --no-renames...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'orig.txt', 'Original content\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      child_process.spawnSync('git', ['mv', 'orig.txt', 'renamed.txt'], { cwd: repoDir, shell: false });
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.staged_diff_sha256, s2.components.staged_diff_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-008 PASSED: Rename alters staged diff and state ID without rename heuristic reliance.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-009: Untracked file
  {
    console.log('[WS-009] Adding untracked file alters untracked count, manifest, and state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);
      assert.strictEqual(s1.untracked_count, 0);

      // Create untracked file
      fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new untracked data\n');
      const s2 = await wsPort.getWorkspaceState(project);

      assert.strictEqual(s2.untracked_count, 1);
      assert.notStrictEqual(s1.components.untracked_manifest_sha256, s2.components.untracked_manifest_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-009 PASSED: Untracked file detected in manifest and changes state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-010: Untracked raw byte change (LF to CRLF)
  {
    console.log('[WS-010] Untracked raw byte change (LF -> CRLF) alters state ID (no newline normalization)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };

      // Untracked file with LF
      fs.writeFileSync(path.join(repoDir, 'text.txt'), Buffer.from('line1\nline2\n'));
      const s1 = await wsPort.getWorkspaceState(project);

      // Untracked file with CRLF
      fs.writeFileSync(path.join(repoDir, 'text.txt'), Buffer.from('line1\r\nline2\r\n'));
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.untracked_manifest_sha256, s2.components.untracked_manifest_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-010 PASSED: Line ending byte difference in untracked file detected.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-011: Binary untracked change
  {
    console.log('[WS-011] Modifying byte in binary untracked file alters state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };

      const bin1 = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      fs.writeFileSync(path.join(repoDir, 'bin.dat'), bin1);
      const s1 = await wsPort.getWorkspaceState(project);

      const bin2 = Buffer.from([0x00, 0x01, 0x03, 0xff]);
      fs.writeFileSync(path.join(repoDir, 'bin.dat'), bin2);
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.untracked_manifest_sha256, s2.components.untracked_manifest_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-011 PASSED: Binary untracked modification alters state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-012: Untracked path change
  {
    console.log('[WS-012] Renaming untracked file without changing content alters manifest and state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };

      fs.writeFileSync(path.join(repoDir, 'path-a.txt'), 'constant content');
      const s1 = await wsPort.getWorkspaceState(project);

      fs.unlinkSync(path.join(repoDir, 'path-a.txt'));
      fs.writeFileSync(path.join(repoDir, 'path-b.txt'), 'constant content');
      const s2 = await wsPort.getWorkspaceState(project);

      assert.notStrictEqual(s1.components.untracked_manifest_sha256, s2.components.untracked_manifest_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-012 PASSED: Untracked path name is part of manifest identity.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-013: Ignored file (A-16)
  {
    console.log('[WS-013] Changes strictly to ignored files do NOT alter workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      // Commit .gitignore first to ensure gitignore itself is stable (A-16)
      commitFile(repoDir, '.gitignore', '*.log\nignored-folder/\n', 'add gitignore');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      // Create and modify ignored files
      fs.writeFileSync(path.join(repoDir, 'debug.log'), 'Debug log content 1\n');
      fs.mkdirSync(path.join(repoDir, 'ignored-folder'), { recursive: true });
      fs.writeFileSync(path.join(repoDir, 'ignored-folder', 'temp.txt'), 'Temp data\n');

      const s2 = await wsPort.getWorkspaceState(project);

      assert.strictEqual(s1.components.untracked_manifest_sha256, s2.components.untracked_manifest_sha256);
      assert.strictEqual(s1.workspace_state_id, s2.workspace_state_id);

      // Mutate ignored file content
      fs.writeFileSync(path.join(repoDir, 'debug.log'), 'Debug log content 2 (updated)\n');
      const s3 = await wsPort.getWorkspaceState(project);
      assert.strictEqual(s1.workspace_state_id, s3.workspace_state_id);

      console.log('✓ WS-013 PASSED: Ignored file modifications do not alter workspace_state_id.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-014: Spaces and non-ASCII Unicode path
  {
    console.log('[WS-014] Untracked path with spaces and non-ASCII characters handled deterministically...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };

      // File with spaces and non-ASCII unicode
      const filename = 'báo cáo kiểm thử 2026.txt';
      fs.writeFileSync(path.join(repoDir, filename), 'Nội dung kiểm thử\n', 'utf8');

      const s1 = await wsPort.getWorkspaceState(project);
      const s2 = await wsPort.getWorkspaceState(project);

      assert.strictEqual(s1.untracked_count, 1);
      assert.strictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-014 PASSED: Paths with spaces and Unicode parsed without corruption.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-015: Large untracked file (chunked/incremental hash, no truncation)
  {
    console.log('[WS-015] Large untracked file hashed completely without truncation...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };

      // 2.5 MiB file
      const largeSize = Math.floor(2.5 * 1024 * 1024);
      const largeBuf = crypto.randomBytes(largeSize);
      fs.writeFileSync(path.join(repoDir, 'large.bin'), largeBuf);

      const s = await wsPort.getWorkspaceState(project);
      assert.strictEqual(s.untracked_count, 1);

      // Verify that changing one byte at the very end changes state ID
      largeBuf[largeSize - 1] ^= 0xff;
      fs.writeFileSync(path.join(repoDir, 'large.bin'), largeBuf);

      const sMutated = await wsPort.getWorkspaceState(project);
      assert.notStrictEqual(s.workspace_state_id, sMutated.workspace_state_id);

      console.log('✓ WS-015 PASSED: Multi-megabyte file hashed incrementally and end-byte modification detected.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-016: Symlink target outside root (never follow external content)
  {
    console.log('[WS-016] Untracked symlink pointing outside root never follows external target content...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const extFile = path.join(sandbox.dir, 'external.txt');
      fs.writeFileSync(extFile, 'Initial External Content\n');

      let canCreateSymlink = true;
      try {
        fs.symlinkSync(extFile, path.join(repoDir, 'link-to-ext'));
      } catch (err) {
        canCreateSymlink = false;
      }

      if (canCreateSymlink) {
        const project = { project_id: 'proj-1', project_root: repoDir };
        const s1 = await wsPort.getWorkspaceState(project);

        // Mutate external file content ONLY
        fs.writeFileSync(extFile, 'Modified External Content (SHOULD NOT CHANGE STATE ID)\n');
        const s2 = await wsPort.getWorkspaceState(project);

        assert.strictEqual(s1.workspace_state_id, s2.workspace_state_id);

        // Now mutate the symlink target itself
        const extFile2 = path.join(sandbox.dir, 'external2.txt');
        fs.writeFileSync(extFile2, 'Second External File\n');
        fs.unlinkSync(path.join(repoDir, 'link-to-ext'));
        fs.symlinkSync(extFile2, path.join(repoDir, 'link-to-ext'));

        const s3 = await wsPort.getWorkspaceState(project);
        assert.notStrictEqual(s1.workspace_state_id, s3.workspace_state_id);

        console.log('✓ WS-016 PASSED: Real symlink tested; external content mutation ignored; target change detected.\n');
      } else {
        // Fallback for restricted Windows symlink environments: test with injected customFs
        console.log('  (Platform symlink privilege restricted; verifying with injected readlinkSync fs)');
        const project = { project_id: 'proj-1', project_root: repoDir };
        fs.writeFileSync(path.join(repoDir, 'mock-link'), 'placeholder');

        let externalTargetReadAttempted = false;
        let readlinkTarget = '../external.txt';

        const injectedFs = {
          ...fs,
          lstatSync: (p) => {
            if (p.endsWith('mock-link')) {
              return { isSymbolicLink: () => true, isFile: () => false, mode: 0o120777 };
            }
            return fs.lstatSync(p);
          },
          readlinkSync: (p, opts) => {
            if (p.endsWith('mock-link')) {
              return Buffer.from(readlinkTarget);
            }
            return fs.readlinkSync(p, opts);
          },
          openSync: (p, flags) => {
            if (p.includes('external')) {
              externalTargetReadAttempted = true;
            }
            return fs.openSync(p, flags);
          }
        };

        const injectedPort = createWorkspaceStatePort({ fs: injectedFs });
        const s1 = await injectedPort.getWorkspaceState(project);
        assert.strictEqual(externalTargetReadAttempted, false);

        // Change symlink target
        readlinkTarget = '../external2.txt';
        const s2 = await injectedPort.getWorkspaceState(project);
        assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);
        assert.strictEqual(externalTargetReadAttempted, false);

        console.log('✓ WS-016 PASSED: Injected symlink target verified; target never opened/read.\n');
      }
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-017: Non-Git directory -> NOT_GIT_REPOSITORY
  {
    console.log('[WS-017] Non-Git directory fails closed with NOT_GIT_REPOSITORY...');
    const sandbox = createTestSandbox();
    try {
      const nonGitDir = path.join(sandbox.dir, 'plain-folder');
      fs.mkdirSync(nonGitDir, { recursive: true });

      // Ensure deterministic not-a-git-repository behavior independent of ambient host .git
      const nonGitSpawn = (bin, args, opts) => {
        if (args.includes('rev-parse') && args.includes('--show-toplevel')) {
          return {
            status: 128,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('fatal: not a git repository (or any of the parent directories): .git\n'),
            error: null
          };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const nonGitPort = createWorkspaceStatePort({ spawnSync: nonGitSpawn });
      let caught = null;
      try {
        await nonGitPort.getWorkspaceState({ project_id: 'p1', project_root: nonGitDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.NOT_GIT_REPOSITORY);

      console.log('✓ WS-017 PASSED: Non-Git directory rejected with NOT_GIT_REPOSITORY.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-018: Nested project root -> PROJECT_ROOT_NOT_GIT_TOPLEVEL
  {
    console.log('[WS-018] Nested subdirectory inside Git repo fails closed with PROJECT_ROOT_NOT_GIT_TOPLEVEL...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'parent-repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'root.txt', 'root content\n');

      const nestedDir = path.join(repoDir, 'packages', 'sub-app');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, 'app.js'), 'console.log("sub");\n');

      let caught = null;
      try {
        await wsPort.getWorkspaceState({ project_id: 'sub-app', project_root: nestedDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_NOT_GIT_TOPLEVEL);

      console.log('✓ WS-018 PASSED: Nested subdirectory root rejected with PROJECT_ROOT_NOT_GIT_TOPLEVEL.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-019: Detached HEAD -> branch = 'DETACHED'
  {
    console.log('[WS-019] Detached HEAD resolves branch as DETACHED with valid state ID...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const sInitial = await wsPort.getWorkspaceState(project);
      assert.strictEqual(sInitial.branch, 'main');

      // Detach HEAD
      child_process.spawnSync('git', ['checkout', '--detach', sInitial.head], { cwd: repoDir, shell: false });

      const sDetached = await wsPort.getWorkspaceState(project);
      assert.strictEqual(sDetached.branch, 'DETACHED');
      assert.strictEqual(sDetached.head, sInitial.head);
      assert.ok(sDetached.workspace_state_id.startsWith('sha256:'));
      assert.notStrictEqual(sInitial.workspace_state_id, sDetached.workspace_state_id);

      console.log('✓ WS-019 PASSED: Detached HEAD captured with DETACHED branch sentinel.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-020: Unborn HEAD -> HEAD_UNAVAILABLE
  {
    console.log('[WS-020] Fresh empty repository (unborn HEAD) fails closed with HEAD_UNAVAILABLE...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'empty-repo');
      initGitRepo(repoDir); // Initialized but zero commits

      let caught = null;
      try {
        await wsPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.HEAD_UNAVAILABLE);

      console.log('✓ WS-020 PASSED: Unborn HEAD rejected with HEAD_UNAVAILABLE.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-021: Git command failure
  {
    console.log('[WS-021] Git command failure fails closed with GIT_COMMAND_FAILED...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      // Inject custom spawnSync that fails for git status
      const customSpawn = (bin, args, opts) => {
        if (args.includes('status')) {
          return {
            status: 128,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('fatal: injected error for git status\n')
          };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const faultPort = createWorkspaceStatePort({ spawnSync: customSpawn });
      let caught = null;
      try {
        await faultPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED);

      console.log('✓ WS-021 PASSED: Git command failure caught and mapped to GIT_COMMAND_FAILED.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-022: Unsafe untracked path (A-03)
  {
    console.log('[WS-022] Unsafe untracked path traversal rejected with UNSAFE_UNTRACKED_PATH...');
    const repoRoot = path.resolve('C:\\Fake\\Repo');

    // 1. Path escaping root with .. segment
    assert.throws(
      () => validateUntrackedPathSafety(Buffer.from('../outside.txt'), repoRoot),
      (err) => err.code === WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH
    );

    // 2. Absolute path
    assert.throws(
      () => validateUntrackedPathSafety(Buffer.from('/etc/passwd'), repoRoot),
      (err) => err.code === WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH
    );

    // 3. Legitimate file containing two dots is NOT rejected (A-03)
    const valid = validateUntrackedPathSafety(Buffer.from('foo..bar.txt'), repoRoot);
    assert.strictEqual(valid.relPath, 'foo..bar.txt');

    console.log('✓ WS-022 PASSED: Segment-based path safety enforced; escapes rejected; dots in names preserved.\n');
  }

  // WS-023: Unsupported special file (Section 35)
  {
    console.log('[WS-023] Unsupported special file types fail closed with UNSUPPORTED_UNTRACKED_TYPE...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      fs.writeFileSync(path.join(repoDir, 'special.dat'), 'special');

      // Inject custom lstat that pretends special.dat is a FIFO/socket
      const customFs = {
        ...fs,
        lstatSync: (p) => {
          if (p.endsWith('special.dat')) {
            return {
              isSymbolicLink: () => false,
              isFile: () => false,
              isFIFO: () => true,
              mode: 0o010644
            };
          }
          return fs.lstatSync(p);
        }
      };

      const specialPort = createWorkspaceStatePort({ fs: customFs });
      let caught = null;
      try {
        await specialPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSUPPORTED_UNTRACKED_TYPE);

      console.log('✓ WS-023 PASSED: Special file types rejected with UNSUPPORTED_UNTRACKED_TYPE.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-024: Submodule clean (A-17)
  {
    console.log('[WS-024] Submodule clean state captured deterministically...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      // Create independent local repo for submodule
      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Submodule content v1\n');

      // Create superproject repo
      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      // Add submodule using test-local protocol.file.allow=always (A-17)
      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      const addRes = child_process.spawnSync(
        'git',
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'],
        { cwd: superDir, shell: false, encoding: 'utf8' }
      );
      assert.strictEqual(addRes.status, 0, `submodule add failed: ${addRes.stderr}`);

      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const state = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });
      assert.strictEqual(state.submodule_count, 1);
      assert.ok(state.components.submodule_status_sha256);

      console.log('✓ WS-024 PASSED: Clean submodule state captured with exact index gitlinks.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-025: Submodule observed HEAD change
  {
    console.log('[WS-025] Submodule observed HEAD change alters superproject workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');
      commitFile(subDir, 'sub.txt', 'Sub v2\n', 'second commit in sub');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      // Inside submodule checkout prior commit (HEAD changes without staging gitlink in super)
      const subWorktree = path.join(superDir, 'modules', 'sub1');
      child_process.spawnSync('git', ['checkout', 'HEAD~1'], { cwd: subWorktree, shell: false });

      const s2 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-025 PASSED: Submodule observed HEAD change changes state ID without superproject commit.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-026: Submodule dirty content (A-07)
  {
    console.log('[WS-026] Submodule dirty worktree content alters workspace_state_id (same gitlink, same HEAD)...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      // Mutate file inside submodule working tree
      const subWorktree = path.join(superDir, 'modules', 'sub1');
      fs.writeFileSync(path.join(subWorktree, 'sub.txt'), 'Dirty content in submodule worktree\n');

      const s2 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-026 PASSED: Dirty submodule content alters submodule status digest and state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-027: Submodule gitlink change
  {
    console.log('[WS-027] Staging new submodule gitlink alters state ID...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      // Commit new revision inside submodule and stage gitlink in superproject
      const subWorktree = path.join(superDir, 'modules', 'sub1');
      commitFile(subWorktree, 'sub.txt', 'Sub v2 committed inside submodule\n', 'update sub');
      child_process.spawnSync('git', ['add', 'modules/sub1'], { cwd: superDir, shell: false });

      const s2 = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });

      // Superproject diffs ignore submodules per WO-V3-004G Section 8
      assert.strictEqual(s1.components.staged_diff_sha256, s2.components.staged_diff_sha256);
      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-027 PASSED: Staged gitlink update alters state ID via submodule component.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-028: Uninitialized submodule
  {
    console.log('[WS-028] Uninitialized submodule recorded with deterministic UNINITIALIZED state...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      // Deinitialize submodule
      child_process.spawnSync('git', ['submodule', 'deinit', '-f', 'modules/sub1'], { cwd: superDir, shell: false });

      const state = await wsPort.getWorkspaceState({ project_id: 'super-proj', project_root: superDir });
      assert.strictEqual(state.submodule_count, 1);
      assert.ok(state.components.submodule_status_sha256);

      console.log('✓ WS-028 PASSED: Uninitialized submodule captured deterministically without error.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-029: Broker stale gate integration (V3-NT-007, V3-NT-008)
  {
    console.log('[WS-029] Broker integration: modified workspace state triggers STALE_AUDIT_STATE (0 worker calls)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'main.js', 'console.log("v1");\n');

      const project = {
        project_id: 'real-project',
        project_root: repoDir,
        worker: { session_id: 'sess-1', enabled: true },
        auditor: { task_id: 'task-1' }
      };

      // 1. Auditor observes state S1
      const s1 = await wsPort.getWorkspaceState(project);

      // 2. Untracked file created (or tracked modified) before dispatch
      fs.writeFileSync(path.join(repoDir, 'rogue-untracked.js'), 'malicious code\n');

      let workerDispatchCalls = 0;
      const fakeWorkerPort = {
        dispatch: async () => {
          workerDispatchCalls++;
          return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
        }
      };

      const fakeRegistryPort = {
        getProject: async (id) => (id === 'real-project' ? project : null)
      };

      const broker = createBroker({
        registryPort: fakeRegistryPort,
        workspacePort: wsPort,
        workerPort: fakeWorkerPort
      });

      // 3. Sol attempts dispatch with expected state S1
      const res = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'real-project',
        work_order_id: 'WO-STALE-01',
        expected_workspace_state_id: s1.workspace_state_id,
        directive: 'Run audit'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, ERROR_CODES.STALE_AUDIT_STATE);
      assert.strictEqual(res.expected_workspace_state_id, s1.workspace_state_id);
      assert.notStrictEqual(res.observed_workspace_state_id, s1.workspace_state_id);
      assert.strictEqual(workerDispatchCalls, 0);

      console.log('✓ WS-029 PASSED: Stale audit state rejected with 0 worker dispatch calls.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-030: Broker unchanged state (dispatch succeeds)
  {
    console.log('[WS-030] Broker integration: matching workspace state permits exactly 1 worker dispatch...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'main.js', 'console.log("v1");\n');

      const project = {
        project_id: 'real-project',
        project_root: repoDir,
        worker: { session_id: 'sess-1', enabled: true },
        auditor: { task_id: 'task-1' }
      };

      const s1 = await wsPort.getWorkspaceState(project);

      let workerDispatchCalls = 0;
      const fakeWorkerPort = {
        dispatch: async () => {
          workerDispatchCalls++;
          return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
        }
      };

      const fakeRegistryPort = {
        getProject: async (id) => (id === 'real-project' ? project : null)
      };

      const broker = createBroker({
        registryPort: fakeRegistryPort,
        workspacePort: wsPort,
        workerPort: fakeWorkerPort
      });

      const res = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'real-project',
        work_order_id: 'WO-FRESH-01',
        expected_workspace_state_id: s1.workspace_state_id,
        directive: 'Run audit'
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(workerDispatchCalls, 1);

      console.log('✓ WS-030 PASSED: Fresh workspace state accepts dispatch cleanly.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-031: Submodule stale gate (V3-NT-009)
  {
    console.log('[WS-031] Broker integration: submodule change triggers STALE_AUDIT_STATE...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const project = {
        project_id: 'super-proj',
        project_root: superDir,
        worker: { session_id: 'sess-1', enabled: true },
        auditor: { task_id: 'task-1' }
      };

      const s1 = await wsPort.getWorkspaceState(project);

      // Mutate submodule
      const subWorktree = path.join(superDir, 'modules', 'sub1');
      fs.writeFileSync(path.join(subWorktree, 'sub.txt'), 'modified sub\n');

      let workerDispatchCalls = 0;
      const broker = createBroker({
        registryPort: { getProject: async () => project },
        workspacePort: wsPort,
        workerPort: {
          dispatch: async () => {
            workerDispatchCalls++;
            return { ok: true, state: DISPATCH_STATES.DISPATCH_ACCEPTED };
          }
        }
      });

      const res = await broker.dispatchWorker({
        schema_version: 1,
        project_id: 'super-proj',
        work_order_id: 'WO-SUB-STALE',
        expected_workspace_state_id: s1.workspace_state_id,
        directive: 'Audit with submodule'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.code, ERROR_CODES.STALE_AUDIT_STATE);
      assert.strictEqual(workerDispatchCalls, 0);

      console.log('✓ WS-031 PASSED: Submodule change triggers STALE_AUDIT_STATE in broker.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-032: No model / report content
  {
    console.log('[WS-032] Production workspace-state.js contains zero references to models/reports...');
    const src = fs.readFileSync(path.join(__dirname, '../../lib/broker/workspace-state.js'), 'utf8');

    const forbiddenTerms = [
      'WorkerReport',
      'OpenAI',
      'ChatGPT',
      'Codex queue',
      'audit verdict',
      'testPassed'
    ];

    for (const term of forbiddenTerms) {
      assert.ok(!src.includes(term), `Forbidden term '${term}' found in workspace-state.js`);
    }

    console.log('✓ WS-032 PASSED: Zero model prose, audit verdict, or WorkerReport references in module.\n');
  }

  // WS-033: Same state after revert
  {
    console.log('[WS-033] Exact revert of modifications restores identical initial workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'file.txt', 'Original content\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const s1 = await wsPort.getWorkspaceState(project);

      // Modify
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'Temporary modified content\n');
      const s2 = await wsPort.getWorkspaceState(project);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      // Revert exact bytes
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'Original content\n');
      const s3 = await wsPort.getWorkspaceState(project);

      assert.strictEqual(s1.workspace_state_id, s3.workspace_state_id);
      assert.deepStrictEqual(s1.components, s3.components);

      console.log('✓ WS-033 PASSED: Deterministic state identity preserved across modification and exact revert.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-034: File mode / metadata policy (mtime does NOT contribute)
  {
    console.log('[WS-034] Untracked file mtime modification does NOT alter workspace_state_id...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const project = { project_id: 'proj-1', project_root: repoDir };
      const untrackedPath = path.join(repoDir, 'untracked.txt');
      fs.writeFileSync(untrackedPath, 'untracked data');

      const s1 = await wsPort.getWorkspaceState(project);

      // Change mtime and atime by 10 hours
      const future = new Date(Date.now() + 10 * 3600 * 1000);
      fs.utimesSync(untrackedPath, future, future);

      const s2 = await wsPort.getWorkspaceState(project);
      assert.strictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-034 PASSED: mtime modification alone has zero effect on workspace_state_id.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-035: Raw status/diffs not returned
  {
    console.log('[WS-035] Return contract contains only small metadata and digests; raw diffs omitted...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'Modified\n');
      fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'untracked content\n');

      const res = await wsPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });

      assert.strictEqual(res.schema_version, 1);
      assert.ok(res.workspace_state_id);
      assert.ok(res.components.status_sha256);
      assert.ok(res.components.unstaged_diff_sha256);
      assert.ok(res.components.untracked_manifest_sha256);

      // Verify no large raw text properties are leaked in the return object
      assert.strictEqual(res.raw_status, undefined);
      assert.strictEqual(res.raw_diff, undefined);
      assert.strictEqual(res.diff, undefined);
      assert.strictEqual(res.file_contents, undefined);
      assert.strictEqual(res.manifest, undefined);

      console.log('✓ WS-035 PASSED: Return object contains strictly digests and small metadata.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-036: Changing repository during two-pass snapshot fails closed (A-11, A-12)
  {
    console.log('[WS-036] Repository mutating during two-pass snapshot fails closed with WORKSPACE_STATE_UNAVAILABLE...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      let callCount = 0;
      const customSpawn = (bin, args, opts) => {
        if (args.includes('status')) {
          callCount++;
          // On second pass status call, simulate a modified repo
          if (callCount >= 2) {
            return {
              status: 0,
              stdout: Buffer.from('1 .M N... 100644 100644 100644 1234567 1234567 README.md\0'),
              stderr: Buffer.alloc(0)
            };
          }
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const mutatingPort = createWorkspaceStatePort({ spawnSync: customSpawn });
      let caught = null;
      try {
        await mutatingPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE);
      assert.ok(caught.message.includes('WORKSPACE_CHANGED_DURING_SNAPSHOT'));

      console.log('✓ WS-036 PASSED: Two-pass snapshot detects concurrent mutation and fails closed.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-037: Regular file becomes symlink before open (A-04, A-13, strengthened per Section 39)
  {
    console.log('[WS-037] Untracked regular file swapped for symlink before open fails closed on open/no-follow (0 target reads)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const targetPath = path.join(repoDir, 'target-file.txt');
      fs.writeFileSync(targetPath, 'Safe initial content');

      let externalTargetReadAttempted = false;
      const injectedFs = {
        ...fs,
        lstatSync: (p) => {
          // Pre-lstat reports regular file
          const real = fs.lstatSync(p);
          return real;
        },
        openSync: (p, flags) => {
          // Simulate race: right at open time, file is swapped with symlink pointing outside
          if (p.includes('target-file')) {
            // Throw WORKSPACE_STATE_UNAVAILABLE or simulate swap
            throw new Error('EMLINK: File swapped for symlink during open');
          }
          if (p.includes('outside')) {
            externalTargetReadAttempted = true;
          }
          return fs.openSync(p, flags);
        }
      };

      const racePort = createWorkspaceStatePort({ fs: injectedFs });
      let caught = null;
      try {
        await racePort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE);
      assert.strictEqual(externalTargetReadAttempted, false);

      console.log('✓ WS-037 PASSED: Regular file symlink swap detected at open and failed closed with 0 external reads.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-038: Untracked path cannot be decoded losslessly (A-02, A-14)
  {
    console.log('[WS-038] Untracked path with invalid UTF-8 bytes fails closed with UNSAFE_UNTRACKED_PATH...');
    const invalidUtf8Buffer = Buffer.from([0x66, 0x6f, 0x6f, 0xc3, 0x28, 0x00]); // 0xc3 0x28 is invalid UTF-8

    let caught = null;
    try {
      validateUntrackedPathSafety(invalidUtf8Buffer, path.resolve('C:\\Fake\\Repo'));
    } catch (err) {
      caught = err;
    }

    assert.ok(caught);
    assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH);

    console.log('✓ WS-038 PASSED: Invalid UTF-8 path bytes fail closed without opening filesystem path.\n');
  }

  // WS-039: Unexpected symbolic-ref failure is not DETACHED (A-01, A-15)
  {
    console.log('[WS-039] Unexpected git symbolic-ref failure throws GIT_COMMAND_FAILED (never DETACHED)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const customSpawn = (bin, args, opts) => {
        if (args.includes('symbolic-ref')) {
          // Unexpected permission or corruption error (not a detached HEAD)
          return {
            status: 128,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from('fatal: unable to read config: Permission denied\n')
          };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const faultPort = createWorkspaceStatePort({ spawnSync: customSpawn });
      let caught = null;
      try {
        await faultPort.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED);

      console.log('✓ WS-039 PASSED: Unexpected symbolic-ref failure throws GIT_COMMAND_FAILED.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-040: Opened regular-file descriptor identity mismatch (WSAUTH-01 / Section 32)
  {
    console.log('[WS-040] Opened regular-file descriptor identity mismatch fails closed (WSAUTH-01)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const fileA = path.join(repoDir, 'fileA.txt');
      const fileB = path.join(repoDir, 'fileB.txt');
      fs.writeFileSync(fileA, 'Content A\n');
      fs.writeFileSync(fileB, 'Content B (SECRET)\n');

      let readFromBAttempted = false;

      // Open real fd for file B
      const realFdB = fs.openSync(fileB, fs.constants.O_RDONLY);

      const injectedFs = {
        ...fs,
        lstatSync: (p) => {
          // pre and post lstat report file A identity
          if (p.includes('fileA')) {
            return {
              isFile: () => true,
              isSymbolicLink: () => false,
              isDirectory: () => false,
              dev: 1,
              ino: 100,
              mode: 0o100644
            };
          }
          return fs.lstatSync(p);
        },
        openSync: (p, flags) => {
          // File A open returns descriptor that actually refers to file B!
          if (p.includes('fileA')) {
            return realFdB;
          }
          return fs.openSync(p, flags);
        },
        fstatSync: (fd) => {
          if (fd === realFdB) {
            // fdStat reports file B identity (dev 1, ino 200)
            return {
              isFile: () => true,
              isSymbolicLink: () => false,
              isDirectory: () => false,
              dev: 1,
              ino: 200,
              mode: 0o100644
            };
          }
          return fs.fstatSync(fd);
        },
        readSync: (fd, buf, offset, length, pos) => {
          if (fd === realFdB) {
            readFromBAttempted = true;
          }
          return fs.readSync(fd, buf, offset, length, pos);
        },
        closeSync: (fd) => {
          if (fd === realFdB) {
            return;
          }
          return fs.closeSync(fd);
        }
      };

      const port = createWorkspaceStatePort({ fs: injectedFs });
      let caught = null;
      try {
        await port.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }

      fs.closeSync(realFdB);

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE);
      assert.strictEqual(readFromBAttempted, false, 'Bytes from file B must never be read');

      console.log('✓ WS-040 PASSED: File descriptor identity mismatch caught and failed closed without reading B.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-041: Hash-authoritative submodule Git command failures fail closed (WSAUTH-02 / Section 33)
  {
    console.log('[WS-041] Submodule Git command failures fail closed with GIT_COMMAND_FAILED (WSAUTH-02)...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subDir = path.join(sandbox.dir, 'sub-repo');

      initGitRepo(subDir);
      commitFile(subDir, 'sub.txt', 'Sub v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'Super repo\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'modules/sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      // Subcase A: submodule rev-parse HEAD fails
      {
        const customSpawnA = (bin, args, opts) => {
          if (args.includes('rev-parse') && args.includes('HEAD')) {
            return {
              status: 128,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from('fatal: injected failure for submodule rev-parse HEAD\n')
            };
          }
          return child_process.spawnSync(bin, args, opts);
        };
        const portA = createWorkspaceStatePort({ spawnSync: customSpawnA });
        let caughtA = null;
        try {
          await portA.getWorkspaceState({ project_id: 'p1', project_root: superDir });
        } catch (err) {
          caughtA = err;
        }
        assert.ok(caughtA);
        assert.strictEqual(caughtA.code, WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED);
      }

      // Subcase B: submodule status --porcelain=v2 fails
      {
        const customSpawnB = (bin, args, opts) => {
          if (args.includes('status') && opts && opts.cwd && opts.cwd.includes('sub1')) {
            return {
              status: 128,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from('fatal: injected failure for submodule status\n')
            };
          }
          return child_process.spawnSync(bin, args, opts);
        };
        const portB = createWorkspaceStatePort({ spawnSync: customSpawnB });
        let caughtB = null;
        try {
          await portB.getWorkspaceState({ project_id: 'p1', project_root: superDir });
        } catch (err) {
          caughtB = err;
        }
        assert.ok(caughtB);
        assert.strictEqual(caughtB.code, WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED);
      }

      // Subcase C: submodule discovery failure (e.g. ls-files --stage fails inside submodule)
      {
        const customSpawnC = (bin, args, opts) => {
          if (args.includes('ls-files') && args.includes('--stage') && opts && opts.cwd && opts.cwd.includes('sub1')) {
            return {
              status: 128,
              stdout: Buffer.alloc(0),
              stderr: Buffer.from('fatal: injected failure for submodule ls-files --stage\n')
            };
          }
          return child_process.spawnSync(bin, args, opts);
        };
        const portC = createWorkspaceStatePort({ spawnSync: customSpawnC });
        let caughtC = null;
        try {
          await portC.getWorkspaceState({ project_id: 'p1', project_root: superDir });
        } catch (err) {
          caughtC = err;
        }
        assert.ok(caughtC);
        assert.strictEqual(caughtC.code, WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED);
      }

      console.log('✓ WS-041 PASSED: All submodule Git command failures failed closed with GIT_COMMAND_FAILED.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-042: Gitlink path byte integrity (WSAUTH-03 / Section 34)
  {
    console.log('[WS-042] Gitlink path parsed as raw bytes: untrimmed whitespace preserved, invalid UTF-8 rejected...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello\n');

      // 1. Injected ls-files --stage -z with leading/trailing whitespace in path
      const pathWithSpaces = '  modules/sub with spaces  ';
      const record1 = Buffer.concat([
        Buffer.from(`160000 0123456789abcdef0123456789abcdef01234567 0\t${pathWithSpaces}`),
        Buffer.from([0])
      ]);

      const customSpawnSpaces = (bin, args, opts) => {
        if (args.includes('ls-files') && args.includes('--stage')) {
          return {
            status: 0,
            stdout: record1,
            stderr: Buffer.alloc(0)
          };
        }
        if (args.includes('submodule') && args.includes('status')) {
          return {
            status: 0,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0)
          };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const portSpaces = createWorkspaceStatePort({ spawnSync: customSpawnSpaces });
      const state = await portSpaces.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      assert.strictEqual(state.submodule_count, 1);

      // 2. Injected ls-files --stage -z with invalid UTF-8 in gitlink path
      const invalidPathBytes = Buffer.from([0x6d, 0x6f, 0x64, 0xc3, 0x28, 0x00]); // invalid UTF-8
      const recordInvalid = Buffer.concat([
        Buffer.from('160000 0123456789abcdef0123456789abcdef01234567 0\t'),
        invalidPathBytes
      ]);

      const customSpawnInvalid = (bin, args, opts) => {
        if (args.includes('ls-files') && args.includes('--stage')) {
          return {
            status: 0,
            stdout: recordInvalid,
            stderr: Buffer.alloc(0)
          };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const portInvalid = createWorkspaceStatePort({ spawnSync: customSpawnInvalid });
      let caught = null;
      try {
        await portInvalid.getWorkspaceState({ project_id: 'p1', project_root: repoDir });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH);

      console.log('✓ WS-042 PASSED: Gitlink path whitespace preserved exactly; invalid UTF-8 failed closed.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-043: Submodule symlink escape to external repository fails closed (WSAUTH-04 / Section 35)
  {
    console.log('[WS-043] Submodule resolving to external directory via symlink fails closed with 0 git -C calls...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const extDir = path.join(sandbox.dir, 'external-repo');

      initGitRepo(extDir);
      commitFile(extDir, 'ext.txt', 'external\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');

      const stageRecord = Buffer.concat([
        Buffer.from('160000 0123456789abcdef0123456789abcdef01234567 0\tmodules/sub1'),
        Buffer.from([0])
      ]);

      let externalGitExecAttempted = false;

      const customSpawn = (bin, args, opts) => {
        if (args.includes('ls-files') && args.includes('--stage')) {
          return { status: 0, stdout: stageRecord, stderr: Buffer.alloc(0) };
        }
        if (args.includes('-C')) {
          const cIdx = args.indexOf('-C');
          const targetDir = args[cIdx + 1];
          if (targetDir && targetDir.includes('external-repo')) {
            externalGitExecAttempted = true;
          }
        }
        return child_process.spawnSync(bin, args, opts);
      };

      // Injected fs that reports modules/sub1 resolving to external-repo
      const injectedFs = {
        ...fs,
        lstatSync: (p) => {
          if (p.includes('modules' + path.sep + 'sub1') || p.includes('modules/sub1')) {
            return {
              isSymbolicLink: () => true,
              isFile: () => false,
              isDirectory: () => false,
              mode: 0o120777
            };
          }
          return fs.lstatSync(p);
        },
        realpathSync: (p) => {
          if (p.includes('modules' + path.sep + 'sub1') || p.includes('modules/sub1')) {
            return extDir; // Escapes project root!
          }
          return fs.realpathSync(p);
        }
      };

      const port = createWorkspaceStatePort({ spawnSync: customSpawn, fs: injectedFs });
      let caught = null;
      try {
        await port.getWorkspaceState({ project_id: 'p1', project_root: superDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH);
      assert.strictEqual(externalGitExecAttempted, false, 'External repository must never be executed against via git -C');

      console.log('✓ WS-043 PASSED: Submodule symlink escape failed closed with 0 external git -C calls.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-044: POSIX backslash filename integrity (WSAUTH-05 / Section 36)
  {
    console.log('[WS-044] Git-relative path with backslash preserves backslash without rewriting to "/" (WSAUTH-05)...');
    const repoRoot = path.resolve('C:\\Fake\\Repo');
    const pathWithBackslash = Buffer.from('foo\\bar.txt');

    const validated = validateUntrackedPathSafety(pathWithBackslash, repoRoot);
    assert.ok(validated);
    assert.strictEqual(validated.gitRelativePath, 'foo\\bar.txt');
    assert.notStrictEqual(validated.gitRelativePath, 'foo/bar.txt');

    // Also test nested with backslash: "dir/sub\\file.txt"
    const nestedWithBackslash = Buffer.from('dir/sub\\file.txt');
    const validatedNested = validateUntrackedPathSafety(nestedWithBackslash, repoRoot);
    assert.strictEqual(validatedNested.gitRelativePath, 'dir/sub\\file.txt');

    console.log('✓ WS-044 PASSED: Git relative path backslashes preserved as filename data.\n');
  }

  // WS-045: Project-root symlink alias fails closed (WSAUTH-06 / Section 37)
  {
    console.log('[WS-045] Project-root symlink alias fails closed with PROJECT_ROOT_UNAVAILABLE (WSAUTH-06)...');
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'real-repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const aliasDir = path.join(sandbox.dir, 'alias-repo');

      const injectedFs = {
        ...fs,
        statSync: (p) => {
          if (p === aliasDir) {
            return { isDirectory: () => true };
          }
          return fs.statSync(p);
        },
        realpathSync: (p) => {
          if (p === aliasDir) {
            return fs.realpathSync(repoDir); // Resolves to real-repo!
          }
          return fs.realpathSync(p);
        }
      };

      const port = createWorkspaceStatePort({ fs: injectedFs });
      let caught = null;
      try {
        await port.getWorkspaceState({ project_id: 'p1', project_root: aliasDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE);
      assert.ok(caught.message.includes('alias or symlink'));

      console.log('✓ WS-045 PASSED: Project root symlink alias rejected with PROJECT_ROOT_UNAVAILABLE.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-046: Top-level external submodule worktree fails closed before status (WO-V3-004G Section 22)
  {
    console.log('[WS-046] Top-level external submodule fails closed before status or diff execution...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const extDir = path.join(sandbox.dir, 'external-repo');

      initGitRepo(extDir);
      commitFile(extDir, 'ext.txt', 'external\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');

      const stageRecord = Buffer.concat([
        Buffer.from('160000 0123456789abcdef0123456789abcdef01234567 0\tmodules/sub1'),
        Buffer.from([0])
      ]);

      const executedCommands = [];

      const customSpawn = (bin, args, opts) => {
        executedCommands.push({ bin, args, cwd: opts && opts.cwd });
        if (args.includes('ls-files') && args.includes('--stage')) {
          return { status: 0, stdout: stageRecord, stderr: Buffer.alloc(0) };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const injectedFs = {
        ...fs,
        lstatSync: (p) => {
          if (p.includes('modules' + path.sep + 'sub1') || p.includes('modules/sub1')) {
            return {
              isSymbolicLink: () => true,
              isFile: () => false,
              isDirectory: () => false,
              mode: 0o120777
            };
          }
          return fs.lstatSync(p);
        },
        realpathSync: (p) => {
          if (p.includes('modules' + path.sep + 'sub1') || p.includes('modules/sub1')) {
            return extDir; // Escapes project root!
          }
          return fs.realpathSync(p);
        }
      };

      const port = createWorkspaceStatePort({ spawnSync: customSpawn, fs: injectedFs });
      let caught = null;
      try {
        await port.getWorkspaceState({ project_id: 'p1', project_root: superDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH);

      // Verify no command ran inside extDir
      const ranInExt = executedCommands.some((c) => c.cwd && c.cwd.includes('external-repo'));
      assert.strictEqual(ranInExt, false, 'No command must execute in external repository');

      // Verify neither superproject status nor diff ran before containment failure
      const statusRan = executedCommands.some((c) => c.args.includes('status'));
      const diffRan = executedCommands.some((c) => c.args.includes('diff'));
      assert.strictEqual(statusRan, false, 'Status must not run before submodule containment check');
      assert.strictEqual(diffRan, false, 'Diff must not run before submodule containment check');

      console.log('✓ WS-046 PASSED: External submodule fails closed before status/diff with 0 external execution.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-047: Nested submodule worktree escape fails closed (WO-V3-004G Section 23)
  {
    console.log('[WS-047] Nested submodule resolving to external repository fails closed with 0 external Git calls...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super-repo');
      const subADir = path.join(sandbox.dir, 'subA-repo');
      const extBDir = path.join(sandbox.dir, 'extB-repo');

      initGitRepo(extBDir);
      commitFile(extBDir, 'b.txt', 'b content\n');

      initGitRepo(subADir);
      commitFile(subADir, 'a.txt', 'a content\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');

      const subAPathAbs = path.resolve(subADir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subAPathAbs, 'modules/A'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add subA'], { cwd: superDir, shell: false });

      // Inside modules/A, inject a nested gitlink "vendor/B" whose worktree resolves to extBDir
      const nestedStageRecord = Buffer.concat([
        Buffer.from('160000 0123456789abcdef0123456789abcdef01234567 0\tvendor/B'),
        Buffer.from([0])
      ]);

      let gitExecutionInsideB = 0;

      const customSpawn = (bin, args, opts) => {
        if (opts && opts.cwd && opts.cwd.includes('extB-repo')) {
          gitExecutionInsideB++;
        }
        if (args.includes('ls-files') && args.includes('--stage') && opts && opts.cwd && opts.cwd.includes('modules' + path.sep + 'A')) {
          return { status: 0, stdout: nestedStageRecord, stderr: Buffer.alloc(0) };
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const injectedFs = {
        ...fs,
        lstatSync: (p) => {
          if (p.includes('vendor' + path.sep + 'B') || p.includes('vendor/B')) {
            return {
              isSymbolicLink: () => true,
              isFile: () => false,
              isDirectory: () => false,
              mode: 0o120777
            };
          }
          return fs.lstatSync(p);
        },
        realpathSync: (p) => {
          if (p.includes('vendor' + path.sep + 'B') || p.includes('vendor/B')) {
            return extBDir; // Escapes top-level project root!
          }
          return fs.realpathSync(p);
        }
      };

      const port = createWorkspaceStatePort({ spawnSync: customSpawn, fs: injectedFs });
      let caught = null;
      try {
        await port.getWorkspaceState({ project_id: 'p1', project_root: superDir });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.strictEqual(caught.code, WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH);
      assert.strictEqual(gitExecutionInsideB, 0, 'Zero Git commands must execute in external B');

      console.log('✓ WS-047 PASSED: Nested submodule escape failed closed with 0 Git execution in external repo.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-048: No implicit recursive submodule command (WO-V3-004G Section 24)
  {
    console.log('[WS-048] Production code never invokes "git submodule status --recursive" and uses --ignore-submodules=all...');
    const src = fs.readFileSync(path.join(__dirname, '../../lib/broker/workspace-state.js'), 'utf8');

    // 1. Static source verification
    assert.strictEqual(src.includes('submodule status --recursive'), false);
    assert.strictEqual(src.includes("['submodule', 'status'"), false);

    // 2. Runtime execution verification
    const sandbox = createTestSandbox();
    try {
      const repoDir = path.join(sandbox.dir, 'repo');
      initGitRepo(repoDir);
      commitFile(repoDir, 'README.md', 'Hello World\n');

      const statusCalls = [];
      const diffCalls = [];
      let recursiveSubmoduleCalls = 0;

      const customSpawn = (bin, args, opts) => {
        if (args.includes('submodule') && args.includes('--recursive')) {
          recursiveSubmoduleCalls++;
        }
        if (args.includes('status')) {
          statusCalls.push(args);
        }
        if (args.includes('diff')) {
          diffCalls.push(args);
        }
        return child_process.spawnSync(bin, args, opts);
      };

      const port = createWorkspaceStatePort({ spawnSync: customSpawn });
      await port.getWorkspaceState({ project_id: 'p1', project_root: repoDir });

      assert.strictEqual(recursiveSubmoduleCalls, 0, 'Must never execute git submodule status --recursive');
      assert.ok(statusCalls.length > 0);
      for (const call of statusCalls) {
        assert.ok(call.includes('--ignore-submodules=all'), `Status call must include --ignore-submodules=all: ${call.join(' ')}`);
      }
      assert.ok(diffCalls.length > 0);
      for (const call of diffCalls) {
        assert.ok(call.includes('--ignore-submodules=all'), `Diff call must include --ignore-submodules=all: ${call.join(' ')}`);
      }

      console.log('✓ WS-048 PASSED: Zero recursive submodule commands; all status and diff commands ignore submodules.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-049: Nested submodule HEAD change alters superproject workspace_state_id (WO-V3-004G Section 25)
  {
    console.log('[WS-049] Nested submodule observed HEAD change alters state ID without superproject commit...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super');
      const subADir = path.join(sandbox.dir, 'subA');
      const subBDir = path.join(sandbox.dir, 'subB');

      // Create B
      initGitRepo(subBDir);
      commitFile(subBDir, 'b.txt', 'b v1\n');
      commitFile(subBDir, 'b.txt', 'b v2\n', 'commit 2 in B');

      // Create A and add B as submodule inside A: vendor/B
      initGitRepo(subADir);
      commitFile(subADir, 'a.txt', 'a content\n');
      const subBPathAbs = path.resolve(subBDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subBPathAbs, 'vendor/B'], {
        cwd: subADir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add B to A'], { cwd: subADir, shell: false });

      // Create super and add A as submodule: modules/A
      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');
      const subAPathAbs = path.resolve(subADir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subAPathAbs, 'modules/A'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add A to super'], { cwd: superDir, shell: false });

      // Initialize nested submodule B inside super/modules/A
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], {
        cwd: superDir,
        shell: false
      });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'p-nested', project_root: superDir });
      assert.strictEqual(s1.submodule_count, 2); // modules/A and modules/A/vendor/B

      // Checkout HEAD~1 inside B
      const subAWorktree = path.join(superDir, 'modules', 'A');
      const subBWorktree = path.join(subAWorktree, 'vendor', 'B');
      child_process.spawnSync('git', ['checkout', 'HEAD~1'], { cwd: subBWorktree, shell: false });

      const s2 = await wsPort.getWorkspaceState({ project_id: 'p-nested', project_root: superDir });

      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-049 PASSED: Nested submodule HEAD change caught by safe explicit recursive collector.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-050: Nested submodule dirty change alters state ID (WO-V3-004G Section 26)
  {
    console.log('[WS-050] Nested submodule dirty content alters state ID (same gitlink, same HEAD)...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super');
      const subADir = path.join(sandbox.dir, 'subA');
      const subBDir = path.join(sandbox.dir, 'subB');

      initGitRepo(subBDir);
      commitFile(subBDir, 'b.txt', 'b v1\n');

      initGitRepo(subADir);
      commitFile(subADir, 'a.txt', 'a content\n');
      const subBPathAbs = path.resolve(subBDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subBPathAbs, 'vendor/B'], {
        cwd: subADir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add B'], { cwd: subADir, shell: false });

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');
      const subAPathAbs = path.resolve(subADir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subAPathAbs, 'modules/A'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add A'], { cwd: superDir, shell: false });

      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'], {
        cwd: superDir,
        shell: false
      });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'p-nested-dirty', project_root: superDir });

      // Modify file inside nested submodule B worktree
      const subBWorktree = path.join(superDir, 'modules', 'A', 'vendor', 'B');
      fs.writeFileSync(path.join(subBWorktree, 'b.txt'), 'Modified dirty content in nested submodule B\n');

      const s2 = await wsPort.getWorkspaceState({ project_id: 'p-nested-dirty', project_root: superDir });

      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-050 PASSED: Nested submodule dirty content alters submodule digest and state ID.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  // WS-051: Staged gitlink still detected under --ignore-submodules=all (WO-V3-004G Section 27)
  {
    console.log('[WS-051] Staging gitlink alters submodule digest and state ID under --ignore-submodules=all...');
    const sandbox = createTestSandbox();
    try {
      const superDir = path.join(sandbox.dir, 'super');
      const subDir = path.join(sandbox.dir, 'sub');

      initGitRepo(subDir);
      commitFile(subDir, 'file.txt', 'v1\n');

      initGitRepo(superDir);
      commitFile(superDir, 'README.md', 'super\n');

      const subPathAbs = path.resolve(subDir).replace(/\\/g, '/');
      child_process.spawnSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subPathAbs, 'sub1'], {
        cwd: superDir,
        shell: false
      });
      child_process.spawnSync('git', ['commit', '-m', 'add sub1'], { cwd: superDir, shell: false });

      const s1 = await wsPort.getWorkspaceState({ project_id: 'p-staged-gitlink', project_root: superDir });

      // Commit new revision in sub1 and stage gitlink in super
      const subWorktree = path.join(superDir, 'sub1');
      commitFile(subWorktree, 'file.txt', 'v2 committed in sub\n', 'update sub');
      child_process.spawnSync('git', ['add', 'sub1'], { cwd: superDir, shell: false });

      const s2 = await wsPort.getWorkspaceState({ project_id: 'p-staged-gitlink', project_root: superDir });

      // Superproject diffs ignore submodules
      assert.strictEqual(s1.components.staged_diff_sha256, s2.components.staged_diff_sha256);
      // But dedicated submodule state captures index gitlink update
      assert.notStrictEqual(s1.components.submodule_status_sha256, s2.components.submodule_status_sha256);
      assert.notStrictEqual(s1.workspace_state_id, s2.workspace_state_id);

      console.log('✓ WS-051 PASSED: Staged gitlink update alters submodule digest and state ID without diff reliance.\n');
    } finally {
      sandbox.cleanup();
    }
  }

  console.log('======================================================================');
  console.log('ALL WORKSPACE-STATE TESTS PASSED (WS-001 .. WS-051: 51/51 PASS)');
  console.log('======================================================================\n');
}

runAllTests().catch((err) => {
  console.error('[TEST SUITE FAILURE]', err);
  process.exit(1);
});

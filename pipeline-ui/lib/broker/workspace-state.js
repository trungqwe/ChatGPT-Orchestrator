'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const child_process = require('child_process');
const { computeRootIdentityKey } = require('./registry');

/**
 * Stable Machine-Readable Workspace State Error Codes (Section 50)
 */
const WORKSPACE_STATE_ERROR_CODES = Object.freeze({
  INVALID_PROJECT: 'INVALID_PROJECT',
  PROJECT_ROOT_UNAVAILABLE: 'PROJECT_ROOT_UNAVAILABLE',
  PROJECT_ROOT_NOT_GIT_TOPLEVEL: 'PROJECT_ROOT_NOT_GIT_TOPLEVEL',
  NOT_GIT_REPOSITORY: 'NOT_GIT_REPOSITORY',
  HEAD_UNAVAILABLE: 'HEAD_UNAVAILABLE',
  GIT_COMMAND_FAILED: 'GIT_COMMAND_FAILED',
  UNSAFE_UNTRACKED_PATH: 'UNSAFE_UNTRACKED_PATH',
  UNSUPPORTED_UNTRACKED_TYPE: 'UNSUPPORTED_UNTRACKED_TYPE',
  WORKSPACE_STATE_UNAVAILABLE: 'WORKSPACE_STATE_UNAVAILABLE'
});

/**
 * Structured Workspace State Error
 */
class WorkspaceStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceStateError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Constants and Bounds
 */
const STATE_VERSION = 'workspace-state-v1';
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024; // 64 MiB (A-09 / WSAUTH-07)
const MAX_STDERR_DIAGNOSTIC_BYTES = 8 * 1024; // 8 KiB (Section 48)

/**
 * Deterministic canonical JSON serialization (Section 38).
 * Ensures object key order is lexicographically sorted and arrays retain intentional order.
 */
function canonicalJsonStringify(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalJsonStringify).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(val[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Compute SHA-256 hex digest of a Buffer or UTF-8 string.
 */
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Prove descriptor and pathname share exact semantic file identity (WSAUTH-01 / A-04).
 * Compares device, inode number, and regular file type.
 */
function sameFileIdentity(s1, s2) {
  if (!s1 || !s2) {
    return false;
  }
  if (typeof s1.isFile !== 'function' || !s1.isFile() || typeof s2.isFile !== 'function' || !s2.isFile()) {
    return false;
  }
  if (s1.dev == null || s2.dev == null || s1.ino == null || s2.ino == null) {
    return false;
  }
  if (s1.dev !== s2.dev || s1.ino !== s2.ino) {
    return false;
  }
  return true;
}

/**
 * Execute Git command using argument-array execution (Section 17 / A-08 / A-09).
 * Returns raw Buffer outputs. Fails closed on spawn error or buffer overflow.
 */
function runGitCommand(gitBinary, args, cwd, customSpawn = child_process.spawnSync) {
  const result = customSpawn(gitBinary, args, {
    cwd,
    shell: false,
    encoding: null, // Raw Buffer (Section 18)
    maxBuffer: GIT_MAX_BUFFER_BYTES
  });

  if (result.error) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `Git execution failed for '${args[0]}': ${result.error.message}`,
      { args, error: result.error.message }
    );
  }

  // Check if execution failed due to buffer overflow
  if (result.status === null && result.signal === 'SIGTERM') {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `Git command '${args[0]}' exceeded maximum output buffer (${GIT_MAX_BUFFER_BYTES} bytes)`,
      { args }
    );
  }

  return result;
}

/**
 * Extract bounded stderr diagnostic string (Section 48).
 */
function extractBoundedStderr(stderrBuffer) {
  if (!stderrBuffer || !stderrBuffer.length) {
    return '';
  }
  const bounded = stderrBuffer.subarray(0, MAX_STDERR_DIAGNOSTIC_BYTES);
  return bounded.toString('utf8');
}

/**
 * Validate and resolve Git top-level against canonical project root (Section 15 / A-08 / A-10).
 */
function resolveGitToplevel(gitBinary, projectRoot, customSpawn, customFs) {
  const res = runGitCommand(gitBinary, ['rev-parse', '--show-toplevel'], projectRoot, customSpawn);
  const stderr = extractBoundedStderr(res.stderr);

  if (res.status !== 0) {
    if (stderr.includes('not a git repository') || stderr.includes('Not a git repository')) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.NOT_GIT_REPOSITORY,
        `Project root '${projectRoot}' is not a Git repository: ${stderr}`,
        { stderr }
      );
    }
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git rev-parse --show-toplevel failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  const toplevelRaw = res.stdout.toString('utf8').trim();
  if (!toplevelRaw) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.NOT_GIT_REPOSITORY,
      `git rev-parse --show-toplevel returned empty path`
    );
  }

  // Canonical realpath comparison
  let canonicalToplevel;
  try {
    const realpathFn = customFs.realpathSync.native || customFs.realpathSync;
    canonicalToplevel = realpathFn(toplevelRaw);
  } catch (err) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
      `Failed to canonicalize Git toplevel '${toplevelRaw}': ${err.message}`
    );
  }

  const toplevelIdentity = computeRootIdentityKey(canonicalToplevel);
  const projectRootIdentity = computeRootIdentityKey(projectRoot);

  if (toplevelIdentity !== projectRootIdentity) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_NOT_GIT_TOPLEVEL,
      `Project root '${projectRoot}' is a subdirectory of Git repository '${canonicalToplevel}'. Subdirectory roots are not supported in v3 MVP.`
    );
  }

  return canonicalToplevel;
}

/**
 * Resolve current branch name or DETACHED sentinel (Section 19 / A-01 / A-08).
 */
function resolveGitBranch(gitBinary, projectRoot, customSpawn) {
  const res = runGitCommand(gitBinary, ['symbolic-ref', '--quiet', '--short', 'HEAD'], projectRoot, customSpawn);

  if (res.status === 0) {
    const branch = res.stdout.toString('utf8').trim();
    if (!branch) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
        'git symbolic-ref returned empty branch name'
      );
    }
    return branch;
  }

  // Check if failure is expected detached HEAD (A-01)
  const stderr = extractBoundedStderr(res.stderr);
  if (
    res.status === 1 &&
    (!stderr ||
      stderr.includes('not a symbolic ref') ||
      stderr.includes('ref HEAD is not a symbolic ref'))
  ) {
    return 'DETACHED';
  }

  throw new WorkspaceStateError(
    WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
    `git symbolic-ref failed unexpectedly: ${stderr}`,
    { status: res.status, stderr }
  );
}

/**
 * Resolve commit SHA of HEAD (Section 20 / A-08).
 */
function resolveGitHead(gitBinary, projectRoot, customSpawn) {
  const res = runGitCommand(gitBinary, ['rev-parse', '--verify', 'HEAD'], projectRoot, customSpawn);

  if (res.status !== 0) {
    const stderr = extractBoundedStderr(res.stderr);
    if (
      stderr.includes('Needed a single revision') ||
      stderr.includes("ambiguous argument 'HEAD'") ||
      stderr.includes('unknown revision')
    ) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.HEAD_UNAVAILABLE,
        `Repository has unborn HEAD (no commits): ${stderr}`,
        { stderr }
      );
    }
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git rev-parse --verify HEAD failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  const head = res.stdout.toString('utf8').trim();
  if (!head || head.length !== 40) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.HEAD_UNAVAILABLE,
      `Invalid commit SHA returned for HEAD: '${head}'`
    );
  }

  return head;
}

/**
 * Resolve porcelain v2 status digest (Section 21).
 */
function resolveStatusDigest(gitBinary, projectRoot, customSpawn) {
  const res = runGitCommand(
    gitBinary,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    projectRoot,
    customSpawn
  );

  if (res.status !== 0) {
    const stderr = extractBoundedStderr(res.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git status failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  return sha256Hex(res.stdout);
}

/**
 * Resolve staged diff digest (Section 22 / A-18).
 */
function resolveStagedDiffDigest(gitBinary, projectRoot, customSpawn) {
  const res = runGitCommand(
    gitBinary,
    [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--diff-algorithm=myers'
    ],
    projectRoot,
    customSpawn
  );

  if (res.status !== 0) {
    const stderr = extractBoundedStderr(res.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git diff --cached failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  return sha256Hex(res.stdout);
}

/**
 * Resolve unstaged diff digest (Section 23 / A-18).
 */
function resolveUnstagedDiffDigest(gitBinary, projectRoot, customSpawn) {
  const res = runGitCommand(
    gitBinary,
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--no-color',
      '--diff-algorithm=myers'
    ],
    projectRoot,
    customSpawn
  );

  if (res.status !== 0) {
    const stderr = extractBoundedStderr(res.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git diff failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  return sha256Hex(res.stdout);
}

/**
 * Validate untracked path safety against project root (A-02 / A-03 / WSAUTH-05).
 * Preserves raw Git relative path without replacing '\' with '/'.
 */
function validateUntrackedPathSafety(entryBuf, projectRoot) {
  // Strict UTF-8 decoding (A-02)
  let gitRelativePath;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    gitRelativePath = decoder.decode(entryBuf);
  } catch (err) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
      `Untracked path contains invalid UTF-8 byte sequence: ${err.message}`
    );
  }

  if (!gitRelativePath) {
    return null;
  }

  // Reject absolute paths
  if (gitRelativePath.startsWith('/') || /^[a-zA-Z]:/.test(gitRelativePath)) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
      `Untracked path must be relative to project root: '${gitRelativePath}'`
    );
  }

  // Segment-based traversal check (A-03 / WSAUTH-05): Git relative paths use '/' as directory separator
  const segments = gitRelativePath.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
        `Untracked path contains directory traversal segment '..': '${gitRelativePath}'`
      );
    }
  }

  // Resolve filesystem path by joining segments
  const fullPath = path.resolve(projectRoot, ...segments);
  const relCheck = path.relative(projectRoot, fullPath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
      `Untracked path resolves outside project root: '${gitRelativePath}'`
    );
  }

  return {
    gitRelativePath,
    relPath: gitRelativePath,
    fullPath
  };
}

/**
 * Collect nonignored untracked manifest with symlink safety and race detection (Sections 25-36 / A-02-A-05 / WSAUTH-01 / WSAUTH-05).
 */
function collectUntrackedManifest(gitBinary, projectRoot, customSpawn, customFs) {
  const res = runGitCommand(
    gitBinary,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    projectRoot,
    customSpawn
  );

  if (res.status !== 0) {
    const stderr = extractBoundedStderr(res.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git ls-files failed: ${stderr}`,
      { status: res.status, stderr }
    );
  }

  // NUL-delimited extraction (A-02)
  const buf = res.stdout;
  const rawEntries = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) {
        rawEntries.push(buf.subarray(start, i));
      }
      start = i + 1;
    }
  }
  if (start < buf.length) {
    rawEntries.push(buf.subarray(start));
  }

  const manifestEntries = [];

  for (const entryBuf of rawEntries) {
    const validated = validateUntrackedPathSafety(entryBuf, projectRoot);
    if (!validated) {
      continue;
    }
    const { gitRelativePath, fullPath } = validated;

    // Pre-lstat
    let preStat;
    try {
      preStat = customFs.lstatSync(fullPath);
    } catch (err) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
        `Failed to lstat untracked entry '${gitRelativePath}': ${err.message}`
      );
    }

    if (preStat.isSymbolicLink()) {
      // Symlink: read raw target bytes (A-05), NEVER follow external target (Section 34)
      let targetBuf;
      try {
        targetBuf = customFs.readlinkSync(fullPath, { encoding: 'buffer' });
      } catch (err) {
        throw new WorkspaceStateError(
          WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
          `Failed to readlink untracked symlink '${gitRelativePath}': ${err.message}`
        );
      }
      const targetSha256 = sha256Hex(targetBuf);

      manifestEntries.push({
        path: gitRelativePath,
        type: 'symlink',
        target_sha256: targetSha256,
        target_bytes: targetBuf.length,
        mode: preStat.mode
      });
    } else if (preStat.isFile()) {
      // Regular file safe open & race verification sequence (A-04 / WSAUTH-01)
      const openFlags = (fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0) | fs.constants.O_RDONLY;
      let fd;
      try {
        fd = customFs.openSync(fullPath, openFlags);
      } catch (err) {
        throw new WorkspaceStateError(
          WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
          `Failed to open untracked file '${gitRelativePath}': ${err.message}`
        );
      }

      try {
        const fdStat = customFs.fstatSync(fd);
        const postStat = customFs.lstatSync(fullPath);

        if (!preStat.isFile() || !fdStat.isFile() || !postStat.isFile()) {
          throw new WorkspaceStateError(
            WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
            `Untracked file '${gitRelativePath}' changed from regular file during open`
          );
        }

        // Prove pre == fd and fd == post identity (WSAUTH-01 / A-04)
        if (!sameFileIdentity(preStat, fdStat) || !sameFileIdentity(fdStat, postStat)) {
          throw new WorkspaceStateError(
            WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
            `Untracked file '${gitRelativePath}' descriptor identity does not match pathname identity (pre/fd/post mismatch)`
          );
        }

        // Incremental raw byte hashing from validated fd (Section 30, 31)
        const hash = crypto.createHash('sha256');
        const chunkSize = 64 * 1024;
        const chunkBuf = Buffer.alloc(chunkSize);
        let bytesRead = 0;
        let totalBytes = 0;

        while ((bytesRead = customFs.readSync(fd, chunkBuf, 0, chunkSize, null)) > 0) {
          hash.update(chunkBuf.subarray(0, bytesRead));
          totalBytes += bytesRead;
        }

        manifestEntries.push({
          path: gitRelativePath,
          type: 'file',
          size: totalBytes,
          mode: preStat.mode,
          sha256: hash.digest('hex')
        });
      } finally {
        try {
          customFs.closeSync(fd);
        } catch {}
      }
    } else {
      // Special unsupported type (FIFO, socket, device, directory) (Section 35)
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.UNSUPPORTED_UNTRACKED_TYPE,
        `Unsupported untracked file type for '${gitRelativePath}' (mode ${preStat.mode})`
      );
    }
  }

  // Deterministic code-unit sorting (A-19)
  manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifestCanonicalJson = canonicalJsonStringify(manifestEntries);
  const manifestSha256 = sha256Hex(Buffer.from(manifestCanonicalJson, 'utf8'));

  return {
    untracked_count: manifestEntries.length,
    manifest_sha256: manifestSha256
  };
}

/**
 * Collect submodule state from index gitlinks and working trees (Sections 41-46 / A-06 / A-07 / WSAUTH-02-05).
 */
function collectSubmoduleState(gitBinary, canonicalProjectRoot, customSpawn, customFs) {
  // 1. Discover submodules via index gitlinks (mode 160000)
  const lsStageRes = runGitCommand(
    gitBinary,
    ['ls-files', '--stage', '-z'],
    canonicalProjectRoot,
    customSpawn
  );

  if (lsStageRes.status !== 0) {
    const stderr = extractBoundedStderr(lsStageRes.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git ls-files --stage failed: ${stderr}`,
      { status: lsStageRes.status, stderr }
    );
  }

  const submodules = [];
  const buf = lsStageRes.stdout;
  let start = 0;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) {
        const recordBuf = buf.subarray(start, i);
        // Find TAB byte separating metadata from path (WSAUTH-03)
        const tabIdx = recordBuf.indexOf(0x09);
        if (tabIdx === -1) {
          throw new WorkspaceStateError(
            WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
            'Malformed git ls-files --stage record: missing TAB separator'
          );
        }

        const metaBuf = recordBuf.subarray(0, tabIdx);
        const pathBuf = recordBuf.subarray(tabIdx + 1);

        const metaStr = metaBuf.toString('ascii').trim();
        const metaParts = metaStr.split(/\s+/);
        if (metaParts.length !== 3) {
          throw new WorkspaceStateError(
            WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
            `Malformed git ls-files --stage metadata: '${metaStr}'`
          );
        }

        const [mode, gitlinkSha, stage] = metaParts;
        if (!/^[0-7]{6}$/.test(mode) || !/^[0-9a-fA-F]{40}$/.test(gitlinkSha) || !/^[0-3]$/.test(stage)) {
          throw new WorkspaceStateError(
            WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
            `Invalid git ls-files --stage record values: mode=${mode}, sha=${gitlinkSha}, stage=${stage}`
          );
        }

        if (mode === '160000') {
          // Strict UTF-8 decode of path bytes (A-02, WSAUTH-03)
          let gitRelativePath;
          try {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            gitRelativePath = decoder.decode(pathBuf);
          } catch (err) {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
              `Submodule path contains invalid UTF-8 bytes: ${err.message}`
            );
          }

          if (!gitRelativePath) {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
              'Submodule path is empty'
            );
          }

          // Reject absolute paths
          if (gitRelativePath.startsWith('/') || /^[a-zA-Z]:/.test(gitRelativePath)) {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
              `Submodule path must be relative to project root: '${gitRelativePath}'`
            );
          }

          // Segment-based traversal check (WSAUTH-04 / WSAUTH-05)
          const segments = gitRelativePath.split('/');
          for (const seg of segments) {
            if (seg === '..') {
              throw new WorkspaceStateError(
                WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
                `Submodule path contains directory traversal segment '..': '${gitRelativePath}'`
              );
            }
          }

          // Build filesystem path without modifying gitRelativePath (WSAUTH-05)
          const submodFullPath = path.resolve(canonicalProjectRoot, ...segments);

          // Lexical containment verification
          const relCheck = path.relative(canonicalProjectRoot, submodFullPath);
          if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || relCheck === '') {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
              `Submodule path resolves outside project root: '${gitRelativePath}'`
            );
          }

          // Submodule worktree symlink / canonical containment check (WSAUTH-04)
          let submodStat = null;
          try {
            submodStat = customFs.lstatSync(submodFullPath);
          } catch (err) {
            if (err.code !== 'ENOENT') {
              throw new WorkspaceStateError(
                WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
                `Failed to lstat submodule path '${gitRelativePath}': ${err.message}`
              );
            }
          }

          if (!submodStat) {
            // Directory does not exist -> uninitialized (A-06, Section 26)
            submodules.push({
              path: gitRelativePath,
              recorded_gitlink_sha: gitlinkSha,
              observed_head: null,
              initialized: false,
              dirty_status_sha256: null
            });
            continue;
          }

          // If working tree path exists, check if it or any intermediate resolves outside root (WSAUTH-04)
          let canonicalSubmod;
          try {
            const realpathFn = customFs.realpathSync.native || customFs.realpathSync;
            canonicalSubmod = realpathFn(submodFullPath);
          } catch (err) {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
              `Failed to resolve canonical path for submodule '${gitRelativePath}': ${err.message}`
            );
          }

          const relCanonical = path.relative(canonicalProjectRoot, canonicalSubmod);
          if (relCanonical.startsWith('..') || path.isAbsolute(relCanonical) || relCanonical === '') {
            throw new WorkspaceStateError(
              WORKSPACE_STATE_ERROR_CODES.UNSAFE_UNTRACKED_PATH,
              `Submodule path '${gitRelativePath}' resolves outside project root via symlink: '${canonicalSubmod}'`
            );
          }

          // Check if .git exists inside the validated canonical submodule directory
          const gitDir = path.join(canonicalSubmod, '.git');
          let isInitialized = false;
          try {
            isInitialized = customFs.existsSync(gitDir);
          } catch {}

          if (isInitialized) {
            // Observed HEAD (WSAUTH-02: fails closed if git command fails)
            const headRes = runGitCommand(
              gitBinary,
              ['rev-parse', '--verify', 'HEAD'],
              canonicalSubmod,
              customSpawn
            );
            if (headRes.status !== 0) {
              const stderr = extractBoundedStderr(headRes.stderr);
              throw new WorkspaceStateError(
                WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
                `git rev-parse --verify HEAD failed for submodule '${gitRelativePath}': ${stderr}`,
                { status: headRes.status, stderr }
              );
            }
            const observedHead = headRes.stdout.toString('utf8').trim();
            if (!observedHead || observedHead.length !== 40) {
              throw new WorkspaceStateError(
                WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
                `Invalid HEAD commit SHA returned for submodule '${gitRelativePath}': '${observedHead}'`
              );
            }

            // Dirty status (WSAUTH-02: fails closed if git command fails)
            const dirtyRes = runGitCommand(
              gitBinary,
              ['-C', canonicalSubmod, 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
              canonicalProjectRoot,
              customSpawn
            );
            if (dirtyRes.status !== 0) {
              const stderr = extractBoundedStderr(dirtyRes.stderr);
              throw new WorkspaceStateError(
                WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
                `git status failed for submodule '${gitRelativePath}': ${stderr}`,
                { status: dirtyRes.status, stderr }
              );
            }
            const dirtyStatusSha = sha256Hex(dirtyRes.stdout);

            submodules.push({
              path: gitRelativePath,
              recorded_gitlink_sha: gitlinkSha,
              observed_head: observedHead,
              initialized: true,
              dirty_status_sha256: dirtyStatusSha
            });
          } else {
            // Uninitialized (A-06)
            submodules.push({
              path: gitRelativePath,
              recorded_gitlink_sha: gitlinkSha,
              observed_head: null,
              initialized: false,
              dirty_status_sha256: null
            });
          }
        }
      }
      start = i + 1;
    }
  }

  // 2. Supplementary raw git submodule status --recursive (A-06 / WSAUTH-02)
  const rawSubmodRes = runGitCommand(
    gitBinary,
    ['submodule', 'status', '--recursive'],
    canonicalProjectRoot,
    customSpawn
  );
  if (rawSubmodRes.status !== 0) {
    const stderr = extractBoundedStderr(rawSubmodRes.stderr);
    throw new WorkspaceStateError(
      WORKSPACE_STATE_ERROR_CODES.GIT_COMMAND_FAILED,
      `git submodule status --recursive failed: ${stderr}`,
      { status: rawSubmodRes.status, stderr }
    );
  }
  const rawSubmoduleStatusSha = sha256Hex(rawSubmodRes.stdout);

  // Deterministic code-unit sorting (A-19)
  submodules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const compositeSubmoduleData = {
    raw_status_sha256: rawSubmoduleStatusSha,
    submodules
  };

  const submoduleSha256 = sha256Hex(Buffer.from(canonicalJsonStringify(compositeSubmoduleData), 'utf8'));

  return {
    submodule_count: submodules.length,
    submodule_status_sha256: submoduleSha256
  };
}

/**
 * Single collection pass of all authoritative components.
 */
function collectAuthoritativeComponents(gitBinary, canonicalRoot, projectId, customSpawn, customFs) {
  const branch = resolveGitBranch(gitBinary, canonicalRoot, customSpawn);
  const head = resolveGitHead(gitBinary, canonicalRoot, customSpawn);
  const statusSha = resolveStatusDigest(gitBinary, canonicalRoot, customSpawn);
  const stagedDiffSha = resolveStagedDiffDigest(gitBinary, canonicalRoot, customSpawn);
  const unstagedDiffSha = resolveUnstagedDiffDigest(gitBinary, canonicalRoot, customSpawn);
  const untrackedInfo = collectUntrackedManifest(gitBinary, canonicalRoot, customSpawn, customFs);
  const submoduleInfo = collectSubmoduleState(gitBinary, canonicalRoot, customSpawn, customFs);

  return {
    branch,
    head,
    status_sha256: statusSha,
    staged_diff_sha256: stagedDiffSha,
    unstaged_diff_sha256: unstagedDiffSha,
    untracked_manifest_sha256: untrackedInfo.manifest_sha256,
    untracked_count: untrackedInfo.untracked_count,
    submodule_status_sha256: submoduleInfo.submodule_status_sha256,
    submodule_count: submoduleInfo.submodule_count
  };
}

/**
 * Factory creating the concrete Workspace-State Port.
 */
function createWorkspaceStatePort(options = {}) {
  const gitBinary = options.gitBinary || 'git';
  const customSpawn = options.spawnSync || child_process.spawnSync;
  const customFs = options.fs || fs;

  /**
   * getWorkspaceState(project)
   * Resolves deterministic workspace_state_id from Git facts.
   * Performs two-pass consistency validation (A-11).
   */
  async function getWorkspaceState(project) {
    // 1. Validate project input (Section 13)
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.INVALID_PROJECT,
        'Project input must be a non-null object'
      );
    }

    const projectId = typeof project.project_id === 'string' ? project.project_id.trim() : '';
    const projectRoot = typeof project.project_root === 'string' ? project.project_root.trim() : '';

    if (!projectId) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.INVALID_PROJECT,
        'Missing or empty project.project_id'
      );
    }
    if (!projectRoot) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.INVALID_PROJECT,
        'Missing or empty project.project_root'
      );
    }

    // 2. Validate project root existence and directory (Section 14)
    let stat;
    try {
      stat = customFs.statSync(projectRoot);
    } catch (err) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Project root '${projectRoot}' does not exist on disk: ${err.message}`
      );
    }

    if (!stat.isDirectory()) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Project root '${projectRoot}' is not a directory`
      );
    }

    // Realpath canonicalization
    let canonicalRoot;
    try {
      const realpathFn = customFs.realpathSync.native || customFs.realpathSync;
      canonicalRoot = realpathFn(projectRoot);
    } catch (err) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Failed to resolve canonical path for project root '${projectRoot}': ${err.message}`
      );
    }

    // Root Input Identity Binding (WSAUTH-06 / A-10)
    // Compare input identity with canonical identity.
    // If caller supplied a symlink or alias whose canonical identity differs from input identity: fail closed.
    const inputIdentity = computeRootIdentityKey(projectRoot);
    const canonicalIdentity = computeRootIdentityKey(canonicalRoot);
    if (inputIdentity !== canonicalIdentity) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
        `Project root '${projectRoot}' is an alias or symlink resolving to '${canonicalRoot}'. Non-canonical root aliases are not permitted.`
      );
    }

    // 3. Verify Git toplevel matches project root (Section 15 / A-10)
    resolveGitToplevel(gitBinary, canonicalRoot, customSpawn, customFs);

    // Proven canonical root identity (A-10)
    const rootIdentity = computeRootIdentityKey(canonicalRoot);

    // 4. Two-Pass Snapshot Stability Check (A-11)
    const pass1 = collectAuthoritativeComponents(gitBinary, canonicalRoot, projectId, customSpawn, customFs);
    const pass2 = collectAuthoritativeComponents(gitBinary, canonicalRoot, projectId, customSpawn, customFs);

    // Compare all authoritative components
    if (
      pass1.branch !== pass2.branch ||
      pass1.head !== pass2.head ||
      pass1.status_sha256 !== pass2.status_sha256 ||
      pass1.staged_diff_sha256 !== pass2.staged_diff_sha256 ||
      pass1.unstaged_diff_sha256 !== pass2.unstaged_diff_sha256 ||
      pass1.untracked_manifest_sha256 !== pass2.untracked_manifest_sha256 ||
      pass1.submodule_status_sha256 !== pass2.submodule_status_sha256
    ) {
      throw new WorkspaceStateError(
        WORKSPACE_STATE_ERROR_CODES.WORKSPACE_STATE_UNAVAILABLE,
        'Workspace state changed during snapshot collection (WORKSPACE_CHANGED_DURING_SNAPSHOT)'
      );
    }

    // 5. Construct Canonical State Object (Section 39 / A-10)
    const canonicalStateObject = {
      version: STATE_VERSION,
      project_identity: {
        project_id: projectId,
        root_identity: rootIdentity
      },
      branch: pass1.branch,
      head: pass1.head,
      components: {
        status_sha256: pass1.status_sha256,
        staged_diff_sha256: pass1.staged_diff_sha256,
        unstaged_diff_sha256: pass1.unstaged_diff_sha256,
        untracked_manifest_sha256: pass1.untracked_manifest_sha256,
        submodule_status_sha256: pass1.submodule_status_sha256
      }
    };

    const canonicalBytes = Buffer.from(canonicalJsonStringify(canonicalStateObject), 'utf8');
    const workspaceStateId = `sha256:${sha256Hex(canonicalBytes)}`;

    // 6. Return Detached Result Object (Section 11 / A-20)
    return {
      schema_version: 1,
      workspace_state_id: workspaceStateId,
      project_id: projectId,
      project_root: canonicalRoot,
      branch: pass1.branch,
      head: pass1.head,
      components: {
        status_sha256: pass1.status_sha256,
        staged_diff_sha256: pass1.staged_diff_sha256,
        unstaged_diff_sha256: pass1.unstaged_diff_sha256,
        untracked_manifest_sha256: pass1.untracked_manifest_sha256,
        submodule_status_sha256: pass1.submodule_status_sha256
      },
      untracked_count: pass1.untracked_count,
      submodule_count: pass1.submodule_count
    };
  }

  return {
    getWorkspaceState
  };
}

module.exports = {
  WORKSPACE_STATE_ERROR_CODES,
  WorkspaceStateError,
  STATE_VERSION,
  GIT_MAX_BUFFER_BYTES,
  MAX_STDERR_DIAGNOSTIC_BYTES,
  canonicalJsonStringify,
  sha256Hex,
  sameFileIdentity,
  runGitCommand,
  validateUntrackedPathSafety,
  createWorkspaceStatePort
};

# WorkOrder Report: WO-V3-004

## WP-V3-04 — Minimal Deterministic Workspace-State Gate

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Approved Parent Branch**: `review/v3-wp03-registry-final`
- **Approved Parent SHA**: `8c955d1f24815a3642ada56fdd9717ff88ad52f8`
- **Architecture Authority**: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Active Branch**: `review/v3-wp04-workspace-state`
- **Status**: `READY_FOR_WP_V3_04_EXTERNAL_REVIEW`

---

# 1. Baseline & Objective

The objective of WP-V3-04 is to implement the concrete workspace-state adapter:
```javascript
workspacePort.getWorkspaceState(project)
```
satisfying the broker contract defined in `contracts.js`.

The sole authority question answered by this component is:
> *Is the Git/worktree state being dispatched against still exactly the state the auditor observed?*

The module produces a deterministic `workspace_state_id` derived exclusively from raw Git facts and filesystem bytes. It enforces fail-closed verification, two-pass snapshot consistency, symlink traversal safety, bounded buffer execution, and command-specific error mapping.

---

# 2. Scope Enforcement & Non-Responsibilities

In strict accordance with WO-V3-004 and the Human Plan Review Addendum (A-01 .. A-20), the following boundaries are enforced:
- **No Worker Execution / Adapter Logic**: Does NOT communicate with Antigravity / AO desktop agents (deferred to WP-V3-05).
- **No Auditor Automation / Prompts**: Does NOT create Codex tasks, prompt ChatGPT, parse audit prose, or produce verdicts (deferred to WP-V3-07).
- **No Registry Authority Modification**: Does NOT modify `pipeline-ui/lib/broker/registry.js` or manage project persistence.
- **No Broker Core Modification**: Does NOT modify `pipeline-ui/lib/broker/broker.js` or `contracts.js`.
- **No UI / Server Modification**: Does NOT touch `server.js`, `package.json`, or UI routes.
- **No Subdirectory Project Roots**: Enforces that project root must match the canonical Git toplevel (`PROJECT_ROOT_NOT_GIT_TOPLEVEL`).
- **No Cross-Call Shared State**: Returns a fresh, deeply detached result object per invocation.

---

# 3. Git Command Execution & Deterministic Invariants

All Git commands are executed with argument arrays via `child_process.spawnSync` with:
- `shell: false` (no shell interpolation).
- `encoding: null` (raw `Buffer` output to prevent UTF-8 text corruption or line-ending mangling).
- `maxBuffer: 52428800` (`GIT_MAX_BUFFER_BYTES` = 50 MB) to protect against buffer overflow while failing closed on oversized outputs (A-09).

### Deterministic Diff Invariants (A-18)
All hash-authoritative diff and status commands pass explicit flags to eliminate host and global configuration variance:
```text
--no-renames
--no-ext-diff
--no-textconv
--no-color
--diff-algorithm=myers
```

---

# 4. Two-Pass Snapshot Stability Policy (A-11, A-12)

Because a filesystem cannot be frozen atomically during user activity without OS-level snapshots, the engine implements a bounded two-pass consistency validation check:
1. **Pass 1**: Collect all 7 authoritative component digests (`branch`, `head`, `status_sha256`, `staged_diff_sha256`, `unstaged_diff_sha256`, `untracked_manifest_sha256`, `submodule_status_sha256`).
2. **Pass 2**: Collect all 7 authoritative component digests a second time.
3. **Comparison**: If any component differs between Pass 1 and Pass 2, the engine aborts immediately and fails closed with:
   ```text
   WORKSPACE_STATE_UNAVAILABLE: Workspace state changed during snapshot collection (WORKSPACE_CHANGED_DURING_SNAPSHOT)
   ```
4. **Resolution**: If both passes agree, the `workspace_state_id` is constructed from the agreed component set.

This detects concurrent tracked edits, unstaged changes, file creations/deletions, and submodule changes during inspection.

---

# 5. Strict Path-Byte Decoding & Path Traversal Safety (A-02, A-03, A-14)

Git outputs NUL-delimited relative paths via `git ls-files --others --exclude-standard -z`.
- **Strict Decoding**: Path buffers are decoded using `new TextDecoder('utf-8', { fatal: true })`. If any byte sequence is invalid UTF-8, decoding aborts and fails closed with `UNSAFE_UNTRACKED_PATH` without attempting filesystem operations.
- **Segment-Based Traversal Check**:
  - Rejects absolute paths.
  - Rejects paths containing any path segment equal to `..` (e.g. `../outside`, `a/../../escape`).
  - Preserves legitimate files containing two dots (e.g. `foo..bar.txt`).
  - Canonical project root lexical containment verification via `path.relative()`.

---

# 6. Regular-File Symlink-Swap Race & Symlink Safety (A-04, A-05, A-13)

### Regular File Reading Sequence (A-04)
To prevent symlink-swap races where a regular file is swapped for an external symlink between stat and read:
1. **Pre-lstat**: Perform `fs.lstatSync(absPath)`. Must satisfy `stat.isFile()`.
2. **Open**: Call `fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))`.
3. **Fstat**: Call `fs.fstatSync(fd)` on the opened descriptor. Must be a regular file.
4. **Post-lstat**: Perform `fs.lstatSync(absPath)` on the pathname.
5. **Identity Match**: Confirm `statPre.dev === statFd.dev && statPre.ino === statFd.ino` and `statPost.dev === statFd.dev && statPost.ino === statFd.ino`. If identity drifted, fail closed with `WORKSPACE_STATE_UNAVAILABLE`.
6. **Descriptor Hashing**: Read file bytes incrementally in 64 KB chunks directly from the validated file descriptor.

### Symlink Target Safety (A-05)
For untracked symlinks:
- The target is read via `fs.readlinkSync(absPath, { encoding: 'buffer' })`.
- Raw target bytes are hashed directly into the manifest entry.
- The external target file is **never opened or read** (target read count = 0).
- Mutations to external file content have zero effect on `workspace_state_id`.
- Modifying the link target bytes alters `workspace_state_id`.

---

# 7. Exact Submodule Authority & Dirty State (A-06, A-07, A-17)

Submodule discovery and hashing are derived strictly from Git plumbing and index authority:
1. **Discovery**: `git ls-files --stage -z` filtered to mode `160000` (gitlinks).
2. **Gitlink SHA**: Extracted directly from the superproject index.
3. **Observed HEAD**: Obtained via `git rev-parse HEAD` executed inside the submodule working directory (or `null` if uninitialized).
4. **Working Tree Dirty State**: Scoped execution of:
   ```text
   git -C <submodule> status --porcelain=v2 -z --untracked-files=all --ignore-submodules=none
   ```
   Raw status bytes are hashed into `dirty_status_sha256`. Modifying any file inside the submodule worktree changes this digest and alters `workspace_state_id` even if the recorded gitlink and submodule HEAD remain identical (A-07).
5. **Supplementary Digest**: Raw output of `git submodule status --recursive` is hashed into `submodule_status_sha256`.

---

# 8. Command-Specific Error Mapping (A-01, A-08, A-15)

Fail-closed error mapping prevents unexpected Git errors from masking valid repository states:

| Git Command | Exit Code | Context / Output | Resulting State / Error Code |
| :--- | :--- | :--- | :--- |
| `git rev-parse --show-toplevel` | 0 | Matches `canonicalRoot` | Clean toplevel verified |
| `git rev-parse --show-toplevel` | 0 | Subdirectory of toplevel | `PROJECT_ROOT_NOT_GIT_TOPLEVEL` |
| `git rev-parse --show-toplevel` | Non-zero | `fatal: not a git repository` | `NOT_GIT_REPOSITORY` |
| `git rev-parse --show-toplevel` | Non-zero | Other stderr / spawn error | `GIT_COMMAND_FAILED` |
| `git symbolic-ref --quiet --short HEAD` | 0 | Branch name | `branch = branchName` |
| `git symbolic-ref --quiet --short HEAD` | 1 | "not a symbolic ref" | `branch = 'DETACHED'` |
| `git symbolic-ref --quiet --short HEAD` | 128 / other | Permission denied, corrupt repo | `GIT_COMMAND_FAILED` |
| `git rev-parse HEAD` | 0 | Commit SHA | `head = commitSha` |
| `git rev-parse HEAD` | 128 | `fatal: ambiguous argument 'HEAD'` | `HEAD_UNAVAILABLE` (unborn HEAD) |
| `git rev-parse HEAD` | Other | Unexpected error | `GIT_COMMAND_FAILED` |
| Any command | Timeout / Kill | Output > 50 MB | `GIT_COMMAND_FAILED` |

---

# 9. Hash Component Table (Section 97)

| Component Name | Git / Filesystem Command | Raw Digest Input | Normalization Policy | Collision Resistance |
| :--- | :--- | :--- | :--- | :--- |
| **Branch** | `git symbolic-ref --quiet --short HEAD` | UTF-8 branch name or `DETACHED` | Trimmed string | Pre-image resistant SHA-256 in state JSON |
| **HEAD** | `git rev-parse HEAD` | 40-char commit SHA | Lowercase trimmed hex | Cryptographic commit ID |
| **Status** | `git status --porcelain=v2 -z --untracked-files=no` | Raw NUL-delimited status bytes | Raw Buffer (no CRLF conversion) | SHA-256 hex digest |
| **Staged Diff** | `git diff --cached --no-renames --no-ext-diff --no-textconv --no-color --diff-algorithm=myers` | Raw unified diff bytes | Raw Buffer (no CRLF conversion) | SHA-256 hex digest |
| **Unstaged Diff** | `git diff --no-renames --no-ext-diff --no-textconv --no-color --diff-algorithm=myers` | Raw unified diff bytes | Raw Buffer (no CRLF conversion) | SHA-256 hex digest |
| **Untracked Manifest**| `git ls-files --others --exclude-standard -z` + file reads | Canonical sorted JSON of path, type, size, mode, sha256 | Raw file bytes & raw symlink target buffer | Incremental SHA-256 per file; composite SHA-256 manifest |
| **Submodules** | `git ls-files --stage -z` + `git submodule status --recursive` | Composite JSON of gitlink SHA, submodule HEAD, dirty digest | Raw status buffers & canonical JSON stringify | SHA-256 hex digest |

---

# 10. Untracked Files Handling Table (Section 98)

| Category | Detection Strategy | Content Hashing | Mode Behavior | Symlink Behavior | Error Code on Failure |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Regular File** | `lstat.isFile()` | Incremental 64KB fd read | Mode recorded | N/A | `UNSAFE_UNTRACKED_PATH` / `UNAVAILABLE` |
| **Symlink** | `lstat.isSymbolicLink()` | Raw target byte digest | Mode recorded | Never opens external target | `UNSAFE_UNTRACKED_PATH` |
| **Directory** | Git porcelain `-z` | Git descends or lists files | N/A | Never treated as directory symlink | `UNSAFE_UNTRACKED_PATH` |
| **FIFO / Socket / Device** | `lstat` special file checks | None (rejected immediately) | N/A | N/A | `UNSUPPORTED_UNTRACKED_TYPE` |
| **Invalid UTF-8 Path** | `TextDecoder fatal: true` | None (rejected before read) | N/A | N/A | `UNSAFE_UNTRACKED_PATH` |
| **Path Traversal (`..`)**| Segment-based check | None (rejected before read) | N/A | N/A | `UNSAFE_UNTRACKED_PATH` |

---

# 11. Submodule Handling Table (Section 99)

| Submodule State | Discovery Source | Gitlink SHA Source | Submodule HEAD Check | Worktree Dirty Check | Impact on `workspace_state_id` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Clean & Initialized** | `ls-files --stage -z` (160000) | Superproject index | `rev-parse HEAD` | `porcelain=v2 -z` is empty | Baseline state established |
| **HEAD Changed** | `ls-files --stage -z` | Superproject index | New commit SHA observed | `porcelain=v2 -z` | State ID changes immediately |
| **Worktree Modified** | `ls-files --stage -z` | Same index SHA | Same commit SHA | Dirty status bytes hashed | State ID changes (A-07) |
| **Gitlink Staged** | `ls-files --stage -z` | New staged index SHA | Current commit SHA | `porcelain=v2 -z` | Staged diff & state ID change |
| **Uninitialized** | `ls-files --stage -z` | Superproject index | Recorded as `null` | Marked `initialized: false` | Deterministic UNINITIALIZED record |

---

# 12. Test Accounting (WS-001 .. WS-039: 39/39 PASS)

| Test ID | Test Description | Status |
| :--- | :--- | :--- |
| **WS-001** | Clean repository determinism (called twice -> identical state ID) | **PASS** |
| **WS-002** | Project identity affects workspace_state_id | **PASS** |
| **WS-003** | Branch change affects workspace_state_id (same HEAD) | **PASS** |
| **WS-004** | New commit changes HEAD and workspace_state_id | **PASS** |
| **WS-005** | Unstaged tracked change alters unstaged diff and state ID | **PASS** |
| **WS-006** | Staged modification alters staged diff and state ID | **PASS** |
| **WS-007** | Deleting tracked file alters state ID | **PASS** |
| **WS-008** | Renaming tracked file alters state ID under --no-renames | **PASS** |
| **WS-009** | Adding untracked file alters untracked count, manifest, and state ID | **PASS** |
| **WS-010** | Untracked raw byte change (LF -> CRLF) alters state ID (no newline normalization) | **PASS** |
| **WS-011** | Modifying byte in binary untracked file alters state ID | **PASS** |
| **WS-012** | Renaming untracked file without changing content alters manifest and state ID | **PASS** |
| **WS-013** | Changes strictly to ignored files do NOT alter workspace_state_id | **PASS** |
| **WS-014** | Untracked path with spaces and non-ASCII characters handled deterministically | **PASS** |
| **WS-015** | Large untracked file hashed completely without truncation | **PASS** |
| **WS-016** | Untracked symlink pointing outside root never follows external target content | **PASS** |
| **WS-017** | Non-Git directory fails closed with NOT_GIT_REPOSITORY | **PASS** |
| **WS-018** | Nested subdirectory inside Git repo fails closed with PROJECT_ROOT_NOT_GIT_TOPLEVEL | **PASS** |
| **WS-019** | Detached HEAD resolves branch as DETACHED with valid state ID | **PASS** |
| **WS-020** | Fresh empty repository (unborn HEAD) fails closed with HEAD_UNAVAILABLE | **PASS** |
| **WS-021** | Git command failure fails closed with GIT_COMMAND_FAILED | **PASS** |
| **WS-022** | Unsafe untracked path traversal rejected with UNSAFE_UNTRACKED_PATH | **PASS** |
| **WS-023** | Unsupported special file types fail closed with UNSUPPORTED_UNTRACKED_TYPE | **PASS** |
| **WS-024** | Submodule clean state captured deterministically | **PASS** |
| **WS-025** | Submodule observed HEAD change alters superproject workspace_state_id | **PASS** |
| **WS-026** | Submodule dirty worktree content alters workspace_state_id (same gitlink, same HEAD) | **PASS** |
| **WS-027** | Staging new submodule gitlink alters state ID | **PASS** |
| **WS-028** | Uninitialized submodule recorded with deterministic UNINITIALIZED state | **PASS** |
| **WS-029** | Broker integration: modified workspace state triggers STALE_AUDIT_STATE (0 worker calls) | **PASS** |
| **WS-030** | Broker integration: matching workspace state permits exactly 1 worker dispatch | **PASS** |
| **WS-031** | Broker integration: submodule change triggers STALE_AUDIT_STATE | **PASS** |
| **WS-032** | Production workspace-state.js contains zero references to models/reports | **PASS** |
| **WS-033** | Exact revert of modifications restores identical initial workspace_state_id | **PASS** |
| **WS-034** | Untracked file mtime modification does NOT alter workspace_state_id | **PASS** |
| **WS-035** | Return contract contains only small metadata and digests; raw diffs omitted | **PASS** |
| **WS-036** | Repository mutating during two-pass snapshot fails closed with WORKSPACE_STATE_UNAVAILABLE | **PASS** |
| **WS-037** | Untracked regular file swapped for symlink before open fails closed (0 target reads) | **PASS** |
| **WS-038** | Untracked path with invalid UTF-8 bytes fails closed with UNSAFE_UNTRACKED_PATH | **PASS** |
| **WS-039** | Unexpected git symbolic-ref failure throws GIT_COMMAND_FAILED (never DETACHED) | **PASS** |

---

# 13. Regression Test Verification

1. **Workspace-State Suite**:
   - `node pipeline-ui/test/refactor/workspace-state.test.js`: **39/39 PASS**.
2. **Registry Suite**:
   - `node pipeline-ui/test/refactor/registry.test.js`: **39/39 PASS** (`RG-001` .. `RG-039`).
3. **Broker Core Suite**:
   - `node pipeline-ui/test/refactor/broker-core.test.js`: **48/48 PASS** (`BC-001` .. `BC-048`).
4. **Legacy Regression Suites**:
   - `node pipeline-ui/test/refactor/wp01-regression.test.js`: **PASS**.
   - `node pipeline-ui/test/refactor/characterization.test.js`: **PASS**.
5. **Ambient Baseline Validation**:
   - `npm test` in `pipeline-ui`: fails at pre-existing baseline assertion in `pipeline-api.test.js:72:12` (`workspace-test` not in `user-projects.json`). Result: `UNCHANGED_PRE_EXISTING_FAILURE`.
6. **Git Formatting Check**:
   - `git diff --check`: Exit code 0 (no whitespace, newline, or formatting errors).

---

# 14. Scope Compliance Verification (Section 100)

| File / Component | Status | Verification Note |
| :--- | :--- | :--- |
| `pipeline-ui/lib/broker/workspace-state.js` | **CREATED (NEW)** | Minimal deterministic workspace state gate |
| `pipeline-ui/test/refactor/workspace-state.test.js` | **CREATED (NEW)** | Test suite for WS-001 .. WS-039 |
| `docs/refactor-v3-thin-orchestrator/WO-V3-004-REPORT.md` | **CREATED (NEW)** | Architectural and verification report |
| `pipeline-ui/lib/broker/broker.js` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/lib/broker/contracts.js` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/lib/broker/lifecycle-store.js` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/lib/broker/registry.js` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/server.js` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/package.json` | **UNTOUCHED** | Zero modifications |
| `pipeline-ui/user-projects.json` | **UNTOUCHED** | Zero modifications |
| `manifest.json` | **UNTOUCHED** | Ambient workspace file ignored and excluded from git |
| Antigravity Adapter / AO | **UNTOUCHED** | Deferred to WP-V3-05 |
| Codex Auditor Automation | **UNTOUCHED** | Deferred to WP-V3-07 |

---

# 15. Known Operational Limits (Section 95)

1. **Git Standard Output Buffer**: Maximum output buffer is set to 50 MB (`GIT_MAX_BUFFER_BYTES = 52428800`). Repositories with single diffs or status payloads exceeding 50 MB fail closed with `GIT_COMMAND_FAILED`.
2. **Fixed Myers Diff Algorithm**: The diff algorithm is fixed to `--diff-algorithm=myers` to ensure deterministic hashing across environments regardless of user Git config.
3. **Single Git Toplevel per Project**: In v3 MVP, each registered project must correspond directly to a Git toplevel root. Nested subdirectories inside a larger Git repository fail closed with `PROJECT_ROOT_NOT_GIT_TOPLEVEL`.
4. **Deterministic Local Workspace Identity**: The module guarantees deterministic local workspace identity under the documented Git and filesystem semantics with fail-closed race detection; it does not claim atomic filesystem snapshots against arbitrary kernel/filesystem races.

---

# 16. Verification Signature & Status

```text
READY_FOR_WP_V3_04_EXTERNAL_REVIEW
```

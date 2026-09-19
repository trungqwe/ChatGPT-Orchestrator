# WorkOrder Report: WO-V3-004F

## WP-V3-04 Final Correctness Closure: File-Descriptor Identity, Submodule Authority & Git Path Integrity

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Branch**: `review/v3-wp04-workspace-state`
- **Parent SHA**: `c1fd481221926bb52f3504de0ded5790433b07de`
- **Architecture Authority**: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Fix Branch**: `review/v3-wp04-workspace-state-final`
- **Status**: `READY_FOR_WP_V3_04_FINAL_EXTERNAL_REVIEW`

---

# 1. Baseline

WorkOrder `WO-V3-004F` closes the seven authority defects (`WSAUTH-01` through `WSAUTH-07`) identified during external review of `review/v3-wp04-workspace-state` at parent commit `c1fd481221926bb52f3504de0ded5790433b07de`.

Pre-flight status confirmed:
- Current branch: `review/v3-wp04-workspace-state`
- Parent HEAD: `c1fd481221926bb52f3504de0ded5790433b07de`
- Ambient untracked file: `manifest.json` preserved untouched.
- Fix branch created: `review/v3-wp04-workspace-state-final`.

---

# 2. WSAUTH-01 File Descriptor Identity

Previously, `workspace-state.js` compared `preStat.ino` and `postStat.ino` across pathname inspections, but did not strictly compare the opened descriptor identity (`fdStat`) against pathname identity (`preStat` and `postStat`). This left open a race where `open` returned a file descriptor for a different regular file while pathname observations remained consistent.

### Corrected Implementation
Before reading or hashing any file bytes:
1. `preStat.isFile()`, `fdStat.isFile()`, and `postStat.isFile()` must all evaluate to `true`.
2. Semantic identity check `sameFileIdentity(s1, s2)` proves:
   - `s1.dev === s2.dev && s1.ino === s2.ino`
   - Device and inode identities are non-null and strictly identical.
3. Both `sameFileIdentity(preStat, fdStat)` AND `sameFileIdentity(fdStat, postStat)` must hold.
4. If identity proof cannot be established or mismatches, execution fails closed with `WORKSPACE_STATE_UNAVAILABLE` before reading any bytes from the descriptor.
5. All reads are performed incrementally from the validated descriptor using `customFs.readSync(fd, chunkBuf, ...)`. The pathname is never reopened for hashing.

### File Identity Table (Section 51)

| Observation | Path Type | dev/ino Identity | Allowed to Hash? | Reason |
| :--- | :--- | :--- | :--- | :--- |
| `pre=A, fd=A, post=A` | Regular file | `dev` & `ino` match across all three | **YES** | Proven regular file identity binding across descriptor and pathname |
| `pre=A, fd=B, post=A` | Regular file | `pre.ino !== fd.ino` | **NO (REJECTED)** | Descriptor identity mismatch; fails closed with `WORKSPACE_STATE_UNAVAILABLE`; 0 bytes read from B |
| `pre=A, fd=ext, post=symlink` | File swapped for symlink | `post.isSymbolicLink()` | **NO (REJECTED)** | Post-stat confirms file type changed during open; fails closed; external target never read |
| `pre=A, open fails NOFOLLOW` | Symlink target | N/A (`openSync` throws) | **NO (REJECTED)** | `O_NOFOLLOW` prevents open; fails closed with `WORKSPACE_STATE_UNAVAILABLE` |

---

# 3. WSAUTH-02 Submodule Command Failure Authority

Previously, submodule Git plumbing failures (`git rev-parse --verify HEAD`, `git status --porcelain=v2`, and `git submodule status --recursive`) were caught and converted into `null` fields (`observed_head: null`, `dirty_status_sha256: null`, `raw_status_sha256: null`), permitting a state ID to be produced despite Git command failures.

### Corrected Implementation
1. **Initialized Submodule HEAD**: If `git rev-parse --verify HEAD` fails in an initialized submodule directory, the engine aborts and throws `GIT_COMMAND_FAILED`. `null` is reserved exclusively for uninitialized submodules.
2. **Submodule Working Tree Dirty Status**: If `git -C <submodule> status --porcelain=v2` fails, the engine aborts and throws `GIT_COMMAND_FAILED`.
3. **Recursive Submodule Status**: If `git submodule status --recursive` fails, the engine aborts and throws `GIT_COMMAND_FAILED`.
4. **No Fallback State**: In all failure cases, execution fails closed and zero `workspace_state_id` is produced.

### Submodule Failure Table (Section 52)

| Operation | Injected Failure | Old Behavior | New Behavior | State ID Produced? |
| :--- | :--- | :--- | :--- | :--- |
| Submodule HEAD (`rev-parse --verify HEAD`) | Status 128 / permission / corruption | `observed_head = null` | Throws `GIT_COMMAND_FAILED` | **NO** |
| Submodule dirty status (`status --porcelain=v2`) | Status 128 / syntax / crash | `dirty_status_sha256 = null` | Throws `GIT_COMMAND_FAILED` | **NO** |
| Recursive status (`submodule status --recursive`) | Status 128 / command failure | `raw_status_sha256 = null` | Throws `GIT_COMMAND_FAILED` | **NO** |

---

# 4. WSAUTH-03 Gitlink Raw Path Integrity

Previously, `git ls-files --stage -z` output was converted to a string with `.toString('utf8')` and `.trim()` was called on the submodule path, which silently stripped legal whitespace and could insert replacement characters on invalid UTF-8.

### Corrected Implementation
1. **Byte-Level Delimitation**: Each NUL-delimited record is parsed at byte level. The TAB byte (`0x09`) separates metadata from the path bytes.
2. **Metadata Validation**: The metadata string is validated as exactly 3 ASCII tokens: `<mode> <object_id> <stage>`. Mode must be 6 octal digits (`160000` for gitlink), object ID must be 40 hex digits, and stage must be 0..3.
3. **Fatal UTF-8 Decoding**: Path bytes are strictly decoded using `new TextDecoder('utf-8', { fatal: true })`. Invalid UTF-8 path bytes immediately fail closed with `UNSAFE_UNTRACKED_PATH`.
4. **Whitespace Preservation**: The decoded path is never trimmed. Leading, trailing, and internal whitespace characters are preserved as data.

---

# 5. WSAUTH-04 Submodule Root Containment

Previously, submodule working-tree paths were validated only with lexical containment. If `modules/sub1` was a symlink or junction pointing to an external directory outside the project root, lexical checks passed and `git -C <submodule>` would run against the external directory.

### Corrected Implementation
Before any `git -C <submodule>` or submodule Git command is executed:
1. Lexical containment of the relative path is checked.
2. `lstatSync` is called on the working-tree path. If it does not exist, the submodule is recorded as uninitialized (`initialized = false`) without further checks.
3. The working-tree path is canonicalized via `realpathSync`.
4. Canonical containment is verified: `path.relative(canonicalProjectRoot, canonicalSubmod)` must remain strictly beneath the canonical project root.
5. If the working tree resolves outside the project root via symlink or junction, execution fails closed with `UNSAFE_UNTRACKED_PATH` and the external repository is never inspected via Git (0 `git -C` calls).

---

# 6. WSAUTH-05 Git Path Semantics

Previously, Git relative paths were globally processed with `.replace(/\\/g, '/')`. On POSIX systems, `\` is a valid filename character, so rewriting backslashes corrupted legitimate filenames (e.g. `foo\bar.txt` became directory `foo` with file `bar.txt`).

### Corrected Implementation
1. Git-produced relative paths already use `/` as directory separators.
2. Backslash bytes are preserved as filename characters. No global `.replace(/\\/g, '/')` is performed on Git relative paths.
3. Separation of Concerns:
   - `gitRelativePath`: The canonical Git-relative path used in the manifest and state digest.
   - `filesystemPath`: Resolved via `path.resolve(projectRoot, ...gitRelativePath.split('/'))` strictly for OS filesystem operations.

### Path-Integrity Table (Section 53)

| Git Path | Host Platform | Manifest Path | Filesystem Access Path | Accepted? |
| :--- | :--- | :--- | :--- | :--- |
| `normal/path.txt` | Windows / POSIX | `normal/path.txt` | `<root>/normal/path.txt` | **YES** |
| `space path` | Windows / POSIX | `space path` | `<root>/space path` | **YES** |
| `  modules/sub  ` | Windows / POSIX | `  modules/sub  ` | `<root>/  modules/sub  ` | **YES (untrimmed)** |
| `foo\bar.txt` | POSIX | `foo\bar.txt` | `<root>/foo\bar.txt` | **YES (backslash preserved)** |
| Invalid UTF-8 bytes | Any | N/A | None (rejected before access) | **NO (`UNSAFE_UNTRACKED_PATH`)** |
| `../escape` | Any | N/A | None (rejected before access) | **NO (`UNSAFE_UNTRACKED_PATH`)** |

---

# 7. WSAUTH-06 Project Root Alias Binding

Previously, when a caller provided a symlink or junction alias as `project.project_root`, the engine canonicalized the path with `realpathSync` and accepted it without verifying that the supplied root identity matched the canonical root identity.

### Corrected Implementation
After computing `canonicalRoot = realpath(project.project_root)`:
```javascript
const inputIdentity = computeRootIdentityKey(projectRoot);
const canonicalIdentity = computeRootIdentityKey(canonicalRoot);
if (inputIdentity !== canonicalIdentity) {
  throw new WorkspaceStateError(
    WORKSPACE_STATE_ERROR_CODES.PROJECT_ROOT_UNAVAILABLE,
    `Project root '${projectRoot}' is an alias or symlink resolving to '${canonicalRoot}'. Non-canonical root aliases are not permitted.`
  );
}
```
Normal Windows casing and slash direction variations produce identical identity keys and remain accepted. Symlink and junction aliases fail closed with `PROJECT_ROOT_UNAVAILABLE`.

### Root / Submodule Containment Table (Section 54)

| Input | Lexically Beneath Root? | Canonical Beneath Root? | Git Execution Allowed? |
| :--- | :--- | :--- | :--- |
| Normal submodule directory | **YES** | **YES** | **YES** |
| Submodule symlink to outside | **YES** | **NO** | **NO (`UNSAFE_UNTRACKED_PATH` before `git -C`)** |
| Canonical project root | **YES** | **YES** | **YES** |
| Project-root symlink alias | **YES** | **NO (input identity != canonical)** | **NO (`PROJECT_ROOT_UNAVAILABLE`)** |

---

# 8. Corrected Git Command & Buffer Contract (WSAUTH-07 / Section 55)

The source, tests, and documentation are unified with exact agreeing values:

| Parameter / Command | Actual Source Value | Verification Note |
| :--- | :--- | :--- |
| `GIT_MAX_BUFFER_BYTES` | `67,108,864` (64 MiB) | Constant defined in `workspace-state.js` |
| `status` command | `git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=none` | Raw status buffer hashed |
| Staged `diff` command | `git diff --cached --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --diff-algorithm=myers` | Fixed Myers algorithm, no renames |
| Unstaged `diff` command | `git diff --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --diff-algorithm=myers` | Fixed Myers algorithm, no renames |
| Git execution mode | `spawnSync(gitBinary, args, { shell: false, encoding: null, maxBuffer: 64MiB })` | Argument arrays, raw Buffer |

---

# 9. State Hash Contract

The state fingerprint `workspace_state_id` preserves version `workspace-state-v1` with zero semantic drift:
```json
{
  "version": "workspace-state-v1",
  "project_identity": {
    "project_id": "<project_id>",
    "root_identity": "<canonical_root_identity>"
  },
  "branch": "<branch_name_or_DETACHED>",
  "head": "<40_char_commit_sha>",
  "components": {
    "status_sha256": "<hex>",
    "staged_diff_sha256": "<hex>",
    "unstaged_diff_sha256": "<hex>",
    "untracked_manifest_sha256": "<hex>",
    "submodule_status_sha256": "<hex>"
  }
}
```
State ID is `sha256:<hex>` of the canonical JSON representation.

---

# 10. Regression Matrix

| Suite | Scope | Target | Result |
| :--- | :--- | :--- | :--- |
| **Workspace-State Suite** | Deterministic gate (`WS-001` .. `WS-045`) | `45/45 PASS` | **45/45 PASS** |
| **Registry Regression** | Persistent registry (`RG-001` .. `RG-039`) | `39/39 PASS` | **39/39 PASS** |
| **Broker Core Regression** | Broker lifecycle & contracts (`BC-001` .. `BC-048`) | `48/48 PASS` | **48/48 PASS** |
| **Legacy Characterization** | WP-01 characterization & regression | Clean exit `0` | **PASS** |
| **npm test** | Ambient baseline tests | Baseline failure | `UNCHANGED_PRE_EXISTING_FAILURE` |
| **Formatting Diff Check** | `git diff --check` | Exit code `0` | **PASS (0 whitespace errors)** |

---

# 11. Command Evidence

All 45 workspace-state tests executed and passed:
```text
======================================================================
RUNNING WORKSPACE-STATE TEST SUITE (WS-001 .. WS-045)
======================================================================

[WS-001] Clean repository determinism ... ✓ PASSED
[WS-002] Project identity affects workspace_state_id ... ✓ PASSED
[WS-003] Branch change affects workspace_state_id (same HEAD) ... ✓ PASSED
[WS-004] New commit changes HEAD and workspace_state_id ... ✓ PASSED
[WS-005] Unstaged tracked change alters unstaged diff and state ID ... ✓ PASSED
[WS-006] Staged modification alters staged diff and state ID ... ✓ PASSED
[WS-007] Deleting tracked file alters state ID ... ✓ PASSED
[WS-008] Renaming tracked file alters state ID under --no-renames ... ✓ PASSED
[WS-009] Adding untracked file alters untracked count, manifest, and state ID ... ✓ PASSED
[WS-010] Untracked raw byte change (LF -> CRLF) alters state ID ... ✓ PASSED
[WS-011] Modifying byte in binary untracked file alters state ID ... ✓ PASSED
[WS-012] Renaming untracked file without changing content alters manifest and state ID ... ✓ PASSED
[WS-013] Changes strictly to ignored files do NOT alter workspace_state_id ... ✓ PASSED
[WS-014] Untracked path with spaces and non-ASCII characters handled deterministically ... ✓ PASSED
[WS-015] Large untracked file hashed completely without truncation ... ✓ PASSED
[WS-016] Untracked symlink pointing outside root never follows external target content ... ✓ PASSED
[WS-017] Non-Git directory fails closed with NOT_GIT_REPOSITORY ... ✓ PASSED
[WS-018] Nested subdirectory inside Git repo fails closed with PROJECT_ROOT_NOT_GIT_TOPLEVEL ... ✓ PASSED
[WS-019] Detached HEAD resolves branch as DETACHED with valid state ID ... ✓ PASSED
[WS-020] Fresh empty repository (unborn HEAD) fails closed with HEAD_UNAVAILABLE ... ✓ PASSED
[WS-021] Git command failure fails closed with GIT_COMMAND_FAILED ... ✓ PASSED
[WS-022] Unsafe untracked path traversal rejected with UNSAFE_UNTRACKED_PATH ... ✓ PASSED
[WS-023] Unsupported special file types fail closed with UNSUPPORTED_UNTRACKED_TYPE ... ✓ PASSED
[WS-024] Submodule clean state captured deterministically ... ✓ PASSED
[WS-025] Submodule observed HEAD change alters superproject workspace_state_id ... ✓ PASSED
[WS-026] Submodule dirty worktree content alters workspace_state_id (same gitlink, same HEAD) ... ✓ PASSED
[WS-027] Staging new submodule gitlink alters state ID ... ✓ PASSED
[WS-028] Uninitialized submodule recorded with deterministic UNINITIALIZED state ... ✓ PASSED
[WS-029] Broker integration: modified workspace state triggers STALE_AUDIT_STATE (0 worker calls) ... ✓ PASSED
[WS-030] Broker integration: matching workspace state permits exactly 1 worker dispatch ... ✓ PASSED
[WS-031] Broker integration: submodule change triggers STALE_AUDIT_STATE ... ✓ PASSED
[WS-032] Production workspace-state.js contains zero references to models/reports ... ✓ PASSED
[WS-033] Exact revert of modifications restores identical initial workspace_state_id ... ✓ PASSED
[WS-034] Untracked file mtime modification does NOT alter workspace_state_id ... ✓ PASSED
[WS-035] Return contract contains only small metadata and digests; raw diffs omitted ... ✓ PASSED
[WS-036] Repository mutating during two-pass snapshot fails closed with WORKSPACE_STATE_UNAVAILABLE ... ✓ PASSED
[WS-037] Untracked regular file swapped for symlink before open fails closed on open/no-follow (0 target reads) ... ✓ PASSED
[WS-038] Untracked path with invalid UTF-8 bytes fails closed with UNSAFE_UNTRACKED_PATH ... ✓ PASSED
[WS-039] Unexpected git symbolic-ref failure throws GIT_COMMAND_FAILED (never DETACHED) ... ✓ PASSED
[WS-040] Opened regular-file descriptor identity mismatch fails closed (WSAUTH-01) ... ✓ PASSED
[WS-041] Submodule Git command failures fail closed with GIT_COMMAND_FAILED (WSAUTH-02) ... ✓ PASSED
[WS-042] Gitlink path parsed as raw bytes: untrimmed whitespace preserved, invalid UTF-8 rejected (WSAUTH-03) ... ✓ PASSED
[WS-043] Submodule resolving to external directory via symlink fails closed with 0 git -C calls (WSAUTH-04) ... ✓ PASSED
[WS-044] Git-relative path with backslash preserves backslash without rewriting to "/" (WSAUTH-05) ... ✓ PASSED
[WS-045] Project-root symlink alias fails closed with PROJECT_ROOT_UNAVAILABLE (WSAUTH-06) ... ✓ PASSED

======================================================================
ALL WORKSPACE-STATE TESTS PASSED (WS-001 .. WS-045: 45/45 PASS)
======================================================================
```

---

# 12. Registry Regression

- Command: `node pipeline-ui/test/refactor/registry.test.js`
- Result: **39/39 PASS** (`RG-001` .. `RG-039`)
- Verification: Registry authority, path canonicalization, and schema contracts remain fully intact.

---

# 13. Broker Regression

- Command: `node pipeline-ui/test/refactor/broker-core.test.js`
- Result: **48/48 PASS** (`BC-001` .. `BC-048`)
- Verification: Immutability closures, state transitions, wait semantics, and lifecycle store boundaries remain fully intact.

---

# 14. Legacy Regression

- Commands:
  - `node test/refactor/wp01-regression.test.js`
  - `node test/refactor/characterization.test.js`
- Result: **PASS** (Zero regressions).

---

# 15. npm test Classification

- Command: `npm test` from `pipeline-ui`
- Output: `AssertionError [ERR_ASSERTION]: Found registered project workspace-test` at `pipeline-api.test.js:72:12`
- Classification: `UNCHANGED_PRE_EXISTING_FAILURE` (baseline fixture defect documented in WO-V3-001).

---

# 16. Scope Compliance (Section 56)

```text
WP-V3-05 started:
NO

AO adapter:
NO

AO called live:
NO

Semantic CLI:
NO

Codex called live:
NO

server.js modified:
NO

broker.js modified:
NO

registry.js modified:
NO

package.json modified:
NO

UI modified:
NO
```

Local untracked files:
- `manifest.json` (ambient, preserved untouched).

---

# 17. Remaining Deferred Work

- **WP-V3-05**: Antigravity / AO Desktop Worker Adapter.
- **WP-V3-06**: Semantic CLI.
- **WP-V3-07**: Codex Task Bootstrap & Auditor Automation.
- **UI / Server Refactor**: Thin orchestrator endpoint wiring.

---

# 18. Recommendation

```text
READY_FOR_WP_V3_04_FINAL_EXTERNAL_REVIEW
```

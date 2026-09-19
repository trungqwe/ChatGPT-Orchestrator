# WorkOrder Report: WO-V3-004G

## WP-V3-04 Final Submodule Containment Closure: Eliminate Implicit Git Recursion Outside Validated Project Root

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Branch**: `review/v3-wp04-workspace-state-final`
- **Parent SHA**: `224abc469b6780514b9822c167fc8d05a87dab2e`
- **Architecture Authority**: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Fix Branch**: `review/v3-wp04-workspace-state-seal`
- **Status**: `READY_FOR_WP_V3_04_APPROVAL`

---

# 1. Baseline

WorkOrder `WO-V3-004G` resolves blocker `WSAUTH-08` identified during review of candidate `review/v3-wp04-workspace-state-final` at parent SHA `224abc469b6780514b9822c167fc8d05a87dab2e`.

### Rejection Reason of Prior Candidate
The prior candidate implementation in `review/v3-wp04-workspace-state-final` executed superproject commands:
```bash
git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=none
```
and:
```bash
git submodule status --recursive
```
Because `git status` ran with `--ignore-submodules=none` before explicit submodule containment validation had executed, Git could implicitly inspect/recurse into submodule worktrees. Furthermore, `git submodule status --recursive` delegated full recursive traversal across all nested submodules to Git plumbing, without first verifying that nested submodule worktrees resided canonically beneath the validated project root. Consequently, JavaScript checks executed later could not mathematically guarantee:
```text
NO GIT WORKTREE ACCESS OUTSIDE PROJECT ROOT
```

### Pre-Flight Verification
- Branch: `review/v3-wp04-workspace-state-final`
- Commit SHA: `224abc469b6780514b9822c167fc8d05a87dab2e`
- Ambient untracked file: `manifest.json` preserved untouched.
- New working branch created: `review/v3-wp04-workspace-state-seal`.

---

# 2. WSAUTH-08 Implicit Git Submodule Traversal

### Flaw Analysis
Under `WSAUTH-08`, relying on Git's native recursion mechanisms creates an uncontrolled boundary escape vector:
1. `git status` with `--ignore-submodules=none` inspects submodule worktrees during superproject status collection, which occurs prior to any submodule path validation.
2. `git submodule status --recursive` recurses into nested gitlinks arbitrarily. If a nested submodule (e.g. `modules/A/vendor/B`) has a worktree or symlink pointing outside the project root, Git accesses the external directory before user-space containment can intervene.
3. Therefore, both `--ignore-submodules=none` and `git submodule status --recursive` violate the fundamental containment invariant.

### Required Invariant
Before any Git operation is permitted to inspect a submodule worktree at any depth:
```text
that exact worktree path must already have been
lexically and canonically proven beneath project_root.
```
No implicit Git recursion is trusted.

---

# 3. Safe Recursive Gitlink Discovery

To eliminate all implicit recursion, `workspace-state.js` implements an explicit, user-space recursive collector:
```javascript
function collectRepositorySubmodules(repositoryRoot, canonicalProjectRoot, projectRelativePrefix, customFs)
```

### Discovery Algorithm at Each Repository Level:
1. **Index-Only Query**: Executes `git ls-files --stage -z` within the already containment-validated `repositoryRoot`. This reads only the repository index file (`.git/index`) and never inspects worktree files or nested submodules.
2. **Raw Byte Gitlink Parsing**: Parses gitlinks (mode `160000`) directly from raw byte buffers delimited by NUL (`0x00`) and TAB (`0x09`).
3. **Strict UTF-8 Decoding**: Decodes the gitlink relative path using `new TextDecoder('utf-8', { fatal: true })`. Whitespace is preserved untrimmed.
4. **Lexical Containment**: Validates that the gitlink path is strictly relative and does not traverse parent directories (`..`).
5. **Filesystem Inspection Without Alias Traversal**: Calls `lstatSync` on the candidate worktree path. If it does not exist, the submodule is recorded as uninitialized (`initialized = false`) without executing any Git command.
6. **Canonicalization**: Calls `realpathSync` to resolve the true filesystem path of the submodule directory.
7. **Canonical Containment Proof**: Proves that `path.relative(canonicalProjectRoot, canonicalSubmod)` does not start with `..` and is not absolute. If the path escapes the top-level project root, execution immediately fails closed with `UNSAFE_UNTRACKED_PATH`.
8. **Git Execution Guard**: Only after lexical and canonical containment are proven is any Git command (`rev-parse`, `status`) executed inside that submodule directory.
9. **Recursive Submodule Discovery**: The function then recursively invokes itself on the validated submodule directory with prefix `projectRelativePrefix + gitPath + '/'`.

---

# 4. Canonical Worktree Containment

Every submodule worktree, whether top-level (`depth = 1`) or deeply nested (`depth >= 2`), must satisfy:
1. **Lexical Containment**: `path.resolve(currentRepoRoot, gitPath)` is beneath `currentRepoRoot`.
2. **Canonical Containment**: `realpathSync(candidateSubmodPath)` is strictly beneath the top-level `canonicalProjectRoot`.

If any submodule path resolves outside `canonicalProjectRoot` (via symlink, Windows junction, or path traversal):
- Execution fails closed immediately with `UNSAFE_UNTRACKED_PATH`.
- Zero Git commands are run with that path as working directory (`cwd`).
- Zero `git -C` commands target that path.
- Zero file bytes or directory contents are inspected inside it.

---

# 5. Superproject Status / Diff Contract

To guarantee that superproject commands never touch submodule worktrees:
1. **Superproject Status**:
   ```bash
   git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all
   ```
   Uses `--ignore-submodules=all`. This guarantees that `git status` never recurses into or stats submodule worktrees. Submodule state is captured exclusively by the safe recursive submodule collector.
2. **Superproject Diff (Staged)**:
   ```bash
   git diff --cached --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --diff-algorithm=myers --ignore-submodules=all
   ```
3. **Superproject Diff (Unstaged)**:
   ```bash
   git diff --binary --full-index --no-ext-diff --no-textconv --no-renames --no-color --diff-algorithm=myers --ignore-submodules=all
   ```
   Both staged and unstaged diffs include `--ignore-submodules=all`. Any staged gitlink SHA change is authoritatively detected by `git ls-files --stage -z` and incorporated into `submodule_status_sha256`.

---

# 6. Per-Submodule Dirty-State Contract

For each initialized, containment-validated submodule:
1. **Submodule HEAD**:
   ```bash
   git rev-parse --verify HEAD
   ```
   Must succeed with exit code `0`. Any non-zero exit code throws `GIT_COMMAND_FAILED`. No state ID is generated.
2. **Submodule Working Tree Dirty Status**:
   ```bash
   git status --porcelain=v2 -z --untracked-files=all --ignore-submodules=all
   ```
   Executed with `cwd = canonicalSubmod`. The `--ignore-submodules=all` flag ensures this submodule does NOT recurse into its own nested submodules. Its dirty status buffer is hashed to `dirty_status_sha256`.
3. **Uninitialized Submodules**:
   If `lstatSync` fails or directory does not exist:
   `observed_head: null`, `dirty_status_sha256: null`, `initialized: false`. No Git commands are executed.

---

# 7. Nested Submodule Semantics

### Full Project-Relative Path Identity
Nested submodules maintain their full path relative to the top-level superproject root (e.g. `modules/A/vendor/B`). Local directory basenames are never used as path keys.

### Deterministic Sorting
All collected records across all recursion depths are flattened and sorted deterministically by exact full project-relative Git path using standard lexicographical comparison.

### Per-Submodule Record Schema
```json
{
  "path": "modules/A/vendor/B",
  "recorded_gitlink_sha": "0123456789abcdef0123456789abcdef01234567",
  "observed_head": "0123456789abcdef0123456789abcdef01234567",
  "initialized": true,
  "dirty_status_sha256": "abcdef..."
}
```
For uninitialized submodules:
```json
{
  "path": "modules/A/vendor/B",
  "recorded_gitlink_sha": "0123456789abcdef0123456789abcdef01234567",
  "observed_head": null,
  "initialized": false,
  "dirty_status_sha256": null
}
```

---

# 8. Final Submodule Digest Contract

The component `submodule_status_sha256` is computed as:
```javascript
createHash('sha256').update(Buffer.from(canonicalJson(submoduleRecords), 'utf8')).digest('hex')
```
- The raw `git submodule status --recursive` command has been completely excised from production code.
- State version remains `workspace-state-v1` because WP-V3-04 had not been externally approved and this WorkOrder seals the intended v1 semantics.

---

# 9. Two-Pass Stability

Both passes of `getWorkspaceState` execute the identical safe recursive submodule collection.
The two snapshots compare:
1. `branch`
2. `head`
3. `status_sha256`
4. `staged_diff_sha256`
5. `unstaged_diff_sha256`
6. `untracked_manifest_sha256`
7. `submodule_status_sha256`

If any component differs between pass 1 and pass 2, execution fails closed with `WORKSPACE_STATE_UNAVAILABLE`. No retry loop is attempted.

---

# 10. Negative Test Matrix

| Test ID | Scenario | Injected Condition | Expected Behavior | Proven Invariant |
| :--- | :--- | :--- | :--- | :--- |
| **WS-046** | Top-level external submodule before status | Superproject index contains gitlink `modules/sub1` pointing via symlink to external dir | Throws `UNSAFE_UNTRACKED_PATH` | Zero Git worktree inspection commands run before containment failure; superproject status does not inspect submodules |
| **WS-047** | Nested submodule escape | Superproject -> `modules/A` (safe) -> `vendor/B` (symlink to external dir) | Throws `UNSAFE_UNTRACKED_PATH` | Zero Git commands executed with external dir as `cwd` or `-C` |
| **WS-048** | No implicit recursive command | Spy on Git commands during normal collection | Passes cleanly | `git submodule status --recursive` is never executed; status and diff use `--ignore-submodules=all` |
| **WS-049** | Nested submodule HEAD change | Superproject -> `modules/A` -> `vendor/B`; checkout commit inside B | `submodule_status_sha256` changes, `workspace_state_id` changes | Nested HEAD tracking is authoritatively captured without network |
| **WS-050** | Nested submodule dirty change | Modify file inside nested `modules/A/vendor/B` worktree | `submodule_status_sha256` changes, `workspace_state_id` changes | Explicit recursive dirty tracking captures nested worktree modifications |
| **WS-051** | Staged gitlink change detection | Superproject stages updated gitlink SHA | `submodule_status_sha256` changes, `workspace_state_id` changes | Index gitlink changes captured by dedicated submodule component even with `--ignore-submodules=all` on diff |

---

# 11. Command Evidence

All 51 workspace-state tests (`WS-001` .. `WS-051`) execute and pass:
```text
======================================================================
RUNNING WORKSPACE-STATE TEST SUITE (WS-001 .. WS-051)
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
[WS-046] Superproject index with external submodule fails closed before status (WS-046) ... ✓ PASSED
[WS-047] Nested submodule escaping project root fails closed with 0 external Git calls (WS-047) ... ✓ PASSED
[WS-048] Implicit recursive submodule command absent; status/diff ignore submodules (WS-048) ... ✓ PASSED
[WS-049] Nested submodule HEAD change alters state ID (WS-049) ... ✓ PASSED
[WS-050] Nested submodule dirty worktree change alters state ID (WS-050) ... ✓ PASSED
[WS-051] Staged submodule gitlink changes submodule digest and workspace_state_id (WS-051) ... ✓ PASSED

======================================================================
ALL WORKSPACE-STATE TESTS PASSED (WS-001 .. WS-051: 51/51 PASS)
======================================================================
```

---

# 12. Registry Regression

- Command: `node pipeline-ui/test/refactor/registry.test.js`
- Result: **39/39 PASS** (`RG-001` .. `RG-039`)
- Verification: Persistent registry authority, path canonicalization, and schema contracts remain fully intact.

---

# 13. Broker Regression

- Command: `node pipeline-ui/test/refactor/broker-core.test.js`
- Result: **48/48 PASS** (`BC-001` .. `BC-048`)
- Verification: Immutability closures, state transitions, wait semantics, and lifecycle store boundaries remain fully intact.

---

# 14. Legacy Regression

- Commands:
  - `node test/refactor/wp01-regression.test.js` -> **17/17 PASS** (`L-NT-029` .. `L-NT-045`)
  - `node test/refactor/characterization.test.js` -> **PASS** (Zero regressions; baseline defects reproduced).

---

# 15. npm test Classification

- Command: `npm test` from `pipeline-ui`
- Output: `AssertionError [ERR_ASSERTION]: Found registered project workspace-test` at `pipeline-api.test.js:72:12`
- Classification: `UNCHANGED_PRE_EXISTING_FAILURE` (baseline fixture defect documented in WO-V3-001).

---

# 16. Scope Compliance

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

# 17. Deferred Work

- **WP-V3-05**: Antigravity / AO Desktop Worker Adapter.
- **WP-V3-06**: Semantic CLI.
- **WP-V3-07**: Codex Task Bootstrap & Auditor Automation.
- **UI / Server Refactor**: Thin orchestrator endpoint wiring.

---

# 18. Recommendation

```text
READY_FOR_WP_V3_04_APPROVAL
```

---

# 32. Command Authority Table

| Command | Can inspect submodule worktree? | Containment required first? | Final flags |
| :--- | :--- | :--- | :--- |
| `git ls-files --stage -z` | **NO** (index-only query) | No (runs only in repository root already proven canonical) | `--stage`, `-z` |
| `git status` (superproject) | **NO** (submodules ignored) | Yes (project root proven canonical) | `--porcelain=v2`, `-z`, `--untracked-files=all`, `--ignore-submodules=all` |
| `git diff --cached` (staged diff) | **NO** (submodules ignored) | Yes (project root proven canonical) | `--cached`, `--binary`, `--full-index`, `--no-ext-diff`, `--no-textconv`, `--no-renames`, `--no-color`, `--diff-algorithm=myers`, `--ignore-submodules=all` |
| `git diff` (unstaged diff) | **NO** (submodules ignored) | Yes (project root proven canonical) | `--binary`, `--full-index`, `--no-ext-diff`, `--no-textconv`, `--no-renames`, `--no-color`, `--diff-algorithm=myers`, `--ignore-submodules=all` |
| `git rev-parse --verify HEAD` (submodule HEAD) | **YES** (reads submodule Git repo) | **YES** (lexical and canonical containment proven beneath `projectRoot` before execution) | `--verify`, `HEAD` |
| `git status` (submodule dirty status) | **YES** (reads submodule worktree, but ignores nested) | **YES** (lexical and canonical containment proven beneath `projectRoot` before execution) | `--porcelain=v2`, `-z`, `--untracked-files=all`, `--ignore-submodules=all` |

---

# 33. Recursion Table

| Depth | Full project-relative path | Canonical path beneath root? | Initialized? | Git execution allowed? |
| :--- | :--- | :--- | :--- | :--- |
| Top-level safe (`depth = 1`) | `modules/A` | **YES** | **YES** | **YES** (`git rev-parse`, `git status --ignore-submodules=all`) |
| Top-level escape (`depth = 1`) | `modules/escaped` | **NO** (symlink/junction to external target) | N/A | **NO (BLOCKED)** — throws `UNSAFE_UNTRACKED_PATH` before any Git execution |
| Nested safe (`depth = 2`) | `modules/A/vendor/B` | **YES** | **YES** | **YES** (`git rev-parse`, `git status --ignore-submodules=all`) |
| Nested escape (`depth = 2`) | `modules/A/vendor/escaped_B` | **NO** (symlink/junction to external target) | N/A | **NO (BLOCKED)** — throws `UNSAFE_UNTRACKED_PATH` before any Git execution |
| Nested uninitialized (`depth = 2`) | `modules/A/vendor/uninit` | **YES** (path is within root) | **NO** (`lstatSync` fails or directory does not exist) | **NO** — recorded as `initialized = false`, `observed_head = null`, `dirty_status_sha256 = null` with 0 Git commands |

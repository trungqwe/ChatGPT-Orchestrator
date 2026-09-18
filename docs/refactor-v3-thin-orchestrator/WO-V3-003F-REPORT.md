# WorkOrder Report: WO-V3-003F

## WP-V3-03 FINAL CORRECTNESS CLOSURE

### Absolute Root Authority + Fail-Closed Realpath + Detached Validation

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Branch**: `review/v3-wp03-registry`
- **Parent SHA**: `0c7eae7535f967babe30a562e4a951839091f20a`
- **Architecture Authority**: `3001dce9e0d010f4b68fc7b061072ec9b30f093d`
- **Active Branch**: `review/v3-wp03-registry-final`
- **Status**: `READY_FOR_WP_V3_03_FINAL_EXTERNAL_REVIEW`

---

# 1. Baseline

- Pre-flight verified on `review/v3-wp03-registry` at commit `0c7eae7535f967babe30a562e4a951839091f20a`.
- Local untracked file: `manifest.json` (ambient IDE file, preserved untouched).
- Branch created: `review/v3-wp03-registry-final`.
- Target: Close remaining correctness defects REG-01, REG-02, REG-03, and REG-04 without expanding scope into WP-V3-04+.

---

# 2. REG-01 Structural Root Authority

- Extracted pure helper `validateProjectRootShape(projectRoot, platform)` that performs structural checks without touching the filesystem.
- Enforced that persisted `project_root` must be an absolute, fully-qualified path:
  - On Windows: Requires fully-qualified drive path (`C:\...`, `D:/...`) or UNC path (`\\server\share\...`). Rejects relative paths (`.`, `..`, `./foo`, `foo/bar`), root-relative paths (`\`, `\Code\App`), and drive-relative paths (`C:foo`).
  - On POSIX: Requires absolute path starting with `/`. Rejects relative paths.
- Document loading (`validateRegistryDocument`) strictly enforces `validateProjectRootShape` on every project record, failing closed with `REGISTRY_SCHEMA_INVALID` if any persisted project has a non-absolute or root-relative path.
- Preserves the approved architectural invariant:
  ```text
  STRUCTURAL VALIDITY != RUNTIME AVAILABILITY
  ```
  An absolute root whose directory does not currently exist on disk loads structurally without corrupting the registry file, whereas a relative or root-relative root is rejected immediately on load.
- `canonicalizeProjectRoot()` applies this exact same structural root shape contract before accessing the filesystem.

---

# 3. REG-02 Realpath Fail-Closed Semantics

- Removed `path.resolve()` fallback from `canonicalizeProjectRoot()`.
- If filesystem `stat` indicates a directory exists, but `realpath` cannot prove canonical filesystem identity, `canonicalizeProjectRoot()` fails closed with `INVALID_PROJECT_ROOT`.
- Zero best-effort path substitution; authoritative mappings must have provable canonical identity.

---

# 4. REG-03 Detached validate() Boundary

- `registry.validate()` now returns a deeply detached validated snapshot:
  ```javascript
  validateRegistryDocument(inMemoryData);
  return structuredClone(inMemoryData);
  ```
- Mutation of the object returned by `registry.validate()` has zero effect on in-memory authoritative registry state and zero effect on disk.
- Hardened load ownership in `loadFromDisk()`: `inMemoryData = structuredClone(parsed)` ensures zero external object aliasing into internal authority.

---

# 5. REG-04 Runtime Root Identity Revalidation

- `getProject(projectId)` revalidates runtime canonical identity before returning any project:
  1. Checks that `project.project_root` exists on disk and is a directory.
  2. Resolves runtime canonical path via `realpathSync` / `realpathSync.native`. If realpath fails, throws `PROJECT_ROOT_UNAVAILABLE`.
  3. Computes `runtimeIdentity = computeRootIdentityKey(runtimeCanonical)` and compares it against `storedIdentity = computeRootIdentityKey(project.project_root)`.
  4. If runtime identity does not match stored identity (identity drift), throws `PROJECT_ROOT_UNAVAILABLE`.
- No silent recanonicalization or mutation occurs on read.
- Other registered projects remain usable if one project's runtime identity drifts or is unavailable.

---

# 6. Registry Error Contract

Stable machine-readable error codes strictly maintained on `error.code`:
- `REGISTRY_CORRUPT`: Malformed JSON or unreadable registry file.
- `REGISTRY_SCHEMA_INVALID`: Schema violation, unknown field, relative root, or root-relative path.
- `PROJECT_NOT_FOUND`: Explicit project ID not present in registry.
- `DUPLICATE_PROJECT_ROOT`: Attempted registration of a canonical root already mapped to another ID.
- `INVALID_PROJECT_ROOT`: Project root relative, missing, regular file, or realpath failure during `putProject()`.
- `PROJECT_ROOT_UNAVAILABLE`: Runtime root missing, non-directory, realpath failure, or identity drift during `getProject()`.
- `REGISTRY_PERSIST_FAILED`: Filesystem atomic write or rename error during persistence.

---

# 7. Regression Matrix

| Test ID | Condition Tested | Result | Invariant Enforced |
| :--- | :--- | :--- | :--- |
| **RG-001** | Nonexistent registry file | PASS | Empty valid schema, no guessed projects |
| **RG-002** | Semantic persistence and reload | PASS | Exact round-trip fidelity |
| **RG-003** | Duplicate basename, distinct roots/IDs | PASS | Distinct mappings co-exist without collision |
| **RG-004** | Duplicate canonical root identity | PASS | `DUPLICATE_PROJECT_ROOT` rejected |
| **RG-005** | Relative or missing project root | PASS | `INVALID_PROJECT_ROOT` rejected |
| **RG-006** | Project root is a regular file | PASS | `INVALID_PROJECT_ROOT` rejected |
| **RG-007** | Missing/empty worker session ID | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-008** | Non-antigravity worker engine | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-009** | Invalid auditor descriptors | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-010** | Unsupported policy values | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-011** | Unknown properties at any level | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-012** | Malformed JSON registry file | PASS | `REGISTRY_CORRUPT`, file untouched |
| **RG-013** | Unsupported schema version | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-014** | Map key / project_id mismatch | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-015** | Project root deleted after load | PASS | `PROJECT_ROOT_UNAVAILABLE` thrown, others usable |
| **RG-016** | Caller mutation of `getProject()` | PASS | Detached return value, internal state unaltered |
| **RG-017** | Caller mutation of `listProjects()` | PASS | Detached return value, internal state unaltered |
| **RG-018** | Persistence rename/write failure | PASS | `REGISTRY_PERSIST_FAILED`, prior state intact |
| **RG-019** | Concurrent same-instance mutations | PASS | Serialized sequentially, zero lost updates |
| **RG-020** | Explicit update of existing project | PASS | Full record replaced only after complete revalidation |
| **RG-021** | Removal of existing project | PASS | Removed from memory and persisted to disk |
| **RG-022** | Removal of unknown project | PASS | Deterministic `PROJECT_NOT_FOUND` |
| **RG-023** | Legacy preview with defects | PASS | Issues detected, zero persistence side effects |
| **RG-024** | Legacy preview of clean path | PASS | Non-authoritative candidate proposal only |
| **RG-025** | Preview-only verification | PASS | No apply/import mutation API exists, zero writes |
| **RG-026** | Broker integration dispatch | PASS | Exact registered descriptors passed to workerPort |
| **RG-027** | Basename query without exact ID | PASS | `PROJECT_NOT_FOUND`, no fallback routing |
| **RG-028** | Ambient legacy file adjacent to dir | PASS | Zero auto-import, registry remains empty |
| **RG-029** | Secret fields (token, cookie, etc.) | PASS | Rejected at schema boundary, zero disk writes |
| **RG-030** | Windows path normalization | PASS | Casing, slashes, and `.`/`..` resolve identical key |
| **RG-031** | `worker.enabled = false` | PASS | `REGISTRY_SCHEMA_INVALID` rejected |
| **RG-032** | Mutation queue recovery after error | PASS | Failed mutation does not poison subsequent queue |
| **RG-033** | `validate()` snapshot detached | PASS | Mutating validate snapshot leaves internal state and disk intact |
| **RG-034** | Persisted relative root rejected | PASS | `REGISTRY_SCHEMA_INVALID` on load |
| **RG-035** | Windows root-relative path rejected | PASS | `REGISTRY_SCHEMA_INVALID` on load |
| **RG-036** | Realpath failure on `putProject()` | PASS | `INVALID_PROJECT_ROOT`, no `path.resolve` fallback |
| **RG-037** | Realpath failure on `getProject()` | PASS | `PROJECT_ROOT_UNAVAILABLE`, zero worker calls via broker |
| **RG-038** | Runtime root identity drift | PASS | `PROJECT_ROOT_UNAVAILABLE` on drift, no silent mutation |
| **RG-039** | Absolute missing root on load | PASS | Structural load succeeds, `getProject()` fails closed |

---

# 8. Command Evidence

### Static Syntax Checks
```text
node -c pipeline-ui/lib/broker/registry.js
node -c pipeline-ui/test/refactor/registry.test.js
node -c pipeline-ui/lib/broker/broker.js
node -c pipeline-ui/lib/broker/contracts.js
node -c pipeline-ui/lib/broker/lifecycle-store.js
Exit code: 0
```

### Registry Test Suite (RG-001 .. RG-039)
```text
node pipeline-ui/test/refactor/registry.test.js
======================================================================
ALL REGISTRY TESTS PASSED (RG-001 .. RG-039: 39/39 PASS)
======================================================================
Exit code: 0
```

### Broker Core Regression Suite (BC-001 .. BC-048)
```text
node pipeline-ui/test/refactor/broker-core.test.js
======================================================================
ALL BROKER CORE TESTS PASSED (BC-001 .. BC-048: 48/48 PASS)
======================================================================
Exit code: 0
```

### Git Diff Check
```text
git diff --check
Exit code: 0
```

---

# 9. Broker Regression

- All 48 tests in `pipeline-ui/test/refactor/broker-core.test.js` passed with 0 failures.
- Zero modifications made to `broker.js`, `contracts.js`, or `lifecycle-store.js`.

---

# 10. Legacy Regression

- `node test/refactor/wp01-regression.test.js`: PASS (0 regressions).
- `node test/refactor/characterization.test.js`: PASS (0 regressions).

---

# 11. npm test Classification

- Result: `UNCHANGED_PRE_EXISTING_FAILURE`
- Pre-existing failure in `test/pipeline-api.test.js` due to missing `workspace-test` in legacy `user-projects.json`.
- Zero new regressions introduced.

---

# 12. Scope Compliance

```text
WP-V3-04 started:
NO

Workspace-state implementation:
NO

WP-V3-05 started:
NO

AO adapter:
NO

Semantic CLI:
NO

server.js modified:
NO

broker.js modified:
NO

user-projects.json modified:
NO

package.json modified:
NO
```

### Local Untracked Files
- `manifest.json`: Ambient IDE workspace file (untracked in repository, preserved untouched).

---

# 13. Remaining Deferred Work

- **WP-V3-04**: Real workspace-state hashing (`workspace_state_id`, git status, untracked diffs).
- **WP-V3-05**: Antigravity / AO worker adapter.
- **WP-V3-06**: Semantic broker CLI.
- **WP-V3-07**: Codex auditor bootstrap.

---

# 14. Root Authority Table

| Stored root | Structural load | Runtime availability | Runtime canonical identity | Result |
| :--- | :--- | :--- | :--- | :--- |
| `.` | REJECTED (`REGISTRY_SCHEMA_INVALID`) | N/A | N/A | Fails closed on load |
| `\SomeFolder` | REJECTED (`REGISTRY_SCHEMA_INVALID`) | N/A | N/A | Fails closed on load |
| `D:\TU_CODE\App` (existing) | ACCEPTED | Exists (dir) | Matches stored identity | Dispatchable mapping returned |
| `D:\Missing\Folder` | ACCEPTED | MISSING (`PROJECT_ROOT_UNAVAILABLE`) | N/A | Structural load succeeds; `getProject()` fails closed |
| `D:\Fault\Folder` (realpath throws) | ACCEPTED | Exists (dir) | FAILS (`PROJECT_ROOT_UNAVAILABLE`) | `getProject()` fails closed; 0 broker worker calls |
| `D:\Drift\Folder` (realpath -> Y) | ACCEPTED | Exists (dir) | MISMATCH (`PROJECT_ROOT_UNAVAILABLE`) | `getProject()` fails closed; no silent update |

---

# 15. Detachment Table

| API | Caller mutation attempted | Internal changed? | Disk changed? |
| :--- | :--- | :--- | :--- |
| `getProject(id)` | Mutate returned project object | NO | NO |
| `listProjects()` | Mutate items in returned array | NO | NO |
| `putProject(record)` | Mutate returned stored project | NO | NO |
| `validate()` | Mutate returned document snapshot | NO | NO |

---

# 16. Recommendation

All four registry correctness defects (REG-01, REG-02, REG-03, REG-04) are fully closed, sealed, and verified across all 39 tests. The implementation is ready for final external review:

```text
READY_FOR_WP_V3_03_FINAL_EXTERNAL_REVIEW
```

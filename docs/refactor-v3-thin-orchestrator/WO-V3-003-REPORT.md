# WorkOrder Report: WO-V3-003

## WP-V3-03 — Persistent Project / Session / Auditor Registry

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Approved Parent Branch**: `review/v3-wp02-broker-core-final`
- **Approved Parent SHA**: `eaf28c75308a76ae3226e06f3435f7ae3fa2f5ae`
- **Architecture Authority**: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Active Branch**: `review/v3-wp03-registry`
- **Status**: `READY_FOR_WP_V3_03_EXTERNAL_REVIEW`

---

# 1. Baseline

- Pre-flight working tree verified clean on `review/v3-wp02-broker-core-final` at commit `eaf28c75308a76ae3226e06f3435f7ae3fa2f5ae`.
- Untracked workspace artifact: `manifest.json` (preserved untouched).
- Branch created: `review/v3-wp03-registry`.
- Legacy UI configuration `pipeline-ui/user-projects.json` inspected and confirmed untrusted (contains duplicate entries, empty IDs, root `"\"`, and lacks v3 worker/auditor mappings).

---

# 2. Registry Responsibility

The project registry implemented in `pipeline-ui/lib/broker/registry.js` serves as the sole control-plane authority mapping:
```text
project_id
    ->
exact project root
exact Antigravity worker session descriptor
exact user-owned Codex auditor descriptor
policy
```

Non-responsibilities strictly preserved:
- Does NOT calculate workspace state hashes (`workspace_state_id`, git status, untracked diffs) -> deferred to WP-V3-04.
- Does NOT validate live AO runtime availability or execute AO commands -> deferred to WP-V3-05.
- Does NOT automate Codex task sessions or communicate with ChatGPT -> deferred to WP-V3-07.
- Does NOT pass code quality verdicts or modify target repositories.

---

# 3. Persistent File Location

- Default storage path resolves outside target repositories via user home directory:
  ```javascript
  const defaultPath = path.join(os.homedir(), '.orchestrator', 'projects.json');
  ```
  Resolves dynamically on Windows (e.g. `C:\Users\<user>\.orchestrator\projects.json`) without any hard-coded usernames.
- Injected `registryFilePath` is supported for testing and isolated instances.
- Registry is never written inside audited target repositories.

---

# 4. Schema Contract

The registry enforces a strict whitelist-only schema at all levels. Unknown fields fail validation closed with `REGISTRY_SCHEMA_INVALID`.
```json
{
  "schema_version": 1,
  "projects": {
    "ai-multi-task": {
      "project_id": "ai-multi-task",
      "project_name": "AI_Multi_Task",
      "project_root": "D:\\TU_CODE\\AI_Multi_Task",
      "worker": {
        "engine": "antigravity",
        "session_id": "exact-session-descriptor",
        "enabled": true
      },
      "auditor": {
        "engine": "codex",
        "task_id": "user-selected-descriptor",
        "task_id_verified": false,
        "expected_model_label": "ChatGPT Web — GPT-5.6 Sol High",
        "mode": "full-harness",
        "managed_by_orchestrator": false
      },
      "policy": {
        "max_active_dispatches": 1,
        "require_workspace_state": true
      }
    }
  }
}
```

Key Schema Invariants:
- `schema_version`: Must equal `1`.
- `project_id`: Must match pattern `^[a-z0-9][a-z0-9._-]{0,127}$` and must match the dictionary key in `projects`.
- `project_name`: Non-empty string.
- `project_root`: Absolute path to an existing directory.
- `worker`: `engine: "antigravity"`, non-empty `session_id`, `enabled: true`.
- `auditor`: `engine: "codex"`, non-empty `task_id`, boolean `task_id_verified`, non-empty `expected_model_label`, `mode: "full-harness"`, `managed_by_orchestrator: false`.
- `policy`: `max_active_dispatches: 1`, `require_workspace_state: true`.
- No secrets: Fields such as `api_key`, `token`, `cookie`, `password`, `tunnel_key` are rejected by the strict allowlist.

---

# 5. Project Root Canonicalization

Root paths are normalized to deterministic canonical representations:
- Forward/backward slashes normalized.
- Trailing slashes stripped (except drive roots).
- Relative components (`.`, `..`) resolved.
- Case-insensitive identity keys computed on Windows (`d:\tu_code\ai_multi_task`).
- Realpath resolution (`fs.realpathSync.native` / `fs.realpathSync`) applied to verify filesystem identity.
- Duplicate canonical roots across different `project_id` values fail closed with `DUPLICATE_PROJECT_ROOT`.
- Duplicate basenames with different canonical roots and distinct IDs are accepted.

---

# 6. Worker Mapping Contract

- `worker.engine`: Must strictly equal `"antigravity"`.
- `worker.session_id`: Must be a non-empty string.
- `worker.enabled`: Must be strictly `true` (per Addendum A-03).
- Missing, empty, or disabled worker sessions are rejected at schema validation and never exposed as dispatchable mappings.

---

# 7. Auditor Mapping Contract

- `auditor.engine`: Must strictly equal `"codex"`.
- `auditor.task_id`: Non-empty descriptor or stable identifier.
- `auditor.task_id_verified`: Explicit boolean (never guessed or fabricated).
- `auditor.expected_model_label`: Exact non-empty user-specified label (e.g. `"ChatGPT Web — GPT-5.6 Sol High"`).
- `auditor.mode`: Must strictly equal `"full-harness"`.
- `auditor.managed_by_orchestrator`: Must strictly equal `false`.

---

# 8. Persistence / Atomic Replacement

- Serialized as deterministic readable JSON (2-space indentation + trailing newline).
- Atomic replacement workflow:
  1. Write to unique temporary file in the same directory (`.projects.<timestamp>.<random>.tmp`).
  2. Flush file descriptor using `fsync`.
  3. Close file descriptor.
  4. Atomically rename/replace target file (`fs.renameSync`).
  5. Clean up temporary file on failure.
- In-memory authority state updates ONLY after successful disk persistence.
- No `unlink(target)` preceding `rename`, preventing missing-file windows.
- POSIX file mode set to `0o600` (user read/write only); no unsupported Windows ACL guarantees claimed.

---

# 9. Mutation Serialization

- Same-process mutations (`putProject`, `removeProject`) are serialized through an internal promise queue.
- Rejection recovery (Addendum A-05): If a mutation fails or throws during persistence, the promise queue recovers cleanly and does not poison subsequent mutations.
- Concurrent overlapping mutations execute sequentially without lost updates.

---

# 10. Legacy Import Policy

- Pure preview helper: `registry.previewLegacyImport(legacyEntries)`.
- No mutation API: Per Addendum A-01, `applyLegacyImport` does NOT exist in production code.
- Legacy records are flagged as incomplete candidates (`CANDIDATE_REQUIRES_COMPLETION`) with `authoritative: false` because legacy `user-projects.json` does not provide worker sessions, auditor descriptors, or policies.
- Zero disk or memory side-effects from invoking `previewLegacyImport`.

---

# 11. Broker Integration

- Concrete `createProjectRegistry` verified as injected `registryPort` with standalone broker core (`createBroker`).
- Broker `dispatchWorker` queries registry by explicit `project_id`.
- Passed project object to `workerPort.dispatch` retains exact registered `project_root`, `worker.session_id`, and `auditor` descriptors.
- Basename fallback queries (e.g. dispatching by basename `app` when project ID is `client-a-app`) fail closed with `PROJECT_NOT_FOUND`.

---

# 12. Negative Test Matrix

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
| **RG-015** | Project root deleted after load | PASS | `PROJECT_ROOT_UNAVAILABLE` thrown, other projects usable |
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

---

# 13. Command Evidence

### Static Syntax Checks
```text
node -c pipeline-ui/lib/broker/registry.js
node -c pipeline-ui/test/refactor/registry.test.js
node -c pipeline-ui/lib/broker/broker.js
node -c pipeline-ui/lib/broker/contracts.js
node -c pipeline-ui/lib/broker/lifecycle-store.js
Exit code: 0
```

### Registry Test Suite (RG-001 .. RG-032)
```text
node pipeline-ui/test/refactor/registry.test.js
======================================================================
ALL REGISTRY TESTS PASSED (RG-001 .. RG-032: 32/32 PASS)
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

# 14. Broker Regression

- All 48 tests in `pipeline-ui/test/refactor/broker-core.test.js` passed without modification.
- Broker contract compatibility confirmed with real registry instance in `RG-026` and `RG-027`.

---

# 15. Legacy Regression

- `node test/refactor/wp01-regression.test.js` passed with 0 regressions.
- `node test/refactor/characterization.test.js` passed with 0 regressions.

---

# 16. npm test Classification

- Result: `UNCHANGED_PRE_EXISTING_FAILURE`
- Pre-existing failure in `test/pipeline-api.test.js` due to missing `workspace-test` in legacy `user-projects.json` (identical to baseline observed in WP-V3-01 and WP-V3-02).
- Zero new regressions introduced.

---

# 17. Scope Compliance

```text
WP-V3-04 started:
NO

Workspace-state implementation:
NO

WP-V3-05 started:
NO

AO adapter:
NO

AO called live:
NO

Codex called live:
NO

Semantic CLI:
NO

server.js modified:
NO

user-projects.json modified:
NO

package.json modified:
NO

UI modified:
NO
```

---

# 18. Deferred Work

- **WP-V3-04**: Real workspace-state hashing (`workspace_state_id` generation, untracked diff detection, git submodule state verification).
- **WP-V3-05**: Live Antigravity / AO worker adapter.
- **WP-V3-06**: Semantic broker CLI commands.
- **WP-V3-07**: Codex auditor bootstrap & verification.
- **Server/UI Integration**: Wiring broker and registry into server routes and Electron desktop UI.

---

# 19. Root Table

| Input path | Canonical/display path | Identity key | Accepted? | Reason |
| :--- | :--- | :--- | :--- | :--- |
| `D:\TU_CODE\AI_Multi_Task` | `D:\TU_CODE\AI_Multi_Task` | `d:\tu_code\ai_multi_task` | YES | Normal absolute Windows path |
| `d:\TU_CODE\AI_Multi_Task` | `d:\TU_CODE\AI_Multi_Task` | `d:\tu_code\ai_multi_task` | NO (if D:\ already registered) | Duplicate canonical root identity |
| `D:/TU_CODE/AI_Multi_Task/` | `D:\TU_CODE\AI_Multi_Task` | `d:\tu_code\ai_multi_task` | NO (if D:\ already registered) | Slash/trailing separator duplicate root |
| `D:\TU_CODE\AI_Multi_Task\` | `D:\TU_CODE\AI_Multi_Task` | `d:\tu_code\ai_multi_task` | NO (if D:\ already registered) | Trailing slash duplicate root |
| `./AI_Multi_Task` | N/A | N/A | NO | Relative path rejected (`INVALID_PROJECT_ROOT`) |
| `D:\Nonexistent\Folder` | N/A | N/A | NO | Path does not exist on disk (`INVALID_PROJECT_ROOT`) |
| `D:\ExistingFile.txt` | N/A | N/A | NO | Path is a regular file, not a directory (`INVALID_PROJECT_ROOT`) |
| `D:\ClientA\app` | `D:\ClientA\app` | `d:\clienta\app` | YES | Distinct canonical root and ID |
| `E:\ClientB\app` | `E:\ClientB\app` | `e:\clientb\app` | YES | Duplicate basename accepted; distinct root & ID |

---

# 20. Legacy Import Table

| Legacy Entry (`user-projects.json`) | Candidate? | Issue Detected | Authoritative? | Written to Registry? |
| :--- | :--- | :--- | :--- | :--- |
| `id: "ai_multi_task", path: "D:\\TU_CODE\\AI_Multi_Task"` | YES | Missing worker/auditor mapping | NO | NO |
| `id: "ai_multi_task" (duplicate), path: "d:\\\\TU_CODE\\\\AI_Multi_Task\\"` | NO | Duplicate ID & duplicate canonical root | NO | NO |
| `id: "", path: "\\"` | NO | Empty project ID & invalid root path | NO | NO |
| `id: "dola-render-video", path: "d:\\\\TU_CODE\\\\dola-render-video\\"` | YES | Trailing slash normalized; missing worker/auditor | NO | NO |
| `id: "admin", path: "c:\\\\Users\\\\Admin\\"` | YES | Missing worker/auditor mapping | NO | NO |

---

# 21. Recommendation

The implementation of `pipeline-ui/lib/broker/registry.js` strictly satisfies all architectural invariants, negative tests (RG-001..RG-032), and plan review amendments. It is ready for external review:

```text
READY_FOR_WP_V3_03_EXTERNAL_REVIEW
```

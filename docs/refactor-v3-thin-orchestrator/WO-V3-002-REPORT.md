# WO-V3-002 REPORT — Standalone Deterministic Broker Core

Work Package: WP-V3-02
Repository: `https://github.com/trungqwe/ChatGPT-Orchestrator`
Parent Branch: `review/v3-wp01-seal-final`
Parent SHA: `c1ba96637a89505e9f24688eda69055d8d14137e`
Architecture Authority: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
Branch: `review/v3-wp02-broker-core`
Result Status: `READY_FOR_WP_V3_02_EXTERNAL_REVIEW`

---

## 1. Baseline

- **Parent Branch:** `review/v3-wp01-seal-final`
- **Parent Commit SHA:** `c1ba96637a89505e9f24688eda69055d8d14137e`
- **Architecture Authority:** `3001dce9e0d010f4b68fc7b061072ec9b30f093d` (`STAGE2_ARCHITECTURE_APPROVED`)
- **WP-V3-01 Status:** All legacy transport provenance blockers (B-03, B-03B, B-04, B-05, B-06, B-07) are closed and sealed in the parent.
- **Governing V3 Architectural Division:**
  ```text
  SOL DECIDES
  ORCHESTRATOR GUARDS AND ROUTES
  ANTIGRAVITY IMPLEMENTS
  ```

---

## 2. Broker Core Responsibility

`broker.js` implements the core deterministic routing, precondition validation, and dispatch lifecycle coordination for the Thin-Orchestrator architecture:
- Accepts semantic operations (`dispatchWorker`, `waitWorker`, `getWorkerStatus`, `getProject`, `getWorkspaceState`).
- Validates deterministic control preconditions (schema, schema version, required non-empty string fields, payload size <= 2 MiB, rejection of raw command fields).
- Enforces the strict rule of one active worker dispatch per project.
- Prevents split-brain and stale execution via workspace state freshness comparison.
- Provides canonical idempotent deduplication for repeated identical dispatches.
- Interacts exclusively with injected external dependency ports (`registryPort`, `workspacePort`, `workerPort`, `lifecycleStore`, `idFactory`, `clock`).
- Contains **ZERO** model evaluation logic, keyword parsing, LLM calls, shell command generation, Express/HTTP wiring, or Electron UI code.

---

## 3. Dependency Ports

All infrastructure dependencies are injected into the broker factory (`createBroker`). No direct dependencies on disk layout, Git subprocesses, or AO binaries are present in broker core.

### Dependency Table

| Port | Methods | Implemented in WP-V3-02? | Fake Used in Tests? | Future Implementation WP |
| :--- | :--- | :---: | :---: | :--- |
| **`registryPort`** | `getProject(projectId)` | NO concrete implementation | YES | WP-V3-03 (Concrete Project Registry) |
| **`workspacePort`** | `getWorkspaceState(project)` | NO concrete implementation | YES | WP-V3-04 (Git Workspace-State Hashing) |
| **`workerPort`** | `dispatch(args)`, `wait(args)`, `status(args)` | NO concrete implementation | YES | WP-V3-05 (Antigravity / AO Worker Adapter) |
| **`lifecycleStore`** | `getDispatch`, `getActiveDispatch`, `beginDispatch`, `transition`, `getProjectHistory` | YES volatile reference implementation | YES | Later durability upgrade (journal/WAL) |
| **`idFactory`** | `nextDispatchId()` | Standard UUID fallback | YES (deterministic) | Standard built-in / configurable |
| **`clock`** | `now()`, `iso()` | Standard Date fallback | YES (deterministic) | Standard built-in / configurable |

---

## 4. Lifecycle Store Contract

`lifecycle-store.js` provides `createMemoryLifecycleStore({ clock })`:
- **Classification:** Explicitly labeled as `VOLATILE / NON-DURABLE` reference implementation for testing and development. No false claims of crash-safe write-ahead persistence are made.
- **Atomic Dispatch Registration:** `beginDispatch(projectId, record)` performs atomic check-and-insert, eliminating race conditions between concurrent requests.
- **Transition Gate:** Validates every forward state movement against `ALLOWED_TRANSITIONS`, preventing illegal resurrecting transitions (e.g. `READY_FOR_REVIEW -> RUNNING`).
- **History Tracking:** Retains an append-only sequence of state transitions with injected timestamps for auditability and characterization.

---

## 5. Dispatch State Machine

The broker defines minimal, unambiguous control states (not code-quality verdicts):

### State Table

| State | Active? | Terminal? | Can Dispatch Another WorkOrder? | Allowed Next States | Description |
| :--- | :---: | :---: | :---: | :--- | :--- |
| **`DISPATCHING`** | YES | NO | NO | `DISPATCH_ACCEPTED`, `DISPATCH_FAILED`, `DISPATCH_UNCERTAIN` | Write-ahead intent recorded before invoking worker transport. |
| **`DISPATCH_ACCEPTED`** | YES | NO | NO | `RUNNING`, `READY_FOR_REVIEW`, `DISPATCH_FAILED`, `PROVENANCE_AMBIGUOUS` | Worker transport has acknowledged receipt of WorkOrder. |
| **`RUNNING`** | YES | NO | NO | `RUNNING`, `READY_FOR_REVIEW`, `DISPATCH_FAILED`, `PROVENANCE_AMBIGUOUS` | Worker is actively executing implementation turn. |
| **`READY_FOR_REVIEW`** | NO | YES | YES | None (terminal) | Worker has completed turn; ready for Sol inspection. |
| **`DISPATCH_FAILED`** | NO | YES | YES | None (terminal) | Definitive transport or worker rejection. |
| **`DISPATCH_UNCERTAIN`** | YES (blocking) | NO | NO | None (locked until manual reconciliation) | Ambiguous transport/IPC failure; held active for safety to prevent double-dispatch. |
| **`PROVENANCE_AMBIGUOUS`** | NO | YES | YES | None (terminal) | Wait event returned identity mismatch against active dispatch. |

---

## 6. Idempotency Contract

Deterministic request fingerprinting is computed via SHA-256 over:
```text
projectId \0 workOrderId \0 expectedWorkspaceStateId \0 directive
```
- **Same WorkOrder + Same Fingerprint:** Replays the existing active dispatch (`ok: true, idempotent_replay: true, dispatch_id, state`) with zero additional worker calls.
- **Same WorkOrder + Different Fingerprint:** Rejects with `DUPLICATE_WORK_ORDER_CONFLICT`. Prevents silent directive mutation during an in-flight dispatch.
- **Different WorkOrder while another is active:** Rejects with `WORKER_BUSY`. Enforces single-dispatch per project.

---

## 7. Workspace Freshness Gate

Before dispatching to the worker, the broker resolves the current project workspace state via `workspacePort.getWorkspaceState(project)` and compares `expected_workspace_state_id` against `observed_workspace_state_id`:
- **Match:** Proceeds to atomic dispatch registration.
- **Mismatch:** Fails closed immediately with `STALE_AUDIT_STATE`, returning both expected and observed state IDs without invoking worker transport.

---

## 8. Worker Port Contract

`workerPort` is called with pure semantic payloads:
```json
{
  "project": { "id": "...", "root": "..." },
  "project_id": "...",
  "work_order_id": "...",
  "dispatch_id": "D-...",
  "directive": "..."
}
```
No shell command strings, command-line arguments, or platform flags cross this boundary.

---

## 9. Wait / Provenance Contract

`waitWorker(request)` accepts `{ project_id, dispatch_id, timeout_secs }`:
- Timeout is clamped between `MIN_TIMEOUT_SECS = 1` and `MAX_TIMEOUT_SECS = 30` (default: 10). Indefinite blocking is prohibited.
- Validates that `dispatch_id` exists and belongs to `project_id` (`DISPATCH_NOT_FOUND`, `DISPATCH_PROJECT_MISMATCH`).
- If `workerPort.wait` returns `dispatch_id` or `work_order_id` differing from the stored record, the dispatch is transitioned to `PROVENANCE_AMBIGUOUS` and rejected.

---

## 10. Test Matrix

All 20 required tests pass deterministically:

| Test ID | Scenario Description | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :---: |
| **BC-001** | Invalid request validation | `INVALID_REQUEST`, worker calls: 0 | As expected | **PASS** |
| **BC-002** | Top-level `command` field rejected | `INVALID_REQUEST`, worker calls: 0 | As expected | **PASS** |
| **BC-003** | Unknown project resolution | `PROJECT_NOT_FOUND`, worker calls: 0 | As expected | **PASS** |
| **BC-004** | Stale workspace state comparison | `STALE_AUDIT_STATE`, worker calls: 0 | As expected | **PASS** |
| **BC-005** | Valid dispatch lifecycle | `DISPATCHING -> DISPATCH_ACCEPTED`, worker calls: 1 | As expected | **PASS** |
| **BC-006** | Exact idempotent retry | Replay existing `dispatch_id`, worker calls: 1 | As expected | **PASS** |
| **BC-007** | Same WorkOrder with modified directive | `DUPLICATE_WORK_ORDER_CONFLICT`, worker calls: 1 | As expected | **PASS** |
| **BC-008** | Parallel WorkOrder while active | `WORKER_BUSY`, worker calls: 1 | As expected | **PASS** |
| **BC-009** | Definitive worker dispatch failure | Stored state `DISPATCH_FAILED` | As expected | **PASS** |
| **BC-010** | Worker dispatch transport exception | Stored state `DISPATCH_UNCERTAIN`, no auto-resend | As expected | **PASS** |
| **BC-011** | Concurrent dispatch race condition | 1 accepted, 1 `WORKER_BUSY`, worker calls: 1 | As expected | **PASS** |
| **BC-012** | `workerPort.wait` returns `RUNNING` | Preserves nonterminal `RUNNING` state | As expected | **PASS** |
| **BC-013** | `workerPort.wait` returns `READY_FOR_REVIEW` | Transitions to `READY_FOR_REVIEW` | As expected | **PASS** |
| **BC-014** | Worker wait returns mismatched `dispatch_id` | Flagged as `PROVENANCE_AMBIGUOUS` | As expected | **PASS** |
| **BC-015** | Worker wait returns mismatched `work_order_id` | Flagged as `PROVENANCE_AMBIGUOUS` | As expected | **PASS** |
| **BC-016** | Bounded wait timeout clamping | Timeout clamped to max 30s bound | As expected | **PASS** |
| **BC-017** | Illegal lifecycle transition rejection | `READY_FOR_REVIEW -> RUNNING` rejected deterministically | As expected | **PASS** |
| **BC-018** | Multi-project isolation | Project A active does not block Project B | As expected | **PASS** |
| **BC-019** | Oversized directive (> 2 MiB) | `PAYLOAD_TOO_LARGE`, worker calls: 0 | As expected | **PASS** |
| **BC-020** | Ordered deterministic lifecycle history | Ordered history with deterministic timestamps | As expected | **PASS** |

---

## 11. Command Evidence

### Static Syntax Checks
```powershell
node -c pipeline-ui/lib/broker/contracts.js
node -c pipeline-ui/lib/broker/lifecycle-store.js
node -c pipeline-ui/lib/broker/broker.js
node -c pipeline-ui/test/refactor/broker-core.test.js
# Exit Code: 0 (All Clean)
```

### Broker Core Test Suite Run (20/20 PASS)
```powershell
node pipeline-ui/test/refactor/broker-core.test.js
```
```text
======================================================================
RUNNING BROKER CORE TEST SUITE (BC-001 .. BC-020)
======================================================================

[BC-001] Testing invalid request rejection...
✓ BC-001 PASSED: Invalid requests rejected with zero worker calls.

[BC-002] Testing top-level command field rejection...
✓ BC-002 PASSED: Arbitrary command field rejected with zero worker calls.

[BC-003] Testing unknown project rejection...
✓ BC-003 PASSED: Unknown project rejected with zero worker calls.

[BC-004] Testing workspace mismatch rejection...
✓ BC-004 PASSED: Stale audit state rejected with zero worker calls.

[BC-005] Testing valid dispatch execution...
✓ BC-005 PASSED: Valid dispatch accepted with exactly 1 worker call.

[BC-006] Testing exact idempotent retry...
✓ BC-006 PASSED: Exact retry replayed existing dispatch without second worker send.

[BC-007] Testing duplicate WorkOrder conflict on modified directive...
✓ BC-007 PASSED: Conflicting WorkOrder modification rejected.

[BC-008] Testing worker busy on different active WorkOrder...
✓ BC-008 PASSED: Parallel active WorkOrder rejected as WORKER_BUSY.

[BC-009] Testing definitive worker dispatch failure...
✓ BC-009 PASSED: Definitive failure stored as DISPATCH_FAILED.

[BC-010] Testing ambiguous transport exception...
✓ BC-010 PASSED: Transport exception stored as DISPATCH_UNCERTAIN.

[BC-011] Testing concurrent dispatch race condition...
✓ BC-011 PASSED: Concurrency race atomically resolved.

[BC-012] Testing workerPort.wait returns RUNNING...
✓ BC-012 PASSED: Nonterminal RUNNING state updated cleanly.

[BC-013] Testing workerPort.wait returns READY_FOR_REVIEW...
✓ BC-013 PASSED: READY_FOR_REVIEW transition recorded.

[BC-014] Testing wrong dispatch_id returned by worker wait...
✓ BC-014 PASSED: Mismatched dispatch_id flagged as PROVENANCE_AMBIGUOUS.

[BC-015] Testing wrong work_order_id returned by worker wait...
✓ BC-015 PASSED: Mismatched work_order_id flagged as PROVENANCE_AMBIGUOUS.

[BC-016] Testing timeout clamping to max 30 seconds...
✓ BC-016 PASSED: Excessive timeout clamped to 30 seconds.

[BC-017] Testing illegal lifecycle transition rejection...
✓ BC-017 PASSED: Illegal resurrection rejected deterministically.

[BC-018] Testing project isolation...
✓ BC-018 PASSED: Project isolation verified with zero cross-talk.

[BC-019] Testing oversized directive rejection...
✓ BC-019 PASSED: Oversized directive rejected with PAYLOAD_TOO_LARGE.

[BC-020] Testing deterministic lifecycle event history...
✓ BC-020 PASSED: Ordered deterministic lifecycle transitions verified.

======================================================================
ALL BROKER CORE TESTS PASSED (BC-001 .. BC-020: 20/20 PASS)
======================================================================
```

### Whitespace / Git Diff Check
```powershell
git diff --check
# Exit Code: 0 (Clean)
```

---

## 12. Legacy Regression Result

Running existing legacy suites from `pipeline-ui`:
```powershell
node test/refactor/wp01-regression.test.js
node test/refactor/characterization.test.js
```
- `wp01-regression.test.js`: 17/17 PASS (L-NT-029 .. L-NT-045).
- `characterization.test.js`: 14/14 checks verified (F-01, F-02, F-03, NT-001..NT-004 enforced; F-06, F-10, F-12 preserved as baseline defects).
- Zero regression on sealed legacy transport.

---

## 13. npm test Classification

**Classification:** `UNCHANGED_PRE_EXISTING_FAILURE`

```text
> pipeline-ui@1.0.0 test
> node test/pipeline-api.test.js && node test/closed-loop.test.js

--- Starting Pipeline Portal Automated Tests ---
[TEST] Server listening on http://127.0.0.1:4099
[TEST 1] Testing static UI delivery (GET /)...
✓ PASS: Static UI delivery verified.
[TEST 2] Testing system health status (GET /api/status)...
✓ PASS: Health status verified. AO: offline, ChatGPT: ready, Agy: 1.2.5
[TEST 3] Testing projects API (GET /api/projects)...
❌ TEST FAILED: AssertionError [ERR_ASSERTION]: Found registered project workspace-test
    at runTests (D:\TU_CODE\Orchestrator\pipeline-ui\test\pipeline-api.test.js:72:12)
```
Failure signature is identical to baseline characterization.

---

## 14. Scope Compliance

```text
WP-V3-03 started:
NO

WP-V3-04 started:
NO

WP-V3-05 started:
NO

WP-V3-06 started:
NO

server.js modified:
NO

package.json modified:
NO

UI modified:
NO

Legacy transport modified:
NO

AO called live:
NO

Codex called live:
NO
```

---

## 15. Known Deferred Work

1. **Concrete Registry (WP-V3-03):** Persistent file-based or database project registry.
2. **Git Workspace-State Engine (WP-V3-04):** Real workspace hashing over tracked files and dirty worktree status.
3. **AO / Antigravity Worker Adapter (WP-V3-05):** Translation of semantic dispatch to AO subprocess / transcript watcher.
4. **Semantic Broker CLI (WP-V3-06):** Shell CLI adapter for Codex Full Harness task execution.
5. **Durable Lifecycle Journaling:** Future replacement of volatile memory store with append-only WAL for crash recovery.

---

## 16. Recommendation

The standalone deterministic broker core is fully implemented, isolated from external network/live dependencies, and validated against all negative control boundaries.

Status:
`READY_FOR_WP_V3_02_EXTERNAL_REVIEW`

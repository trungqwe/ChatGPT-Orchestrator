# WO-V4-03AF REPORT: Codex App Server Transport — Stable Protocol Conformance Seal

## 1. Baseline

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Commit**: `83c00e73d245d89e7e954de5f05e89929fab8a9f` (`feat(auditor): add Codex app-server transport`)
- **Review Branch**: `review/v4-wp03a-codex-app-server-transport-final`
- **Objective**: Correct stdio JSONL transport implementation and deterministic fake fixture model to conform strictly to current stable OpenAI Codex App Server protocol, resolving all blockers identified in review state:
  - `CASPROTO-01`: thread/start sandbox field mismatch
  - `CASPROTO-02`: turn/completed correlation incompatible with stable event
  - `CASPROTO-03`: review evidence identity/race
  - `CASPROTO-04`: review target stable-schema mismatch

## 2. Stable Provider Contract Review

Official schemas generated from installed Codex binary via `codex app-server generate-json-schema` and `codex app-server generate-ts` were inspected:
- **`ThreadStartParams`**: Defines fields `cwd: string`, `approvalPolicy: "never" | "onRequest" | ...`, and `sandbox: "read-only" | "readOnly" | ...`. No boolean `readOnly` exists.
- **`TurnStatus`**: Stable initial status is `"inProgress"`, terminal statuses are `"completed"`, `"interrupted"`, `"failed"`.
- **`ReviewTarget`**: Structured object variants (`uncommittedChanges`, `baseBranch`, `commit`, `custom`). Plain string targets are rejected.
- **`ServerRequest`**: Methods include `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`.
- **Generated schemas** were used strictly as inspection evidence and are not committed to git.

## 3. Thread Sandbox Correction (CASPROTO-01)

- **Previous Defect**: Sent `{ cwd: "...", readOnly: true }` using invented boolean protocol fields.
- **Correction**: Replaced with stable provider fields:
  ```json
  {
    "cwd": "<absolute cwd>",
    "approvalPolicy": "never",
    "sandbox": "readOnly"
  }
  ```
- **Privilege Enforcement**: Strict rejection of invented boolean protocol fields (`readOnly`, `workspaceWrite`, `dangerFullAccess`) with `CODEX_APP_SERVER_SECURITY_VIOLATION`.
- **Auditor Security Profile**: Default `sandbox: "readOnly"`, `approvalPolicy: "never"` allows source reads and non-writing verification while preventing repository mutations and avoiding approval prompts in headless relay.

## 4. Initialized Handshake Correction

- **Notification Method & Params**: Client sends `{ method: "initialized", params: {} }`. `params` is explicitly included.
- **Write Authority**: The client does not transition to `READY` until the `initialized` notification has been successfully flushed to stdin.
- **Error Behavior**: If the write operation fails, the client transitions to `FAILED` with `CODEX_APP_SERVER_WRITE_FAILED` or `CODEX_APP_SERVER_STDIN_ERROR` and terminates the child process. It never reaches `READY`.

## 5. Test-Hook Removal

- **Removed Passthrough**: Removed all production forwarding of keys beginning with `_` (`_trigger`, `_threadId`, `_sessionId`, `_wrongTurnId`, `_failTurn`, `_interruptTurn`, `_wrongReviewThread`, `_reviewTurnId`).
- **Fixture Control**: Moved all fake test behaviors to fixture-owned mechanisms (`--scenario` command-line flags and deterministic synthetic exact IDs).
- **Static Scan**: Production adapter contains 0 occurrences of test-hook parameters.

## 6. Turn Ownership and Completion Correlation (CASPROTO-02)

- **Notification Contract**: Supported provider `turn/completed` notifications omitting `threadId`.
- **Local Turn Ownership Map**: On successful `turn/start` (and `turn/interrupt`), the adapter maps `turnId -> threadId` in a bounded local memory structure (max 4,096 entries).
- **Correlation**: `waitForTurnCompletion({ threadId, turnId })` checks local ownership:
  - If `turnId` is recorded as belonging to a different `threadId`, it immediately rejects with `CODEX_APP_SERVER_THREAD_MISMATCH`.
  - If the notification provides `threadId`, it validates against local ownership.
  - Absence of `threadId` in notification does not impede resolution.

## 7. Completion Race Elimination

- **Race Condition**: `turn/completed` may arrive before the caller invokes `waitForTurnCompletion`.
- **Bounded Completion Cache**: Maintained a bounded FIFO cache (max 4,096 records) keyed by `turnId`.
- **Wait Resolution**: Waiter checks cached terminal records first; if already present, it returns immediately without waiting for timeout.

## 8. Review Target Contract (CASPROTO-04)

- **Target Object**: `review/start.target` must be a structured object (`{ type: "uncommittedChanges" }`, `{ type: "baseBranch", branch }`, `{ type: "commit", sha, title? }`, `{ type: "custom", instructions }`).
- **Rejection**: Plain string targets (`target: "uncommittedChanges"`) are rejected fail-closed with `INVALID_REVIEW_TARGET`.
- **Delivery**: Restricted strictly to `delivery: "inline"`. `detached` is rejected with `DETACHED_REVIEW_UNSUPPORTED`.

## 9. Review Evidence Correlation (CASPROTO-03)

- **Evidence Identity**: Review mode exit evidence requires `item.type === "exitedReviewMode"` and `item.id === turnId`.
- **Provider Field Preservation**: Canonical content field is preserved as `review` (not `text`).
- **Evidence Cache**: Bounded cache (max 4,096 entries) retains early-arriving `exitedReviewMode` evidence for waiters.
- **Review Completion Authority**: Successful `waitForReviewCompletion` requires both exact `exitedReviewMode` evidence and exact terminal `turn/completed` for the same `turnId`.

## 10. Resume / Read Identity Verification

- **`thread/resume`**: Verifies `result.thread.id === requested threadId`. Mismatch throws `CODEX_APP_SERVER_THREAD_MISMATCH`.
- **`thread/read`**: Verifies `result.thread.id === requested threadId`. Mismatch throws `CODEX_APP_SERVER_THREAD_MISMATCH`.
- **Opaque Provider IDs**: `thread.id`, `sessionId`, and `turn.id` are preserved byte-for-byte without normalization or trimming.

## 11. Close / Uncertainty Semantics

- **Sent Side-Effect Uncertainty**: When `client.close()` is invoked while a side-effecting request (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) has already been written to stdin, the pending request promise rejects with `CODEX_APP_SERVER_REQUEST_UNCERTAIN`.
- **Unsent Request**: If closed before write completion, rejects with `CODEX_APP_SERVER_CLOSED`.
- **No Auto-Retry**: Uncertainty preserves fail-closed behavior without automatic re-transmission.

## 12. Fake App Server Conformance

- Updated fake server command approval method to stable `item/commandExecution/requestApproval`.
- Fake server initial turn status set to `inProgress`.
- Fake review mode completion emits item with `type: "exitedReviewMode"`, `id: reviewTurnId`, and field `review`.
- Stable `turn/completed` fixture notifications omit `threadId` by default, proving contract compatibility.
- Client approval response returns `{ decision: "decline" }` fail-closed.

## 13. CAS Test Evidence

The CAS suite was expanded from CAS-001..CAS-060 to **CAS-001..CAS-082**:
- `CAS-001..CAS-060`: 60/60 PASS (preserved all existing transport/adapter invariants)
- `CAS-061`: thread/start sends sandbox=readOnly (PASS)
- `CAS-062`: thread/start does not send readOnly boolean (PASS)
- `CAS-063`: thread/start sends approvalPolicy=never (PASS)
- `CAS-064`: initialized notification includes params={} (PASS)
- `CAS-065`: initialized write failure prevents READY (PASS)
- `CAS-066`: no underscore/test fields reach provider (PASS)
- `CAS-067`: real-shaped turn/completed without threadId resolves exact turn (PASS)
- `CAS-068`: wrong local thread ownership fails immediately (PASS)
- `CAS-069`: completion arriving before waiter is retained (PASS)
- `CAS-070`: review exitedReviewMode correlates item.id == turnId (PASS)
- `CAS-071`: unrelated review evidence cannot satisfy waiter (PASS)
- `CAS-072`: review evidence arriving before waiter retained (PASS)
- `CAS-073`: string review target rejected (PASS)
- `CAS-074`: resume response thread mismatch rejected (PASS)
- `CAS-075`: read response thread mismatch rejected (PASS)
- `CAS-076`: response with neither result nor error rejected (PASS)
- `CAS-077`: response with both result and error rejected (PASS)
- `CAS-078`: close sent thread/start -> REQUEST_UNCERTAIN (PASS)
- `CAS-079`: close sent turn/start -> REQUEST_UNCERTAIN (PASS)
- `CAS-080`: official commandExecution approval request not auto-approved (PASS)
- `CAS-081`: stable inProgress provider status preserved (PASS)
- `CAS-082`: provider contract snapshot asserts key stable field names (PASS)

**Result: 82/82 PASS**

## 14. Full Regression Evidence

Ran full `npm test` across all 10 deterministic suites:
- `WP-V4-02A legacy auditor quarantine`: PASS
- `Native transition contract`: PASS
- `CLI-001 .. CLI-050`: 50/50 PASS
- `SL-001 .. SL-047`: 47/47 PASS
- `BC-001 .. BC-052`: 52/52 PASS
- `WA-001 .. WA-055`: 55/55 PASS
- `WS-001 .. WS-051`: 51/51 PASS
- `RG-001 .. RG-039`: 39/39 PASS
- `RV2-001 .. RV2-052`: 52/52 PASS
- `CAS-001 .. CAS-082`: 82/82 PASS

**Overall npm test Exit Code**: 0

## 15. Live Smoke Classification

- Real App Server smoke was classified as: `PASS_INITIALIZE_MODEL_LIST_ONLY` (re-runnable under `--live` flag without creating real threads/turns).
- No real threads, turns, reviews, or worker dispatches were created during corrective acceptance.

## 16. Scope Compliance

```text
Registry production modified:
NO

Broker modified:
NO

Runtime integrated:
NO

Server/UI integrated:
NO

AuditDecision implemented:
NO

Thread persistence implemented:
NO

Model resolver implemented:
NO

Real thread created:
NO

Real turn started:
NO

Real review started:
NO

Real worker dispatch:
NO

WP-V4-03B started:
NO

WP-V4-04 started:
NO
```

## 17. Recommendation

`READY_FOR_WP_V4_03A_FINAL_EXTERNAL_REVIEW`

# WO-V4-09A-R3: One-Shot Full-Cycle Coordinator & Real Acceptance Design Seal (R3)

## 1. Document & Work Package Identity

- **Work Package**: WP-V4-09 (One-Shot Full Cycle)
- **Phase**: Design Seal Revision 3 (WO-V4-09A-R3)
- **Status**: DESIGN_COMPLETE / EXTERNAL_REVIEW_PENDING
- **Parent Commit**: `f1b5147ff111b98514cabf4a732ed910ff8eaf68`
- **Canonical Branch**: `dev/v4-clean`
- **Scope**: Documentation only (no production code, no test modifications, no registry modifications, no runtime execution)
- **Purpose**: Correct safety semantics identified during external review of WO-V4-09A-R2:
  1. **Correct close-failure precedence**: Delete the unsafe R2 rule that close failure unconditionally overrides candidate results. Seal the general rule: `execution authority > cleanup authority`. Primary execution failure authority (e.g., `AUDITOR_TURN_UNCERTAIN`, `DISPATCH_UNCERTAIN`, `PROVENANCE_AMBIGUOUS`, `WORKER_WAIT_UNAVAILABLE`) and active-worker conditions (`WORKER_PENDING`) must never be masked by a cleanup failure.
  2. **Add bounded cleanup metadata**: Result envelope includes `cleanup: { auditor_close, code }` with strict bounded enumerations and no raw exceptions or provider payloads.
  3. **Close failure with success / semantic terminal result**: When the cycle body produced a non-operational semantic/success result (`APPROVED`, `APPROVED_WITHOUT_DISPATCH`, `EVIDENCE_REQUIRED`, `BLOCKED`, `STOPPED`, `CYCLE_LIMIT_REACHED`) and `auditor.close()` fails, return `status: FAILED`, `code: AUDITOR_CLOSE_FAILED`. In particular, `APPROVED` must never survive a failed close.
  4. **Close failure must not mask existing operational failure**: When the cycle body already failed with a primary operational code, that primary code remains authoritative; cleanup failure is recorded in `cleanup`.
  5. **`WORKER_PENDING` precedence**: When the worker is still pending, close failure must not replace `WORKER_PENDING` with generic failure, preserving operator awareness of ongoing background execution.
  6. **Dispatch ownership race**: `broker.dispatchWorker()` may return idempotent replays (`idempotent_replay: true`) if an active dispatch raced between Gate A and Gate C. The coordinator must not adopt such unowned dispatches.
  7. **Strict fresh dispatch acceptance shape**: Proceed to `waitWorker()` only if the dispatch result is a freshly created, non-replay `DISPATCH_ACCEPTED` matching project and work order identities.
  8. **Idempotent replay result**: Return fail-closed `status: FAILED`, `code: DISPATCH_REPLAY_NOT_OWNED` with zero wait calls, zero retries, and zero second dispatches.
  9. **Malformed successful dispatch results**: Any successful dispatch result diverging from the fresh acceptance shape returns `status: FAILED`, `code: DISPATCH_RESULT_INVALID`.
  10. **Wait result ownership and state validation**: Single authorized `waitWorker()` must retain exact dispatch and work order identities. States `DISPATCH_ACCEPTED` and `RUNNING` remain `WORKER_PENDING`. Unexpected states like `DISPATCHING` return `DISPATCH_RESULT_INVALID`.
  11. **Full-cycle pass condition**: All 14 invariants sealed, with invariant 8 clarifying fresh coordinator-owned dispatch and invariant 14 clarifying close-failure precedence.
  12. **Planned OSC test matrix**: Minimum 42 tests explicitly covering dispatch ownership, wait ownership, and close-failure precedence.

---

## 2. Current Authoritative State & Architectural Baseline

Authoritative closed packages:
- `WP-V4-07`: `APPROVED_CLOSED`
- `WP-V4-08A`: `APPROVED_CLOSED`
- `WP-V4-08B`: `APPROVED_CLOSED`
- `WP-V4-08`: `APPROVED_CLOSED` (closure commit `0fbf614f976ba6f184254620077b2d38baa30689`)

**Source Reality** (verified canonical source):

1. **Broker surface** (`pipeline-ui/lib/broker/broker.js`):
   ```text
   broker.dispatchWorker(request)
   broker.waitWorker(request)
   broker.getWorkerStatus(projectId)
   broker.getProject(projectId)
   broker.getWorkspaceState(projectId)
   ```
   `snapshot` is a CLI command in `agent-broker-cli.js` that delegates to `broker.getWorkspaceState()`. CLI names must not be conflated with broker method names.

2. **Workspace Port API**: Every snapshot uses:
   ```js
   await workspacePort.getWorkspaceState(project)
   ```
   No production `computeWorkspaceState()` exists.

3. **Canonical Root Authority**: `pipeline-ui/lib/broker/registry.js` exports:
   ```js
   canonicalizeProjectRoot(rawPath) → { canonicalRoot, identityKey }
   ```
   This function performs runtime filesystem resolution. All path identity comparisons must use its `identityKey`, not raw string or lexical normalization alone.

4. **Audit Decision Execution** uses existing helpers:
   ```js
   buildAuditDecisionV1OutputSchema(expectedContext)
   auditor.startTurn({ threadId, input, outputSchema, model, effort })
   awaitAuditDecisionV1(auditor, { threadId, turnId, expectedContext, timeoutMs })
   ```

5. **Model Policy Resolver** call shape:
   ```js
   resolveAuditorModelPolicy({ policy: project.auditor.model_policy, models: catalog })
   ```

6. **Absence of Production Composite Commands**: No `one-shot-cycle`, `full-cycle`, or `audit-and-dispatch` in production source. The coordinator is a new module.

---

## 3. Core One-Shot Coordinator Contract

```js
runOneShotCycle({
  projectId,            // valid non-empty project ID string
  auditSubjectId,       // non-empty bounded identifier; SAME for Turn A and Turn B
  auditPrompt,          // non-empty adapter-compatible input array (Turn A)
  reviewPrompt,         // non-empty adapter-compatible input array (Turn B; explicit caller input)

  registryPort,         // existing Registry authority
  workspacePort,        // workspace state authority
  broker,               // existing broker
  auditorFactory,       // factory: async ({ phase, cwd }) => adapter

  turnTimeoutMs,        // bounded Turn A / Turn B timeout
  workerWaitTimeoutSecs // bounded worker wait timeout
})
```

### Separation of Ownership
The coordinator orchestrates existing domain authorities and does **not** own:
- Registry persistence or validation logic (`registry.js`)
- Worker lifecycle store persistence
- Auditor thread creation or recovery store (`auditor-thread-lifecycle.js`, `sqlite-auditor-recovery-store.js`)
- Workspace state hashing (`workspace-state.js`)
- `AuditDecisionV1` schema validation rules (`audit-decision.js`)
- Worker transport implementation (`worker-adapter.js`, `worker-adapter-registry.js`)
- Model catalog retrieval or model policy resolution (`model-policy-resolver.js`)

---

## 4. auditorFactory Contract

Factory signature:
```js
auditorFactory({
  phase: 'one_shot_cycle',
  cwd: canonicalProjectRoot  // canonicalProjectRoot from canonicalizeProjectRoot(project.project_root)
})
```

Called **at most once** per cycle, strictly after Gate A passes and worker is confirmed `IDLE`.

The factory returns an adapter conforming to `CodexAuditorAdapter` contract:
```text
initialize, resumeThread, listModels, startTurn, waitForTurnCompletion, readThread, close
```

Coordinator initialization sequence:
```text
auditorFactory({ phase: 'one_shot_cycle', cwd: canonicalProjectRoot })
  → auditor.initialize()
  → auditor.resumeThread({ threadId: exactRegistryThreadId })
  → (verify returned ID matches exactRegistryThreadId byte-for-byte)
  → auditor.listModels()
  → resolveAuditorModelPolicy(...)
```

No `startThread()`. The same adapter instance is retained through both Turn A and Turn B.

---

## 5. Adapter Cleanup Authority & Close-Failure Precedence

Once an auditor adapter has been created, the coordinator **must** close it through a `finally` boundary:
```text
close attempts: exactly 1
```

This applies on every terminal path after successful factory creation.

### 5.1 Bounded Cleanup Metadata

The conceptual result envelope includes a bounded `cleanup` record:
```js
cleanup: {
  auditor_close: 'NOT_REQUIRED' | 'SUCCEEDED' | 'FAILED',
  code: null | 'AUDITOR_CLOSE_FAILED'
}
```

Rules:
- Before auditor creation:
  ```text
  auditor_close = NOT_REQUIRED
  code = null
  ```
- After successful creation and successful close:
  ```text
  auditor_close = SUCCEEDED
  code = null
  ```
- After close failure:
  ```text
  auditor_close = FAILED
  code = AUDITOR_CLOSE_FAILED
  ```
- No raw close exception.
- No stack trace.
- No provider payload.
- No unbounded diagnostic.

### 5.2 General Precedence Rule: Execution Authority > Cleanup Authority

```text
execution authority > cleanup authority
```

Cleanup failure is secondary evidence when an operational failure or active-worker condition already exists. Primary execution authority must never be hidden by cleanup failure.

### 5.3 Close Failure with Success / Semantic Terminal Result

If the cycle body produced a non-operational semantic or success result:
```text
APPROVED
APPROVED_WITHOUT_DISPATCH
EVIDENCE_REQUIRED
BLOCKED
STOPPED
CYCLE_LIMIT_REACHED
```
and `auditor.close()` fails, externally return:
```text
status: FAILED
code: AUDITOR_CLOSE_FAILED
```
while preserving already validated bounded decision/workspace metadata.

In particular:
```text
APPROVED must never survive a failed close.
```

### 5.4 Close Failure Must Not Mask Existing Operational Failure

If the cycle body already produced:
```text
status: FAILED
```
with any primary operational code, close failure **MUST NOT** replace that code.

Example:
```text
body:
  status = FAILED
  code = AUDITOR_TURN_UNCERTAIN

close:
  FAILED

final:
  status: FAILED
  code = AUDITOR_TURN_UNCERTAIN
  cleanup: {
    auditor_close: 'FAILED',
    code: 'AUDITOR_CLOSE_FAILED'
  }
```
Not: `code = AUDITOR_CLOSE_FAILED`.

The primary execution failure remains authoritative. This applies generally to all pre-existing `FAILED` results, including:
```text
AUDITOR_TURN_FAILED
AUDITOR_TURN_UNCERTAIN
DECISION_INVALID
AUTHORITY_DRIFT
WORKER_POLICY_MISMATCH
WORKSPACE_STATE_FAILED
STALE_AUDIT_STATE
DISPATCH_FAILED
DISPATCH_UNCERTAIN
PROVENANCE_AMBIGUOUS
WORKER_WAIT_UNAVAILABLE
DISPATCH_REPLAY_NOT_OWNED
DISPATCH_RESULT_INVALID
```
and all other bounded broker failures propagated by the coordinator.

### 5.5 WORKER_PENDING Precedence

If the body result is:
```text
status: WORKER_PENDING
```
the worker may still be active in the background.

Therefore a subsequent auditor close failure **MUST NOT** replace `WORKER_PENDING` with generic `FAILED / AUDITOR_CLOSE_FAILED`.

Final result:
```text
status: WORKER_PENDING
code: null (or sealed pending code)
cleanup: {
  auditor_close: 'FAILED',
  code: 'AUDITOR_CLOSE_FAILED'
}
```

This preserves operator knowledge that worker execution may still be in progress.
- No retry.
- No second wait.
- No second dispatch.

---

## 6. Registry Gate A — Cycle Start

```js
const projectA = await registryPort.getProject(projectId)
```

Obtain canonical root authority using the production helper:
```js
const rootAuthorityA = canonicalizeProjectRoot(projectA.project_root)
const cwdAuthorityA  = canonicalizeProjectRoot(projectA.auditor.cwd)
```

Require:
```text
rootAuthorityA.identityKey === cwdAuthorityA.identityKey
```

Capture immutable cycle authority:
```text
canonicalProjectRoot         = rootAuthorityA.canonicalRoot
canonicalProjectRootIdentity = rootAuthorityA.identityKey
```

Validate all of:
```text
project exists
auditor.thread_id: non-null, non-empty, valid string
auditor.enabled === true
auditor.model_policy: valid registered policy descriptor
worker.enabled === true
worker.engine === "antigravity"
worker.session_id: present and non-empty
policy.require_workspace_state === true
policy.max_active_dispatches === 1
```

Then immediately:
```js
const workerStatus = await broker.getWorkerStatus(projectId)
```

Require:
```text
workerStatus.ok === true
workerStatus.worker_state === "IDLE"
workerStatus.active_dispatch_id === null
workerStatus.active_work_order_id === null
```

Failures at Gate A:
```text
Missing project or schema violation → STARTING_STATE_INVALID (0 turns, 0 dispatches)
Auditor unbound or disabled → AUDITOR_UNAVAILABLE (0 turns, 0 dispatches)
Worker not IDLE → WORKER_BUSY (0 turns, 0 dispatches)
Root/cwd identity mismatch → STARTING_STATE_INVALID (0 turns, 0 dispatches)
policy.max_active_dispatches !== 1 → STARTING_STATE_INVALID (0 turns, 0 dispatches)
```

---

## 7. Exact Auditor Thread Authority

Thread ID authority is exclusively `fresh Registry project.auditor.thread_id`.

- Callers cannot provide `threadId`, `auditorThreadId`, `taskId`, or session overrides.
- After `auditor.initialize()`:
  ```js
  const resumed = await auditor.resumeThread({ threadId: exactRegistryThreadId })
  ```
- The returned thread ID must match `exactRegistryThreadId` byte-for-byte. On mismatch: `THREAD_RESUME_MISMATCH`.
- Heuristic fallback, latest-thread discovery, fuzzy matching, and `startThread()` are forbidden.

---

## 8. Catalog + Registry Gate B (pre-Turn A)

After `initialize()`, `resumeThread()`, `listModels()`, and `resolveAuditorModelPolicy()`, perform a **new** fresh Registry read:

```js
const projectB = await registryPort.getProject(projectId)
const rootAuthorityB = canonicalizeProjectRoot(projectB.project_root)
const cwdAuthorityB  = canonicalizeProjectRoot(projectB.auditor.cwd)
```

Require:
```text
rootAuthorityB.identityKey === canonicalProjectRootIdentity
cwdAuthorityB.identityKey  === canonicalProjectRootIdentity
```

And unchanged from Gate A:
```text
project_id
auditor.thread_id
auditor.enabled === true
auditor.model_policy
worker.engine
worker.session_id
worker.enabled
worker.model_policy
policy.require_workspace_state === true
policy.max_active_dispatches === 1
```

Any drift or canonicalization failure:
```text
AUTHORITY_DRIFT
0 auditor turns
0 worker dispatches
```

---

## 9. Model Policy Pinning

```js
const catalog = await auditor.listModels()
const resolved = resolveAuditorModelPolicy({
  policy: projectA.auditor.model_policy,
  models: catalog
})
```

Pins `resolved.model` and `resolved.reasoning_effort` for the entire cycle (both Turn A and Turn B). The auditor cannot self-select its model or reasoning effort. Worker model policy is completely isolated from the Codex auditor resolver.

---

## 10. S0 and Turn A Context

Compute snapshot using Gate B project:
```js
const S0 = await workspacePort.getWorkspaceState(projectB)
```

Validate returned snapshot:
```text
object
workspace_state_id: non-empty string
project_id === projectId
project_root canonical identity === canonicalProjectRootIdentity
```

Build Turn A context:
```js
const expectedContextA = {
  project_id: projectId,
  audit_subject_id: auditSubjectId,
  auditor_thread_id: exactRegistryThreadId,
  workspace_state_observed: S0.workspace_state_id
}
const outputSchema = buildAuditDecisionV1OutputSchema(expectedContextA)
```

Execute Turn A:
```js
const start = await auditor.startTurn({
  threadId: exactRegistryThreadId,
  input: auditPrompt,
  outputSchema,
  model: resolved.model,
  effort: resolved.reasoning_effort
})

const decisionA = await awaitAuditDecisionV1(auditor, {
  threadId: exactRegistryThreadId,
  turnId: start.turnId,
  expectedContext: expectedContextA,
  timeoutMs: turnTimeoutMs
})
```

---

## 11. Auditor Turn Error Classification

A shared classification policy applies to both Turn A and Turn B. Implementation may use a private helper `classifyAuditTurnError(err, stage)` local to `one-shot-cycle.js` — no shared-contract changes.

### A. `startTurn()` errors

**Uncertain** — if `startTurn()` throws with:
```text
err.code === "CODEX_APP_SERVER_REQUEST_UNCERTAIN"
```
Return:
```text
status: FAILED
code: AUDITOR_TURN_UNCERTAIN
```
Never resend.

**Definitive start failure** — any other definitive failure from `startTurn()` (e.g., `CODEX_APP_SERVER_WRITE_FAILED` with notSent, `CODEX_APP_SERVER_NOT_READY`, `CODEX_APP_SERVER_PROVIDER_ERROR`, `INVALID_ARGUMENT`, etc.):
```text
status: FAILED
code: AUDITOR_TURN_FAILED
```
No retry. Do not treat an unsent definitive failure as uncertainty.

### B. `awaitAuditDecisionV1()` errors

`awaitAuditDecisionV1` wraps `readThread` hydration failures as `AUDIT_DECISION_ITEMS_INCOMPLETE`. WP09B must not bypass the helper to recover the underlying hydration transport failure separately.

**Raw completion/wait uncertainty** — if the helper propagates an operational wait/transport error that does NOT carry an `AUDIT_DECISION_*` code (e.g., `WAIT_TURN_TIMEOUT`, transport/process loss while awaiting completion):
```text
status: FAILED
code: AUDITOR_TURN_UNCERTAIN
```
No resend.

**Non-completed turn** — if `err.code === "AUDIT_DECISION_TURN_NOT_COMPLETED"`:
```text
status: FAILED
code: AUDITOR_TURN_FAILED
```
No retry.

**Strict decision-authority failures** — all `AUDIT_DECISION_*` validation errors map to:
```text
status: FAILED
code: DECISION_INVALID
```
Including:
```text
AUDIT_DECISION_INVALID_JSON
AUDIT_DECISION_DUPLICATE_KEY
AUDIT_DECISION_TOO_LARGE
AUDIT_DECISION_SCHEMA_INVALID
AUDIT_DECISION_CONTEXT_MISMATCH
AUDIT_DECISION_BRANCH_INVALID
AUDIT_DECISION_ITEMS_INCOMPLETE    ← wraps hydration failure; DECISION_INVALID at coordinator boundary
AUDIT_DECISION_OUTPUT_MISSING
AUDIT_DECISION_OUTPUT_AMBIGUOUS
```

No retry in any category.

---

## 12. Turn A Decision Branches

All five standard `AuditDecisionV1` decisions are valid:

| Decision | Action | Worker Dispatches | Result | Satisfies Full Acceptance? |
|---|---|:---:|---|:---:|
| `DISPATCH_WORKER` | Proceed to Gate C, S1, dispatch | **1** | Continues cycle | Yes (candidate) |
| `REQUEST_EVIDENCE` | Terminate | **0** | `EVIDENCE_REQUIRED` | No |
| `APPROVE_WORK_PACKAGE` | Terminate | **0** | `APPROVED_WITHOUT_DISPATCH` | No |
| `BLOCKED` | Terminate | **0** | `BLOCKED` | No |
| `STOP` | Terminate | **0** | `STOPPED` | No |

The coordinator must never coerce or prompt-hack the auditor into `DISPATCH_WORKER`.
`DISPATCH_WORKER` requires non-null `decisionA.work_order` with valid `work_order_id` and `directive`.

---

## 13. Registry Gate C — Before Worker Dispatch

```js
const projectC = await registryPort.getProject(projectId)
const rootAuthorityC = canonicalizeProjectRoot(projectC.project_root)
const cwdAuthorityC  = canonicalizeProjectRoot(projectC.auditor.cwd)
```

Require:
```text
rootAuthorityC.identityKey === canonicalProjectRootIdentity
cwdAuthorityC.identityKey  === canonicalProjectRootIdentity
```

And unchanged from Gate B:
```text
project_id
auditor.thread_id
auditor.enabled
auditor.model_policy
worker.enabled
worker.engine
worker.session_id
worker.model_policy
policy.require_workspace_state === true
policy.max_active_dispatches === 1
```

Any drift or canonicalization failure:
```text
AUTHORITY_DRIFT
worker dispatch count = 0
```

---

## 14. Worker Model Policy Consistency Gate

`AuditDecisionV1.work_order.worker_model_policy` is required by the schema. However, `broker.dispatchWorker()` does not accept `worker_model_policy`, and the worker adapter does not expose a per-dispatch model override.

Require before dispatch:
```text
decisionA.work_order.worker_model_policy === projectC.worker.model_policy
```

If not equal:
```text
WORKER_POLICY_MISMATCH
worker dispatch count = 0
```

When equal, it acts as an authorization consistency check — NOT a CLI/runtime/engine model override. Do NOT modify broker or worker adapter for this in WP09B.

---

## 15. S1 Pre-Dispatch Freshness Gate

```js
const S1 = await workspacePort.getWorkspaceState(projectC)
```

Require:
```text
S1.workspace_state_id === S0.workspace_state_id === decisionA.workspace_state_observed
```

If not equal:
```text
STALE_AUDIT_STATE
worker dispatches = 0
```

Physical re-hashing is mandatory. The model's echoed state string is never sufficient authority.

---

## 16. Worker Dispatch & Ownership Race

### 16.1 Dispatch Call Shape

```js
const dispatchResult = await broker.dispatchWorker({
  schema_version: 1,
  project_id: projectId,
  work_order_id: decisionA.work_order.work_order_id,
  expected_workspace_state_id: S0.workspace_state_id,
  directive: decisionA.work_order.directive
})
```

No extra fields. No direct worker adapter calls. No session override. No engine override. No model-policy override.
Maximum `broker.dispatchWorker` calls per cycle: **1** (including uncertain attempts).

### 16.2 Dispatch Ownership Race Reality

Source reality: `broker.dispatchWorker()` can return:
```js
{
  ok: true,
  idempotent_replay: true,
  dispatch_id,
  state
}
```
if an exact matching active dispatch appears before the coordinator's dispatch call. This may occur despite Gate A reporting `IDLE` because another actor can race between Gate A and Gate C.

The one-shot coordinator **MUST NOT** adopt such an existing dispatch as its own newly-created worker action.

### 16.3 Strict Fresh Dispatch Acceptance Shape

After the one allowed call to `broker.dispatchWorker(...)`, the coordinator may proceed to `waitWorker()` **only if all of the following are true**:
```text
dispatchResult.ok === true
dispatchResult.idempotent_replay !== true
dispatchResult.state === "DISPATCH_ACCEPTED"
dispatchResult.dispatch_id is non-empty string
dispatchResult.work_order_id === decisionA.work_order.work_order_id
dispatchResult.project_id === projectId
```
This is the only newly accepted dispatch shape for WP09 one-shot ownership.

### 16.4 Idempotent Replay Handling

If:
```text
dispatchResult.ok === true
dispatchResult.idempotent_replay === true
```
fail closed:
```text
status: FAILED
code: DISPATCH_REPLAY_NOT_OWNED
```

Rules:
- `waitWorker` calls: 0
- second dispatch calls: 0
- worker transcript reads: 0
- Do NOT treat the existing active dispatch as completion of this cycle.
- Do NOT retry.

`DISPATCH_REPLAY_NOT_OWNED` is local to `one-shot-cycle.js`. No shared `broker/contracts.js` modification.

### 16.5 Malformed Successful Dispatch Results

If:
```text
dispatchResult.ok === true
```
but the returned result is not the exact fresh acceptance shape in §16.3, fail closed:
```text
status: FAILED
code: DISPATCH_RESULT_INVALID
```
Examples:
- missing `dispatch_id`
- wrong `project_id`
- wrong `work_order_id`
- unexpected state (e.g., `DISPATCHING`, `UNKNOWN`)

Rules:
- 0 wait calls
- 0 retry calls
- 0 second dispatch calls

`DISPATCH_RESULT_INVALID` is local to the coordinator.

### 16.6 Broker Failure Results

If:
```text
dispatchResult.ok === false
```
preserve bounded broker failure authority where supplied:
```text
WORKER_BUSY
STALE_AUDIT_STATE
DISPATCH_FAILED
DISPATCH_UNCERTAIN
DUPLICATE_WORK_ORDER_CONFLICT
LIFECYCLE_STORE_FAILURE
REGISTRY_UNAVAILABLE
WORKSPACE_STATE_UNAVAILABLE
```

Do not reinterpret `DISPATCH_UNCERTAIN` as definitive failure.
- No retry.
- No `waitWorker()` after failed dispatch.

---

## 17. Worker Wait & Ownership Validation

After a newly-owned `DISPATCH_ACCEPTED`, the coordinator calls `broker.waitWorker()` **at most once**:

```js
const waitResult = await broker.waitWorker({
  project_id: projectId,
  dispatch_id: dispatchResult.dispatch_id,
  timeout_secs: workerWaitTimeoutSecs
})
```

### 17.1 Wait Result Ownership Validation

Require any successful wait result to retain exact identity:
```text
waitResult.dispatch_id === dispatchResult.dispatch_id
waitResult.work_order_id === decisionA.work_order.work_order_id (when present)
```

Unexpected successful state:
`DISPATCHING` or any unknown success state is NOT `READY_FOR_REVIEW`.
Return bounded failure:
```text
status: FAILED
code: DISPATCH_RESULT_INVALID
```
No Turn B.

### 17.2 WORKER_PENDING Status

Treat as `WORKER_PENDING` only:
```text
DISPATCH_ACCEPTED
RUNNING
```
returned by the single authorized wait call (e.g., wait timed out while worker is still processing).
- No Turn B.
- No retry.
- No second wait.

Only `READY_FOR_REVIEW` permits Gate D / S2 / Turn B.

### 17.3 Preserved Broker Wait Failures

If `broker.waitWorker()` returns `ok: false` or throws bounded broker errors:
```text
DISPATCH_FAILED
DISPATCH_UNCERTAIN
PROVENANCE_AMBIGUOUS
WORKER_WAIT_UNAVAILABLE
```
Fail closed with preserved authority.

`READY_FOR_REVIEW` does not constitute approval. Worker completion metadata from `broker.waitWorker()` is bounded (`state`, `dispatch_id`, `work_order_id`) and does not expose a raw worker report or transcript.

---

## 18. Registry Gate D + S2

After `READY_FOR_REVIEW`:
```js
const projectD = await registryPort.getProject(projectId)
const rootAuthorityD = canonicalizeProjectRoot(projectD.project_root)
const cwdAuthorityD  = canonicalizeProjectRoot(projectD.auditor.cwd)
```

Require:
```text
rootAuthorityD.identityKey === canonicalProjectRootIdentity
cwdAuthorityD.identityKey  === canonicalProjectRootIdentity
```

And unchanged from Gate C. Then:
```js
const S2 = await workspacePort.getWorkspaceState(projectD)
```

Validate returned snapshot. Do not reuse S0.

---

## 19. Same-Thread Invariant

```text
thread_A === project.auditor.thread_id
thread_B === project.auditor.thread_id
thread_A === thread_B
```

Zero new auditor threads are created during the cycle. Worker output cannot alter or replace auditor thread authority.

---

## 20. Turn B — Same-Thread Independent Review

Gate D re-canonicalization confirms authority unchanged (§18). Use same adapter instance, same logical thread:

```js
const expectedContextB = {
  project_id: projectId,
  audit_subject_id: auditSubjectId,          // SAME as Turn A — not a different post-worker subject
  auditor_thread_id: exactRegistryThreadId,  // SAME thread
  workspace_state_observed: S2.workspace_state_id
}
const outputSchemaB = buildAuditDecisionV1OutputSchema(expectedContextB)

const startB = await auditor.startTurn({
  threadId: exactRegistryThreadId,
  input: reviewPrompt,                        // explicit caller input; NOT derived from worker prose
  outputSchema: outputSchemaB,
  model: resolved.model,                      // same pinned model
  effort: resolved.reasoning_effort           // same pinned effort
})

const decisionB = await awaitAuditDecisionV1(auditor, {
  threadId: exactRegistryThreadId,
  turnId: startB.turnId,
  expectedContext: expectedContextB,
  timeoutMs: turnTimeoutMs
})
```

Turn B uses the same shared error classification policy as Turn A (§11).

The coordinator must NOT: fetch or parse the raw Antigravity transcript; inject raw worker prose into Turn B; treat any WorkerReport as authority. The existing same-thread auditor history already contains Turn A context. The reviewer independently inspects the actual workspace.

---

## 21. Turn B Decision Semantics & Final Freshness Gate (S3)

### `APPROVE_WORK_PACKAGE`
Perform final fresh Registry authority check:
```js
const projectFinal = await registryPort.getProject(projectId)
const rootAuthorityFinal = canonicalizeProjectRoot(projectFinal.project_root)
const cwdAuthorityFinal  = canonicalizeProjectRoot(projectFinal.auditor.cwd)
```

Require identity unchanged from Gate D. Then:
```js
const S3 = await workspacePort.getWorkspaceState(projectFinal)
```

Require:
```text
S3.workspace_state_id === S2.workspace_state_id
```

If `S3 !== S2`: return `STALE_AUDIT_STATE`.

### `REQUEST_EVIDENCE` → `EVIDENCE_REQUIRED` (0 dispatches)
### `BLOCKED` → `BLOCKED` (0 dispatches)
### `STOP` → `STOPPED` (0 dispatches)
### `DISPATCH_WORKER` → `CYCLE_LIMIT_REACHED` with validated decision payload, **never dispatch a second work order**

---

## 22. Full-Cycle Acceptance Pass Condition

WP09 real acceptance passes if and only if a single continuous execution verifies **all 14 invariants**:

```text
 1. Registered auditor starts already bound and enabled in Registry V2.
 2. canonicalizeProjectRoot establishes cycle-wide canonical identity at Gate A.
 3. Exact Registry thread_id is resumed without fallback or heuristic.
 4. Turn A completes with authoritative DISPATCH_WORKER decision.
 5. Gate C authority is confirmed (re-canonicalized) unchanged before dispatch.
 6. Worker model policy matches Registry exactly (consistency check, not override).
 7. Freshness gate S1 matches S0 immediately before worker dispatch.
 8. Exactly one real worker dispatch is accepted by the broker as a fresh coordinator-owned dispatch (not idempotent replay: dispatchResult.ok === true, dispatchResult.idempotent_replay !== true, dispatchResult.state === "DISPATCH_ACCEPTED", dispatchResult.dispatch_id non-empty, matching project_id and work_order_id).
 9. Worker reaches READY_FOR_REVIEW with exact project and dispatch identities.
10. Post-worker snapshot S2 is computed after Gate D authority confirmation.
11. Same exact logical auditor thread performs Turn B with explicit reviewPrompt.
12. Turn B returns authoritative APPROVE_WORK_PACKAGE decision.
13. Final freshness gate S3 matches S2 immediately before final approval.
14. Auditor adapter closed exactly once in finally block; close failure overrides non-operational semantic/success results (APPROVED converted to FAILED / AUDITOR_CLOSE_FAILED), while primary operational failures and WORKER_PENDING retain their primary status and record cleanup failure in bounded metadata.
```

Any divergence constitutes `NOT_FULL_CYCLE_PASS`.

---

## 23. Stable Result Envelope

```js
{
  ok,               // boolean
  status,           // terminal status string
  code,             // operational error code (primary execution authority)
  project_id,
  audit_subject_id,
  auditor_thread_id,

  turn_a_decision,  // null if not reached
  dispatch_id,      // null if not dispatched
  worker_state,     // null if not dispatched
  turn_b_decision,  // null if not reached

  workspace: {
    s0,  // null if not computed
    s1,  // null if not computed
    s2,  // null if not computed
    s3   // null if not computed
  },

  cleanup: {
    auditor_close,  // 'NOT_REQUIRED' | 'SUCCEEDED' | 'FAILED'
    code            // null | 'AUDITOR_CLOSE_FAILED'
  }
}
```

Fields unavailable due to early termination are `null`, not fabricated.

Must NOT include: raw provider response, raw worker transcript, full Registry document, environment variables, or stack traces.

### Terminal `status` Values
```text
APPROVED                  — full-cycle Turn B approval after S3 gate (EXCLUSIVE; overridden by close failure)
APPROVED_WITHOUT_DISPATCH — Turn A APPROVE_WORK_PACKAGE (no dispatch)
EVIDENCE_REQUIRED         — Turn A or Turn B REQUEST_EVIDENCE
BLOCKED                   — Turn A or Turn B BLOCKED
STOPPED                   — Turn A or Turn B STOP
WORKER_PENDING            — worker did not reach READY_FOR_REVIEW within timeout (preserved across close failure)
CYCLE_LIMIT_REACHED       — Turn B DISPATCH_WORKER (second dispatch refused)
FAILED                    — operational failure (see code; primary execution failure preserved across close failure)
```

---

## 24. Operational Error Codes (local to one-shot-cycle.js)

```text
STARTING_STATE_INVALID
AUDITOR_UNAVAILABLE
WORKER_BUSY
THREAD_RESUME_MISMATCH
MODEL_POLICY_UNAVAILABLE
AUTHORITY_DRIFT
WORKER_POLICY_MISMATCH
WORKSPACE_STATE_FAILED
AUDITOR_TURN_FAILED
AUDITOR_TURN_UNCERTAIN
DECISION_INVALID
STALE_AUDIT_STATE
AUDITOR_CLOSE_FAILED
DISPATCH_REPLAY_NOT_OWNED
DISPATCH_RESULT_INVALID
```

Preserved broker codes where appropriate:
```text
DISPATCH_FAILED
DISPATCH_UNCERTAIN
PROVENANCE_AMBIGUOUS
WORKER_WAIT_UNAVAILABLE
DUPLICATE_WORK_ORDER_CONFLICT
LIFECYCLE_STORE_FAILURE
REGISTRY_UNAVAILABLE
WORKSPACE_STATE_UNAVAILABLE
```

No new shared `broker/contracts.js` error codes required.

---

## 25. Recovery-Store Preflight Boundary

WP09B coordinator does NOT receive `recoveryStore` and does not own auditor bootstrap recovery.

WP09C real-acceptance harness must separately prove, before the first real auditor turn:
```text
auditor recovery inspect: no active bootstrap requiring recovery/resolution
```
using existing WP07 inspection authority. Do NOT add recovery-store ownership to WP09B.

---

## 26. Planned WP09B Implementation Scope

**New Production Module**: `pipeline-ui/lib/relay/one-shot-cycle.js`
**New Deterministic Suite**: `pipeline-ui/test/refactor/one-shot-cycle.test.js`
**Modified**: `pipeline-ui/package.json`, `docs/refactor-v4-native-codex-relay/15-IMPLEMENTATION-PLAN.md`

### Protected Modules (zero modifications preferred):
```text
pipeline-ui/lib/broker/broker.js
pipeline-ui/lib/broker/runtime.js
pipeline-ui/lib/broker/worker-adapter-registry.js
pipeline-ui/lib/broker/worker-adapter.js
pipeline-ui/lib/broker/registry.js
pipeline-ui/lib/broker/workspace-state.js
pipeline-ui/lib/broker/contracts.js
pipeline-ui/lib/relay/audit-decision.js
pipeline-ui/lib/relay/auditor-thread-lifecycle.js
pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js
pipeline-ui/lib/auditor/codex-auditor-adapter.js
pipeline-ui/lib/auditor/codex-app-server-client.js
pipeline-ui/lib/auditor/model-policy-resolver.js
```

The purpose of R3 is specifically to finalize all safety semantics so that WP09B is implementable cleanly without modifying these protected modules.

---

## 27. Planned WP09B Deterministic Test Matrix (OSC)

Test prefix: `OSC`. **Minimum 42 test cases** covering all the following (existing cases refined with R3 corrections; new cases added as needed):

**Gate and Starting State:**
- `OSC-001`: Missing project fails closed before adapter creation (`STARTING_STATE_INVALID`; 0 factory calls; `cleanup.auditor_close = NOT_REQUIRED`).
- `OSC-002`: Unbound auditor (`auditor.thread_id === null`) fails closed before model/worker.
- `OSC-003`: Disabled auditor (`auditor.enabled === false`) fails closed before model/worker.
- `OSC-004`: Worker not IDLE (`worker_state !== "IDLE"`) fails closed before model turn (`WORKER_BUSY`).
- `OSC-005`: `auditorFactory` called exactly once with `{ phase: 'one_shot_cycle', cwd: canonicalProjectRoot }`.
- `OSC-006`: `auditor.initialize()` occurs before `auditor.resumeThread()`.
- `OSC-007`: Exact Registry `auditor.thread_id` is resumed — no heuristic or latest-thread fallback.
- `OSC-008`: Resume mismatch fails closed with `THREAD_RESUME_MISMATCH`.
- `OSC-009`: Catalog resolved with correct shape `resolveAuditorModelPolicy({ policy, models })`.
- `OSC-010`: Registry Gate B detects authority drift after catalog retrieval and before Turn A.
- `OSC-011`: Model and effort resolved once at cycle start and pinned for both Turn A and Turn B.
- `OSC-012`: S0 computed via `workspacePort.getWorkspaceState(projectB)`.

**Canonical Root Authority (OSC-CANON):**
- `OSC-CANON-01`: Gate A obtains `canonicalProjectRoot` through `canonicalizeProjectRoot(project.project_root)` — not raw string, not `path.normalize` alone.
- `OSC-CANON-02`: Gate A detects `auditor.cwd` canonical identity mismatch with `project_root` identity fails closed before factory.
- `OSC-CANON-03`: Gate B, Gate C, Gate D, and final gate each re-canonicalize `project_root` and `auditor.cwd`; identity drift at any gate returns `AUTHORITY_DRIFT`.

**Turn A Decisions:**
- `OSC-013`: Turn A uses exact `auditSubjectId` and `auditPrompt` from caller input.
- `OSC-014`: Turn A `REQUEST_EVIDENCE` terminates with 0 dispatches, result `EVIDENCE_REQUIRED`.
- `OSC-015`: Turn A `BLOCKED` terminates with 0 dispatches, result `BLOCKED`.
- `OSC-016`: Turn A `STOP` terminates with 0 dispatches, result `STOPPED`.
- `OSC-017`: Turn A `APPROVE_WORK_PACKAGE` terminates with `APPROVED_WITHOUT_DISPATCH` (0 dispatches).

**Turn Error Classification (OSC-TURN):**
- `OSC-TURN-01`: `startTurn` throws `CODEX_APP_SERVER_REQUEST_UNCERTAIN` → `AUDITOR_TURN_UNCERTAIN`; zero resend.
- `OSC-TURN-02`: `startTurn` throws definitive failure (e.g., `CODEX_APP_SERVER_NOT_READY`) → `AUDITOR_TURN_FAILED`; no retry.
- `OSC-TURN-03`: `awaitAuditDecisionV1` propagates raw `WAIT_TURN_TIMEOUT` (no `AUDIT_DECISION_*` code) → `AUDITOR_TURN_UNCERTAIN`; no resend.
- `OSC-TURN-04`: `awaitAuditDecisionV1` throws `AUDIT_DECISION_TURN_NOT_COMPLETED` → `AUDITOR_TURN_FAILED`; no retry.
- `OSC-TURN-05`: `awaitAuditDecisionV1` throws `AUDIT_DECISION_ITEMS_INCOMPLETE` → `DECISION_INVALID` at coordinator boundary (hydration cause not separately recoverable).
- `OSC-TURN-06`: Other strict `AUDIT_DECISION_*` validation failures → `DECISION_INVALID`; no retry.
- `OSC-018`: Same classification policy applies to Turn A and Turn B.

**Dispatch Gate & Dispatch Ownership (OSC-DISP-OWN):**
- `OSC-019`: Registry Gate C drift before dispatch returns `AUTHORITY_DRIFT` (0 dispatches).
- `OSC-020`: `decisionA.work_order.worker_model_policy !== projectC.worker.model_policy` returns `WORKER_POLICY_MISMATCH` (0 dispatches).
- `OSC-021`: S1 computed via `workspacePort.getWorkspaceState(projectC)`.
- `OSC-022`: S1 drift returns `STALE_AUDIT_STATE` (0 dispatches).
- `OSC-023`: Dispatch uses exact broker request shape with no extra fields.
- `OSC-024`: `broker.dispatchWorker` called at most once per cycle.
- `OSC-DISP-OWN-01`: Fresh broker `DISPATCH_ACCEPTED` result is accepted as coordinator-owned dispatch; proceeds to `waitWorker()`.
- `OSC-DISP-OWN-02`: `dispatchResult.ok === true && dispatchResult.idempotent_replay === true` → fails closed with `DISPATCH_REPLAY_NOT_OWNED` → exactly 0 `waitWorker` calls, 0 second dispatch calls, 0 worker transcript reads.
- `OSC-DISP-OWN-03`: Successful dispatch result with malformed/wrong identity (missing dispatch_id, wrong project_id, wrong work_order_id, unexpected state) → `DISPATCH_RESULT_INVALID` → exactly 0 `waitWorker` calls.
- `OSC-DISP-OWN-04`: Broker `DISPATCH_UNCERTAIN` preserved exactly → zero retry → close failure cannot mask uncertainty.

**Worker Wait & Ownership Validation (OSC-WAIT-OWN):**
- `OSC-WAIT-OWN-01`: Wait `READY_FOR_REVIEW` with exact dispatch identity permits Gate D / S2 / Turn B.
- `OSC-WAIT-OWN-02`: Wait `DISPATCH_ACCEPTED` or `RUNNING` (timeout) returns `WORKER_PENDING` (no Turn B, no retry).
- `OSC-WAIT-OWN-03`: Unexpected successful wait state such as `DISPATCHING` or unknown state returns `DISPATCH_RESULT_INVALID` → zero Turn B.
- `OSC-027`: `READY_FOR_REVIEW` alone never constitutes approval.

**Turn B Review & Gates:**
- `OSC-028`: Registry Gate D detects authority drift — `AUTHORITY_DRIFT` (no Turn B).
- `OSC-029`: S2 computed via `workspacePort.getWorkspaceState(projectD)` using fresh Gate D project.
- `OSC-030`: Turn B uses same `auditSubjectId` as Turn A.
- `OSC-031`: Turn B uses explicit `reviewPrompt` from caller input.
- `OSC-032`: Turn B uses same adapter instance, same logical thread, same pinned model and effort.
- `OSC-033`: Raw worker output/transcript is NOT passed to Turn B by coordinator.
- `OSC-034`: Turn B transport uncertainty maps to `AUDITOR_TURN_UNCERTAIN` — no resend.
- `OSC-035`: Turn B `DISPATCH_WORKER` returns `CYCLE_LIMIT_REACHED` with zero second dispatch.
- `OSC-036`: Turn B `APPROVE_WORK_PACKAGE` requires final fresh Registry gate + S3 computation.
- `OSC-037`: S3 drift prevents `APPROVED`, returns `STALE_AUDIT_STATE`.

**Close Failure Precedence & Cleanup Metadata (OSC-CLOSE-PREC):**
- `OSC-CLOSE-PREC-01`: Candidate `APPROVED` + close failure → `status: FAILED`, `code: AUDITOR_CLOSE_FAILED`; validated workspace metadata preserved; `APPROVED` never survives.
- `OSC-CLOSE-PREC-02`: Primary `AUDITOR_TURN_UNCERTAIN` + close failure → primary `status: FAILED, code: AUDITOR_TURN_UNCERTAIN` preserved; `cleanup: { auditor_close: 'FAILED', code: 'AUDITOR_CLOSE_FAILED' }`.
- `OSC-CLOSE-PREC-03`: Primary `DISPATCH_UNCERTAIN` + close failure → primary `DISPATCH_UNCERTAIN` preserved; cleanup marks `AUDITOR_CLOSE_FAILED`.
- `OSC-CLOSE-PREC-04`: `WORKER_PENDING` + close failure → `status: WORKER_PENDING` preserved; cleanup marks `AUDITOR_CLOSE_FAILED`.
- `OSC-CLOSE-01`: `auditor.close()` attempted exactly once on every post-factory terminal path.
- `OSC-CLOSE-02`: Successful close sets `cleanup: { auditor_close: 'SUCCEEDED', code: null }`.

**Happy Path:**
- `OSC-042`: Happy-path exact ordering verified end-to-end:
  ```text
  Gate A → worker IDLE check → factory → initialize → resume → listModels
  → resolveAuditorModelPolicy → Gate B → S0 → Turn A → Gate C
  → worker_model_policy check → S1 → dispatchWorker (fresh DISPATCH_ACCEPTED)
  → waitWorker (READY_FOR_REVIEW) → Gate D → S2 → Turn B
  → final Registry gate + S3 → APPROVED → close (SUCCEEDED)
  ```

---

## 28. Planned Regression Baselines

Following WP09B implementation:
- **Suite Count**: 18 deterministic suites passing
- **Preserved Baselines**:
  ```text
  WREG: 28 / 28
  WA:   55 / 55
  BC:   52 / 52
  RG:   55 / 55
  ARC:  67 / 67
  ARS:  88 / 88
  TUO:  27 / 27
  CAS:  105 / 105
  MPR:  21 / 21
  ATL:  133 / 133
  AD:   122 / 122
  OSC:  >= 42
  ```

---

## 29. WP09C Real Acceptance Boundary

Real execution side effects strictly confined to `WP-V4-09C`.

### Acceptance Ceilings:
```text
real auditorFactory calls:      maximum 1
real model/list calls:          maximum 1
real thread/resume calls:       maximum 1
real auditor turns:             maximum 2
real worker dispatch attempts:  maximum 1
real worker completions:        maximum 1
logical auditor threads:        exactly 1 (existing bound thread)
new auditor threads:            0
```

### WP09A-R3 Execution Facts:
```text
real auditor turns:     0
real worker dispatches: 0
real AGY messages:      0
model turns:            0
Registry mutations:     NO
```

---

## 30. Acceptance Project Selection Criteria

- **No Hard-Coded Identities**: No machine-local paths, project IDs, session IDs, or thread IDs in committed docs or code.
- **Operator Selection**: Explicitly designated by operator in WP09C.
- **Eligibility**: Registered in Registry V2; auditor bound and enabled; worker enabled with valid `session_id`; clean Git status; disposable environment (safe small edit); no automatic "first project" selection.

---

## 31. External Review & Approval Gate

This design document (Revision 3) seals the safety semantics of the One-Shot Full-Cycle Coordinator.

Before proceeding to WP09B implementation:
- The corrected design must be reviewed and approved by the external operator.
- The parent commit must remain `f1b5147ff111b98514cabf4a732ed910ff8eaf68`.
- No implementation work may start until explicit authorization is received.

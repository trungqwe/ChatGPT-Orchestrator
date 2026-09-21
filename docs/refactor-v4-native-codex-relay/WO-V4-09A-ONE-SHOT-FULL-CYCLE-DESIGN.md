# WO-V4-09A-R1: One-Shot Full-Cycle Coordinator & Real Acceptance Design Seal (Corrected)

## 1. Document & Work Package Identity

- **Work Package**: WP-V4-09 (One-Shot Full Cycle)
- **Phase**: Design Seal Revision 1 (WO-V4-09A-R1)
- **Status**: DESIGN_COMPLETE / EXTERNAL_REVIEW_PENDING
- **Parent Commit**: `c1ce796bf4f8648f845b0c19da553dbe0835b8e5`
- **Canonical Branch**: `dev/v4-clean`
- **Scope**: Documentation only (no production code, no test modifications, no registry modifications, no runtime execution)
- **Purpose**: Correct three categories of design ambiguity found during external review of WO-V4-09A:
  1. Source-reality method names (broker surface vs CLI command names; workspace port API)
  2. Audit decision execution helpers and model resolver call shape
  3. Registry authority gate sequence (A/B/C/D/final), coordinator input signature, auditor factory contract, adapter cleanup authority, turn uncertainty classification, and OSC test matrix expansion to 42 minimum

---

## 2. Current Authoritative State & Architectural Baseline

Authoritative closed packages:
- `WP-V4-07`: `APPROVED_CLOSED`
- `WP-V4-08A`: `APPROVED_CLOSED`
- `WP-V4-08B`: `APPROVED_CLOSED`
- `WP-V4-08`: `APPROVED_CLOSED` (closure commit `0fbf614f976ba6f184254620077b2d38baa30689`)

The target V4 architecture:
```text
Operator
  ↓
Thin Relay
  ├── Native Codex Auditor (Thread-backed, AuditDecisionV1 authority)
  └── Worker Adapter Registry (WorkerPortV1 facade: dispatch + wait)
```

**Identified Source Reality**:

1. **Broker surface** (`pipeline-ui/lib/broker/broker.js`):
   ```text
   broker.dispatchWorker(request)
   broker.waitWorker(request)
   broker.getWorkerStatus(projectId)
   broker.getProject(projectId)
   broker.getWorkspaceState(projectId)
   ```
   Note: `snapshot` is an `agent-broker-cli.js` command that delegates to `broker.getWorkspaceState(projectId)`. CLI command names must not be conflated with broker method names.

2. **Workspace Port API**: Every workspace snapshot calculation uses:
   ```js
   await workspacePort.getWorkspaceState(project)
   ```
   There is no production `computeWorkspaceState()` port method.

3. **Audit Decision Execution** uses the existing helpers:
   ```js
   buildAuditDecisionV1OutputSchema(expectedContext)
   auditor.startTurn({ threadId, input, outputSchema, model, effort })
   awaitAuditDecisionV1(auditor, { threadId, turnId, expectedContext, timeoutMs })
   ```
   There is no generic `validateAuditDecision(rawDecision, expectedContext)`.

4. **Model Policy Resolver** call shape:
   ```js
   resolveAuditorModelPolicy({ policy: project.auditor.model_policy, models: catalog })
   ```
   Not `resolveAuditorModelPolicy(catalog, policyDescriptor)`.

5. **Absence of Production Composite Commands**: No `one-shot-cycle`, `full-cycle`, or `audit-and-dispatch` in production source.

6. **Auditor Lifecycle Scope**: `auditor-thread-lifecycle.js` is strictly for unbound auditor bootstrapping. Normal WP09 operation uses an already-bound thread from Registry.

---

## 3. Core One-Shot Coordinator Contract

The coordinator will be introduced in WP09B as pure orchestration logic:

```js
runOneShotCycle({
  projectId,           // valid non-empty project ID string
  auditSubjectId,      // non-empty bounded identifier (same for Turn A and Turn B)
  auditPrompt,         // non-empty adapter-compatible input array (Turn A)
  reviewPrompt,        // non-empty adapter-compatible input array (Turn B; explicit caller input)

  registryPort,        // existing Registry authority
  workspacePort,       // workspace state authority
  broker,              // existing broker
  auditorFactory,      // factory: async ({ phase, cwd }) => adapter

  turnTimeoutMs,       // bounded Turn A / Turn B timeout
  workerWaitTimeoutSecs // bounded worker wait timeout
})
```

### Caller Input Requirements
- `auditSubjectId`: shared audit subject identity for both turns. One cycle audits one logical work package.
- `auditPrompt`: explicit caller input for Turn A. The coordinator must not invent it.
- `reviewPrompt`: explicit caller input for Turn B. The coordinator must not invent a post-worker prompt from worker prose.
- Turn A and Turn B differ by `prompt`, `workspace_state_observed`, and `turn ID` — **not** by `audit_subject_id`.

### Separation of Ownership
The coordinator orchestrates existing domain authorities and explicitly does **not** own:
- Registry persistence or validation logic (`registry.js`)
- Worker lifecycle store persistence
- Auditor thread creation or recovery store (`auditor-thread-lifecycle.js`, `sqlite-auditor-recovery-store.js`)
- Workspace state hashing (`workspace-state.js`)
- `AuditDecisionV1` schema validation rules (`audit-decision.js`)
- Worker transport implementation (`worker-adapter.js`, `worker-adapter-registry.js`)
- Model catalog retrieval or model policy resolution (`model-policy-resolver.js`)

---

## 4. auditorFactory Contract

The injected factory is called exactly once:

```js
const auditor = await auditorFactory({
  phase: 'one_shot_cycle',
  cwd: canonicalProjectRoot
})
```

The returned adapter instance must support:
```text
initialize
resumeThread
listModels
startTurn
waitForTurnCompletion
readThread
close
```

Required initialization sequence:
```text
auditorFactory (exactly once)
  → auditor.initialize()
  → auditor.resumeThread({ threadId: exactRegistryThreadId })
  → (verify returned ID matches exactRegistryThreadId byte-for-byte)
  → auditor.listModels()
  → resolveAuditorModelPolicy(...)
```

No `startThread()`. The same adapter instance is retained through both Turn A and Turn B.

---

## 5. Adapter Cleanup Authority (finally boundary)

Once an auditor adapter has been created, the coordinator **must** close it through a `finally` boundary:
```text
close attempts: exactly 1
```

This applies on every terminal path after successful factory creation, including:
```text
resume mismatch, catalog failure, authority drift, Turn A terminal branch,
stale S1, worker policy mismatch, worker dispatch failure, worker pending,
Turn B terminal branch, approval, stale S3
```

A close failure must be surfaced as:
```text
AUDITOR_CLOSE_FAILED
```
The coordinator must not report full-cycle PASS if close fails. It must never trigger another turn or dispatch as a result of close failure.

---

## 6. Required Starting State & Pre-Execution Gate

### Registry Gate A — Cycle Start
```js
projectA = await registryPort.getProject(projectId)
```

Validate all of:
```text
project exists
auditor.thread_id: non-null, non-empty, valid string
auditor.enabled === true
auditor.cwd canonical identity === project_root canonical identity
auditor.model_policy: valid registered policy descriptor
worker.enabled === true
worker.engine === "antigravity"
worker.session_id: present and non-empty
policy.require_workspace_state === true
```

Then immediately call:
```js
broker.getWorkerStatus(projectId)
```

Require:
```text
ok === true
worker_state === "IDLE"
active_dispatch_id === null
active_work_order_id === null
```

If worker is not IDLE:
```text
WORKER_BUSY
0 auditor turns
0 worker dispatches
```

If any Gate A precondition fails:
```text
STARTING_STATE_INVALID (auditor unbound/disabled) or AUDITOR_UNAVAILABLE
0 auditor turns
0 worker dispatches
```

### Fail-Closed Starting Invariants
The coordinator MUST NOT:
- Start a replacement or provisional auditor thread
- Auto-bootstrap an unbound project
- Modify `auditor.thread_id`
- Enable a disabled auditor or worker
- Perform silent repairs on Registry records

---

## 7. Exact Auditor Thread Authority

Thread ID authority is exclusively `fresh Registry project.auditor.thread_id`.

- Callers cannot provide `threadId`, `auditorThreadId`, `taskId`, or session overrides.
- The coordinator calls:
  ```js
  const resumed = await auditor.resumeThread({ threadId: exactRegistryThreadId })
  ```
- The returned thread ID must match `exactRegistryThreadId` byte-for-byte.
- Heuristic fallback, latest-thread discovery, fuzzy matching, and `startThread()` are forbidden.

---

## 8. Catalog + Registry Gate B (pre-Turn A)

After `initialize()`, `resumeThread()`, `listModels()`, and `resolveAuditorModelPolicy()`, perform a **new** fresh Registry read:

```js
projectB = await registryPort.getProject(projectId)
```

Require unchanged authority from Gate A:
```text
project_id
canonical project-root identity
auditor.cwd identity
auditor.thread_id
auditor.enabled === true
auditor.model_policy
worker.engine
worker.session_id
worker.enabled
worker.model_policy
policy.require_workspace_state
```

If anything drifted:
```text
AUTHORITY_DRIFT
0 auditor turns
0 worker dispatches
```

This prevents stale authority accumulated during `listModels()`.

---

## 9. Model Policy Pinning

```js
const catalog = await auditor.listModels()
const resolved = resolveAuditorModelPolicy({
  policy: projectA.auditor.model_policy,
  models: catalog
})
```

Pins `resolved.model` and `resolved.reasoning_effort` for the entire cycle (both Turn A and Turn B).

Rules:
- The auditor cannot self-select its model.
- Worker model policy is completely isolated and never used in the Codex auditor resolver.
- Gate B re-confirms `auditor.model_policy` has not drifted since Gate A.

---

## 10. S0 and Turn A

Compute snapshot using Gate B project:
```js
const S0 = await workspacePort.getWorkspaceState(projectB)
```

Validate returned snapshot:
```text
object
workspace_state_id: non-empty string
project_id === projectId
project_root canonical identity === expected project root
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

## 11. Auditor Turn Uncertainty — Mandatory Classification

`startTurn()` is side-effecting. The transport can return a distinct uncertain state when bytes were sent but outcome is unknown.

**Classification rules** (MANDATORY — these are distinct, non-conflatable):

### AUDITOR_TURN_UNCERTAIN
Return this when:
- `startTurn()` throws with `err.code === "CODEX_APP_SERVER_REQUEST_UNCERTAIN"`, OR
- `startTurn()` returned a `turnId` but subsequent completion/transport waiting cannot prove a terminal authoritative decision (e.g., `WAIT_TURN_TIMEOUT`, transport loss, thread read unavailable).

Do NOT resend. Do NOT start a replacement turn. Do NOT dispatch worker.

### DECISION_INVALID
Return this when a terminal turn produces a structurally invalid decision:
```text
AUDIT_DECISION_INVALID_JSON
AUDIT_DECISION_DUPLICATE_KEY
AUDIT_DECISION_TOO_LARGE
AUDIT_DECISION_SCHEMA_INVALID
AUDIT_DECISION_CONTEXT_MISMATCH
AUDIT_DECISION_BRANCH_INVALID
AUDIT_DECISION_OUTPUT_MISSING
AUDIT_DECISION_OUTPUT_AMBIGUOUS
AUDIT_DECISION_ITEMS_INCOMPLETE
```

No retry in either category.

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

Turn A `DISPATCH_WORKER` authority alone is insufficient. Immediately before S1 and dispatch:

```js
projectC = await registryPort.getProject(projectId)
```

Require unchanged from Gate B:
```text
project_id
canonical project root
auditor.cwd identity
auditor.thread_id
auditor.enabled
auditor.model_policy
worker.enabled
worker.engine
worker.session_id
worker.model_policy
policy.require_workspace_state
policy.max_active_dispatches
```

If anything drifted:
```text
AUTHORITY_DRIFT
worker dispatch count = 0
```

---

## 14. Worker Model Policy Consistency Gate

`AuditDecisionV1.work_order.worker_model_policy` is required by the schema. However, `broker.dispatchWorker()` does not accept a `worker_model_policy` field, and the worker adapter does not expose a per-dispatch model override.

Before dispatch, require:
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

Compute using Gate C project:
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

## 16. Worker Dispatch

Call existing broker exactly:
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

---

## 17. Exactly One Worker Dispatch Maximum

In a one-shot cycle, the maximum successful dispatch attempts is strictly **1**. The coordinator MUST NOT:
- Issue a second work order
- Retry after `DISPATCH_UNCERTAIN`, transport timeout, or provenance ambiguity

All ambiguous outcomes fail closed immediately.

---

## 18. Worker Wait

```js
const waitResult = await broker.waitWorker({
  project_id: projectId,
  dispatch_id: dispatchResult.dispatch_id,
  timeout_secs: workerWaitTimeoutSecs
})
```

Called at most once. Only `READY_FOR_REVIEW` permits Turn B.

### Transition Mapping
- `READY_FOR_REVIEW` → proceed to Gate D, S2, Turn B
- `DISPATCH_ACCEPTED` / `RUNNING` (timeout) → `WORKER_PENDING`; stop (no second wait loop)
- `DISPATCH_FAILED` → fail closed
- `DISPATCH_UNCERTAIN` → fail closed (no retry)
- `PROVENANCE_AMBIGUOUS` → fail closed
- `WORKER_WAIT_UNAVAILABLE` → fail closed

---

## 19. READY_FOR_REVIEW Is Not Approval

```text
READY_FOR_REVIEW ≠ approved
READY_FOR_REVIEW ≠ tests passed
READY_FOR_REVIEW ≠ work package complete
```

Worker completion data from `broker.waitWorker()` exposes only bounded semantic metadata (`state`, `dispatch_id`, `work_order_id`). It does NOT expose a raw worker report.

The coordinator must NOT:
- Fetch or parse the raw Antigravity transcript
- Inject raw worker prose into Turn B
- Treat any WorkerReport as authority

The existing same-thread auditor history already contains Turn A context. The reviewer independently inspects the actual workspace.

---

## 20. Registry Gate D + S2

After `READY_FOR_REVIEW`:

```js
const projectD = await registryPort.getProject(projectId)
```

Require same authority as Gate C. Then:

```js
const S2 = await workspacePort.getWorkspaceState(projectD)
```

Validate returned snapshot. Do not reuse S0.

While typical worker modifications produce `S2 !== S0`, the coordinator does not assert divergence as a semantic prerequisite.

---

## 21. Same-Thread Invariant

```text
thread_A === project.auditor.thread_id
thread_B === project.auditor.thread_id
thread_A === thread_B
```

Zero new auditor threads are created during the cycle. Worker output cannot alter or replace auditor thread authority.

---

## 22. Turn B — Same-Thread Independent Review

Before Turn B, the Gate D Registry read must confirm that all authority is unchanged from Gate C:
```text
same project_id
same canonical root identity
same auditor.cwd identity
same auditor.thread_id
auditor.enabled === true
same auditor.model_policy
worker still maps to same project authority
```

If authority drifted:
```text
AUTHORITY_DRIFT
0 Turn B
```

Build Turn B context:
```js
const expectedContextB = {
  project_id: projectId,
  audit_subject_id: auditSubjectId,          // SAME as Turn A
  auditor_thread_id: exactRegistryThreadId,  // SAME adapter/thread
  workspace_state_observed: S2.workspace_state_id
}
const outputSchemaB = buildAuditDecisionV1OutputSchema(expectedContextB)
```

Execute Turn B using same adapter instance, same pinned model/effort:
```js
const startB = await auditor.startTurn({
  threadId: exactRegistryThreadId,
  input: reviewPrompt,           // explicit caller input
  outputSchema: outputSchemaB,
  model: resolved.model,         // same pinned model
  effort: resolved.reasoning_effort  // same pinned effort
})

const decisionB = await awaitAuditDecisionV1(auditor, {
  threadId: exactRegistryThreadId,
  turnId: startB.turnId,
  expectedContext: expectedContextB,
  timeoutMs: turnTimeoutMs
})
```

Turn B uncertainty classification follows the same rules as Turn A (§11).

---

## 23. Turn B Decision Semantics & Final Freshness Gate (S3)

### `APPROVE_WORK_PACKAGE`
Before accepting approval, perform final fresh Registry authority check (same as Gate D). Then:
```js
const S3 = await workspacePort.getWorkspaceState(freshProject)
```

Require:
```text
S3.workspace_state_id === S2.workspace_state_id
```

If `S3 !== S2`:
```text
STALE_AUDIT_STATE
```
Do not return approved full-cycle result.

### `REQUEST_EVIDENCE`
Return `EVIDENCE_REQUIRED`. Zero additional dispatches.

### `BLOCKED`
Return `BLOCKED`. Zero additional dispatches.

### `STOP`
Return `STOPPED`. Zero additional dispatches.

### `DISPATCH_WORKER`
Structurally valid under `AuditDecisionV1`, but the one-shot cycle has exhausted its dispatch allowance.
Return `CYCLE_LIMIT_REACHED`. Include the validated decision payload for operator review or future WP12.
**Never dispatch a second work order.**

---

## 24. Full-Cycle Acceptance Pass Condition

WP09 real acceptance passes if and only if a single continuous execution verifies all 12 invariants:

```text
 1. Registered auditor starts already bound and enabled in Registry V2.
 2. Exact Registry thread_id is resumed without fallback or heuristic.
 3. Turn A completes with authoritative DISPATCH_WORKER decision.
 4. Gate C authority is confirmed unchanged before dispatch.
 5. Worker model policy matches Registry exactly.
 6. Freshness gate S1 matches S0 immediately before worker dispatch.
 7. Exactly one real worker dispatch is accepted by the broker.
 8. Worker reaches READY_FOR_REVIEW with exact project and dispatch identities.
 9. Post-worker snapshot S2 is computed after Gate D authority confirmation.
10. Same exact logical auditor thread performs Turn B with explicit reviewPrompt.
11. Turn B returns authoritative APPROVE_WORK_PACKAGE decision.
12. Final freshness gate S3 matches S2 immediately before final approval.
13. Exactly zero second worker dispatches occur.
14. Auditor adapter closed exactly once in finally block.
```

Any divergence constitutes `NOT_FULL_CYCLE_PASS`.

---

## 25. Stable Result Envelope

```js
{
  ok,               // boolean
  status,           // terminal status string (see §26)
  code,             // operational error code (see §28)
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
  }
}
```

Fields unavailable due to early termination are `null`, not fabricated.

Must NOT include: raw provider response, raw worker transcript, full Registry document, environment variables, or stack traces.

### Terminal `status` Values
```text
APPROVED                 — full-cycle Turn B approval after S3 gate (EXCLUSIVE)
APPROVED_WITHOUT_DISPATCH — Turn A APPROVE_WORK_PACKAGE (no dispatch)
EVIDENCE_REQUIRED        — Turn A or Turn B REQUEST_EVIDENCE
BLOCKED                  — Turn A or Turn B BLOCKED
STOPPED                  — Turn A or Turn B STOP
WORKER_PENDING           — worker did not reach READY_FOR_REVIEW within timeout
CYCLE_LIMIT_REACHED      — Turn B DISPATCH_WORKER (second dispatch refused)
FAILED                   — operational failure (see code)
```

`APPROVED` is reserved exclusively for the full-cycle Turn-B approval path after S3.

---

## 26. Operational Error Codes (local to one-shot-cycle.js)

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
```

Preserved broker codes where appropriate:
```text
DISPATCH_FAILED
DISPATCH_UNCERTAIN
PROVENANCE_AMBIGUOUS
WORKER_WAIT_UNAVAILABLE
```

No new shared `broker/contracts.js` error codes are required. One-shot codes remain local to `one-shot-cycle.js`.

---

## 27. Recovery-Store Preflight Boundary

The WP09B coordinator does NOT receive `recoveryStore` and does not own auditor bootstrap recovery.

WP09C real-acceptance harness must separately prove, before the first real auditor turn:
```text
auditor recovery inspect: no active bootstrap requiring recovery/resolution
```
using existing WP07 inspection authority (`agy-recover inspect`).

Do NOT silently add recovery-store ownership to WP09B.

---

## 28. Acceptance Project Selection Criteria

- **No Hard-Coded Identities**: No machine-local paths, project IDs, session IDs, or thread IDs in committed docs or code.
- **Operator Selection**: Explicitly designated by operator in WP09C.
- **Eligibility**:
  - Registered in Registry V2
  - Auditor bound and enabled
  - Worker enabled with valid `session_id`
  - Clean Git status
  - Disposable environment (safe small edit)
  - No automatic "first project" selection or fuzzy matching

---

## 29. Acceptance Workspace Safety Rules

Prior to Turn A in real acceptance:
1. Git working tree is clean.
2. `broker.getWorkerStatus()` returns `worker_state === "IDLE"`.
3. No active worker dispatches in lifecycle store.
4. No active auditor recovery bootstraps (via WP07 inspect).

If any safety check fails: halt before any model turn or worker dispatch. No destructive Git commands against user workspace.

---

## 30. Acceptance Task Shape

Must be:
- **Small & Bounded** — e.g., single fixture/artifact file
- **Reversible** — clean revert via targeted deletion
- **Non-Sensitive** — zero contact with credentials, deployment, network publishing
- **Independently Verifiable** — workspace files accessible to auditor

---

## 31. Post-Acceptance Cleanup Protocol

1. Capture full acceptance evidence (S2, S3 hashes, approved decisions) before any cleanup.
2. Cleanup is an explicit operator action targeting only the dedicated acceptance artifact.
3. Never use `git reset --hard` or `git clean -fd` against unverified workspace.
4. Cleanup is strictly separated from auditor approval authority.

---

## 32. Planned WP09B Implementation Scope

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

---

## 33. Planned WP09B Deterministic Test Matrix (OSC)

Test prefix: `OSC` (One-Shot Coordinator). **Minimum 42 test cases**.

- `OSC-001`: Missing project fails closed before adapter creation (`STARTING_STATE_INVALID`; 0 factory calls).
- `OSC-002`: Unbound auditor (`auditor.thread_id === null`) fails closed before model/worker.
- `OSC-003`: Disabled auditor (`auditor.enabled === false`) fails closed before model/worker.
- `OSC-004`: Worker not IDLE (`worker_state !== "IDLE"`) fails closed before model turn (`WORKER_BUSY`).
- `OSC-005`: `auditorFactory` called exactly once with `{ phase: 'one_shot_cycle', cwd: canonicalProjectRoot }`.
- `OSC-006`: `auditor.initialize()` occurs before `auditor.resumeThread()`.
- `OSC-007`: Exact Registry `auditor.thread_id` is resumed — no heuristic or latest-thread fallback.
- `OSC-008`: Resume mismatch (returned ID != Registry ID) fails closed with `THREAD_RESUME_MISMATCH`.
- `OSC-009`: Catalog resolved with correct shape `resolveAuditorModelPolicy({ policy, models })`.
- `OSC-010`: Registry Gate B detects authority drift after catalog retrieval and before Turn A (`AUTHORITY_DRIFT`; 0 turns, 0 dispatches).
- `OSC-011`: Model and effort resolved once at cycle start and pinned for both Turn A and Turn B.
- `OSC-012`: S0 computed via `workspacePort.getWorkspaceState(projectB)` (uses Gate B project).
- `OSC-013`: Turn A uses exact `auditSubjectId` and `auditPrompt` from caller input.
- `OSC-014`: Turn A `REQUEST_EVIDENCE` terminates with 0 dispatches and result `EVIDENCE_REQUIRED`.
- `OSC-015`: Turn A `BLOCKED` terminates with 0 dispatches and result `BLOCKED`.
- `OSC-016`: Turn A `STOP` terminates with 0 dispatches and result `STOPPED`.
- `OSC-017`: Turn A `APPROVE_WORK_PACKAGE` terminates with `APPROVED_WITHOUT_DISPATCH` (0 dispatches).
- `OSC-018`: Turn A `startTurn` uncertain transport maps to `AUDITOR_TURN_UNCERTAIN` with zero resend.
- `OSC-019`: Post-start Turn A completion uncertainty (timeout/transport loss) maps to `AUDITOR_TURN_UNCERTAIN`.
- `OSC-020`: Strict invalid Turn A decision structure maps to `DECISION_INVALID`.
- `OSC-021`: Registry Gate C drift before dispatch returns `AUTHORITY_DRIFT` (0 dispatches).
- `OSC-022`: `decisionA.work_order.worker_model_policy !== projectC.worker.model_policy` returns `WORKER_POLICY_MISMATCH` (0 dispatches).
- `OSC-023`: S1 computed via `workspacePort.getWorkspaceState(projectC)` (uses Gate C project).
- `OSC-024`: S1 drift (`S1.workspace_state_id !== S0.workspace_state_id`) returns `STALE_AUDIT_STATE` (0 dispatches).
- `OSC-025`: Dispatch uses exact broker request shape: `{ schema_version:1, project_id, work_order_id, expected_workspace_state_id, directive }` — no extra fields.
- `OSC-026`: `broker.dispatchWorker` called at most once per cycle (including on uncertain attempt).
- `OSC-027`: `DISPATCH_UNCERTAIN` terminates without retry (`DISPATCH_UNCERTAIN` result, 0 second dispatches).
- `OSC-028`: Worker pending (`DISPATCH_ACCEPTED`/`RUNNING` after timeout) stops cycle with `WORKER_PENDING` — no Turn B.
- `OSC-029`: `READY_FOR_REVIEW` alone never constitutes approval — Turn B is required.
- `OSC-030`: Registry Gate D detects authority drift before Turn B — `AUTHORITY_DRIFT` (no Turn B).
- `OSC-031`: S2 computed via `workspacePort.getWorkspaceState(projectD)` using fresh Gate D project.
- `OSC-032`: Turn B uses same `auditSubjectId` as Turn A (not a different post-worker subject).
- `OSC-033`: Turn B uses explicit `reviewPrompt` from caller input (not derived from worker prose).
- `OSC-034`: Turn B uses same adapter instance, same logical thread, same pinned model and effort.
- `OSC-035`: Raw worker output/transcript is NOT passed to Turn B by coordinator.
- `OSC-036`: Turn B transport uncertainty maps to `AUDITOR_TURN_UNCERTAIN` — no resend.
- `OSC-037`: Turn B `DISPATCH_WORKER` returns `CYCLE_LIMIT_REACHED` with zero second dispatch.
- `OSC-038`: Turn B `APPROVE_WORK_PACKAGE` requires final fresh Registry gate + S3 computation before APPROVED.
- `OSC-039`: S3 drift (`S3.workspace_state_id !== S2.workspace_state_id`) prevents `APPROVED`, returns `STALE_AUDIT_STATE`.
- `OSC-040`: `auditor.close()` attempted exactly once on every post-factory terminal path (happy and failing).
- `OSC-041`: `AUDITOR_CLOSE_FAILED` prevents reporting full-cycle PASS; no additional turn or dispatch.
- `OSC-042`: Happy-path exact ordering verified:
  ```text
  Gate A → worker IDLE check → factory → initialize → resume → listModels
  → resolveAuditorModelPolicy → Gate B → S0 → Turn A → Gate C
  → worker_model_policy check → S1 → dispatchWorker → waitWorker
  → Gate D → S2 → Turn B → final Registry gate → S3 → APPROVED → close
  ```

---

## 34. Planned Regression Baselines

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

## 35. WP09C Real Acceptance Boundary

Real execution side effects are strictly confined to `WP-V4-09C`.

### Acceptance Ceilings:
```text
real auditor turns:           maximum 2
real worker dispatch attempts: maximum 1
real worker completions:       maximum 1
logical auditor threads:       exactly 1 (existing bound thread)
new auditor threads:           0
real model/list calls:         maximum 1 (coordinator catalog resolution)
real thread/resume calls:      maximum 1
```

### WP09A-R1 Execution Facts:
```text
real auditor turns:    0
real worker dispatches: 0
real AGY messages:     0
model turns:           0
Registry mutations:    NO
```

---

## 16. External Review & Approval Gate

This design document (Revision 1) seals the corrected technical specification of the One-Shot Full-Cycle Coordinator.

Before proceeding to WP09B implementation:
- The corrected design must be reviewed and approved by the external operator.
- The parent commit must remain `c1ce796bf4f8648f845b0c19da553dbe0835b8e5`.
- No implementation work may start until explicit authorization is received.

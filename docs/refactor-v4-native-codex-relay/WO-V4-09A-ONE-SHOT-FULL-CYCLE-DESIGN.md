# WO-V4-09A: One-Shot Full-Cycle Coordinator & Real Acceptance Design Seal

## 1. Document & Work Package Identity

- **Work Package**: WP-V4-09 (One-Shot Full Cycle)
- **Phase**: Design Seal (WO-V4-09A)
- **Status**: DESIGN_COMPLETE / EXTERNAL_REVIEW_PENDING
- **Parent Commit**: `0fbf614f976ba6f184254620077b2d38baa30689`
- **Canonical Branch**: `dev/v4-clean`
- **Scope**: Documentation only (no production code, no test modifications, no registry modifications, no runtime execution)
- **Purpose**: Define the architectural contract, lifecycle invariants, fail-closed semantics, deterministic test matrix, and real acceptance boundary for the one-shot full-cycle coordinator.

---

## 2. Current Authoritative State & Architectural Baseline

Authoritative closed packages:
- `WP-V4-07`: `APPROVED_CLOSED` (Auditor recover CLI with WAL-safe inspect and strict output authority).
- `WP-V4-08A`: `APPROVED_CLOSED` (Generic worker adapter boundary design seal).
- `WP-V4-08B`: `APPROVED_CLOSED` (Generic worker adapter registry implementation, WREG regression suite).
- `WP-V4-08`: `APPROVED_CLOSED` (Docs-only closure, parent `31e9f9db3718556aa8f6561f78c37b0c9af093ea`).

The target V4 architecture establishes:
```text
Operator
  ↓
Thin Relay
  ├── Native Codex Auditor (Thread-backed, AuditDecisionV1 authority)
  └── Worker Adapter Registry (WorkerPortV1 facade: dispatch + wait)
```

The relay protocol defines a rigorous cycle:
```text
workspace snapshot (S0)
  ↓
structured auditor turn (Turn A)
  ↓
strict AuditDecisionV1 validation
  ↓
fresh workspace recomputation (S1)
  ↓
lifecycle action (worker dispatch or terminal exit)
```

**Identified Architectural Gap**:
Existing production source contains independent primitives (`snapshot`, `worker-status`, `worker-dispatch`, `worker-wait`, `resumeThread`, `startTurn`, `validateAuditDecision`), but does **not** contain an integrated coordinator that joins auditor evaluation with the worker lifecycle.

---

## 3. Source Reality & Invariants to Preserve

A strict audit of the canonical codebase confirms:
1. **Existing Broker Worker Commands**:
   `pipeline-ui/lib/broker/broker.js` exposes independent operations:
   - `snapshot(projectId)`
   - `getWorkerStatus(projectId)`
   - `dispatchWorker({ projectId, workOrderId, expectedWorkspaceStateId, directive })`
   - `waitWorker({ projectId, dispatchId, timeoutSecs })`
2. **Absence of Production Composite Commands**:
   There is currently **no** production implementation of `one-shot-cycle`, `full-cycle`, or `audit-and-dispatch`.
3. **Auditor Lifecycle Scope**:
   `pipeline-ui/lib/relay/auditor-thread-lifecycle.js` is strictly designed for unbound auditor bootstrapping:
   ```text
   unbound auditor → provisional thread → first useful turn → durability verification → Registry binding
   ```
   It is **not** the normal bound-auditor full-cycle coordinator.
4. **Bound Auditor Invariant**:
   Normal WP09 one-shot operation operates strictly against a project whose auditor thread is already persisted, bound, and enabled in Registry V2.

---

## 4. Core One-Shot Coordinator Contract

The one-shot coordinator will be introduced in WP09B as a pure orchestration module:

```js
runOneShotCycle({
  projectId,
  auditSubjectId,
  auditPrompt,
  registryPort,
  workspacePort,
  broker,
  auditorFactory
})
```

### Separation of Ownership
The coordinator orchestrates existing domain authorities and explicitly does **not** own:
- Registry persistence or validation logic (`registry.js`).
- Worker lifecycle store persistence (`lifecycle-store.js`).
- Auditor thread creation or recovery store semantics (`auditor-thread-lifecycle.js`, `sqlite-auditor-recovery-store.js`).
- Workspace state hashing or canonical filesystem identity (`workspace-state.js`).
- `AuditDecisionV1` schema validation rules (`audit-decision.js`).
- Worker transport implementation (`worker-adapter.js`, `worker-adapter-registry.js`).
- Model catalog retrieval or model policy resolution (`model-policy-resolver.js`).

---

## 5. Required Starting State & Pre-Execution Gate

A one-shot cycle is strictly prohibited from executing unless a fresh read of the Project Registry proves all of the following conditions:

```text
1. Project Record:
   project exists in Registry V2

2. Auditor Binding:
   project.auditor.thread_id is non-null, non-empty, valid thread ID string
   project.auditor.enabled === true
   project.auditor.cwd matches canonical filesystem identity of project.project_root
   project.auditor.model_policy is a valid registered policy descriptor

3. Worker Configuration:
   project.worker.enabled === true
   project.worker.engine === "antigravity" (under current V2 schema)
   project.worker.session_id is present and non-empty

4. Policy Preconditions:
   project.policy.require_workspace_state === true
```

### Fail-Closed Starting Invariants
The coordinator MUST NOT:
- Start a replacement or provisional auditor thread.
- Auto-bootstrap an unbound project.
- Modify `project.auditor.thread_id`.
- Enable a disabled auditor or worker.
- Perform silent repairs or migrations on Registry records.

If any starting precondition fails, the coordinator must immediately fail closed with:
- **0** auditor turns.
- **0** worker dispatches.

---

## 6. Exact Auditor Thread Authority

The auditor thread identity authority is exclusively:
```text
fresh Registry project.auditor.thread_id
```

- Callers cannot provide `threadId`, `auditorThreadId`, `taskId`, or session overrides.
- The coordinator initializes the auditor adapter via `auditorFactory` and calls:
  ```js
  auditorAdapter.resumeThread({ threadId: exactRegistryThreadId })
  ```
- The resumed thread ID returned by the adapter must match `exactRegistryThreadId` byte-for-byte.
- Heuristic fallback, latest-thread discovery, fuzzy matching, and `startThread()` are strictly forbidden.

---

## 7. Same-Thread Invariant

A valid one-shot cycle requires strict conversational continuity across both audit phases:
```text
Turn A: Pre-worker audit evaluation
Turn B: Post-worker independent review
```

### Invariant:
```text
thread_A === project.auditor.thread_id
thread_B === project.auditor.thread_id
thread_A === thread_B
```

- There must be **zero** second auditor threads created during the cycle.
- Worker output, completion payloads, or error conditions can never alter or replace auditor thread authority.

---

## 8. Model Policy Pinning

At cycle initialization:
1. Fresh Registry read retrieves `project.auditor.model_policy`.
2. Auditor adapter calls `listModels()`.
3. `resolveAuditorModelPolicy(catalog, policyDescriptor)` resolves:
   - `model`
   - `reasoning_effort`

### Pinning Rules:
- The resolved `model` and `reasoning_effort` are pinned for the entire duration of the cycle (both Turn A and Turn B).
- The auditor model cannot self-select its model or reasoning effort.
- Worker model policy is completely isolated and never passed to the Codex auditor resolver.
- Immediately before Turn B, a fresh Registry read must confirm that `auditor.thread_id`, `auditor.enabled`, `auditor.model_policy`, and canonical path identities remain identical to cycle start. Any drift fails closed before Turn B.

---

## 9. Turn A — Pre-Worker Audit Flow

Turn A execution sequence:
1. Read authoritative Registry record.
2. Compute baseline workspace snapshot `S0` via `workspacePort.computeWorkspaceState(projectRoot)`.
3. Construct `AuditDecisionV1` schema parameter dynamically bound to:
   - `project_id`
   - `audit_subject_id`
   - `exact auditor_thread_id`
   - `S0.workspace_state_id`
4. Invoke `startTurn` on the resumed thread with the structured prompt and bound decision schema.
5. Await terminal turn completion from the auditor adapter.
6. Validate turn output strictly using `validateAuditDecision(rawDecision, expectedContext)`.

**Strict Invariant**: Only an authoritative terminal turn returning a structurally valid `AuditDecisionV1` payload may drive coordinator actions. Prose, free-form text, or unvalidated responses fail closed.

---

## 10. Turn A Decision Branches & Action Semantics

All five standard `AuditDecisionV1` decisions are valid and handled as follows:

| Decision | Action Taken | Worker Dispatches | Coordinator Result | Satisfies Full Acceptance? |
|---|---|:---:|---|:---:|
| `DISPATCH_WORKER` | Proceed to pre-dispatch freshness gate and broker dispatch | **1** | Continues cycle | Yes (candidate path) |
| `REQUEST_EVIDENCE` | Terminate cycle immediately | **0** | `EVIDENCE_REQUIRED` | No (early stop) |
| `APPROVE_WORK_PACKAGE`| Terminate cycle immediately | **0** | `APPROVED_WITHOUT_DISPATCH` | No (no worker cycle) |
| `BLOCKED` | Terminate cycle immediately | **0** | `BLOCKED` | No (safety block) |
| `STOP` | Terminate cycle immediately | **0** | `STOPPED` | No (operator stop) |

- `DISPATCH_WORKER` requires non-null `decision.work_order` with valid `work_order_id`, `directive`, and optional `worker_model_policy`.
- The coordinator must never coerce, prompt-hack, or force the auditor into `DISPATCH_WORKER`.

---

## 11. Pre-Dispatch Freshness Gate (S1)

For the `DISPATCH_WORKER` branch only:
Immediately before calling `broker.dispatchWorker()`, the coordinator must recompute the workspace state:
```text
S1 = workspacePort.computeWorkspaceState(projectRoot)
```

### Freshness Invariant:
```text
S1.workspace_state_id === TurnA.workspace_state_observed === S0.workspace_state_id
```

If `S1.workspace_state_id !== S0.workspace_state_id`:
- Return `STALE_AUDIT_STATE`.
- Abort worker dispatch immediately.
- Worker dispatch count remains **0**.
- The model's echoed state string is never sufficient authority on its own; physical re-hashing is mandatory.

---

## 12. Worker Dispatch via Generic Boundary

Dispatch delegation rules:
- Invoke `broker.dispatchWorker({ schema_version: 1, project_id, work_order_id, expected_workspace_state_id, directive })`.
- `expected_workspace_state_id` must be set to `S0.workspace_state_id`.
- `work_order_id` and `directive` must be taken directly from Turn A's validated `work_order`.
- The generic `WorkerAdapterRegistry` routes the request to the configured engine (`project.worker.engine`).
- The coordinator makes **no** direct calls to Antigravity CLI or UI, uses no session overrides, and invokes no shell commands.

---

## 13. Exactly One Worker Dispatch Maximum

- In a one-shot cycle, the maximum number of successful worker dispatches is strictly **1**.
- The coordinator must **never** issue a second work order.
- The coordinator must **never** retry or auto-resend dispatches following:
  - `DISPATCH_UNCERTAIN`
  - Transport or connection timeout
  - Timeout after send confirmation
  - Provenance ambiguity
- All ambiguous outcomes fail closed immediately.

---

## 14. Worker Wait & Result Transitions

Following a successful `DISPATCH_ACCEPTED`:
1. The coordinator calls `broker.waitWorker({ project_id, dispatch_id, timeout_secs })` with a bounded timeout.
2. The broker queries the active lifecycle record and adapter status.
3. Only `READY_FOR_REVIEW` authorizes proceeding to Turn B.

### Transition Mapping:
- `READY_FOR_REVIEW`: Proceed to post-worker snapshot S2 and Turn B.
- `DISPATCH_ACCEPTED` / `RUNNING` (timeout expired): Return `WORKER_PENDING`. Do not start Turn B. Do not re-dispatch.
- `DISPATCH_FAILED`: Fail closed, terminate cycle.
- `DISPATCH_UNCERTAIN`: Fail closed, terminate cycle.
- `PROVENANCE_AMBIGUOUS`: Fail closed, terminate cycle.
- `WORKER_WAIT_UNAVAILABLE`: Fail closed, terminate cycle.

---

## 15. Semantics of READY_FOR_REVIEW

The design strictly upholds:
```text
READY_FOR_REVIEW ≠ approved
READY_FOR_REVIEW ≠ tests passed
READY_FOR_REVIEW ≠ work package complete
```
- `READY_FOR_REVIEW` indicates solely that the worker has completed its execution turn and relinquished control.
- Any worker report, summary, or exit metadata is classified as an **UNTRUSTED_HINT** and possesses zero approval authority.

---

## 16. Post-Worker Snapshot (S2)

Upon reaching `READY_FOR_REVIEW`:
1. Compute fresh workspace snapshot:
   ```text
   S2 = workspacePort.computeWorkspaceState(projectRoot)
   ```
2. Turn B decision schema must be bound to `S2.workspace_state_id`.
3. The coordinator must never reuse `S0` for Turn B.
4. While typical worker modifications produce `S2 !== S0`, the coordinator does not assert divergence as a prerequisite for Turn B evaluation.

---

## 17. Turn B — Same-Thread Independent Review

Before initiating Turn B:
1. Re-read Registry V2 and verify that project identity, root canonical path, auditor thread ID, auditor enabled status, and model policy remain identical to cycle start.
2. Maintain the same auditor adapter instance and active logical thread (`thread_B === project.auditor.thread_id`).
3. Construct a new `AuditDecisionV1` schema bound to:
   - `project_id`
   - Post-worker `audit_subject_id`
   - Same `auditor_thread_id`
   - `S2.workspace_state_id`
4. Prompt instructs the auditor to independently inspect the actual workspace files and verify correctness. Worker completion hints are marked as untrusted context.

---

## 18. Turn B Decision Semantics & Final Freshness Gate (S3)

Turn B decisions are evaluated under strict terminal semantics:

### `APPROVE_WORK_PACKAGE`:
- The candidate path to successful full-cycle completion.
- Before accepting final approval, compute a fresh workspace snapshot:
  ```text
  S3 = workspacePort.computeWorkspaceState(projectRoot)
  ```
- **Final Approval Gate**:
  ```text
  S3.workspace_state_id === S2.workspace_state_id
  ```
- If `S3.workspace_state_id !== S2.workspace_state_id`, return `STALE_AUDIT_STATE` and withhold approval.

### `REQUEST_EVIDENCE`:
- Return `EVIDENCE_REQUIRED`. Zero additional dispatches.

### `BLOCKED`:
- Return `BLOCKED`. Zero additional dispatches.

### `STOP`:
- Return `STOPPED`. Zero additional dispatches.

### `DISPATCH_WORKER`:
- While structurally valid under `AuditDecisionV1`, the one-shot cycle has already exhausted its dispatch allowance (1/1).
- Return `CYCLE_LIMIT_REACHED`.
- Include the validated decision payload for operator review or future WP12 multi-cycle handling.
- **Never dispatch a second work order**.

---

## 19. Full-Cycle Acceptance Pass Condition

Real WP09 acceptance passes if and only if a single continuous execution verifies all 12 invariants:

```text
 1. Registered auditor starts already bound and enabled in Registry V2.
 2. Exact Registry thread_id is resumed without fallback or heuristic.
 3. Turn A completes with authoritative DISPATCH_WORKER decision.
 4. Freshness gate S1 matches S0 immediately before worker dispatch.
 5. Exactly one real worker dispatch is accepted by the broker.
 6. Worker reaches READY_FOR_REVIEW with exact project and dispatch identities.
 7. Post-worker snapshot S2 is computed and bound to Turn B.
 8. Same exact logical auditor thread performs Turn B.
 9. Turn B performs independent workspace verification.
10. Turn B returns authoritative APPROVE_WORK_PACKAGE decision.
11. Freshness gate S3 matches S2 immediately before final approval.
12. Exactly zero second worker dispatches occur.
```

Any divergence from these 12 conditions constitutes `NOT_FULL_CYCLE_PASS`.

---

## 20. Acceptance Project Selection Criteria

- **No Hard-Coded Identities**: WP09 documents and code must **never** hard-code specific machine-local paths, project IDs, session IDs, or thread IDs.
- **Operator Selection**: The acceptance project will be explicitly designated by the operator during WP09C.
- **Eligibility Requirements**:
  - Registered in Registry V2.
  - Auditor bound (`auditor.thread_id` valid) and enabled.
  - Worker enabled with valid `session_id`.
  - Clean Git status (no untracked or uncommitted changes).
  - Disposable environment where a small test edit causes zero business or operational disruption.
  - No fuzzy or automatic "first project" fallback.

---

## 21. Acceptance Workspace Safety Rules

Prior to executing Turn A in real acceptance:
1. Verify Git working tree is clean.
2. Verify broker worker status is `IDLE`.
3. Verify no active worker dispatches exist in lifecycle store.
4. Verify no active auditor recovery bootstraps exist.
5. If any safety check fails, halt execution before initiating any model turn or worker dispatch.
6. The coordinator must never run destructive Git commands (`git reset --hard`, `git clean -fd`) against a user workspace.

---

## 22. Acceptance Task Shape

The acceptance task defined in WP09C must satisfy:
- **Small & Bounded**: Minimal file modification (e.g., creating or updating a single acceptance test file).
- **Reversible**: Easily inspected and undone via clean revert.
- **Non-Sensitive**: Zero contact with credentials, environment variables, deployment scripts, or sensitive configurations.
- **Independently Verifiable**: Readily verified by the Codex auditor using standard file viewing and checking tools.

---

## 23. Post-Acceptance Cleanup Protocol

1. Full acceptance evidence (including S2 and S3 hashes and approved decision payloads) must be captured and persisted first.
2. Post-acceptance cleanup is an explicit, manual operator action, or uses an isolated, pre-approved single-file removal script.
3. Cleanup is strictly separated from auditor approval authority.

---

## 24. Failure & Uncertainty Handling Matrix

The coordinator enforces fail-closed behavior across all stages:

| Failure Stage | Cause / Symptom | Fail-Closed Result | Turns / Dispatches |
|---|---|---|:---:|
| Pre-flight | Registry missing project or invalid record | `STARTING_STATE_INVALID` | 0 turns, 0 dispatches |
| Pre-flight | Auditor unbound or disabled | `AUDITOR_UNAVAILABLE` | 0 turns, 0 dispatches |
| Pre-flight | Thread resume returns mismatched ID | `THREAD_RESUME_MISMATCH` | 0 turns, 0 dispatches |
| Pre-flight | Model catalog or policy resolution error | `MODEL_POLICY_UNAVAILABLE`| 0 turns, 0 dispatches |
| Pre-flight | Workspace snapshot S0 failure | `WORKSPACE_STATE_FAILED` | 0 turns, 0 dispatches |
| Turn A | App server crash, timeout, or turn error | `AUDITOR_TURN_FAILED` | 1 turn, 0 dispatches |
| Turn A | Invalid or unparseable `AuditDecisionV1` | `DECISION_INVALID` | 1 turn, 0 dispatches |
| Turn A | Workspace freshness S1 != S0 | `STALE_AUDIT_STATE` | 1 turn, 0 dispatches |
| Dispatch | Broker dispatch uncertain or transport error| `DISPATCH_UNCERTAIN` | 1 turn, 1 attempt (stopped)|
| Wait | Worker fails, times out, or provenance issue | `WORKER_FAILED` / `PENDING` | 1 turn, 1 dispatch |
| Pre-Turn B| Registry authority drift (thread/policy/root) | `AUTHORITY_DRIFT` | 1 turn, 1 dispatch |
| Turn B | App server crash, timeout, or turn error | `AUDITOR_TURN_FAILED` | 2 turns, 1 dispatch |
| Turn B | Invalid or unparseable `AuditDecisionV1` | `DECISION_INVALID` | 2 turns, 1 dispatch |
| Turn B | Workspace freshness S3 != S2 | `STALE_AUDIT_STATE` | 2 turns, 1 dispatch |

---

## 25. Durability & State Machine Invariants

- **Zero New SQLite Stores**: WP09 will **not** introduce an additional persistent state store for one-shot cycles.
- Existing authoritative stores suffice:
  - Registry V2 (`registry.json`)
  - Worker Lifecycle SQLite Store (`broker-lifecycle.db`)
  - Auditor Recovery Store (`auditor-recovery.db`)
  - Codex App Server Thread Store
- The coordinator is purely in-memory procedural orchestration. Crash/restart recovery of in-flight cycles is reserved for WP-V4-10.

---

## 26. Planned WP09B Implementation Scope

Implementation in WP09B will be strictly scoped to:
- **New Production Module**: `pipeline-ui/lib/relay/one-shot-cycle.js`
- **New Deterministic Suite**: `pipeline-ui/test/refactor/one-shot-cycle.test.js`
- **Modified Configuration**: `pipeline-ui/package.json` (add `test:one-shot-cycle` script)
- **Modified Documentation**: `docs/refactor-v4-native-codex-relay/15-IMPLEMENTATION-PLAN.md`

### Modules Protected from Modification:
- `pipeline-ui/lib/broker/broker.js`
- `pipeline-ui/lib/broker/runtime.js`
- `pipeline-ui/lib/broker/worker-adapter-registry.js`
- `pipeline-ui/lib/broker/worker-adapter.js`
- `pipeline-ui/lib/broker/registry.js`
- `pipeline-ui/lib/broker/workspace-state.js`
- `pipeline-ui/lib/broker/contracts.js`
- `pipeline-ui/lib/relay/audit-decision.js`
- `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
- `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`
- `pipeline-ui/lib/auditor/codex-auditor-adapter.js`
- `pipeline-ui/lib/auditor/codex-app-server-client.js`
- `pipeline-ui/lib/auditor/model-policy-resolver.js`

---

## 27. Planned WP09B Deterministic Test Matrix (OSC)

Test prefix: `OSC` (One-Shot Coordinator). Minimum planned 30 test cases:

- `OSC-001`: Starting gate: rejects missing project with `STARTING_STATE_INVALID`.
- `OSC-002`: Starting gate: rejects unbound auditor (`thread_id === null`) with zero model/worker calls.
- `OSC-003`: Starting gate: rejects disabled auditor (`auditor.enabled === false`) with zero model/worker calls.
- `OSC-004`: Starting gate: rejects disabled worker (`worker.enabled === false`) with zero model/worker calls.
- `OSC-005`: Thread resumption: resumes exact `project.auditor.thread_id`.
- `OSC-006`: Thread resumption: mismatch between requested and returned thread ID fails closed.
- `OSC-007`: Model policy: resolves model policy once at cycle start and pins for both turns.
- `OSC-008`: Turn A schema: binds exact `project_id`, `audit_subject_id`, `thread_id`, and `S0.workspace_state_id`.
- `OSC-009`: Turn A decision: `REQUEST_EVIDENCE` terminates with zero worker dispatches.
- `OSC-010`: Turn A decision: `BLOCKED` terminates with zero worker dispatches.
- `OSC-011`: Turn A decision: `STOP` terminates with zero worker dispatches.
- `OSC-012`: Turn A decision: `APPROVE_WORK_PACKAGE` terminates with `APPROVED_WITHOUT_DISPATCH` (zero dispatches).
- `OSC-013`: Turn A decision: `DISPATCH_WORKER` proceeds to freshness gate.
- `OSC-014`: Pre-dispatch freshness: S1 matches S0 allows dispatch to proceed.
- `OSC-015`: Pre-dispatch freshness: S1 drift (`S1 !== S0`) aborts dispatch with `STALE_AUDIT_STATE`.
- `OSC-016`: Worker dispatch: passes exact validated directive and work order ID to broker.
- `OSC-017`: Worker dispatch: maximum dispatch count is strictly 1.
- `OSC-018`: Worker dispatch: `DISPATCH_UNCERTAIN` terminates without auto-retry.
- `OSC-019`: Worker wait: `RUNNING` or `DISPATCH_ACCEPTED` after timeout returns `WORKER_PENDING`.
- `OSC-020`: Worker wait: failure outcomes (`DISPATCH_FAILED`, `PROVENANCE_AMBIGUOUS`) fail closed.
- `OSC-021`: Worker wait: `READY_FOR_REVIEW` alone does not approve and triggers S2 calculation.
- `OSC-022`: Post-worker snapshot: S2 is computed fresh after `READY_FOR_REVIEW`.
- `OSC-023`: Authority gate: Registry re-verified before Turn B; authority drift fails closed.
- `OSC-024`: Turn B execution: uses exact same logical auditor thread (`thread_B === thread_A`).
- `OSC-025`: Turn B schema: binds exact `S2.workspace_state_id`.
- `OSC-026`: Turn B context: worker completion data passed strictly as `UNTRUSTED_HINT`.
- `OSC-027`: Turn B approval: fresh S3 snapshot recomputed.
- `OSC-028`: Turn B approval: S3 drift (`S3 !== S2`) fails with `STALE_AUDIT_STATE`.
- `OSC-029`: Turn B non-approval: `DISPATCH_WORKER` returns `CYCLE_LIMIT_REACHED` with zero second dispatch.
- `OSC-030`: Happy path sequence: verifies exact ordering (resume → Turn A → S1 → dispatch → wait → S2 → Turn B → S3 → approve).

---

## 28. Planned Regression Baselines

Following WP09B implementation:
- **Suite Count**: 18 deterministic suites passing.
- **Preserved Baselines**:
  - `WREG`: 28 / 28
  - `WA`: 55 / 55
  - `BC`: 52 / 52
  - `RG`: 55 / 55
  - `ARC`: 67 / 67
  - `ARS`: 88 / 88
  - `TUO`: 27 / 27
  - `CAS`: 105 / 105
  - `MPR`: 21 / 21
  - `ATL`: 133 / 133
  - `AD`: 122 / 122
  - `OSC`: >= 30

---

## 29. WP09C Real Acceptance Boundary

Real execution side effects are strictly confined to a subsequent, explicitly authorized work order (`WP-V4-09C`).

### Acceptance Ceilings:
- Real worker dispatches: **maximum 1**
- Real worker completions: **maximum 1**
- Real auditor turns: **maximum 2**
- Logical auditor threads: **exactly 1** (existing bound thread)
- New auditor threads created: **0**

### WP09A Execution Facts:
- Real auditor turns: **0**
- Real worker dispatches: **0**
- Real AGY messages: **0**
- Model turns: **0**
- Registry mutations: **NO**

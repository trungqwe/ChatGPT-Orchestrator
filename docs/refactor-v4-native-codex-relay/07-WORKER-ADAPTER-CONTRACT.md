# Worker Adapter Contract (WorkerPortV1)

## 1. Architectural Scope & Purpose

The Worker Port defines the broker-facing abstraction layer decoupling the deterministic Orchestrator broker from worker implementation engines (e.g., Antigravity, future Codex worker, or other execution backends).

In the Native Codex Relay architecture:

```text
Operator
  ↓
Thin Relay
  ├── Native Codex Auditor
  └── Worker Adapter Registry
        └── Antigravity / future engines
```

---

## 2. Authoritative WorkerPortV1 Contract

The broker-facing WorkerPortV1 interface requires **exactly two** semantic methods for WP-V4-08:

```ts
interface WorkerPortV1 {
  /**
   * Dispatches an implementation directive to the resolved worker engine.
   */
  dispatch(args: {
    project: object;
    project_id: string;
    work_order_id: string;
    dispatch_id: string;
    expected_workspace_state_id: string;
    directive: string;
  }): Promise<{
    ok: boolean;
    definitive?: boolean;
    code?: string;
    error?: string;
  }>;

  /**
   * Bounded monotonic wait for worker completion envelope.
   */
  wait(args: {
    project: object;
    project_id: string;
    work_order_id: string;
    dispatch_id: string;
    expected_workspace_state_id: string;
    timeout_secs?: number;
  }): Promise<{
    ok: boolean;
    state?: string;
    code?: string;
    error?: string;
    dispatch_id?: string;
    work_order_id?: string;
  }>;
}
```

These two methods are the **ONLY** required WorkerPortV1 methods.

---

## 3. Classification of Non-Required & Future Capabilities

### `probe` and `cancel`
- **Status**: Future capability only.
- **Authority**: Zero lifecycle authority in WP08.
- **Rationale**: The deterministic broker does not invoke `probe()` or `cancel()`. Any future cancellation or probe capability requires independent architectural design, lifecycle state definitions, and formal regression coverage before introduction.

### `status`
- **Status**: Existing adapter-local compatibility helper.
- **Authority**: Zero broker semantic authority.
- **Rationale**: `broker.getWorkerStatus(projectId)` is derived entirely from broker lifecycle state stored in the SQLite Lifecycle Store (`lifecycleStore.getActiveDispatch(projectId)`), NOT from worker adapter status. While the Antigravity adapter implementation exports a local `status()` helper returning `{ ok: true, state: 'IDLE' }`, it is **not** part of the required generic WorkerPortV1 contract and carries zero lifecycle weight.

### `close`
- **Status**: Runtime-owned capability if needed for future engines.
- **Authority**: Zero WorkerPortV1 contract requirement in WP08.
- **Rationale**: Antigravity requires no process cleanup contract.

---

## 4. Engine Resolution & Exact Authority

1. **Exact Engine Token Authority**: Engine selection is driven exclusively by:
   ```text
   project.worker.engine
   ```
   as resolved from the authoritative Project Registry.
2. **No Fallback / No Default**:
   - Unknown engine → fail closed (never default to Antigravity).
   - Missing worker descriptor → fail closed.
   - Case mismatch (e.g. `Antigravity`, `ANTIGRAVITY`) → fail closed.
   - Whitespace in runtime project descriptor (e.g. `"antigravity "`) → fail closed.
   - No fuzzy matching, no case folding, no alias resolution.
3. **No Caller or Directive Overrides**:
   - Callers cannot override engine selection via API flags, CLI flags, or environment variables.
   - Directive text must never influence adapter selection.
4. **Argument Immutability**:
   - The selected adapter receives `project_id`, `work_order_id`, `dispatch_id`, `expected_workspace_state_id`, and `directive` completely unchanged.

---

## 5. Generic Software Boundary vs. Persisted Registry V2 Authority

- **Software Capability**: The Worker Adapter Registry enables modular composition of multiple engine adapters in software.
- **Persisted Registry Authority**: In production, persisted Registry V2 strictly enforces:
  ```text
  worker.engine === "antigravity"
  ```
- **Invariant**: Generic adapter capability ≠ persisted engine authorization.
- Expanding persisted engine types to Codex worker or other engines is explicitly reserved for a dedicated Registry schema work package and is NOT part of WP-V4-08.

---

## 6. Completion Binding & The `READY_FOR_REVIEW` Invariant

1. **Exact Identity Binding**:
   - Completion envelopes must strictly bind:
     - `project_id`
     - `work_order_id`
     - `dispatch_id`
   - Plain `DONE` or unverified completion signals are invalid and rejected.
2. **Semantic Meaning of `READY_FOR_REVIEW`**:
   - `READY_FOR_REVIEW ≠ approved`
   - `READY_FOR_REVIEW ≠ tests passed`
   - `READY_FOR_REVIEW ≠ auditor decision`
   - `READY_FOR_REVIEW` represents only that the worker implementation claims completion and is ready for independent review.
3. **Trust Hierarchy**:
   - Worker output is treated as `UNTRUSTED_HINT`.
   - The Native Codex Auditor is the sole semantic approval authority.

---

## 7. Resolution Failure Semantics

### Dispatch Resolution Failure
- Generic adapter resolution failure during `dispatch()` occurs **before** calling any adapter method.
- Invariants:
  - Adapter calls: 0
  - AO sends: 0
  - Subprocess spawns: 0
  - Fallback attempts: 0
- Returns a deterministic definitive local failure:
  ```js
  {
    ok: false,
    definitive: true,
    error: "Worker adapter unavailable"
  }
  ```
- Does **NOT** require `code: "WORKER_SESSION_UNAVAILABLE"` (`WORKER_SESSION_UNAVAILABLE` is Antigravity/session-specific, not shared broker authority; `contracts.js` is not modified).
- The existing broker translates this definitive dispatch failure into its existing `DISPATCH_FAILED` lifecycle semantics. No new broker lifecycle state is created.

### Wait Resolution Failure
- In the broker core (`broker.js`), transport exceptions during `wait()` are caught by the broker catch boundary:
  ```text
  workerPort.wait throws
      ↓
  broker catches
      ↓
  returns WORKER_WAIT_UNAVAILABLE
      ↓
  existing lifecycle state remains unchanged
  ```
- Therefore, when worker engine resolution fails during `wait()`:
  - The generic registry facade **MUST THROW** a local bounded Error before calling any adapter.
  - It **MUST NOT** return `{ ok: false, code: "WORKER_WAIT_UNAVAILABLE" }` (broker does not interpret that return shape as `WORKER_WAIT_UNAVAILABLE`).
  - It **MUST NOT** return `{ definitive: true }` (which would trigger transition to `DISPATCH_FAILED`).
  - Required flow:
    ```text
    resolution failure
    → throw
    → broker catch boundary
    → WORKER_WAIT_UNAVAILABLE
    → zero lifecycle mutation
    ```

---

## 8. Worker Adapter Registry Public Surface & Snapshot Semantics

1. **Facade Public API**:
   `createWorkerAdapterRegistry(...)` returns a broker-facing `WorkerPortV1` facade exposing **strictly**:
   ```js
   {
     dispatch,
     wait
   }
   ```
   It does **NOT** expose:
   - `resolve()`
   - `get()`
   - `lookup()`
   - `adapters`
   - `map`
   - `register()`
   - `unregister()`
   Engine resolution is private implementation plumbing.
2. **Registration Storage & Immutability**:
   - Internal storage uses a closure-private Map / lookup structure, never exposed to callers.
   - No runtime mutation API (`register`, `unregister`) is provided.
   - At construction, the registry snapshots `engine` (string) and `adapter` (reference) from each registration entry.
   - Mutation of the original `adapters` array, `entry.engine`, or `entry.adapter` after construction has zero effect on engine mapping.
   - Does not rely on `Object.freeze(new Map())`.
   - Registration mapping immutability ≠ deep immutability of adapter implementation state (adapters may maintain mutable transport state).
3. **Registration Entry Validation**:
   - Each registration requires: plain object, non-empty `engine` string, `adapter` object with `dispatch` and `wait` functions.
   - Duplicate exact engine strings are rejected at construction.
   - Registration engine tokens with leading or trailing whitespace are rejected at construction.

---

## 9. Antigravity Dispatch Delivery Acknowledgement & Provenance (WO-V4-09C-D1)

### 9.1 Core Delivery Authority Rule
- `AO exit status 0 = transport-command acknowledgement only`.
- Process exit 0 **MUST NOT** by itself authorize `DISPATCH_ACCEPTED`.
- Authoritative delivery acknowledgement requires positive observation of the exact dispatch boundary in the Registry-resolved authoritative transcript.
- Exact boundary requires:
  - `record.source === "USER_EXPLICIT"`
  - `record.type === "USER_INPUT"`
  - Physical line 0: `[ORCHESTRATOR_DISPATCH_V1]`
  - Physical line 1: JSON binding `worker_dispatch` schema v1 to current `project_id`, `work_order_id`, `dispatch_id`, and `expected_workspace_state_id`.

### 9.2 Dispatch Sequence with Bounded Delivery Acknowledgement
```text
validate worker/session
→ resolve authoritative transcript
→ render exact envelope
→ AO send ONCE
→ if send outcome non-zero/timeout/exception:
     existing non-definitive failure → broker persists DISPATCH_UNCERTAIN
→ if AO exit 0:
     enter bounded boundary-ack observation window:
     ├── monotonic clock evaluation (default 30,000ms, clamped 1ms..30,000ms)
     ├── re-resolve exact session and verify transcript mapping stability
     ├── scan transcript for exact dispatch boundary
     ├── exact boundary observed:
     │    return { ok: true, state: "DISPATCH_ACCEPTED" }
     └── boundary unproven by deadline / scan error / mapping drift / duplicate / contradiction:
          return non-definitive failure → broker persists DISPATCH_UNCERTAIN
```

### 9.3 Invariants
- **No AO resend**: `ao send` is invoked at most once per dispatch attempt.
- **No second dispatch**: Unproven boundary produces non-definitive failure; the adapter never resends.
- **No heuristic delivery inference**: Delivery cannot be assumed without exact transcript proof.
- **Separation of Concerns**: Dispatch acknowledgement never emits `READY_FOR_REVIEW`.

---

## 10. Wait Contract Hardening & Retirement of WA-008

1. **Precondition Hardening**:
   Under the delivery acknowledgement contract, `DISPATCH_ACCEPTED` is only achieved after the exact boundary is verified on disk.
2. **Retirement of WA-008**:
   The legacy assumption that a missing boundary at wait deadline returns `DISPATCH_ACCEPTED` is formally **RETIRED**.
3. **Provenance Ambiguity**:
   If a subsequent `workerPort.wait()` invocation cannot observe the previously acknowledged dispatch boundary within its authoritative transcript snapshot, this constitutes a provenance violation.
   The adapter returns:
   ```js
   {
     ok: false,
     code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
     dispatch_id,
     error: "Authoritative dispatch boundary previously acknowledged could not be found in transcript during wait"
   }
   ```
   The broker transitions the dispatch to `PROVENANCE_AMBIGUOUS`.

---

## 11. Scope Invariants & Compatibility Boundaries

1. **`contracts.js` Immutability**:
   Zero changes to lifecycle states or error code definitions.
2. **`broker.js` Immutability**:
   Existing broker failure mapping (`ok: false, definitive: false` → `DISPATCH_UNCERTAIN`; `code: PROVENANCE_AMBIGUOUS` → `PROVENANCE_AMBIGUOUS`) is fully utilized without broker modification.
3. **Public API Immutability**:
   `WorkerPortV1.dispatch()` and `WorkerPortV1.wait()` public signatures remain unchanged. Acknowledgement timeouts are adapter-internal configuration.

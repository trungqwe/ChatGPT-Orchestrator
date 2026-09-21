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
   - Whitespace (e.g. `antigravity `) → fail closed.
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

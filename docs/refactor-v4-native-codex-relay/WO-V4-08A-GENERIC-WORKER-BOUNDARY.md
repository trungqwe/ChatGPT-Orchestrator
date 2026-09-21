# WO-V4-08A: Generic Worker Adapter Boundary Design Seal

## 1. Document & Work Package Identity

- **Work Package**: WP-V4-08 (Generic Worker Boundary)
- **Phase**: Design Seal (WO-V4-08A)
- **Status**: DESIGN_COMPLETE / EXTERNAL_REVIEW_PENDING
- **Parent Commit**: `c1fb0363d188ccef4b923e4033b742314dec7113`
- **Canonical Branch**: `dev/v4-clean`
- **Scope**: Documentation only (no production code, no test modifications, no registry modifications, no runtime execution)

---

## 2. Current Authoritative Source Inventory

A thorough audit of the active canonical source (`dev/v4-clean`) reveals the following production reality:

1. **Direct Coupling in Runtime Factory**:
   In `pipeline-ui/lib/broker/runtime.js`, the runtime factory directly instantiates `createAntigravityWorkerPort(options.workerOptions || {})` as the default `workerPort`. There is currently no generic production Worker Adapter Registry.
2. **Strict Persisted Registry Schema**:
   In `pipeline-ui/lib/broker/registry.js`, the project schema validator explicitly requires:
   ```text
   project.worker.engine === "antigravity"
   ```
   Persisted Registry V2 permits only `"antigravity"` as a valid worker engine.
3. **Authoritative Broker Usage**:
   In `pipeline-ui/lib/broker/broker.js`, the deterministic broker interacts with `workerPort` strictly through two methods:
   - `workerPort.dispatch({ project, project_id, work_order_id, dispatch_id, expected_workspace_state_id, directive })`
   - `workerPort.wait({ project, project_id, work_order_id, dispatch_id, expected_workspace_state_id, timeout_secs })`
4. **Lifecycle State Decoupling**:
   The broker does **not** call `probe()`, `cancel()`, or `status()` on `workerPort`.
   Specifically, `broker.getWorkerStatus(projectId)` reads the active dispatch record directly from SQLite via `lifecycleStore.getActiveDispatch(projectId)`. Worker adapter status carries zero lifecycle authority.
5. **Existing Antigravity Port Exports**:
   `pipeline-ui/lib/broker/worker-adapter.js` exports:
   - `dispatch`
   - `wait`
   - `status` (local helper returning `{ ok: true, state: 'IDLE' }`)
   - `formatDispatchEnvelope`
6. **Active Regression Baselines**:
   - Worker Adapter: `WA-001 .. WA-055` (55/55 PASS)
   - Broker Core: `BC-001 .. BC-052` (52/52 PASS)
   - Project Registry: `RG-001 .. RG-055` (55/55 PASS)
   - Auditor Recover CLI: `ARC-001 .. ARC-067` (67/67 PASS)
   - Auditor Recovery Store: `ARS-001 .. ARS-088` (88/88 PASS)
   - Token Usage Observer: `TUO-001 .. TUO-027` (27/27 PASS)
   - Codex App Server Client: `CAS-001 .. CAS-105` (105/105 PASS)
   - Model Policy Resolver: `MPR-001 .. MPR-021` (21/21 PASS)
   - Auditor Thread Lifecycle: `ATL-001 .. ATL-133` (133/133 PASS)
   - Audit Decision: `AD-001 .. AD-122` (122/122 PASS)

---

## 3. Problem Statement & Architecture Goals

### Problem Statement
In the original implementation, the Orchestrator broker runtime was hardcoded to create and use `createAntigravityWorkerPort`. While Antigravity is currently the sole supported production execution engine, coupling the broker directly to Antigravity violates architectural modularity and prevents clean introduction of future worker engines (such as a native Codex worker or alternate headless engines) without rewriting broker initialization.

### Architectural Goals
1. Establish a clean, deterministic, fail-closed **Generic Worker Adapter Registry** boundary.
2. Formally seal the broker-facing contract (`WorkerPortV1`) to exactly the two methods actually used by the broker (`dispatch` and `wait`).
3. Maintain complete backward compatibility: preserve existing Antigravity adapter semantics and 100% of existing regression test coverage.
4. Guarantee fail-closed security invariants: exact engine matching, no fallbacks, no dynamic code loading, immutable registry state.
5. Keep production persisted Registry V2 scoped strictly to `antigravity`—generic software boundary capability must not be conflated with persisted schema authorization.

---

## 4. Trust Boundaries & Invariants

```text
       ┌─────────────────────────────────────────────────────────┐
       │                        OPERATOR                         │
       └────────────────────────────┬────────────────────────────┘
                                    │
                                    ▼
       ┌─────────────────────────────────────────────────────────┐
       │                   THIN RELAY & BROKER                   │
       │  - Owns lifecycle state transitions (SQLite Store)      │
       │  - Owns dispatch IDs & workspace state verification     │
       │  - Consults Project Registry for project config         │
       └──────────────┬───────────────────────────┬──────────────┘
                      │                           │
                      ▼                           ▼
       ┌──────────────────────────────┐   ┌──────────────────────────────┐
       │    NATIVE CODEX AUDITOR      │   │    WORKER ADAPTER REGISTRY   │
       │  - Sole approval authority   │   │  - Selection plumbing only   │
       │  - Evaluates diffs & claims  │   │  - Zero lifecycle authority  │
       │  - Produces binding decision │   │  - Resolves engine to port   │
       └──────────────────────────────┘   └──────────────┬───────────────┘
                                                         │
                                          ┌──────────────┴───────────────┐
                                          ▼                              ▼
                               ┌─────────────────────┐        ┌─────────────────────┐
                               │ Antigravity Adapter │        │ (Future Engine Port)│
                               │ - AO session bind   │        │ - Explicitly scoped │
                               │ - Machine envelope  │        │ - Not in V2 schema  │
                               └─────────────────────┘        └─────────────────────┘
```

### Core Invariants
1. **Worker Output is `UNTRUSTED_HINT`**:
   - `READY_FOR_REVIEW ≠ approved`
   - `READY_FOR_REVIEW ≠ tests passed`
   - `READY_FOR_REVIEW ≠ auditor decision`
   - `READY_FOR_REVIEW` indicates only that the worker claims completion. The Native Codex Auditor remains the sole authority for verification and approval.
2. **Zero Lifecycle Ownership in Adapter Registry**:
   - The Worker Adapter Registry is purely selection plumbing.
   - It does NOT generate dispatch IDs.
   - It does NOT persist dispatch records.
   - It does NOT perform state transitions.
   - It does NOT inspect workspace git state.
   - It does NOT approve or reject work orders.
3. **Identity Immutability**:
   - Every dispatch and wait operation remains strictly bound to four immutable identities:
     - `project_id`
     - `work_order_id`
     - `dispatch_id`
     - `expected_workspace_state_id`
   - The generic layer must never omit, alter, or synthesize any of these fields.

---

## 5. Broker-Facing Contract: WorkerPortV1

The broker-facing WorkerPortV1 interface is sealed to **exactly two required methods**:

```ts
interface WorkerPortV1 {
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

### Classification of Non-Required Methods
- **`probe()` and `cancel()`**:
  - Future capabilities only.
  - Carry **zero lifecycle authority** in WP-V4-08.
  - The broker core does not call them. Any future addition requires dedicated lifecycle state analysis, store schema review, and test coverage.
- **`status()`**:
  - Existing adapter-local helper on `createAntigravityWorkerPort`.
  - Carries **zero broker semantic authority**.
  - `broker.getWorkerStatus(projectId)` retrieves active state from `lifecycleStore.getActiveDispatch(projectId)`, not from the adapter.
- **`close()`**:
  - Not part of WorkerPortV1 in WP08.
  - Antigravity adapter has no persistent subagent processes requiring cleanup. Future engines requiring process management will define lifecycle cleanup at runtime level.

---

## 6. Adapter Registry Specification

### Construction Factory
```ts
function createWorkerAdapterRegistry(options = {}) {
  // options.adapters: Array<{ engine: string, adapter: WorkerPortV1 }>
}
```

### Construction Rules & Invariants
1. **Strict Validation**:
   - `options.adapters` must be an Array.
   - Every entry must be a plain object with a valid `engine` string and a valid `adapter` object.
   - `adapter.dispatch` must be a function.
   - `adapter.wait` must be a function.
2. **Duplicate Rejection**:
   - Duplicate `engine` keys are rejected immediately at construction with a descriptive Error.
3. **State Immutability**:
   - The registry must copy entries into a private, frozen internal Map.
   - Subsequent mutation of the caller's array or entry objects has zero effect on engine resolution.
   - No dynamic registration/unregistration API (`register()`, `unregister()`) is exposed at runtime.
4. **Resolution by Exact Token**:
   - Lookup key is strictly `project.worker.engine`.
   - Matching is exact binary string equality (`===`).
   - No case folding (e.g. `Antigravity` or `ANTIGRAVITY` will fail).
   - No whitespace trimming on lookup (e.g. `"antigravity "` will fail).
   - No fuzzy matching, no regex matching, no alias resolution.
5. **No Default or Fallback Engine**:
   - Unknown engine → fail closed.
   - Missing engine → fail closed.
   - There must be **zero fallback** to Antigravity or the first registered adapter.
6. **No External Overrides**:
   - Engine selection cannot be overridden via CLI flags, query parameters, directive contents, or environment variables.

---

## 7. Engine Authority & Validation Rules

When `dispatch` or `wait` is called on the registry-backed facade:

1. **Pre-flight Project Validation**:
   - `project` must be an object.
   - `project.project_id` must match `args.project_id`.
   - `project.worker` must be an object.
   - `project.worker.enabled` must be strictly `true`.
   - `project.worker.engine` must be a string matching a registered engine exactly.
2. **Fail-Closed Dispatch Semantics**:
   - If engine resolution fails:
     - No adapter method is called.
     - No external processes are spawned.
     - No subprocess communication occurs.
     - Returns immediately:
       ```json
       {
         "ok": false,
         "definitive": true,
         "code": "WORKER_SESSION_UNAVAILABLE",
         "error": "Unrecognized or unauthorized worker engine: '<engine>'"
       }
       ```
     - The broker translates this deterministically according to its existing error boundary.
3. **Fail-Closed Wait Semantics**:
   - If engine resolution fails during wait:
     - Does NOT mutate lifecycle store.
     - Does NOT synthesize `READY_FOR_REVIEW`.
     - Throws/returns error mapping to `WORKER_WAIT_UNAVAILABLE`.
4. **Result Transparency**:
   - For successfully resolved engines, return values from `adapter.dispatch` and `adapter.wait` are passed through transparently without rewriting or semantic interference.

---

## 8. Persisted Registry V2 Boundary Scope

A fundamental design constraint of WP-V4-08 is separating software modularity from persisted data authority:

```text
Generic Adapter Capability ≠ Persisted Engine Authorization
```

- **In Code**: `createWorkerAdapterRegistry` is capable of holding multiple adapter engines.
- **In Persisted Storage**: `pipeline-ui/lib/broker/registry.js` remains strictly Antigravity-only:
  ```text
  worker.engine === "antigravity"
  ```
- **Scope Rule**: WP-V4-08 does **NOT** expand the Registry V2 schema to allow `"codex"` or other engines in persisted projects. Expanding the persisted schema requires a future dedicated work package with its own schema migrations and rollback tests.
- No dynamic `require()` or dynamic path loading based on engine string is permitted.

---

## 9. Future Production Composition (WP-V4-08B)

In the planned WP-V4-08B implementation, `createBrokerRuntime` will compose components as follows:

```text
createBrokerRuntime(options)
  │
  ├── Project Registry
  ├── Workspace State Port
  ├── SQLite Lifecycle Store
  │
  └── workerPort:
        │
        ├── If options.workerPort provided:
        │     └── options.workerPort  (Direct DI for tests)
        │
        └── Else:
              └── createWorkerAdapterRegistry({
                    adapters: [
                      {
                        engine: 'antigravity',
                        adapter: createAntigravityWorkerPort(options.workerOptions || {})
                      }
                    ]
                  })
```

### Dependency Injection Rules
1. `options.workerPort`: If explicitly provided by caller, the runtime uses it directly, bypassing registry creation entirely. This guarantees zero breaking changes for existing unit tests.
2. `options.workerAdapterRegistry`: An optional parameter allowing programmatic injection of a custom registry for integration testing. Never exposed via CLI.

---

## 10. Security Requirements

1. **No Dynamic Code Execution**:
   - No `eval()`, `new Function()`.
   - No `child_process.exec()` or `child_process.execSync()` in the registry.
   - No `require()` calls parameterized by `project.worker.engine`.
2. **No User/Directive Injection**:
   - Directives cannot contain control headers that switch the engine.
   - Directive text is passed verbatim to the selected adapter.
3. **Deterministic Error Handling**:
   - Engine resolution failures must produce consistent error shapes.
   - Stack traces are sanitized and never leaked to external control boundaries.

---

## 11. Planned WP-V4-08B Implementation Scope

For subsequent work order WP-V4-08B:

### Files to Create
- `pipeline-ui/lib/broker/worker-adapter-registry.js`: Pure factory implementing `createWorkerAdapterRegistry`.
- `pipeline-ui/test/refactor/worker-adapter-registry.test.js`: Comprehensive deterministic unit test suite.

### Files to Modify
- `pipeline-ui/lib/broker/runtime.js`: Integrate `createWorkerAdapterRegistry` into runtime composition, preserving DI.
- `pipeline-ui/package.json`: Add test script for worker adapter registry test suite.
- `docs/refactor-v4-native-codex-relay/15-IMPLEMENTATION-PLAN.md`: Update WP-V4-08 status upon implementation completion.

### Files Explicitly Preserved (Zero Modifications Planned)
- `pipeline-ui/lib/broker/worker-adapter.js`
- `pipeline-ui/lib/broker/antigravity-completion-source.js`
- `pipeline-ui/lib/broker/broker.js`
- `pipeline-ui/lib/broker/contracts.js`
- `pipeline-ui/lib/broker/registry.js`
- All existing test suites

---

## 12. Planned WP-V4-08B Test Matrix (`WREG`)

The implementation test suite will enforce the following minimum 18 deterministic cases:

| ID | Description | Assertion / Expected Behavior |
|---|---|---|
| **WREG-001** | Single Antigravity registration resolves exact engine | Returns matching adapter instance |
| **WREG-002** | Dispatch delegates to exact registered adapter | Adapter's `dispatch()` called with unmodified arguments |
| **WREG-003** | Wait delegates to exact registered adapter | Adapter's `wait()` called with unmodified arguments |
| **WREG-004** | Dispatch preserves authoritative argument fields | `project`, `project_id`, `work_order_id`, `dispatch_id`, `expected_workspace_state_id`, `directive` identical |
| **WREG-005** | Wait preserves authoritative argument fields | `project`, `project_id`, `work_order_id`, `dispatch_id`, `expected_workspace_state_id`, `timeout_secs` identical |
| **WREG-006** | Unknown engine has zero fallback and zero adapter call | Fails closed with definitive error; adapter methods not invoked |
| **WREG-007** | Case mismatch has zero fallback | Engine `"Antigravity"` or `"ANTIGRAVITY"` fails closed |
| **WREG-008** | Missing worker descriptor fails closed | `project.worker` undefined/null fails closed |
| **WREG-009** | Disabled worker fails closed | `project.worker.enabled === false` fails closed |
| **WREG-010** | `project_id` mismatch fails closed before adapter call | `project.project_id !== args.project_id` rejected immediately |
| **WREG-011** | Duplicate engine registration rejected at construction | Throws Error during `createWorkerAdapterRegistry` |
| **WREG-012** | Adapter missing `dispatch` rejected at construction | Throws Error if `adapter.dispatch` is not a function |
| **WREG-013** | Adapter missing `wait` rejected at construction | Throws Error if `adapter.wait` is not a function |
| **WREG-014** | Caller mutation of registration array cannot alter resolution | Modifying array after factory return has zero effect |
| **WREG-015** | Extra adapter methods carry zero broker authority | Auxiliary properties/methods on adapter are ignored |
| **WREG-016** | Existing Antigravity adapter behavior is delegated unchanged | Real Antigravity port runs through registry with exact fidelity |
| **WREG-017** | `options.workerPort` DI bypasses production registry construction | Passing `workerPort` skips registry creation |
| **WREG-018** | Runtime default composition registers Antigravity exactly once | Default `createBrokerRuntime()` exposes functioning Antigravity port |

---

## 13. Explicit Out-of-Scope List

The following items are strictly out of scope for WP-V4-08:
1. **Implementation Code**: No production or test code is written in WO-V4-08A.
2. **Registry Schema Changes**: No new engine types or model policy schemas in `registry.js`.
3. **Model Selection & Budgeting**: Model selection and token budgeting are reserved for WP-V4-12.
4. **Cancellation / Probing**: Cancellation semantics and probe protocols are not implemented.
5. **Real Worker Dispatches**: No real Antigravity messages or worker executions during WP-V4-08.

---

## 14. External Review & Approval Gate

This design document seals the technical specification of the Generic Worker Adapter Boundary.

Before proceeding to WP-V4-08B implementation:
- The design must be reviewed and approved by the external operator.
- The parent commit must remain `c1fb0363d188ccef4b923e4033b742314dec7113`.
- No implementation work may start until explicit authorization is received.

# WO-V4-08A-R1: Generic Worker Adapter Boundary Design Seal (Corrected)

## 1. Document & Work Package Identity

- **Work Package**: WP-V4-08 (Generic Worker Boundary)
- **Phase**: Design Seal Revision 1 (WO-V4-08A-R1)
- **Status**: APPROVED_CLOSED
- **Closure Note**:
  - External review result: APPROVED_CLOSED
  - Implementation authority: `31e9f9db3718556aa8f6561f78c37b0c9af093ea`
  - Reviewed implementation tree: `8a1b9bdfad6b59f7d499f47a40c953b3f5a84aa9`
- **Parent Commit**: `5915c2123bdf9b173980a9d174d03ef0f3f83b00`
- **Canonical Branch**: `dev/v4-clean`
- **Scope**: Documentation only (no production code, no test modifications, no registry modifications, no runtime execution)
- **Purpose**: Correct three design ambiguities identified during external review:
  1. Wait-resolution failure semantics (throw into broker catch boundary for zero lifecycle mutation)
  2. Worker Adapter Registry public API (strictly `dispatch` and `wait`; no public `resolve()`)
  3. Registration immutability semantics (closure-private snapshot; no reliance on `Object.freeze(Map)`)

---

## 2. Current Authoritative Source Inventory

A thorough audit of the active canonical source (`dev/v4-clean`) establishes the following authoritative facts:

1. **Direct Coupling in Runtime Factory**:
   In `pipeline-ui/lib/broker/runtime.js`, `createBrokerRuntime` directly defaults `workerPort` to:
   ```js
   createAntigravityWorkerPort(options.workerOptions || {})
   ```
   There is currently no generic production Worker Adapter Registry.
2. **Strict Persisted Registry Schema**:
   In `pipeline-ui/lib/broker/registry.js`, the schema validator explicitly requires:
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
In the original implementation, the Orchestrator broker runtime directly constructed `createAntigravityWorkerPort`. While Antigravity is currently the sole supported production execution engine, coupling the broker directly to Antigravity violates architectural modularity.

External review identified three specific design points requiring formal correction before implementation:
1. **Wait-Resolution Failure Semantics**: The generic facade must throw upon engine resolution failure so that the broker catch boundary deterministically returns `WORKER_WAIT_UNAVAILABLE` without mutating lifecycle state.
2. **Public API Sealing**: The registry must return a pure `WorkerPortV1` facade (`dispatch`, `wait`). No public `resolve()`, `get()`, or lookup API may exist.
3. **Registration Immutability**: Immutability must be achieved via closure-private snapshots, recognizing that `Object.freeze(Map)` does not freeze Map entries.

### Architectural Goals
1. Establish a clean, deterministic, fail-closed **Generic Worker Adapter Registry** boundary.
2. Formally seal the broker-facing contract (`WorkerPortV1`) to exactly the two methods actually used by the broker (`dispatch` and `wait`).
3. Maintain complete backward compatibility: preserve existing Antigravity adapter semantics and 100% of existing regression test coverage.
4. Guarantee fail-closed security invariants: exact engine matching, no fallbacks, no dynamic code loading, closure-private snapshot state.
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
  - Future capabilities only; zero lifecycle authority in WP08.
  - The broker core does not call them. Any future addition requires dedicated lifecycle state analysis, store schema review, and test coverage.
- **`status()`**:
  - Existing adapter-local helper on `createAntigravityWorkerPort`.
  - Carries zero broker semantic authority.
  - `broker.getWorkerStatus(projectId)` retrieves active state from `lifecycleStore.getActiveDispatch(projectId)`, not from the adapter.
- **`close()`**:
  - Not part of WorkerPortV1 in WP08.
  - Antigravity adapter has no persistent subagent processes requiring cleanup. Future engines requiring process management will define lifecycle cleanup at runtime level.

---

## 6. Adapter Registry Public Surface & Specification

### Factory Signature
```ts
function createWorkerAdapterRegistry(options = {}) {
  // options.adapters: Array<{ engine: string, adapter: WorkerPortV1 }>
  // returns: WorkerPortV1 facade ({ dispatch, wait })
}
```

### Public API Sealing (No Public Resolve)
The factory returns a facade exposing **strictly**:
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

No adapter instance lookup API is part of WP08. Engine resolution is private implementation plumbing.

### Registration Storage & Snapshot Immutability
1. **Closure-Private Lookup Structure**:
   - Internal storage uses a closure-private Map / dictionary, never exposed to callers.
   - No runtime mutation API (`register`, `unregister`) is provided.
2. **Snapshot at Construction**:
   - At construction time, the factory extracts and snapshots:
     - `engine`: exact string token
     - `adapter`: reference to the `WorkerPortV1` object
   - Subsequent mutation of the caller's `options.adapters` array (e.g. `push`, `pop`, `splice`), mutation of `entry.engine`, or replacement of `entry.adapter` has **zero effect** on engine resolution.
3. **No Reliance on `Object.freeze(Map)`**:
   - The design explicitly does not rely on `Object.freeze(new Map())`, which does not prevent Map mutation. Closure privacy provides complete encapsulation.
4. **Adapter Immutability Distinction**:
   - `registration mapping immutability ≠ deep immutability of adapter implementation state`.
   - Adapter instances may legitimately maintain internal mutable transport state (e.g. connections, timers, mock state).

### Construction Validation Rules
1. `options.adapters` must be a non-empty Array.
2. Every entry must be a plain object:
   - `entry.engine` must be a non-empty string with no leading or trailing whitespace (tokens with surrounding whitespace are rejected at construction).
   - `entry.adapter` must be an object.
   - `entry.adapter.dispatch` must be a function.
   - `entry.adapter.wait` must be a function.
3. Duplicate exact `engine` strings are rejected at construction with a descriptive Error.

---

## 7. Engine Authority & Validation Rules

When `dispatch` or `wait` is called on the registry-backed facade:

1. **Pre-flight Project Validation**:
   - `project` must be an object.
   - `project.project_id` must match `args.project_id`.
   - `project.worker` must be an object.
   - `project.worker.enabled` must be strictly `true`.
   - `project.worker.engine` must be a string matching a registered engine exactly.
2. **Exact Token Lookup**:
   - Lookup key is strictly `project.worker.engine`.
   - Matching is exact binary string equality (`===`).
   - No case folding (e.g. `Antigravity` or `ANTIGRAVITY` will fail).
   - No whitespace trimming at runtime (e.g. `"antigravity "` will fail).
   - No fuzzy matching, no regex matching, no alias resolution.
   - No fallback engine (zero fallback to Antigravity).
   - No caller, CLI, or directive overrides.

### Fail-Closed Dispatch Semantics
If engine resolution fails during `dispatch()`:
- Resolution happens **before** calling any adapter method.
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

### Fail-Closed Wait Semantics (Mandatory Correction)
In `broker.js` (lines 528-535), the broker's wait logic wraps `workerPort.wait` in a `try/catch` block:
```js
try {
  waitRes = await workerPort.wait({ ... });
} catch (err) {
  return {
    ok: false,
    code: ERROR_CODES.WORKER_WAIT_UNAVAILABLE,
    dispatch_id: request.dispatch_id,
    state: dispatch.state,
    error: err.message
  };
}
```
Therefore, when worker engine resolution fails during `wait()`:
1. The generic registry facade **MUST THROW** a local bounded Error before calling any adapter.
2. It **MUST NOT** return `{ ok: false, code: "WORKER_WAIT_UNAVAILABLE" }` (the broker does not interpret that return shape as `WORKER_WAIT_UNAVAILABLE`).
3. It **MUST NOT** return `{ definitive: true }` (which would trigger transition to `DISPATCH_FAILED`).
4. Required flow:
   ```text
   resolution failure
   → throw
   → broker catch boundary
   → WORKER_WAIT_UNAVAILABLE
   → zero lifecycle mutation
   ```

### Local Resolution Error Type & Bounded Diagnostics
- The registry module may define a local Error class (e.g. `WorkerAdapterResolutionError`) or local diagnostic code (e.g. `WORKER_ADAPTER_UNAVAILABLE`).
- It is NOT broker lifecycle authority, shared `ERROR_CODES`, or Registry schema authority. `contracts.js` is NOT modified.
- Error messages must be bounded and deterministic:
  - Default: `"Worker adapter unavailable"`
  - Must not echo unbounded arbitrary engine tokens, raw directives, environment data, full project descriptors, or session data.
  - No stack traces leaked through broker-facing return values.

### Result Transparency
For successfully resolved engines, return values from `adapter.dispatch` and `adapter.wait` are passed through transparently without rewriting or semantic interference.

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

In the planned WP-V4-08B implementation, `createBrokerRuntime` will compose components with exact precedence:

```text
if (options.workerPort) {
    workerPort = options.workerPort;
} else if (options.workerAdapterRegistry) {
    workerPort = options.workerAdapterRegistry;
} else {
    workerPort = createWorkerAdapterRegistry({
        adapters: [
            {
                engine: 'antigravity',
                adapter: createAntigravityWorkerPort(options.workerOptions || {})
            }
        ]
    });
}
```

### Precedence & Dependency Injection Invariants
1. `options.workerPort`: If explicitly provided by caller, the runtime uses it directly, bypassing registry creation entirely. This guarantees zero breaking changes for existing unit tests.
2. `options.workerAdapterRegistry`: An already-constructed `WorkerPortV1`-compatible registry facade (not registration configuration). Programmatic DI only, never exposed via CLI.
3. Precedence Rule: If both `options.workerPort` and `options.workerAdapterRegistry` are supplied, `options.workerPort` wins, and production registry construction must not occur.

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
   - Engine resolution failures produce consistent, bounded error shapes.
   - Stack traces are sanitized and never leaked to external control boundaries.

---

## 11. Planned WP-V4-08B Implementation Scope

For subsequent work order WP-V4-08B:

### Files to Create
- `pipeline-ui/lib/broker/worker-adapter-registry.js`: Pure factory implementing `createWorkerAdapterRegistry`.
- `pipeline-ui/test/refactor/worker-adapter-registry.test.js`: Comprehensive deterministic unit test suite.

### Files to Modify
- `pipeline-ui/lib/broker/runtime.js`: Integrate `createWorkerAdapterRegistry` into runtime composition, honoring DI precedence.
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

## 12. Corrected WP-V4-08B Test Matrix (`WREG`)

The implementation test suite will enforce the following minimum 24 deterministic cases:

| ID | Description | Assertion / Expected Behavior |
|---|---|---|
| **WREG-001** | Dispatch selects exact registered engine through delegation | Adapter's `dispatch()` called via facade delegation; no public resolve API required |
| **WREG-002** | Wait selects exact registered engine through delegation | Adapter's `wait()` called via facade delegation |
| **WREG-003** | Dispatch arguments preserved exactly | `project`, `project_id`, `work_order_id`, `dispatch_id`, `expected_workspace_state_id`, `directive` identical |
| **WREG-004** | Wait arguments preserved exactly | `project`, `project_id`, `work_order_id`, `dispatch_id`, `expected_workspace_state_id`, `timeout_secs` identical |
| **WREG-005** | Unknown engine fails closed on dispatch | Definitive dispatch failure, zero adapter call, zero fallback |
| **WREG-006** | Case-mismatched engine has zero fallback | Engine `"Antigravity"` or `"ANTIGRAVITY"` fails closed; adapter not called |
| **WREG-007** | Whitespace-mismatched runtime engine has zero fallback | Engine `"antigravity "` fails closed; adapter not called |
| **WREG-008** | Missing `project.worker` fails closed | Fails closed before adapter call |
| **WREG-009** | `worker.enabled !== true` fails closed | Fails closed before adapter call |
| **WREG-010** | `project.project_id !== args.project_id` fails closed | Rejected immediately before adapter call |
| **WREG-011** | Duplicate exact engine registration rejected at construction | Throws Error during `createWorkerAdapterRegistry` |
| **WREG-012** | Registration missing `dispatch` rejected at construction | Throws Error if `adapter.dispatch` is not a function |
| **WREG-013** | Registration missing `wait` rejected at construction | Throws Error if `adapter.wait` is not a function |
| **WREG-014** | Malformed/whitespace registration engine token rejected | Engine token with leading/trailing whitespace rejected at construction |
| **WREG-015** | Mutating original registration array after construction has no effect | Mapping remains unchanged |
| **WREG-016** | Mutating original `entry.engine` after construction has no effect | Mapping remains unchanged |
| **WREG-017** | Replacing original `entry.adapter` after construction has no effect | Mapping remains unchanged |
| **WREG-018** | Registry facade exposes no public resolution or mutation API | No `resolve`, `register`, `unregister`, `adapters`, `map` API |
| **WREG-019** | Successful dispatch result passes through unchanged | Full return object passed transparently |
| **WREG-020** | Successful wait result passes through unchanged | Full return object passed transparently |
| **WREG-021** | Wait resolution failure throws before adapter call | Throws bounded Error; broker maps to `WORKER_WAIT_UNAVAILABLE`; lifecycle state remains unchanged |
| **WREG-022** | Dispatch resolution failure is definitive | Broker maps through existing `DISPATCH_FAILED` semantics; zero adapter invocation |
| **WREG-023** | `options.workerPort` bypasses registry creation | If both `workerPort` and `workerAdapterRegistry` supplied, `workerPort` wins |
| **WREG-024** | `options.workerAdapterRegistry` used directly when `workerPort` absent | Default runtime composition otherwise registers Antigravity exactly once |

---

## 13. Antigravity Compatibility & Test Rules

1. **Adapter Ownership**:
   The existing Antigravity adapter retains complete ownership of AO session binding, AO CLI transport, dispatch envelope formatting, transcript parsing, identity verification, and `READY_FOR_REVIEW` detection. The generic registry must not inspect AO sessions or DB rows.
2. **Deterministic Mock Invariants for WP-V4-08B Tests**:
   Any test in WP08B utilizing the concrete `createAntigravityWorkerPort` must inject deterministic test dependencies:
   - Mock `spawnSync`
   - Mock `completionSource`
   - Temporary file paths
   - Mock `clock` / `sleep`
3. **Zero Real Worker Mutation**:
   - Real `ao send`: 0
   - Real AGY messages: 0
   - Real worker dispatch: 0
   - Real model turns: 0
4. Existing `WA-001 .. WA-055` remains the unchanged authority for Antigravity adapter behavior.

---

## 14. Future Full Regression Suite Gate

- **Current Baseline**: 16 deterministic test suites passing.
- **WP-V4-08B Addition**: `worker-adapter-registry.test.js` (minimum 24 `WREG` tests).
- **Target Suite Count**: 17 deterministic test suites passing.
- **Authoritative Preserved Baselines**:
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
  - `WREG`: >= 24

---

## 15. Explicit Out-of-Scope List

The following items are strictly out of scope for WP-V4-08:
1. **Implementation Code**: No production or test code is written in WO-V4-08A-R1.
2. **Registry Schema Changes**: No new engine types or model policy schemas in `registry.js`.
3. **Model Selection & Budgeting**: Model selection and token budgeting are reserved for WP-V4-12.
4. **Cancellation / Probing**: Cancellation semantics and probe protocols are not implemented.
5. **Real Worker Dispatches**: No real Antigravity messages or worker executions during WP-V4-08.

---

## 16. External Review & Approval Gate

This design document seals the technical specification of the Generic Worker Adapter Boundary Revision 1.

Before proceeding to WP-V4-08B implementation:
- The design must be reviewed and approved by the external operator.
- The parent commit must remain `5915c2123bdf9b173980a9d174d03ef0f3f83b00`.
- No implementation work may start until explicit authorization is received.

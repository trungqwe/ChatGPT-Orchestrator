# Uncertain Dispatch Reconciliation Design Seal (WO-V4-09C-U1)

## Document Metadata

```text
Work Order:               WO-V4-09C-U1
Status:                   DESIGN_SEALED
Repository:               D:/TU_CODE/Orchestrator
Branch:                   dev/v4-clean
Parent Commit:            66c54112b44ef1cec5fcc057738edbddc643eb08
Scope:                    DESIGN ONLY (Zero Source / Zero Real Mutation / Zero P2 Reconciliation / Zero P3)
Target Output File:       docs/refactor-v4-native-codex-relay/WO-V4-09C-UNCERTAIN-RECONCILIATION-DESIGN.md
```

---

## 1. Incident Authority & Context

During the execution of acceptance cycle **WP-V4-09C-P2**, the orchestrator initiated a fresh worker dispatch attempt against the target project `chatgpt-orchestrator` with work order `wp-v4-09c-readonly-worker-acceptance-002`.

The adapter invoked the worker transport (`ao.exe send`), which exited with transport failure:
```text
The agent process exited; relaunch it before sending another message (AGENT_EXITED) [request Admin/OlzvryaCFC-000297]
```

In conformance with the delivery acknowledgement contract (**WO-V4-09C-D1**), the broker transitioned the lifecycle to durable state:
```text
DISPATCH_UNCERTAIN
```

The subsequent read-only forensic diagnostic (**WO-V4-09C-P2-R1**) inspected the authoritative Antigravity transcript and established:
```text
project_id:                             chatgpt-orchestrator
work_order_id:                          wp-v4-09c-readonly-worker-acceptance-002
dispatch_id:                            D-4af7357f-d332-4e50-b64e-b716961f3424
durable state:                          DISPATCH_UNCERTAIN
diagnostic classification:              DELIVERY_UNPROVEN
authoritative exact dispatch boundaries: 0
contradictory current boundaries:       0
exact completions:                      0
```

### The Active-Lock Invariant
In `pipeline-ui/lib/broker/contracts.js`:
```javascript
const _ACTIVE_STATES_SET = new Set([
  DISPATCH_STATES.DISPATCHING,
  DISPATCH_ACCEPTED,
  DISPATCH_STATES.RUNNING,
  DISPATCH_STATES.DISPATCH_UNCERTAIN
]);
```

Because `DISPATCH_UNCERTAIN ∈ ACTIVE_STATES`:
1. The project `chatgpt-orchestrator` remains active-locked in `lifecycle.sqlite3`.
2. `getActiveDispatch('chatgpt-orchestrator')` returns the stalled P2 dispatch.
3. Any subsequent dispatch attempt against `chatgpt-orchestrator` is rejected with `WORKER_BUSY`.
4. Normal `waitWorker()` cannot wait on or clear `DISPATCH_UNCERTAIN`, because `DISPATCH_UNCERTAIN ∉ WAITABLE_STATES`.
5. Generic lifecycle transition authority defines:
   ```javascript
   [DISPATCH_STATES.DISPATCH_UNCERTAIN]: new Set([])
   ```
   Ordinary `lifecycleStore.transition(...)` rejects any transition out of `DISPATCH_UNCERTAIN`.

Without an authorized, dedicated reconciliation mechanism, the project is permanently wedged.

---

## 2. Design Goal & Semantic Boundaries

The primary design goal is to establish an explicit, narrow, operator-authorized reconciliation mechanism:
```text
DISPATCH_UNCERTAIN
       │
       ▼ (authorized reconciliation with evidence: DELIVERY_UNPROVEN)
PROVENANCE_AMBIGUOUS
```

### Critical Semantic Boundary: Non-Equivalence
```text
DELIVERY_UNPROVEN ≠ DISPATCH_FAILED
```

- **`DELIVERY_UNPROVEN`** means that an authorized external read-only forensic investigation examined the authoritative transcript and could not find an exact dispatch boundary record matching the dispatch identity. It proves that delivery cannot be authoritatively demonstrated. It **does NOT** prove that delivery definitively did not occur (e.g. transport packet arrived over IPC, but the agent crashed prior to disk serialization).
- **`DISPATCH_FAILED`** is a definitive claim that dispatch failed before worker engagement or was deterministically rejected. Claiming `DISPATCH_FAILED` when delivery is merely unproven is an invalid semantic overclaim. If an operator or automated supervisor were to infer `DISPATCH_FAILED`, it might assume the worker never ran and attempt an unverified replay, risking dirty-state contamination.
- **`PROVENANCE_AMBIGUOUS`** is the existing, semantically honest terminal lifecycle state representing unresolved delivery or execution provenance.

Therefore:
```text
DELIVERY_UNPROVEN → PROVENANCE_AMBIGUOUS
```

---

## 3. Preservation of the Existing Lifecycle State Enum

This design strictly preserves the existing lifecycle state enum in `contracts.js`:

```javascript
const DISPATCH_STATES = Object.freeze({
  DISPATCHING: 'DISPATCHING',
  DISPATCH_ACCEPTED: 'DISPATCH_ACCEPTED',
  RUNNING: 'RUNNING',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  DISPATCH_UNCERTAIN: 'DISPATCH_UNCERTAIN',
  PROVENANCE_AMBIGUOUS: 'PROVENANCE_AMBIGUOUS'
});
```

The design **MUST NOT** introduce new lifecycle states such as:
- `DELIVERY_UNPROVEN`
- `RECONCILED`
- `ABANDONED`
- `CANCELLED`

`PROVENANCE_AMBIGUOUS` is already a recognized terminal state (`TERMINAL_STATES`). Reusing it maintains database schema stability, simplifies downstream audit consumers, and preserves state machine compactness.

---

## 4. Generic Lifecycle Transition Remains Sealed

The generic transition map in `pipeline-ui/lib/broker/contracts.js` defines:
```javascript
const _ALLOWED_TRANSITIONS_MAP = Object.freeze({
  ...
  [DISPATCH_STATES.READY_FOR_REVIEW]: new Set([]),
  [DISPATCH_STATES.DISPATCH_FAILED]: new Set([]),
  [DISPATCH_STATES.PROVENANCE_AMBIGUOUS]: new Set([]),
  [DISPATCH_STATES.DISPATCH_UNCERTAIN]: new Set([])
});
```

### Invariant
`_ALLOWED_TRANSITIONS_MAP[DISPATCH_STATES.DISPATCH_UNCERTAIN]` **MUST REMAIN EMPTY**.

### Rationale
Ordinary `lifecycleStore.transition(dispatchId, nextState, patch)` is used by automated runtime cycles (`broker.js`, `one-shot-cycle.js`).

Uncertainty reconciliation requires:
1. An explicit operator authority command.
2. Separate, external forensic evidence confirming `DELIVERY_UNPROVEN`.
3. Bounded identity verification.

Allowing `DISPATCH_UNCERTAIN → PROVENANCE_AMBIGUOUS` via generic `transition()` would permit runtime automation to bypass forensic review and silently clear uncertainty locks. Therefore, generic `transition()` must continue to throw or return `ILLEGAL_STATE_TRANSITION` if invoked on `DISPATCH_UNCERTAIN`.

---

## 5. Dedicated Lifecycle Store Reconciliation API

Reconciliation must be exposed exclusively via a dedicated method on lifecycle store instances, separate from `transition()`, `beginDispatch()`, and broker operations.

### API Signature
```javascript
store.reconcileUncertainDispatch(authority);
```

### Store Implementation Parity
The method must be implemented with strictly identical semantics across both stores:
1. **`pipeline-ui/lib/broker/lifecycle-store.js`** (`createMemoryLifecycleStore`): Reference volatile implementation used for deterministic unit and integration tests.
2. **`pipeline-ui/lib/broker/sqlite-lifecycle-store.js`** (`createSqliteLifecycleStore`): Authoritative production durable implementation backed by SQLite.

---

## 6. Required Input Authority & Identity Bounding

To prevent operator error, stale mutations, or fuzzy matching against the wrong dispatch, `reconcileUncertainDispatch` requires an explicit, fully bound authority object:

```javascript
const authority = {
  dispatch_id: 'D-4af7357f-d332-4e50-b64e-b716961f3424',
  project_id: 'chatgpt-orchestrator',
  work_order_id: 'wp-v4-09c-readonly-worker-acceptance-002',
  expected_state: 'DISPATCH_UNCERTAIN',
  target_state: 'PROVENANCE_AMBIGUOUS',
  classification: 'DELIVERY_UNPROVEN',
  evidence_authority: 'WP-V4-09C-P2-R1'
};
```

### Exact Input Validation Rules
The store method must validate each field prior to modifying state:

| Field | Validation Constraint | Failure Outcome |
|---|---|---|
| `authority` | Must be a non-null, non-array object | `INVALID_REQUEST` |
| `dispatch_id` | Must be a non-empty string | `INVALID_REQUEST` |
| `project_id` | Must be a non-empty string | `INVALID_REQUEST` |
| `work_order_id` | Must be a non-empty string | `INVALID_REQUEST` |
| `expected_state` | Must strictly equal `DISPATCH_STATES.DISPATCH_UNCERTAIN` | `ILLEGAL_STATE_TRANSITION` |
| `target_state` | Must strictly equal `DISPATCH_STATES.PROVENANCE_AMBIGUOUS` | `ILLEGAL_STATE_TRANSITION` |
| `classification` | Must strictly equal `'DELIVERY_UNPROVEN'` | `INVALID_REQUEST` |
| `evidence_authority` | Must be a non-empty string | `INVALID_REQUEST` |

### Zero Fuzzy Lookup Rule
The operation queries strictly by `dispatch_id`.
- If the dispatch does not exist: returns `DISPATCH_NOT_FOUND`.
- If `row.project_id !== authority.project_id`: returns `PROJECT_IDENTITY_MISMATCH`.
- If `row.work_order_id !== authority.work_order_id`: returns `DUPLICATE_WORK_ORDER_CONFLICT` (or identity conflict).
- No fallback to "latest dispatch for project".
- No implicit state derivation.

---

## 7. Allowed Target State Constraints

For `reconcileUncertainDispatch`, the **ONLY** initially authorized target state is:
```text
DISPATCH_STATES.PROVENANCE_AMBIGUOUS
```

All other target states are explicitly rejected:
```text
DISPATCH_UNCERTAIN -> RUNNING               [REJECTED]
DISPATCH_UNCERTAIN -> DISPATCH_ACCEPTED     [REJECTED]
DISPATCH_UNCERTAIN -> READY_FOR_REVIEW      [REJECTED]
DISPATCH_UNCERTAIN -> DISPATCH_FAILED       [REJECTED]
```

Any attempt to specify a target state other than `PROVENANCE_AMBIGUOUS` fails closed with:
```javascript
{
  ok: false,
  code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
  error: "Target state '...' is not authorized for uncertain dispatch reconciliation"
}
```

---

## 8. Evidence Classification Contract

The reconciliation operation accepts only the sealed evidence classification:
```text
DELIVERY_UNPROVEN
```

### Contractual Definition
- Classification `DELIVERY_UNPROVEN` certifies that an authorized forensic investigation (referenced by `evidence_authority`) inspected the worker session transcript and observed **0 authoritative exact dispatch boundaries**.
- It does **not** assert that the worker never received the payload or that no side effects occurred.
- Any unrecognized classification (e.g. `'NOT_DELIVERED'`, `'WORKER_CRASHED'`, `'TIMEOUT'`) is rejected immediately with `INVALID_REQUEST`.

---

## 9. Durable History & Dispatch Semantics

A successful reconciliation execution must guarantee the following durable effects:

1. **Dispatch Table Row Count**: Exactly unchanged. No new dispatch row is created.
2. **Dispatch State Mutation**:
   - `state` becomes `PROVENANCE_AMBIGUOUS`.
   - `updated_at` becomes current ISO timestamp (`clock.iso()`).
3. **Dispatch Error Preservation**:
   - The original `error` field is **preserved byte-for-byte**. It is not cleared, not nullified, and not overwritten.
4. **Dispatch Diagnostics Persistence**:
   - `diagnostics` is updated to record the bounded structured reconciliation metadata:
     ```json
     {
       "reconciliation": {
         "classification": "DELIVERY_UNPROVEN",
         "evidence_authority": "WP-V4-09C-P2-R1",
         "reconciled_at": "2026-09-22T02:00:00.000Z"
       }
     }
     ```
   - If pre-existing diagnostics were present, the `reconciliation` object is merged into the existing diagnostics dictionary.
5. **History Table Append**:
   - Exactly one history row is appended (`history +1`).
   - Fields:
     - `project_id`: matching dispatch project
     - `dispatch_id`: matching dispatch ID
     - `work_order_id`: matching work order ID
     - `previous_state`: `DISPATCH_UNCERTAIN`
     - `next_state`: `PROVENANCE_AMBIGUOUS`
     - `timestamp`: current integer milliseconds (`clock.now()`)
     - `iso`: current ISO timestamp (`clock.iso()`)
     - `patch`: serialized object:
       ```json
       {
         "diagnostics": {
           "reconciliation": {
             "classification": "DELIVERY_UNPROVEN",
             "evidence_authority": "WP-V4-09C-P2-R1",
             "reconciled_at": "2026-09-22T02:00:00.000Z"
           }
         }
       }
       ```
6. **Active-Lock Release**:
   - Because `PROVENANCE_AMBIGUOUS ∈ TERMINAL_STATES` and `PROVENANCE_AMBIGUOUS ∉ ACTIVE_STATES`, the project is released from the active dispatch index.

### Metadata Bounding Invariants
- **No Raw Transcript Blobs**: Transcripts, logs, or multi-line output must never be placed into diagnostics or history patch.
- **No Thread / Session IDs**: Volatile transport or worker session identifiers must not be leaked into durable reconciliation metadata.
- **No Arbitrary Prose**: Bounded to standard keys (`classification`, `evidence_authority`, `reconciled_at`).

---

## 10. Original Transport Error Preservation

In cycle P2, the dispatch record recorded:
```text
error: "The agent process exited; relaunch it before sending another message (AGENT_EXITED) [request Admin/OlzvryaCFC-000297]"
```

Reconciliation **MUST NOT** overwrite `error`.

The terminal record preserves both distinct dimensions of operational truth:
1. **Transport Outcome**: Preserved in `dispatch.error` (`AGENT_EXITED`).
2. **Forensic Provenance**: Recorded in `dispatch.diagnostics.reconciliation` and `history.patch` (`DELIVERY_UNPROVEN` via `WP-V4-09C-P2-R1`).

---

## 11. Atomic SQLite Transaction Contract

In `sqlite-lifecycle-store.js`, reconciliation must execute within an atomic transaction:

```sql
BEGIN IMMEDIATE
```

### Step-by-Step Transaction Execution Flow
```text
1. BEGIN IMMEDIATE
2. Re-read dispatch row by dispatch_id:
   SELECT * FROM dispatches WHERE dispatch_id = ?
3. If row not found:
   -> ROLLBACK
   -> Return { ok: false, code: ERROR_CODES.DISPATCH_NOT_FOUND }
4. Validate identity:
   - row.project_id === authority.project_id (if not -> ROLLBACK, return PROJECT_IDENTITY_MISMATCH)
   - row.work_order_id === authority.work_order_id (if not -> ROLLBACK, return DUPLICATE_WORK_ORDER_CONFLICT)
5. Evaluate current state:
   a. If row.state === DISPATCH_STATES.PROVENANCE_AMBIGUOUS:
      - Evaluate idempotent replay (Section 13)
      - If valid replay -> ROLLBACK (or COMMIT no-op), return { ok: true, reconciled: false, idempotent_replay: true, dispatch }
      - If invalid replay -> ROLLBACK, return ILLEGAL_STATE_TRANSITION
   b. If row.state !== DISPATCH_STATES.DISPATCH_UNCERTAIN:
      -> ROLLBACK
      -> Return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, currentState: row.state, expectedState: DISPATCH_UNCERTAIN }
6. Prepare new diagnostics:
   - Parse existing row.diagnostics (if present)
   - Merge { reconciliation: { classification: authority.classification, evidence_authority: authority.evidence_authority, reconciled_at: nowIso } }
   - Serialize via v8.serialize
7. Update dispatches:
   UPDATE dispatches
   SET state = 'PROVENANCE_AMBIGUOUS',
       updated_at = nowIso,
       diagnostics = newDiagBlob
   WHERE dispatch_id = dispatch_id
   (error column remains untouched)
8. Insert exactly one history row:
   INSERT INTO history (
     project_id, dispatch_id, work_order_id,
     previous_state, next_state,
     timestamp, iso, patch
   ) VALUES (?, ?, ?, 'DISPATCH_UNCERTAIN', 'PROVENANCE_AMBIGUOUS', nowTs, nowIso, patchBlob)
9. COMMIT
10. Return { ok: true, reconciled: true, idempotent_replay: false, dispatch: rowToDispatch(updatedRow) }
```

On any caught exception:
```text
ROLLBACK
Re-throw or return structured LIFECYCLE_STORE_FAILURE
```

Ad-hoc raw SQL scripts executed directly against `lifecycle.sqlite3` from PowerShell or external tools are **strictly forbidden**. All reconciliation must execute through the audited store API.

---

## 12. Active Index Semantics

In `sqlite-lifecycle-store.js`, the active dispatch invariant is enforced by:
```sql
CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id)
WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN')
```

### Pre-Reconciliation Authority
```text
store.getActiveDispatch('chatgpt-orchestrator')
  → returns P2 dispatch (state: DISPATCH_UNCERTAIN)
```

### Post-Reconciliation Authority
When state is updated to `PROVENANCE_AMBIGUOUS`:
1. SQLite automatically drops the row from the partial index `idx_active_project` because `PROVENANCE_AMBIGUOUS` is excluded from the `WHERE state IN (...)` predicate.
2. When `store.getActiveDispatch('chatgpt-orchestrator')` executes:
   ```javascript
   for (const row of projectRows) {
     if (isActiveState(row.state)) { ... }
   }
   ```
   `isActiveState('PROVENANCE_AMBIGUOUS')` evaluates to `false`.
3. The store returns `null`.
4. In `createMemoryLifecycleStore`:
   ```javascript
   if (activeDispatchByProject.get(record.project_id) === dispatchId) {
     activeDispatchByProject.delete(record.project_id);
   }
   ```
5. In both stores, active dispatch authority becomes `null`, releasing the project cleanly for future dispatches.

---

## 13. Replay Safety & Idempotence

Operator procedures may accidentally trigger a reconciliation script multiple times. The reconciliation API must be strictly idempotent and replay-safe.

### Semantics

#### First Invocation (Actual Mutation)
- State: `DISPATCH_UNCERTAIN → PROVENANCE_AMBIGUOUS`
- Dispatch row count: unchanged
- History row count: `+1`
- Diagnostics: reconciliation metadata persisted
- Return:
  ```javascript
  {
    ok: true,
    reconciled: true,
    idempotent_replay: false,
    dispatch: { ... }
  }
  ```

#### Second Identical Invocation (Idempotent Replay)
- Inputs match identical `dispatch_id`, `project_id`, `work_order_id`, `classification`, and `evidence_authority`.
- Current state in DB is already `PROVENANCE_AMBIGUOUS`.
- Diagnostics already contain matching reconciliation classification and evidence authority.
- Action:
  - **ZERO state mutation**
  - **ZERO new history rows** (`history +0`)
  - **ZERO diagnostic overwrite**
- Return:
  ```javascript
  {
    ok: true,
    reconciled: false,
    idempotent_replay: true,
    dispatch: { ... }
  }
  ```

#### Non-Identical Replay (Conflict / Illegal State)
- If current state is `PROVENANCE_AMBIGUOUS` but `classification` or `evidence_authority` contradicts existing diagnostics, or if the dispatch was not reconciled via this path (e.g. wait timeout):
  - Fails closed: returns `ILLEGAL_STATE_TRANSITION`.
  - Zero mutation.

---

## 14. Concurrency & Race Safety

If another process or transaction modifies the dispatch record between operator preflight inspection and SQLite transaction execution:

```text
Operator Preflight: observes DISPATCH_UNCERTAIN
       │
       ▼ (race / concurrent process modifies state)
Transaction: BEGIN IMMEDIATE -> reads state
       │
       ▼ (current state is no longer DISPATCH_UNCERTAIN)
Fail Closed: ROLLBACK -> ILLEGAL_STATE_TRANSITION
```

- SQLite transaction-time state is the sole authority.
- Preflight evidence carries zero authority inside the database transaction.
- Stale or drifted state fails closed immediately without modifying any row.

---

## 15. Broker & Automated Cycle Isolation

The reconciliation API is an out-of-band operator recovery mechanism.

### Strict Prohibition
No normal broker or runtime method may invoke `reconcileUncertainDispatch`.

Specifically, automatic reconciliation **MUST NOT** be added to:
- `broker.dispatchWorker()`
- `broker.waitWorker()`
- `broker.getWorkerStatus()`
- `broker.runOneShotCycle()`
- `broker.runtime.js`
- `relay/one-shot-cycle.js`

An uncertain dispatch must remain locked until an operator separately evaluates forensic evidence and explicitly initiates reconciliation.

---

## 16. Operator Surface Selection

Two operator surfaces were evaluated:

```text
Option 1: Dedicated production lifecycle-store API invoked by a bounded operator script
Option 2: Dedicated reconciliation CLI with exact identity/evidence gates
```

### Selected Design: Option 1
**Dedicated production lifecycle-store API invoked by a bounded operator script.**

### Architectural Justification
1. **Minimal Attack Surface**: Keeping the reconciliation surface at the store API level prevents unauthorized invocations via public CLI arguments or ambient command-line interfaces.
2. **Complete Isolation from Automation**: CLI flags or broker options risk accidental integration into automated shell runners. A bounded operator script (analogous to the verified pattern in `WO-V4-09C-RC1`) requires deliberate operator execution with hardcoded, audited constants.
3. **Deterministic Programmatic Guarding**: The script imports `createSqliteLifecycleStore`, passes the exact required authority object, validates the returned `reconciled === true` or `idempotent_replay === true`, verifies active lock release, and closes the store.
4. **Consistency with V4 Recovery Patterns**: Audited operator maintenance tasks in V4 (such as P1 reconciliation) rely on bounded scripts rather than general-purpose multi-tenant CLI commands.

---

## 17. Deterministic Test Matrix (UR-001..UR-016)

The subsequent implementation work order must implement and verify the following deterministic test cases across both memory and SQLite stores:

| Test ID | Scenario | Expected Behavior |
|---|---|---|
| **UR-001** | `DISPATCH_UNCERTAIN + DELIVERY_UNPROVEN` | Transitions state to `PROVENANCE_AMBIGUOUS`. Returns `{ ok: true, reconciled: true, idempotent_replay: false }`. |
| **UR-002** | Row count & history count invariant | Dispatch table row count unchanged. History table row count increments by exactly 1 (`+1`). |
| **UR-003** | Active lock release | Prior to call, `getActiveDispatch(project)` returns the dispatch. After call, `getActiveDispatch(project)` returns `null`. |
| **UR-004** | Generic `transition()` remains sealed | Calling `store.transition(dispatchId, 'PROVENANCE_AMBIGUOUS')` on `DISPATCH_UNCERTAIN` is rejected with `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-005** | Wrong `project_id` rejected | Passing mismatched `project_id` returns `PROJECT_IDENTITY_MISMATCH`. Zero mutation, zero history append. |
| **UR-006** | Wrong `work_order_id` rejected | Passing mismatched `work_order_id` returns `DUPLICATE_WORK_ORDER_CONFLICT` (or identity conflict). Zero mutation. |
| **UR-007** | Wrong current state rejected | Calling against dispatch in `DISPATCH_ACCEPTED`, `RUNNING`, or `READY_FOR_REVIEW` returns `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-008** | Unsupported target state rejected | Passing `target_state: 'DISPATCH_FAILED'` or `'RUNNING'` returns `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-009** | Unsupported classification rejected | Passing `classification: 'NOT_DELIVERED'` or `'AGENT_CRASH'` returns `INVALID_REQUEST`. Zero mutation. |
| **UR-010** | Original transport error preserved | The original `error` string (`AGENT_EXITED...`) remains intact in the dispatch record and is not overwritten or cleared. |
| **UR-011** | Reconciliation metadata durability | `diagnostics.reconciliation` contains `classification`, `evidence_authority`, `reconciled_at`. `history.patch.diagnostics` matches. |
| **UR-012** | Identical replay safety | Second call with identical authority returns `{ ok: true, reconciled: false, idempotent_replay: true }`. Zero DB mutation, zero history append. |
| **UR-013** | SQLite store reopen durability | Closing and reopening SQLite store verifies `state === 'PROVENANCE_AMBIGUOUS'`, diagnostics durable, error intact, history count intact. |
| **UR-014** | Memory lifecycle store parity | All reconciliation validations and state transformations pass identically in `createMemoryLifecycleStore()`. |
| **UR-015** | Transaction race / state drift | If state changes concurrently prior to transaction commit, fails closed with `ROLLBACK`. |
| **UR-016** | Zero worker / AO / Codex side effects | Reconciliation executes strictly within the lifecycle store. Zero network, CLI, or subprocess calls. |

---

## 18. P2 Real Reconciliation Protocol

Following formal review and approval of this design and its subsequent implementation:

1. **Design Scope Constraint**:
   Work Order `WO-V4-09C-U1` is strictly **DESIGN-ONLY**. It executes **ZERO** lifecycle mutations on `lifecycle.sqlite3`.
2. **Future Real Reconciliation Work Order**:
   A dedicated real-state reconciliation work order (e.g. `WO-V4-09C-P2-RC`) will be authorized to reconcile the stalled P2 dispatch:
   ```text
   dispatch_id:         D-4af7357f-d332-4e50-b64e-b716961f3424
   project_id:          chatgpt-orchestrator
   work_order_id:       wp-v4-09c-readonly-worker-acceptance-002
   transition:          DISPATCH_UNCERTAIN -> PROVENANCE_AMBIGUOUS
   evidence_authority:  WP-V4-09C-P2-R1
   classification:      DELIVERY_UNPROVEN
   ```
3. **Execution Safety**:
   The reconciliation work order will invoke `store.reconcileUncertainDispatch(...)` via a single-run bounded Node.js script and verify that `getActiveDispatch('chatgpt-orchestrator')` returns `null`.

---

## 19. P3 Acceptance Gate

Real acceptance execution of **P3** remains strictly **FORBIDDEN** until all four prerequisite gates are satisfied:

```text
┌────────────────────────────────────────────────────────┐
│ Gate 1: U1 Reconciliation Design                       │
│ Status: APPROVED_CLOSED (Current Work Order)           │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Gate 2: Reconciliation Implementation                  │
│ Status: PENDING (Dedicated Work Order + Test Matrix)   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Gate 3: Real P2 Lifecycle Reconciliation               │
│ Status: PENDING (Clear P2 Active Lock in SQLite)       │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Gate 4: Antigravity Worker Transport Readiness         │
│ Status: PENDING (Root Cause & Session Readiness Proven)│
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
                 AUTHORIZED FOR P3
```

### Transport Readiness Invariant
Clearing the lifecycle lock on `chatgpt-orchestrator` merely resolves state store bookkeeping. It **DOES NOT** prove that the Antigravity worker session is healthy or capable of receiving messages.

The `AGENT_EXITED` failure observed in P2 must be investigated and resolved under separate authority before initiating any new real dispatch attempt in P3.

---

## 20. Required Design Decisions Summary (A through O)

### Decision A: Why PROVENANCE_AMBIGUOUS is correct for DELIVERY_UNPROVEN
`DELIVERY_UNPROVEN` establishes only that no delivery boundary could be found in the transcript; it does not prove delivery definitely failed. `PROVENANCE_AMBIGUOUS` is the exact existing lifecycle state designed for ambiguous provenance. It accurately reflects historical reality without overclaiming failure.

### Decision B: Why DISPATCH_FAILED is not justified
`DISPATCH_FAILED` asserts definitive dispatch failure. Overclaiming `DISPATCH_FAILED` when delivery is merely unproven could lead downstream supervisors to perform unsafe, unverified replays.

### Decision C: Why generic transition() must remain sealed
Generic `transition()` is the automated runtime transition mechanism. Permitting automated transitions out of `DISPATCH_UNCERTAIN` would bypass required forensic review. `_ALLOWED_TRANSITIONS_MAP[DISPATCH_UNCERTAIN]` must remain empty.

### Decision D: Exact dedicated reconciliation API
`store.reconcileUncertainDispatch(authority)` implemented on both memory and SQLite stores, completely isolated from `transition()`, `beginDispatch()`, and `broker`.

### Decision E: Exact identity/evidence inputs
A single bounded object binding `dispatch_id`, `project_id`, `work_order_id`, `expected_state: 'DISPATCH_UNCERTAIN'`, `target_state: 'PROVENANCE_AMBIGUOUS'`, `classification: 'DELIVERY_UNPROVEN'`, and `evidence_authority: string`. Fails closed on any mismatch, missing field, or fuzzy lookup.

### Decision F: SQLite atomic transaction semantics
Executed within `BEGIN IMMEDIATE`. Re-reads row, validates identity, evaluates replay, updates state, writes diagnostics, preserves error, appends exactly one history row, and commits. Rolls back on any error.

### Decision G: Active-lock release semantics
Transitioning to terminal state `PROVENANCE_AMBIGUOUS` automatically drops the row from the partial index `idx_active_project` and causes `getActiveDispatch()` to return `null`, releasing the active lock cleanly.

### Decision H: Original transport error preservation
The `error` column containing `AGENT_EXITED` is left untouched byte-for-byte. Reconciliation metadata is written exclusively to `diagnostics` and `history.patch`.

### Decision I: Reconciliation metadata persistence
Persisted in **BOTH** `dispatch.diagnostics` and `history.patch` using bounded structured JSON (`classification`, `evidence_authority`, `reconciled_at`). No raw transcripts or arbitrary prose.

### Decision J: Replay/idempotence behavior
First call updates state and appends 1 history row. Second identical call detects that the row is already reconciled with matching metadata and returns `{ ok: true, reconciled: false, idempotent_replay: true }` with zero state mutation and no second history row.

### Decision K: Race/state-drift behavior
If state changes concurrently between preflight and transaction, transaction re-read detects the mismatch and rolls back with `ILLEGAL_STATE_TRANSITION`. Transaction-time database state is sole authority.

### Decision L: Operator invocation boundary
Option 1: Dedicated production lifecycle store API invoked by a bounded operator script. Bounded to audited Node.js execution, eliminating generic broker/CLI exposure.

### Decision M: Deterministic test matrix
Cases UR-001 through UR-016 covering success, invariants, active lock release, generic seal, input validation, error preservation, replay safety, durability, and store parity.

### Decision N: P2 real reconciliation protocol
A future dedicated work order will execute `reconcileUncertainDispatch` against P2 dispatch `D-4af7357f-d332-4e50-b64e-b716961f3424` using forensic authority `WP-V4-09C-P2-R1`. U1 performs zero mutation.

### Decision O: P3 gating
P3 is strictly gated behind U1 design approval, reconciliation implementation, real P2 reconciliation, and separate proof of Antigravity transport readiness (`AGENT_EXITED` root cause resolution).

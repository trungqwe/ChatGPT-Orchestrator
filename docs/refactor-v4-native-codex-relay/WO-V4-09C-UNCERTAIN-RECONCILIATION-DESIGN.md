# Uncertain Dispatch Reconciliation Design Seal (WO-V4-09C-U1)

## Document Metadata

```text
Work Order:               WO-V4-09C-U1 (sealed via WO-V4-09C-U1-R1, WO-V4-09C-U1-R2)
Status:                   DESIGN_SEALED (EXTERNAL_REVIEW_PENDING)
Repository:               D:/TU_CODE/Orchestrator
Branch:                   dev/v4-clean
Parent Commit:            ab75f21de9a837c9dd2506411d0cfafead2563d7
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
  DISPATCH_STATES.DISPATCH_ACCEPTED,
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

## 5. Dedicated Lifecycle Store Reconciliation API & Plain Data Object Helper

Reconciliation must be exposed exclusively via a dedicated method on lifecycle store instances, separate from `transition()`, `beginDispatch()`, and broker operations.

### API Signature
```javascript
store.reconcileUncertainDispatch(authority);
```

### Store Implementation Parity
The method must be implemented with strictly identical semantics across both stores:
1. **`pipeline-ui/lib/broker/lifecycle-store.js`** (`createMemoryLifecycleStore`): Reference volatile implementation used for deterministic unit and integration tests.
2. **`pipeline-ui/lib/broker/sqlite-lifecycle-store.js`** (`createSqliteLifecycleStore`): Authoritative production durable implementation backed by SQLite.

### Authoritative Plain-Data Object Helper
Because SQLite diagnostics and history patches are reconstructed via `v8.deserialize`, deserialized objects may include instances of `Date`, `Map`, `Set`, `RegExp`, class instances, or objects with custom prototypes. Defining a plain object simply as `typeof d === 'object' && d !== null && !Array.isArray(d)` is dangerously permissive.

Both stores and all validation boundaries must use one exact helper semantic:

```javascript
function isPlainDataObject(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return (
    proto === Object.prototype ||
    proto === null
  );
}
```

This helper is authoritative for:
- Reconciliation input `authority` object validation
- Memory-store diagnostics validation
- SQLite-store persisted diagnostics validation
- Replay diagnostics validation
- Replay history patch validation

---

## 6. Required Input Authority & Finite Validation Bounds

To prevent operator error, stale mutations, or fuzzy matching against the wrong dispatch, `reconcileUncertainDispatch` requires an explicit, fully bound authority object with finite bounds:

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

### Exact Authority Object Shape Constraints
The authority argument must be a valid plain data object (`isPlainDataObject(authority)` with `Object.prototype` or `null` prototype).

It must have **EXACTLY** the seven required own enumerable string keys:
1. `dispatch_id`
2. `project_id`
3. `work_order_id`
4. `expected_state`
5. `target_state`
6. `classification`
7. `evidence_authority`

The store must reject with `{ ok: false, code: ERROR_CODES.INVALID_REQUEST, error: "..." }` and perform **ZERO** mutation if:
- `authority` is not a plain data object (`isPlainDataObject(authority)` is `false`).
- Any required key is missing.
- Any unexpected extra key is present (`Object.keys(authority).length !== 7`).
- Any Symbol property exists (`Object.getOwnPropertySymbols(authority).length > 0`).
- Any property has a getter or setter accessor (`Object.getOwnPropertyDescriptors(authority)` contains accessors; validation must check descriptors without invoking getters).
- Any property is non-enumerable.

### Exact Field-Level Finite Validation Rules
The store method must validate each field prior to evaluating database state or modifying records:

| Field | Finite Validation Constraints | Failure Code |
|---|---|---|
| `dispatch_id` | Non-empty string, trim-exact (`s.trim() === s`), no ASCII control chars (`/[\x00-\x1F\x7F]/`), UTF-8 byte length `<= 512` | `INVALID_REQUEST` |
| `project_id` | Non-empty string matching regex `^[a-z0-9][a-z0-9._-]{0,127}$` | `INVALID_REQUEST` |
| `work_order_id` | Non-empty string, trim-exact (`s.trim() === s`), no ASCII control chars (`/[\x00-\x1F\x7F]/`), UTF-8 byte length `<= 512` | `INVALID_REQUEST` |
| `expected_state` | Must strictly equal `DISPATCH_STATES.DISPATCH_UNCERTAIN` | `ILLEGAL_STATE_TRANSITION` |
| `target_state` | Must strictly equal `DISPATCH_STATES.PROVENANCE_AMBIGUOUS` | `ILLEGAL_STATE_TRANSITION` |
| `classification` | Must strictly equal `'DELIVERY_UNPROVEN'` | `INVALID_REQUEST` |
| `evidence_authority` | Non-empty string, trim-exact (`s.trim() === s`), single-line (no newline/CR), no ASCII control chars, UTF-8 byte length `<= 512` | `INVALID_REQUEST` |

Any validation violation fails closed with `{ ok: false, code: <CODE>, error: "<reason>" }` and executes **ZERO** mutations.

### Identity Evaluation Error Codes
The operation queries strictly by `dispatch_id`. No fuzzy lookup, no "latest dispatch" fallback:
- If the dispatch does not exist in store:
  ```javascript
  { ok: false, code: ERROR_CODES.DISPATCH_NOT_FOUND, error: "Dispatch '...' not found" }
  ```
- If `row.project_id !== authority.project_id`:
  ```javascript
  { ok: false, code: ERROR_CODES.PROJECT_IDENTITY_MISMATCH, error: "Project identity mismatch: ..." }
  ```
- If `row.work_order_id !== authority.work_order_id`:
  ```javascript
  { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: "Work order mismatch: ..." }
  ```

No new error codes are introduced in `contracts.js`. The existing structured enum is preserved.

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

## 8. Evidence Classification Contract & DELIVERY_UNPROVEN Definition

The reconciliation operation accepts only the sealed evidence classification:
```text
DELIVERY_UNPROVEN
```

### Exact Definition
`DELIVERY_UNPROVEN` requires:
```text
exact_dispatch_boundaries === 0
AND
contradictory_current_boundaries === 0
```

- **Exact dispatch boundary count** must be strictly `0` in the authoritative session transcript.
- **Contradictory current boundary count** must be strictly `0`.
- Completion count may be recorded by forensic work, but is not sufficient to establish delivery.

### Strict Non-Contradiction Invariant
```text
If contradictory_current_boundaries > 0, classification is NOT DELIVERY_UNPROVEN.
```
If any contradictory current dispatch boundaries are observed (records claiming the current `dispatch_id` but with mismatched control fields such as `project_id`, `work_order_id`, or `expected_workspace_state_id`), the forensic state represents an active provenance conflict. Such evidence cannot use this reconciliation path and requires separate provenance-conflict investigation.

Any unrecognized classification (e.g. `'NOT_DELIVERED'`, `'WORKER_CRASHED'`, `'TIMEOUT'`) is rejected immediately with `INVALID_REQUEST`.

---

## 9. Durable History & Dispatch Semantics

### Clock Snapshot Rule
Exactly once per actual reconciliation execution, the store generates:
```javascript
const nowIso = clock.iso();
const nowTs = clock.now();
```

The single snapshot `nowIso` is reused across all fields:
- `dispatch.updated_at`
- `diagnostics.reconciliation.reconciled_at`
- `history.iso`
- `history.patch.diagnostics.reconciliation.reconciled_at`

No second `clock.iso()` call is permitted within the same mutation.
Idempotent replay does **not** invoke the mutation clock and does **not** rewrite timestamps.

### Persisted Diagnostics Shape & Merge Rules
Before reconciliation mutation, the store inspects `row.diagnostics`:
1. If diagnostics is absent or SQL `NULL`: `base = {}`.
2. If `isPlainDataObject(row.diagnostics)` is `true`:
   - Accept plain object with `Object.prototype` or `null` prototype.
   - Preserve all existing keys (`...base`).
3. If diagnostics is non-null and `isPlainDataObject(row.diagnostics)` is `false`:
   - Array: **CORRUPTION / THROW**
   - Date: **CORRUPTION / THROW**
   - Map: **CORRUPTION / THROW**
   - Set: **CORRUPTION / THROW**
   - RegExp: **CORRUPTION / THROW**
   - Class instance / custom prototype: **CORRUPTION / THROW**
   - Primitive (string, number, boolean): **CORRUPTION / THROW**
   - `ROLLBACK` active transaction.
   - `throw new Error("Lifecycle store corruption: malformed diagnostics in dispatch '...'")`.
   - **ZERO mutation**. Do not coerce, do not use `Object.fromEntries`, do not convert via JSON serialization, and do not replace malformed diagnostics with `{}`.

### Reconciliation-Key Collision Rule
- **Under current state `DISPATCH_UNCERTAIN`**:
  If the existing plain diagnostics object already has own property `reconciliation` (`Object.hasOwn(base, 'reconciliation')`):
  - **FAIL CLOSED**: persisted-authority inconsistency.
  - `ROLLBACK` active transaction.
  - `throw new Error("Lifecycle store corruption: dispatch '...' in DISPATCH_UNCERTAIN already contains reconciliation metadata")`.
  - Pre-existing reconciliation metadata must never be silently overwritten.

- **Under current state `PROVENANCE_AMBIGUOUS`**:
  Idempotent replay is authorized **only** when durable history provenance is positively proven (see Section 13).
  Otherwise: `ILLEGAL_STATE_TRANSITION`, zero mutation.

### Merge Semantics on Valid First Reconciliation
```javascript
const newDiagnostics = {
  ...existingDiagnostics,
  reconciliation: {
    classification: 'DELIVERY_UNPROVEN',
    evidence_authority: authority.evidence_authority,
    reconciled_at: nowIso
  }
};
```
Every unrelated existing diagnostics key is preserved exactly.

The diagnostics dictionary must **never** store:
- Raw transcripts or log lines
- Raw AO command output
- Transport session IDs or thread IDs
- Dispatch transport request IDs (e.g. `Admin/OlzvryaCFC-000297`)
- Arbitrary operator prose

### History Patch Exact Shape
The history row's `patch` blob records strictly the reconciliation delta:
```json
{
  "diagnostics": {
    "reconciliation": {
      "classification": "DELIVERY_UNPROVEN",
      "evidence_authority": "<exact bounded authority>",
      "reconciled_at": "<same nowIso>"
    }
  }
}
```
Unrelated pre-existing diagnostics keys are **not** copied into the history patch.

---

## 10. Original Transport Error Preservation

In cycle P2, the dispatch record recorded:
```text
error: "The agent process exited; relaunch it before sending another message (AGENT_EXITED) [request Admin/OlzvryaCFC-000297]"
```

Reconciliation **MUST NOT** overwrite or clear `error`.

The terminal record preserves both distinct dimensions of operational truth:
1. **Transport Outcome**: Preserved in `dispatch.error` (`AGENT_EXITED`).
2. **Forensic Provenance**: Recorded in `dispatch.diagnostics.reconciliation` and `history.patch` (`DELIVERY_UNPROVEN` via `WP-V4-09C-P2-R1`).

---

## 11. Atomic SQLite Transaction Contract

In `sqlite-lifecycle-store.js`, reconciliation must execute within an atomic transaction:

```sql
BEGIN IMMEDIATE
```

### Exact Parameterized SQL Update
```sql
UPDATE dispatches
SET state = ?,
    updated_at = ?,
    diagnostics = ?
WHERE dispatch_id = ?
```

The bound parameters are strictly:
1. `DISPATCH_STATES.PROVENANCE_AMBIGUOUS`
2. `nowIso`
3. `v8.serialize(newDiagnostics)`
4. `authority.dispatch_id`

### Predicate & Row-Count Invariants
- **No unqualified or tautological predicate** (such as `WHERE dispatch_id = dispatch_id`) is permitted.
- A successful reconciliation `UPDATE` must affect **exactly one row**:
  ```javascript
  const updateResult = updateStmt.run(targetState, nowIso, diagBlob, authority.dispatch_id);
  if (updateResult.changes !== 1) {
    db.exec('ROLLBACK');
    throw new Error(`Integrity error: reconciliation UPDATE affected ${updateResult.changes} rows (expected exactly 1)`);
  }
  ```
- If `changes !== 1`: `ROLLBACK`, zero history append, throw integrity error.

### Step-by-Step Transaction Execution Flow
```text
1. BEGIN IMMEDIATE
2. Re-read dispatch row by dispatch_id:
   SELECT * FROM dispatches WHERE dispatch_id = ?
3. If row not found:
   -> ROLLBACK
   -> Return { ok: false, code: ERROR_CODES.DISPATCH_NOT_FOUND, error: "Dispatch '...' not found" }
4. Validate identity:
   - row.project_id === authority.project_id (if not -> ROLLBACK, return PROJECT_IDENTITY_MISMATCH)
   - row.work_order_id === authority.work_order_id (if not -> ROLLBACK, return INVALID_REQUEST)
5. Evaluate current state:
   a. If row.state === DISPATCH_STATES.PROVENANCE_AMBIGUOUS:
      - Evaluate idempotent replay with durable history provenance proof (Section 13)
      - If valid replay -> ROLLBACK transaction, return { ok: true, reconciled: false, idempotent_replay: true, dispatch: rowToDispatch(row) }
      - If invalid replay / different-path provenance -> ROLLBACK, return ILLEGAL_STATE_TRANSITION
      - If history is corrupt -> ROLLBACK, throw Error
   b. If row.state !== DISPATCH_STATES.DISPATCH_UNCERTAIN:
      -> ROLLBACK
      -> Return { ok: false, code: ERROR_CODES.ILLEGAL_STATE_TRANSITION, currentState: row.state, expectedState: DISPATCH_UNCERTAIN }
6. Inspect and validate diagnostics:
   - Deserialized row.diagnostics must satisfy isPlainDataObject(base) (or be null/absent -> {})
   - If not plain data object (Array, Date, Map, Set, RegExp, class instance, primitive) -> ROLLBACK, throw Error
   - If Object.hasOwn(base, 'reconciliation') -> ROLLBACK, throw Error
7. Capture single clock snapshot:
   nowIso = clock.iso()
   nowTs = clock.now()
8. Prepare new diagnostics & history patch:
   newDiagnostics = { ...base, reconciliation: { classification: authority.classification, evidence_authority: authority.evidence_authority, reconciled_at: nowIso } }
   historyPatch = { diagnostics: { reconciliation: { classification: authority.classification, evidence_authority: authority.evidence_authority, reconciled_at: nowIso } } }
9. Execute parameterized UPDATE:
   UPDATE dispatches SET state = ?, updated_at = ?, diagnostics = ? WHERE dispatch_id = ?
   Verify changes === 1 (if not -> ROLLBACK, throw Error)
10. Insert exactly one history row:
   INSERT INTO history (project_id, dispatch_id, work_order_id, previous_state, next_state, timestamp, iso, patch)
   VALUES (?, ?, ?, 'DISPATCH_UNCERTAIN', 'PROVENANCE_AMBIGUOUS', nowTs, nowIso, patchBlob)
11. COMMIT
12. Return { ok: true, reconciled: true, idempotent_replay: false, dispatch: rowToDispatch(updatedRow) }
```

### Exception Behavior
- **Expected validation and state failures**: Return structured results (`INVALID_REQUEST`, `DISPATCH_NOT_FOUND`, `PROJECT_IDENTITY_MISMATCH`, `ILLEGAL_STATE_TRANSITION`).
- **Unexpected persistence / SQLite / deserialization / integrity exceptions**:
  `ROLLBACK` if transaction is active, then **THROW** the error.
  Never convert unexpected store-internal errors into synthetic success or idempotent results. The bounded operator script is responsible for catching and reporting the error.

Ad-hoc raw SQL scripts executed directly against `lifecycle.sqlite3` from PowerShell or external tools remain **strictly forbidden**.

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

## 13. Replay Safety & Durable History Provenance

Operator procedures may accidentally trigger a reconciliation script multiple times. However, current state `PROVENANCE_AMBIGUOUS` plus matching diagnostics alone is **NOT** sufficient to authorize an idempotent replay.

### The Replay Provenance Invariant
An idempotent replay is authorized **IF AND ONLY IF** all of the following hold:

1. **Identity Matches**: `dispatch_id`, `project_id`, and `work_order_id` match exactly.
2. **Current State**: Exactly `DISPATCH_STATES.PROVENANCE_AMBIGUOUS`.
3. **Dispatch Diagnostics Plainness**:
   - `row.diagnostics` is a valid plain data object (`isPlainDataObject(row.diagnostics)`).
   - `row.diagnostics.reconciliation` is a valid plain data object (`isPlainDataObject(row.diagnostics.reconciliation)`).
4. **Dispatch Diagnostics Exactness**:
   - `row.diagnostics.reconciliation.classification === 'DELIVERY_UNPROVEN'`
   - `row.diagnostics.reconciliation.evidence_authority === authority.evidence_authority`
   - `typeof row.diagnostics.reconciliation.reconciled_at === 'string'`
5. **Latest Durable History Row Lookup**:
   The store queries the latest history row for the exact dispatch identity:
   ```sql
   SELECT previous_state, next_state, patch
   FROM history
   WHERE dispatch_id = ?
   ORDER BY history_seq DESC
   LIMIT 1
   ```
   (Memory store performs the exact semantic equivalent by inspecting the last history entry for `dispatch_id`).
   - If no history row exists: **FAIL CLOSED** (`ROLLBACK`, throw persisted corruption error).
   - `latestHistory.previous_state` must strictly equal `DISPATCH_STATES.DISPATCH_UNCERTAIN`.
   - `latestHistory.next_state` must strictly equal `DISPATCH_STATES.PROVENANCE_AMBIGUOUS`.
6. **Latest History Patch Exactness**:
   - Deserialized patch must be a valid plain data object (`isPlainDataObject(patch)`).
   - `patch` must have **EXACTLY** one own key: `'diagnostics'`.
   - `patch.diagnostics` must be a valid plain data object with **EXACTLY** one own key: `'reconciliation'`.
   - `patch.diagnostics.reconciliation` must be a valid plain data object with **EXACTLY** three own keys: `'classification'`, `'evidence_authority'`, `'reconciled_at'`.
   - The values must strictly match the dispatch diagnostics:
     ```text
     patch.diagnostics.reconciliation.classification === dispatch.diagnostics.reconciliation.classification
     patch.diagnostics.reconciliation.evidence_authority === dispatch.diagnostics.reconciliation.evidence_authority
     patch.diagnostics.reconciliation.reconciled_at === dispatch.diagnostics.reconciliation.reconciled_at
     ```
   - No additional keys at any of these levels (`patch`, `patch.diagnostics`, `patch.diagnostics.reconciliation`).

### Different-Path Provenance Must Fail Closed
If a dispatch reached `PROVENANCE_AMBIGUOUS` from:
- `DISPATCH_ACCEPTED → PROVENANCE_AMBIGUOUS` (e.g. wait timeout / missing boundary)
- `RUNNING → PROVENANCE_AMBIGUOUS`

Even if its diagnostics happen to contain `classification: 'DELIVERY_UNPROVEN'` and `evidence_authority: authority.evidence_authority`, `reconcileUncertainDispatch(authority)` **MUST NOT** classify the call as idempotent replay.
Because the latest history transition was not `DISPATCH_UNCERTAIN → PROVENANCE_AMBIGUOUS`, it fails closed:
```javascript
{
  ok: false,
  code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
  error: "Dispatch reached PROVENANCE_AMBIGUOUS through a different transition path; replay unauthorized"
}
```
**ZERO** mutation. **ZERO** history append.

### Replay Execution Semantics
When all replay provenance checks pass:
- **Transaction is ROLLED BACK** (read-only validation requires no COMMIT).
- `UPDATE` calls: `0`
- History inserts: `0`
- Diagnostics rewrites: `0`
- `updated_at` rewrites: `0`
- `clock.iso()` calls: `0`
- `clock.now()` calls: `0`
- Return:
  ```javascript
  {
    ok: true,
    reconciled: false,
    idempotent_replay: true,
    dispatch: rowToDispatch(row)
  }
  ```

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
4. **Consistency with V4 Recovery Patterns**: Audited operator maintenance tasks in V4 rely on bounded scripts rather than general-purpose multi-tenant CLI commands.

---

## 17. Deterministic Test Matrix (UR-001..UR-035)

The subsequent implementation work order must implement and verify the following deterministic test cases across both memory and SQLite stores:

| Test ID | Scenario | Expected Behavior |
|---|---|---|
| **UR-001** | `DISPATCH_UNCERTAIN + DELIVERY_UNPROVEN` | Transitions state to `PROVENANCE_AMBIGUOUS`. Returns `{ ok: true, reconciled: true, idempotent_replay: false }`. |
| **UR-002** | Row count & history count invariant | Dispatch table row count unchanged. History table row count increments by exactly 1 (`+1`). |
| **UR-003** | Active lock release | Prior to call, `getActiveDispatch(project)` returns the dispatch. After call, `getActiveDispatch(project)` returns `null`. |
| **UR-004** | Generic `transition()` remains sealed | Calling `store.transition(dispatchId, 'PROVENANCE_AMBIGUOUS')` on `DISPATCH_UNCERTAIN` is rejected with `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-005** | Wrong `project_id` rejected | Passing mismatched `project_id` returns `PROJECT_IDENTITY_MISMATCH`. Zero mutation, zero history append. |
| **UR-006** | Wrong `work_order_id` rejected | Passing mismatched `work_order_id` returns `INVALID_REQUEST`. Zero mutation, zero history append. |
| **UR-007** | Wrong current state rejected | Calling against dispatch in `DISPATCH_ACCEPTED`, `RUNNING`, or `READY_FOR_REVIEW` returns `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-008** | Unsupported target state rejected | Passing `target_state: 'DISPATCH_FAILED'` or `'RUNNING'` returns `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-009** | Unsupported classification rejected | Passing `classification: 'NOT_DELIVERED'` or `'AGENT_CRASH'` returns `INVALID_REQUEST`. Zero mutation. |
| **UR-010** | Original transport error preserved | The original `error` string (`AGENT_EXITED...`) remains intact in the dispatch record and is not overwritten or cleared. |
| **UR-011** | Reconciliation metadata durability | `diagnostics.reconciliation` contains `classification`, `evidence_authority`, `reconciled_at`. `history.patch.diagnostics` matches. |
| **UR-012** | Identical replay safety | Second call with identical authority and history proof returns `{ ok: true, reconciled: false, idempotent_replay: true }`. Zero DB mutation, zero history append. |
| **UR-013** | SQLite store reopen durability | Closing and reopening SQLite store verifies `state === 'PROVENANCE_AMBIGUOUS'`, diagnostics durable, error intact, history count intact. |
| **UR-014** | Memory lifecycle store parity | All reconciliation validations and state transformations pass identically in `createMemoryLifecycleStore()`. |
| **UR-015** | Transaction race / state drift | If state changes concurrently prior to transaction commit, fails closed with `ROLLBACK`. |
| **UR-016** | Zero worker / AO / Codex side effects | Reconciliation executes strictly within the lifecycle store. Zero network, CLI, or subprocess calls. |
| **UR-017** | `evidence_authority` over byte bound | String exceeding 512 UTF-8 bytes rejected with `INVALID_REQUEST`. Zero mutation. |
| **UR-018** | `evidence_authority` control character / multiline | String containing `\n`, `\r`, or ASCII control chars rejected with `INVALID_REQUEST`. Zero mutation. |
| **UR-019** | Pre-existing diagnostics plain object | Existing unrelated keys in `diagnostics` are preserved exactly after reconciliation. |
| **UR-020** | Pre-existing diagnostics non-plain / array | Persisted non-plain/array diagnostics fails closed (`ROLLBACK`, throws Error). Zero mutation. |
| **UR-021** | `DISPATCH_UNCERTAIN` with pre-existing reconciliation key | Fails closed on authority inconsistency (`ROLLBACK`, throws Error). Zero mutation. |
| **UR-022** | SQL UPDATE affected rows != 1 | Mismatched affected rows triggers `ROLLBACK` and throws integrity error. Zero history row appended. |
| **UR-023** | Identical replay immutability | Identical replay does not call mutation clock, does not modify `updated_at`, and rolls back no-op transaction. |
| **UR-024** | Contradictory-current-boundary classification | Classification with contradictory boundaries cannot use `DELIVERY_UNPROVEN` reconciliation. |
| **UR-025** | Date diagnostics | Persisted `Date` object in diagnostics triggers `ROLLBACK` and throws corruption error. Zero mutation. |
| **UR-026** | Map diagnostics | Persisted `Map` object in diagnostics triggers `ROLLBACK` and throws corruption error. Zero mutation. |
| **UR-027** | Set / custom-prototype diagnostics | Persisted `Set` or custom-prototype object in diagnostics triggers `ROLLBACK` and throws corruption error. Zero mutation. |
| **UR-028** | null-prototype plain diagnostics | Diagnostics created via `Object.create(null)` accepted as plain data object; unrelated keys preserved. |
| **UR-029** | Authority object extra own key | Authority object containing unrecognized extra key rejected with `INVALID_REQUEST`. Zero mutation. |
| **UR-030** | Authority accessor / non-enumerable / symbol key | Authority object containing getter/setter, non-enumerable property, or Symbol key rejected with `INVALID_REQUEST`. Zero mutation. |
| **UR-031** | Replay mismatch: latest history is `DISPATCH_ACCEPTED -> PROVENANCE_AMBIGUOUS` | Dispatch in `PROVENANCE_AMBIGUOUS` reaching terminal state via `DISPATCH_ACCEPTED` rejected with `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-032** | Replay mismatch: latest history is `RUNNING -> PROVENANCE_AMBIGUOUS` | Dispatch in `PROVENANCE_AMBIGUOUS` reaching terminal state via `RUNNING` rejected with `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-033** | Replay latest history patch malformed / non-plain | Replay encountering malformed/non-plain patch triggers `ROLLBACK` and throws corruption error. Zero mutation. |
| **UR-034** | Replay latest history patch mismatch with diagnostics | Replay where history patch does not exactly match dispatch reconciliation metadata rejected with `ILLEGAL_STATE_TRANSITION`. Zero mutation. |
| **UR-035** | Valid identical replay with exact durable history proof | Replay satisfying full durable history provenance returns `idempotent_replay: true`, zero mutations, zero clock calls. |

---

## 18. P2 Real Reconciliation Protocol

Following formal review and approval of this design and its subsequent implementation:

1. **Design Scope Constraint**:
   Work Order `WO-V4-09C-U1` (including `WO-V4-09C-U1-R1` and `WO-V4-09C-U1-R2`) is strictly **DESIGN-ONLY**. It executes **ZERO** lifecycle mutations on `lifecycle.sqlite3`.
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
│ Status: DESIGN_SEALED (EXTERNAL_REVIEW_PENDING)        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼ (Approved only after external review)
┌────────────────────────────────────────────────────────┐
│ Gate 2: Reconciliation Implementation                  │
│ Status: PENDING (Dedicated Work Order + Matrix UR-035) │
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

Gate 1 is currently `DESIGN_SEALED` and `EXTERNAL_REVIEW_PENDING`. It becomes `APPROVED_CLOSED` only after external review.

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
A single bounded plain data object binding `dispatch_id`, `project_id`, `work_order_id`, `expected_state: 'DISPATCH_UNCERTAIN'`, `target_state: 'PROVENANCE_AMBIGUOUS'`, `classification: 'DELIVERY_UNPROVEN'`, and `evidence_authority: string`. Must have exactly 7 own enumerable string keys, no extra keys, no symbols, no accessors. Validated with finite bounds (`<= 512` UTF-8 bytes, no control chars/multiline, project regex). Fails closed with `INVALID_REQUEST` on invalid input or work order mismatch, `DISPATCH_NOT_FOUND` on missing dispatch, and `PROJECT_IDENTITY_MISMATCH` on project mismatch.

### Decision F: SQLite atomic transaction semantics
Executed within `BEGIN IMMEDIATE`. Re-reads row, validates identity, evaluates replay (rolling back on replay), updates state via parameterized SQL (`WHERE dispatch_id = ?`), verifies `changes === 1`, writes diagnostics, preserves error, appends exactly one history row, and commits. Rolls back and throws on persistence/integrity exceptions.

### Decision G: Active-lock release semantics
Transitioning to terminal state `PROVENANCE_AMBIGUOUS` automatically drops the row from the partial index `idx_active_project` and causes `getActiveDispatch()` to return `null`, releasing the active lock cleanly.

### Decision H: Original transport error preservation
The `error` column containing `AGENT_EXITED` is left untouched byte-for-byte. Reconciliation metadata is written exclusively to `diagnostics` and `history.patch`.

### Decision I: Reconciliation metadata persistence
Persisted in **BOTH** `dispatch.diagnostics` and `history.patch` using bounded structured JSON (`classification`, `evidence_authority`, `reconciled_at`). Dispatch diagnostics preserves unrelated plain keys; history patch records strictly the reconciliation delta. No raw transcripts or arbitrary prose.

### Decision J: Replay/idempotence behavior
First call updates state and appends 1 history row. Second identical call requires proof of durable history provenance: verifies latest history row for dispatch is `DISPATCH_UNCERTAIN -> PROVENANCE_AMBIGUOUS` with matching deserialized patch. Rolls back the read-only transaction, and returns `{ ok: true, reconciled: false, idempotent_replay: true, dispatch }` with zero state mutation, zero history append, zero timestamp rewrites, and zero mutation clock calls. Different-path provenance fails closed with `ILLEGAL_STATE_TRANSITION`.

### Decision K: Race/state-drift behavior
If state changes concurrently between preflight and transaction, transaction re-read detects the mismatch and rolls back with `ILLEGAL_STATE_TRANSITION`. Transaction-time database state is sole authority.

### Decision L: Operator invocation boundary
Option 1: Dedicated production lifecycle store API invoked by a bounded operator script. Bounded to audited Node.js execution, eliminating generic broker/CLI exposure.

### Decision M: Deterministic test matrix
Cases UR-001 through UR-035 covering success, invariants, active lock release, generic seal, input validation bounds, error preservation, replay safety, durable history provenance proof, durability, store parity, and corruption handling.

### Decision N: P2 real reconciliation protocol
A future dedicated work order will execute `reconcileUncertainDispatch` against P2 dispatch `D-4af7357f-d332-4e50-b64e-b716961f3424` using forensic authority `WP-V4-09C-P2-R1`. U1/U1-R1/U1-R2 performs zero mutation.

### Decision O: P3 gating
P3 is strictly gated behind U1 design approval, reconciliation implementation, real P2 reconciliation, and separate proof of Antigravity transport readiness (`AGENT_EXITED` root cause resolution). Gate 1 is pending external review.

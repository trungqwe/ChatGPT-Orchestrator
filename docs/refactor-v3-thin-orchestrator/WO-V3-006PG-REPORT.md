# WO-V3-006PG — Final Schema / Store-Contract Seal Report

**Work Order**: WO-V3-006PG
**Status**: COMPLETE
**Result**: `READY_FOR_WP_V3_006P_APPROVAL`
**Parent Branch**: `review/v3-wp06-lifecycle-persistence-final`
**Parent SHA**: `7a59919c596bebe7a05d7851247e2f19508f7639`
**Working Branch**: `review/v3-wp06-lifecycle-persistence-seal`
**Architecture Authority**: `3001dce9e0d010f4b68fc7b061072ec9b30f093d`

---

## 1. Baseline

WO-V3-006PF established semantic corruption fail-closed defenses, physical integrity validation (`quick_check`), initialization rollback, and structured error serialization. External review identified three final closure requirements for full schema and store-contract sealing:
- `LCAUTH-06`: Schema validation checked column names but not lifecycle-critical column constraints, identities, affinities, primary keys, and database-level uniqueness.
- `LCAUTH-07`: Active partial index validation accepted extra trailing/leading predicate conditions (such as `AND project_id <> 'bypass'`).
- `LCAUTH-08`: SQLite optional mutable-field (`error`, `diagnostics`) null/undefined/absence semantics were not fully conformant with the memory lifecycle store.

WO-V3-006PG closes all three items while preserving all approved persistence behaviors.

---

## 2. LCAUTH-06 Schema Constraints & Identity Semantics

Schema version 1 validation proves that the database enforces deterministic sequencing, identity uniqueness, non-null guarantees, and correct affinities:

1. **`dispatches.seq`**:
   - Declared type: `INTEGER`.
   - Primary key position: `pk === 1`.
   - Rejects plain nullable or TEXT `seq` columns (`SL-042`, `SL-045`).
   - Ensures deterministic integer row identity and latest-dispatch ordering.

2. **`history.history_seq`**:
   - Declared type: `INTEGER`.
   - Primary key position: `pk === 1`.
   - Rejects non-primary key or TEXT `history_seq` columns (`SL-042`, `SL-045`).
   - Ensures deterministic integer sequence ordering for history events.

3. **`dispatches.dispatch_id` Uniqueness**:
   - Verified at the database level using `PRAGMA index_list('dispatches')` and `PRAGMA index_info`.
   - Requires an exact single-column, non-partial UNIQUE constraint or UNIQUE index on `dispatch_id`.
   - Application `SELECT then INSERT` alone is not accepted (`SL-043`).
   - A schema with non-unique `dispatch_id` fails closed at open.

4. **Critical NOT NULL Constraints**:
   - `dispatches`: `dispatch_id`, `project_id`, `work_order_id`, `request_fingerprint`, `directive`, `state`, `created_at`, `updated_at` must all be declared `NOT NULL` (`SL-044`).
   - `history`: `project_id`, `dispatch_id`, `work_order_id`, `next_state`, `timestamp`, `iso` must all be declared `NOT NULL` (`SL-044`).
   - Handled SQLite's implicit `PRIMARY KEY` non-null semantics appropriately.

5. **Column Declared Affinities**:
   - Identity, state, directive, timestamps: `TEXT`.
   - `seq`, `history_seq`, `timestamp`: `INTEGER`.
   - Structured blobs (`audit_metadata`, `diagnostics`, `patch`): `BLOB`.
   - `error`: accepts both candidate `TEXT` and new `BLOB` declarations for backward compatibility.
   - Structurally incompatible declarations (e.g. `seq TEXT`, `history_seq TEXT`, `state BLOB`) fail closed (`SL-045`).

6. **Fresh Schema Self-Validation**:
   - Immediately after creating a fresh schema inside the initialization transaction, the store runs the exact same validator (`validateSchemaShape`, `validateActiveIndex`, `validatePersistedSemantics`) before returning the operational store instance.

---

## 3. LCAUTH-07 Exact Active Index Predicate

The single-active-dispatch guard for a project relies on `idx_active_project`.
- The index must be `UNIQUE`, partial (`partial === 1`), and cover strictly `project_id`.
- The `WHERE` clause predicate is normalized and parsed strictly against:
  ```text
  state IN (<exact ACTIVE_STATES set>)
  ```
- Any extra condition (e.g. `AND project_id <> 'bypass'`, extra `OR`, `NOT`, collation, or functions) fails closed (`SL-041`).
- The validated active state list must match exactly:
  `['DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN']`.

---

## 4. LCAUTH-08 Optional Field Parity (Null vs Undefined vs Absent)

The memory store applies `Object.assign(record, structuredClone(patch))` or `{ ...safeClone(record) }`, creating observable distinctions between:
1. Field absent (`Object.hasOwn(...) === false`).
2. Field present with `undefined` (`Object.hasOwn(...) === true`, `val === undefined`).
3. Field present with `null` (`Object.hasOwn(...) === true`, `val === null`).
4. Field present with value (`Object.hasOwn(...) === true`, `val === <value>`).

SQLite lifecycle store achieves 100% parity across all four states:
- **Absence Sentinel**: SQL `NULL` is reserved exclusively as the sentinel for field absence. When a row has SQL `NULL` for `error` or `diagnostics`, `rowToDispatch()` omits the property entirely (`Object.hasOwn(...) === false`).
- **Explicit `null` / `undefined`**:
  - `beginDispatch(projectId, record)`: If `Object.hasOwn(record, 'error')` is true, persists `v8.serialize(record.error)`. Even for `undefined` or `null`, a small 3-byte Buffer (`<Buffer ff 0f 5f>` for undefined, `<Buffer ff 0f 30>` for null) is persisted as a `BLOB`.
  - `transition(dispatchId, nextState, patch)`: If `Object.hasOwn(patch, 'error')` is true, persists `v8.serialize(patch.error)`.
  - Same rule applies to `diagnostics`.
- **Read Contract**:
  - Buffer deserializes via `v8.deserialize()` to the exact original primitive (`undefined`, `null`) or structured object.
  - Plain string values in `error` remain supported for backward candidate compatibility.
- Verified in `SL-046` and `SL-047` with memory vs SQLite parity across transitions, initial records, reloads, and detachment.

---

## 5. Required Schema Table

| Column | Declared Affinity Accepted | NOT NULL Required? | PK / UNIQUE Role | Why Authoritative |
|---|---|---|---|---|
| `dispatches.seq` | `INTEGER` | Yes (implicit via PK) | `PRIMARY KEY (pos 1)` | Guarantees deterministic row sequencing and latest-dispatch resolution. |
| `dispatches.dispatch_id` | `TEXT` | Yes | `UNIQUE` constraint / index | Ensures database-enforced dispatch identity uniqueness without relying on app checks. |
| `dispatches.project_id` | `TEXT` | Yes | Indexed in `idx_active_project` | Enforces project scoping and single-active engine guard. |
| `dispatches.work_order_id` | `TEXT` | Yes | None | Preserves WorkOrder identity for idempotent replay and conflict detection. |
| `dispatches.expected_workspace_state_id` | `TEXT` | No (optional) | None | Tracks workspace snapshot precondition for the dispatch. |
| `dispatches.request_fingerprint` | `TEXT` | Yes | None | Cryptographic fingerprint for idempotent replay validation. |
| `dispatches.directive` | `TEXT` | Yes | None | Authoritative prompt/instruction delivered to worker. |
| `dispatches.audit_metadata` | `BLOB` | No (optional) | None | Lossless structured audit parameters (deserialized via v8). |
| `dispatches.state` | `TEXT` | Yes | Filtered in `idx_active_project` | Authoritative closed lifecycle state machine domain. |
| `dispatches.error` | `BLOB` or `TEXT` | No (optional) | None | Structured failure diagnostic payload; TEXT supported for backward compatibility. |
| `dispatches.diagnostics` | `BLOB` | No (optional) | None | Lossless worker diagnostic payload (deserialized via v8). |
| `dispatches.created_at` | `TEXT` | Yes | None | Authoritative ISO timestamp of dispatch creation. |
| `dispatches.updated_at` | `TEXT` | Yes | None | Authoritative ISO timestamp of latest state update. |
| `history.history_seq` | `INTEGER` | Yes (implicit via PK) | `PRIMARY KEY (pos 1)` | Guarantees deterministic chronological sequence ordering for history stream. |
| `history.project_id` | `TEXT` | Yes | None | Scopes history queries by project. |
| `history.dispatch_id` | `TEXT` | Yes | None | Correlates history events to dispatch identity. |
| `history.work_order_id` | `TEXT` | Yes | None | Correlates history events to WorkOrder identity. |
| `history.previous_state` | `TEXT` | No (null for init) | None | Captures state machine origin for audit trail. |
| `history.next_state` | `TEXT` | Yes | None | Captures state machine destination for audit trail. |
| `history.timestamp` | `INTEGER` | Yes | None | Monotonic millisecond timestamp for ordering inspection. |
| `history.iso` | `TEXT` | Yes | None | Deterministic ISO timestamp of state transition. |
| `history.patch` | `BLOB` | No (optional) | None | Lossless mutation patch applied during transition. |

---

## 6. Required Optional-Field Table

| Input Value | Memory Store Returned Shape | SQLite Store Returned Shape | SQLite Reopened Shape |
|---|---|---|---|
| **Field absent** (omitted from record/patch) | Property omitted (`Object.hasOwn === false`) | Property omitted (`Object.hasOwn === false`, stored as SQL `NULL`) | Property omitted (`Object.hasOwn === false`, SQL `NULL` omitted) |
| **`undefined`** (`{ field: undefined }`) | Own property present (`Object.hasOwn === true`, `val === undefined`) | Own property present (`Object.hasOwn === true`, `val === undefined`, stored as `v8.serialize(undefined)`) | Own property present (`Object.hasOwn === true`, `val === undefined`) |
| **`null`** (`{ field: null }`) | Own property present (`Object.hasOwn === true`, `val === null`) | Own property present (`Object.hasOwn === true`, `val === null`, stored as `v8.serialize(null)`) | Own property present (`Object.hasOwn === true`, `val === null`) |
| **String** (`{ field: 'err' }`) | Own property present (`Object.hasOwn === true`, `val === 'err'`) | Own property present (`Object.hasOwn === true`, `val === 'err'`) | Own property present (`Object.hasOwn === true`, `val === 'err'`) |
| **Object** (`{ field: { code: 12n } }`) | Own property present (`Object.hasOwn === true`, deep clone of object) | Own property present (`Object.hasOwn === true`, deserialized structured object) | Own property present (`Object.hasOwn === true`, deserialized structured object) |

---

## 7. Negative Test Matrix (`SL-001` .. `SL-047`)

Suite: `pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`
Total: **47/47 PASS**

| ID | Test Description | Condition Tested | Result |
|---|---|---|---|
| SL-001 | create new DB/schema | Schema v1, tables, index, self-validation | PASS |
| SL-002 | begin persists and reopen returns same dispatch | Durability across close/reopen | PASS |
| SL-003 | accepted state persists across reopen | DISPATCH_ACCEPTED persistence | PASS |
| SL-004 | RUNNING persists across reopen | RUNNING persistence | PASS |
| SL-005 | READY_FOR_REVIEW persists and is inactive | Terminal state inactive on reopen | PASS |
| SL-006 | DISPATCH_UNCERTAIN persists and remains active | Uncertain state active on reopen | PASS |
| SL-007 | PROVENANCE_AMBIGUOUS persists and is inactive | Terminal state inactive on reopen | PASS |
| SL-008 | idempotent replay survives reopen | Exact duplicate request | PASS |
| SL-009 | duplicate WorkOrder conflict survives reopen | Fingerprint mismatch conflict | PASS |
| SL-010 | WORKER_BUSY survives reopen | Parallel WorkOrder busy rejection | PASS |
| SL-011 | duplicate dispatch ID fails closed | Primary key dispatch collision | PASS |
| SL-012 | illegal transition rejected | Forward state machine check | PASS |
| SL-013 | immutable patch rejected | Immutable field violation check | PASS |
| SL-014 | nested audit_metadata detached + persisted losslessly | BigInt, Date, Map, Set in audit | PASS |
| SL-015 | diagnostics detached + persisted losslessly | BigInt, Date, Map, Set in diag | PASS |
| SL-016 | history persists in deterministic sequence | Transaction history order | PASS |
| SL-017 | latest dispatch uses DB sequence | Sequence ordering vs timestamp | PASS |
| SL-018 | failed begin transaction leaves no partial dispatch/history | Atomic rollback on error | PASS |
| SL-019 | failed transition transaction preserves previous state/history | Atomic rollback on transition failure | PASS |
| SL-020 | corrupt DB fails closed without replacement | Non-database file rejection | PASS |
| SL-021 | wrong schema version fails closed | Unsupported schema version | PASS |
| SL-022 | two independent store instances see same committed state | Concurrent store visibility | PASS |
| SL-023 | cross-process same-project race permits only one active dispatch | Real child process race condition | PASS |
| SL-024 | cross-process different-project dispatches both succeed | Multi-project concurrency | PASS |
| SL-025 | process exits after DISPATCHING; reopened store remains non-IDLE | Crash safety before worker return | PASS |
| SL-026 | broker reopened with durable store can worker-wait accepted dispatch | Broker reopen wait flow | PASS |
| SL-027 | broker reopened sees uncertain dispatch and does not call worker | Non-waitable uncertain dispatch | PASS |
| SL-028 | write-ahead visible from second store before worker transport call | Intent commits before worker send | PASS |
| SL-029 | caller mutation of returned record cannot mutate DB | Complete object detachment | PASS |
| SL-030 | memory store and SQLite store transition conformance | Full state transition matrix parity | PASS |
| SL-031 | unknown active state on reopen fails closed | LCAUTH-01: corrupt state on reopen | PASS |
| SL-032 | unknown state after open fails closed and blocks new dispatch | LCAUTH-01: corrupt state post-open | PASS |
| SL-033 | fake active index rejected fail-closed | LCAUTH-02: non-unique/non-partial/wrong predicate | PASS |
| SL-034 | wrong table shape rejected fail-closed | LCAUTH-02: missing columns in schema | PASS |
| SL-035 | partial version-0 schema fails closed without auto-initialization | LCAUTH-03: user_version=0 with objects | PASS |
| SL-036 | structured error parity between memory and SQLite stores verified | LCAUTH-04: structured error parity | PASS |
| SL-037 | corrupt history state fails closed on reopen | LCAUTH-01: corrupt history state | PASS |
| SL-038 | physical quick_check failure fails closed | SQLite quick_check physical failure | PASS |
| SL-039 | initialization failure closes handle without leak | LCAUTH-05: guaranteed handle closure | PASS |
| SL-040 | store contract patch conformance (memory vs SQLite) verified | LCAUTH-04: comprehensive patch parity | PASS |
| SL-041 | extra active-index predicate rejected | LCAUTH-07: trailing predicate condition rejected | PASS |
| SL-042 | sequence column not primary key rejected | LCAUTH-06: seq / history_seq PK=1 requirement | PASS |
| SL-043 | dispatch_id without unique constraint rejected | LCAUTH-06: database-level uniqueness requirement | PASS |
| SL-044 | required NOT-NULL contract verified | LCAUTH-06: project_id, state, next_state NOT NULL | PASS |
| SL-045 | incompatible column type shapes rejected | LCAUTH-06: declared affinities (seq TEXT, etc.) | PASS |
| SL-046 | null / undefined patch parity verified across stores | LCAUTH-08: transition patch parity (5 combinations) | PASS |
| SL-047 | initial optional field parity verified across stores | LCAUTH-08: beginDispatch parity (7 combinations) | PASS |

---

## 8. Command Evidence

### Local Test Execution Claims
The following test suites were executed locally in this workspace:
- `node pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`: **47/47 PASS**
- `node pipeline-ui/test/refactor/broker-core.test.js`: **52/52 PASS**
- `node pipeline-ui/test/refactor/worker-adapter.test.js`: **55/55 PASS**
- `node pipeline-ui/test/refactor/workspace-state.test.js`: **51/51 PASS**
- `node pipeline-ui/test/refactor/registry.test.js`: **39/39 PASS**
- `node pipeline-ui/test/refactor/wp01-regression.test.js`: **17/17 PASS**
- `node pipeline-ui/test/refactor/characterization.test.js`: **PASS**

### Static Verification Evidence
```bash
node -c pipeline-ui/lib/broker/sqlite-lifecycle-store.js
node -c pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js
node -c pipeline-ui/lib/broker/contracts.js
node -c pipeline-ui/lib/broker/lifecycle-store.js
node -c pipeline-ui/lib/broker/broker.js
```
All static syntax checks exited with code 0.

`git diff --check` exited with code 0 (zero whitespace or formatting errors).

---

## 9. Regression Evidence

All refactor test suites remain 100% passing with exact totals:
- `SL-001..SL-047`: 47/47 PASS
- `BC-001..BC-052`: 52/52 PASS
- `WA-001..WA-055`: 55/55 PASS
- `WS-001..WS-051`: 51/51 PASS
- `RG-001..RG-039`: 39/39 PASS
- `L-NT-029..L-NT-045`: 17/17 PASS

Total active refactor tests passing: **261 / 261 PASS**.

---

## 10. npm Classification

`npm test` in `pipeline-ui` executes `node test/pipeline-api.test.js && node test/closed-loop.test.js`.
- Status: `UNCHANGED_PRE_EXISTING_FAILURE`
- Root Cause: Pre-existing test expectation in `pipeline-api.test.js:72:12` checking for `workspace-test` in unseeded environment. Preserved unchanged per scope rules prohibiting edits to legacy server or user projects.

---

## 11. Scope Compliance

```text
Semantic CLI started:
NO

AO called live:
NO

Worker adapter modified:
NO

Registry modified:
NO

Workspace state modified:
NO

server.js modified:
NO

package.json modified:
NO

UI modified:
NO

Full AO reconciliation:
NO
```

### Local Untracked Files
- `manifest.json`: Pre-existing ambient file, unstaged and untouched.

---

## 12. Deferred AO Reconciliation

Lingering in-flight AO process reconciliation after host crash or ungraceful shutdown remains deferred to WP-V3-10 or an authorized recovery package. Persisted active and uncertain states are preserved faithfully without premature deletion or assumption of IDLE.

---

## 13. Recommendation

All closure requirements (`LCAUTH-06`, `LCAUTH-07`, `LCAUTH-08`) are fully implemented and sealed. 47 durable lifecycle tests and 261 total refactor tests pass with complete conformance.

**Result**:
```text
READY_FOR_WP_V3_006P_APPROVAL
```

# WO-V3-006PF — Final Correctness Closure Report

**Work Order**: WO-V3-006PF
**Status**: COMPLETE
**Result**: `READY_FOR_WP_V3_006P_FINAL_EXTERNAL_REVIEW`
**Parent Branch**: `review/v3-wp06-lifecycle-persistence`
**Parent SHA**: `a39d42823f76c376b1d4c0bcd30ba08fa11ae28a`
**Working Branch**: `review/v3-wp06-lifecycle-persistence-final`
**Architecture Authority**: `3001dce9e0d010f4b68fc7b061072ec9b30f093d`

---

## 1. Baseline

WO-V3-006P established the durable SQLite lifecycle store precondition. External review identified five blockers requiring final correctness closure:
- `LCAUTH-01`: Semantically corrupt persisted state could become invisible to active-dispatch lookup and allow false IDLE / new dispatch.
- `LCAUTH-02`: Existing DB schema identity was verified only by object names, not by required columns, index uniqueness, partial properties, and exact predicate.
- `LCAUTH-03`: A nonempty or partial `user_version=0` database could be treated as a fresh database and silently completed.
- `LCAUTH-04`: SQLite `error` persistence narrowed the memory-store value contract to string.
- `LCAUTH-05`: Initialization and configuration lacked a guaranteed fail-closed validation boundary that ensures the database handle is closed on failure.

WO-V3-006PF resolves all five blockers while preserving all existing broker invariants and tests.

---

## 2. LCAUTH-01 Semantic State Integrity

The lifecycle store strictly enforces the closed authoritative state domain:
```text
DISPATCHING
DISPATCH_ACCEPTED
RUNNING
READY_FOR_REVIEW
DISPATCH_FAILED
DISPATCH_UNCERTAIN
PROVENANCE_AMBIGUOUS
```

### Open-Time Verification
When opening an existing database:
1. Every persisted dispatch row must have a recognized lifecycle state.
2. Every history row must have a recognized `next_state` and (if non-null) `previous_state`.
3. All serialized BLOB values (`audit_metadata`, `diagnostics`, `error`, `patch`) must successfully deserialize without error.
4. No project may contain more than one recognized active dispatch.
5. Consistency: for each dispatch row, a matching history stream must exist whose latest transition `next_state` matches the dispatch's current `state`, and project/work_order identity must agree.

Any violation causes store creation to FAIL CLOSED immediately.

### Runtime Corruption Guards
Queries do not rely solely on `WHERE state IN (...)`:
- `getActiveDispatch(projectId)` inspects all dispatches for the project. If any row contains an unrecognized state, it throws and fails closed. A corrupt row can NEVER produce a false `null` (IDLE) result.
- `getDispatch(dispatchId)` validates that the retrieved row has a recognized state; throws on unrecognized state.
- `getLatestDispatch(projectId)` validates all project rows before returning latest.
- `beginDispatch(projectId, record)` verifies all project rows under `BEGIN IMMEDIATE` before checking if the project is free. If any row has an invalid state, it rolls back and fails closed without inserting a new dispatch.

---

## 3. LCAUTH-02 Schema Identity

Schema version 1 verification enforces physical structural shape, not mere table names:
- **`dispatches` Table**: Verified via `PRAGMA table_info('dispatches')` to contain all 13 required columns:
  `seq`, `dispatch_id`, `project_id`, `work_order_id`, `expected_workspace_state_id`, `request_fingerprint`, `directive`, `audit_metadata`, `state`, `error`, `diagnostics`, `created_at`, `updated_at`.
- **`history` Table**: Verified via `PRAGMA table_info('history')` to contain all 9 required columns:
  `history_seq`, `project_id`, `dispatch_id`, `work_order_id`, `previous_state`, `next_state`, `timestamp`, `iso`, `patch`.
- **`idx_active_project` Index**:
  - `unique === 1` via `PRAGMA index_list('dispatches')`.
  - `partial === 1` via `PRAGMA index_list('dispatches')`.
  - Indexed column is strictly `project_id` via `PRAGMA index_info('idx_active_project')`.
  - Predicate in SQLite master SQL verified to match the exact authoritative `ACTIVE_STATES` set:
    `WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN')`.
  - Any ordinary index, non-unique index, non-partial index, or mismatched predicate fails closed.

---

## 4. LCAUTH-03 Fresh-vs-Partial DB Detection

A database is eligible for automatic schema initialization if and only if:
```text
user_version == 0 AND count(user_schema_objects) == 0
```
If `user_version == 0` but any user tables, views, or indexes exist in `sqlite_master`:
- The store FAILS CLOSED with:
  `Corrupt or partial database: user_version is 0 but user schema objects exist`.
- It does not overwrite, alter, or silently complete the partial database.

If `user_version !== 0` on an empty database:
- The store FAILS CLOSED.

---

## 5. LCAUTH-04 Mutable Error Contract

The memory store permits arbitrary structured-cloneable values in `patch.error` (e.g. `{ message: 'failed', code: 12n, at: new Date(), tags: new Set(['a']) }`).

In `sqlite-lifecycle-store.js`:
- New schemas declare `error BLOB`.
- Structured error values are serialized using `v8.serialize()` and deserialized via `v8.deserialize()`.
- Backward compatibility: If an existing database contains plain string `error` values (TEXT storage class), `rowToDispatch` detects `typeof row.error === 'string'` and returns the string directly.
- Semantics:
  - If `error` was never patched / omitted: property is omitted (`undefined`).
  - If `error = null`: property is `null`.
  - If `error = string`: property is `string`.
  - If `error = structured`: property is deeply cloned structured value.
- Complete parity with memory store verified in `SL-036` and `SL-040`.

---

## 6. Initialization Transaction

Fresh database schema creation executes inside an explicit SQLite transaction:
```sql
BEGIN IMMEDIATE;
CREATE TABLE dispatches (...);
CREATE UNIQUE INDEX idx_active_project ON dispatches(project_id) WHERE state IN (...);
CREATE TABLE history (...);
PRAGMA user_version = 1;
COMMIT;
```
If any error occurs during creation, `ROLLBACK` is executed, preventing partially initialized schemas from remaining on disk.

---

## 7. Integrity Check

Existing databases undergo physical B-tree integrity validation prior to operational use:
```sql
PRAGMA quick_check;
```
The result must be strictly `ok`. Any other output triggers immediate fail-closed initialization rejection (`SL-038`).

Persistent journal-mode changes (e.g., `PRAGMA journal_mode = WAL`) are deferred until after `quick_check`, version, shape, index, and semantic validations have fully passed.

---

## 8. Runtime Corruption Detection

If an active dispatch is corrupted while a store instance is already open:
- `getActiveDispatch` immediately catches the unrecognized state and throws, refusing to return `null` (IDLE).
- `beginDispatch` inspects all project rows under `BEGIN IMMEDIATE` and throws upon encountering the corrupt state, refusing to insert a second dispatch row (`SL-032`).

---

## 9. Cross-Process Invariants

- Partial UNIQUE index `idx_active_project` guarantees that concurrent processes cannot both hold an active dispatch for the same project.
- Bounded busy timeout (`PRAGMA busy_timeout = 5000`) prevents deadlock.
- Multi-process race test `SL-023` confirms real independent Node.js processes cannot violate the one-active rule.

---

## 10. Restart Semantics

- State is fully durable on disk.
- Closed and reopened store instances recover exact active dispatch provenance without in-memory state.
- `DISPATCH_UNCERTAIN` remains active and non-waitable across restarts (`SL-006`, `SL-027`).
- Terminal states remain inactive and non-active across restarts (`SL-005`, `SL-007`).

---

## 11. Structured Value Conformance

All structured fields (`audit_metadata`, `diagnostics`, `error`, `history.patch`) use `v8.serialize()` / `v8.deserialize()`.
This guarantees lossless round-trip persistence of:
- `BigInt`
- `Date`
- `Map`
- `Set`
- `Uint8Array` / typed arrays
- Deeply nested objects

Caller mutations of returned records never mutate the database (deep detachment).

---

## 12. Permissions

Directory creation applies POSIX `0o700`. Existing directory permissions are best-effort chmoded to `0o700`. Database file applies `0o600`. Windows environments operate under standard OS filesystem semantics without false ACL claims.

---

## 13. Negative Test Matrix (`SL-001` .. `SL-040`)

Suite: `pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`
Total: **40/40 PASS**

| ID | Test Description | Condition Tested | Result |
|---|---|---|---|
| SL-001 | create new DB/schema | Schema v1, tables, index | PASS |
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

---

## 14. Command Evidence

### Local Test Execution Claims
The following test suites were executed locally in this workspace:
- `node pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`: **40/40 PASS**
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

`git diff --check` exited with code 0 (zero whitespace/newline errors).

---

## 15. Regression Evidence

All refactor test suites remain 100% passing with exact totals:
- `SL-001..SL-040`: 40/40 PASS
- `BC-001..BC-052`: 52/52 PASS
- `WA-001..WA-055`: 55/55 PASS
- `WS-001..WS-051`: 51/51 PASS
- `RG-001..RG-039`: 39/39 PASS
- `L-NT-029..L-NT-045`: 17/17 PASS

---

## 16. npm Classification

`npm test` in `pipeline-ui` executes `node test/pipeline-api.test.js && node test/closed-loop.test.js`.
- Status: `UNCHANGED_PRE_EXISTING_FAILURE`
- Root Cause: Pre-existing test expectation in `pipeline-api.test.js` checking for `workspace-test` in unmigrated legacy projects. Preserved unchanged per scope rules prohibiting edits to legacy server or user projects.

---

## 17. Scope Compliance

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

## 18. Deferred Reconciliation

This WorkOrder implements durable lifecycle authority. Recovery and reconciliation of lingering in-flight AO processes after system crash remains deferred to WP-V3-10 or an authorized recovery package. Persisted active and uncertain states are preserved faithfully without premature deletion or assumption of IDLE.

---

## 19. Recommendation

All five blockers (`LCAUTH-01` .. `LCAUTH-05`) are resolved and verified with 40 durable lifecycle tests and 214 total regression tests passing.

**Recommendation**: Proceed to external review with result:
```text
READY_FOR_WP_V3_006P_FINAL_EXTERNAL_REVIEW
```

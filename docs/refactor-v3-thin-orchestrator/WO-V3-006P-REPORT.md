# WO-V3-006P — Durable Lifecycle Store Precondition Report

**Work Order**: WO-V3-006P
**Status**: COMPLETE
**Result**: `READY_FOR_WP_V3_006P_EXTERNAL_REVIEW`
**Parent Branch**: `review/v3-wp05-antigravity-adapter-final`
**Parent SHA**: `e7b5ef857f94657e99ba59a218f2408bef4c0cc3`
**Working Branch**: `review/v3-wp06-lifecycle-persistence`
**Architecture Authority**: `3001dce9e0d010f4b68fc7b061072ec9b30f093d`

---

## 1. Baseline

WP-V3-05 was closed and approved at parent SHA `e7b5ef857f94657e99ba59a218f2408bef4c0cc3`. The broker core state machine and worker adapter boundary were verified and locked. However, the existing lifecycle store implementation (`pipeline-ui/lib/broker/lifecycle-store.js`) was explicitly labeled `VOLATILE / NON-DURABLE` and stored lifecycle state in process-local `Map` structures.

---

## 2. Why Durable Store is Prerequisite to One-Shot CLI

The intended CLI architecture (WP-V3-06) operates via discrete, non-persistent shell commands:
- `agent-broker worker-dispatch`
- `agent-broker worker-wait`
- `agent-broker worker-status`

In a standard shell environment, each command runs in an independent Node.js process:
1. `Process A` executes `worker-dispatch`, writes dispatch intent and receives acceptance, then exits.
2. Under the volatile memory store, the lifecycle state exists only in RAM of Process A; on process exit, all state is lost.
3. `Process B` subsequently executes `worker-wait`, encounters an empty lifecycle store, and loses all dispatch provenance.

This directly violated the locked architecture requirement:
> On restart: persist active dispatch/work-order/session/state/base workspace ID; never silently assume IDLE.

WO-V3-006P fulfills this precondition by implementing a durable SQLite-backed lifecycle store conforming strictly to the existing broker lifecycle store interface, without beginning the semantic CLI or altering broker semantics.

---

## 3. SQLite Schema

The durable lifecycle store uses Node.js's built-in `node:sqlite` (`DatabaseSync`). Default database path is `<user-home>/.orchestrator/lifecycle.sqlite3`, with temporary path overrides for unit testing.

Explicit schema version is enforced via `PRAGMA user_version = 1`.

### Table: `dispatches`
- `seq INTEGER PRIMARY KEY AUTOINCREMENT`: Monotonically increasing database sequence providing deterministic latest-dispatch ordering.
- `dispatch_id TEXT NOT NULL UNIQUE`: Authoritative dispatch identifier.
- `project_id TEXT NOT NULL`: Target project identity.
- `work_order_id TEXT NOT NULL`: Target WorkOrder identity.
- `expected_workspace_state_id TEXT`: Sealed workspace state pre-condition.
- `request_fingerprint TEXT NOT NULL`: SHA-256 fingerprint of the dispatch request.
- `directive TEXT NOT NULL`: Immutable execution prompt/directive.
- `audit_metadata BLOB`: Lossless `v8.serialize` binary payload of arbitrary structured metadata.
- `state TEXT NOT NULL`: Authoritative lifecycle state machine enum.
- `error TEXT`: Structured failure or exception string.
- `diagnostics BLOB`: Lossless `v8.serialize` binary payload of diagnostics.
- `created_at TEXT NOT NULL`: ISO 8601 creation timestamp.
- `updated_at TEXT NOT NULL`: ISO 8601 last-transition timestamp.

### Partial Unique Index: `idx_active_project`
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_project ON dispatches(project_id)
WHERE state IN ('DISPATCHING', 'DISPATCH_ACCEPTED', 'RUNNING', 'DISPATCH_UNCERTAIN');
```
This index enforces at the database engine level that no two concurrent processes can ever hold more than one active dispatch per project.

### Table: `history`
- `history_seq INTEGER PRIMARY KEY AUTOINCREMENT`: Deterministic sequence for transaction log ordering.
- `project_id TEXT NOT NULL`: Project identity.
- `dispatch_id TEXT NOT NULL`: Dispatch identity.
- `work_order_id TEXT NOT NULL`: WorkOrder identity.
- `previous_state TEXT`: State before transition (NULL for initial dispatching event).
- `next_state TEXT NOT NULL`: State transitioned to.
- `timestamp INTEGER NOT NULL`: Monotonic epoch millisecond timestamp.
- `iso TEXT NOT NULL`: ISO 8601 timestamp.
- `patch BLOB`: Lossless `v8.serialize` binary representation of the transition patch.

---

## 4. Transition Authority

To eliminate duplicate lifecycle truth tables, the state transition authority was extracted to `pipeline-ui/lib/broker/contracts.js` as an immutable frozen map with an exported predicate:
```javascript
isAllowedLifecycleTransition(currentState, nextState)
```
Both `createMemoryLifecycleStore` and `createSqliteLifecycleStore` consume this exact predicate. No mutable sets or maps are exported. Conformance across all state combinations was verified in test `SL-030`.

---

## 5. Write-Ahead Transaction

`beginDispatch(projectId, record)` executes within a single atomic SQLite transaction (`BEGIN IMMEDIATE ... COMMIT`).
1. Validates duplicate `dispatch_id` (collides with `DISPATCH_ID_COLLISION`).
2. Reads current active dispatch for `project_id`.
3. Evaluates idempotent replay, duplicate WorkOrder conflict, or worker busy rules.
4. Serializes structured values and inserts the dispatch row with state `DISPATCHING`.
5. Inserts initial history record.
6. Commits transaction to disk.

`beginDispatch` commits `DISPATCHING` to SQLite before returning success to the broker. Therefore, downstream worker transport (`workerPort.dispatch`) is only invoked after durable intent exists on disk (verified in write-ahead test `SL-028`).

---

## 6. Cross-Process Concurrency

Cross-process concurrency safety is enforced via:
1. `PRAGMA busy_timeout = 5000`: Bounded wait on locked write transactions.
2. `PRAGMA journal_mode = WAL`: Readers never block writers, writers never block readers.
3. `BEGIN IMMEDIATE`: Immediate acquisition of SQLite write locks, preventing stale-read races.
4. Partial UNIQUE index `idx_active_project`: Engine-level enforcement guaranteeing at most one active dispatch per project across all processes.

SL-023 verified real cross-process isolation using two independent child Node.js processes racing simultaneously against the same SQLite database file. Exactly one process succeeded; the racing process was rejected with `WORKER_BUSY`.

---

## 7. Restart Behavior

When store A is closed and store B is opened on the same database file:
- Active dispatches (`DISPATCHING`, `DISPATCH_ACCEPTED`, `RUNNING`, `DISPATCH_UNCERTAIN`) remain active and are recovered without RAM state.
- Terminal dispatches (`READY_FOR_REVIEW`, `DISPATCH_FAILED`, `PROVENANCE_AMBIGUOUS`) are loaded as terminal and report inactive (`getActiveDispatch` returns `null`).
- Replayed identical requests yield `IDEMPOTENT_REPLAY` with the persisted record.
- Conflicting requests yield `DUPLICATE_WORK_ORDER_CONFLICT`.
- Dispatches on busy projects yield `WORKER_BUSY`.
- The broker never assumes `IDLE` upon restart.

---

## 8. Structured Value Serialization

Rather than JSON-only serialization which silently drops `BigInt`, `Date`, `Map`, `Set`, and typed arrays, structured values (`audit_metadata`, `diagnostics`, `patch`) are stored as BLOBs using Node.js built-in `node:v8`:
```javascript
v8.serialize() / v8.deserialize()
```
Tests `SL-014` and `SL-015` verified lossless round-trip persistence and complete detachment for `BigInt`, `Date`, `Map`, `Set`, `Uint8Array`, and nested object graphs.

---

## 9. Corruption & Versioning Behavior

1. **Schema Version Check**: If an existing database has `user_version !== 1`, initialization immediately throws `Unsupported schema version: expected 1, found X`.
2. **Missing Schema Objects**: If required tables (`dispatches`, `history`) or partial index (`idx_active_project`) are absent, initialization fails closed.
3. **Corrupt File**: Malformed/non-SQLite files trigger `file is not a database` or `database disk image is malformed`.
4. **Fail-Closed Rule**: The store never deletes, resets, replaces with empty, falls back to memory, or assumes `IDLE`.

---

## 10. Permissions

Directory creation uses POSIX mode `0o700`. Database file creation applies best-effort POSIX `0o600`. On Windows, standard ACL behavior applies without false custom claims.

---

## 11. Test Coverage Summary (`SL-001` .. `SL-030`)

File: `pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`
Result: **30/30 PASS**

| ID | Description | Result |
|---|---|---|
| SL-001 | create new DB/schema | PASS |
| SL-002 | begin persists and reopen returns same dispatch | PASS |
| SL-003 | accepted state persists across reopen | PASS |
| SL-004 | RUNNING persists across reopen | PASS |
| SL-005 | READY_FOR_REVIEW persists and is inactive | PASS |
| SL-006 | DISPATCH_UNCERTAIN persists and remains active | PASS |
| SL-007 | PROVENANCE_AMBIGUOUS persists and is inactive | PASS |
| SL-008 | idempotent replay survives reopen | PASS |
| SL-009 | duplicate WorkOrder conflict survives reopen | PASS |
| SL-010 | WORKER_BUSY survives reopen | PASS |
| SL-011 | duplicate dispatch ID fails closed | PASS |
| SL-012 | illegal transition rejected | PASS |
| SL-013 | immutable patch rejected | PASS |
| SL-014 | nested audit_metadata detached + persisted losslessly | PASS |
| SL-015 | diagnostics detached + persisted losslessly | PASS |
| SL-016 | history persists in deterministic sequence | PASS |
| SL-017 | latest dispatch uses DB sequence | PASS |
| SL-018 | failed begin transaction leaves no partial dispatch/history | PASS |
| SL-019 | failed transition transaction preserves previous state/history | PASS |
| SL-020 | corrupt DB fails closed without replacement | PASS |
| SL-021 | wrong schema version fails closed | PASS |
| SL-022 | two independent store instances see same committed state | PASS |
| SL-023 | cross-process same-project race permits only one active dispatch | PASS |
| SL-024 | cross-process different-project dispatches both succeed | PASS |
| SL-025 | process exits after DISPATCHING; reopened store remains non-IDLE | PASS |
| SL-026 | broker reopened with durable store can worker-wait accepted dispatch | PASS |
| SL-027 | broker reopened sees uncertain dispatch and does not call worker | PASS |
| SL-028 | write-ahead visible from second store before worker transport call | PASS |
| SL-029 | caller mutation of returned record cannot mutate DB | PASS |
| SL-030 | memory store and SQLite store transition conformance | PASS |

---

## 12. Existing Regressions

All existing test suites were executed without regression:

1. `node pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`: **30/30 PASS**
2. `node pipeline-ui/test/refactor/broker-core.test.js`: **52/52 PASS** (BC-001..BC-052)
3. `node pipeline-ui/test/refactor/worker-adapter.test.js`: **55/55 PASS** (WA-001..WA-055)
4. `node pipeline-ui/test/refactor/workspace-state.test.js`: **51/51 PASS** (WS-001..WS-051)
5. `node pipeline-ui/test/refactor/registry.test.js`: **39/39 PASS** (RG-001..RG-039)
6. `cd pipeline-ui && node test/refactor/wp01-regression.test.js`: **17/17 PASS** (L-NT-029..L-NT-045)
7. `node test/refactor/characterization.test.js`: **PASS** (invariants enforced, characterization baseline preserved)

### npm Test Classification
`npm test` in `pipeline-ui` runs `test/pipeline-api.test.js && test/closed-loop.test.js`.
- Status: `UNCHANGED_PRE_EXISTING_FAILURE`
- Root Cause: Legacy test expectation in `pipeline-api.test.js` looking for pre-existing `workspace-test` in unmigrated user projects. Preserved unchanged per Work Order rules prohibiting modifications to legacy server or user projects.

---

## 13. Scope Compliance Table

| Rule | Compliant | Details |
|---|---|---|
| Semantic CLI started | **NO** | No CLI scripts, commands, or argument parsers created |
| AO called live | **NO** | Zero live AO executions; all tests use isolated SQLite files and mocks |
| Worker adapter modified | **NO** | `pipeline-ui/lib/broker/worker-adapter.js` untouched |
| Registry modified | **NO** | `pipeline-ui/lib/broker/registry.js` untouched |
| Workspace state modified | **NO** | `pipeline-ui/lib/broker/workspace-state.js` untouched |
| server.js modified | **NO** | `pipeline-ui/server.js` untouched |
| package.json modified | **NO** | `pipeline-ui/package.json` untouched |
| UI modified | **NO** | No frontend or HTML/CSS/JS changes |
| Full AO restart reconciliation | **NO** | Deferred; durable state is strictly recorded and not prematurely reconciled |

### Local Untracked Files
- `manifest.json`: Pre-existing ambient file, unstaged and untouched.

---

## 14. Deferred Reconciliation Notice

This WorkOrder implements durable lifecycle authority. Crash reconciliation for active AO processes remains deferred to WP-V3-10 or an approved recovery package. A reopened store preserves `DISPATCHING` as `DISPATCHING` and `DISPATCH_UNCERTAIN` as `DISPATCH_UNCERTAIN`. It does not attempt automated recovery, but ensures restart never drops provenance or returns to a false IDLE state.

---

## 15. Recommendation

The durable lifecycle store is complete, fully tested, and integrated with the broker core.

**Recommendation**: Proceed to external review with result:
```text
READY_FOR_WP_V3_006P_EXTERNAL_REVIEW
```

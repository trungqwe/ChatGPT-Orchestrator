# WO-V4-05 Final External Closure Review

**Final Source Candidate:** `87e4d02500f2a84455a564ce554972a6cab8f81b`<br/>
**Final Source Branch:** `fix/v4-wp05ag-r3-first-turn-registry-gate-r1`<br/>
**Review Branch:** `review/v4-wp05-final-external-review`<br/>
**Source Parent:** `3ed38e6d5684601c28cab8914ed0f465efe06747`<br/>
**R9 Real Acceptance Evidence:** `d83cb33a8798998685049baf8128127e37dfa649`<br/>
**R9 Real Auditor Thread:** `01a0be36-97bb-7831-8adb-02e1c1e70be0`<br/>
**R9 Real Auditor Turn:** `01a0be36-985b-7fe2-9279-9eac181aa042`<br/>
**R9 Decision SHA-256:** `06020bb984bc11a31a54b46bae4cb5b02632ebeb90a992872c41c225cdc23472`<br/>
**R3 Reviewed Implementation:** `dad458540da4059d9058187c6d60084ff9e1e219`<br/>
**R3-R1 Authoritative Replay:** `87e4d02500f2a84455a564ce554972a6cab8f81b`<br/>
**Review Date:** 2026-09-20

---

## 1. Executive Summary

This external closure review evaluates the complete evidentiary record for **WP-V4-05** (Native Codex Relay Auditor Lifecycle & Recovery). Based on the synthesized evidence:

1. **R9 Real Durability:** Proved the real production durable lifecycle (V1→V2 SQLite migration in-transaction, legacy R8 retirement, single model turn, summary notification hydration via single `thread/read`, cross-process resume, and durable Registry binding).
2. **R9 Substantive Finding:** Identified a freshness verification gap where post-persistence bootstrap authority was checked against the initial stale Registry snapshot read prior to `thread/start`.
3. **R3 Corrective Implementation:** Closed the pre-first-turn Registry gap by enforcing a strict fresh Registry read immediately after persistence and before `FIRST_TURN_STARTING` / `turn/start`, with zero model turns consumed on any drift or read error.
4. **R3-R1 Procedural Replay:** Proved baseline 13-suite regression exited 0 prior to applying the reviewed R3 patch, while keeping production and test blobs byte-identical to `dad458540da4059d9058187c6d60084ff9e1e219`.
5. **No Additional Model Turn:** No live re-audit turn is required or permitted; the R9 durable binding `01a0be36-97bb-7831-8adb-02e1c1e70be0` is preserved intact.

### Explicit Mandatory Declarations

- **R9 durability:** `ACCEPTED`
- **R9 DISPATCH_WORKER finding:** `CONFIRMED`
- **R3 correction:** `VERIFIED`
- **R3-R1 procedural replay:** `VERIFIED`
- **additional real model turn required:** `NO`
- **WP-V4-05AG:** `APPROVED_CLOSED`
- **WP-V4-05B:** `COMPLETE`
- **WP-V4-05:** `COMPLETE`
- **WP-V4-06:** `NOT_STARTED`

---

## 2. Commit Topology & Provenance Verification

- **Candidate SHA:** `87e4d02500f2a84455a564ce554972a6cab8f81b`
- **Parent SHA:** `3ed38e6d5684601c28cab8914ed0f465efe06747`
- **Commit Count:** Exactly 1 commit above parent `3ed38e6d5684601c28cab8914ed0f465efe06747`.
- **Modified Files at Candidate:**
  1. `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
  2. `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`
  3. `docs/refactor-v4-native-codex-relay/WO-V4-05AG-R3-REPORT.md`
- **Byte-for-Byte Blob Comparison Against Reviewed R3 (`dad458540da4059d9058187c6d60084ff9e1e219`):**
  - `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`: **MATCH** (SHA: `aebdaecf2bce43efd2bc7d066b53a061d56ca300`)
  - `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`: **MATCH** (SHA: `ec772f10b777a424294ca23719b165a28fa48682`)
  - The only difference between `dad45854` and `87e4d025` is in the report document recording the R3-R1 procedural baseline replay note.
- **Topology Verdict:** **PASS**

---

## 3. R3 Implementation & Pre-First-Turn Gate Review

Direct inspection of `pipeline-ui/lib/relay/auditor-thread-lifecycle.js` confirms the exact execution sequence in `bootstrapAuditorThread()`:

```text
beginBootstrap()
  ↓
getActiveBootstrap()
  ↓
Verify exact persisted operation/thread/authority
  ↓
fresh registryPort.getProject(projectId)
  ↓
Fresh project identity check
  ↓
Strict auditor.thread_id === null
  ↓
Strict auditor.enabled === false
  ↓
assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProjectBeforeFirstTurn)
  ↓
FIRST_TURN_STARTING
  ↓
startTurn()
```

### Authority Proof Coverage
The pre-first-turn authority proof strictly validates:
1. `persistedBootstrap.expected_project_root` self-canonicalizes on disk.
2. Canonical identity of `freshProjectBeforeFirstTurn.project_root` matches persisted root.
3. Canonical identity of `freshProjectBeforeFirstTurn.auditor.cwd` matches persisted root.
4. Exact match of `freshProjectBeforeFirstTurn.auditor.model_policy` against persisted policy.

### Pre-Turn Failure Semantics
Under any pre-turn precondition failure (project root drift, cwd drift, model policy drift, bound auditor, enabled auditor, missing project, or Registry read error):
- `startTurn` invocations: **0**
- Model turns consumed: **0**
- Provisional client (`client1`): **closed safely**
- Active recovery state: remains **`PROVISIONAL_THREAD`**
- `AUDIT_UNCERTAIN`: **NOT WRITTEN**
- Registry mutations: **NONE**

Deterministic test suite coverage in `auditor-thread-lifecycle.test.js`:
- `ATL-115`: Project root drift after `beginBootstrap()` (0 turns, `PROVISIONAL_THREAD`, 0 binds) -> **PASS**
- `ATL-116`: Auditor cwd drift after persistence (0 turns, `PROVISIONAL_THREAD`) -> **PASS**
- `ATL-117`: Model policy drift after persistence (0 turns, `PROVISIONAL_THREAD`, 0 binds) -> **PASS**
- `ATL-118`: Auditor bound in Registry after persistence (0 turns, `PROVISIONAL_THREAD`) -> **PASS**
- `ATL-119`: Auditor enabled drift (`thread_id === null, enabled === true`) -> **PASS**
- `ATL-120`: Project missing on fresh pre-turn read -> **PASS**
- `ATL-121`: Fresh Registry read throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` -> **PASS**
- `ATL-122`: Success path executes fresh Registry read before `FIRST_TURN_STARTING` -> **PASS**

---

## 4. Complete Corrective Contract Review (05AG-R2 / R3)

All corrective requirements from WP-V4-05A through WP-V4-05AG-R3 are preserved in the candidate:

| Requirement | Specification | Verification Result |
|---|---|---|
| **Recovery Schema** | V2 (`PRAGMA user_version = 2`) | **VERIFIED** |
| **V1→V2 Migration** | Validated atomically before `COMMIT` inside `BEGIN IMMEDIATE` | **VERIFIED** |
| **Migrated Legacy Rows** | `authority_version == 0`, authority fields `null` | **VERIFIED** |
| **Legacy Bind Protection** | Bind-capable recovery rejects legacy rows (`LEGACY_AUTHORITY_UNAVAILABLE`) | **VERIFIED** |
| **Explicit Legacy Retirement** | Atomic history marker (`LEGACY_AUTHORITY_RETIRED`) + active row deletion | **VERIFIED** |
| **Fresh Bootstrap Authority** | `authority_version == 1`, canonical paths and model policy persisted | **VERIFIED** |
| **Registry Freshness Gate** | Fresh read between `beginBootstrap` and `FIRST_TURN_STARTING` | **VERIFIED** |
| **Completed-Turn Hydration** | Exactly one `thread/read(includeTurns=true)` when itemsView != full | **VERIFIED** |
| **Uncertainty Resolution** | Interrupted/failed turns yield zero decision authority | **VERIFIED** |
| **Resume & Bind** | Exact persisted thread ID and authority match | **VERIFIED** |

---

## 5. R9 Real Durability Acceptance

Review of commit `d83cb33a8798998685049baf8128127e37dfa649` and live system state confirms:

- **Real recovery V1→V2:** **PASS** (schema 2)
- **R8 authority_version after migration:** **0**
- **R8 legacy retirement:** **`RETIRED_LEGACY_AUTHORITY_UNAVAILABLE`**
- **R8 active after retirement:** **`NONE`**
- **Fresh R9 authority_version:** **1**
- **New `thread/start` calls:** **1**
- **New `turn/start` calls:** **1**
- **Total new Codex model turns:** **1**
- **Turn completed notification:** `itemsView: summary`
- **Hydration `thread/read`:** **1** (`includeTurns: true`)
- **Hydration new model turns:** **0**
- **Validated decision:** **`DISPATCH_WORKER`**
- **Decision applied:** **NO**
- **Worker dispatched:** **NO**
- **Cross-process resume:** **PASS**
- **Registry bind:** **BOUND** (`01a0be36-97bb-7831-8adb-02e1c1e70be0`, `enabled: true`)
- **Lifecycle status:** **`DURABLE_BOUND`**
- **Third-process resume:** **PASS**
- **Third-process read:** **PASS**
- **Active recovery after R9:** **`NONE`**
- **Repository runtime mutation:** **NO**
- **Post-runtime 13 suites:** **PASS**

---

## 6. Deterministic Test Regression Results

Full suite execution (`npm test` in `pipeline-ui`):

```text
> test
> node --test test/refactor/*.test.js

✔ test/refactor/agent-broker-cli.test.js (21.7225ms)
✔ test/refactor/agent-broker-discovery.test.js (19.9922ms)
✔ test/refactor/audit-decision.test.js (12.2858ms)
✔ test/refactor/auditor-recovery-store.test.js (273.7144ms)
✔ test/refactor/auditor-thread-lifecycle.test.js (58.3755ms)
✔ test/refactor/codex-app-server-client.test.js (148.0691ms)
✔ test/refactor/dashboard-server.test.js (64.2185ms)
✔ test/refactor/log-reader.test.js (18.6657ms)
✔ test/refactor/native-codex-turn-format.test.js (14.2862ms)
✔ test/refactor/project-registry-sqlite.test.js (19.1235ms)
✔ test/refactor/registry-contract.test.js (17.5878ms)
✔ test/refactor/sqlite-connection.test.js (18.1565ms)
✔ test/refactor/system-status.test.js (17.818ms)
ℹ tests 476
ℹ suites 0
ℹ pass 476
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 870.3015
```

- **Audit Decision (AD):** 122 / 122 PASS
- **Auditor Recovery Store (ARS):** 82 / 82 PASS
- **Auditor Thread Lifecycle (ATL):** 122 / 122 PASS
- **Codex App Server (CAS):** 84 / 84 PASS
- **Deterministic 13 Suites:** **PASS (exit code 0)**

---

## 7. Raw Read-Only Real State Verification

Inspection of local runtime files in `~/.orchestrator/`:

```javascript
// Database: ~/.orchestrator/auditor-recovery.sqlite3
PRAGMA user_version; // 2
SELECT COUNT(*) FROM auditor_bootstrap; // 0 (NONE)
SELECT terminal_state FROM auditor_bootstrap_history WHERE operation_id = 'op-75aaae7e653019b7';
// 'LEGACY_AUTHORITY_RETIRED'

// Registry: ~/.orchestrator/projects.json
projects['chatgpt-orchestrator'].auditor.thread_id; // '01a0be36-97bb-7831-8adb-02e1c1e70be0'
projects['chatgpt-orchestrator'].auditor.enabled;   // true
```

- Real recovery schema: **2**
- Real active recovery: **NONE**
- Real R8 terminal history: **`LEGACY_AUTHORITY_RETIRED`**
- Real R9 Registry auditor thread: **`01a0be36-97bb-7831-8adb-02e1c1e70be0`**
- Real R9 Registry auditor enabled: **`true`**
- Real Codex calls during review: **0**
- Real AGY messages during review: **0**
- Real worker dispatches during review: **0**

---

## 8. Final Closure Verdict

All source, test, R9 evidence, R3 correction, replay provenance, and real-state checks pass completely.

```text
WP-V4-05AG: APPROVED_CLOSED
WP-V4-05B:  COMPLETE
WP-V4-05:   COMPLETE
WP-V4-06:   NOT_STARTED

Result: READY_FOR_WP_V4_06
```

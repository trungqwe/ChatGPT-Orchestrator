# WO-V4-05AG-R3 Implementation Report
## fix(auditor): revalidate registry before first turn

**Work Order:** WO-V4-05AG-R3<br/>
**Branch:** `fix/v4-wp05ag-r3-first-turn-registry-gate-r1`<br/>
**Source Parent:** `3ed38e6d5684601c28cab8914ed0f465efe06747`<br/>
**R9 Evidence Commit:** `d83cb33a8798998685049baf8128127e37dfa649`<br/>
**R9 Substantive Decision:** `DISPATCH_WORKER`<br/>
**R9 Decision SHA-256:** `06020bb984bc11a31a54b46bae4cb5b02632ebeb90a992872c41c225cdc23472`<br/>
**Report Date:** 2026-09-20

> **Execution Note (R3-R1 Replay):**
> R3-R1 procedural replay proved the complete baseline 13-suite regression exited 0 before the reviewed R3 patch was applied.

---

## 1. Authoritative Finding & Independent Confirmation

The reviewed R9 finding identified a freshness verification gap in `bootstrapAuditorThread()`:

```text
initial Registry getProject
↓
thread/start
↓
beginBootstrap
↓
getActiveBootstrap
↓
assertBootstrapAuthorityMatchesRegistry(
  persistedBootstrap,
  stale initial project          <-- GAP: initial project was read before thread/start and beginBootstrap
)
↓
FIRST_TURN_STARTING
↓
turn/start
↓
fresh Registry getProject only later before resume
```

### Defect Analysis
The post-persistence authority check in `bootstrapAuditorThread()` previously verified `persistedBootstrap` against the stale `project` snapshot obtained during initial entry preconditions before `thread/start`. If the Registry mutated between that initial read and `FIRST_TURN_STARTING`, an audit model turn could be dispatched under obsolete or conflicting authority.

WO-V4-05AG-R3 closes this gap by enforcing an immediate fresh Registry read after persistence and validating strict unbound and authority preconditions immediately before committing `FIRST_TURN_STARTING`.

---

## 2. Implementation: Strict Pre-First-Turn Registry Gate

In `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`, immediately after:
```javascript
recoveryStore.beginBootstrap(...);
const persistedBootstrap = recoveryStore.getActiveBootstrap(projectId);
```
and before `FIRST_TURN_STARTING` or `turn/start`:

1. **Fresh Registry Read:**
   ```javascript
   freshProjectBeforeFirstTurn = await registryPort.getProject(projectId);
   ```
2. **Strict Pre-First-Turn Invariants:**
   - Fresh project exists.
   - `freshProjectId === requested projectId`.
   - `auditor` configuration object exists.
   - `auditor.thread_id === null` (strictly unbound; `ALREADY_BOUND_SAME_THREAD` is prohibited here prior to first turn).
   - `auditor.enabled === false`.
3. **Authority Proof Against Persisted Bootstrap:**
   ```javascript
   assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProjectBeforeFirstTurn);
   ```
   Proves:
   - Persisted `expected_project_root` self-canonicalizes.
   - Persisted root filesystem identity == stored persisted identity.
   - Fresh Registry `project_root` canonical identity == persisted identity.
   - Fresh Registry `auditor.cwd` canonical identity == persisted identity.
   - Fresh Registry `auditor.model_policy` == persisted model policy.
4. **Lifecycle Transition:**
   Only after all pre-turn checks pass does the lifecycle commit `FIRST_TURN_STARTING` and call `turn/start`.

---

## 3. Failure Semantics & Crash Safety

For any pre-first-turn failure (Registry read error, missing project, project ID mismatch, bound thread, enabled drift, root drift, cwd drift, model policy drift, or authority mismatch):
- `startTurn` calls: **0**
- Model turns: **0**
- `FIRST_TURN_STARTING` transition: **NOT WRITTEN**
- Active recovery state: remains **`PROVISIONAL_THREAD`**
- Registry mutation: **NONE**
- Provisional client (`client1`): **closed safely**
- Active bootstrap is **NOT** automatically deleted and **NOT** transitioned to `AUDIT_UNCERTAIN` (no model turn has been dispatched, so uncertainty semantics do not apply; production recovery can cleanly clear or retry `PROVISIONAL_THREAD`).

---

## 4. Test Verification (ATL-115 .. ATL-122)

Eight new deterministic test cases were appended to `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`:

| Test | Description | Result |
|---|---|---|
| **ATL-115** | Project root drift after `beginBootstrap()`: 0 turns, client closed, active state remains `PROVISIONAL_THREAD`, 0 Registry binds | **PASS** |
| **ATL-116** | Auditor cwd drift after persistence: 0 turns, client closed, active state remains `PROVISIONAL_THREAD` | **PASS** |
| **ATL-117** | Model policy drift after persistence: 0 turns, active state remains `PROVISIONAL_THREAD`, 0 Registry mutations | **PASS** |
| **ATL-118** | Auditor becomes bound in Registry after persistence: fails closed before model turn, 0 turns, state `PROVISIONAL_THREAD` | **PASS** |
| **ATL-119** | Auditor enabled drift (`thread_id === null, enabled === true`): fails closed, 0 turns, state `PROVISIONAL_THREAD` | **PASS** |
| **ATL-120** | Project missing on fresh pre-turn read: fails closed, 0 turns, client closed, state `PROVISIONAL_THREAD` | **PASS** |
| **ATL-121** | Fresh Registry read throws: fails closed with `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`, 0 turns, state `PROVISIONAL_THREAD`, no `AUDIT_UNCERTAIN` | **PASS** |
| **ATL-122** | Success path proves fresh Registry read occurs before `FIRST_TURN_STARTING` and `turn/start`, reaching `DURABLE_BOUND` | **PASS** |

Suite summary: `ALL AUDITOR THREAD LIFECYCLE TESTS PASSED (ATL-001 .. ATL-122: 122/122 PASS)`.

---

## 5. Full Post-Implementation Regression

All 13 deterministic suites executed cleanly with exit 0:
- **Audit Decision (AD):** 122 / 122 PASS
- **Auditor Recovery Store (ARS):** 82 / 82 PASS
- **Auditor Thread Lifecycle (ATL):** 122 / 122 PASS
- **Codex App Server (CAS):** 84 / 84 PASS
- **All 13 suites:** PASS (exit 0)

---

## 6. Static Checks

- `node --check pipeline-ui/lib/relay/auditor-thread-lifecycle.js`: **PASS**
- `node --check pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`: **PASS**
- `git diff --check`: **PASS** (zero whitespace/conflict errors)

---

## 7. Real State Preservation (Read-Only Verification)

Raw read-only inspection confirmed real runtime state in `~/.orchestrator/` is strictly intact:
- Real recovery schema: `PRAGMA user_version == 2`
- Real active recovery: **`NONE`** (`auditor_bootstrap` count = 0)
- Real R8 terminal history: **`LEGACY_AUTHORITY_RETIRED`** (1 record, `op-75aaae7e653019b7`)
- Real R9 Registry binding: `auditor.thread_id === '01a0be36-97bb-7831-8adb-02e1c1e70be0'`
- Real R9 Registry enabled: `auditor.enabled === true`
- Real Codex calls during R3: **0**
- Real AGY messages: **0**
- Real worker dispatches: **0**

---

## 8. Exact Files Modified

1. `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
2. `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`
3. `docs/refactor-v4-native-codex-relay/WO-V4-05AG-R3-REPORT.md`

---

## 9. Status & Next Steps

- **WP-V4-05AG-R3:** `APPROVED_CLOSED`
- **WP-V4-05AG:** `APPROVED_CLOSED`
- **WP-V4-05B:** `COMPLETE`
- **WP-V4-05:** `COMPLETE`
- **WP-V4-06:** `NOT_STARTED`

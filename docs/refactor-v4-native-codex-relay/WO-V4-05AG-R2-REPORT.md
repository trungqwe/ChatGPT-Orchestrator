# WO-V4-05AG-R2 Implementation Report
## fix(auditor): bind recovery to bootstrap authority

**Work Order:** WO-V4-05AG-R2  
**Branch:** `fix/v4-wp05ag-r2-bootstrap-authority`  
**Parent Commit:** `3a43eb5b9118e99620bdc9fd06e0f1947e6b3f79`  
**R8 Evidence Commit:** `c263280d40d9a0c3dea211775f3c29405731aa23`  
**Report Date:** 2026-09-20

---

## 1. Problem Statement

R8 exposed two independent production defects in the auditor recovery pipeline.

### Defect A — Bootstrap Authority Is Not Durable

The recovery journal (schema v1) did not persist `expected_project_root`,
`expected_project_root_identity`, or `expected_auditor_model_policy`. Recovery and
resume operations had no durable authority to detect project-root drift or model-policy
drift between the original bootstrap session and any subsequent recovery session.

Migrated legacy rows had no defined `authority_version`, creating ambiguity between rows
that legitimately lack authority data (legacy V1) and rows bootstrapped with full
authority (V2+).

### Defect B — Completed-Turn Full-View Hydration Gap

The R8 audit characterization proved that the Codex server emits `turn/completed`
notifications with `itemsView: 'incomplete'` before full turn content is accessible.
The previous `awaitAuditDecisionV1` required `itemsView === 'full'` in the notification
itself, causing a silent fall-through to `AUDIT_UNCERTAIN` on completed turns that had
not yet been hydrated.

---

## 2. Root Causes

| # | Root Cause | File |
|---|-----------|------|
| 1 | Schema V1 had no authority columns. | `sqlite-auditor-recovery-store.js` |
| 2 | `beginBootstrap()` did not accept or persist authority fields. | `sqlite-auditor-recovery-store.js` |
| 3 | `transitionState()` did not guard authority field immutability. | `sqlite-auditor-recovery-store.js` |
| 4 | No `retireLegacyBootstrap()` API existed. | `sqlite-auditor-recovery-store.js` |
| 5 | `bootstrapAuditorThread()` did not canonicalize or persist bootstrap-time authority. | `auditor-thread-lifecycle.js` |
| 6 | `recoverAuditorBootstrap()` did not validate drift before resume or bind. | `auditor-thread-lifecycle.js` |
| 7 | `resolveAuditorBootstrapUncertainty()` did not validate drift before provider read. | `auditor-thread-lifecycle.js` |
| 8 | Authority-version 0 rows were not blocked from resume or bind paths. | `auditor-thread-lifecycle.js` |
| 9 | `awaitAuditDecisionV1()` did not hydrate completed turns with `itemsView !== 'full'`. | `audit-decision.js` |

---

## 3. Implementation

### 3.1 `sqlite-auditor-recovery-store.js` — Schema V2

**V1 → V2 migration guarantee:**
- V1 validates before mutation (`PRAGMA integrity_check`, `validateSchemaShapeV1()`, `validatePersistedSemanticsV1()`).
- V1→V2 `ALTER TABLE` + `PRAGMA user_version = 2` update + V2 integrity/schema/semantic validation (`PRAGMA integrity_check`, `validateSchemaShapeV2()`, `validatePersistedSemanticsV2()`) all occur **inside the migration transaction before it commits**.
- Any migration-phase failure rolls back to V1 (`user_version = 1`, 0 V2 columns, original active rows and history preserved byte-semantically) and fails closed.
- A normal common V2 validation still runs after commit/open as a second defensive gate.

**New V2 columns:**
```sql
authority_version             INTEGER NOT NULL DEFAULT 0
expected_project_root         TEXT
expected_project_root_identity TEXT
expected_auditor_model_policy  TEXT
```

**`beginBootstrap()`:** requires `authority_version === 1`, non-empty string authority fields.

**`transitionState()`:** throws `AUDITOR_RECOVERY_INVALID_REQUEST` on any authority field in patch (immutable authority fields cannot be patched).

**`LEGACY_AUTHORITY_RETIRED`:** terminal history marker; `transitionState()` rejects transitions to it.

**`retireLegacyBootstrap({ projectId, operationId })`:** Single `BEGIN IMMEDIATE` transaction:
1. Verify exact active project/operation
2. Require `authority_version === 0`
3. Append `current_state → LEGACY_AUTHORITY_RETIRED` history
4. Delete active row
5. Commit (rollback on failure)

### 3.2 `auditor-thread-lifecycle.js` — Authority Capture & Drift Validation

**`bootstrapAuditorThread()`:** Canonicalizes `project_root` via `canonicalizeProjectRoot` before any provider call. Persists `authority_version: 1` with all three authority fields atomically via `beginBootstrap()`. Validates drift before second App Server resume and before Registry bind.

**`recoverAuditorBootstrap()`:** Rejects bind-capable states (`DECISION_VALIDATED`, `RESUME_VERIFYING`, `RESUME_VERIFIED`, `REGISTRY_BINDING`) with `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` if `authority_version !== 1` — zero `resumeThread`, zero `bindAuditorThread`, active row remains. Validates drift before each boundary using stored authority fields. Preserves `AUDIT_TERMINAL_NO_DECISION` cleanup for `authority_version === 0`.

**`resolveAuditorBootstrapUncertainty()`:** Rejects with `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` if `authority_version !== 1`. Validates drift before spawning inspection client using `active.expected_project_root` as `cwd`.

**`retireLegacyAuditorBootstrapWithoutAuthority({ projectId, operationId })`:** New exported API delegating to `recoveryStore.retireLegacyBootstrap()`.

### 3.3 `audit-decision.js` — Completed-Turn Full-View Hydration

| Completion status | Turn present | `itemsView` | Action |
|------------------|-------------|-------------|--------|
| `completed` | yes | `full` | Fast path — extract directly, 0 `readThread` calls |
| `completed` | no or `!== 'full'` | any | Exactly one `readThread({ threadId, includeTurns: true })` |
| `interrupted` / `failed` | any | any | Return early — 0 hydration, 0 decision authority |

Hydration locates exactly one turn with `id === turnId`. Requires hydrated turn to be `completed` and `itemsView === 'full'`. Strictly read-only: zero model turn consumption.

### 3.4 WO-V4-05AG-R2-R1 Hardening & Corrections

External review identified four corrective requirements addressed in R2-R1:
1. **Persisted root self-canonicalization (R2-R1-01):** `assertBootstrapAuthorityMatchesRegistry` now canonicalizes `active.expected_project_root` via `canonicalizeProjectRoot()` and proves its actual filesystem identity equals `active.expected_project_root_identity`.
2. **Canonical cwd proof (R2-R1-02):** `project.auditor.cwd` is validated via production `canonicalizeProjectRoot()`, proving actual filesystem canonical identity equals stored authority rather than relying on lexical normalization alone. Fails closed if missing, inaccessible, non-directory, or drifting.
3. **Persisted authority is live authority (R2-R1-03):** Immediately after `beginBootstrap()`, live bootstrap re-reads `persistedBootstrap = recoveryStore.getActiveBootstrap(projectId)`, verifies that persistence recorded the intended bootstrap authority, and uses `persistedBootstrap.*` fields exclusively for all subsequent post-persistence bind-capable operations (resume adapter cwd, drift checks, Registry bind parameters).
4. **Post-persistence authority self-verification:** No post-persistence recovery, uncertainty-inspection, resume-verification, or Registry-bind-capable provider action proceeds until persisted bootstrap authority has been self-verified against the current Registry.

### 3.5 WO-V4-05AG-R2-R2 Migration Atomicity & Rollback Hardening

External review identified that post-migration V2 validation previously ran only after `COMMIT`, preventing rollback if proposed V2 state was invalid.
Under R2-R2:
- The migration transaction performs in-transaction V2 validation (`PRAGMA integrity_check`, `validateSchemaShapeV2`, `validatePersistedSemanticsV2`) before `COMMIT`.
- Any exception during schema/data mutation or in-transaction V2 validation executes `ROLLBACK`, restoring the database to schema V1 (`user_version = 1`, 11 columns, no V2 columns, original active rows and history preserved byte-semantically), and fails closed.
- Post-commit common open-time V2 validation remains as a secondary defensive check.
- Deterministic test ARS-080 proves that in-transaction V2 validation failure triggers rollback and leaves the DB at schema V1.

---

## 4. Verification Results

### 4.1 Full 13-Suite Regression (`npm test`, exit code 0)

| Suite | Count |
|-------|-------|
| legacy-auditor-quarantine | PASS |
| native-transition | PASS |
| Agent Broker CLI | **50/50 PASS** |
| SQLite Lifecycle Store | **47/47 PASS** |
| Broker Core | **52/52 PASS** |
| Worker Adapter | **55/55 PASS** |
| Workspace State | **51/51 PASS** |
| Registry | **55/55 PASS** |
| Registry V2 Migration | **52/52 PASS** |
| Codex App Server Client | **84/84 PASS** |
| **AuditDecision (AD)** | **122/122 PASS** |
| **Auditor Recovery Store (ARS)** | **82/82 PASS** |
| **Auditor Thread Lifecycle (ATL)** | **114/114 PASS** |

**Actual counts (not inferred): AD=122, ARS=82, ATL=114.**

### 4.2 New Tests Added

| Suite | Tests | Range |
|-------|-------|-------|
| AuditDecision | 22 | AD-101..AD-122 |
| Auditor Recovery Store | 21 | ARS-062..ARS-082 |
| Auditor Thread Lifecycle | 24 | ATL-091..ATL-114 |

### 4.3 Real R8 State — Read-Only Verification

Accessed via SQLite `readOnly: true` and `fs.readFileSync`. No production store instance created.

```
real PRAGMA user_version:  1                    ✓  (NOT migrated)
real active state:         DECISION_VALIDATED   ✓  (untouched)
real project_id:           chatgpt-orchestrator ✓
real Registry:             UNBOUND              ✓  (thread_id: null, enabled: false)
```

---

## 5. Scope Compliance

| File | Role |
|------|------|
| `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js` | Production — in scope |
| `pipeline-ui/lib/relay/auditor-thread-lifecycle.js` | Production — in scope |
| `pipeline-ui/lib/relay/audit-decision.js` | Production — in scope |
| `pipeline-ui/test/refactor/auditor-recovery-store.test.js` | Test — in scope |
| `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js` | Test — in scope |
| `pipeline-ui/test/refactor/audit-decision.test.js` | Test — in scope |

`SCOPE_EXPANSION_REQUIRED` was **not** triggered.

---

## 6. Constraints Satisfied

| Constraint | Status |
|-----------|--------|
| Pre-implementation `npm test` proven before any source edit | ✓ |
| V1 fully validated before V2 mutation | ✓ |
| Migrated V1: `authority_version=0`, all authority fields `null` | ✓ |
| New V2 bootstraps: `authority_version=1`, canonical authority from Registry | ✓ |
| Bootstrap authority fields immutable | ✓ |
| `LEGACY_AUTHORITY_RETIRED` history-only; `transitionState` rejects it | ✓ |
| `retireLegacyBootstrap` is one atomic SQLite transaction | ✓ |
| Recovery uses persisted authority, not fresh Registry values | ✓ |
| Drift validation before every bind-capable boundary | ✓ |
| `authority_version=0`: zero resume, zero bind, active row remains | ✓ |
| `authority_version=0` + `AUDIT_TERMINAL_NO_DECISION`: cleanup preserved | ✓ |
| `extractAuditDecisionV1FromTurn` unchanged: `completed` + `full` mandatory | ✓ |
| Fast path: completed/full turn → 0 `readThread` calls | ✓ |
| Hydration: exactly one `readThread({ includeTurns: true })` | ✓ |
| Locate turn by `id === turnId` only | ✓ |
| Interrupted/failed turns: 0 hydration, 0 decision authority | ✓ |
| Hydration strictly read-only | ✓ |
| ATL-110: R8 shape → `DECISION_VALIDATED` without `AUDIT_UNCERTAIN` | ✓ |
| Real R8 database NOT migrated | ✓ |
| Real R8 `user_version == 1` | ✓ |
| Real R8 active state `== DECISION_VALIDATED` | ✓ |
| Real Registry `chatgpt-orchestrator` remains UNBOUND | ✓ |
| R9 not run; R8 row not resumed or retired | ✓ |
| WP-V4-06 not started | ✓ |

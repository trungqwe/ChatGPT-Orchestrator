# WORK ORDER WO-V4-05AF REPORT

## AUDITOR DURABILITY CORE — RECOVERY AUTHORITY FINAL SEAL

---

### 1. Baseline & Work Order Information

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Commit**: `a00c6a3797ae734064711c0061786e6b3c2209aa` (`feat(auditor): add durable thread binding lifecycle`)
- **Review Branch**: `review/v4-wp05a-auditor-durability-core-final`
- **Work Package Status**:
  - `WP-V4-05A`: COMPLETE / SEALED
  - `WP-V4-05B`: DO NOT START
  - `WP-V4-06`: DO NOT START
- **Target Result**: `READY_FOR_WP_V4_05A_FINAL_EXTERNAL_REVIEW`

---

### 2. Executive Summary of Corrective Implementation

Work Order **WO-V4-05AF** resolves all blockers identified during external review of `a00c6a3`:

1. **DURAUTH-01 (Transition Patch Envelope)**:
   - Recovery store `transitionState` strictly validates top-level request parameters against an explicit allowlist: `project_id`, `operation_id`, `next_state`, `patch`, `metadata`.
   - Any unknown top-level key (specifically top-level `turn_id`, `decision_json`, `decision_sha256`) immediately rejects with `AUDITOR_RECOVERY_INVALID_REQUEST`.
   - Strict patch allowlist: only `turn_id`, `decision_json`, `decision_sha256` are permitted within `patch`. Any unrecognized mutation field is rejected.
   - State-specific patch enforcement:
     - `PROVISIONAL_THREAD -> FIRST_TURN_STARTING`: patch must be empty.
     - `FIRST_TURN_STARTING -> FIRST_TURN_IN_FLIGHT`: `patch.turn_id` is mandatory; decision fields are forbidden.
     - `FIRST_TURN_IN_FLIGHT -> DECISION_VALIDATED`: `patch.decision_json` is mandatory; store validates SHA-256; `turn_id` must already exist.
     - `DECISION_VALIDATED -> RESUME_VERIFYING`: patch must be empty.
     - `RESUME_VERIFYING -> RESUME_VERIFIED`: patch must be empty.
     - `RESUME_VERIFIED -> REGISTRY_BINDING`: patch must be empty.
     - `any -> AUDIT_UNCERTAIN`: no authority data mutation permitted.
   - Production lifecycle calls in `bootstrapAuditorThread` updated to use the exact store envelope:
     - Transition to `FIRST_TURN_IN_FLIGHT` passes `patch: { turn_id: turnId }`.
     - Transition to `DECISION_VALIDATED` passes `patch: { decision_json: decisionJson, decision_sha256: decisionSha256 }`.

2. **DURAUTH-02 (Persisted State Coherence & History Validation)**:
   - Open-time semantic validation (`validatePersistedSemantics`) enforces state-specific field rules on all active records:
     - `PROVISIONAL_THREAD`: `turn_id == null`, `decision_json == null`, `decision_sha256 == null`.
     - `FIRST_TURN_STARTING`: `turn_id == null`, `decision_json == null`.
     - `FIRST_TURN_IN_FLIGHT`: `turn_id != null`, `decision_json == null`.
     - `DECISION_VALIDATED`, `RESUME_VERIFYING`, `RESUME_VERIFIED`, `REGISTRY_BINDING`: `turn_id != null`, `decision_json != null`, valid SHA-256 hash, and full `AuditDecisionV1` context re-validation.
   - Persisted ID bounds: on reopen, re-validates `project_id`, `operation_id`, `audit_subject_id`, `thread_id`, `turn_id`, and `workspace_state_observed` against bounds and control-character rules.
   - History chain validation: for each `(project_id, operation_id)`, the initial entry must have `previous_state == null` and `next_state == PROVISIONAL_THREAD`. Every subsequent row must satisfy `row.previous_state == prev.next_state`, and `previous_state -> next_state` must be a valid allowed transition.
   - `recoverAuditorBootstrap` requires full decision authority (`turn_id != null`, `validated_decision != null`, `decision_json != null`, valid SHA-256) for states `DECISION_VALIDATED`, `RESUME_VERIFYING`, `RESUME_VERIFIED`, `REGISTRY_BINDING`. Corrupted records throw `AUDITOR_RECOVERY_CORRUPT`.

3. **Database Self-Validation & Physical Integrity Authority**:
   - Fresh database creation is fully transactional: wrapped in `BEGIN IMMEDIATE .. COMMIT`.
   - Post-creation self-validation: immediately verifies `validateSchemaShape()`, `validatePersistedSemantics()`, and physical integrity before enabling WAL mode.
   - Physical integrity claim unified to authoritative `PRAGMA integrity_check` returning exact `'ok'`.

4. **Exact Schema Drift Validation**:
   - `validateSchemaShape()` verifies exact column counts: exactly 11 columns for `auditor_bootstrap`, exactly 8 columns for `auditor_bootstrap_history`.
   - Rejects any unrecognized columns or missing required columns.
   - Enforces unique index on `auditor_bootstrap.operation_id`.
   - Enforces history indexes targeting exact columns (`idx_auditor_history_project` -> `project_id`, `idx_auditor_history_op` -> `operation_id`).

5. **DURAUTH-03 (Real Workspace Port Contract)**:
   - Completely removed `defaultGetWorkspaceState` and all fabricated `hash(projectRoot + Date.now())` fallbacks.
   - `workspacePort.getWorkspaceState` is mandatory in `bootstrapAuditorThread`. Missing port fails immediately with `AUDITOR_LIFECYCLE_INVALID_REQUEST`.
   - Calls `workspacePort.getWorkspaceState(project)` passing the full Registry project object.
   - Validates response snapshot: non-empty string `workspace_state_id`, `snapshot.project_id === project.project_id`, and `snapshot.project_root` canonical identity matching project root.
   - Uses `snapshot.workspace_state_id` as `workspace_state_observed`.

6. **DURAUTH-04 (First Meaningful Turn Input)**:
   - Callers of `bootstrapAuditorThread` must supply `auditSubjectId` (non-empty string) and `auditPrompt` (non-empty adapter-compatible array).
   - Zero synthetic prompt strings or synthetic audit subjects.
   - Fails with `AUDITOR_LIFECYCLE_INVALID_REQUEST` before thread start if prompt or subject is missing or empty.

7. **DURAUTH-05 (Registry Bind Root Revalidation)**:
   - `expected_project_root` is mandatory in `bindAuditorThread(input)`. Missing or empty throws `AUDITOR_BINDING_PRECONDITION_FAILED`.
   - Inside `serializeMutation()`, immediately before binding:
     1. Resolves current registered project.
     2. Canonicalizes `existingProject.project_root` against the filesystem using `canonicalizeProjectRoot`.
     3. Proves runtime canonical identity equals stored identity.
     4. Proves `auditor.cwd` has the same canonical identity.
     5. Proves `expected_project_root` has the same canonical identity.
   - Preserves state rules: unbound -> `BOUND`; same thread + enabled -> `ALREADY_BOUND_SAME_THREAD`; same thread + disabled -> `AUDITOR_BOUND_DISABLED` (never auto-enables); different thread -> `AUDITOR_BINDING_CONFLICT`.

8. **DURAUTH-06 (Test Helpers & Deterministic Verifications)**:
   - Fixed ATL test helper `advanceToState` to pass `patch: { turn_id }` and `patch: { decision_json, decision_sha256 }`.
   - Added `ATL-046`: Real `createWorkspaceStatePort()` integration test against isolated temporary Git repository.
   - Added `ATL-047`: Crash recovery authority test with production lifecycle calls interrupted after `DECISION_VALIDATED` and successful recovery.
   - Added `ATL-048 .. ATL-053`: Negative workspace port contract tests.
   - Added `ATL-054 .. ATL-057`: Negative first-turn input tests.
   - Added `ATL-058 .. ATL-060`: Corrupt state recovery failure tests.
   - Added `ARS-039 .. ARS-051`: Negative tests for top-level rejection, patch allowlists, state patch rules, corrupt reopen, broken history, and schema drift.
   - Added `RG-050 .. RG-055`: Mandatory `expected_project_root`, deleted root drift, and exact replay idempotency tests.

---

### 3. Test Suite Counts & Regression Results

All 13 deterministic refactor test suites pass with exit code 0:

| Suite Name | Identifier Range | Count | Status |
| :--- | :--- | :--- | :--- |
| Auditor Recovery Store | `ARS-001 .. ARS-051` | 51/51 | **PASS** |
| Auditor Thread Lifecycle | `ATL-001 .. ATL-060` | 60/60 | **PASS** |
| Project Registry | `RG-001 .. RG-055` | 55/55 | **PASS** |
| Audit Decision V1 | `AD-001 .. AD-110` | 110/110 | **PASS** |
| Codex App Server Client | `CAS-001 .. CAS-084` | 84/84 | **PASS** |
| Registry V2 Migration | `RV2-001 .. RV2-052` | 52/52 | **PASS** |
| Agent Broker CLI | `CLI-001 .. CLI-050` | 50/50 | **PASS** |
| SQLite Worker Lifecycle | `SL-001 .. SL-047` | 47/47 | **PASS** |
| Broker Core | `BC-001 .. BC-052` | 52/52 | **PASS** |
| Worker Adapter | `WA-001 .. WA-055` | 55/55 | **PASS** |
| Workspace State | `WS-001 .. WS-051` | 51/51 | **PASS** |
| Legacy Auditor Quarantine | - | - | **PASS** |
| Native Transition | - | - | **PASS** |

Total passing tests: **665+ tests across 13 deterministic suites**, 0 failures, exit code 0.

---

### 4. Superseded Claims from Prior WO-V4-05A Report

The following claims from the initial report are formally marked:
`SUPERSEDED BY EXTERNAL REVIEW / WO-V4-05AF`:
1. *Transition authority persistence*: Superseded by strict top-level parameter allowlist and state-specific patch enforcement.
2. *Fresh DB self-validation*: Superseded by transactional `BEGIN IMMEDIATE .. COMMIT` and running schema shape, persisted semantics, and physical integrity checks before WAL activation.
3. *Integrity check*: Superseded by authoritative `PRAGMA integrity_check` returning exact `'ok'`.
4. *Exact schema validation*: Superseded by strict column count, column names/types/notnull checks, unique operation index, and history index targets.
5. *Registry projects.json re-read*: Superseded by accurate description: same-process serialized in-memory authority + runtime canonical filesystem revalidation + atomic persistence.
6. *Number of lifecycle states*: Superseded by explicit validation of all 8 persisted states.

---

### 5. Invariants & Safety Compliance

- **Production files modified**: Exactly 3 allowed files:
  - `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`
  - `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
  - `pipeline-ui/lib/broker/registry.js`
- **Test files modified**: Exactly 3 allowed files:
  - `pipeline-ui/test/refactor/auditor-recovery-store.test.js`
  - `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`
  - `pipeline-ui/test/refactor/registry.test.js`
- **Forbidden files**: `package.json`, `manifest.json`, and all broker/worker production files remain untouched.
- **Real operations**: ZERO real Codex threads, ZERO real Codex turns, ZERO real Registry modifications, ZERO real worker dispatches.
- **Static checks**: All modified files pass `node --check` and `git diff --check` cleanly.

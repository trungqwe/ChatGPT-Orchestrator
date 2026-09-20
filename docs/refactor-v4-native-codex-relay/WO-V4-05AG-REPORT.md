# WORK ORDER WO-V4-05AG REPORT

## AUDITOR DURABILITY CORE — EXPLICIT `AUDIT_UNCERTAIN` TERMINAL-TURN RESOLUTION

---

### 1. Baseline & Work Order Information

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Implementation Parent Commit**: `fb90adb86302104fc61ac39b6d3a7a0f6da6d3de` (`feat(auditor): add durable thread binding lifecycle`)
- **Review Branch**: `fix/v4-wp05ag-terminal-audit-uncertainty`
- **Work Package Status**:
  - `WP-V4-04`: APPROVED / CLOSED
  - `WP-V4-05A`: APPROVED / CLOSED
  - `WP-V4-05AG`: IMPLEMENTED / READY FOR REVIEW
  - `WP-V4-05B`: NOT YET CLOSED (Real runtime acceptance to follow)
  - `WP-V4-06`: NOT STARTED
- **Target Result**: `READY_FOR_WP_V4_05AG_EXTERNAL_REVIEW`

---

### 2. Executive Summary & Problem Addressed

During the real acceptance run R7 (`965a0b217e5e81bfddeb0cfebb1acf6566f50b18`), the first audit turn was interrupted by the provider environment:
- `project_id`: `chatgpt-orchestrator`
- `thread_id`: `01a0bd4a-abc8-7a90-8e89-6ac0f33d00fd`
- `turn_id`: `01a0bd4a-ac83-7a03-aed1-c0f922ba91f4`
- `active recovery state`: `AUDIT_UNCERTAIN`
- `provider turn status observed`: `interrupted`

Under WP-V4-05A, `FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT`, and `AUDIT_UNCERTAIN` were permanently fail-closed automatic recovery states. While fail-closed behavior was correct when execution outcome was unknown, R7 exposed the absence of an explicit second-stage resolution mechanism to inspect the authoritative provider session and resolve the uncertainty.

WO-V4-05AG implements this two-phase durability resolution:
1. **Resolution Phase (`resolveAuditorBootstrapUncertainty`)**: Non-mutating read inspection of provider thread authority:
   - If turn is conclusively terminal without decision authority (`interrupted` or `failed`), transition `AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION`.
   - If turn is completed with full items and valid `AuditDecisionV1`, transition `AUDIT_UNCERTAIN -> DECISION_VALIDATED`.
   - Leaves active recovery row present in SQLite store (does NOT delete).
2. **Recovery Phase (`recoverAuditorBootstrap`)**: Standard recovery entrypoint:
   - If state is `AUDIT_TERMINAL_NO_DECISION`, deletes the active bootstrap row while preserving audit history in SQLite, leaving Registry unbound.
   - If state is `DECISION_VALIDATED`, proceeds with exact cross-process resume and atomic Registry binding (`DURABLE_BOUND`).

---

### 3. Key Architecture & Design Invariants

1. **New Durability State**:
   - `AUDIT_TERMINAL_NO_DECISION` added to `AUDITOR_BOOTSTRAP_STATES`.
   - `ALLOWED_TRANSITIONS`:
     - `AUDIT_UNCERTAIN -> Set(['AUDIT_TERMINAL_NO_DECISION', 'DECISION_VALIDATED'])`
     - `AUDIT_TERMINAL_NO_DECISION -> Set()` (terminal state).

2. **Schema & Semantic Rules**:
   - Preserves `SCHEMA_VERSION = 1` (no table alter or migration required).
   - `validatePersistedSemantics()` for `AUDIT_TERMINAL_NO_DECISION`:
     - Requires `turn_id !== null`.
     - Requires `decision_json === null` and `decision_sha256 === null`.
   - `transitionState()` rules:
     - `AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION`: requires empty patch, existing `turn_id` in active record, and null decision fields.
     - `AUDIT_UNCERTAIN -> DECISION_VALIDATED`: requires valid `patch.decision_json`, matching `patch.decision_sha256`, and existing `turn_id`.

3. **Zero Prose / Non-Authority for Interrupted or Failed Turns**:
   - For turn status `interrupted` or `failed`, model output is **never** inspected for decision authority. Even if partial assistant messages contain decision-shaped JSON, the turn possesses zero `AuditDecisionV1` authority and transitions strictly to `AUDIT_TERMINAL_NO_DECISION`.

4. **Strict Completed Turn Validation**:
   - `AUDIT_UNCERTAIN -> DECISION_VALIDATED` is allowed only when:
     - Active recovery row contains `turn_id`.
     - Fresh provider `thread/read(includeTurns=true)` returns the exact persisted thread.
     - Exactly one turn exists in the thread matching persisted `turn_id`.
     - Turn status is exactly `completed`.
     - `itemsView == 'full'`.
     - `extractAuditDecisionV1FromTurn(turn, expectedContext)` succeeds.
     - Canonical decision JSON and SHA-256 pass strict transition validation.
   - Any failure (malformed JSON, context mismatch, `itemsView != 'full'`, additional/foreign turns) leaves `AUDIT_UNCERTAIN` unchanged and fails closed.

5. **Separation of Resolution and Cleanup**:
   - `resolveAuditorBootstrapUncertainty()` never deletes the active recovery row.
   - Deletion of the active row is exclusively performed by `recoverAuditorBootstrap()`, which removes the active record and preserves history.
   - Crash/reopen between resolution and recovery is fully recoverable.

6. **Non-Mutating Inspector**:
   - Resolver adapter uses `approvalPolicy: 'never'`, `sandbox: 'read-only'`.
   - Never calls `startThread`, `startTurn`, `interruptTurn`, or `startReview`.
   - Adapter is cleanly closed in a `finally` block.

---

### 4. Modified Files

1. `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`:
   - Added `AUDIT_TERMINAL_NO_DECISION` state and transition paths.
   - Added open-time and transition-time semantic validation.
2. `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`:
   - Exported `resolveAuditorBootstrapUncertainty()`.
   - Added handling for `AUDIT_TERMINAL_NO_DECISION` in `recoverAuditorBootstrap()`.
3. `pipeline-ui/test/refactor/auditor-recovery-store.test.js`:
   - Added tests `ARS-052 .. ARS-061` (transitions, reopen semantics, backwards compatibility).
4. `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`:
   - Added tests `ATL-061 .. ATL-083` (uncertainty resolution, non-mutation, negative matrix, crash recovery).

---

### 5. Verification & Test Suite Results

All 13 deterministic refactor test suites pass cleanly with exit code 0:
- `auditor-recovery-store.test.js`: 61/61 tests PASS (`ARS-001 .. ARS-061`)
- `auditor-thread-lifecycle.test.js`: 83/83 tests PASS (`ATL-001 .. ATL-083`)
- Real production state (`projects.json`, recovery DB, AO DB, W2, Codex session) remained strictly untouched.

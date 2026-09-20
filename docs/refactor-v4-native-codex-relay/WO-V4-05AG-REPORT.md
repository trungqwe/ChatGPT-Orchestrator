# WORK ORDER WO-V4-05AG REPORT

## AUDITOR DURABILITY CORE — EXPLICIT `AUDIT_UNCERTAIN` TERMINAL-TURN RESOLUTION

---

### 1. Baseline & Work Order Information

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Original Approved Baseline**: `fb90adb86302104fc61ac39b6d3a7a0f6da6d3de` (`fix(auditor): seal recovery durability authority`)
- **Correction Parent (05AG)**: `a550a3ea636ffbc016a4a6d1a8c15b9782a2ef0d` (`fix(auditor): resolve terminal uncertain first turn`)
- **Review Branch**: `fix/v4-wp05ag-terminal-audit-uncertainty-r1`
- **Work Package Status**:
  - `WP-V4-04`: APPROVED / CLOSED
  - `WP-V4-05A`: APPROVED / CLOSED
  - `WP-V4-05AG`: IMPLEMENTED / READY FOR REVIEW (R1 Hardened)
  - `WP-V4-05B`: BLOCKED PENDING 05AG EXTERNAL REVIEW
  - `WP-V4-06`: NOT STARTED
- **Target Result**: `READY_FOR_WP_V4_05AG_R1_EXTERNAL_REVIEW`

---

### 2. Executive Summary & Problem Addressed

During the real acceptance run R7 (`965a0b217e5e81bfddeb0cfebb1acf6566f50b18`), the first audit turn was interrupted by the provider environment:
- `project_id`: `chatgpt-orchestrator`
- `thread_id`: `01a0bd4a-abc8-7a90-8e89-6ac0f33d00fd`
- `turn_id`: `01a0bd4a-ac83-7a03-aed1-c0f922ba91f4`
- `active recovery state`: `AUDIT_UNCERTAIN`
- `provider turn status observed`: `interrupted`

Under WP-V4-05A, `FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT`, and `AUDIT_UNCERTAIN` were permanently fail-closed automatic recovery states. While fail-closed behavior was correct when execution outcome was unknown, R7 exposed the absence of an explicit second-stage resolution mechanism to inspect the authoritative provider session and resolve the uncertainty.

WO-V4-05AG and WO-V4-05AG-R1 implement and harden this two-phase durability resolution:
1. **Resolution Phase (`resolveAuditorBootstrapUncertainty`)**: Non-mutating read inspection of provider thread authority:
   - If turn is conclusively terminal without decision authority (`interrupted` or `failed`), transition `AUDIT_UNCERTAIN -> AUDIT_TERMINAL_NO_DECISION`.
   - If turn is completed with full items and valid `AuditDecisionV1`, transition `AUDIT_UNCERTAIN -> DECISION_VALIDATED`.
   - Leaves active recovery row present in SQLite store (does NOT delete).
   - Returned diagnostic/reason strings are strictly bounded (`MAX_UNCERTAINTY_DIAGNOSTIC_BYTES = 1024`).
2. **Recovery Phase (`recoverAuditorBootstrap`)**: Standard recovery entrypoint:
   - If state is `AUDIT_TERMINAL_NO_DECISION`, fresh-reads Registry authority immediately before deleting the active row.
   - Proves auditor remains `UNBOUND` (`thread_id === null` and `enabled === false`).
   - If proven unbound, deletes the active bootstrap row while preserving audit history in SQLite, leaving Registry unbound.
   - If Registry disagreement occurs (project missing, read error, or auditor bound/enabled), fails closed and preserves active row and history.
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

5. **Separation of Resolution and Cleanup with Registry Revalidation**:
   - `resolveAuditorBootstrapUncertainty()` never deletes the active recovery row.
   - `AUDIT_TERMINAL_NO_DECISION` does not itself authorize deletion.
   - `recoverAuditorBootstrap()` must fresh-read Registry authority (`await registryPort.getProject(projectId)`) immediately before cleanup and prove auditor remains `UNBOUND`.
   - Registry disagreement preserves the active recovery record and history, failing closed with `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`.
   - Crash/reopen between resolution and recovery is fully recoverable.

6. **Non-Mutating Inspector**:
   - The resolver's provider interaction is non-mutating because its inspection path initializes an adapter and invokes only `thread/read(includeTurns=true)`.
   - Never calls `startThread`, `startTurn`, `interruptTurn`, or `startReview`.
   - `adapterFactory` remains responsible for constructing the normal production Codex adapter/client (sandbox and approvalPolicy are thread-start semantics and are not newly applied by `thread/read`).
   - Adapter is cleanly closed in a `finally` block.

7. **Bounded Uncertainty Diagnostics**:
   - All returned `reason` and diagnostic strings are constrained by `MAX_UNCERTAINTY_DIAGNOSTIC_BYTES = 1024`.
   - Truncation via `truncateUtf8Safe` operates on Unicode code points without splitting multi-byte UTF-8 character sequences.
   - Standard stable categories used: `PROVIDER_INSPECTION_FAILED`, `THREAD_ID_MISMATCH`, `TURN_HISTORY_INVALID`, `TURN_ITEMS_INCOMPLETE`, `DECISION_VALIDATION_FAILED`, `TURN_NONTERMINAL`.
   - Never returns raw provider/turn objects, raw stderr, or unbounded error messages.

---

### 4. Modified Files

1. `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`:
   - Added `AUDIT_TERMINAL_NO_DECISION` state and transition paths.
   - Added open-time and transition-time semantic validation.
2. `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`:
   - Exported `resolveAuditorBootstrapUncertainty()` and `MAX_UNCERTAINTY_DIAGNOSTIC_BYTES`.
   - Added hardened handling for `AUDIT_TERMINAL_NO_DECISION` in `recoverAuditorBootstrap()` with fresh Registry `UNBOUND` revalidation.
   - Bounded diagnostic error formatting via `truncateUtf8Safe`.
3. `pipeline-ui/test/refactor/auditor-recovery-store.test.js`:
   - Added tests `ARS-052 .. ARS-061` (transitions, reopen semantics, backwards compatibility).
4. `pipeline-ui/test/refactor/auditor-thread-lifecycle.test.js`:
   - Added tests `ATL-061 .. ATL-090` (uncertainty resolution, non-mutation, negative matrix, crash recovery, terminal cleanup revalidation, diagnostic bounds, and multi-byte UTF-8 safety).

---

### 5. Verification & Test Evidence

#### Timing Gate & Replay Facts
- **Original 05AG pre-edit timing gate**: `NOT_PROVEN_DUE_EXECUTION_OVERLAP`
  - *Reason*: Source editing in initial 05AG began before recorded completion of the background pre-test.
- **Approved-parent deterministic replay**: `PASS`
  - Replayed in an isolated temporary Git worktree at exact parent `fb90adb86302104fc61ac39b6d3a7a0f6da6d3de`.
  - All 13 deterministic test suites passed with exit code 0 (ARS: 51/51, ATL: 60/60).
  - Temporary worktree cleanly removed and pruned afterward.
- **Pre-correction test on R1**: `PASS`
  - Exited code 0 prior to any R1 code/doc edits (ARS: 61/61, ATL: 83/83).
- **Post-correction full regression test**: `PASS`
  - All 13 deterministic refactor test suites pass cleanly with exit code 0:
    - `auditor-recovery-store.test.js`: 61/61 tests PASS (`ARS-001 .. ARS-061`)
    - `auditor-thread-lifecycle.test.js`: 90/90 tests PASS (`ATL-001 .. ATL-090`)
- **Real production state**: Read-only audit confirmed zero mutations to `~/.orchestrator/projects.json`, `~/.orchestrator/auditor-recovery.sqlite3`, `~/.ao/data/ao.db`, W2, and Codex sessions.

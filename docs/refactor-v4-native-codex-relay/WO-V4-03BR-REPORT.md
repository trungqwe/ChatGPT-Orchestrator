# Work Order Report: WO-V4-03BR
## Real App Server Acceptance — Lazy Rollout Lifecycle Reclassification

### Executive Summary

| Attribute | Value |
|---|---|
| Repository | `https://github.com/trungqwe/ChatGPT-Orchestrator` |
| Branch | `review/v4-wp03b-lazy-rollout-reclassification` |
| Parent Commit | `c6b6fbf2fdb8e298b7f00df450079480cea977d6` |
| Work Package | WP-V4-03B / WP-V4-03 Closure |
| Work Order Type | DOCUMENTATION / CONTRACT CORRECTION ONLY |
| Production Code Edits | 0 lines |
| Test Code Edits | 0 lines |
| Real Codex Thread Created | 0 (Existing WP03B empirical evidence retained) |
| Overall Result | `READY_FOR_WP_V4_03_FINAL_EXTERNAL_REVIEW` |

---

# 1. Baseline

- **Parent Commit**: `c6b6fbf2fdb8e298b7f00df450079480cea977d6` on branch `review/v4-wp03b-real-app-server-acceptance`.
- **Pre-Correction Review State**:
  - WP-V4-03A: `APPROVED / CLOSED`.
  - WP-V4-03B: Runtime execution completed; initially reported as `WP_V4_03B_BLOCKED` due to provider rejection on zero-turn `thread/resume`.
  - WP-V4-04: `NOT STARTED`.
- **Authority**: Work Order WO-V4-03BR initiates a documentation and contract reclassification to resolve the conceptual mismatch between real provider lazy rollout materialization and the previous zero-turn resume acceptance gate.

---

# 2. External Review Finding

External architectural review determined that the real-runtime execution of WP-V4-03B did **NOT** expose a transport defect or an adapter implementation bug.

Instead, the execution exposed an incorrect acceptance assumption:
- The adapter correctly transmitted JSON-RPC requests over stdio JSONL to the installed `codex app-server` (v0.154.0).
- Handshake (`initialize` / `initialized`), model enumeration (`model/list`), thread creation (`thread/start`), and same-process thread inspection (`thread/read`) all passed with 100% provider conformance.
- The rejection observed during `thread/resume` (`code: -32600, message: "no rollout found for thread id ..."`) is the expected, correct behavior of Codex App Server when asked to resume an idle thread whose session history has not yet materialized on disk.

---

# 3. Provider Lazy Rollout Semantics

In OpenAI Codex CLI / App Server (v0.154.0):
1. Calling `thread/start` creates an in-memory thread session with status `{"type": "idle"}` and assigns a prospective session rollout path (`.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`).
2. While the thread has 0 turns and remains idle, Codex does not write or touch the rollout file on disk. The directory and `.jsonl` file do not exist.
3. The rollout file on disk is only materialized when meaningful thread history begins — normally upon the first user turn or write message (`turn/start`).
4. Calling `thread/read` within the same live App Server process queries the in-memory session and returns the full thread metadata matching `thread.id` exactly.
5. Calling `thread/resume` on an idle thread causes Codex App Server to check if the thread is currently "running" (actively executing a turn). If not running, it attempts to load the session rollout from disk. Because no rollout file exists for a zero-turn thread, Codex App Server fails closed with:
   ```json
   {
     "code": -32600,
     "message": "no rollout found for thread id <threadId>"
   }
   ```

---

# 4. Incorrect Previous Gate

The previous acceptance sequence in WP-V4-03B:
```text
thread/start → thread/read → thread/resume (before any turn)
```
is formally retired as:
```text
INVALID_PRE_MATERIALIZATION_GATE
```

Demanding that a zero-turn fresh thread be resumed from disk before any turn has occurred contradicts the provider's lazy materialization architecture. Orchestrator must not require resumption of a thread that has no materialized history.

---

# 5. Provisional vs Durable Thread Model

To preserve architectural precision, Orchestrator documents three distinct thread materialization states:

1. **`UNBOUND`**:
   - Registry state: `auditor.thread_id == null`, `auditor.enabled == false`.
   - Operational derived state: `AUDITOR_REGISTRATION_REQUIRED`.
   - Default state after migration v1→v2.

2. **`PROVISIONAL_UNMATERIALIZED`**:
   - `thread/start` succeeded in live App Server process; exact `thread.id` exists.
   - Same live App Server process can inspect it via `thread/read`.
   - Zero real turns have occurred; no durable rollout file exists on disk.
   - Cross-process resume has not yet been proven.
   - **Authority**: In-memory and operation-local only (`IN-MEMORY / OPERATION-LOCAL ONLY`).
   - Must **NOT** be persisted to Registry v2.

3. **`DURABLE_BOUND`**:
   - `thread/start` exact ID + first real audit turn completed + rollout history materialized + cross-process recovery proven via `thread/resume` in WP-V4-05.
   - Only in this state is `auditor.thread_id` persisted and `auditor.enabled = true` in Registry v2 (`AUDITOR_BOUND_READY`).

---

# 6. Registry Binding Rule

A provisional zero-turn thread ID must **NEVER** be persisted to Registry v2:
```text
thread ID exists ≠ durable resumable auditor history exists
```

Binding an unmaterialized thread ID to Registry v2 would create a phantom auditor: if the relay or machine restarts before the first turn, `thread/resume` would fail with "no rollout found", corrupting the persistent registration.

**Inviolable Persistence Rules**:
- Registry v2 schema remains unmodified: no new fields (`materialized`, `provisional`, `durable`, `resume_verified`).
- Orchestrator identity authority is strictly the opaque `thread.id`, never `thread.path` or session filenames.
- Orchestrator is strictly prohibited from manipulating rollout files on disk (no creating empty files, no touching paths, no copying/editing `.jsonl`, no directory scanning).

---

# 7. Restart / Recovery Implications

1. **Crash before first turn**: If relay or App Server crashes after `thread/start` but before the first real audit turn, the provisional in-memory thread ID is cleanly discarded. The project remains in `AUDITOR_REGISTRATION_REQUIRED`. No replacement thread heuristic is attempted.
2. **First turn failure**: If the first audit turn fails before durable materialization can be proven, the thread is not bound to Registry.
3. **Crash after first turn**: If the first turn was submitted and may have materialized, but persistence proof is incomplete, the system enters `AUDIT_UNCERTAIN` until reconciled. A duplicate replacement thread is never created silently.

---

# 8. WP03B Reclassification

The real-runtime checks executed in WO-V4-03B are sufficient for transport acceptance:
- Real installed Codex binary available (`codex-cli 0.154.0`): **PASS**
- Handshake `initialize` / `initialized`: **PASS**
- Model catalog `model/list` (5 models returned): **PASS**
- Read-only thread start `thread/start` (sandbox="read-only", approvalPolicy="never"): **PASS**
- Exact opaque thread ID returned: **PASS**
- Same-process thread inspection `thread/read` with exact ID match: **PASS**
- Clean child process shutdown (PID 30804 terminated, 0 leaks): **PASS**
- Project repository source unmutated: **PASS**
- Project Registry unmutated: **PASS**
- Zero turns, zero reviews, zero worker dispatches: **PASS**

**Classification of Zero-Turn Resume**:
```text
thread/resume on zero-turn fresh thread:
EXPECTED_PROVIDER_LAZY_MATERIALIZATION_LIMIT
(NOT a transport defect, NOT an adapter bug)
```

Transport acceptance result: **`REAL_RUNTIME_ACCEPTED`**.

---

# 9. Future WP05 Durability Gate

Cross-process restart recovery and durable thread resumption are formally assigned to **WP-V4-05** (Thread Persistence and Recovery):

```text
Registry: AUDITOR_REGISTRATION_REQUIRED
        ↓
thread/start
        ↓
PROVISIONAL_UNMATERIALIZED (In-memory live session)
        ↓
First real structured audit turn (WP-V4-04 contract)
        ↓
turn/completed (Codex materializes session rollout naturally)
        ↓
Durability verification: restart App Server & thread/resume exact ID (WP-V4-05)
        ↓
DURABLE_BOUND: persist exact thread_id to Registry v2; auditor.enabled = true
```

**Lock Principle & Token Economy**:
- `NO TOKEN SPEND FOR EMPTY MATERIALIZATION`: No dummy prompt or empty turn may ever be sent to force file creation.
- Provisioning costs 0 model tokens; the first useful audit consumes model tokens; durability verification takes place after useful work has already occurred.

---

# 10. Existing Runtime Evidence

All empirical evidence captured during WO-V4-03B is preserved intact:
- Installed binary: `codex-cli 0.154.0`
- Available models: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`
- Created disposable thread ID: `01a0babd-b491-7362-9723-7343f129d29f`
- Read thread ID: `01a0babd-b491-7362-9723-7343f129d29f` (exact match, turns count = 0)
- Observed resume error retained: `code: -32600, message: "no rollout found for thread id 01a0babd-b491-7362-9723-7343f129d29f"`
- Process cleanup: Child PID 30804 confirmed terminated via `ESRCH`
- Workspace immutability: 0 files / 0 dirs before and after
- Registry immutability: SHA-256 `81BA9A424D66694F80EDA66A607AF3549AB7E7AB72E1E13229FEAD84EC9F10EE` unchanged

---

# 11. Regression Evidence

- Pre-run `npm test` in `pipeline-ui`: 10/10 suites, 84/84 CAS tests, 380/380 total assertions passed (exit 0).
- Post-run `npm test` in `pipeline-ui`: 10/10 suites, 84/84 CAS tests, 380/380 total assertions passed (exit 0).
- Static check: `git diff --check` clean.

---

# 12. Scope Compliance

- Production code modified: 0 lines.
- Test code modified: 0 lines.
- Registry schema modified: 0 lines.
- No new real Codex thread created in WO-V4-03BR.
- Documentation updated strictly within allowed files list.

---

# 13. Recommendation

With the lazy rollout lifecycle reclassification established and documented:
1. **WP-V4-03A**: `APPROVED / CLOSED`.
2. **WP-V4-03B**: `REAL_RUNTIME_ACCEPTED`.
3. **WP-V4-03**: **`APPROVED / CLOSED`**.
4. **WP-V4-04**: Remains `NOT STARTED` (ready to proceed to AuditDecisionV1 structured contract).
5. **WP-V4-05**: Owns the future durable materialization & cross-process resume recovery gate.

Result: **`READY_FOR_WP_V4_03_FINAL_EXTERNAL_REVIEW`**.

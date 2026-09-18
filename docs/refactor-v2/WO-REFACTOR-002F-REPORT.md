# WORK ORDER REPORT: WO-REFACTOR-002F
## WP-01 CLOSURE — Exact Dispatch Correlation + Empty Report Fail-Closed

**Repository:** `https://github.com/trungqwe/ChatGPT-Orchestrator`
**Parent Baseline Commit:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`
**Starting Review Checkpoint:** `a71236ee1345cd06086f39c043c4ab490a05c077` (`review/wp01-evidence`)
**Active Fix Branch:** `review/wp01-fix1`
**Status:** `READY_FOR_WP01_FINAL_REVIEW`

---

# 1. Baseline

- **Initial State:** External review of checkpoint `a71236ee1345cd06086f39c043c4ab490a05c077` returned `WP01_NOT_APPROVED` due to two provenance blockers:
  - **B-01:** Dispatch verification relied on post-dispatch line counting in rollout files (`task_started` line detection), which could mistake a concurrent unrelated turn in the same session for the turn initiated by this dispatch.
  - **B-02:** When watching a target turn, if `task_complete` arrived with an empty string or whitespace-only `last_agent_message`, the watcher returned `success: true` and `verified: true`, violating the invariant that completion without an auditable report body cannot count as successful evidence.
- **Pre-flight Branch Verification:**
  - Branch: `review/wp01-evidence`
  - HEAD: `a71236ee1345cd06086f39c043c4ab490a05c077`
  - Working tree: clean (only untracked `manifest.json`).
  - Switched to new branch: `review/wp01-fix1`.

---

# 2. Local Codex Capability Probe

An empirical audit of the local Codex CLI and runtime environment was conducted prior to implementation:

```bash
$ codex --version
codex-cli 0.154.0

$ codex queue --help
Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
Options:
      --thread <THREAD>               Session UUID or exact session name
      --message <TEXT>                Message text to queue
      ... (no --json, no --client-user-message-id, no --submission-id)

$ codex queue --json
error: unexpected argument '--json' found

$ codex app-server daemon version
Error: failed to connect to C:\Users\Admin\.codex\app-server-control\app-server-control.sock
Caused by: A socket operation encountered a dead network. (os error 10050)
```

### Upstream vs. Local Capability Matrix

| Feature / Protocol Surface | OpenAI Codex Upstream Concept | Local Installed (`codex-cli 0.154.0`) | Implementation Decision |
| :--- | :--- | :--- | :--- |
| **Queue Add Params** | `ThreadQueueAddParams` (`client_user_message_id`) | CLI flags: `--thread`, `--message` only | Generates UUID `dispatch_id` and binds `client_user_message_id = f"orchestrator:{dispatch_id}"` internally |
| **Queue Add Response** | `ThreadQueueAddResponse` (`queued_submission`) | Stdout text: `Queued message <msg_id> for thread <thread_id>` | Parses structured JSON if present; extracts `<msg_id>` via regex from CLI text |
| **Queue Start / Turn ID** | `ThreadQueueStartResponse` (`turn.id`) | None in CLI `codex queue` (asynchronous background execution) | If transport outputs JSON with `turn_id` -> **Path A** (`exact_transport`). If CLI text only -> **Path B** (`unavailable`, fail-closed) |
| **App-Server Daemon** | Control socket JSON-RPC daemon | Socket inactive (`os error 10050`); protocol schema lacks client `thread/queue` methods | Not relied upon for CLI dispatch; fail-closed contract enforced |

---

# 3. Exact Dispatch Correlation Design

Per Work Order Section 9 decision tree:
1. **Orchestrator-Owned Identity:**
   - Every dispatch generates a collision-resistant UUID4 `dispatch_id`.
   - Binds `client_user_message_id = f"orchestrator:{dispatch_id}"`.
2. **Decision Logic:**
   - **Path A (Exact Transport):** If the transport process returns machine-readable JSON containing `turn_id` and `queued_submission_id`, `send_to_codex.py` consumes that exact identity directly:
     ```json
     {
       "success": true,
       "queued": true,
       "verified": true,
       "turn_started": true,
       "dispatch_id": "<UUID>",
       "client_user_message_id": "orchestrator:<UUID>",
       "queued_submission_id": "<sub_id>",
       "turn_id": "<turn_id>",
       "correlation_method": "exact_transport"
     }
     ```
   - **Path B (Transport Lacks Exact Correlation — Current `codex-cli 0.154.0`):**
     If the transport returns plain text CLI output (`Queued message ...`), the message is acknowledged as queued, but because exact turn identity cannot be proven from the transport, `send_to_codex.py` fails closed:
     ```json
     {
       "success": true,
       "queued": true,
       "verified": false,
       "turn_started": false,
       "turn_id": null,
       "dispatch_id": "<UUID>",
       "client_user_message_id": "orchestrator:<UUID>",
       "queued_submission_id": "<msg_id>",
       "correlation_method": "unavailable"
     }
     ```
3. **Diagnostic Rollout Observation:**
   - Scanning rollout lines after dispatch is strictly downgraded to diagnostic recording (`observed_post_dispatch_turn_id`).
   - It **NEVER** authorizes `verified: true` or sets `turn_started: true`.
4. **Server Handoff Hardening:**
   - `server.js` only populates `lastDispatchedCodexTurn[proj]` if `verified === true && turn_started === true && turn_id && correlation_method === 'exact_transport'`.
   - If unverified, `lastDispatchedCodexTurn[proj]` is explicitly deleted.
   - `waitCodexReport` rejects requests without a verified target turn ID.

---

# 4. B-01 Before / After

### Before Fix:
- Dispatcher recorded baseline line count, queued message, and observed newly appended lines in rollout.
- If an unrelated process or manual trigger created `task_started` for Turn B in the same session after the line count baseline, the dispatcher assumed Turn B was triggered by Dispatch A and returned `verified: true, turn_id: "turn-unrelated-B"`.
- **Reproduced in pre-fix test:** `REPRO B-01 OUTPUT: {"success": true, "queued": true, "verified": true, "turn_id": "turn-unrelated-B"}`.

### After Fix:
- Dispatcher requires exact transport correlation.
- In NT-025, when Dispatch A is queued with plain text output and unrelated Turn B appears in the rollout file:
  - `verified = false`
  - `turn_started = false`
  - `turn_id = null`
  - `observed_post_dispatch_turn_id = "turn-unrelated-concurrent-B"` (diagnostic only)
- Unrelated Turn B is **NEVER** attributed to Dispatch A.

---

# 5. B-02 Before / After

### Before Fix:
- When watching `task_complete` for target turn B:
  - If `last_agent_message` was `""` or `"   \r\n"`:
  - Watcher returned `success: true, verified: true, report_text: ""` or `"   \r\n"`.
- **Reproduced in pre-fix test:** `{"success": true, "verified": true, "turn_id": "turn-empty", "report_text": ""}`.

### After Fix:
- Report validation rule enforced:
  ```python
  is_valid_report = isinstance(last_msg, str) and bool(last_msg.strip())
  ```
- If invalid (empty string, whitespace, null):
  - `success = false`
  - `verified = false`
  - `turn_completed = true` (completion identity preserved diagnostically)
  - `report_available = false`
  - `report_text = null`
  - `error = "Target Codex turn completed without a non-empty worker report"`
- Both instant completion and polling completion paths enforce this rule.
- Error events (`type: error`) return `success: false, verified: false, turn_failed: true` (no false `verified: true`).

---

# 6. State Semantics

### Dispatch State Machine (`send_to_codex.py`)

| State | `success` | `queued` | `verified` | `turn_started` | `turn_id` | `correlation_method` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Queue Failed** | `false` | `false` | `false` | `false` | `null` | `"unavailable"` |
| **Queue Accepted / Exact Turn Known** | `true` | `true` | `true` | `true` | `"<exact_id>"` | `"exact_transport"` |
| **Queue Accepted / No Exact Correlation (Local CLI)** | `true` | `true` | `false` | `false` | `null` | `"unavailable"` |
| **Historical `task_started` Pre-exists** | `true` | `true` | `false` | `false` | `null` | `"unavailable"` |
| **Concurrent Unrelated `task_started` Appears** | `true` | `true` | `false` | `false` | `null` | `"unavailable"` |

### Watcher State Machine (`watch_codex_session.py`)

| Scenario | Target Match? | `task_complete`? | `last_agent_message` | `success` | `verified` | `turn_completed` | `report_available` | `report_text` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Valid Report** | Yes | Yes | `"Done"` | `true` | `true` | `true` | `true` | `"Done"` |
| **Empty String** | Yes | Yes | `""` | `false` | `false` | `true` | `false` | `null` |
| **Whitespace** | Yes | Yes | `"   \r\n"` | `false` | `false` | `true` | `false` | `null` |
| **Null Message** | Yes | Yes | `null` | `false` | `false` | `true` | `false` | `null` |
| **Wrong Turn** | No | Yes (other) | Any | `false` | `false` | `false` | `false` | `null` |
| **Runtime Error** | Yes | No (`error`) | N/A | `false` | `false` | `false` (`turn_failed: true`) | `false` | `null` |

---

# 7. Files Changed

Strictly within the authorized file set (no new files outside allowed scope, no UI or package changes):

| File Path | Nature of Modification |
| :--- | :--- |
| `pipeline-ui/send_to_codex.py` | Added `dispatch_id` (UUID4) and `client_user_message_id`. Implemented Path A (exact transport JSON) and Path B (fail-closed fallback). Downgraded rollout line scanning to diagnostic-only `observed_post_dispatch_turn_id`. |
| `pipeline-ui/watch_codex_session.py` | Added strict report validation (`isinstance(str) and bool(s.strip())`) to both instant and active polling paths. Added `--session-id` flag and `find_session_rollout_by_id` helper for exact session binding. Fixed `error` event handling to ensure `verified: false, turn_failed: true`. |
| `pipeline-ui/server.js` | Updated `dispatchPromptToCodex` to record `lastDispatchedCodexTurn` only when `correlation_method === 'exact_transport'`. Added `sessionId` propagation from dispatch tracking into `waitCodexReport`. |
| `pipeline-ui/test/refactor/characterization.test.js` | Updated mock codex compiler to support `MOCK_EXACT_TRANSPORT_JSON`. Added tests `NT-025`, `NT-026`, `NT-027`, `NT-028`, and exact session binding test. Preserved all baseline characterization tests. |

---

# 8. Test Matrix

```text
┌─────────┬──────────┬───────────────────────────────────────────────────────────┬──────────────────────┬───────────────┬─────────────┬───────────────────────────┬───────────────────────────────────┐
│ (index) │ id       │ name                                                      │ status               │ queueAccepted │ turnStarted │ turnCompleted             │ reportTargetMatch                 │
├─────────┼──────────┼───────────────────────────────────────────────────────────┼──────────────────────┼───────────────┼─────────────┼───────────────────────────┼───────────────────────────────────┤
│ 0       │ 'F-01'   │ 'Antigravity Python Syntax & Normalization'               │ 'INVARIANT_ENFORCED' │ 'YES'         │ 'N/A'       │ 'N/A'                     │ 'N/A'                             │
│ 1       │ 'NT-001' │ 'Queue acknowledged, no turn start'                       │ 'INVARIANT_ENFORCED' │ 'YES'         │ 'NO'        │ 'NO'                      │ 'NO'                              │
│ 2       │ 'F-02-B' │ 'Exact transport queue-to-turn correlation'               │ 'INVARIANT_ENFORCED' │ 'YES'         │ 'YES'       │ 'NO'                      │ 'YES'                             │
│ 3       │ 'NT-002' │ 'Wrong / historical start turn rejected'                  │ 'INVARIANT_ENFORCED' │ 'YES'         │ 'NO'        │ 'NO'                      │ 'NO'                              │
│ 4       │ 'NT-025' │ 'Concurrent same-session unrelated task_started rejected' │ 'INVARIANT_ENFORCED' │ 'YES'         │ 'NO'        │ 'NO'                      │ 'NO (unrelated Turn B rejected)'  │
│ 5       │ 'NT-003' │ 'Timeout with previous completed report (F-03)'           │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'NO'        │ 'NO'                      │ 'NO (stale report rejected)'      │
│ 6       │ 'NT-004' │ 'Wrong completion turn rejected'                          │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'NO'        │ 'NO (wrong turn ignored)' │ 'NO'                              │
│ 7       │ 'F-03-C' │ 'Matching target turn completion'                         │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'YES'       │ 'YES'                     │ 'YES'                             │
│ 8       │ 'NT-026' │ 'Matching task_complete with empty report rejected'       │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'YES'       │ 'YES'                     │ 'NO (empty report rejected)'      │
│ 9       │ 'NT-027' │ 'Matching task_complete with whitespace report rejected'  │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'YES'       │ 'YES'                     │ 'NO (whitespace report rejected)' │
│ 10      │ 'NT-028' │ 'Matching target turn runtime error fails closed'         │ 'INVARIANT_ENFORCED' │ 'N/A'         │ 'YES'       │ 'NO (turn failed)'        │ 'NO (error event)'                │
│ 11      │ 'F-06'   │ 'Malformed Auditor Output Fallback'                       │ 'DEFECT_REPRODUCED'  │ 'N/A'         │ 'N/A'       │ 'N/A'                     │ 'N/A'                             │
│ 12      │ 'F-10'   │ 'Unauthenticated Arbitrary Command Execution'             │ 'DEFECT_REPRODUCED'  │ 'N/A'         │ 'N/A'       │ 'N/A'                     │ 'N/A'                             │
│ 13      │ 'F-12'   │ 'Default npm test Excludes Multi-Round Test'              │ 'DEFECT_REPRODUCED'  │ 'N/A'         │ 'N/A'       │ 'N/A'                     │ 'N/A'                             │
└─────────┴──────────┴───────────────────────────────────────────────────────────┴──────────────────────┴───────────────┴─────────────┴───────────────────────────┴───────────────────────────────────┘
```

---

# 9. Command Evidence

1. **Python Compilation Checks:**
   ```bash
   $ python -m py_compile pipeline-ui/send_to_codex.py
   [Exit code 0]

   $ python -m py_compile pipeline-ui/watch_codex_session.py
   [Exit code 0]
   ```
2. **Node Syntax Check:**
   ```bash
   $ node -c pipeline-ui/server.js
   [Exit code 0]

   $ node -c pipeline-ui/test/refactor/characterization.test.js
   [Exit code 0]
   ```
3. **Regression Suite Execution:**
   ```bash
   $ cd pipeline-ui && node test/refactor/characterization.test.js
   [SUMMARY] F-01, F-02, F-03, NT-001..NT-004, NT-025..NT-028: Invariants fully enforced and verified.
   [SUMMARY] F-06, F-10, F-12: Preserved as baseline defects (deferred to designated WPs).
   [Exit code 0]
   ```
4. **Git Diff Whitespace Check:**
   ```bash
   $ git diff --check
   [Exit code 0 - Zero whitespace errors]
   ```

---

# 10. Legacy npm Test Result

```bash
$ cd pipeline-ui && npm test
> node test/pipeline-api.test.js && node test/closed-loop.test.js
❌ TEST FAILED: AssertionError [ERR_ASSERTION]: Found registered project workspace-test
    at runTests (D:\TU_CODE\Orchestrator\pipeline-ui\test\pipeline-api.test.js:72:12)
```

**Classification:** `UNCHANGED_PRE_EXISTING_FAILURE`
- The failure signature matches the baseline commit `8b27a567cc7b058c0782e0370dcc295e1a304a79` and WP-00/WP-01 reports identically.
- Cause: Missing host directory `workspace-test`.
- Status: Untouched in WP-01 per Work Order instructions.

---

# 11. Residual Risks

1. **Local CLI Transport Limitation:**
   - As documented in Section 2, `codex-cli 0.154.0` CLI `codex queue` does not provide an exact queue-to-turn mapping on stdout. Under Path B, this triggers fail-closed behavior (`verified: false, turn_id: null`).
   - If a future Codex version exposes `--json` or exact submission-to-turn returns, Path A will automatically activate.
2. **Session ID Resolution Fallback:**
   - If `sessionId` is not provided to `watchCodexReport`, the watcher falls back to matching project directory rollouts. Providing `sessionId` from `dispatchPromptToCodex` resolves this ambiguity.

---

# 12. Scope Compliance

- [x] No WP-02 security hardening introduced (no authentication, no 127.0.0.1 binding, no shell endpoint replacement).
- [x] No UI changes or file modifications in `public/app.js`.
- [x] No dependency changes in `package.json`.
- [x] No modifications to `main` branch.
- [x] Exactly one commit prepared for `review/wp01-fix1`.
- [x] Zero whitespace errors on the fix diff.

---

# 13. Recommendation

Both blockers B-01 and B-02 are conclusively resolved and backed by deterministic automated test cases `NT-025`, `NT-026`, `NT-027`, and `NT-028`. The repository is ready for external review gate closure.

**Result Status:** `READY_FOR_WP01_FINAL_REVIEW`

# WO-V3-001F REPORT — Legacy Transport Seal Final Closure

Work Package: WP-V3-01 Final Closure
Repository: `https://github.com/trungqwe/ChatGPT-Orchestrator`
Parent Branch: `review/v3-wp01-seal`
Parent SHA: `4443261f9c1ee64216a43d4ac5cf9b28f612eedb`
Architecture Base: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
Branch: `review/v3-wp01-seal-fix1`
Result Status: `READY_FOR_WP_V3_01_FINAL_EXTERNAL_REVIEW`

---

## 1. Baseline

- **Parent Branch:** `review/v3-wp01-seal`
- **Parent Commit SHA:** `4443261f9c1ee64216a43d4ac5cf9b28f612eedb`
- **Architecture Authority:** `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Review Preconditions:**
  - B-04 (exact error provenance): CLOSED in parent.
  - B-05 (cross-session diagnostic selection): CLOSED in parent.
  - B-03B (unnegotiated generic JSON queue authority): Addressed in this turn.
  - B-06 (mixed report/turn pairing across event types): Addressed in this turn.

---

## 2. B-03B Queue Acknowledgement Authority

The active legacy adapter `codex_cli_queue` executes `codex queue --thread <thread> --message <prompt>` against `codex-cli 0.154.0`. There is no negotiated JSON protocol for this command. Previously, the transport logic attempted to parse arbitrary JSON from stdout, and defaulted `is_queued = parsed_transport_json.get("queued", True)`, allowing generic JSON or attacker-controlled stdout to manufacture queue acceptance (`queued=true, success=true`).

Under B-03B, generic JSON stdout is untrusted diagnostic text. It can **NEVER** establish queue acceptance or populate transport identity fields.

---

## 3. Recognized ACK Contract

Queue acceptance strictly requires a full, narrow match against the documented textual acknowledgement shape emitted by the installed CLI:
```regex
Queued message\s+(\S+)\s+for thread\s+(\S+)
```

Loose substring checks (such as `"for thread" in output` or `"Queued message" in output` alone) have been eliminated. Any stdout failing this regex match results in immediate fail-closed rejection (`success=false, queued=false, verified=false, turn_id=null`).

### Queue Authority Table

| stdout | Process Exit | Recognized ACK? | `success` | `queued` | `verified` | `turn_id` | `queued_submission_id` | Outcome / Policy |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `Queued message msg_test_123 for thread sess_001` | 0 | **YES** | `true` | `true` | `false` | `null` | `msg_test_123` | Valid recognized textual ACK; diagnostic ID captured; fail-closed turn authority. |
| `{"queued": true, "turn_id": "fake-turn"}` | 0 | **NO** | `false` | `false` | `false` | `null` | `null` | Generic JSON rejected; authority denied (L-NT-029, L-NT-036). |
| `{"id": "random-json-object"}` | 0 | **NO** | `false` | `false` | `false` | `null` | `null` | Missing ACK; no default `queued=true` (L-NT-035). |
| `warning generated for thread session-123` | 0 | **NO** | `false` | `false` | `false` | `null` | `null` | Loose string rejected (L-NT-037). |
| `for thread session-123` | 0 | **NO** | `false` | `false` | `false` | `null` | `null` | Loose substring rejected (L-NT-037). |
| Empty stdout `""` | 0 | **NO** | `false` | `false` | `false` | `null` | `null` | Empty stdout rejected fail-closed. |
| `Lỗi kết nối...` | 1 | **NO** | `false` | `false` | `false` | `null` | `null` | Non-zero exit code fails closed immediately. |

---

## 4. Identity Field Semantics

1. **`dispatch_id`:** Orchestrator-generated UUID (`uuid.uuid4()`). Diagnostic only; local to orchestrator process.
2. **`client_user_message_id`:** Formatted locally as `orchestrator:<dispatch_id>`. Marked explicitly as `LOCAL_DIAGNOSTIC_ONLY`. Subprocess output is strictly prohibited from overwriting this value.
3. **`queued_submission_id`:** Populated solely from the captured capture group `(\S+)` in `Queued message <id> for thread ...`. Diagnostic only. Never implies turn binding.
4. **`turn_id`:** Always `null` on queue dispatch. The legacy CLI transport cannot return authoritative turn correlation.

---

## 5. B-06 Report/Turn Pairing

Previously, `extract_latest_report_from_rollout_file()` checked `task_complete` to extract `turn_id` and `last_agent_message`, but also parsed later `response_item` assistant messages, which could overwrite `last_message` while leaving `turn_id` unchanged. This allowed partial text from an incomplete subsequent turn to be incorrectly attributed to an earlier completed turn.

Under B-06:
- The authoritative completed report text and `turn_id` **MUST** originate from the same `task_complete` event.
- Free-form `response_item` assistant messages are never used to fabricate or overwrite report text.
- If a `task_complete` event has an empty or whitespace-only `last_agent_message`, the report extraction fails closed (`success=false, report_text=null`) without borrowing from unrelated `response_item` events.

### Report Pairing Table

| `task_complete` turn | `task_complete` message | Later `response_item` | Returned `turn_id` | Returned `report_text` | `success` | Provenance Boundary |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `turn-A` | `"REPORT A"` | None | `turn-A` | `"REPORT A"` | `true` | Standard single-turn completion (L-NT-038). |
| `turn-A` | `"REPORT A"` | Assistant: `"TEXT FROM LATER TURN B"` | `turn-A` | `"REPORT A"` | `true` | Report text strictly preserved from `task_complete` A (L-NT-038, L-NT-039). |
| `turn-B` | `""` (empty) | Assistant: `"some text"` | `turn-B` | `null` | `false` | Empty report fails closed; no borrowing from `response_item` (L-NT-040). |
| None | None | Assistant: `"some text"` | `null` | `null` | `false` | Free assistant text without `task_complete` rejected. |

---

## 6. Regression Matrix

| Test ID | Scenario Description | Expected Result | Actual Result | Status |
| :--- | :--- | :--- | :--- | :---: |
| **L-NT-029** | Generic JSON stdout cannot activate transport authority | `queued=false, success=false, verified=false, turn_id=null` | As expected | **PASS** |
| **L-NT-030** | Contradictory `queued=false` + `turn_id` fails closed | `queued=false, success=false, verified=false, turn_id=null` | As expected | **PASS** |
| **L-NT-031** | Unrelated error (turn A) ignored when watching target turn B | Turn A error ignored; Turn B completes with `success=true` | As expected | **PASS** |
| **L-NT-032** | Matching error (turn B) returns exact target failure provenance | `success=false, turn_failed=true, turn_id=B, report_text=null` | As expected | **PASS** |
| **L-NT-033** | Unknown-turn error returns `watch_failed=true`, does not fail B | `turn_failed=false, watch_failed=true, turn_id=null` | As expected | **PASS** |
| **L-NT-034** | Cross-session timeout diagnostic strictly session-bound | `timed_out=true, diagnostic.session_id=sess_A` (never `sess_X`) | As expected | **PASS** |
| **L-NT-035** | JSON without `queued` field rejected as queue acceptance | `success=false, queued=false, turn_id=null` | As expected | **PASS** |
| **L-NT-036** | JSON `queued=true` cannot create queue authority or overwrite IDs | `success=false, queued=false`, IDs not overwritten | As expected | **PASS** |
| **L-NT-037** | Loose text (`for thread ...`) rejected as queue acceptance | `success=false, queued=false` | As expected | **PASS** |
| **Positive ACK** | Exact textual ACK `Queued message ... for thread ...` | `success=true, queued=true, verified=false, queued_submission_id=<id>` | As expected | **PASS** |
| **L-NT-038** | Mixed turn/report provenance rejected | `turn_id=turn-A, report_text='REPORT A'`, ignores later text | As expected | **PASS** |
| **L-NT-039** | Incomplete new turn text does not rewrite completed report | `turn_id=turn-A, report_text='REPORT A'` | As expected | **PASS** |
| **L-NT-040** | Empty `task_complete` fails closed without borrowing assistant text | `success=false, report_text=null` | As expected | **PASS** |

---

## 7. Command Evidence

### Compile Checks
```powershell
python -m py_compile pipeline-ui/send_to_codex.py pipeline-ui/watch_codex_session.py pipeline-ui/send_to_antigravity.py
# Exit Code: 0 (Clean)

node -c pipeline-ui/test/refactor/characterization.test.js
# Exit Code: 0 (Clean)

node -c pipeline-ui/test/refactor/wp01-regression.test.js
# Exit Code: 0 (Clean)
```

### Dedicated WP-V3-01 Regression Suite Run (12/12 PASS)
```powershell
node pipeline-ui/test/refactor/wp01-regression.test.js
```
```text
======================================================================
RUNNING WP-V3-01 REGRESSION TEST SUITE (L-NT-029 .. L-NT-040)
======================================================================

[L-NT-029] Testing generic JSON stdout cannot activate exact transport authority...
✓ L-NT-029 PASSED: Generic JSON stdout rejected as transport and queue authority.

[L-NT-030] Testing contradictory queued=false + turn_id fails closed...
✓ L-NT-030 PASSED: Contradictory queued=false + turn_id fails closed.

[L-NT-031] Testing wrong-turn error does not terminate watch or fail target turn...
✓ L-NT-031 PASSED: Unrelated Turn A error ignored; Target Turn B completed successfully.

[L-NT-032] Testing matching error event returns exact target failure provenance...
✓ L-NT-032 PASSED: Matching error attributes failure to target turn B with report_text=null.

[L-NT-033] Testing error without turn_id returns session/unknown failure, not target turn proof...
✓ L-NT-033 PASSED: Unknown-turn error reported as watch_failed without claiming target turn failed.

[L-NT-034] Testing timeout diagnostic remains strictly session-bound to Session A...
✓ L-NT-034 PASSED: Timeout diagnostic remained strictly session-bound to Session A.

[L-NT-035] Testing JSON without queued field does not establish queue acceptance...
✓ L-NT-035 PASSED: JSON without queued field rejected as queue acceptance.

[L-NT-036] Testing JSON queued=true cannot create queue authority or overwrite IDs...
✓ L-NT-036 PASSED: JSON queued=true rejected; IDs not overwritten.

[L-NT-037] Testing loose text does not establish queue acceptance...
✓ L-NT-037 PASSED: Loose text patterns rejected as queue acceptance.

[POSITIVE ACK] Testing valid recognized textual ACK pattern...
✓ POSITIVE ACK PASSED: Exact textual ACK acknowledged with diagnostic queued_submission_id.

[L-NT-038] Testing mixed turn/report provenance rejected...
✓ L-NT-038 PASSED: Report text strictly bound to matching task_complete record.

[L-NT-039] Testing incomplete new turn does not rewrite completed report...
✓ L-NT-039 PASSED: Incomplete turn B did not rewrite completed report A.

[L-NT-040] Testing empty complete does not borrow assistant text...
✓ L-NT-040 PASSED: Empty complete failed closed without borrowing assistant text.

======================================================================
ALL WP-V3-01 REGRESSION TESTS PASSED (L-NT-029 .. L-NT-040: 12/12 PASS)
======================================================================
```

### Characterization Test Suite Run
```powershell
node pipeline-ui/test/refactor/characterization.test.js
# Invariant checks 1-11: INVARIANT_ENFORCED (100% PASS)
# Baseline defect checks 12-14: DEFECT_REPRODUCED (preserved)
```

### Git Diff Check
```powershell
git diff --check
# Exit Code: 0 (Zero whitespace errors)
```

---

## 8. npm test

**Classification:** `UNCHANGED_PRE_EXISTING_FAILURE`

```text
> pipeline-ui@1.0.0 test
> node test/pipeline-api.test.js && node test/closed-loop.test.js

--- Starting Pipeline Portal Automated Tests ---
[TEST] Server listening on http://127.0.0.1:4099
[TEST 1] Testing static UI delivery (GET /)...
✓ PASS: Static UI delivery verified.
[TEST 2] Testing system health status (GET /api/status)...
✓ PASS: Health status verified. AO: offline, ChatGPT: ready, Agy: 1.2.5
[TEST 3] Testing projects API (GET /api/projects)...
❌ TEST FAILED: AssertionError [ERR_ASSERTION]: Found registered project workspace-test
    at runTests (D:\TU_CODE\Orchestrator\pipeline-ui\test\pipeline-api.test.js:72:12)
```

The failure signature matches the baseline characterization record identically.

---

## 9. Scope Compliance

```text
WP-V3-02 started:
NO

Broker files:
NONE

server.js modified:
NO

UI modified:
NO

package.json modified:
NO
```

---

## 10. Remaining Legacy Limitations

1. **Legacy CLI Queue Interface is Strictly Fail-Closed:**
   The legacy `codex queue` transport provides no exact queue-to-turn correlation mechanism. Dispatches return `verified=false`, `turn_started=false`, `turn_id=null`, and `correlation_method='unavailable'`.
2. **No Fallback Authority Manufacture:**
   Neither unnegotiated JSON stdout nor rollout observation lines can manufacture turn authority or queue acceptance.
3. **Pending Retirement:**
   This sealed transport will be superseded by the Thin-Orchestrator broker architecture in subsequent WorkOrders and retired in WP-V3-11.

---

## 11. Recommendation

Both remaining legacy correctness issues (B-03B and B-06) are completely sealed and verified across 12 deterministic negative/positive tests.

Status:
`READY_FOR_WP_V3_01_FINAL_EXTERNAL_REVIEW`

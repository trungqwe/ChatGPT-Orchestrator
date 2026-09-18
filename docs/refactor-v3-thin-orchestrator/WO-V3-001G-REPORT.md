# WO-V3-001G REPORT — Legacy Transport Absolute Final Closure

Work Package: WP-V3-01 Absolute Final Closure
Repository: `https://github.com/trungqwe/ChatGPT-Orchestrator`
Parent Branch: `review/v3-wp01-seal-fix1`
Parent SHA: `8c13f926867468b0ab9b28ed396b926211777d29`
Architecture Base: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
Branch: `review/v3-wp01-seal-final`
Result Status: `READY_FOR_WP_V3_01_APPROVAL`

---

## 1. Baseline

- **Parent Branch:** `review/v3-wp01-seal-fix1`
- **Parent Commit SHA:** `8c13f926867468b0ab9b28ed396b926211777d29`
- **Architecture Authority:** `3001dce9e0d010f4b68fc7b061072ec9b30f093d`
- **Externally Accepted Invariants:**
  - B-03: Generic JSON cannot manufacture `exact_transport` authority (`verified=false`).
  - B-03B: Generic JSON cannot manufacture queue authority (`queued=false, success=false`).
  - B-04: Error provenance is exact (wrong-turn ignored; matching-turn fails target; untracked fails watch).
  - B-05: Timeout diagnostics remain strictly session-bound.
  - B-06: Authoritative report text and turn ID are paired strictly from a single `task_complete` event.
- **Defect Addressed in this Turn:**
  - B-07: Queue ACK was not parsed line-exact, permitted embedded substring matches, and was not bound to the requested session ID.

---

## 2. B-07 Finding

The queue ACK parser previously utilized a loose `re.search(r"Queued message\s+(\S+)\s+for thread\s+(\S+)", queue_output)` across the entire stdout string. This introduced two provenance vulnerabilities:
1. **Embedded Substring Acceptance:** A warning or error line containing the phrase (e.g. `WARNING: Queued message fake for thread sess_001 but transport uncertain`) was mistakenly treated as an authoritative ACK.
2. **Missing Session Binding:** The extracted `thread_id` was not checked against the requested `session_id`. An ACK acknowledging an entirely different session or thread would erroneously set `queued=true` for the current request.
3. **Ambiguous Multi-ACK Output:** Multiple ACK lines (whether same session or conflicting sessions) were not handled fail-closed.

---

## 3. Exact ACK Parser

The transport output inspection in `pipeline-ui/send_to_codex.py` now implements line-by-line parsing:
- Each non-empty line of stdout is stripped of outer whitespace.
- An exact full-line pattern is applied using `re.fullmatch`:
  ```python
  ack_pattern = re.compile(r"^Queued message\s+(\S+)\s+for thread\s+(\S+)$")
  ```
- Any embedded phrase within a longer diagnostic message fails the full-line match and is rejected.
- Unrelated diagnostic log lines before or after the ACK line are ignored so long as the ACK line itself is exact.

---

## 4. Session Binding

The parsed thread identifier from the exact ACK line must strictly match the `session_id` targeted by the `codex queue --thread <session_id>` command.
- If `ack_thread_id != session_id`, the dispatcher returns `success=false, queued=false, verified=false, turn_id=null` with the error `ACK_SESSION_MISMATCH`.
- A queue ACK for another session is never accepted.

---

## 5. Ambiguous ACK Handling

If stdout contains more than one exact ACK line:
- Multiple ACKs for the same session or for conflicting sessions fail closed immediately.
- The dispatcher returns `success=false, queued=false` with the error `AMBIGUOUS_QUEUE_ACK`.
- No arbitrary selection among multiple ACKs is permitted.

### ACK Authority Table

| stdout | Requested Session | Recognized Exact ACK Lines | ACK Session | `success` | `queued` | Reason / Outcome |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `Queued message msg123 for thread sess_001` | `sess_001` | 1 | `sess_001` | `true` | `true` | Exact matching ACK; valid queue acceptance (L-NT-043). |
| `WARNING: Queued message fake for thread sess_001 but transport uncertain` | `sess_001` | 0 | None | `false` | `false` | `NO_RECOGNIZED_QUEUE_ACK`: Embedded phrase rejected (L-NT-041). |
| `Queued message msg123 for thread sess_OTHER` | `sess_001` | 1 | `sess_OTHER` | `false` | `false` | `ACK_SESSION_MISMATCH`: ACK thread does not match requested session (L-NT-042). |
| `Queued message msg123 for thread sess_001`<br>`Queued message msg456 for thread sess_001` | `sess_001` | 2 | `sess_001` | `false` | `false` | `AMBIGUOUS_QUEUE_ACK`: Multiple ACKs rejected fail-closed (L-NT-044). |
| `Queued message msg123 for thread sess_001`<br>`Queued message msg456 for thread sess_OTHER` | `sess_001` | 2 | Conflicting | `false` | `false` | `AMBIGUOUS_QUEUE_ACK`: Conflicting ACKs rejected fail-closed (L-NT-045). |
| `{"queued": true, "turn_id": "fake"}` | `sess_001` | 0 | None | `false` | `false` | `NO_RECOGNIZED_QUEUE_ACK`: Generic JSON rejected (L-NT-029, L-NT-036). |
| `for thread sess_001` | `sess_001` | 0 | None | `false` | `false` | `NO_RECOGNIZED_QUEUE_ACK`: Loose substring rejected (L-NT-037). |

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
| **L-NT-038** | Mixed turn/report provenance rejected | `turn_id=turn-A, report_text='REPORT A'`, ignores later text | As expected | **PASS** |
| **L-NT-039** | Incomplete new turn text does not rewrite completed report | `turn_id=turn-A, report_text='REPORT A'` | As expected | **PASS** |
| **L-NT-040** | Empty `task_complete` fails closed without borrowing assistant text | `success=false, report_text=null` | As expected | **PASS** |
| **L-NT-041** | Embedded ACK phrase in other text rejected | `success=false, queued=false` | As expected | **PASS** |
| **L-NT-042** | ACK for wrong session fails closed | `success=false, queued=false, error=ACK_SESSION_MISMATCH` | As expected | **PASS** |
| **L-NT-043** | Exact matching ACK for requested session accepted | `success=true, queued=true, queued_submission_id='msg123'` | As expected | **PASS** |
| **L-NT-044** | Multiple matching ACKs fail closed | `success=false, queued=false, error=AMBIGUOUS_QUEUE_ACK` | As expected | **PASS** |
| **L-NT-045** | Multiple conflicting ACKs fail closed | `success=false, queued=false, error=AMBIGUOUS_QUEUE_ACK` | As expected | **PASS** |

---

## 7. Command Evidence

### Compile and Syntax Checks
```powershell
python -m py_compile pipeline-ui/send_to_codex.py pipeline-ui/watch_codex_session.py pipeline-ui/send_to_antigravity.py
# Exit Code: 0 (Clean)

node -c pipeline-ui/test/refactor/characterization.test.js
# Exit Code: 0 (Clean)

node -c pipeline-ui/test/refactor/wp01-regression.test.js
# Exit Code: 0 (Clean)
```

### Dedicated WP-V3-01 Regression Suite Run (17/17 PASS)
```powershell
node pipeline-ui/test/refactor/wp01-regression.test.js
```
```text
======================================================================
RUNNING WP-V3-01 REGRESSION TEST SUITE (L-NT-029 .. L-NT-045)
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

[L-NT-038] Testing mixed turn/report provenance rejected...
✓ L-NT-038 PASSED: Report text strictly bound to matching task_complete record.

[L-NT-039] Testing incomplete new turn does not rewrite completed report...
✓ L-NT-039 PASSED: Incomplete turn B did not rewrite completed report A.

[L-NT-040] Testing empty complete does not borrow assistant text...
✓ L-NT-040 PASSED: Empty complete failed closed without borrowing assistant text.

[L-NT-041] Testing embedded ACK phrase within other text rejected...
✓ L-NT-041 PASSED: Embedded ACK phrase rejected as full line ACK.

[L-NT-042] Testing ACK for wrong session fails closed with ACK_SESSION_MISMATCH...
✓ L-NT-042 PASSED: ACK for wrong session rejected with ACK_SESSION_MISMATCH.

[L-NT-043] Testing exact matching ACK for requested session accepted...
✓ L-NT-043 PASSED: Exact matching ACK for requested session successfully accepted.

[L-NT-044] Testing multiple matching ACK lines fail closed with AMBIGUOUS_QUEUE_ACK...
✓ L-NT-044 PASSED: Multiple matching ACKs rejected fail-closed.

[L-NT-045] Testing multiple conflicting ACK lines fail closed with AMBIGUOUS_QUEUE_ACK...
✓ L-NT-045 PASSED: Multiple conflicting ACKs rejected fail-closed.

======================================================================
ALL WP-V3-01 REGRESSION TESTS PASSED (L-NT-029 .. L-NT-045: 17/17 PASS)
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

watch_codex_session.py modified:
NO
```

---

## 10. Recommendation

All legacy transport provenance defects (B-03, B-03B, B-04, B-05, B-06, B-07) are completely sealed and verified. The legacy queue transport is now strictly fail-closed, line-exact, and session-bound.

Status:
`READY_FOR_WP_V3_01_APPROVAL`

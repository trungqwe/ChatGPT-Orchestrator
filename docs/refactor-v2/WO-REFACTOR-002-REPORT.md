# WorkOrder Report: WO-REFACTOR-002

**WorkPackage:** `WP-01 — Eliminate False-Positive Worker Transport and Stale Report Attribution`  
**Repository:** `ChatGPT-Orchestrator`  
**Remote Baseline Verified:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`  
**Status:** `READY_FOR_WP01_REVIEW`  

---

## 1. Baseline Verification

- **Branch:** `main`
- **Initial HEAD:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`
- **Final HEAD:** `8b27a567cc7b058c0782e0370dcc295e1a304a79` (0 commits drift, working tree modified without commit)
- **Initial Working Tree Status:** Untracked documentation files in `docs/refactor-v2/`, `manifest.json`, and WP-00 characterization test `pipeline-ui/test/refactor/characterization.test.js`.
- **Final Working Tree Status:** 4 allowed production files modified (`send_to_antigravity.py`, `send_to_codex.py`, `watch_codex_session.py`, `server.js`). WP-01 regression test suite updated. This report added.
- **Remote Baseline:** `8b27a567cc7b058c0782e0370dcc295e1a304a79` (verified no newer remote commit exists).

---

## 2. WP-00 Review Gate

```text
WP00_REVIEW_GATE: PASS
```

**Preflight Audit Summary:**
- All 16 Stage 1 planning documents and `WO-REFACTOR-001-REPORT.md` are present and intact on disk.
- Tracked production code was completely clean before WP-01 implementation began.
- Baseline characterization suite `node test/refactor/characterization.test.js` ran deterministically and confirmed all 6 target defects (F-01, F-02, F-03, F-06, F-10, F-12) as reported.
- No destructive or network operations were performed.
- Baseline passed the WP-00 gate without qualification.

---

## 3. Files Changed

### Production Files Modified (Authorized Scope Only: Exactly 4)
1. [`pipeline-ui/send_to_antigravity.py`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/send_to_antigravity.py) (Fix F-01 syntax error & deterministic normalization)
2. [`pipeline-ui/send_to_codex.py`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/send_to_codex.py) (Fix F-02 dispatch verification state model)
3. [`pipeline-ui/watch_codex_session.py`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/watch_codex_session.py) (Fix F-03 eliminate stale timeout fallback & enforce turn provenance)
4. [`pipeline-ui/server.js`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js) (Update dispatch & watcher handoff to require verified turn target)

### Test Files Modified
1. [`pipeline-ui/test/refactor/characterization.test.js`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/test/refactor/characterization.test.js) (Converted F-01, F-02, F-03 to enforce safe invariants, added NT-001..NT-004 scenarios, preserved F-06, F-10, F-12 characterizations)

### Documentation / Report Files Added
1. [`docs/refactor-v2/WO-REFACTOR-002-REPORT.md`](file:///d:/TU_CODE/Orchestrator/docs/refactor-v2/WO-REFACTOR-002-REPORT.md) (This report)

---

## 4. F-01 — Antigravity Python Syntax & Project Normalization

- **Previous Behavior:** Running `python -m py_compile pipeline-ui/send_to_antigravity.py` exited with code `1`: `SyntaxError: invalid decimal literal` at line 61.
- **Root Cause:** JavaScript regular expression literal syntax `replace(/[^a-z0-9_-]/, '_')` was copied directly into Python code.
- **Exact Implementation Change:**
  - Added `import re`.
  - Introduced deterministic helper function `normalize_project_keyword(project_keyword)`:
    - Strips and lowercases the input.
    - Replaces any character outside `[a-z0-9_-]` with `_`.
    - Enforces fallback to `"ai_multi_task"` on empty, None, or non-string input.
  - Replaced broken line 61 with `clean_proj = normalize_project_keyword(project_keyword)`.
- **Post-Fix Behavior:** File compiles cleanly without syntax errors and normalizes all project identifiers deterministically.
- **Commands & Exit Codes:**
  - `python -m py_compile pipeline-ui/send_to_antigravity.py` -> Exit code `0`.
  - Normalization test coverage -> Exit code `0` (Tested: `"AI_Multi_Task" -> "ai_multi_task"`, `"Hello World" -> "hello_world"`, `"ABC!@#XYZ" -> "abc___xyz"`, `"foo-bar" -> "foo-bar"`, `"" -> "ai_multi_task"`, `None -> "ai_multi_task"`).

---

## 5. F-02 — Codex Dispatch State Model

- **Previous Behavior:** When `codex queue` succeeded, if no `task_started` event appeared in the rollout, `send_to_codex.py` still returned `success: true, verified: true, turn_id: null` and claimed `"xác thực: task_started"`.
- **Root Cause:** Control flow unconditionally set `result["verified"] = True` and `result["success"] = True` on queue output confirmation regardless of whether `turn_started` was actually observed.
- **Exact Implementation Change:**
  - Explicitly decoupled state fields: `queued`, `verified`, `turn_started`, `turn_id`.
  - Recorded pre-dispatch `baseline_line_count` and `baseline_turn_id` before invoking `codex queue`.
  - Scanned only lines appended *after* `baseline_line_count` (rejecting historical events).
  - Only when a matching `task_started` is observed post-dispatch: set `verified = True, turn_started = True, turn_id = new_turn_id`.
  - When `task_started` is not observed: set `queued = True, verified = False, turn_started = False, turn_id = None`, with message explicitly noting that `task_started` was unobserved.

### State Transition Table

| Condition | `queued` | `turn_started` | `verified` | `turn_id` | `message` |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Queue failure** (non-0 exit / no confirmation) | `false` | `false` | `false` | `null` | Error message describing queue failure |
| **Queue success / no start observed** (NT-001) | `true` | `false` | `false` | `null` | "Lệnh đã nạp vào hàng đợi... nhưng chưa quan sát thấy task_started" |
| **Matching start observed** | `true` | `true` | `true` | `<observed_id>` | "Đã nạp chỉ đạo... (xác thực: task_started turn '<id>')" |
| **Wrong / historical start** (NT-002) | `true` | `false` | `false` | `null` | Historical event ignored; unverified |

---

## 6. F-03 — Watcher Stale Report Fallback Elimination

- **Previous Behavior:** When watching for a target turn that timed out, `watch_codex_session.py` fell back to `extract_latest_codex_report()` and returned an older completed turn's report with `success: true, timeout_warning: true`.
- **Root Cause:** Fallback block at lines 215–220 populated `success = True` with data from earlier turns upon timeout.
- **Exact Implementation Change:**
  - Replaced fallback: on timeout, `watch_codex_turn` **always** returns `success = False, verified = False, timed_out = True, report_text = None, turn_id = None`.
  - Old/latest report is strictly relegated to optional `diagnostic_latest_report` for debugging and never populates primary report fields.
  - Strict matching rule: when `target_turn_id` is set, events with mismatched `turn_id` are ignored and cannot satisfy completion.

### Provenance Attribution Table

| Target Turn | Observed Event | Timeout? | `success` | `verified` | Primary Report Source | Diagnostic Report |
| :--- | :--- | :---: | :---: | :---: | :--- | :--- |
| **Turn B** | None (timeout) | `true` | `false` | `false` | `null` | Turn A (if present) |
| **Turn B** | Completion of Turn A | `true` | `false` | `false` | `null` (Turn A ignored) | Turn A |
| **Turn B** | Completion of Turn B | `false` | `true` | `true` | Exact Turn B report | `null` |

---

## 7. Server Handoff Changes in `server.js`

1. **`dispatchPromptToCodex`:**
   - Evaluates `isTurnVerified = !!(pyOut.verified && pyOut.turn_started && pyOut.turn_id)`.
   - Populates `result.queued = !!pyOut.queued` and `result.verified = isTurnVerified`.
   - If verified: registers `{ targetTurnId: pyOut.turn_id, baselineTurnId: ... }` in `lastDispatchedCodexTurn[proj]`.
   - If NOT verified: deletes `lastDispatchedCodexTurn[proj]` and logs `[CODEX BG DISPATCH UNVERIFIED]`.
2. **`waitCodexReport`:**
   - Inspects `effectiveTargetTurn = targetTurnId || tracked?.targetTurnId`.
   - **Refuses to wait without verified target:** If `effectiveTargetTurn` is missing/null, immediately resolves with:
     ```json
     {
       "success": false,
       "verified": false,
       "target_turn_id": null,
       "turn_id": null,
       "timed_out": false,
       "report_text": null,
       "error": "Cannot wait for Codex report: missing verified target_turn_id (dispatch was not verified or target turn missing)"
     }
     ```
   - When verified target turn exists, passes `--target-turn "${effectiveTargetTurn}"` directly to `watch_codex_session.py`.
   - Never invokes watcher with untargeted fallback.

---

## 8. Regression Test Matrix

| Test ID | Scenario | Before WP-01 | After WP-01 | Result |
| :--- | :--- | :--- | :--- | :---: |
| **F-01** | Python syntax compilation & keyword normalization | `SyntaxError` at line 61 (exit code 1) | Compiles cleanly (exit code 0); all normalization cases pass | **ENFORCED** |
| **NT-001** | Queue acknowledged, no turn start observed | Returned `verified: true, turn_id: null` | Returns `queued: true, verified: false, turn_started: false, turn_id: null` | **ENFORCED** |
| **F-02-B** | Queue acknowledged, matching turn start observed | (Unreliable attribution) | Returns `queued: true, verified: true, turn_started: true, turn_id: matching` | **ENFORCED** |
| **NT-002** | Pre-existing historical start event before dispatch | Treated historical event as current verification | Historical event ignored; returns `verified: false, turn_id: null` | **ENFORCED** |
| **NT-003** | Timeout with previous completed report (Turn A) | Returned Turn A report with `success: true` | Returns `success: false, timed_out: true, report_text: null` | **ENFORCED** |
| **NT-004** | Wrong turn completion observed during watch | Treated latest event as completed turn | Wrong turn ignored; watcher times out with `success: false` | **ENFORCED** |
| **F-03-C** | Matching target turn completion observed | (Subject to race conditions) | Returns `success: true, verified: true, turn_id: target, report: target` | **ENFORCED** |
| **F-06** | Malformed model prose in `/api/orchestrator/audit` | Defect present (`verdict="COMPLETE"`) | Defect preserved for structured auditor WP | **DEFERRED** |
| **F-10** | Unauthenticated arbitrary command execution | Defect present (HTTP 200 executes cmd) | Defect preserved for WP-02 Security Hardening | **DEFERRED** |
| **F-12** | Multi-round tests omitted from default `npm test` | Defect present (runs only 2 legacy files) | Defect preserved for WP-12 test registration | **DEFERRED** |

---

## 9. Command Execution Evidence

| Command | Working Directory | Exit Code | Result Summary |
| :--- | :--- | :---: | :--- |
| `python -m py_compile pipeline-ui/send_to_antigravity.py` | `d:\TU_CODE\Orchestrator` | `0` | Clean compilation. F-01 eliminated. |
| `python -m py_compile pipeline-ui/send_to_codex.py` | `d:\TU_CODE\Orchestrator` | `0` | Clean compilation. |
| `python -m py_compile pipeline-ui/watch_codex_session.py` | `d:\TU_CODE\Orchestrator` | `0` | Clean compilation. |
| `node -c pipeline-ui/server.js` | `d:\TU_CODE\Orchestrator` | `0` | Clean JavaScript syntax. |
| `node test/refactor/characterization.test.js` | `d:\TU_CODE\Orchestrator\pipeline-ui` | `0` | All 7 WP-01 invariant assertions passed; all 3 deferred characterizations passed. |
| `git diff --check` | `d:\TU_CODE\Orchestrator` | `0` | Clean formatting; no whitespace/merge artifacts. |
| `npm test` | `d:\TU_CODE\Orchestrator\pipeline-ui` | `1` | `PRE_EXISTING_UNRELATED_FAILURE`: Legacy `test/pipeline-api.test.js` Test 3 fails asserting `workspace-test` in user environment. Identical failure to WP-00 baseline. |
| `git status --porcelain=v2 --untracked-files=all` | `d:\TU_CODE\Orchestrator` | `0` | Confirms exactly 4 production files modified (`send_to_antigravity.py`, `send_to_codex.py`, `watch_codex_session.py`, `server.js`). |

---

## 10. Known Unresolved Issues (Disciplined Scope Exclusions)

The following items are intentionally **NOT** fixed in WP-01 to preserve modular reviewability:
1. **F-06 (Malformed Auditor Output Fallback):** Deferred to structured auditor Work Package (WP-07/WP-09).
2. **F-10 (Arbitrary Command Execution Endpoint):** Deferred to WP-02 Security Hardening.
3. **Legacy `npm test` Host-State Dependency:** Fails at `pipeline-api.test.js` Test 3 because local environment does not have pre-registered `workspace-test`. Deferred to WP-10 / WP-12.
4. **Zero-Intrusion Active Verification Limits:** Stronger cryptographic/session token binding deferred to Verification Contract & Active Inspector (WP-03/WP-04).

---

## 11. Scope Compliance Audit

- **Out-of-scope production files changed:** `NO` (0 files outside the 4 authorized)
- **Security WP-02 implemented:** `NO`
- **Snapshot / Verification Contract implemented:** `NO`
- **Commit created:** `NO`
- **Push performed:** `NO`

---

## 12. Recommendation

```text
READY_FOR_WP01_REVIEW
```

WP-01 is complete. False-positive transport states and stale report attributions have been strictly eliminated and verified with deterministic regression tests. Per WorkOrder instructions, execution is stopped.

The working tree is ready for human review.

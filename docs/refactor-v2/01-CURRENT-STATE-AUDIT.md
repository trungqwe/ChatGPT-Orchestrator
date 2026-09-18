# Current-State Audit

## 1. Scope and baseline

This assessment is pinned to:

`8b27a567cc7b058c0782e0370dcc295e1a304a79`

The purpose is to record facts the implementation plan must address. This file is not a general criticism and must not be used as an excuse to redesign unrelated UI or product features.

## 2. Confirmed defects

### CS-001 — Syntax error in Antigravity dispatcher

File:

`pipeline-ui/send_to_antigravity.py`

Current code contains JavaScript regex-literal syntax inside Python:

```python
clean_proj = project_keyword.lower().replace(/[^a-z0-9_-]/, '_') ...
```

Impact:

- the Python file cannot be parsed normally;
- the Antigravity background-dispatch path is not covered by the Codex-only three-round test;
- a broad claim such as “background IPC fully verified” is not supported by that test.

Required disposition:

- fix in the first implementation phase;
- add Python syntax/compile validation to the trusted verification contract;
- add an explicit Antigravity-dispatch smoke test.

### CS-002 — Codex dispatch can report verified without observing `task_started`

File:

`pipeline-ui/send_to_codex.py`

Current flow:

1. queue command returns success;
2. code waits for `task_started`;
3. even when no matching start event is observed, the function later sets:
   - `success = True`
   - `verified = True`
   - message claims `task_started` verification.

Impact:

- deterministic false-positive verification;
- downstream logic cannot distinguish “queued” from “turn observed.”

Required state model:

- `QUEUED`
- `TURN_STARTED`
- `TURN_COMPLETED`
- `FAILED`

`verified=true` must never mean more than the strongest event actually observed.

### CS-003 — Watcher can return a stale report after timeout

File:

`pipeline-ui/watch_codex_session.py`

Current timeout fallback calls `extract_latest_codex_report()` and may return the latest earlier report with `success=true`.

Impact:

- report from turn N can be attributed to turn N+1;
- end-to-end provenance is broken.

Required behavior:

- timeout is terminal failure for the requested turn;
- stale/latest report can be returned only as diagnostic metadata and never as successful evidence;
- exact turn binding is mandatory.

### CS-004 — Main audit path reviews testimony more than implementation

Files/functions:

- `pipeline-ui/server.js`
- `getProjectLocalContext()`
- `/api/orchestrator/audit-and-direct`

Current context builder primarily sends:

- shallow directory tree;
- selected technical documents;
- worker report.

Technical documents are truncated; implementation files are not independently selected/read by the auditor in a systematic way.

Impact:

- reviewer is anchored to the implementer’s claims;
- changed code, callers, tests, and indirect dependencies may never be inspected.

Required behavior:

- worker report is an untrusted claim manifest;
- machine evidence and repository inspection are separate sources;
- auditor is allowed to actively read/search the exact project snapshot.

### CS-005 — Missing report can degrade into a positive fallback statement

Current audit flow contains fallback prose equivalent to “worker reports task completed” when report extraction fails.

Impact:

- missing evidence can become positive evidence.

Required rule:

**NO EVIDENCE = NO AUDIT = NO DISPATCH**

### CS-006 — Model-output parse failure can become COMPLETE

The legacy `/api/orchestrator/audit` fallback can derive COMPLETE from `workerReport.testPassed` when model JSON parsing fails.

Impact:

- protocol failure can be transformed into project success.

Required rule:

**MODEL PROTOCOL FAILURE = AUDIT_PROTOCOL_ERROR**

Never infer PASS/COMPLETE from malformed model output.

### CS-007 — Semantic verdict is laundered into `testPassed`

Current exchange compatibility data derives `testPassed` from LLM verdict.

Impact:

- semantic judgment is mislabeled as machine test evidence.

Required separation:

- `worker_claims`
- `machine_evidence`
- `auditor_verdict`

These fields must never be synthesized into each other.

### CS-008 — Verdict parsing by Vietnamese substrings is non-deterministic

Current code searches response prose for words such as “lỗi” or “sửa”.

Impact:

- positive sentence containing those words can produce FIX;
- alternate wording can miss a real failure.

Required behavior:

- JSON-schema-constrained output;
- parse failure is fail-closed.

### CS-009 — Server exposure + arbitrary command endpoint

Current server starts without an explicit loopback host and contains a route accepting a raw test command which is passed to shell execution.

Impact:

- potential unauthenticated command execution if the listener is reachable from an untrusted process/interface;
- command semantics are controlled by caller rather than verifier policy.

Required behavior:

- bind `127.0.0.1`;
- add request authentication for privileged routes;
- remove or quarantine generic raw-shell execution;
- use allowlisted verification actions.

### CS-010 — “100% zero-intrusion” claim exceeds instrumentation

Current test samples mouse position before/after a larger operation and does not continuously instrument:

- keyboard injection;
- foreground-window changes;
- clipboard mutation;
- mouse path during the operation;
- fullscreen application interaction.

Required behavior:

- rename the property to what is actually measured, e.g. `no_mouse_position_change_at_sample_points`;
- or add appropriate instrumentation before making a stronger claim.

### CS-011 — three-round test is not part of `npm test`

Current package test script does not include `test_codex_3_rounds.js`.

Required behavior:

- decide whether it is an integration test, acceptance test, or release-validation test;
- register it in an explicit test tier;
- never imply `npm test` covers it unless it does.

## 3. Confirmed architectural opportunities

### CO-001 — `--ephemeral` does not disable local tools

`--ephemeral` controls session persistence. Tool availability is a separate concern.

### CO-002 — Correct project CWD is part of authority

Writing a local path inside prompt text is not a substitute for launching the Codex task with the target project as its trusted working root.

### CO-003 — Full Harness can provide active inspection

When the Full Harness is healthy and correctly bound, ChatGPT can access the active Codex task’s local tools through MCP.

This is optional capability, not something the orchestrator may assume. Runtime health must be verified.

### CO-004 — local verifier and GitHub solve different problems

Local verifier:

- uncommitted/dirty state;
- runtime checks;
- exact local filesystem.

GitHub:

- immutable committed checkpoint;
- history/diff;
- optional CI/checkpoint corroboration.

The target architecture uses both where useful; neither replaces the other everywhere.

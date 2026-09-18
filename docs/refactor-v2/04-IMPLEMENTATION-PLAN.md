# Detailed Implementation Plan

## 0. Rule for using this plan

The implementing agent must work one Work Package (WP) at a time.

For every WP:

1. read this entire WP;
2. read all files listed under “Files to inspect”;
3. run preflight;
4. make only listed changes;
5. run required checks;
6. produce the required evidence;
7. stop;
8. do not start the next WP until reviewer approval.

No opportunistic refactors.

No UI redesign.

No dependency upgrade unless the WP explicitly requires it.

---

# WP-00 — Freeze baseline and add characterization tests

## Goal

Create tests that reproduce current unsafe/false-positive behavior before changing implementation.

## Files to inspect

- `pipeline-ui/send_to_antigravity.py`
- `pipeline-ui/send_to_codex.py`
- `pipeline-ui/watch_codex_session.py`
- `pipeline-ui/server.js`
- `pipeline-ui/package.json`
- existing `pipeline-ui/test/*`

## Required additions

Create a dedicated refactor test tier, e.g.:

`pipeline-ui/test/refactor/`

Add characterization tests for:

1. Codex queue returns exit 0 but no `task_started`.
2. watcher times out while old report exists.
3. malformed auditor output.
4. missing worker report.
5. verdict prose containing “đã sửa hết lỗi”.
6. command endpoint accepts arbitrary command.
7. Antigravity Python file compile check.
8. snapshot-drift primitive once snapshot module exists; placeholder skipped test may be used only in WP-00.

## Exit criteria

- tests reliably demonstrate the known defects;
- test names describe unsafe behavior;
- they are not silently marked PASS as desired behavior;
- baseline commit/SHA captured in report.

---

# WP-01 — Critical correctness fixes in worker transport

## Goal

Eliminate false-positive dispatch/report provenance.

## 1. Fix `send_to_antigravity.py`

Replace invalid Python normalization code with valid Python.

Requirements:

- deterministic normalization;
- unit tests for:
  - `AI_Multi_Task`
  - spaces
  - uppercase
  - unsupported punctuation
  - empty string.

Mandatory check:

```text
python -m py_compile pipeline-ui/send_to_antigravity.py
```

## 2. Fix `send_to_codex.py`

Introduce explicit event state.

Suggested result fields:

```json
{
  "queued": true,
  "turn_started": false,
  "verified": false,
  "turn_id": null
}
```

Rules:

- queue exit 0 means only `queued=true`;
- `verified=true` only after matching start event;
- returned message must match actual state;
- no synthetic turn ID.

## 3. Fix `watch_codex_session.py`

Rules:

- timeout returns `success=false`;
- latest old report may be attached as `diagnostic_latest_report`, never primary evidence;
- exact `target_turn_id` is mandatory after a verified dispatch;
- completion event must match expected turn;
- an event with empty report body does not count as completed evidence.

## 4. Fix server handoff

`waitCodexReport` must pass the strongest known turn binding.

No “best guess” report success.

## Exit criteria

Negative tests for wrong/stale/no-turn paths pass.

---

# WP-02 — Local security hardening

## Goal

Make the local control plane safe by default.

## Files to inspect and touch

- `pipeline-ui/server.js` (loopback bind, auth middleware, replace raw shell endpoint with semantic check)
- `pipeline-ui/desktop-main.js` (pass auth token to renderer via IPC)
- `pipeline-ui/preload.js` (expose auth token to `window.orchestratorAuthToken`)
- `pipeline-ui/public/app.js` (attach auth token header in `apiGet`/`apiPost`, update worktree test callers at lines 1614 & 1986)
- `pipeline-ui/test/pipeline-api.test.js` (attach auth token in test helper `makeRequest`)

## Server binding

Change Express listen to explicit loopback:

`127.0.0.1`

Ensure desktop health probes use the same host (`127.0.0.1:${PORT}`).

## Authentication

Introduce a startup-generated local secret:
- Generated via `crypto.randomBytes(32).toString('hex')` on server startup.
- Persisted locally in `.orchestrator/auth_token` with restrictive file permissions.
- Passed to Electron renderer via `desktop-main.js` -> `preload.js` -> `public/app.js`.
- Read by local test runners via `process.env.ORCHESTRATOR_API_TOKEN` or by reading `.orchestrator/auth_token`.

Privileged routes require `Authorization: Bearer <token>` or `x-orchestrator-token`.

At minimum protect:

- test execution;
- dispatch;
- audit control;
- project file extraction if it can expose sensitive source.

## Remove generic remote shell API

Replace:

`POST .../test { command: "..." }`

with semantic requests such as:

```json
{ "check_id": "project.default_test" }
```

Check ID resolves through trusted Verification Contract.

Update frontend callers in `public/app.js` and test caller in `test/pipeline-api.test.js` to use the semantic request and attach auth token.

If raw-shell functionality is retained for development, place it behind:

- disabled-by-default developer flag (`ALLOW_UNSAFE_SHELL=false`);
- loopback;
- authentication;
- explicit warning;
- separate route namespace (`/api/debug/raw-test`).

## Exit criteria

- request without token rejected with 401/403;
- request to non-loopback listener impossible because no non-loopback listener exists;
- arbitrary shell strings cannot enter trusted verifier path;
- `pipeline-api.test.js` and `public/app.js` work seamlessly with authenticated semantic checks.

---

# WP-03 — Snapshot Engine

## Goal

Create immutable audit identity for a mutable local worktree.

## New module

Suggested:

`pipeline-ui/lib/audit-snapshot.js`

## Snapshot fields

At minimum:

```json
{
  "schema_version": 1,
  "snapshot_id": "...",
  "project_path": "...",
  "branch": "...",
  "head_sha": "...",
  "upstream_ref": "...",
  "upstream_sha": "...",
  "git_status_porcelain_v2": "...",
  "changed_files": [],
  "untracked_files": [],
  "diff_hash": "...",
  "fingerprint": "...",
  "created_at": "..."
}
```

## Fingerprint inputs

Use canonical ordering.

Include:

- HEAD;
- branch;
- status bytes;
- diff bytes or hash;
- untracked manifest;
- optionally hashes of untracked files included in audit scope.

## API

Provide:

- `createAuditSnapshot(projectPath)`
- `revalidateAuditSnapshot(snapshot)`
- `assertSnapshotUnchanged(snapshot)`

## Exit criteria

Mutating a tracked or audited untracked file changes validation result.

---

# WP-04 — Verification Contract

## Goal

The orchestrator, not worker prose, owns the required checks.

## Files to inspect and touch

- `pipeline-ui/lib/verification-contract.js` (new module implementing contract parser, runner, and fallback resolver)
- `pipeline-ui/server.js` (integrate verification contract runner into audit preparation)

## Configuration and Fallback Policy

Add project-level trusted config, for example:

`.orchestrator/verification.json`

Do not silently execute worker-provided commands.

### Default Fallback Contract for Unconfigured Projects:
If `.orchestrator/verification.json` does not exist in target project, Orchestrator resolves a deterministic baseline based on project manifest:
1. If `package.json` exists in project root:
   - Required: `git_diff_check`, `npm_test` (`npm test`)
2. If `pyproject.toml` or `requirements.txt` or `pytest.ini` exists:
   - Required: `git_diff_check`, `python_compile` (`python -m py_compile`), `pytest` (`pytest -q`)
3. Generic fallback:
   - Required: `git_diff_check` (`git diff --check`)
Explicit `.orchestrator/verification.json` always takes precedence over default fallbacks.

## Check types

Prefer semantic types:

- `python_compile`
- `node_syntax`
- `npm_test`
- `git_diff_check`
- `ajv_compile`
- `custom_allowlisted`

## Result object

Each run returns:

```json
{
  "evidence_id": "...",
  "snapshot_id": "...",
  "check_id": "...",
  "command_display": "...",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "started_at": "...",
  "ended_at": "...",
  "stdout_hash": "...",
  "stderr_hash": "..."
}
```

## Required behavior

- failed required check cannot be overridden by worker claim;
- unavailable required check means BLOCKED, not PASS;
- output size bounded with truncation metadata;
- secrets redacted before model delivery where feasible.

---

# WP-05 — Evidence Packet Builder

## Goal

Build a deterministic baseline packet before model audit.

## Packet contents

- snapshot metadata;
- changed-file list;
- diff stat;
- full diff when under safe size threshold;
- otherwise per-file diff hashes + retrievable source;
- Verification Contract result summary;
- raw failing outputs;
- WorkerReport claim manifest;
- declared audit capability.

## Important

Do not dump the full project.

Baseline packet provides high-signal facts.

Active Inspector provides selective expansion.

---

# WP-06 — Active Inspector / correct Codex task authority

## Goal

Run the auditor against the actual target project with read-only authority.

## Files to inspect and touch

- `pipeline-ui/server.js` (update `runCodexWithPrompt` signature and process execution options)

## `runCodexWithPrompt` change

Update signature:
```javascript
function runCodexWithPrompt(targetModel, promptText, options = {})
```
Where `options` supports:
- `cwd`: absolute target project path
- `timeout`: default 180000 ms
- `sandbox`: `'read-only'`
- `outputSchemaPath`: path to JSON Schema file for structured output

When `options.cwd` is provided:
- Node child process options must include `cwd: options.cwd`.
- Codex CLI invocation must include `-C "${options.cwd}"`.

Do not rely on “Local Path: ...” prompt text.

The target project path must come from Orchestrator project resolution and be passed as trusted process configuration.

## Sandbox

Inspector baseline:

`read-only`

Passed via `-s read-only` to `codex exec`.

Do not combine read-only mode with `--approve-for-me`, because current Codex CLI semantics map `--approve-for-me` to automatic review with `workspace-write`, which conflicts with `--sandbox read-only`.

## Full Harness health gate

Before declaring Active Inspector capability, verify:

- route/model installed;
- proxy healthy;
- Full Harness mode;
- tunnel runtime healthy;
- expected connector available;
- current Codex task contains trusted CWD/workspace authority.

If any are missing:

- downgrade explicitly to Evidence Packet mode if policy allows;
- otherwise block.

## Read-only goal

Auditor may:

- read/search source;
- inspect git diff/status;
- run read-only commands and trusted checks.

Auditor must not modify source.

---

# WP-07 — Structured auditor protocol

## Goal

Remove prose substring parsing.

## Output

Use JSON Schema / `--output-schema` where supported.

The model response must validate before any directive is eligible for dispatch.

## Statuses

Recommended:

- `FIX_REQUIRED`
- `READY_FOR_NEXT_WORKORDER`
- `BLOCKED_INSUFFICIENT_EVIDENCE`
- `BLOCKED_SNAPSHOT_INVALIDATED`
- `AUDIT_PROTOCOL_ERROR`
- `ROADMAP_COMPLETE`

Avoid ambiguous PASS/COMPLETE reuse across scopes.

## Required fields

See `09-AUDIT-RESULT-SCHEMA.md`.

## Failure

Invalid JSON/schema:

- persist raw response for diagnostics;
- mark protocol error;
- do not dispatch.

---

# WP-08 — Claim/evidence reconciliation

## Goal

Make “independent audit” explicit.

For each WorkerReport claim:

classify:

- `CORROBORATED`
- `CONTRADICTED`
- `UNVERIFIED`
- `NOT_APPLICABLE`

Example:

Worker claim:

“Only schema file changed.”

Machine evidence:

changed files = schema + README.

Result:

`CONTRADICTED`

This reconciliation must be visible to the user.

---

# WP-09 — Directive Gate

## Goal

Prevent stale or malformed audit output from reaching worker.

Before dispatch:

1. structured result valid;
2. directive present;
3. target worker idle;
4. snapshot revalidation passes;
5. no required evidence missing;
6. audit result snapshot matches current snapshot;
7. project/session/worker identity still matches;
8. dispatch lock acquired.

If any fail:

do not dispatch.

---

# WP-10 — Negative regression suite

Implement every case in `10-NEGATIVE-TEST-MATRIX.md`.

This WP is not complete with only happy-path tests.

The primary success metric is:

**No tested fault condition can create false PASS, false verified dispatch, or stale report attribution.**

---

# WP-11 — GitHub checkpoint integration

## Goal

Use GitHub as a second source at meaningful milestones, not every micro-edit.

At checkpoint:

- compare local candidate SHA with pushed SHA;
- inspect remote commit/diff;
- fetch status/checks if available;
- store checkpoint provenance.

Do not require a push for every local audit.

---

# WP-12 — Cleanup and compatibility removal

Only after new pipeline is stable:

- remove legacy verdict substring parser;
- remove positive missing-report fallback;
- remove semantic `testPassed` compatibility field or rename/migrate it;
- remove arbitrary command API;
- remove “last paragraph as directive” fallback;
- update README claims;
- document test tiers.

## Final exit

All roadmap acceptance gates pass.

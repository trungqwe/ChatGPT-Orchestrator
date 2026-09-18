# Negative Regression Test Matrix

## Purpose

The primary question is not “can the happy path work?”

It is:

**Can any known fault be converted into false success?**

## NT-001 — Queue acknowledged, no turn start

Setup:

- mock queue command exit 0;
- do not emit `task_started`.

Expected:

- queued=true;
- verified=false;
- no target turn;
- watcher not treated as successfully bound.

## NT-002 — Wrong start turn

Emit `task_started` for a different turn/session.

Expected:

- ignored;
- verification fails/times out.

## NT-003 — Timeout with previous completed report

Preload old `task_complete`.

Start new expected turn that never completes.

Expected:

- success=false;
- old report diagnostic only;
- no stale attribution.

## NT-004 — Wrong completion turn

Expected turn X.

Emit completion Y.

Expected:

- ignored/block.

## NT-005 — Worker says pass, trusted test fails

Worker claim:

“all tests passed.”

Trusted verifier:

exit 1.

Expected:

- claim=CONTRADICTED;
- no READY/PASS.

## NT-006 — Worker says only A changed; machine sees A+B

Expected:

- contradiction recorded;
- scope policy determines FIX/BLOCK.

## NT-007 — Auditor returns malformed JSON

Expected:

- AUDIT_PROTOCOL_ERROR;
- no dispatch.

## NT-008 — Valid JSON with wrong snapshot ID

Expected:

- reject result.

## NT-009 — Snapshot changes during model audit

Modify audited file after model starts.

Expected:

- revalidation fails;
- directive not dispatched.

## NT-010 — Missing required verifier

Required check executable/config unavailable.

Expected:

- BLOCKED_INSUFFICIENT_EVIDENCE.

## NT-011 — Unauthorized local HTTP request

Call privileged endpoint without token.

Expected:

- 401/403;
- no process execution.

## NT-012 — Non-loopback exposure test

Verify listener address is loopback.

Expected:

- no wildcard listener.

## NT-013 — Raw shell injection attempt

Submit shell control syntax through semantic verifier endpoint.

Expected:

- rejected as invalid check ID/input;
- no shell interpretation.

## NT-014 — Antigravity syntax regression

Introduce invalid Python into dispatcher fixture.

Expected:

- compile verifier catches it.

## NT-015 — Full Harness expected but browser-only

Expected:

- explicit capability downgrade or block;
- never label audit as active-inspector.

## NT-016 — Connector/tool approval failure

Tool call cannot be approved/executed.

Expected:

- fail closed;
- no fabricated evidence.

## NT-017 — Duplicate dispatch while worker busy

Expected:

- second dispatch rejected.

## NT-018 — Missing WorkerReport

Expected:

- no positive synthetic report;
- audit is blocked or proceeds only under a specifically designed “machine-only audit” mode.

## NT-019 — Prose contains words `lỗi` and `sửa`

Structured result says READY.

Expected:

- structured status wins;
- no substring parser exists.

## NT-020 — Evidence output truncated

Expected:

- `truncated=true`;
- hash preserved;
- auditor knows evidence is incomplete and can request targeted expansion where supported.

## NT-021 — Malformed UTF-8 in verifier output or git diff

Setup:

- Inject invalid UTF-8 byte sequences into verifier output or staged file.

Expected:

- Sanitized safely with replacement character `U+FFFD` without throwing unhandled exceptions or corrupting JSON serialization.

## NT-022 — Path traversal or symlink escape in worktree/project file extraction

Setup:

- Request file via `/api/extract/worktree/:sessionId?file=../../sensitive.txt` or through an absolute path outside workspace.

Expected:

- Rejected with 403/404;
- Canonical path containment strictly enforced.

## NT-023 — Verifier command process killed by timeout or OS signal

Setup:

- Verifier command hangs or is killed via SIGKILL / process termination.

Expected:

- Recorded as `exit_code: null`, `timed_out: true`, `error: "TIMEOUT"`;
- Treated as fail-closed failure; cannot authorize PASS.

## NT-024 — Concurrent audit requests for same project

Setup:

- Trigger two audit requests for the same project simultaneously.

Expected:

- Second request rejected with 409 Conflict or cleanly queued with separate snapshot ID;
- No race condition or interleaved evidence.

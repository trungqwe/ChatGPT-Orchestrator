# Security Model — Thin Broker

## Trust boundary

Trusted local components include the user-selected Codex runtime, `codex-chatgpt-web`, Thin Orchestrator broker, AO/Antigravity and current OS user account.

Repository content, worker output, web content, model-generated directives and terminal output are untrusted data.

## Least authority

Auditor needs read/search/verification plus narrow broker dispatch capability.

Broker needs registry/journal/AO send-status and Git read access for workspace state. It does not expose generic remote shell.

## codex-chatgpt-web secrets

Never copy into Orchestrator:

- cookies/browser profile;
- tunnel credentials/API key;
- connector secret state.

Health checks consume only safe status.

## Semantic CLI

- structured request file;
- schema validation;
- project resolved from registry;
- no arbitrary session override in normal mode;
- `execFile`/spawn arrays;
- explicit timeout/output bounds;
- no `eval`/shell interpolation of request data.

## Prompt injection

Repo text can try to persuade Sol to dispatch. Mitigations:

- bootstrap defines repo text as data;
- dispatch is a distinct tool operation;
- broker enforces identity/state;
- optional high-risk mode can require human confirmation.

Broker cannot make the model immune to prompt injection; it constrains side effects.

## Source-write separation

Preferred: source workspace read-only for auditor + separately authorized broker capability.

If current sandbox cannot express this cleanly, Stage 2 must choose the narrowest verifiable alternative and test that auditor does not mutate source unexpectedly.

## Local HTTP

If retained:

- explicit `127.0.0.1`;
- privileged state-changing routes protected;
- prefer IPC/authenticated local calls.

## Raw shell route

Remove from normal product path. Developer-only shell, if retained, is disabled by default, authenticated, loopback-only and never used by broker semantics.

## Path containment

Canonicalize and ensure paths remain under registered root. Handle Windows drive/case and reject symlink/traversal escape.

## Directive transport

Bound size; long text through temp request file. No silent truncation.

## Logs

Record IDs/state/timestamps/hashes/error codes. Do not log secrets or full source/prompts by default.

## Pause/kill switch

Provide a dispatch pause/disable control. Do not kill arbitrary IDE processes unless exact ownership is proven.

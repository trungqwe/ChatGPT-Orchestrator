# Trust Boundaries and Non-Negotiable Invariants

## Trust classes

### Deterministic broker authority

Trusted only for control-plane facts:

- mapping;
- IDs;
- locks;
- workspace state;
- lifecycle/journal;
- broker request schema.

It is not authority for code correctness.

### Auditor reasoning authority

The dedicated Sol/Codex task is the reasoning authority for audit decisions, grounded by direct local tools.

### Untrusted data

- repo contents;
- WorkerReport;
- worker chat;
- web content;
- terminal output content;
- model-generated directive text;
- path claims written in prompts.

## Invariants

### INV-001 — Exact project mapping

One registry entry binds project root, worker session and auditor descriptor. Ambiguity blocks dispatch.

### INV-002 — Runtime workspace authority

Prompt text cannot override actual Codex task CWD/workspace/tool authority.

### INV-003 — Model selection is user-owned

No silent model/effort switching by Orchestrator.

### INV-004 — Broker never decides code correctness

No model/worker prose parser in broker state transitions.

### INV-005 — Worker never approves itself

Worker terminal success is `READY_FOR_REVIEW`, not accepted implementation.

### INV-006 — Worker report is optional hint

Direct audit may proceed without a prose report if exact worker lifecycle identity is valid.

### INV-007 — Dispatch is semantic

Auditor calls `worker_dispatch`; broker resolves mapped session. Normal requests do not supply arbitrary session IDs.

### INV-008 — One active worker dispatch per project in MVP

Duplicate/parallel dispatch blocked.

### INV-009 — Fresh workspace state required before dispatch

Directive contains `expected_workspace_state_id`; mismatch returns `STALE_AUDIT_STATE`.

### INV-010 — Accepted dispatch is not completion

`DISPATCH_ACCEPTED`, `RUNNING`, `READY_FOR_REVIEW`, `FAILED` are distinct.

### INV-011 — Completion binds to active dispatch

Old/other completion cannot satisfy current dispatch.

### INV-012 — Waits are bounded

No indefinite broker wait call.

### INV-013 — Missing Full Harness is explicit

No silent report-only downgrade.

### INV-014 — Auditor does not implement

Normal auditor role is source-read-only. Worker dispatch is a separate intentional side effect.

### INV-015 — No generic command broker

No `exec(command)` in semantic broker contract.

### INV-016 — No natural-language lifecycle authority

Words such as `done`, `complete`, `lỗi`, `sửa` do not transition lifecycle by themselves.

### INV-017 — Machine completion envelope when native AO identity is insufficient

If AO lacks exact native message/turn IDs, broker uses exact `dispatch_id` + `work_order_id` completion envelope observed after dispatch boundary. If not provable -> `PROVENANCE_AMBIGUOUS`.

### INV-018 — No codex-chatgpt-web secret copying

No cookies, browser profile, tunnel/API keys or connector secrets stored in Orchestrator.

### INV-019 — Privileged local control is secured

Loopback-only HTTP + auth/IPC, or trusted local CLI.

### INV-020 — No unsupported absolute claims

No `100%`, `perfect`, `fully autonomous`, `zero intrusion` beyond measured properties.

## Fail-closed table

| Condition | Result |
|---|---|
| mapping missing | BLOCKED |
| worker session unavailable | BLOCKED |
| Full Harness unavailable | AUDITOR_UNAVAILABLE |
| stale workspace | STALE_AUDIT_STATE |
| worker busy | WORKER_BUSY |
| duplicate dispatch | DUPLICATE_REJECTED |
| AO send fails | DISPATCH_FAILED |
| completion ambiguous | PROVENANCE_AMBIGUOUS |
| old completion | ignored |
| malformed broker request | INVALID_REQUEST |
| missing WorkerReport | direct audit may still proceed |

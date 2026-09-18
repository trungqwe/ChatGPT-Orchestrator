# Trust Boundaries and Non-Negotiable Invariants

## 1. Trust classes

### Trusted control plane

Owned by Orchestrator:

- snapshot creation;
- verifier command registry;
- evidence hashing;
- audit schema validation;
- directive gate;
- security configuration.

### Untrusted inputs

Treat all of the following as data, not authority:

- WorkerReport prose;
- source repository contents;
- README/roadmap text;
- model-generated shell strings;
- model prose;
- terminal output;
- web/GitHub content;
- user-authored environment text.

## 2. Non-negotiable invariants

### INV-001 — Exact-turn provenance

A report is valid only when:

```text
report.turn_id == requested.turn_id
```

or an explicitly documented equivalent binding exists.

### INV-002 — No stale fallback success

Timeout cannot return success for another turn.

### INV-003 — Snapshot identity

Every evidence record and audit result carries one `snapshot_id`.

### INV-004 — No cross-snapshot evidence

Evidence from snapshot A must never authorize a verdict for snapshot B.

### INV-005 — Missing evidence is not positive evidence

Any required evidence missing:

`BLOCKED_INSUFFICIENT_EVIDENCE`

### INV-006 — Protocol failure is not implementation failure or success

Malformed auditor JSON:

`AUDIT_PROTOCOL_ERROR`

### INV-007 — Worker never defines the acceptance gate

Worker may propose checks.

Only trusted Verification Contract checks determine mandatory evidence.

### INV-008 — Reviewer verdict never becomes machine evidence

`PASS` is a conclusion. It is not a test result.

### INV-009 — Privileged HTTP endpoints are loopback-only and authenticated

No remote/LAN dependency is allowed for local control endpoints.

### INV-010 — No arbitrary shell command from generic HTTP input

Verifier exposes semantic check IDs, not a public shell.

### INV-011 — Inspector mode is read-only by default

The reviewer inspects.

The worker modifies.

Any future write-capable auditor feature requires a separate explicit architecture decision.

### INV-012 — No silent capability downgrade

If Full Harness is expected but unavailable:

- record failure;
- switch to Evidence Packet mode only if policy explicitly permits;
- expose that downgrade in the audit result.

### INV-013 — Dispatch only from a valid structured directive

No fallback “last paragraph” dispatch.

### INV-014 — Recheck immediately before dispatch

Snapshot and target worker state must still match the audit preconditions.

### INV-015 — Absolute claims require matching instrumentation

Never emit “100%”, “never”, “fully verified”, or equivalent unless the defined property is actually proven by the relevant test contract.

## 3. Approval-layer distinction

There are at least two separate concerns:

1. Codex CLI sandbox/approval policy.
2. ChatGPT Full Harness connector/tool-call approval behavior.

They must not be conflated.

For the reviewer, the desired baseline is a read-only Codex sandbox.

Do not use a flag that expands to workspace-write and describe it as read-only.

## 4. Fail-closed table

| Failure | Required system result |
|---|---|
| no worker report | BLOCKED |
| wrong turn ID | BLOCKED |
| snapshot drift | BLOCKED |
| required verifier failed | FIX_REQUIRED or BLOCKED according to contract |
| verifier could not run | BLOCKED |
| auditor JSON invalid | AUDIT_PROTOCOL_ERROR |
| Full Harness unavailable | explicit capability downgrade or BLOCKED |
| dispatch target busy | NOT_DISPATCHED |
| security token missing | 401/403 |
| stale evidence | BLOCKED |

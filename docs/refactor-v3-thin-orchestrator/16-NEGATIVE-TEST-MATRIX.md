# v3 Negative Test Matrix

Primary question:

> Can ambiguity, stale state or wrong mapping cause a directive to reach the wrong worker or cause the system to attribute the wrong lifecycle state?

## Registry / mapping

### V3-NT-001 Unknown project

Expected `PROJECT_NOT_FOUND`; no AO call.

### V3-NT-002 Duplicate basename roots

No basename guessing; exact registry ID/root required.

### V3-NT-003 Missing worker session

Expected `WORKER_SESSION_UNAVAILABLE`.

### V3-NT-004 Auditor task/CWD mismatch

Bootstrap/health fails; no dispatch.

## Dispatch / state freshness

### V3-NT-005 Worker already active

Second dispatch -> `WORKER_BUSY`; no AO call.

### V3-NT-006 Duplicate same WorkOrder delivery

Reject or idempotently return existing active dispatch; never double-send.

### V3-NT-007 Workspace changes after Sol audit

Expected `STALE_AUDIT_STATE`.

### V3-NT-008 Untracked source changes

State mismatch.

### V3-NT-009 Submodule changes

State mismatch.

### V3-NT-010 Symlink escape

Snapshot records link safely without reading outside root.

## AO lifecycle

### V3-NT-011 AO send exit nonzero

`DISPATCH_FAILED`; no RUNNING state.

### V3-NT-012 Send accepted but no completion

Bounded waits remain nonterminal; no fabricated READY.

### V3-NT-013 Previous dispatch completion appears

Active D2; completion D1 ignored.

### V3-NT-014 Wrong WorkOrder completion

Ignored or provenance ambiguous according to exact adapter rules.

### V3-NT-015 Completion envelope lacks required dispatch ID when no native exact ID

`PROVENANCE_AMBIGUOUS`.

### V3-NT-016 Worker says `done` in prose only

No lifecycle transition.

### V3-NT-017 Completion from another project/session

Ignored/rejected.

## Auditor capability

### V3-NT-018 Full Harness unavailable

Loop stops; no report-only silent downgrade.

### V3-NT-019 `codex-chatgpt-web` doctor unhealthy

Auditor unavailable.

### V3-NT-020 Codex task wrong workspace

No dispatch.

### V3-NT-021 Browser/ChatGPT turn ends while worker runs

Broker state preserved; auditor can resume and inspect state.

### V3-NT-022 Orchestrator restart while worker runs

Reconcile exact active dispatch or mark provenance ambiguous; never assume IDLE.

## Broker input/security

### V3-NT-023 Raw command field submitted

Schema reject.

### V3-NT-024 Auditor tries worker-session override

Reject in normal mode.

### V3-NT-025 Directive too large

Bounded reject or request-file mode; no silent truncation.

### V3-NT-026 Malformed JSON request

`INVALID_REQUEST`, nonzero schema exit.

### V3-NT-027 Directive contains shell metacharacters

No shell interpretation because request is data/argument file.

### V3-NT-028 Unauthorized HTTP dispatch

401/403 or route absent.

### V3-NT-029 Non-loopback listener

Security test fails.

### V3-NT-030 Path traversal

Rejected.

## Crash/durability

### V3-NT-031 Broker crash after dispatch intent before AO result

Restart -> ambiguous/reconcile; no automatic resend.

### V3-NT-032 Corrupt lifecycle store

Fail closed; no assumption worker idle.

## Expected workspace mutations

### V3-NT-033 Worker changes workspace while running

Allowed. New state captured after review-ready.

### V3-NT-034 Third party changes workspace after worker ready while Sol audits

Sol sees current state; next dispatch stale-state gate blocks if state changes again.

## Model-quality boundary

### V3-NT-035 Worker report claims tests passed

No effect on broker lifecycle.

### V3-NT-036 Repo prompt injection requests AO send

Broker still enforces mapping/state. Optional high-risk policy may require human approval.

### V3-NT-037 Sol creates semantically poor directive with valid schema

Broker does not grade semantics. This is auditor-quality risk; pause/human policy may mitigate.

### V3-NT-038 Sol says roadmap complete while worker active

No automatic merge/release; active worker state remains.

## Legacy isolation

### V3-NT-039 `codex queue` emits misleading turn ID

Not v3 auditor authority; no effect on v3 loop.

### V3-NT-040 Legacy `/audit-and-direct` produces positive result

When v3 is active, legacy semantic result cannot dispatch v3 worker path.

## Wait bounds

### V3-NT-041 Wait timeout requested above max

Clamp/reject; no indefinite call.

## Concurrency & Malformed Envelope

### V3-NT-042 Concurrent multi-project dispatches do not cross-talk

Dispatches for `project_A` and `project_B` have independent locks and state; `project_A` active does not block `project_B` dispatch.

### V3-NT-043 Malformed or truncated completion envelope

File exists but contains non-JSON or missing required schema fields (`project_id`, `work_order_id`, `dispatch_id`); broker rejects with `PROVENANCE_AMBIGUOUS`.

### V3-NT-044 Codex process restart while worker runs

Codex IDE crashes/restarts; broker journal retains active dispatch; newly launched auditor task reads `worker-status` and seamlessly recovers lifecycle state.

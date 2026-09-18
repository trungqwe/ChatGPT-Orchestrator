# Antigravity Worker Adapter

## Role

Antigravity implements. The adapter delivers directives and observes lifecycle. It does not make worker prose authoritative.

## Semantic states

```text
IDLE
DISPATCHING
DISPATCH_ACCEPTED
RUNNING
READY_FOR_REVIEW
FAILED
PROVENANCE_AMBIGUOUS
```

`ao send` exit 0 means `DISPATCH_ACCEPTED`, not completion.

## Dispatch envelope

The broker wraps Sol-authored directive with identity metadata:

```text
[ORCHESTRATOR_WORK_ORDER]
project_id: ai-multi-task
work_order_id: WO-123
dispatch_id: <uuid>
expected_base_state: <workspace_state_id>

<Sol-authored directive>

[REQUIRED_COMPLETION_ENVELOPE]
Return one machine-readable completion envelope with:
project_id
work_order_id
dispatch_id
state=READY_FOR_REVIEW
Do not self-approve roadmap/phase.
```

Broker does not rewrite directive semantics.

## Completion provenance hierarchy

Verified AO runtime inspection confirms:
- `ao send --session <session> --message <text>` exits 0 upon daemon receipt, does not support `--json`, and provides no message or turn ID.
- `ao send --steer` provides steering confirmation text but not machine-readable JSON turn completion IDs.
- `ao session get <id> --json` returns aggregate session state, not per-prompt turn completion events.

Therefore, the completion provenance hierarchy is:

1. Exact AO-native message/turn/operation identity, if real daemon API capability is later exposed;
2. **PRIMARY MVP MECHANISM**: Exact dispatch/work-order machine completion envelope observed after dispatch boundary;
3. If neither is verifiable -> fail closed with `PROVENANCE_AMBIGUOUS`.

Never use “latest report” or plain `done` prose as authority.

## Completion envelope

```json
{
  "type": "worker_completion",
  "schema_version": 1,
  "project_id": "ai-multi-task",
  "work_order_id": "WO-123",
  "dispatch_id": "D-...",
  "state": "READY_FOR_REVIEW"
}
```

Optional claims may list changed files/checks but remain untrusted hints.

## Long WorkerReport is optional

Sol inspects actual workspace. The worker need not write a large semantic report unless useful for implementation notes.

## Bounded wait

Input:

```json
{
  "project_id": "ai-multi-task",
  "dispatch_id": "D-...",
  "timeout_secs": 10
}
```

Nonterminal:

```json
{
  "state": "RUNNING",
  "terminal": false,
  "dispatch_id": "D-..."
}
```

Terminal:

```json
{
  "state": "READY_FOR_REVIEW",
  "terminal": true,
  "dispatch_id": "D-...",
  "completion_identity": {
    "method": "completion_envelope",
    "work_order_id": "WO-123"
  }
}
```

## Duplicate prevention

While `DISPATCHING`, `DISPATCH_ACCEPTED` or `RUNNING`, a second dispatch for the project is rejected in MVP.

## Missing session

Do not guess similarly named sessions. Return `WORKER_SESSION_UNAVAILABLE`.

## Worker timeout

A wait timeout is a lifecycle fact, not a code-quality verdict. Sol decides whether to keep waiting or involve the human.

## Capability probe before implementation

Inspect actual AO CLI/daemon for:

- stable session ID;
- send response;
- message/turn IDs;
- status;
- transcript format;
- completion/cancel primitives.

Use the strongest real identity. Do not invent one.

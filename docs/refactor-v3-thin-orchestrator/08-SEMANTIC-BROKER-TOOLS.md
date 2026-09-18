# Semantic Broker Tool Contract

## Principle

Expose operations, not shell. Sol supplies intent/directive; broker supplies target mapping, state checks and transport.

## MVP adapter

A CLI backed by a broker library. Every command emits one JSON object on stdout, diagnostics on stderr, bounded output and documented exit codes.

No arbitrary command input.

## `snapshot`

Request:

```json
{"operation":"snapshot","project_id":"ai-multi-task"}
```

Response:

```json
{
  "ok": true,
  "project_id": "ai-multi-task",
  "workspace_state_id": "sha256:...",
  "head_sha": "...",
  "branch": "...",
  "dirty": true,
  "changed_files": ["..."],
  "created_at": "..."
}
```

This is a freshness guard, not an evidence packet.

## `worker-status`

```json
{
  "ok": true,
  "project_id": "ai-multi-task",
  "worker_state": "IDLE",
  "active_dispatch_id": null,
  "active_work_order_id": null
}
```

## `worker-dispatch`

Request:

```json
{
  "schema_version": 1,
  "operation": "worker_dispatch",
  "project_id": "ai-multi-task",
  "work_order_id": "WO-018",
  "expected_workspace_state_id": "sha256:...",
  "directive": "...",
  "audit_metadata": {
    "auditor": "codex-full-harness",
    "decision_id": "A-..."
  }
}
```

Validation:

1. schema valid;
2. project exists;
3. worker enabled/session available;
4. no active dispatch;
5. WorkOrder sequence policy valid;
6. expected workspace state matches current;
7. directive nonempty/within limit;
8. lock acquired;
9. dispatch intent durably journaled.

Broker does not interpret directive semantics.

Success:

```json
{
  "ok": true,
  "state": "DISPATCH_ACCEPTED",
  "dispatch_id": "D-...",
  "work_order_id": "WO-018",
  "worker_session": "mapped-session",
  "workspace_state_id": "sha256:..."
}
```

Stale:

```json
{
  "ok": false,
  "code": "STALE_AUDIT_STATE",
  "expected_workspace_state_id": "...",
  "observed_workspace_state_id": "..."
}
```

Sol must inspect again.

## `worker-wait`

Request:

```json
{
  "operation": "worker_wait",
  "project_id": "ai-multi-task",
  "dispatch_id": "D-...",
  "timeout_secs": 10
}
```

Rules:

- timeout bounded/clamped;
- wrong dispatch rejected;
- old completion ignored;
- no WorkerReport semantic parse needed.

## `worker-cancel`

Not MVP unless AO provides a safe exact cancellation primitive. Never fake cancellation by killing unrelated IDE processes.

## Optional `workflow-complete`

May record Sol's roadmap-complete decision, but does not merge/push/release automatically.

## Request-file mode

Long directive is passed via broker-owned temp JSON request file with restrictive permissions, deleted after use. Avoid shell quoting/command length problems.

## Exit codes

| Exit | Meaning |
|---:|---|
| 0 | handled; inspect JSON `ok` |
| 2 | invalid request/schema |
| 3 | mapping missing |
| 4 | worker busy |
| 5 | stale workspace |
| 6 | transport failure |
| 7 | provenance ambiguous |
| 8 | broker/journal failure |

## Future MCP adapter

Expose identical semantics:

- `project_snapshot`;
- `worker_status`;
- `worker_dispatch`;
- `worker_wait`.

MCP and CLI must call the same broker library; no duplicated business logic.

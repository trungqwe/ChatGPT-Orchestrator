# Migration, Rollback and Observability

## Strategy

Do not rewrite the product in one commit. Run v3 alongside legacy until live agent-to-agent cycle is proven.

## Suggested flags

```text
ORCH_V3_BROKER_CORE
ORCH_V3_REGISTRY
ORCH_V3_WORKSPACE_STATE
ORCH_V3_WORKER_LIFECYCLE
ORCH_V3_AGENT_CLI
ORCH_V3_DISABLE_LEGACY_AUDIT
```

Every flag needs owner/removal plan.

## Shadow phase

Before real AO dispatch, Sol calls broker dry-run. Broker validates/logs what would be sent but causes no worker mutation.

## Live pilot

Use a fixture project and one small WorkOrder with human observation before real project adoption.

## Rollback units

Keep independently revertible:

- registry;
- state gate;
- AO adapter;
- semantic CLI;
- UI integration;
- legacy audit deactivation.

Do not mix package upgrades/UI redesign.

## Event journal

Recommended events:

```text
registry.project_bound
registry.project_unbound
workspace.snapshot_created
dispatch.requested
dispatch.blocked
dispatch.accepted
worker.running
worker.ready_for_review
worker.failed
worker.provenance_ambiguous
auditor.health_checked
auditor.loop_paused
workflow.completed
```

Common fields:

- event ID/time;
- project ID;
- WorkOrder ID;
- dispatch ID;
- workspace-state ID;
- worker session identity;
- result/error code.

Full directive text is optional/configurable, not required in normal logs.

## Metrics

Track facts, not marketing percentages:

- stale-state blocks;
- duplicate blocks;
- dispatch rejection reasons;
- worker wait duration;
- provenance ambiguity count;
- Full Harness availability;
- successful controlled cycles;
- manual intervention count.

## Recovery

### Orchestrator restart

Reload journal/state and reconcile; never silently assume IDLE.

### AO unavailable

Do not mark complete.

### Auditor gone

Worker/broker state persists. User resumes/new auditor task and reads current state.

### codex-chatgpt-web unavailable

No new audit-driven dispatch.

## Legacy audit rollback

During migration legacy UI may remain behind a flag. After v3 acceptance: v3 default -> legacy shadow/read-only -> remove. Do not maintain two semantic brains indefinitely.

## GitHub checkpoints

Recommended at: pre-migration, broker core, first live cycle, pre-legacy removal, release candidate.

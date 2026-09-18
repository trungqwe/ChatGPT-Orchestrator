# Target Architecture — Thin Orchestrator

## Objective

Create a two-agent engineering loop:

- Sol High = architect/auditor;
- Antigravity = implementer;
- Orchestrator = deterministic broker.

## Topology

```text
                         +------------------------+
                         | User                   |
                         | selects project/task   |
                         +-----------+------------+
                                     |
                                     v
                         +------------------------+
                         | Dedicated Codex Task   |
                         | ChatGPT Web Sol High   |
                         | Full Harness           |
                         +-----+-------------+----+
                               |             |
                    read/search/exec         | semantic broker operations
                               |             |
                               v             v
                         Local Project   Thin Orchestrator
                               ^        / registry / locks
                               |       / state gate / journal
                               |      v
                               |   AO adapter
                               |      |
                               +-- Antigravity
                                   implementation
```

## Operating loop

### Bootstrap

User opens the intended project in Codex, selects the desired ChatGPT Web Sol model, verifies Full Harness, starts a dedicated auditor task and provides the bootstrap instructions.

### Auditor prepares a WorkOrder

Sol:

1. reads roadmap/policy;
2. inspects current code/diff/tests;
3. obtains `workspace_state_id` from broker;
4. creates a precise worker directive;
5. calls `worker_dispatch`.

### Broker dispatches

Broker:

1. resolves project mapping;
2. verifies worker mapping;
3. checks active dispatch/lock;
4. recomputes workspace state;
5. rejects stale audit if state differs;
6. creates `dispatch_id`;
7. wraps directive with control metadata;
8. uses AO adapter to send to mapped Antigravity session;
9. journals outcome.

### Auditor waits

Sol calls bounded `worker_wait`. Nonterminal polling is normal.

### Auditor reviews

At `READY_FOR_REVIEW`, Sol independently reads actual filesystem/diff/callers/tests and runs appropriate checks. Worker report is optional hint only.

### Auditor continues

If more work is needed, Sol creates another WorkOrder using a fresh workspace state. If roadmap is complete, Sol does not dispatch and reports completion to the human.

## No normal Orchestrator audit brain

Legacy `/api/orchestrator/audit` and `/api/orchestrator/audit-and-direct` may coexist temporarily during migration but are not the v3 brain.

## Broker surfaces

MVP:

- reusable broker library;
- semantic CLI;
- UI/status calls into broker.

Optional later:

- MCP adapter;
- managed Codex task adapter.

## UI after pivot

UI becomes a control/status plane showing:

- project mapping;
- worker session;
- auditor task descriptor;
- expected model label;
- Full Harness health;
- active WorkOrder/dispatch;
- workspace state;
- event log;
- pause state.

It does not generate a semantic code-quality verdict.

## Full Harness boundary

`codex-chatgpt-web` owns browser, ChatGPT login/profile, tunnel and MCP bridge. Orchestrator never copies those secrets.

## Failure behavior

- Full Harness unavailable -> stop audit loop;
- wrong mapping -> broker rejects;
- worker busy -> broker rejects;
- workspace changed -> stale-audit rejection;
- completion identity ambiguous -> no READY state;
- malformed broker request -> structured failure;
- journal durability failure -> fail closed according to policy.

## Degraded evidence-packet mode

Not part of MVP. If introduced later it must be explicitly labeled and must not silently replace direct inspection.

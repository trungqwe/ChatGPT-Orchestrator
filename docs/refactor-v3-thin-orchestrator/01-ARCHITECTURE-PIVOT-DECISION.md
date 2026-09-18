# Architecture Pivot Decision

## Decision

Adopt **Persistent Codex Auditor + Antigravity Implementer + Thin Orchestrator Broker**.

Do not continue toward an Orchestrator-owned semantic audit engine as the normal path.

## Why

When `codex-chatgpt-web` Full Harness is healthy, ChatGPT Web can operate inside the current Codex task and use its local files, terminal/search and tools. Therefore Sol can independently inspect the real implementation instead of receiving a preselected report/context packet.

A second semantic planner in Orchestrator would duplicate:

- source selection;
- test interpretation;
- code review;
- verdict generation;
- prompt generation.

The simpler responsibility split is safer and easier to reason about.

## Responsibility split

### Codex / ChatGPT Web Sol High

Owns:

- architecture reasoning;
- direct source/diff/caller/test inspection;
- appropriate local verification;
- defect identification;
- WorkOrder acceptance/rejection reasoning;
- next directive content.

Does not normally edit implementation.

### Antigravity

Owns:

- implementation edits;
- scoped implementation-time tests;
- review-ready completion signal;
- optional claims/report.

Does not approve itself or select the next roadmap step.

### Thin Orchestrator

Owns:

- registry;
- identity;
- locks;
- lifecycle;
- workspace-state freshness gate;
- semantic worker dispatch/wait;
- journal/security.

Does not decide whether code is correct.

## Why not let Sol call raw `ao.exe send`

Technically Full Harness can execute local commands, but direct raw AO control loses useful guardrails:

- wrong session target;
- duplicate dispatch;
- stale directive;
- worker already busy;
- runaway ping-pong;
- no durable WorkOrder/dispatch audit trail.

Preferred flow:

```text
Sol -> worker_dispatch semantic operation -> broker validates -> mapped AO session
```

## Why CLI first

MVP uses a semantic CLI backed by a broker library:

```text
agent-broker snapshot
agent-broker worker-status
agent-broker worker-dispatch --request-file ...
agent-broker worker-wait ...
```

Advantages:

- fewer integration layers;
- easy deterministic tests;
- no additional MCP registration required;
- Full Harness can invoke it through native Codex tools;
- later MCP adapter can reuse identical broker logic.

If real Stage 2 validation proves MCP-first is materially simpler or safer, docs may be revised before implementation.

## Model selection

Model selection is user-owned. Orchestrator may display an expected model label but must not manipulate ChatGPT UI or silently switch model/effort.

## Auditor task ownership

MVP: user-owned dedicated persistent Codex task.

Future managed task control is allowed only when an exact documented native thread/turn API is verified. Do not use rollout timing heuristics as an authority substitute.

## v2 work carried forward

Keep:

- characterization-first discipline;
- exact identity/provenance lessons;
- stale-report failure semantics;
- local security findings;
- no prose verdict parser;
- no absolute claims beyond instrumentation.

Supersede:

- large Evidence Packet as the normal path;
- Orchestrator-owned Auditor Runtime;
- Orchestrator semantic claim reconciliation;
- `audit-and-direct` as the system brain;
- Orchestrator-generated next prompts.

## Governing principle

```text
SOL DECIDES
ORCHESTRATOR GUARDS AND ROUTES
ANTIGRAVITY IMPLEMENTS
```

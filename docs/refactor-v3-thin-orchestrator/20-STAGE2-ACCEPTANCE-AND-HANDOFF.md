# Stage 2 Acceptance and Handoff

## Architecture approval questions

Human reviewer should answer YES to all before implementation:

1. Sol High in Codex is the single audit/architecture reasoning authority.
2. Antigravity is the implementation worker.
3. Orchestrator is a thin deterministic broker.
4. Normal audit uses direct Full Harness inspection.
5. User selects auditor task/model in MVP.
6. Orchestrator does not drive auditor lifecycle with heuristic `codex queue`.
7. Sol dispatches only through semantic broker operation.
8. Worker reports are optional/untrusted.
9. Minimal workspace freshness state replaces the large v2 evidence engine.
10. Legacy Orchestrator semantic audit is scheduled for retirement.

Any NO -> revise architecture first.

## Required Stage 2 planning-agent output

Create:

`docs/refactor-v3-thin-orchestrator/STAGE2-PLAN-REVIEW.md`

Include:

- actual repository baseline;
- actual local Codex/AO/codex-chatgpt-web capabilities;
- contradictions/missing assumptions;
- corrections;
- file-level implementation mapping per WP;
- dependencies/tests;
- unresolved decisions;
- first implementation WorkOrder.

No production changes.

## First implementation after approval

If carried-forward WP-01 blockers remain: `WP-V3-01`.

Otherwise: `WP-V3-02 — Extract broker core`.

Do not jump directly to automated agent-to-agent dispatch.

## MVP completion definition

A human can:

1. register project;
2. map Antigravity session;
3. open one dedicated Codex Full Harness Sol task;
4. bootstrap auditor;
5. have Sol inspect local code directly;
6. have Sol call broker to dispatch one scoped WorkOrder;
7. observe stale/wrong/duplicate dispatch protections;
8. have Antigravity complete;
9. have Sol independently inspect resulting diff;
10. issue a second WorkOrder without Orchestrator semantic audit logic.

## MVP non-goals

- indefinite unattended autonomy;
- Orchestrator-created ChatGPT sessions;
- automatic ChatGPT model selection;
- automatic tunnel/key creation;
- multi-worker concurrency;
- evidence-packet fallback;
- automatic merge/release.

## Human approval marker

After review:

```text
STAGE2_ARCHITECTURE_APPROVED
```

Only then begin first implementation WP.

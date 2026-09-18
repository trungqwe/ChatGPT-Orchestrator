# ChatGPT-Orchestrator Refactor v3 — Thin Orchestrator / Agent-to-Agent Architecture

- **Architecture generation:** v3
- **Planning reference:** `review/wp01-fix1` @ `fde47f853e18d52f80e08dd1ab025685fc73a6db`
- **Historical main baseline:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`
- **Stage:** Stage 2 — Architecture Pivot / Design Lock
- **Production code changes authorized by this pack:** **NONE until human Stage 2 approval**


## Purpose

Refactor v3 changes the responsibility model. Instead of making ChatGPT-Orchestrator a second audit brain, the target is:

```text
ChatGPT Web Sol High inside a dedicated Codex Full Harness task
    = architect + auditor

Antigravity
    = implementation worker

ChatGPT-Orchestrator
    = thin deterministic broker + guardrails
```

The broker transports decisions. It does not decide source-code correctness.

## Why this replaces the v2 target

The v2 roadmap proposed an Orchestrator-owned snapshot/evidence/auditor/prompt-generation pipeline. That can be made correct, but Full Harness already allows ChatGPT Web to inspect the real Codex task workspace through local tools. A second semantic planner increases code, state, provenance problems and failure modes.

v3 keeps deterministic identity/security lessons from v2 while removing duplicated reasoning.

## Target loop

```text
User selects project + Antigravity session + dedicated Codex auditor task
                              |
                              v
                    Codex + Sol High
                    Full Harness tools
                    read/search/exec repo
                              |
                  decide next WorkOrder
                              |
                  semantic broker operation
                              v
                    Thin Orchestrator
               mapping / locks / state gate
                              |
                           ao send
                              v
                       Antigravity
                         edits repo
                              |
                    completion identity
                              |
                              +----------> Sol re-audits actual repo
```

## Orchestrator no longer owns

- WorkerReport semantic analysis;
- source-selection/context packing as the normal audit path;
- code-quality verdicts;
- keyword parsing (`lỗi`, `sửa`, `COMPLETE`, `FIX`);
- model prose → `testPassed` conversion;
- worker prompt generation;
- an LLM-based “audit-and-direct” brain.

## Orchestrator still owns

- project/session/task registry;
- worker dispatch routing;
- work-order/dispatch IDs;
- duplicate/busy locks;
- worker lifecycle;
- minimal `workspace_state_id` and stale-audit rejection;
- bounded semantic CLI/tool surface;
- event journal and health;
- local API/IPC security.

## Recommended MVP

The user creates/selects the dedicated Codex auditor task and ChatGPT Web model once. Orchestrator does **not** automate ChatGPT DOM/model selection or drive the auditor through heuristic `codex queue` correlation.

Sol directly audits through Full Harness and calls a narrow broker capability for Antigravity dispatch/status/wait.

MVP broker exposure is a semantic CLI because it is simpler to test and deploy than a new MCP server. A future MCP adapter may expose the same broker library without changing semantics.

## Authority order

1. `04-TRUST-BOUNDARIES-AND-INVARIANTS.md`
2. `08-SEMANTIC-BROKER-TOOLS.md`
3. `09-STATE-MACHINE-AND-LIFECYCLE.md`
4. `10-MINIMAL-WORKSPACE-STATE-GATE.md`
5. `06-CODEX-AUDITOR-RUNTIME.md`
6. `13-IMPLEMENTATION-PLAN.md`
7. `14-ROADMAP.md`
8. other v3 documents

## Files

1. `01-ARCHITECTURE-PIVOT-DECISION.md`
2. `02-CURRENT-STATE-AND-CARRIED-FORWARD-FINDINGS.md`
3. `03-TARGET-ARCHITECTURE.md`
4. `04-TRUST-BOUNDARIES-AND-INVARIANTS.md`
5. `05-PROJECT-SESSION-REGISTRY.md`
6. `06-CODEX-AUDITOR-RUNTIME.md`
7. `07-ANTIGRAVITY-WORKER-ADAPTER.md`
8. `08-SEMANTIC-BROKER-TOOLS.md`
9. `09-STATE-MACHINE-AND-LIFECYCLE.md`
10. `10-MINIMAL-WORKSPACE-STATE-GATE.md`
11. `11-AUDITOR-DECISION-CONTRACT.md`
12. `12-SECURITY-MODEL.md`
13. `13-IMPLEMENTATION-PLAN.md`
14. `14-ROADMAP.md`
15. `15-MASTER-CHECKLIST.md`
16. `16-NEGATIVE-TEST-MATRIX.md`
17. `17-MIGRATION-ROLLBACK-OBSERVABILITY.md`
18. `18-AGENT-EXECUTION-RULES.md`
19. `19-LEGACY-DEPRECATION-MAP.md`
20. `20-STAGE2-ACCEPTANCE-AND-HANDOFF.md`
21. `21-SOURCE-REFERENCE-MEMO.md`
22. `AGENT-PROMPT-STAGE2-ARCHITECTURE-PIVOT.md`

## Stage 2 exit gate

Human reviewer must approve the new responsibility boundary, persistent auditor lifecycle, broker interface, worker provenance, workspace-state gate, security model, negative tests and migration sequence before production implementation begins.

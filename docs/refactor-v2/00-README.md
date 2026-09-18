# ChatGPT-Orchestrator Refactor v2 — Documentation Index

**Planning baseline:** GitHub `main` at commit `8b27a567cc7b058c0782e0370dcc295e1a304a79`  
**Stage:** Stage 1 — Documentation / Design Lock  
**Code changes allowed in this stage:** **NONE**

## Purpose

This document set defines the refactor required to turn ChatGPT-Orchestrator from a report-forwarding loop into a fail-closed, evidence-driven orchestration system.

The target is not merely “the worker ran and said it passed.” The target is:

1. every audit is bound to one exact repository snapshot;
2. machine evidence is produced independently from the worker’s prose report;
3. ChatGPT Sol High can actively inspect the target project, rather than only reading a prepacked report;
4. a worker claim can be classified as corroborated, contradicted, or unverified;
5. transport failures, stale reports, malformed model output, missing evidence, or snapshot drift can never be silently converted into PASS;
6. local micro-iterations stay fast; GitHub remains a canonical checkpoint and optional second-source verifier rather than a mandatory transport hop for every edit.

## Reading order

1. `01-CURRENT-STATE-AUDIT.md`
2. `02-TARGET-ARCHITECTURE.md`
3. `03-TRUST-BOUNDARIES-AND-INVARIANTS.md`
4. `04-IMPLEMENTATION-PLAN.md`
5. `05-ROADMAP.md`
6. `06-MASTER-CHECKLIST.md`
7. `07-VERIFICATION-CONTRACT.md`
8. `08-AUDIT-SNAPSHOT-PROTOCOL.md`
9. `09-AUDIT-RESULT-SCHEMA.md`
10. `10-NEGATIVE-TEST-MATRIX.md`
11. `11-SECURITY-HARDENING.md`
12. `12-CODEX-FULL-HARNESS-INTEGRATION.md`
13. `13-MIGRATION-ROLLBACK-AND-OBSERVABILITY.md`
14. `14-AGENT-EXECUTION-RULES.md`

## Authority order

When documents disagree, use this order:

1. `03-TRUST-BOUNDARIES-AND-INVARIANTS.md`
2. `07-VERIFICATION-CONTRACT.md`
3. `08-AUDIT-SNAPSHOT-PROTOCOL.md`
4. `09-AUDIT-RESULT-SCHEMA.md`
5. `04-IMPLEMENTATION-PLAN.md`
6. `05-ROADMAP.md`
7. all other documents

## Stage 1 exit gate

Stage 1 is complete only when a human reviewer explicitly approves:

- target architecture;
- trust boundaries;
- implementation work packages;
- verification contract;
- snapshot protocol;
- structured audit schema;
- negative-test matrix;
- security controls;
- migration/rollback sequence.

No production code refactor should begin before that approval.

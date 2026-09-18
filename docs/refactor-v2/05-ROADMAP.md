# Refactor Roadmap

## Phase 0 — Plan Approval

Status: `PLANNED`

Scope:

- documentation only;
- no production changes.

Exit:

- architecture and implementation plan approved by human.

## Phase 1 — Stop False Positives and Close Critical Security Gaps

Work packages:

- WP-00
- WP-01
- WP-02

Exit:

- no verified dispatch without observed matching event;
- no stale timeout success;
- Antigravity script compiles;
- loopback binding;
- privileged control endpoints authenticated;
- generic untrusted shell execution removed from normal path.

## Phase 2 — Establish Evidence Integrity

Work packages:

- WP-03
- WP-04
- WP-05

Exit:

- every audit has snapshot ID;
- required checks are orchestrator-owned;
- evidence is machine-generated and snapshot-bound;
- WorkerReport is explicitly untrusted claims.

## Phase 3 — Upgrade Auditor to Active Inspector

Work packages:

- WP-06
- WP-07
- WP-08

Exit:

- correct target CWD;
- read-only inspector;
- Full Harness health is verified rather than assumed;
- active inspection when available;
- JSON-schema audit result;
- claim/evidence reconciliation.

## Phase 4 — Lock Dispatch and Failure Semantics

Work packages:

- WP-09
- WP-10

Exit:

- snapshot recheck before dispatch;
- malformed audit never dispatches;
- all negative tests pass;
- no known stale-turn false positive.

## Phase 5 — Checkpoint / GitHub Corroboration

Work package:

- WP-11

Exit:

- milestone checkpoints can cross-check local and remote identity;
- remote CI/check status consumed when present.

## Phase 6 — Remove Legacy Paths and Correct Product Claims

Work package:

- WP-12

Exit:

- no substring verdict parser;
- no positive evidence fallback;
- test tiers documented;
- README claims match measured properties;
- compatibility fields no longer mislabel semantic verdicts as machine tests.

## Roadmap governance

A phase advances only when:

1. every checklist item is checked;
2. required tests pass;
3. reviewer verifies evidence;
4. no unresolved blocker is carried forward without explicit decision.

# Agent Execution Rules

This file is written to minimize interpretation.

## Rule 1 — One Work Package only

Never execute two WPs in the same turn unless the WorkOrder explicitly lists both.

## Rule 2 — Read before edit

Before editing, read:

- the WP;
- every file named under its “Files to inspect” section;
- relevant contract documents.

## Rule 3 — Scope

Only edit files explicitly permitted by the WorkOrder.

If another file must change:

STOP.

Report the dependency.

Do not silently expand scope.

## Rule 4 — Preconditions

Before editing:

- print current branch;
- print HEAD;
- print status;
- compare against WorkOrder base.

Mismatch:

STOP.

## Rule 5 — No history rewriting

Do not:

- amend pushed commits;
- force push;
- reset published history;
- rebase published work;

unless a future explicit human-approved workflow changes this rule.

## Rule 6 — Tests

Run every mandatory check in the WorkOrder / Verification Contract.

Do not claim a check ran if it did not run.

## Rule 7 — Failure

If a required check fails:

- do not hide output;
- do not reinterpret failure as success;
- report exact exit code;
- stop after report unless WorkOrder explicitly authorizes fixing within the same scoped task.

## Rule 8 — Evidence

Report:

- exact files changed;
- exact commands executed;
- exact exit codes;
- unresolved risks;
- final HEAD;
- working-tree status.

Worker evidence remains claims until Orchestrator corroborates it.

## Rule 9 — No PASS authority

Worker may say:

`READY_FOR_ORCHESTRATOR_REVIEW`

Worker must not declare roadmap/phase approval.

## Rule 10 — No opportunistic cleanup

Do not rename, reformat, restructure, upgrade packages, or fix unrelated code “while here.”

## Rule 11 — Comments and claims

Do not add “100%”, “perfect”, “fully verified”, or similar wording unless the WorkOrder explicitly defines and tests that property.

## Rule 12 — Stop condition

After WorkerReport:

STOP.

Wait for reviewer.

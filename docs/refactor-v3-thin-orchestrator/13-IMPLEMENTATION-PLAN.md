# Detailed Implementation Plan — v3 Thin Orchestrator

## Rule

One Work Package per approved turn. Every WP verifies branch/HEAD/status, reads required docs/code, modifies only allowed files, runs mandatory checks, produces evidence and stops.

## WP-V3-00 — Architecture pivot documentation lock

Goal: review/install v3 docs only.

Required output:

`docs/refactor-v3-thin-orchestrator/STAGE2-PLAN-REVIEW.md`

No production changes.

Exit: human approves v3 responsibility model and implementation order.

---

## WP-V3-01 — Close carried-forward transport correctness

Goal: finish still-open WP-01 provenance defects in legacy code so migration starts from safe semantics.

Examples from review history:

- generic JSON stdout must not auto-activate exact Codex correlation;
- target-turn error provenance exact;
- session-bound diagnostics remain session-bound.

Do not expand `codex queue` into the v3 auditor lifecycle.

Exit: relevant negative tests pass and no stale/false verified path remains known.

---

## WP-V3-02 — Extract broker core

Goal: create reusable deterministic broker independent of Express/UI.

Suggested modules after actual code inspection:

```text
pipeline-ui/lib/broker/registry.js
pipeline-ui/lib/broker/workspace-state.js
pipeline-ui/lib/broker/worker-adapter.js
pipeline-ui/lib/broker/lifecycle-store.js
pipeline-ui/lib/broker/broker.js
```

Conceptual API:

```text
getProject(projectId)
getWorkspaceState(projectId)
getWorkerStatus(projectId)
dispatchWorker(request)
waitWorker(request)
```

No model/audit logic.

Tests call broker directly without Express.

---

## WP-V3-03 — Project/session registry

Goal: replace guess-based target selection with explicit mapping.

Requirements:

- persistent local registry;
- exact root;
- exact AO session;
- auditor task descriptor;
- expected model label;
- no secrets;
- ambiguous import requires user confirmation.

Tests:

- duplicate basenames;
- invalid/missing root;
- missing session;
- Windows case/path normalization;
- corrupted registry fail-closed.

---

## WP-V3-04 — Minimal workspace-state gate

Implement `workspace_state_id` from Git/worktree facts only.

Required coverage:

- tracked change;
- staged change;
- untracked change;
- delete/rename;
- submodule change;
- symlink escape safety.

No WorkerReport/test/model content in state hash.

---

## WP-V3-05 — Antigravity lifecycle adapter

First probe real AO capabilities.

Document:

- stable session IDs;
- send result;
- message/turn IDs if any;
- status/transcript/completion primitives.

Then implement:

- accepted != completed;
- dispatch envelope;
- exact active dispatch binding;
- bounded wait;
- stale completion rejection;
- restart reconciliation.

Exit: old completion cannot complete new dispatch.

---

## WP-V3-06 — Semantic broker CLI

Commands:

```text
snapshot
worker-status
worker-dispatch
worker-wait
```

Requirements:

- JSON request/response;
- request-file support;
- explicit exit codes;
- no arbitrary shell;
- no raw worker-session override in normal mode;
- calls shared broker library.

End-to-end CLI tests use mocked AO.

---

## WP-V3-07 — Codex auditor bootstrap and health

Goal: reliably use one user-selected Codex Full Harness task as auditor.

Deliver:

- bootstrap prompt;
- safe health checklist;
- operator runbook;
- UI/status integration where useful.

Acceptance in real task:

1. read target source;
2. run `git status`/diff;
3. run broker `snapshot`;
4. call `worker-status`;
5. demonstrate auditor does not edit source.

No real worker dispatch yet.

---

## WP-V3-08 — Shadow agent-to-agent loop

Dry-run broker validates/logs directive but does not call AO.

Sol audits fixture/project, creates WorkOrder, calls dry-run dispatch, receives structured response.

No legacy audit endpoint involved.

---

## WP-V3-09 — Live one-cycle integration

Safe fixture project first:

```text
Sol audit
-> broker dispatch
-> Antigravity small edit
-> completion identity
-> Sol direct re-audit
```

Exit: exact state transitions; no duplicate/stale attribution.

---

## WP-V3-10 — Continuous bounded loop

Allow multiple WorkOrders in one dedicated auditor task.

Requirements:

- bounded `worker_wait`;
- pause switch;
- duplicate prevention;
- browser/Codex turn resume procedure;
- restart recovery.

Do not claim indefinite autonomous operation.

---

## WP-V3-11 — Security hardening of remaining UI/API

Still required even with thin broker:

- explicit loopback binding;
- auth/IPC boundary for privileged routes;
- remove normal raw-shell endpoint;
- path containment;
- safe process spawning;
- secret-safe logs.

---

## WP-V3-12 — Retire legacy audit brain

Disable/remove normal-path use of:

- `audit-and-direct` semantic brain;
- verdict substring parser;
- WorkerReport → `testPassed` laundering;
- positive missing-report fallback;
- last-paragraph directive fallback;
- large context builder used solely for old audit path.

Preserve history display/user data as separately decided.

---

## WP-V3-13 — Optional MCP adapter

Only if real usage shows CLI/tool approval ergonomics are poor.

MCP adapter calls same broker library. It is optional for MVP.

---

## WP-V3-14 — GitHub/CI milestone corroboration

At meaningful milestones:

- pushed SHA;
- remote diff;
- CI/checks.

No push required for every micro-turn.

---

## WP-V3-15 — Release cleanup

Update README, diagrams, test tiers, operator/security docs and remove unsupported claims.

## MVP final acceptance

- project can bind to one auditor task and worker session;
- Sol directly inspects local code;
- Sol calls semantic broker;
- broker blocks wrong/stale/duplicate dispatch;
- Antigravity completes scoped task;
- Sol re-audits actual diff;
- second WorkOrder can be issued without Orchestrator semantic analysis.

# v3 Roadmap

## Phase 0 — Pivot Design Lock

WP: `WP-V3-00`.

Exit: v3 docs reviewed and responsibility split approved.

## Phase 1 — Preserve Correctness Before Pivot

WP: `WP-V3-01`.

Exit: no known stale/false verified provenance remains in carried-forward transport code.

## Phase 2 — Thin Broker Core

WPs:

- `WP-V3-02` broker core;
- `WP-V3-03` registry;
- `WP-V3-04` workspace state;
- `WP-V3-05` AO lifecycle;
- `WP-V3-06` semantic CLI.

Exit: deterministic broker works with no model/audit dependency.

## Phase 3 — Attach Real Sol Auditor

WPs:

- `WP-V3-07` bootstrap/health;
- `WP-V3-08` shadow loop.

Exit: user-selected Full Harness task can inspect project and call broker dry-run.

## Phase 4 — Live Agent-to-Agent Loop

WPs:

- `WP-V3-09` one-cycle live;
- `WP-V3-10` bounded multi-cycle/resume.

Exit: Sol audits actual workspace, Antigravity implements, broker only routes/guards.

## Phase 5 — Security + Legacy Removal

WPs:

- `WP-V3-11` security;
- `WP-V3-12` legacy audit removal.

## Phase 6 — Optional / Release

- `WP-V3-13` optional MCP adapter;
- `WP-V3-14` GitHub/CI milestone corroboration;
- `WP-V3-15` release cleanup.

## Governance

Advance only after required tests, exact diff review, scope verification and human approval during migration.

## Superseded v2 sequence

After v3 approval, do not blindly continue v2 `WP-02 -> WP-12`. Relevant security/provenance work is remapped. The v2 Evidence Packet + Orchestrator Auditor Runtime path is no longer the target.

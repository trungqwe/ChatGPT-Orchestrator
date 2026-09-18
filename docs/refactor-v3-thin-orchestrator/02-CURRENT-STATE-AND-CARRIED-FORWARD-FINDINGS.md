# Current State and Carried-Forward Findings

## Reference

v3 was drafted against the public repository around `review/wp01-fix1` at `fde47f853e18d52f80e08dd1ab025685fc73a6db`.

Historical main: `8b27a567cc7b058c0782e0370dcc295e1a304a79`.

The existing v2 docs and WP-00/WP-01 reports remain historical evidence, not the new target roadmap.

## Full Harness opportunity

The inspected `codex-chatgpt-web` architecture documents that Full Harness binds ChatGPT to the current Codex task and exposes local task capabilities through MCP while Codex sandbox/approval remains authoritative.

Architectural consequence: the auditor can inspect the real local workspace directly.

## Current Codex limitation observed during WP-01

The local agent reported `codex-cli 0.154.0` and found that the current `codex queue` CLI did not provide a proven exact queue→turn identity contract.

Therefore v3 MVP does not use `codex queue` + rollout timing inference to drive the auditor lifecycle.

## Carried-forward findings

### CF-001 Worker claims are untrusted

Worker prose can guide inspection but never replaces it.

### CF-002 Stale report success is forbidden

An old completion cannot satisfy a new dispatch.

### CF-003 Queue acceptance is not completion

Distinct worker states are mandatory.

### CF-004 Missing inspection capability is not success

If Sol cannot use the required Full Harness tools, the loop blocks.

### CF-005 Generic raw shell HTTP is unsafe

Legacy caller-controlled shell execution must leave the normal product path.

### CF-006 Local control plane needs explicit security

Retained local HTTP must be loopback-only and privileged mutation routes protected or moved to trusted IPC/CLI.

### CF-007 Prose verdict parsing must be removed

No keywords or last-paragraph fallback.

### CF-008 Auditor verdict is not test evidence

Never synthesize `testPassed` from model verdict.

### CF-009 Workspace authority is runtime authority

A prompt line containing a path is not sufficient. The dedicated Codex task must actually be bound to the project.

### CF-010 Absolute “100% zero intrusion” claims remain unsupported

Use measured claims only.

## New v3 findings

### V3-001 Context packing is unnecessary in the primary path

Direct Full Harness inspection is preferable to Orchestrator choosing which files Sol may see.

### V3-002 Broker should not be the normal Codex turn driver

MVP avoids another exact-turn transport problem by letting native Codex own the auditor task.

### V3-003 Raw AO execution from the auditor is overpowered

Use a semantic broker boundary.

### V3-004 Worker waits must be bounded

Recommended individual wait poll: at most 10 seconds. The auditor may repeat it.

### V3-005 A minimal workspace freshness identity remains necessary

The broker still needs to reject a directive generated against stale repository state.

## Non-goal

The thin broker does not prove Sol's reasoning is infallible. It improves grounding and eliminates unnecessary duplicated semantic machinery.

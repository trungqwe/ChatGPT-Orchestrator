# Codex / ChatGPT Full Harness Integration

## 1. Objective

Allow ChatGPT Sol High to act as an active, read-only inspector of the real target project.

## 2. Required distinction

`--ephemeral`:

- controls session persistence;
- does not itself disable local tools.

Tool availability depends on integration mode/runtime.

## 3. Correct working authority

Do not rely on:

```text
Local Path: D:\...
```

inside prompt.

Launch the Codex audit task with the resolved target project as its actual CWD / trusted workspace root.

## 4. Read-only inspector

Desired Codex sandbox:

`read-only`

The auditor should not edit source.

### Do not make this mistake

Do not document `--approve-for-me` as “read-only automatic approval.”

Current Codex CLI semantics use automatic review with `workspace-write`, and the flag conflicts with explicit `--sandbox read-only`.

## 5. Two approval layers

### Layer A — Codex execution sandbox / approvals

Controls local command/filesystem behavior of the Codex task.

### Layer B — ChatGPT Full Harness connector/tool call policy

Controls whether ChatGPT tool calls through the connector are available/allowed.

The Orchestrator health check must understand these are separate.

## 6. Capability health

Before `audit_capability=active_inspector`, collect machine-readable health proving:

- model route exists;
- launcher/browser authenticated;
- response proxy healthy;
- mode=full;
- tunnel ready;
- connector available;
- turn is bound to trusted target CWD.

If runtime tooling cannot prove these conditions, do not assume them.

## 7. Baseline packet + active retrieval

For latency and determinism, provide:

- snapshot header;
- changed files;
- diff stat;
- verification summary;
- failing raw output.

Then allow model-driven retrieval for:

- suspicious diff;
- related callers;
- tests;
- configs;
- exact file sections.

Do not hardcode claims such as “each tool call costs 10–15 seconds” into product logic without measurement.

## 8. Evidence Packet fallback

If Full Harness is unavailable:

- use deterministic local evidence packet;
- clearly mark capability;
- do not imply the model independently browsed arbitrary project files.

## 9. Benchmarking

Measure:

- audit wall time;
- number of tool calls;
- tokens/context size;
- false-negative findings in known test fixtures.

Use measurements to tune preloaded evidence, not assumptions.

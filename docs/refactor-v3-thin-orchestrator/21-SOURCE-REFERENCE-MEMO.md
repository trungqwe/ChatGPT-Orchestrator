# Source / Reference Memo

## ChatGPT-Orchestrator references

- historical main baseline: `8b27a567cc7b058c0782e0370dcc295e1a304a79`
- WP-01 review checkpoint: `a71236ee1345cd06086f39c043c4ab490a05c077`
- v3 planning reference: `fde47f853e18d52f80e08dd1ab025685fc73a6db`

## codex-chatgpt-web upstream reference

Repository: `miuuyy/codex-chatgpt-web`

Reference inspected: `e0904bc82001f06e06e7f85f564ce760c92bfd79`.

Relevant documented behavior at that reference:

- Browser-only has no local Codex tools.
- Full Harness connects ChatGPT tool calls to the current Codex task through MCP.
- Full Harness uses OpenAI tunnel-client.
- browser/tool sessions are task-bound;
- bridge deliberately transports decisions rather than adding a second planner;
- Codex sandbox/approval remains authoritative;
- runtime/browser/tunnel credentials are sensitive and must not be copied into Orchestrator.

## Local capability observation from WP-01 agent report

Reported local Codex: `codex-cli 0.154.0`.

Reported current `codex queue` did not provide a proven exact queue→turn contract. v3 MVP therefore does not use queue+rollout inference as auditor lifecycle authority.

## Required revalidation

Stage 2 planning agent must re-check all changing/niche capability facts against the actual installed runtime and pinned submodule before implementation.

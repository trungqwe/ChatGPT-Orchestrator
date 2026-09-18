# Agent Execution Rules — v3

1. **One WP only.** Do not execute adjacent WPs without explicit WorkOrder.
2. **Read before edit.** Read v3 authority docs plus actual code/callers/tests.
3. **Preflight.** Print branch, HEAD, status, base comparison. Mismatch -> stop.
4. **Scope.** Only allowed files. Hidden dependency -> report and stop.
5. **Respect architecture.** Do not reintroduce Orchestrator semantic audit/report parsing/prompt generation.
6. **No speculative capability.** Probe Codex/AO before using IDs/APIs.
7. **Tests.** Run every mandatory check and report exact exit codes.
8. **No self-approval.** Agent may say `READY_FOR_REVIEW`, not architecture/phase approved.
9. **No opportunistic cleanup.** No unrelated formatting/rename/dependency/UI work.
10. **No history rewrite.** Do not amend/force-push published work unless explicitly authorized.
11. **Secrets.** Never copy ChatGPT cookies/browser profiles/tunnel keys/connector secrets.
12. **Full Harness claims require runtime evidence.** Config alone is not proof.
13. **No unsupported absolute claims.** Avoid `100%`, `perfect`, `fully autonomous`, `zero intrusion` unless precisely measured.
14. **Stop after report.** Do not start next WP automatically.

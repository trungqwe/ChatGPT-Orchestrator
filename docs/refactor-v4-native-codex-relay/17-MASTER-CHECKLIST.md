# Master checklist

- [x] Không yêu cầu ChatGPT Web, `codex-chatgpt-web`, MCP tunnel, connector hoặc browser automation.
- [x] Exact `thread_id`; strict structured AuditDecision.
- [x] Local source audit; WorkerReport untrusted.
- [x] Runtime `model/list`; pluggable workers.
- [x] Durable lifecycle, freshness và fail-closed recovery.
- [x] Bridge runtime, installed app và submodule đã bị gỡ.
- [x] Production bridge calls được quarantine.
- [x] Registry v2 và migration explicit implemented; auditor thread vẫn unbound sau migration.
- [x] App Server stdio transport core & semantic adapter implemented (WP-V4-03A).
- [ ] Real Native Codex accepted (WP-V4-03B).
- [ ] Thread persistence complete (WP-V4-05).
- [ ] AuditDecision complete (WP-V4-04).
- [ ] Model resolver complete (WP-V4-06).
- [ ] One-shot và shadow proven.
- [ ] Legacy production path removed.

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
- [x] Real Native Codex accepted (WP-V4-03B: real initialize, model/list, thread/start, same-process thread/read, clean close; WP-V4-03 COMPLETE).
- [x] AuditDecision complete (WP-V4-04: AuditDecisionV1 pure semantic contract, duplicate key rejection, exact context binding, turn items authority, 78 AD tests).
- [ ] Thread persistence & durable cross-process recovery complete (WP-V4-05; no pre-materialization Registry binding).
- [ ] Model resolver complete (WP-V4-06).
- [ ] One-shot và shadow proven.
- [ ] Legacy production path removed.

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
- [x] Thread persistence & durable cross-process recovery core complete & sealed (WP-V4-05A / WO-V4-05AF: SQLite recovery store authority seal, strict patch envelope, history chain revalidation, physical integrity_check, exact schema validation, real workspacePort contract, mandatory auditPrompt/Subject, Registry root canonical revalidation, 51 ARS + 55 RG + 60 ATL tests pass).
- [x] Explicit AUDIT_UNCERTAIN terminal-turn resolution complete (WP-V4-05AG: resolveAuditorBootstrapUncertainty, non-mutating provider read, AUDIT_TERMINAL_NO_DECISION state, clean separation between resolution and recovery cleanup, schema-v1 compatibility, 61 ARS + 83 ATL tests pass).
- [ ] Real first audit acceptance complete (WP-V4-05B).
- [ ] Model resolver complete (WP-V4-06).
- [ ] One-shot và shadow proven.
- [ ] Legacy production path removed.

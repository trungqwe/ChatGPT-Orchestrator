# Hiện trạng và tài sản giữ lại

| Tài sản | Phân loại | Lý do |
|---|---|---|
| `broker.js`, `contracts.js` | ADAPT | Giữ guards/identity; nhận AuditDecision |
| `registry.js` | ADAPT | Migrate Web task schema sang v2 |
| `workspace-state.js` | KEEP | Freshness/provenance vẫn là invariant |
| `sqlite-lifecycle-store.js` | KEEP | Durable state, one-active-dispatch |
| `worker-adapter.js`, `runtime.js`, CLI | ADAPT | Generic worker và auditor lifecycle |
| refactor tests | ADAPT | Giữ regression, bỏ Web assumptions |
| Web proxy/UI paths | REMOVE_LATER | Chỉ sau shadow/live validation |
| `codex-chatgpt-web` submodule/runtime/app | REMOVED_EARLY | Operator yêu cầu gỡ ngay; production references phải quarantine trước |

`pipeline-ui/package.json` description: `DEFERRED_TO_IMPLEMENTATION_CLEANUP`.

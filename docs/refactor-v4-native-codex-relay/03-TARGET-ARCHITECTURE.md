# Kiến trúc đích

```text
Operator
  ▼
Thin Relay ── Registry ── Lifecycle Store
  │ freshness / exact identities
  ├── Codex App Server Adapter ── Native Codex Auditor
  └── Worker Adapter Registry ── Antigravity/Codex/other
                    ▲                 │ edits + tests
                    └── same-thread review
```

Một relay-owned App Server process phục vụ nhiều project threads. Mỗi project có một logical persistent auditor thread. Relay không viết lại ý nghĩa quyết định Codex; worker không tự approve.

Restart: load registry/store → initialize App Server → resume exact `thread_id` → reconcile auditor turn và worker dispatch. State không chứng minh được chuyển `UNCERTAIN` và chặn resend.

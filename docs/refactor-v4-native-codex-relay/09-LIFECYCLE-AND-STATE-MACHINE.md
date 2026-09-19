# Lifecycle và state machine

```text
AUDIT_CREATED → AUDIT_RUNNING → AUDIT_DECISION_READY
                       ├──────→ AUDIT_FAILED
                       └──────→ AUDIT_UNCERTAIN
```

Auditor và worker dùng state domain riêng. Audit record lưu project/thread/turn, reason, observed workspace, timestamps và raw validated decision. Worker giữ durable dispatch lifecycle hiện có. Restart reconcile từng domain trước khi nối quan hệ.

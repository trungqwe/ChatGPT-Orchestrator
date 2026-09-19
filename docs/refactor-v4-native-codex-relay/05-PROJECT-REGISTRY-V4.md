# Project Registry V4

```json
{"schema_version":2,"projects":{"project-id":{"project_id":"project-id","project_name":"Project","project_root":"D:\\Code\\Project","auditor":{"engine":"codex_app_server","thread_id":"thr_...","cwd":"D:\\Code\\Project","enabled":true,"model_policy":"auditor_standard"},"worker":{"engine":"antigravity","session_id":"...","enabled":true,"model_policy":"worker_standard"},"policy":{"max_active_dispatches":1,"require_workspace_state":true}}}}
```

Migration v1→v2 phải transactional, backup trước và canonicalize root. Không chuyển `task_id` thành `thread_id`; record cũ nhận `AUDITOR_REGISTRATION_REQUIRED`. Persist thread chỉ sau start thành công. Resume thất bại không tự tạo thread mới.

# Project Registry V4

```json
{"schema_version":2,"projects":{"project-id":{"project_id":"project-id","project_name":"Project","project_root":"D:\\Code\\Project","auditor":{"engine":"codex_app_server","thread_id":null,"cwd":"D:\\Code\\Project","enabled":false,"model_policy":"auditor_standard"},"worker":{"engine":"antigravity","session_id":"exact-session-id","enabled":true,"model_policy":"worker_standard"},"policy":{"max_active_dispatches":1,"require_workspace_state":true}}}}
```

Registry mới mặc định `schema_version: 2`. Runtime gặp v1 trả `REGISTRY_MIGRATION_REQUIRED`, không tự nâng cấp. Broker dispatch request tiếp tục dùng `schema_version: 1` vì đó là giao thức riêng.

`auditor.thread_id` là opaque ID hoặc `null`, tối đa 512 byte UTF-8, không có ký tự điều khiển. `enabled: true` yêu cầu ID đã gắn. `AUDITOR_REGISTRATION_REQUIRED` được **suy ra** từ `thread_id == null`, không lưu thành cờ độc lập. `thread_id != null` kết hợp `enabled` lần lượt tạo `AUDITOR_BOUND_DISABLED` hoặc `AUDITOR_BOUND_READY`. `auditor.cwd` và `project_root` phải cùng canonical filesystem identity; khi ghi, cả hai được chuẩn hóa thành cùng canonical path.

Worker vẫn giới hạn `antigravity`; `worker.model_policy` là `worker_economy` hoặc `worker_standard`. `auditor.model_policy` là `auditor_fast`, `auditor_standard` hoặc `auditor_deep`. Registry không lưu tên model cụ thể. `architecture_deep` chỉ là chính sách nâng cấp theo turn về sau.

Migration v1→v2 chỉ chạy qua admin CLI explicit. Preview đọc và hash byte nguồn, validate toàn bộ v1, canonicalize tất cả root, tạo candidate v2 và không ghi file. Apply cần SHA-256 đã preview, đọc lại nguồn, tạo backup byte-exact trong cùng thư mục, ghi temp file, fsync, rename và validate sau ghi. Metadata auditor v1 bị loại bỏ; **không chuyển `task_id` thành `thread_id`**. Mọi project v1 trở thành auditor unbound/disabled và cần đăng ký thread sau này. Không tạo thread trong WP-V4-02B.

Mỗi lần đọc nguồn migration, kể cả lần re-read ngay trước rename, bắt buộc ba snapshot `lstat(path)` → `fstat(fd)` → `lstat(path)`. Pathname trước/sau không được là symlink; cả ba phải là regular file với `dev` và `ino` không null. Identity `dev`/`ino` phải bằng nhau theo cặp pre/fd và fd/post. Nếu thiếu identity hoặc pathname đổi, trả `REGISTRY_CORRUPT` và không dùng byte vừa đọc làm authority. SHA-256 chỉ bổ sung xác thực nội dung sau khi file identity đã được chứng minh.

# 1. Baseline

Parent `847becb3dedf6a06fc2afb150dddf95fcb5f7ce1` trên nhánh `review/v4-wp02a-quarantine-final`. WP-V4-02A đã đóng; bridge Web vẫn bị cách ly bằng HTTP 410. Worktree riêng cho WO này bắt đầu sạch từ parent.

# 2. Registry v2 Schema

Registry mới và các mutation thường dùng `schema_version: 2`, strict allowlist ở mọi cấp. Registry không tồn tại trả `{schema_version:2,projects:{}}` mà chưa tạo file. Runtime gặp v1 trả `REGISTRY_MIGRATION_REQUIRED` và giữ nguyên byte; version lạ trả `REGISTRY_SCHEMA_INVALID`, JSON hỏng trả `REGISTRY_CORRUPT`. Broker dispatch request vẫn là giao thức `schema_version: 1` độc lập.

# 3. Auditor Binding Semantics

Auditor dùng `engine: codex_app_server`, `thread_id` opaque hoặc `null`, `cwd` cùng canonical root, `enabled` và `model_policy`. `enabled: true` chỉ hợp lệ khi có thread ID. `getAuditorBindingState` suy ra `AUDITOR_REGISTRATION_REQUIRED`, `AUDITOR_BOUND_DISABLED` hoặc `AUDITOR_BOUND_READY`; không lưu cờ trạng thái riêng. Thread ID hợp lệ được giữ nguyên byte, không giả định prefix/UUID.

# 4. Model Policy Fields

Worker chỉ hỗ trợ `antigravity` với `worker_economy`/`worker_standard`; auditor chấp nhận `auditor_fast`/`auditor_standard`/`auditor_deep`. Migration dùng hai giá trị `*_standard`. Không lưu tên model cụ thể hoặc `architecture_deep` mặc định.

# 5. V1 Migration Preview

`previewV1ToV2Migration` yêu cầu đường dẫn tuyệt đối; đọc regular non-symlink source, hash byte, parse, validate đủ cấu trúc v1, canonicalize mọi root, validate candidate v2, trả summary và candidate detached. Không tạo backup, temp file hoặc target mutation. V1 auditor metadata bị loại bỏ. Already-v2 preview là no-op.

# 6. Source Hash / TOCTOU Authority

Apply bắt buộc `expected_source_sha256` 64 hex. Hash bao phủ byte file nguồn, không phải JSON chuẩn hóa. Apply đọc lại và so hash trước mutation, rồi kiểm tra lại ngay trước rename. `lstat`/`fstat`/same-file identity từ descriptor phát hiện source symlink, nonregular và một số file-swap race. Không có khóa liên tiến trình tuyệt đối; operator phải dừng Registry writer trong lúc apply. Hash mismatch trả `REGISTRY_MIGRATION_SOURCE_CHANGED`.

# 7. Backup and Atomic Persistence

Backup `wx` duy nhất ở cùng thư mục, chứa byte v1 chính xác và fsync trước target write. Temp v2 cùng thư mục được ghi, fsync, close, rồi `renameSync` atomically. Trên POSIX file mode 0600; Windows dùng mode phù hợp nền tảng. Apply trả backup path.

# 8. Failure / Rollback Behavior

Backup lỗi trả `REGISTRY_BACKUP_FAILED`, temp/rename lỗi trả `REGISTRY_MIGRATION_PERSIST_FAILED`; nguồn v1 giữ nguyên. Sau rename, utility đọc lại, so byte với candidate đã validate và validate schema. Verify lỗi cố khôi phục từ backup; trả `REGISTRY_MIGRATION_VERIFY_FAILED` nếu khôi phục được, hoặc `REGISTRY_MIGRATION_ROLLBACK_FAILED` nếu rollback lỗi. Các fault path đã được kiểm thử bằng filesystem injection.

# 9. Migration CLI

`registry-v2-migrate.js` chỉ hỗ trợ `preview` và `apply`, luôn yêu cầu `--registry-file` tuyệt đối; apply cần `--expected-source-sha256`. Mỗi invocation in đúng một JSON object; không in source Registry JSON, task ID hoặc model label cũ. CLI test chạy trên temp fixture, gồm preview → SHA → apply → backup exact → load v2. Không có default apply path.

# 10. Broker / Worker Compatibility

Registry v2 không thay broker, SQLite schema hoặc worker adapter. Fixture broker chứng minh dispatch dependency-injected nhận đúng `worker.session_id` và `worker.model_policy` khi auditor unbound. Không có AO send thật.

# 11. Registry Tests

`RG-001..RG-039`: 39/39 pass. Chỉ đổi fixtures/assertions Registry v1 sang v2; các assertion về broker request `schema_version: 1` được giữ nguyên. CLI fixture-only adaptations đưa descriptor v2 vào các registry thử nghiệm.

# 12. Migration Tests

`RV2-001..RV2-045`: 45/45 pass, gồm preview read-only, exact hash, không suy diễn task ID, backup, persist/verify/rollback fault, source symlink/nonregular, one-invalid-project, bound auditor và canonical cwd.

# 13. Full Regression Evidence

Chín suite mặc định trong `npm test`: quarantine, native transition, CLI 50/50, SQLite lifecycle 47/47, broker 52/52, worker adapter 55/55, workspace state 51/51, Registry 39/39, migration 45/45. `npm test` exit 0; cả chín suite còn được chạy độc lập và đều exit 0. GitHub CI không được thực thi trong WO này và không được coi là pass.

# 14. Legacy Test Classification

`pipeline-api.test.js`: `LEGACY_INTEGRATION / NOT_DEFAULT`, không chạy trong WO này do fixture môi trường lịch sử. `closed-loop.test.js`: `RETIRED_BY_V4_ARCHITECTURE`, không phải v4 acceptance authority.

# 15. Security / Secret Handling

Strict keys từ chối các field bí mật và field auditor v1. Migration CLI không echo source JSON. Legacy task/model values không được persist vào v2. Source Registry thật của operator không bị đọc/ghi để apply; mọi migration test dùng temp file.

# 16. Scope Compliance

- Legacy `task_id` copied to `thread_id`: **NO**.
- Automatic v1 migration: **NO**.
- Real default registry modified: **NO**.
- Real Codex thread created: **NO**.
- App Server invoked: **NO**.
- Real worker dispatched: **NO**.
- Server/UI/Desktop/broker/runtime/SQLite/worker adapter production modified: **NO**.
- WP-V4-03 started: **NO**.

# 17. Recommendation

Sau khi gate cuối và external review đạt, operator có thể preview và apply Registry thật bằng explicit hash theo runbook; auditor vẫn cần bind thread ở work package về sau. Chưa bắt đầu WP-V4-03 trong nhánh này.

# Operator runbook

## Migration Registry v1→v2 sau khi được review

1. Dừng các writer của Registry. Chạy `node pipeline-ui/registry-v2-migrate.js preview --registry-file <đường-dẫn-tuyệt-đối>`.
2. Ghi lại `source_sha256`, `project_count` và `requires_auditor_registration`; đối chiếu danh sách project. Preview không ghi file.
3. Chạy `node pipeline-ui/registry-v2-migrate.js apply --registry-file <cùng-đường-dẫn> --expected-source-sha256 <SHA-256-ở-bước-1>`.
4. Ghi lại `backup_path`; kiểm tra backup chứa đúng byte v1 và Registry mới có `schema_version: 2`.
5. Mỗi migrated auditor đều có `thread_id: null`, `enabled: false`; chưa tạo thread ở WP-V4-02B. Worker mapping vẫn khả dụng. Chỉ đăng ký thread sau khi App Server transport được triển khai và review.

Không chạy các lệnh apply này trên Registry thật trong work package triển khai máy móc.

1. Register canonical project root và worker.
2. Start relay; kiểm tra registry/store/App Server.
3. Khởi tạo provisional auditor thread (in-memory). Chỉ thực hiện lượt audit thực tế đầu tiên khi contract AuditDecisionV1 (WP-V4-04) đã sẵn sàng. Sau khi vượt qua gate kiểm định durable materialization & exact resume recovery (WP-V4-05), mới persist exact thread_id vào Registry v2. Tuyệt đối không persist zero-turn provisional thread chỉ vì thread/start thành công.
4. Chọn logical model policy và xem runtime resolution.
5. Chạy one-shot; quan sát decision/dispatch IDs.
6. Khi ready, xác nhận fresh snapshot và same-thread review.
7. Stop bằng drain, controlled interrupt, persist và shutdown.

Crash: restart, resume exact thread, probe worker, xử lý uncertainty. Model unavailable: chọn tier hợp lệ. Thay thread chỉ qua explicit operator command, lưu old ID và reason.

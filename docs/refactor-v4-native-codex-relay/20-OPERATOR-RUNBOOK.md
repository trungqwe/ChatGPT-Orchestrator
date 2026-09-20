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

## Giám sát và Khôi phục Vòng đời Auditor (Auditor Bootstrap Runbook — WP-V4-05A)

### 1. Kiểm tra trạng thái Bootstrap (`inspectAuditorBootstrap`)
Khi nghi ngờ quy trình gắn kết auditor thread bị gián đoạn hoặc cần đối soát:
- Lệnh inspect trả về trạng thái từ cả Recovery Store SQLite và Registry v2:
  ```js
  const info = await inspectAuditorBootstrap(projectId, { store, registryPort });
  // info.bootstrapState: PROVISIONAL_THREAD | FIRST_TURN_IN_FLIGHT | DECISION_VALIDATED | ... | null
  // info.registryState: AUDITOR_REGISTRATION_REQUIRED | AUDITOR_BOUND_READY | AUDITOR_BOUND_DISABLED
  // info.history: Danh sách các bước chuyển trạng thái đã ghi nhận
  ```

### 2. Xử lý Trạng thái Sự cố (`recoverAuditorBootstrap`)
Chạy quy trình khôi phục chính thức:
- **Nếu ở `PROVISIONAL_THREAD`**: Recovery tự động dọn sạch bản ghi tạm trong SQLite; Registry giữ nguyên `UNBOUND`. Operator khởi tạo bootstrap mới khi sẵn sàng.
- **Nếu ở `FIRST_TURN_STARTING` hoặc `FIRST_TURN_IN_FLIGHT`**: Hệ thống đánh dấu và giữ nguyên `AUDIT_UNCERTAIN`.
  - **CẢNH BÁO QUAN TRỌNG**: Không được tự ý ép chạy lại `turn/start` nếu chưa xác minh App Server đã thực thi hay chưa. Operator cần chạy quy trình giải quyết bất định `resolveAuditorBootstrapUncertainty`.
- **Nếu ở `AUDIT_UNCERTAIN`**: Chạy `resolveAuditorBootstrapUncertainty({ projectId, recoveryStore, createInspectionAdapter, expectedProjectRoot })`:
  - Sử dụng adapter read-only (không mutation, không start turn/thread) để đọc `thread/read(includeTurns=true)`.
  - Nếu turn có trạng thái `interrupted` hoặc `failed`: chuyển sang `AUDIT_TERMINAL_NO_DECISION` (hàng active vẫn được lưu trong SQLite; không tự xóa).
  - Nếu turn là `completed` với `itemsView: 'full'` và chứa `AuditDecisionV1` hợp lệ: chuyển sang `DECISION_VALIDATED`.
  - Nếu turn đang `inProgress` hoặc dữ liệu thread không hợp lệ: fail-closed và giữ nguyên `AUDIT_UNCERTAIN`.
- **Nếu ở `AUDIT_TERMINAL_NO_DECISION`**: Chạy `recoverAuditorBootstrap`:
  - Hệ thống tự động xóa bản ghi active bootstrap trong SQLite recovery store, bảo toàn toàn bộ lịch sử trong `auditor_bootstrap_history`, và giữ Registry ở trạng thái `UNBOUND` an toàn để operator có thể bắt đầu lại bootstrap sạch.
- **Nếu ở `DECISION_VALIDATED` hoặc `RESUME_VERIFYING`**: Recovery tự động tái khởi động kết nối App Server, thực hiện exact `thread/resume(T)`. Nếu resume thành công, recovery tự động hoàn tất `bindAuditorThread` lên Registry v2 (`AUDITOR_BOUND_READY`) mà không tiêu tốn token nào của model turn.
- **Nếu ở `REGISTRY_BINDING`**: Recovery tự động đối soát Registry v2. Nếu Registry đã gắn đúng ID, bản ghi bootstrap được xóa và hoàn tất `DURABLE_BOUND`. Nếu chưa gắn, lệnh `bindAuditorThread` được gọi lại với tính chất idempotent an toàn tuyệt đối.

### 3. Nguyên tắc vận hành an toàn (Fail-Closed Safety Rules)
1. **Không sửa tay SQLite**: Tuyệt đối không can thiệp bằng các công cụ SQLite bên ngoài để sửa đổi trường `state` hoặc xóa thủ công các bản ghi trong `auditor_recovery_v1` vì có thể phá vỡ tính toàn vẹn chữ ký hash của validated decision.
2. **Không copy/touch file session Codex**: Quá trình rollout file hoàn toàn do App Server quản lý. Tuyệt đối không tạo file giả lập để ép `thread/resume` thành công.
3. **Môi trường Test**: Trong các bài kiểm tra tự động và diễn tập phục hồi, bắt buộc dùng isolated temporary directory cho cả Registry file lẫn SQLite recovery file (`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`).

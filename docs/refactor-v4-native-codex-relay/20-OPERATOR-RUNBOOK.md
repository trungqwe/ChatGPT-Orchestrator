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
- **Nếu ở `AUDIT_UNCERTAIN`**: Chạy `resolveAuditorBootstrapUncertainty({ projectId, registryPort, recoveryStore, adapterFactory })`:
  - Mọi định danh (thread_id, turn_id) và ngữ cảnh kiểm tra đều được lấy từ thẩm quyền Registry, recovery store và provider durability. Operator tuyệt đối KHÔNG cung cấp `threadId`, `turnId`, `turnStatus`, hay `decision`.
  - Tương tác provider hoàn toàn mang tính chất phi biến đổi (non-mutating) vì đường dẫn kiểm tra chỉ khởi tạo adapter và gọi duy nhất `thread/read(includeTurns=true)`. Quy trình tuyệt đối không gọi `thread/start`, `turn/start`, `turn/interrupt`, hay `review/start`. `adapterFactory` chịu trách nhiệm khởi tạo production Codex adapter/client tiêu chuẩn (các cấu hình sandbox và approvalPolicy thuộc ngữ nghĩa `thread/start`, không được áp dụng mới trong `thread/read`).
  - Toàn bộ chuỗi thông báo lỗi hay chẩn đoán trả về đều được giới hạn tường minh qua UTF-8 byte bound (`MAX_UNCERTAINTY_DIAGNOSTIC_BYTES = 1024`), phân loại theo các nhóm chuẩn (`PROVIDER_INSPECTION_FAILED`, `THREAD_ID_MISMATCH`, `TURN_HISTORY_INVALID`, `TURN_ITEMS_INCOMPLETE`, `DECISION_VALIDATION_FAILED`, `TURN_NONTERMINAL`), và không bao giờ cắt cụt dở dang ký tự đa byte.
  - Nếu turn có trạng thái `interrupted` hoặc `failed`: chuyển sang `AUDIT_TERMINAL_NO_DECISION` (hàng active vẫn được bảo toàn trong SQLite; resolver không tự xóa).
  - Nếu turn là `completed` với `itemsView: 'full'` và chứa `AuditDecisionV1` hợp lệ: chuyển sang `DECISION_VALIDATED`.
  - Nếu turn đang `inProgress` hoặc dữ liệu thread không hợp lệ: fail-closed và giữ nguyên `AUDIT_UNCERTAIN`.
- **Nếu ở `AUDIT_TERMINAL_NO_DECISION`**: Chạy `recoverAuditorBootstrap({ projectId, registryPort, recoveryStore, adapterFactory })`:
  - Bản thân trạng thái `AUDIT_TERMINAL_NO_DECISION` không tự động cấp quyền xóa bản ghi. Ngay trước khi xóa bản ghi active, `recoverAuditorBootstrap` bắt buộc đọc lại Registry (`await registryPort.getProject(projectId)`) và kiểm chứng auditor vẫn đang `UNBOUND` (`thread_id === null` và `enabled === false`).
  - Nếu project bị thiếu, lệnh đọc Registry thất bại, hoặc auditor đã bị gắn kết hay kích hoạt, hệ thống fail closed và BẢO TOÀN bản ghi active trong recovery store cùng lịch sử.
  - Chỉ khi kiểm chứng Registry `UNBOUND` thành công, hệ thống mới thực hiện xóa bản ghi active bootstrap trong SQLite recovery store, bảo toàn toàn bộ lịch sử trong `auditor_bootstrap_history`, và trả về `RECOVERED_TERMINAL_NO_DECISION_CLEARED` để operator có thể bắt đầu lại bootstrap sạch.
- **Nếu ở `DECISION_VALIDATED` hoặc `RESUME_VERIFYING`**: Recovery tự động tái khởi động kết nối App Server, thực hiện exact `thread/resume(T)`. Nếu resume thành công, recovery tự động hoàn tất `bindAuditorThread` lên Registry v2 (`AUDITOR_BOUND_READY`) mà không tiêu tốn token nào của model turn.
- **Nếu ở `REGISTRY_BINDING`**: Recovery tự động đối soát Registry v2. Nếu Registry đã gắn đúng ID, bản ghi bootstrap được xóa và hoàn tất `DURABLE_BOUND`. Nếu chưa gắn, lệnh `bindAuditorThread` được gọi lại với tính chất idempotent an toàn tuyệt đối.

### 3. Nguyên tắc vận hành an toàn (Fail-Closed Safety Rules)
1. **Không sửa tay SQLite**: Tuyệt đối không can thiệp bằng các công cụ SQLite bên ngoài để sửa đổi trường `state` hoặc xóa thủ công các bản ghi active trong bảng `auditor_bootstrap`, và không sửa đổi hay ghi đè lịch sử trong bảng `auditor_bootstrap_history` vì có thể phá vỡ tính toàn vẹn chữ ký hash và chuỗi thẩm quyền của validated decision.
2. **Không copy/touch file session Codex**: Quá trình rollout file hoàn toàn do App Server quản lý. Tuyệt đối không tạo file giả lập để ép `thread/resume` thành công.
3. **Môi trường Test**: Trong các bài kiểm tra tự động và diễn tập phục hồi, bắt buộc dùng isolated temporary directory cho cả Registry file lẫn SQLite recovery file (`PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`).

### 4. Kiểm chứng Thẩm quyền Fresh Trước Lượt Audit Đầu Tiên (WO-V4-05AG-R3)
Ngay sau khi `beginBootstrap()` ghi nhận thẩm quyền (`authority_version = 1`, `expected_project_root`, `expected_project_root_identity`, `expected_auditor_model_policy`) vào SQLite và đọc lại bản ghi persisted:
- Hệ thống bắt buộc thực hiện fresh read Registry (`await registryPort.getProject(projectId)`).
- Kiểm chứng auditor trong Registry vẫn đang ở trạng thái unbound nghiêm ngặt (`thread_id === null` và `enabled === false`).
- Tự chứng thực thẩm quyền persisted (`assertBootstrapAuthorityMatchesRegistry`) đảm bảo:
  1. `expected_project_root` tự canonicalize và khớp identity đã lưu.
  2. Registry `project_root` fresh khớp canonical identity.
  3. Registry `auditor.cwd` fresh khớp canonical identity.
  4. Registry `auditor.model_policy` fresh khớp policy đã lưu.
- Nếu có bất kỳ sai lệch nào (drift, read failure, auditor bound/enabled): fail-closed ngay lập tức, đóng client provisional, giữ nguyên trạng thái `PROVISIONAL_THREAD` trong SQLite recovery store, và tiêu thụ chính xác **0 lượt model turn**.

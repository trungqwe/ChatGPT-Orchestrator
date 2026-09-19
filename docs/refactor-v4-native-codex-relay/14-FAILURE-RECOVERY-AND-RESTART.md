# Failure recovery và restart

Startup: validate registry/database → acquire relay lock → initialize App Server → expose health. Crash mid-turn tạo `AUDIT_UNCERTAIN`; restart rồi read/resume exact ID, không tìm latest thread. Resume fail trả `AUDITOR_THREAD_UNAVAILABLE`; replacement thread cần operator action và audit log.

Model unavailable chỉ fallback trong tier cấu hình. Worker timeout dùng probe; unknown outcome không resend. Shutdown drain, interrupt theo policy, persist uncertainty, close stores và terminate child process có deadline.

## Phục hồi sự cố trong các pha Materialization (WO-V4-03BR)

- **Lỗi lượt audit đầu tiên (First Turn Failure)**: Nếu lượt audit thực tế đầu tiên thất bại hoặc bị ngắt trước khi chứng minh được materialization và recovery bền vững, tuyệt đối **không bind thread** vào Registry. Giữ nguyên trạng thái `AUDITOR_REGISTRATION_REQUIRED` hoặc trạng thái lỗi cục bộ; không gán ID chưa hoàn tất vào `projects.json`.
- **Crash trước lượt audit đầu tiên (Crash Before First Turn)**: Nếu relay hoặc App Server sập nguồn sau khi `thread/start` thành công nhưng chưa thực hiện lượt audit nào, ID provisional trong bộ nhớ bị hủy hoàn toàn và không phải là authority bền vững. Không suy diễn rằng Registry cần giữ ID này; không quét tìm thread "mới nhất" (latest thread heuristic) để thay thế. Hệ thống fail-closed về `AUDITOR_REGISTRATION_REQUIRED`.
- **Crash sau lượt audit đầu tiên (Crash After First Turn)**: Nếu lượt audit đầu tiên có thể đã vật chất hóa nhưng quá trình kiểm định persistence/recovery bị gián đoạn, chuyển dispatch sang `AUDIT_UNCERTAIN` cho đến khi đối soát xong exact thread/history authority. Nghiêm cấm việc âm thầm tạo thread mới thay thế.

## Quy Tắc Khôi Phục Vòng Đời Auditor (Recovery Semantics — WO-V4-05A)

### 1. Recovery Store Fail-Closed Authority
Store `auditor_recovery_v1` hoạt động như một storage authority độc lập:
- **Pragmas**: `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = FULL`. WAL journal mode chỉ được kích hoạt *sau khi* xác thực schema và integrity thành công.
- **Reopen Validation**: Bắt buộc kiểm tra `user_version === 1`, bảng, cột, chỉ mục, và tính toàn vẹn của mọi bản ghi persisted.
  - Kiểm tra SHA-256 hash của `decision_json` đối chiếu với giá trị hash lưu trữ.
  - Revalidate ngữ cảnh quyết định (`project_id`, `audit_subject_id`, `auditor_thread_id`, `workspace_state_observed`).
  - Xác thực tính hợp lệ ngữ nghĩa của các trạng thái persisted và lịch sử chuyển tiếp. Bất kỳ sai lệch nào đều khiến store fail-closed với mã lỗi `AUDITOR_RECOVERY_CORRUPT`.

### 2. Hành Vi Khôi Phục Từng Trạng Thái (Per-State Recovery Logic)
Hàm `recoverAuditorBootstrap(projectId, options)` tuân thủ nghiêm ngặt ma trận xử lý sau:

| Trạng thái tại thời điểm sập nguồn / restart | Hành động khôi phục (`recoverAuditorBootstrap`) | Thẩm quyền Registry | Cho phép gọi model lại? |
|---|---|---|---|
| `PROVISIONAL_THREAD` | Xóa bản ghi active bootstrap; giải phóng trạng thái chờ. | `UNBOUND` (`thread_id: null`) | Không (chờ phiên mới) |
| `FIRST_TURN_STARTING` | Chuyển sang `AUDIT_UNCERTAIN`. Ghi nhận sự cố trước khi xác định được turn. | `UNBOUND` | **TUYỆT ĐỐI CẤM auto-resend** |
| `FIRST_TURN_IN_FLIGHT` | Giữ nguyên / chuyển sang `AUDIT_UNCERTAIN`. | `UNBOUND` | **TUYỆT ĐỐI CẤM auto-resend** |
| `AUDIT_UNCERTAIN` | Giữ nguyên `AUDIT_UNCERTAIN`. Không cho phép thoát trạng thái tự động. | `UNBOUND` | **TUYỆT ĐỐI CẤM auto-resend** |
| `DECISION_VALIDATED` | Tiếp tục quy trình: khởi tạo process mới, gọi exact `thread/resume(T)` để xác thực persistence rồi bind Registry. | Chưa bind cho tới khi resume thành công | **KHÔNG** (dùng lại validated decision đã persist) |
| `RESUME_VERIFYING` | Thử lại exact `thread/resume(T)` trên App Server process mới. Nếu thành công, chuyển `RESUME_VERIFIED` $\to$ bind Registry. | Chưa bind cho tới khi resume thành công | **KHÔNG** (dùng lại validated decision đã persist) |
| `RESUME_VERIFIED` | Tiến hành gọi atomic `registry.bindAuditorThread(projectId, threadId)`. | Chuyển sang `AUDITOR_BOUND_READY` | Không |
| `REGISTRY_BINDING` | Kiểm tra Registry: nếu đã bind cùng `thread_id` thì xóa active bootstrap và hoàn tất `DURABLE_BOUND` (idempotent reconciliation). Nếu chưa bind, gọi lại `bindAuditorThread`. | Chuyển sang `AUDITOR_BOUND_READY` | Không |

**Nguyên tắc cốt lõi**: Trạng thái không chắc chắn (`FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT`, `AUDIT_UNCERTAIN`) tuyệt đối không bao giờ được tự động phát lại `turn/start` để tránh nguy cơ double-dispatch, xung đột nhánh hoặc tiêu tốn chi phí token ngoài tầm kiểm soát. Quyết định một khi đã validated (`DECISION_VALIDATED`) được lưu trữ bất biến và được phép tái sử dụng để hoàn tất bài kiểm tra resume.

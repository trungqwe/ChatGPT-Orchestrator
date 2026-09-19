# Codex Auditor Adapter

## Interface and Separation of Concerns

Kiến trúc chia làm hai module độc lập trong `pipeline-ui/lib/auditor/`:
1. `codex-app-server-client.js`: Quản lý child process (`spawn`, `shell=false`), framing stdio JSONL, bounded diagnostic tail stderr (64 KiB), request IDs đơn điệu, tương quan response (xác thực chặt chẽ response phải có đúng một trong hai trường `result` hoặc `error`), timeouts, uncertainty semantics (request side-effect đã gửi khi close chuyển thành `CODEX_APP_SERVER_REQUEST_UNCERTAIN`), notifications (với write authority có thể await trước khi vào `READY`), và server-initiated requests fail-closed. Không chứa logic nghiệp vụ broker/registry, không chuyển tiếp test hooks (`_`).
2. `codex-auditor-adapter.js`: Semantic wrapper định kiểu xung quanh các phương thức stable của App Server: `initialize`, `listModels`, `startThread`, `resumeThread`, `readThread`, `startTurn`, `waitForTurnCompletion`, `interruptTurn`, `startReview`, `waitForReviewCompletion`, `close`. Định nghĩa hằng số định kiểu `THREAD_SANDBOX_MODES` (`read-only`, `workspace-write`, `danger-full-access`).

## Phân biệt hai kiểu dữ liệu giao thức (Protocol Type Distinction)

- `ThreadStartParams.sandbox`: Thuộc enum `SandboxMode`, sử dụng chuỗi kebab-case: `"read-only"`, `"workspace-write"`, `"danger-full-access"`.
- `TurnStartParams.sandboxPolicy.type`: Thuộc enum `SandboxPolicy`, sử dụng định danh camelCase: `"readOnly"`, `"workspaceWrite"`, `"dangerFullAccess"`.
Hai kiểu này độc lập và không thể dùng thay thế nhau trên dây truyền (wire). V4 WP-V4-03A kế thừa security policy từ thread level và gửi `sandbox: "read-only"`.

## Contract Rules

- `initialize`: Gửi request `initialize` với `clientInfo` tĩnh; sau khi thành công gửi notification `initialized` với `params: {}`. Write authority bắt buộc hoàn thành ghi vào stdin trước khi vào `READY`; nếu ghi lỗi sẽ chuyển sang `FAILED` với `CODEX_APP_SERVER_WRITE_FAILED` hoặc `CODEX_APP_SERVER_STDIN_ERROR`. Không dùng `experimentalApi`.
- `listModels`: Trả provider models detached; không phân giải model tier ở WP-V4-03A (dành cho WP-V4-06).
- `startThread`: Bắt buộc `cwd` tuyệt đối (`path.isAbsolute`). Cấu hình bảo mật provider ổn định: `sandbox: "read-only"` và `approvalPolicy: "never"`. Từ chối các invented boolean protocol fields (`readOnly`, `workspaceWrite`, `dangerFullAccess`) bằng `CODEX_APP_SERVER_SECURITY_VIOLATION`. Bảo toàn opaque `thread.id` và `thread.sessionId` byte-for-byte. Không ghi vào Registry. Loại bỏ hoàn toàn việc forward các param test hook có tiền tố `_`.
- `resumeThread`: Yêu cầu exact `threadId`. Không suy diễn heuristic. Xác thực response `result.thread.id === threadId`, nếu lệch trả về `CODEX_APP_SERVER_THREAD_MISMATCH`. Nếu thất bại từ provider, truyền nguyên lỗi, không tự tạo thread thay thế.
- `readThread`: Exact `threadId`. Mặc định `includeTurns: false`. Xác thực response `result.thread.id === threadId`, nếu lệch trả về `CODEX_APP_SERVER_THREAD_MISMATCH`. Không resume ngầm định.
- `startTurn`: Bắt buộc `threadId` và mảng `input` văn bản có chặn kích thước (tối đa 1 MiB). Ghi nhận quan hệ sở hữu local `turnId -> threadId` trong bounded map (tối đa 4,096 mục). Forward `outputSchema` an toàn nhưng không validate `AuditDecisionV1` (dành cho WP-V4-04). Trạng thái turn ban đầu theo chuẩn provider là `inProgress`.
- `waitForTurnCompletion`: Xác thực sở hữu local giữa `turnId` và `threadId`, từ chối ngay với `CODEX_APP_SERVER_THREAD_MISMATCH` nếu `turnId` thuộc về thread khác. Hỗ trợ notification `turn/completed` không có `threadId` (chuẩn provider ổn định) hoặc có `threadId`. Duy trì bounded completion cache (tối đa 4,096 records) để loại bỏ race condition khi notification hoàn thành đến trước khi waiter đăng ký.
- `startReview`: Chỉ cho phép `delivery = "inline"` trong v4 MVP (tối thiểu `{ type: "uncommittedChanges" }`, từ chối `detached`). Target bắt buộc phải là structured object (từ chối plain string với `INVALID_REVIEW_TARGET`). Yêu cầu `reviewThreadId === threadId`, từ chối `CODEX_APP_SERVER_THREAD_MISMATCH`.
- `waitForReviewCompletion`: Yêu cầu thu thập evidence `item/completed (exitedReviewMode)` khớp chính xác `item.id === turnId` và bắt buộc khớp notification `turn/completed` cho cùng `turnId`. Bảo toàn trường `review` chuẩn của provider. Duy trì bounded review evidence cache để xử lý trường hợp evidence đến trước khi waiter đăng ký.
- `interruptTurn`: Ghi nhận quan hệ sở hữu `turnId -> threadId` và gửi request `turn/interrupt`.
- `close`: Idempotent; reject các request side-effect đã gửi thành `CODEX_APP_SERVER_REQUEST_UNCERTAIN`, đóng stdin, chờ graceful exit, và terminate đúng PID của child process được spawn (không kill theo tên tiến trình).

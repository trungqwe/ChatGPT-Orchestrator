# Relay Protocol

1. Snapshot workspace.
2. Resume exact auditor thread; Codex inspect local repo.
3. Validate structured AuditDecision.
4. Với `DISPATCH_WORKER`, recheck freshness, persist rồi dispatch.
5. Worker trả `READY_FOR_REVIEW` với exact identities.
6. Snapshot mới; resume cùng thread; audit source/diff/tests độc lập.
7. Nhận approve, corrective WorkOrder, evidence request, blocked hoặc stop.

Mọi request có correlation ID và idempotency fingerprint. Timeout sau send nhưng chưa biết outcome là `UNCERTAIN`, không auto-retry.

## Transport Core Protocol (WP-V4-03A / WO-V4-03AG Wire Enum Seal)

- Local Stdio JSONL: Giao tiếp qua `codex app-server --listen stdio://` với `shell: false`. Không dùng WebSocket/Unix socket trong v4 MVP.
- Handshake Authority: Khởi tạo bằng request `initialize` (với static clientInfo) -> chờ response -> gửi notification `initialized` với `params: {}` có write authority (chờ ghi thành công vào stdin) -> chuyển sang trạng thái `READY`. Nếu ghi lỗi, chuyển sang `FAILED`.
- Thread Start Contract: Gửi payload chuẩn `{ cwd: "<absolute>", approvalPolicy: "never", sandbox: "read-only" }`. Thuộc tính `sandbox` ở cấp thread là `SandboxMode` (kebab-case `"read-only"`), phân biệt rõ với `TurnStartParams.sandboxPolicy.type` là `SandboxPolicy` (camelCase `"readOnly"`). Không gửi các boolean tự chế như `readOnly`, `workspaceWrite`, `dangerFullAccess`. Không forward bất kỳ test-only parameters có tiền tố `_`.
- Request Correlation: Request ID cục bộ đơn điệu `cas_req_X`, tương quan 1-1 với response. Response bắt buộc phải có đúng một trong hai trường `result` hoặc `error` (nếu có cả hai hoặc không có trường nào sẽ báo `CODEX_APP_SERVER_PROTOCOL_ERROR`). Response trùng ID hoặc unknown ID gây protocol error fail-closed.
- Notifications: Các message có `method` và không có `id`. Notification không thể giải phóng pending request.
- Turn Completion Authority: Provider chuẩn gửi notification `turn/completed` với `{ turn: { id, status } }` không bắt buộc có `threadId`. Adapter duy trì bounded local ownership map (`turnId -> threadId`) và bounded completion cache (tối đa 4,096 records) để loại bỏ race condition khi turn hoàn thành trước khi waiter đăng ký.
- Review Contract: Request `review/start` yêu cầu target là structured object (`uncommittedChanges`, `baseBranch`, `commit`, `custom`), từ chối plain string. Evidence review `exitedReviewMode` phải có `item.id === turnId` và giữ nguyên trường `review` của provider; kết hợp bounded evidence cache để loại trừ race.
- Server-Initiated Requests: Các message có cả `id` và `method`. Phương thức chuẩn là `item/commandExecution/requestApproval` và `item/fileChange/requestApproval`. Nhận diện tách biệt khỏi response và không đưa vào pending request map. Do chưa có operator UI duyệt, mặc định phản hồi từ chối `{ decision: "decline" }` fail-closed, không bao giờ tự động phê duyệt (auto-approve), không log nhạy cảm toàn bộ payload.
- Lifecycle Uncertainty: Bất kỳ request nào có side-effect (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) bị timeout sau khi đã write thành công vào stdin, tiến trình con bị thoát đột ngột, hoặc client bị `close()` trong khi request đã gửi đang chờ kết quả đều trả về `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.

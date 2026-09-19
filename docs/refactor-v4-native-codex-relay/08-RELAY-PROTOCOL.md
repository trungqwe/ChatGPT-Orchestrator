# Relay Protocol

1. Snapshot workspace.
2. Resume exact auditor thread; Codex inspect local repo.
3. Validate structured AuditDecision.
4. Với `DISPATCH_WORKER`, recheck freshness, persist rồi dispatch.
5. Worker trả `READY_FOR_REVIEW` với exact identities.
6. Snapshot mới; resume cùng thread; audit source/diff/tests độc lập.
7. Nhận approve, corrective WorkOrder, evidence request, blocked hoặc stop.

Mọi request có correlation ID và idempotency fingerprint. Timeout sau send nhưng chưa biết outcome là `UNCERTAIN`, không auto-retry.

## Transport Core Protocol (WP-V4-03A)

- Local Stdio JSONL: Giao tiếp qua `codex app-server --listen stdio://` với `shell: false`. Không dùng WebSocket/Unix socket trong v4 MVP.
- Handshake: Khởi tạo bằng request `initialize` (với static clientInfo) -> chờ response -> gửi notification `initialized` -> trạng thái READY.
- Request Correlation: Request ID cục bộ đơn điệu `cas_req_X`, tương quan 1-1 với response `{ id, result }` hoặc `{ id, error }`. Response trùng ID hoặc unknown ID gây protocol error fail-closed.
- Notifications: Các message có `method` và không có `id`. Notification không thể giải phóng pending request.
- Server-Initiated Requests: Các message có cả `id` và `method`. Nhận diện tách biệt khỏi response và không đưa vào pending request map. Do chưa có operator UI duyệt, mặc định trả error response fail-closed, không bao giờ tự động phê duyệt (auto-approve).
- Lifecycle Uncertainty: Bất kỳ request nào có side-effect (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) bị timeout sau khi đã write thành công vào stdin hoặc tiến trình con bị thoát đột ngột đều trả về `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.

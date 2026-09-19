# Codex Auditor Adapter

## Interface and Separation of Concerns

Kiến trúc chia làm hai module độc lập trong `pipeline-ui/lib/auditor/`:
1. `codex-app-server-client.js`: Quản lý child process (`spawn`, `shell=false`), framing stdio JSONL, bounded diagnostic tail stderr (64 KiB), request IDs đơn điệu, tương quan response, timeouts, uncertainty semantics, notifications và server-initiated requests fail-closed. Không chứa logic nghiệp vụ broker/registry.
2. `codex-auditor-adapter.js`: Semantic wrapper định kiểu xung quanh các phương thức stable của App Server: `initialize`, `listModels`, `startThread`, `resumeThread`, `readThread`, `startTurn`, `waitForTurnCompletion`, `interruptTurn`, `startReview`, `waitForReviewCompletion`, `close`.

## Contract Rules

- `initialize`: Gửi request `initialize` với `clientInfo` tĩnh; sau khi thành công gửi notification `initialized`. Idempotent: gọi nhiều lần không gửi trùng. Không dùng `experimentalApi`.
- `listModels`: Trả provider models detached; không phân giải model tier ở WP-V4-03A (dành cho WP-V4-06).
- `startThread`: Bắt buộc `cwd` tuyệt đối (`path.isAbsolute`). Mặc định bảo mật `readOnly: true`; từ chối `dangerFullAccess` và `workspaceWrite`. Bảo toàn opaque `thread.id` và `thread.sessionId` byte-for-byte. Không ghi vào Registry.
- `resumeThread`: Yêu cầu exact `threadId`. Không suy diễn heuristic. Nếu thất bại, truyền nguyên lỗi provider, không tự tạo thread thay thế.
- `readThread`: Exact `threadId`. Mặc định `includeTurns: false`. Không resume ngầm định.
- `startTurn`: Input chỉ hỗ trợ mảng văn bản có chặn kích thước (tối đa 1 MiB). Forward `outputSchema` an toàn nhưng không validate `AuditDecisionV1` (dành cho WP-V4-04).
- `waitForTurnCompletion`: Bắt buộc tương quan chính xác cả `threadId` và `turnId` từ notification `turn/completed`. Các trạng thái cuối hợp lệ: `completed`, `interrupted`, `failed`.
- `startReview`: Chỉ cho phép `delivery = "inline"` trong v4 MVP (từ chối `detached`). Kiểm tra target type thuộc allowlist. Yêu cầu `reviewThreadId === threadId`, từ chối `CODEX_APP_SERVER_THREAD_MISMATCH`.
- `waitForReviewCompletion`: Yêu cầu thu thập evidence `item/completed (exitedReviewMode)` và bắt buộc khớp notification `turn/completed`.
- `close`: Idempotent; đóng stdin, chờ graceful exit, và terminate đúng PID của child process được spawn (không kill theo tên tiến trình).

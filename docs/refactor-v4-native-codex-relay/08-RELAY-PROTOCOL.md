# Relay Protocol

## 1. High-Level Audit Flow Sequence

The orchestrator relay follows an explicit, fail-closed lifecycle sequence:

```text
1. Workspace Snapshot (compute exact workspace_state_id)
      ↓
2. Output Schema Generation (buildAuditDecisionV1OutputSchema bound to exact context:
   project_id, audit_subject_id, auditor_thread_id, workspace_state_observed)
      ↓
3. Auditor Turn Execution (adapter.startTurn with threadId, prompt, outputSchema)
      ↓
4. Terminal Turn Collection (await turn/completed notification with status=completed, itemsView=full)
      ↓
5. Strict Semantic Validation (extractAuditDecisionV1FromTurn / validateAuditDecisionV1)
      ↓
6. Workspace Freshness Recheck (compute fresh workspace_state_id immediately before action)
      ↓
7. Future Action Application (dispatch worker / complete package / request evidence / record block / stop)
```

- **Thread Durability**: Codex may materialize durable history once the first meaningful user turn begins; WP05 proves durability explicitly through recovery/resume and does not rely on the exact filesystem-materialization event.
- **Freshness Gate**: The `workspace_state_observed` in the decision confirms what state the auditor analyzed, but is NOT sufficient by itself to authorize workspace modifications or dispatch. The relay freshly recomputes workspace state immediately prior to side effects.
- **Deterministic Retries**: Every request carries correlation ID and idempotency fingerprint. Timeouts or disconnections after send produce `UNCERTAIN`, never auto-retry.

---

## 2. Transport Core Protocol (WP-V4-03A / WO-V4-03AG Wire Enum Seal)

- **Local Stdio JSONL**: Giao tiếp qua `codex app-server --listen stdio://` với `shell: false`. Không dùng WebSocket/Unix socket trong v4 MVP.
- **Handshake Authority**: Khởi tạo bằng request `initialize` (với static clientInfo) -> chờ response -> gửi notification `initialized` với `params: {}` có write authority (chờ ghi thành công vào stdin) -> chuyển sang trạng thái `READY`. Nếu ghi lỗi, chuyển sang `FAILED`.
- **Thread Start Contract**: Gửi payload chuẩn `{ cwd: "<absolute>", approvalPolicy: "never", sandbox: "read-only" }`. Thuộc tính `sandbox` ở cấp thread là `SandboxMode` (kebab-case `"read-only"`), phân biệt rõ với `TurnStartParams.sandboxPolicy.type` là `SandboxPolicy` (camelCase `"readOnly"`). Không gửi các boolean tự chế như `readOnly`, `workspaceWrite`, `dangerFullAccess`. Không forward bất kỳ test-only parameters có tiền tố `_`.
- **Request Correlation**: Request ID cục bộ đơn điệu `cas_req_X`, tương quan 1-1 với response. Response bắt buộc phải có đúng một trong hai trường `result` hoặc `error` (nếu có cả hai hoặc không có trường nào sẽ báo `CODEX_APP_SERVER_PROTOCOL_ERROR`). Response trùng ID hoặc unknown ID gây protocol error fail-closed.
- **Notifications**: Các message có `method` và không có `id`. Notification không thể giải phóng pending request.
- **Turn Completion Authority**: Provider chuẩn gửi notification `turn/completed` với `{ turn: { id, status } }` không bắt buộc có `threadId`. Adapter duy trì bounded local ownership map (`turnId -> threadId`) và bounded completion cache (tối đa 4,096 records) để loại bỏ race condition khi turn hoàn thành trước khi waiter đăng ký.
- **Review Contract**: Request `review/start` yêu cầu target là structured object (`uncommittedChanges`, `baseBranch`, `commit`, `custom`), từ chối plain string. Evidence review `exitedReviewMode` phải có `item.id === turnId` và giữ nguyên trường `review` của provider; kết hợp bounded evidence cache để loại trừ race.
- **Server-Initiated Requests**: Các message có cả `id` và `method`. Phương thức chuẩn là `item/commandExecution/requestApproval` và `item/fileChange/requestApproval`. Nhận diện tách biệt khỏi response và không đưa vào pending request map. Do chưa có operator UI duyệt, mặc định phản hồi từ chối `{ decision: "decline" }` fail-closed, không bao giờ tự động phê duyệt (auto-approve), không log nhạy cảm toàn bộ payload.
- **Lifecycle Uncertainty**: Bất kỳ request nào có side-effect (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) bị timeout sau khi đã write thành công vào stdin, tiến trình con bị thoát đột ngột, hoặc client bị `close()` trong khi request đã gửi đang chờ kết quả đều trả về `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.

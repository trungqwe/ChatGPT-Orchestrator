# Báo cáo thực hiện WO-V4-03A — Native Codex App Server Stdio Transport Core

# 1. Baseline

- Repository: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- Approved Parent SHA: `aed3b5582101222f9df96931e9ba369896b6e0f2`
- Branch: `review/v4-wp03a-codex-app-server-transport`
- Previous Package: `WP-V4-02B` (APPROVED / CLOSED)
- Current Package: `WP-V4-03A` (TRANSPORT CORE)

# 2. Transport Selection

- Chỉ sử dụng cơ chế vận chuyển cục bộ stdio JSONL qua:
  `codex app-server --listen stdio://`
- Sử dụng argument array với `shell: false` và `stdio: ['pipe', 'pipe', 'pipe']`.
- Hoàn toàn không triển khai WebSocket, Unix socket, remote transport hay HTTP endpoints trong phạm vi V4 MVP.

# 3. Process Lifecycle

- Trạng thái tiến trình được theo dõi tường minh: `NEW -> SPAWNING -> INITIALIZING -> READY -> CLOSING -> CLOSED` (hoặc `FAILED`).
- Quản lý vòng đời tiến trình con qua tham chiếu PID chính xác.
- Tiến trình con kết thúc bất ngờ (`_onChildExit`) được ghi nhận chi tiết (exit code, signal, bounded stderr tail) và chuyển trạng thái sang `FAILED`.

# 4. Initialize Handshake

- Quá trình bắt tay sau khi spawn tiến trình:
  1. Gửi request `initialize` kèm `clientInfo` tĩnh: `{ name: "chatgpt_orchestrator", title: "ChatGPT Orchestrator Native Codex Relay", version: "4" }`.
  2. Không truyền `experimentalApi: true` (chỉ sử dụng stable API).
  3. Chờ response thành công từ App Server.
  4. Gửi notification `initialized` (`{ method: "initialized" }` không có `id`).
  5. Chuyển sang trạng thái `READY`.
- Tính lũy thừa (idempotency): Gọi `initialize()` lần thứ hai không gửi lại request protocol mà trả về kết quả sẵn có.

# 5. JSONL Framing

- Dòng stdout được tách theo ký tự xuống dòng (`\n`).
- Bất kỳ dòng nào không parse được JSON hợp lệ lập tức fail transport với `CODEX_APP_SERVER_PROTOCOL_ERROR`, không bỏ qua dòng lỗi.
- Bounded line size: Giới hạn kích thước dòng tối đa 8 MiB (`maxLineSizeBytes: 8388608`). Nếu vượt ngưỡng trước khi có newline, lập tức ngắt kết nối với `CODEX_APP_SERVER_PROTOCOL_LIMIT`.
- Bounded stderr diagnostics: Stderr được tích lũy vào bộ đệm FIFO tail tối đa 64 KiB (`maxStderrBytes: 65536`), không bao giờ parse stderr làm JSON-RPC authority.

# 6. Request Correlation

- Mã định danh request ID được sinh cục bộ theo chuỗi đơn điệu tăng dần `cas_req_X`.
- Bản đồ `_pendingRequests` lưu trữ request trước khi ghi vào stdin.
- Response `{ id, result }` hoặc `{ id, error }` được ánh xạ 1-1 với request tương ứng.
- Unknown response ID: Báo lỗi `CODEX_APP_SERVER_PROTOCOL_ERROR` và fail-closed.
- Duplicate response ID: Báo lỗi `CODEX_APP_SERVER_PROTOCOL_ERROR` và fail-closed.

# 7. Notifications

- Các thông điệp có `method` nhưng không có `id` được xác định là notification.
- Route thông điệp qua cơ chế EventEmitter (`notification` và method-specific events).
- Notification không bao giờ giải phóng nhầm các pending request.

# 8. Server-Initiated Request Safety

- Thông điệp có cả `id` và `method` được phân loại là server-initiated request.
- Tách biệt hoàn toàn khỏi response thông thường; không đưa vào `_pendingRequests`.
- Chính sách mặc định fail-closed: Do chưa có giao diện duyệt của operator, mặc định trả về phản hồi lỗi JSON-RPC `SERVER_REQUEST_REJECTED_FAIL_CLOSED` (code `-32000`). Tuyệt đối không tự động phê duyệt (no auto-approval) cho command execution hay file modification.
- Cung cấp ranh giới handler có thể inject (`onServerRequest`).

# 9. Thread Methods

- `startThread`: Bắt buộc đường dẫn `cwd` tuyệt đối (`path.isAbsolute`). Mặc định bảo mật `readOnly: true`, từ chối các yêu cầu quyền leo thang như `dangerFullAccess` hay `workspaceWrite`. Bảo toàn nguyên vẹn `thread.id` và `sessionId` từ provider. Không ghi vào Registry.
- `resumeThread`: Yêu cầu `threadId` chính xác, không dùng heuristic hay tìm kiếm gần đúng. Nếu provider báo lỗi, truyền nguyên lỗi, không tự tạo thread thay thế.
- `readThread`: Đọc thread theo exact ID. Mặc định `includeTurns: false`. Không resume ngầm định.

# 10. Turn Methods

- `startTurn`: Input chỉ chấp nhận mảng văn bản (`[{ type: "text", text: "..." }]`) với tổng dung lượng không quá 1 MiB. Hỗ trợ chuyển tiếp `outputSchema` an toàn (<= 512 KiB) mà không validate `AuditDecisionV1` (dành cho WP-V4-04).
- `waitForTurnCompletion`: Tương quan chính xác cả `threadId` và `turnId` từ notification `turn/completed`. Chỉ chấp nhận các trạng thái cuối: `completed`, `interrupted`, hoặc reject khi `failed`.
- `interruptTurn`: Yêu cầu exact `threadId` và `turnId`. Phản hồi request không tự ngụy tạo trạng thái hoàn thành khi chưa nhận được notification `turn/completed`.

# 11. Review Methods

- `startReview`: Chỉ cho phép `delivery = "inline"` trong kiến trúc V4 MVP (từ chối `detached`). Kiểm tra target type thuộc danh sách cho phép (`uncommittedChanges`, `baseBranch`, `commit`, `custom`). Yêu cầu `reviewThreadId === requested threadId`; nếu sai lệch báo lỗi `CODEX_APP_SERVER_THREAD_MISMATCH`.
- `waitForReviewCompletion`: Thu thập bằng chứng reviewer từ `item/completed` (`item.type === "exitedReviewMode"`) và bắt buộc có notification `turn/completed` tương ứng trước khi hoàn tất.

# 12. Timeout / Uncertainty Contract

- Mọi request đều có thời gian timeout hữu hạn.
- Phân biệt rõ tính chất hoạt động:
  - Read-only request (`model/list`, `thread/read`): Khi timeout trả về `CODEX_APP_SERVER_TIMEOUT`.
  - Side-effecting request (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`): Nếu đã write thành công vào stdin mà quá thời gian timeout chưa có response, hoặc tiến trình con bị thoát đột ngột, trả về `CODEX_APP_SERVER_REQUEST_UNCERTAIN`.
- Không tự động retry khi gặp tình trạng bất định (uncertainty) nhằm tránh nhân bản thread hoặc turn ngoài ý muốn.

# 13. Shutdown

- Hàm `close()` có giới hạn thời gian và bảo đảm tính lũy thừa (idempotent).
- Dừng nhận request mới, đóng luồng `stdin`, cho phép tiến trình con thoát nhẹ nhàng trong khoảng thời gian ân hạn (graceful timeout).
- Nếu tiến trình con vẫn sống, gửi tín hiệu `SIGTERM` rồi `SIGKILL` tới đúng PID của child process được spawn.
- Tuyệt đối không dùng lệnh hủy theo tên tiến trình (`taskkill /IM codex.exe` hoặc `pkill codex`).

# 14. Fake App Server Fixture

- Tạo fixture xác định `pipeline-ui/test/fixtures/fake-codex-app-server.js` chạy stdio JSONL thực tế.
- Hỗ trợ đầy đủ các kịch bản:
  - Khởi tạo, list models, start/resume/read thread, start/interrupt turn, start review.
  - Streaming notifications: `turn/started`, `item/started`, `item/completed`, `turn/completed`.
  - Các kịch bản lỗi: malformed JSON, oversized line, exit pre-init, exit mid-request, timeout, duplicate response, unknown response ID, provider error, server-initiated request, wrong reviewThreadId, wrong turnId notification, turn failure, turn interrupt.

# 15. Transport Tests

- Triển khai bộ kiểm thử xác định `pipeline-ui/test/refactor/codex-app-server-client.test.js` bao gồm 60 test cases:
  - `CAS-001..CAS-060: 60/60 PASS`.

# 16. Existing Regression Evidence

Toàn bộ 10 bộ kiểm thử trong `pipeline-ui` đều đạt kết quả PASS:

```text
Quarantine:
✓ WP-V4-02A legacy auditor quarantine contract passed.

Native Transition:
✓ Legacy closed-loop surface is quarantined pending Native Codex transport.

Broker CLI:
CLI-001..CLI-050: 50/50 PASS

SQLite Lifecycle Store:
SL-001..SL-047: 47/47 PASS

Broker Core:
BC-001..BC-052: 52/52 PASS

Worker Adapter:
WA-001..WA-055: 55/55 PASS

Workspace State:
WS-001..WS-051: 51/51 PASS

Project Registry:
RG-001..RG-039: 39/39 PASS

Registry v2 Migration:
RV2-001..RV2-052: 52/52 PASS

Codex App Server Transport:
CAS-001..CAS-060: 60/60 PASS
```

# 17. Optional Real Smoke

- Tạo công cụ smoke test có cờ opt-in: `pipeline-ui/codex-app-server-smoke.js`.
- Chạy không có cờ `--live`:
  ```json
  {
    "ok": false,
    "reason": "REAL_APP_SERVER_SMOKE: NOT_RUN_OPERATOR_OPT_IN_REQUIRED",
    "message": "Explicit operator opt-in flag --live is required to run live Codex App Server smoke test."
  }
  ```
- Chạy với cờ `--live` (kiểm tra thực tế với Codex CLI `0.154.0`):
  ```json
  {
    "ok": true,
    "transport": "stdio-jsonl",
    "initialized": true,
    "model_list": "PASS",
    "model_count": 5,
    "thread_created": false,
    "turn_started": false
  }
  ```
- Báo cáo trạng thái smoke:
  `PASS_INITIALIZE_MODEL_LIST_ONLY`

# 18. Security

- Giao tiếp duy nhất qua stdio JSONL cục bộ; không mở socket từ xa.
- Gọi lệnh an toàn với `shell: false` và mảng tham số.
- Mặc định bảo mật fail-closed với mọi yêu cầu phê duyệt từ server.
- Tuân thủ nghiêm ngặt các giới hạn bộ nhớ đệm (8 MiB stdout, 64 KiB stderr tail).
- Xử lý bất định chặt chẽ, không tự ý retry khi có rủi ro side-effect.

# 19. Scope Compliance

- Server integrated: NO
- UI integrated: NO
- Broker integrated: NO
- Runtime integrated: NO
- Registry auditor thread persisted: NO
- AuditDecisionV1 implemented: NO
- Model tier resolver implemented: NO
- Real thread created: NO
- Real turn started: NO
- Real review started: NO
- Real worker dispatched: NO
- Legacy Web bridge restored: NO

# 20. Recommendation

READY_FOR_WP_V4_03A_EXTERNAL_REVIEW

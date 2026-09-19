# Source reference memo

## Official capability facts

OpenAI Codex App Server docs xác nhận các phương thức protocol qua stdio JSONL: `initialize` / `initialized`, `model/list`, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `turn/completed`, `turn/interrupt`, `review/start`, `server-initiated requests`, và `outputSchema`: https://developers.openai.com/codex/app-server

Kiểm chứng dựa trên schema sinh ra từ chính bản cài đặt Codex (`codex app-server generate-ts`):
- `ThreadStartParams`: Chứa các trường `{ cwd, approvalPolicy: "never", sandbox: SandboxMode }`, trong đó `SandboxMode = "read-only" | "workspace-write" | "danger-full-access"` (dạng kebab-case).
- `TurnStartParams`: Chứa trường `sandboxPolicy: SandboxPolicy`, trong đó `SandboxPolicy` có các biến thể `{ type: "readOnly", ... }`, `{ type: "workspaceWrite", ... }`, `{ type: "dangerFullAccess" }` (dạng camelCase).
- `TurnStatus`: Trạng thái ban đầu chuẩn là `inProgress`, các trạng thái kết thúc là `completed`, `interrupted`, `failed`.
- `ReviewTarget`: Là structured object (`uncommittedChanges`, `baseBranch`, `commit`, `custom`), không phải plain string.
- Server Request: Phương thức chuẩn là `item/commandExecution/requestApproval` và `item/fileChange/requestApproval`.

## Phân định ranh giới (Contract Distinctions)

1. Official Provider Behavior:
   - App Server chạy qua stdio JSONL, yêu cầu `initialize` trước các lệnh khác.
   - Handshake hoàn tất khi client gửi notification `initialized` với `params: {}`.
   - `thread/start` nhận `sandbox: SandboxMode` (`"read-only"`, `"workspace-write"`, `"danger-full-access"`).
   - Hỗ trợ server-initiated requests (như yêu cầu phê duyệt lệnh shell hoặc file change).
   - `review/start` hỗ trợ cả `inline` và `detached`.
   - Streaming các notification `turn/started`, `item/started`, `item/completed`, `turn/completed` (trong đó `turn/completed` có thể không kèm `threadId`).

2. Our Adapter Policy (WP-V4-03A / WO-V4-03AG):
   - Chỉ cho phép transport stdio JSONL cục bộ với `shell: false`.
   - Khởi tạo với `clientInfo` tĩnh và không bật `experimentalApi`. Write authority bắt buộc hoàn thành ghi `initialized` trước khi vào `READY`.
   - Server-initiated requests mặc định fail-closed với quyết định `{ decision: "decline" }` do chưa có giao diện duyệt của operator; không bao giờ tự động phê duyệt (auto-approve); không log nhạy cảm toàn bộ payload.
   - Chỉ cho phép `review/start` với `delivery = "inline"`; từ chối `detached` để bảo toàn tính duy nhất của thread identity. Target bắt buộc là structured object.
   - Bắt buộc `cwd` tuyệt đối khi `thread/start` và cấu hình `sandbox: "read-only"`, `approvalPolicy: "never"` (từ chối `dangerFullAccess`, `workspaceWrite`, `readOnly`).
   - Loại bỏ hoàn toàn việc forward các param test hook (`_`).
   - Ánh xạ local turn ownership (`turnId -> threadId`) và bounded completion cache để triệt tiêu race condition.
   - Timeout sau write, client `close()`, hoặc crash tiến trình con khi đang chạy lệnh có side-effect chuyển sang `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.
   - Giới hạn kích thước dòng stdout 8 MiB, giới hạn stderr tail 64 KiB, giới hạn text input 1 MiB.

3. Status & Future V4 Behavior:
   - WP-V4-03A: PENDING_EXTERNAL_REVIEW (đã hoàn thành WO-V4-03AG Wire Enum Seal, chờ phê duyệt).
   - WP-V4-03B: NOT YET STARTED (Live App Server smoke & end-to-end verification).
   - WP-V4-04: Validate cấu trúc `AuditDecisionV1` qua strict schema.
   - WP-V4-05: Lưu trữ bền vững và phục hồi binding thread ID trong Project Registry v2.
   - WP-V4-06: Phân giải model policy logic (`auditor_fast`, `auditor_standard`, `auditor_deep`) sang concrete model IDs từ `model/list`.

## Repository facts

V3 có Web-specific registry, durable SQLite worker lifecycle, workspace state, broker và Antigravity adapter. Global Codex config trước khôi phục từng trỏ model/base URL/hook vào `codex-chatgpt-web`.

## Decisions và proposals

Persistent project thread, App Server control plane, read-only auditor policy và logical model tiers là quyết định V4. WP-V4-03A đã niêm phong chuẩn xác enum dây chuyền `sandbox: "read-only"` qua WO-V4-03AG; WP-V4-03B sẽ nghiệm thu real App Server khi có quyết định bắt đầu.

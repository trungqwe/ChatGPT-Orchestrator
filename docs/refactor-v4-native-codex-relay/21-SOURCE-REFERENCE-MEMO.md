# Source reference memo

## Official capability facts

OpenAI Codex App Server docs xác nhận các phương thức protocol qua stdio JSONL: `initialize` / `initialized`, `model/list`, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `turn/completed`, `turn/interrupt`, `review/start`, `server-initiated requests`, và `outputSchema`: https://developers.openai.com/codex/app-server

## Phân định ranh giới (Contract Distinctions)

1. Official Provider Behavior:
   - App Server chạy qua stdio JSONL, yêu cầu `initialize` trước các lệnh khác.
   - Hỗ trợ server-initiated requests (như yêu cầu phê duyệt lệnh shell hoặc file change).
   - `review/start` hỗ trợ cả `inline` và `detached`.
   - Streaming các notification `turn/started`, `item/started`, `item/completed`, `turn/completed`.

2. Our Adapter Policy (WP-V4-03A):
   - Chỉ cho phép transport stdio JSONL cục bộ với `shell: false`.
   - Khởi tạo với `clientInfo` tĩnh và không bật `experimentalApi`.
   - Server-initiated requests mặc định fail-closed với lỗi JSON-RPC rõ ràng do chưa có giao diện duyệt của operator; không bao giờ tự động phê duyệt (auto-approve).
   - Chỉ cho phép `review/start` với `delivery = "inline"`; từ chối `detached` để bảo toàn tính duy nhất của thread identity.
   - Bắt buộc `cwd` tuyệt đối khi `thread/start` và mặc định cấu hình read-only (từ chối `dangerFullAccess` và `workspaceWrite`).
   - Timeout sau write hoặc crash tiến trình con khi đang chạy lệnh có side-effect chuyển sang `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.
   - Giới hạn kích thước dòng stdout 8 MiB, giới hạn stderr tail 64 KiB, giới hạn text input 1 MiB.

3. Future V4 Behavior (WP-V4-04+):
   - WP-V4-04: Validate cấu trúc `AuditDecisionV1` qua strict schema.
   - WP-V4-05: Lưu trữ bền vững và phục hồi binding thread ID trong Project Registry v2.
   - WP-V4-06: Phân giải model policy logic (`auditor_fast`, `auditor_standard`, `auditor_deep`) sang concrete model IDs từ `model/list`.

## Repository facts

V3 có Web-specific registry, durable SQLite worker lifecycle, workspace state, broker và Antigravity adapter. Global Codex config trước khôi phục từng trỏ model/base URL/hook vào `codex-chatgpt-web`.

## Decisions và proposals

Persistent project thread, App Server control plane, read-only auditor policy và logical model tiers là quyết định V4. WP-V4-03A triển khai xong transport core và adapter; WP-V4-03B nghiệm thu real App Server; WP-V4-04 triển khai AuditDecision.

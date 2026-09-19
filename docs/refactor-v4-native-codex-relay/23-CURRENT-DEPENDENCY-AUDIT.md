# Audit phụ thuộc hiện tại

Ngày audit: 2026-09-19. Baseline: `d7a5dfd169c2e5731a69efc466c2ddecf7a237a3`.

## Kết luận

Pivot sang Native Codex Relay là đúng. Codex Desktop đã trở lại native config; bridge runtime, ứng dụng Codex Web GPT, autostart và submodule đã bị gỡ. Repository chưa chạy được native audit vì production `pipeline-ui` vẫn là implementation Web-first.

## Findings theo mức độ

### Critical — Legacy transport vẫn nằm trên production path

`pipeline-ui/server.js` vẫn hard-code `127.0.0.1:17841`, chạy `codex-chatgpt-web doctor`, chọn `chatgpt-web/*`, đọc `.codex-chatgpt-web` và expose login/logout/verify/audit endpoints. UI vẫn gọi các endpoint đó. Có 186 textual references trong phạm vi audit.

Tác động: app có thể khởi động nhưng audit/config actions chắc chắn lỗi hoặc hiển thị trạng thái sai. Cần quarantine ngay, trước khi viết native adapter.

### High — Registry là contract V3

`registry.js` yêu cầu `task_id`, `task_id_verified`, `expected_model_label`, `managed_by_orchestrator=false` và chỉ chấp nhận Antigravity. Nó không thể lưu exact App Server `thread_id`, logical model policy hoặc worker engine khác.

### High — Chưa có auditor lifecycle/structured authority

Không có production adapter cho initialize/model/thread/turn/review; không có durable auditor-turn store; không có AuditDecisionV1 validator. Relay chưa thể chứng minh “same exact thread” hoặc phân biệt failed/uncertain turn.

### High — Legacy semantic path dựa trên prose

Các flow trong `server.js` và `public/app.js` vẫn gắn vai trò ChatGPT Web vào model label, transcript/report và UI action. Chúng không phải authority thích hợp cho V4 và phải đứng ngoài native command surface.

### Medium — Version compatibility

Máy hiện có `codex-cli 0.154.0`; `app-server` được CLI đánh dấu experimental dù protocol có tài liệu chính thức. Adapter cần initialize handshake, generated schema snapshot, compatibility range và fail-closed khi version/schema drift.

### Medium — Test suite chứa V3 assertions

`auditor-bootstrap.test.js` đòi tài liệu V3 đã xóa. Characterization suite bị ACL chặn ghi `__pycache__`. Hai lỗi này phải được xử lý như test-infrastructure migration, không được dùng để phủ nhận 311 checks core đang pass.

### Medium — Git state chưa đóng gói

Worktree vẫn ở branch V3; V4 docs, README, submodule deletion và legacy-doc deletion chưa có commit review riêng. `manifest.json` là untracked có sẵn và phải để ngoài scope.

## Tài sản đã chứng minh

| Thành phần | Bằng chứng | Quyết định |
|---|---:|---|
| Semantic CLI | 50/50 pass | KEEP/ADAPT |
| Broker core | 52/52 pass | KEEP |
| Registry mechanics | 39/39 pass | ADAPT schema |
| SQLite lifecycle | 47/47 pass | KEEP; thêm store riêng cho audit |
| Worker adapter | 55/55 pass | KEEP Antigravity; thêm registry |
| Workspace state | 51/51 pass | KEEP |
| WP-01 regression | 17/17 pass | KEEP |

Tổng bằng chứng pass: 311 cases.

## Đánh giá ba hướng Codex transport

Trọng số: correctness 25%, operational simplicity 20%, maintainability 15%, integration risk 15%, time-to-prove 10%, complexity 5%, performance 5%, resource cost 5%.

| Hướng | Điểm | Nhận định |
|---|---:|---|
| Node adapter gọi App Server stdio trực tiếp | 8.7 | Khớp relay hiện có; kiểm soát schema/identity; cần tự làm lifecycle |
| Dùng AO daemon làm auditor gateway | 7.4 | AO rất trưởng thành nhưng API/lifecycle rộng, reviewer thiên PR, thiếu AuditDecision contract trực tiếp |
| Sidecar Codex adapter riêng | 7.0 | Boundary sạch nhưng thêm process/deploy/health surface quá sớm |

Khuyến nghị: Node adapter trực tiếp, dùng generated TypeScript/JSON schema từ Codex binary; tham khảo failure/recovery patterns của AO nhưng không import Go `internal` packages hoặc thêm AO làm auditor authority.

## Ranh giới hoàn thành

Config native sạch không đồng nghĩa V4 hoàn tất. V4 chỉ đạt one-shot MVP khi có exact thread persistence, structured decision validation, freshness recheck, worker dispatch, same-thread review và restart recovery có test.

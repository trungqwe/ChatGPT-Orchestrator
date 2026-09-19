# Negative test matrix

Các case phải fail closed hoặc vào uncertainty có recovery:

- wrong/missing root, symlink escape, unknown project, legacy registry;
- missing/substituted thread, wrong cwd, resume failure, crash mid-turn;
- duplicate turn, malformed/extra-field/stale AuditDecision;
- model/tier unavailable; worker busy/uncertain/wrong identity;
- restart giữa auditor/worker; same-project double dispatch; cross-project parallel;
- WorkerReport/repo injection; worker claims pass nhưng actual tests fail;
- auditor source mutation; approval thiếu independent verification;
- oversized/invalid UTF-8 output, malicious filename, secret leakage.

Mỗi test ghi error code, persisted state, retry rule và operator action.

Registry v2 và migration phải kiểm tra riêng: v1 normal runtime load, không auto-migration, không thay `task_id` bằng `thread_id`, nguồn thay đổi giữa preview/apply, backup lỗi, atomic rename lỗi, post-write validation lỗi, rollback lỗi, `auditor.cwd` khác root, auditor enabled thiếu thread, thread ID có control characters, model policy lạ, v2 chứa trường v1 đã nghỉ, một project sai trong nhiều project, nguồn symlink hoặc không phải regular file. Lỗi trước rename giữ nguyên byte v1; lỗi sau rename cần khôi phục từ backup hoặc báo `REGISTRY_MIGRATION_ROLLBACK_FAILED`.

RV2AUTH-01: pre-lstat thiếu `dev`/`ino`, fd-fstat thiếu `dev`/`ino`, post-lstat thiếu `dev`/`ino`, pre/fd lệch, fd/post lệch, và identity giá trị `0` vẫn phải so sánh. Lần đọc lại ngay trước rename phải áp dụng cùng gate; nếu fail, target v1 không đổi và không có rename v2, dù backup an toàn đã được tạo.

## App Server Stdio Transport Negative Matrix (WP-V4-03A: CAS-001..CAS-060)

1. Dòng stdout malformed: Bất kỳ dòng nào không parse được JSON hợp lệ lập tức fail transport với `CODEX_APP_SERVER_PROTOCOL_ERROR`, không bỏ qua để tiếp tục.
2. Dòng stdout vượt ngưỡng (oversized line): Dòng dài hơn `maxLineSizeBytes` (8 MiB mặc định) trước khi có ký tự xuống dòng ngắt kết nối với `CODEX_APP_SERVER_PROTOCOL_LIMIT`.
3. Unknown response ID: Response có ID không tồn tại trong map pending request fail-closed với `CODEX_APP_SERVER_PROTOCOL_ERROR`.
4. Duplicate response ID: Response thứ hai cho một ID đã hoàn thành fail-closed với `CODEX_APP_SERVER_PROTOCOL_ERROR`.
5. Response đến sau timeout: Đã hủy pending record; nếu response đến sau, đối chiếu tập completed ID và loại trừ, không corrupt state.
6. Process exit pre-init: Tiến trình con thoát trước khi handshake hoàn thành reject initialization với `CODEX_APP_SERVER_PROCESS_EXITED` hoặc `CODEX_APP_SERVER_SPAWN_FAILED`.
7. Process exit mid-request: Tiến trình con thoát khi có request đang chờ; nếu request là read-only reject với `CODEX_APP_SERVER_PROCESS_EXITED`; nếu là side-effecting reject với `CODEX_APP_SERVER_REQUEST_UNCERTAIN`.
8. Turn started nhưng response lost: Timeout sau write gán mã `CODEX_APP_SERVER_REQUEST_UNCERTAIN`, không tự động retry.
9. Review started nhưng response lost: Timeout sau write gán mã `CODEX_APP_SERVER_REQUEST_UNCERTAIN`, không tự động retry.
10. Server approval request thiếu handler: Mặc định trả về lỗi fail-closed `SERVER_REQUEST_REJECTED_FAIL_CLOSED`, không tự động phê duyệt (no auto-approval).
11. Server yêu cầu duyệt file-change: Bị từ chối fail-closed `SERVER_REQUEST_REJECTED_FAIL_CLOSED` nếu không có handler riêng.
12. Thread ID trong review response bị lệch: Inline review yêu cầu `reviewThreadId === requested threadId`; nếu khác trả về lỗi `CODEX_APP_SERVER_THREAD_MISMATCH`.
13. Wrong turn completion: Notification `turn/completed` có `turnId` hoặc `threadId` khác bị bỏ qua, không giải phóng nhầm waiter.
14. Double initialize: Gọi `initialize()` lần thứ hai trả về trạng thái hiện tại, không gửi request protocol thứ hai.
15. Double close: Gọi `close()` nhiều lần bảo đảm idempotent, an toàn, không sinh ngoại lệ.

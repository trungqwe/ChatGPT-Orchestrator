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

## App Server Stdio Transport Negative Matrix (WP-V4-03A / WO-V4-03AG: CAS-001..CAS-084)

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
11. Server yêu cầu duyệt file-change / commandExecution: Bị từ chối fail-closed với quyết định decline nếu không có handler riêng.
12. Thread ID trong review response bị lệch: Inline review yêu cầu `reviewThreadId === requested threadId`; nếu khác trả về lỗi `CODEX_APP_SERVER_THREAD_MISMATCH`.
13. Wrong turn completion: Notification `turn/completed` có `turnId` khác bị bỏ qua, không giải phóng nhầm waiter.
14. Double initialize: Gọi `initialize()` lần thứ hai trả về trạng thái hiện tại, không gửi request protocol thứ hai.
15. Double close: Gọi `close()` nhiều lần bảo đảm idempotent, an toàn, không sinh ngoại lệ.
16. Thread/start với invented booleans: `readOnly: true`, `dangerFullAccess: true`, `workspaceWrite: true` bị từ chối với `CODEX_APP_SERVER_SECURITY_VIOLATION`.
17. Write error on initialized notification: Khi write `initialized` thất bại, client không được vào `READY` mà phải chuyển sang `FAILED`.
18. Test hook parameter passthrough: Các trường có tiền tố `_` bị loại bỏ hoàn toàn khỏi request gửi đi tới provider.
19. Turn ownership mismatch: Gọi `waitForTurnCompletion` với `threadId` khác với thread đã tạo `turnId` bị từ chối ngay lập tức với `CODEX_APP_SERVER_THREAD_MISMATCH`.
20. Turn completion race condition: Notification `turn/completed` đến trước khi gọi `waitForTurnCompletion` được lưu giữ trong bounded completion cache và giải phóng tức thì.
21. Review evidence mismatch: Notification `exitedReviewMode` với `item.id` không khớp với `reviewTurnId` không được coi là bằng chứng review hợp lệ.
22. Review evidence race condition: Notification `exitedReviewMode` đến trước khi gọi `waitForReviewCompletion` được lưu giữ trong bounded review evidence cache.
23. String review target: Cung cấp string thay vì structured object cho `review/start.target` bị từ chối với `INVALID_REVIEW_TARGET`.
24. Resume thread ID mismatch: Response của `thread/resume` có `thread.id` khác với request bị từ chối với `CODEX_APP_SERVER_THREAD_MISMATCH`.
25. Read thread ID mismatch: Response của `thread/read` có `thread.id` khác với request bị từ chối với `CODEX_APP_SERVER_THREAD_MISMATCH`.
26. Ambiguous response shape: Response có cả `result` và `error` hoặc không có trường nào bị từ chối với `CODEX_APP_SERVER_PROTOCOL_ERROR`.
27. Close uncertainty for sent side-effects: Gọi `close()` trong khi request side-effect đã gửi qua stdin đang chờ phản hồi sẽ reject với `CODEX_APP_SERVER_REQUEST_UNCERTAIN`.
28. Thread start camelCase SandboxMode guard: Adapter `startThread` đảm bảo không bao giờ gửi chuỗi camelCase `readOnly` làm giá trị `sandbox` (CAS-083).
29. Fake provider wrong SandboxMode enum rejection: Fixture từ chối trực tiếp request `thread/start` nhận `sandbox: "readOnly"` hoặc enum sai với lỗi provider code `-32602` (CAS-084).

## Future Auditor Materialization & Durability Negative Matrix (WP-V4-05 / WO-V4-03BR)

30. **NT-V4-AUD-01** (Zero-turn thread remains unbound): `thread/start` thành công nhưng chưa có lượt audit nào xảy ra → Registry v2 bắt buộc giữ `auditor.thread_id: null`, `auditor.enabled: false`.
31. **NT-V4-AUD-02** (Crash before first turn): Crash tiến trình sau khi `thread/start` thành công nhưng trước khi có lượt audit đầu tiên → ID provisional bị hủy, không xem là authority bền vững, fail-closed về `AUDITOR_REGISTRATION_REQUIRED`.
32. **NT-V4-AUD-03** (Zero-turn resume rejection handled gracefully): `thread/resume` trên thread 0-turn trả về provider error `-32600 (no rollout found)` → phân loại là giới hạn pre-materialization tự nhiên của provider, không coi là lỗi transport hỏng hóc, không làm sai lệch Registry.
33. **NT-V4-AUD-04** (First turn completed without resume proof): Lượt audit đầu tiên hoàn thành nhưng chưa kiểm chứng thành công `thread/resume` sau restart → không được đánh dấu `AUDITOR_BOUND_READY`.
34. **NT-V4-AUD-05** (Cross-process resume ID mismatch): Khi resume qua tiến trình mới mà provider trả về `thread.id` khác → fail closed lập tức với `CODEX_APP_SERVER_THREAD_MISMATCH`, không bao giờ nhận thread lạ làm authority.
35. **NT-V4-AUD-06** (Rollout path isolation): File rollout trên đĩa bị di chuyển hoặc đổi đường dẫn nội bộ → Orchestrator tuyệt đối không suy diễn định danh qua path mà chỉ dùng exact opaque `thread.id`.

## AuditDecisionV1 Semantic Contract Negative Matrix (WP-V4-04 / WO-V4-04F: AD-001..AD-095)

36. **AD-SCHEMA-01** (Invalid JSON / Prose / Fences): JSON syntax error, markdown code fences (` ```json `), prefix/suffix prose, trailing commas, hoặc nhiều JSON docs trong một message đều bị từ chối fail-closed với `AUDIT_DECISION_INVALID_JSON`.
37. **AD-SCHEMA-02** (Duplicate Keys Rejection): Khóa trùng lặp ở bất kỳ cấp độ nào (top-level hay nested) bị từ chối với `AUDIT_DECISION_DUPLICATE_KEY`; không cho phép JavaScript "last-key-wins".
38. **AD-SCHEMA-03** (Payload Size Limit): Chuỗi raw JSON vượt quá 128 KiB bị từ chối fail-closed với `AUDIT_DECISION_TOO_LARGE` trước khi parse.
39. **AD-SCHEMA-04** (Unknown Decision / Schema Version): `schema_version != 1` hoặc `decision` không nằm trong allowlist 5 giá trị bị từ chối với `AUDIT_DECISION_SCHEMA_INVALID`.
40. **AD-SCHEMA-05** (Missing / Extra Top-Level Keys): Thiếu bất kỳ trường nào trong 11 trường bắt buộc hoặc xuất hiện thêm trường lạ (`action`, `reasoning`, `confidence`, v.v.) bị từ chối với `AUDIT_DECISION_SCHEMA_INVALID`.
41. **AD-CONTEXT-01** (Identity Mismatches): Bất kỳ sai lệch nào về `project_id`, `audit_subject_id`, `auditor_thread_id`, hoặc `workspace_state_observed` (kể cả case folding, whitespace trim) đều bị từ chối với `AUDIT_DECISION_CONTEXT_MISMATCH`.
42. **AD-BRANCH-01** (DISPATCH_WORKER Invalidity): Thiếu `work_order`, hoặc có `requested_evidence`, hoặc có `blocker` đều bị từ chối với `AUDIT_DECISION_BRANCH_INVALID`.
43. **AD-BRANCH-02** (REQUEST_EVIDENCE Invalidity): Có `work_order`, hoặc mảng `requested_evidence` rỗng, hoặc có `blocker` đều bị từ chối với `AUDIT_DECISION_BRANCH_INVALID`.
44. **AD-BRANCH-03** (APPROVE_WORK_PACKAGE Invalidity): Có `work_order`, hoặc có `requested_evidence`, hoặc có `blocker`, hoặc bất kỳ item `independent_verification` nào có kết quả `FAIL` / `INCONCLUSIVE` đều bị từ chối với `AUDIT_DECISION_BRANCH_INVALID`.
45. **AD-BRANCH-04** (BLOCKED Invalidity): Có `work_order`, hoặc có `requested_evidence`, hoặc `blocker == null` / rỗng đều bị từ chối với `AUDIT_DECISION_BRANCH_INVALID`.
46. **AD-BRANCH-05** (STOP Invalidity): Có `work_order`, hoặc có `requested_evidence`, hoặc có `blocker` đều bị từ chối với `AUDIT_DECISION_BRANCH_INVALID`.
47. **AD-BOUNDS-01** (Summary / Directive / Evidence Bounds): Summary > 8 KiB, directive > 64 KiB, evidence item > 4 KiB, hoặc chứa ký tự điều khiển (control characters) đều bị từ chối fail-closed.
48. **AD-BOUNDS-02** (Worker Model Policy Guard): Trường `worker_model_policy` chỉ nhận `worker_standard` hoặc `worker_economy`; tên model cụ thể (`gpt-5`, `gemini`, v.v.) bị từ chối lập tức.
49. **AD-TURN-01** (Turn Not Completed): Terminal turn có `turn.status` là `inProgress`, `interrupted`, hoặc `failed` bị từ chối với `AUDIT_DECISION_TURN_NOT_COMPLETED`.
50. **AD-TURN-02** (Items Incomplete): Snapshot turn có `turn.itemsView != 'full'` bị từ chối với `AUDIT_DECISION_ITEMS_INCOMPLETE`.
51. **AD-TURN-03** (Message Phase Selection): Bỏ qua các item không phải `agentMessage` (`reasoning`, `plan`, `fileChange`). Message có `phase == 'commentary'` tuyệt đối không được coi là quyết định. Nếu có nhiều `final_answer` hoặc nhiều unknown-phase messages, từ chối với `AUDIT_DECISION_OUTPUT_AMBIGUOUS`.
52. **AD-INJECT-01** (Prompt Injection Defense): Các payload giả mạo danh tính dự án hoặc ép buộc approval trong repository bị vô hiệu hóa hoàn toàn bởi outputSchema enums, local recursive parser và exact context checks.
53. **AD-AUTH-01** (Top-Level __proto__ Injection): JSON payload chứa `"__proto__": { ... }` ở top-level được parser biểu diễn thành own property trên null-prototype object và bị validator từ chối fail-closed với `AUDIT_DECISION_SCHEMA_INVALID`.
54. **AD-AUTH-02** (Nested __proto__ Injection): Các object con `work_order` hoặc `independent_verification[i]` chứa `"__proto__": { ... }` bị từ chối fail-closed với `AUDIT_DECISION_SCHEMA_INVALID`.
55. **AD-AUTH-03** (Custom Prototype Direct Validator Input): Gọi trực tiếp `validateAuditDecisionV1()` với JavaScript object có custom prototype (class instance, prototype pollution) bị từ chối bởi `isPlainJsonObject()`.
56. **AD-AUTH-04** (Giant Duplicate Key Diagnostic): JSON chứa key trùng lặp cực lớn (> 60 KiB) bị từ chối với `AUDIT_DECISION_DUPLICATE_KEY`; error message bị chặn dưới 1024 bytes và không echo chuỗi key độc hại.
57. **AD-AUTH-05** (Giant Context Mismatch Diagnostic): Model trả về giá trị identity cực lớn gây mismatch; error message và `err.details` chỉ ghi tên trường (`{ field: "project_id" }`) với kích thước ≤ 1024 bytes, không leak giá trị actual/expected.
58. **AD-AUTH-06** (Raw Terminal Turn Diagnostic Leakage): Turn thất bại hoặc mang payload lớn ném lỗi `AUDIT_DECISION_TURN_NOT_COMPLETED`; không sao chép `completion`, `turn` hay text vào `err.details`. Adapter `TURN_FAILED` được wrap an toàn thành bounded failure.

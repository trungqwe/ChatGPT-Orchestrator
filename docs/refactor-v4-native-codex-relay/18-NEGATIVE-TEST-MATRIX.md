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
59. **AD-AUTH-07** (Inherited Required Field Rejection): Trường bắt buộc (`blocker`, `decision`, `workspace_state_observed`, v.v.) không tồn tại như own property trên decision mà kế thừa từ `Object.prototype` bị từ chối fail-closed với `AUDIT_DECISION_SCHEMA_INVALID` (AD-096, AD-097, AD-098).
60. **AD-AUTH-08** (Inherited Context Identity Rejection): Expected context thiếu trường định danh tin cậy (`auditor_thread_id`) nhưng kế thừa từ `Object.prototype` bị từ chối với `AUDIT_DECISION_CONTEXT_MISMATCH` (AD-099).
61. **AD-AUTH-09** (Symbol Property Rejection): Decision object chứa own symbol property bị `inspectPlainJsonDataObject` từ chối fail-closed với `AUDIT_DECISION_SCHEMA_INVALID` (AD-100).
62. **AD-AUTH-10** (Non-Enumerable Hidden Property Rejection): Thuộc tính bị ẩn bằng `enumerable: false` bị phát hiện và từ chối với `AUDIT_DECISION_SCHEMA_INVALID` (AD-101, AD-106).
63. **AD-AUTH-11** (Accessor Authority Rejection Without Invocation): Thuộc tính được định nghĩa là getter (`get decision()`) bị từ chối với `AUDIT_DECISION_SCHEMA_INVALID`; descriptor được kiểm tra trước khi đọc giá trị, đảm bảo getter không bị kích hoạt (getterCounter == 0) (AD-102).
64. **AD-AUTH-12** (Nested Object Authority Rules): Áp dụng cùng luật own data property cho `work_order` và `independent_verification[i]`; kế thừa hoặc accessor trên trường con đều bị từ chối không kích hoạt getter (AD-103, AD-104).
65. **AD-AUTH-13** (Object.prototype Pollution Resilience): Khi `Object.prototype` bị ô nhiễm bởi các thuộc tính lạ, decision hợp lệ vẫn validate thành công và đóng băng sâu độc lập, không bị ảnh hưởng hay sao chép thuộc tính lạ vào kết quả (AD-105).
66. **AD-AUTH-14** (Nested Symbol Rejection): Ký hiệu symbol trên `work_order` hoặc item `independent_verification` bị từ chối với `AUDIT_DECISION_SCHEMA_INVALID` (AD-107, AD-108).
67. **AD-AUTH-15** (Custom Prototype ExpectedContext): ExpectedContext có custom prototype bị từ chối với `AUDIT_DECISION_CONTEXT_MISMATCH` (AD-109).
68. **AD-AUTH-16** (Accessor on ExpectedContext): Thuộc tính định danh trong ExpectedContext được khai báo dạng getter bị từ chối với `AUDIT_DECISION_CONTEXT_MISMATCH` mà không kích hoạt getter (AD-110).

## Auditor Recovery Store Negative Matrix (WP-V4-05A: ARS-001..ARS-038)

69. **ARS-ISOL-01** (Single Active Bootstrap Per Project): Cố tình tạo bootstrap thứ hai cho cùng `project_id` bị từ chối với `AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT` (ARS-003).
70. **ARS-ISOL-02** (Duplicate Operation ID Across Projects): Trùng `operation_id` giữa hai dự án bị SQLite unique constraint từ chối với `AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT` (ARS-005).
71. **ARS-BOUND-01** (Thread / Operation ID Bounds): Thread ID hoặc Operation ID rỗng, chứa ký tự điều khiển, chứa whitespace đầu/cuối, hoặc vượt quá 512 bytes bị từ chối với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-006, ARS-007).
72. **ARS-TRANS-01** (Illegal State Transitions): Nhảy cóc trạng thái (ví dụ `PROVISIONAL_THREAD` $\to$ `DECISION_VALIDATED` hoặc `DURABLE_BOUND`) bị từ chối với `AUDITOR_RECOVERY_TRANSITION_INVALID` (ARS-010).
73. **ARS-TRANS-02** (Operation ID Mismatch in Transition): Chuyển trạng thái với `operation_id` khác với bản ghi active bootstrap bị từ chối với `AUDITOR_RECOVERY_OPERATION_MISMATCH` (ARS-011).
74. **ARS-TRANS-03** (Transition Unknown Project): Chuyển trạng thái trên dự án không có bootstrap nào bị từ chối với `AUDITOR_RECOVERY_NOT_FOUND` (ARS-012).
75. **ARS-AUTH-01** (Context Mismatched Decision Storage): Lưu `decision_json` có ngữ cảnh lệch với `project_id`, `audit_subject_id`, `auditor_thread_id`, hoặc `workspace_state_observed` bị từ chối tại cửa ngõ transition với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-014).
76. **ARS-AUTH-02** (SHA-256 Mismatched Decision Storage): Hash SHA-256 cung cấp không khớp với hash tính toán trên chuỗi byte `decision_json` bị từ chối với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-015).
77. **ARS-REOPEN-01** (Corrupt Persisted Decision Hash): Reopen DB mà hash trong bản ghi khác với hash thực của chuỗi byte JSON lập tức fail-closed với `AUDITOR_RECOVERY_CORRUPT` (ARS-021).
78. **ARS-REOPEN-02** (Corrupt Persisted Decision JSON): Reopen DB mà `decision_json` bị hỏng cấu trúc JSON hoặc vi phạm schema lập tức fail-closed với `AUDITOR_RECOVERY_CORRUPT` (ARS-022).
79. **ARS-REOPEN-03** (Unrecognized / Illegal Persisted State): Reopen DB mà cột `state` chứa giá trị lạ không nằm trong enum hợp lệ lập tức fail-closed với `AUDITOR_RECOVERY_CORRUPT` (ARS-023).
80. **ARS-REOPEN-04** (History Disagreement With Active Bootstrap): Reopen DB mà trạng thái của active bootstrap không khớp với bản ghi history mới nhất fail-closed với `AUDITOR_RECOVERY_CORRUPT` (ARS-024).
81. **ARS-SCHEMA-01** (Unsupported User Version): `PRAGMA user_version` khác 1 bị từ chối với `AUDITOR_RECOVERY_SCHEMA_MISMATCH` (ARS-025).
82. **ARS-SCHEMA-02** (Zero User Version on Existing Tables): DB có bảng nhưng version = 0 bị từ chối với `AUDITOR_RECOVERY_CORRUPT` (ARS-026).
83. **ARS-SCHEMA-03** (Missing Table or Column): Thiếu bảng hoặc cột bắt buộc bị từ chối với `AUDITOR_RECOVERY_SCHEMA_MISMATCH` (ARS-027).
84. **ARS-BOUNDS-01** (Decision Payload Size Limit): Chuỗi JSON quyết định vượt quá 128 KiB (131,072 bytes) bị từ chối với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-035).
85. **ARS-UNCERTAIN-01** (Trap State Immutability): Không cho phép bất kỳ phép chuyển trạng thái nào thoát ra khỏi `AUDIT_UNCERTAIN` (ARS-034).

## Auditor Thread Lifecycle Negative Matrix (WP-V4-05A: ATL-001..ATL-045)

86. **ATL-PRE-01** (Missing Project in Registry): Bootstrap dự án chưa đăng ký trong Registry v2 ném lỗi `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (ATL-002).
87. **ATL-PRE-02** (Already Bound and Enabled Project): Bootstrap dự án đã có `thread_id != null` và `enabled: true` ném lỗi `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (ATL-003).
88. **ATL-PRE-03** (Bound But Disabled Project): Dự án có `thread_id != null` nhưng `enabled: false` ném lỗi `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (ATL-004).
89. **ATL-PRE-04** (Active Bootstrap In Flight): Gọi bootstrap khi dự án đang có active bootstrap khác ném lỗi `AUDITOR_LIFECYCLE_BOOTSTRAP_IN_PROGRESS` (ATL-005, ATL-028).
90. **ATL-START-01** (Thread Start Failure): Client 1 `startThread()` thất bại ném lỗi mà không tạo bất kỳ bản ghi bootstrap nào trong recovery DB (ATL-007).
91. **ATL-TURN-01** (Turn Start Failure Uncertainty): `startTurn()` thất bại hoặc văng lỗi đưa trạng thái vòng đời vào `AUDIT_UNCERTAIN`, bảo đảm không tự resend (ATL-008).
92. **ATL-VALID-01** (Decision Validation Failure Uncertainty): Turn trả về quyết định sai ngữ cảnh hoặc sai schema đưa trạng thái vòng đời vào `AUDIT_UNCERTAIN` (ATL-009).
93. **ATL-RESUME-01** (Second Process Resume Failure Gate): Client 2 `resumeThread()` thất bại (do unmaterialized hoặc provider crash) dừng ngay vòng đời, tuyệt đối không gọi `registry.bindAuditorThread` (ATL-010).
94. **ATL-RESUME-02** (Cross-Process Thread ID Mismatch): Client 2 trả về `threadId` khác với client 1 dừng ngay vòng đời trước khi bind Registry (ATL-011).
95. **ATL-BIND-01** (Registry Binding Conflict): Registry ném `AUDITOR_BINDING_CONFLICT` dừng ngay vòng đời và báo lỗi (ATL-012).
96. **ATL-ISOL-01** (Provisional Registry Isolation): Qua các bước 1..4 (provisional, starting, in-flight, validated), Registry v2 luôn được chứng minh giữ nguyên `thread_id: null` và `enabled: false` (ATL-014).
97. **ATL-REC-01** (Provisional Recovery Cleans Store): Phục hồi từ `PROVISIONAL_THREAD` xóa sạch active record và giữ Registry unbound (ATL-016).
98. **ATL-REC-02** (In-Flight Recovery Preserves Uncertainty): Phục hồi từ `FIRST_TURN_STARTING` hoặc `FIRST_TURN_IN_FLIGHT` chuyển/giữ nguyên `AUDIT_UNCERTAIN` và cấm tuyệt đối auto-resend (ATL-017, ATL-018, ATL-019).

## Atomic Registry Binding Negative Matrix (WP-V4-05A: RG-040..RG-049)

99. **RG-BIND-01** (Unknown Project Binding): `bindAuditorThread` trên projectId không tồn tại ném `AUDITOR_BINDING_PRECONDITION_FAILED` (RG-041).
100. **RG-BIND-02** (Invalid Thread ID Formats): Thread ID rỗng, chứa newline, spaces, hoặc vượt quá 512 bytes ném `AUDITOR_BINDING_PRECONDITION_FAILED` (RG-042, RG-043, RG-044).
101. **RG-BIND-03** (Conflicting Thread ID Rejection): Dự án đã bind thread `th-existing` cố bind thread `th-different` ném lỗi `AUDITOR_BINDING_CONFLICT` mà không ghi đè Registry (RG-045).
102. **RG-BIND-04** (Disabled-Bound State Preservation): Gọi `bindAuditorThread` với cùng thread ID trên project đang `enabled: false` giữ nguyên `enabled: false` (RG-047).
103. **RG-BIND-05** (Atomic Rename Resilience & Write-Lock): `bindAuditorThread` chạy trong hàng đợi `serializeMutation()`, đảm bảo an toàn đồng thời tuyệt đối giữa các tiến trình/luồng (RG-049).

## Auditor Durability Authority Final Seal Negative Matrix (WP-V4-05AF: ARS-039..051, ATL-048..060, RG-050..055)

104. **ARS-PATCH-01** (Top-Level Key Reject): Truyền `turn_id` hoặc decision fields ở top-level của `transitionState` bị từ chối với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-039, ARS-040).
105. **ARS-PATCH-02** (Patch Key Allowlist): Truyền key không thuộc `{ turn_id, decision_json, decision_sha256 }` trong `patch` bị từ chối với `AUDITOR_RECOVERY_INVALID_REQUEST` (ARS-041).
106. **ARS-PATCH-03** (State-Specific Patch Rules): `STARTING` không cho patch, `IN_FLIGHT` bắt buộc `turn_id`, `DECISION_VALIDATED` bắt buộc `decision_json` (ARS-042, ARS-043, ARS-044, ARS-045).
107. **ARS-REOPEN-05** (Corrupt In-Flight Reopen): Reopen khi `FIRST_TURN_IN_FLIGHT` có `turn_id == null` ném `AUDITOR_RECOVERY_CORRUPT` (ARS-046).
108. **ARS-REOPEN-06** (Corrupt Decision Reopen): Reopen khi `DECISION_VALIDATED` thiếu decision fields ném `AUDITOR_RECOVERY_CORRUPT` (ARS-047).
109. **ARS-HIST-01** (Broken History Chain): Lịch sử chuyển trạng thái bị xáo trộn hoặc sai previous_state ném `AUDITOR_RECOVERY_CORRUPT` (ARS-048).
110. **ARS-BOUNDS-01** (Persisted Control Character): Ký tự điều khiển trong ID đã lưu bị từ chối khi mở DB (ARS-049).
111. **ARS-SCHEMA-04** (Schema Drift Rogue Column): Cột lạ trong bảng authority bị từ chối fail-closed (ARS-050).
112. **ARS-INTEG-01** (Physical PRAGMA integrity_check Failure): DB hỏng vật lý ném `AUDITOR_RECOVERY_CORRUPT` (ARS-051).
113. **ATL-WS-01** (Missing Workspace Port): Thiếu `workspacePort` bị từ chối trước khi gọi adapter (ATL-048).
114. **ATL-WS-02** (Invalid Workspace Snapshot): Trả về string, null, sai projectId, sai projectRoot, hoặc rỗng workspace_state_id đều ném `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (ATL-049..ATL-053).
115. **ATL-INP-01** (Missing First-Turn Input): Thiếu hoặc rỗng `auditSubjectId` / `auditPrompt` bị từ chối trước khi tạo thread (ATL-054..ATL-057).
116. **ATL-REC-03** (Corrupt Decision Authority Recovery): Phục hồi từ `DECISION_VALIDATED` nhưng thiếu turn_id/decision ném `AUDITOR_RECOVERY_CORRUPT` (ATL-058..ATL-060).
117. **RG-BIND-06** (Mandatory expected_project_root & Runtime Drift): Thiếu expected root hoặc root bị thay đổi canonical identity trên filesystem bị từ chối với `AUDITOR_BINDING_PRECONDITION_FAILED` (RG-050..RG-054).

## Model Policy Resolution & Catalog Authority Negative Matrix (WP-V4-06A & R1: MPR-001..MPR-021, CAS-085..CAS-096, ATL-123..ATL-133)

118. **MPR-POL-01** (Worker Policy Out of Scope Rejection): Truyền `worker_economy` hoặc `worker_standard` vào resolver ném lỗi `MODEL_POLICY_INVALID_REQUEST` fail-closed (MPR-009).
119. **MPR-POL-02** (Unsupported Policy Rejection): Truyền policy không thuộc danh sách cho phép (`auditor_fast`, `auditor_standard`, `auditor_deep`, `architecture_deep`) ném `MODEL_POLICY_INVALID_REQUEST` (MPR-008).
120. **MPR-CAT-01** (Catalog Entry Validation): Catalog không phải array, model entry không phải object, thiếu `id` hoặc `model`, hoặc `supportedReasoningEfforts` không phải array hợp lệ ném `MODEL_POLICY_CATALOG_INVALID` (MPR-012, MPR-013, MPR-014, MPR-015).
121. **MPR-CAT-02** (Multiple Default Models Rejected): Nhiều hơn 1 model trong catalog có `isDefault === true` ném `MODEL_POLICY_CATALOG_INVALID` fail-closed do catalog không xác định rõ ràng model mặc định (MPR-004).
122. **MPR-CAT-03** (Duplicate Model Selectors Rejected): Catalog có hai model trùng lặp trường `model` ném `MODEL_POLICY_CATALOG_INVALID` fail-closed thay vì phụ thuộc vào thứ tự duyệt (MPR-017).
123. **MPR-UNAVAIL-01** (Empty Catalog or All Hidden): Catalog rỗng hoặc toàn bộ model đều có `hidden: true` ném `MODEL_POLICY_UNAVAILABLE` (MPR-010, MPR-011).
124. **MPR-UNAVAIL-02** (Default Effort Not Advertised / Unsupported Effort): Default effort của model mặc định không nằm trong `supportedReasoningEfforts`, hoặc không có model nào hỗ trợ reasoning effort mong muốn ném `MODEL_POLICY_UNAVAILABLE` (MPR-016, MPR-018).
125. **CAS-PAG-01** (Catalog Pagination Cycle & Repeated Cursor): Cursor lặp lại trong quá trình phân trang bị từ chối fail-closed với `CODEX_APP_SERVER_PROTOCOL_ERROR` (CAS-088).
126. **CAS-PAG-02** (Malformed Cursor Rejection): `nextCursor` không phải string hoặc là chuỗi rỗng / chứa control characters ném `CODEX_APP_SERVER_PROTOCOL_ERROR` (CAS-089).
127. **CAS-PAG-03** (Catalog Safety Bounds Enforcement): Số lượng model vượt quá `MAX_MODEL_CATALOG_ENTRIES = 1000` hoặc cursor byte vượt quá `MAX_CURSOR_BYTES = 512` bị từ chối fail-closed với `CODEX_APP_SERVER_PROTOCOL_LIMIT` (CAS-090).
128. **CAS-PAG-04** (Exact 50 Pages Terminal Success): Catalog chứa đúng 50 trang và kết thúc ở trang 50 (`nextCursor === null`) được hoàn tất thành công với đúng 50 provider calls (CAS-095).
129. **CAS-PAG-05** (Page 51 Required Fails Closed Without Call): Trang 50 vẫn trả về `nextCursor` không rỗng bị từ chối fail-closed với `CODEX_APP_SERVER_INVALID_RESPONSE` mà không phát sinh request trang 51 (CAS-096).
130. **CAS-TURN-01** (Local Validation for Turn Model and Effort): `startTurn()` nhận model hoặc effort không phải non-empty string hoặc chứa control characters ném `CODEX_APP_SERVER_INVALID_REQUEST` tại client mà không gửi request sang server (CAS-093, CAS-094).
131. **ATL-FAIL-01** (Catalog Failure Leaves Provisional State & 0 Turns): `model/list` thất bại trong bootstrap ném lỗi, không gọi `startTurn`, không ghi `FIRST_TURN_STARTING`, giữ trạng thái recovery ở `PROVISIONAL_THREAD`, và đóng client 1 (ATL-125).
132. **ATL-FAIL-02** (Model Policy Unavailable Leaves Provisional State & 0 Turns): Resolver ném `MODEL_POLICY_UNAVAILABLE` giữ nguyên trạng thái recovery ở `PROVISIONAL_THREAD`, 0 turns, và Registry unbound (ATL-126).
133. **ATL-ORDER-01** (Resolution Sequence Invariants): `model/list` bắt buộc xảy ra sau fresh Registry read (Gate A) và trước khi chuyển sang `FIRST_TURN_STARTING` (ATL-123, ATL-124).
134. **ATL-REC-04** (Zero Catalog Resolution During Recovery): `recoverAuditorBootstrap` và `resolveAuditorBootstrapUncertainty` tuyệt đối không gọi `model/list` (ATL-129).
135. **ATL-GATEB-01** (Policy Drift During Model/List Detected at Gate B): Policy trong Registry bị thay đổi trong lúc gọi `model/list` bị Gate B phát hiện và từ chối với `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`, 0 `startTurn`, không ghi `FIRST_TURN_STARTING`, giữ `PROVISIONAL_THREAD`, đóng client 1 (ATL-130).
136. **ATL-GATEB-02** (Binding Drift During Model/List Detected at Gate B): Auditor trở thành bound trong lúc gọi `model/list` bị Gate B từ chối trước `FIRST_TURN_STARTING`, 0 `startTurn`, giữ `PROVISIONAL_THREAD`, không ghi đè binding (ATL-131).
137. **ATL-GATEB-03** (Post-Resolution Registry Read Failure at Gate B): `getProject` tại Gate B ném lỗi bị từ chối trước `startTurn`, không ghi `FIRST_TURN_STARTING` hay `AUDIT_UNCERTAIN`, giữ `PROVISIONAL_THREAD`, đóng client 1 (ATL-132).
138. **ATL-ORDER-02** (Exact End-to-End Success Order): Chứng minh thứ tự thực thi chuẩn: Gate A < `listModels` < Model Resolution < Gate B < `FIRST_TURN_STARTING` < `startTurn`, bảo đảm chuyển thành công sang `DURABLE_BOUND` với exact pinned model và effort (ATL-133).

## Token Usage Observability & Turn Correlation Negative Matrix (WP-V4-06B & R1: TUO-001..TUO-027, CAS-097..CAS-105)

139. **TUO-CNT-01** (Negative Counter Rejection): Bất kỳ counter nào trong `total` hoặc `last` có giá trị âm bị từ chối với `TOKEN_USAGE_INVALID_COUNTER` (TUO-006).
140. **TUO-CNT-02** (Fractional / Non-Integer Counter Rejection): Counter dạng float / số thập phân bị từ chối với `TOKEN_USAGE_INVALID_COUNTER` (TUO-007).
141. **TUO-CNT-03** (Unsafe Integer Counter Rejection): Counter vượt quá `Number.MAX_SAFE_INTEGER` bị từ chối fail-closed với `TOKEN_USAGE_INVALID_COUNTER` (TUO-008).
142. **TUO-NOTIF-01** (Missing Breakdown or Counter Rejection): Thiếu breakdown `total` hoặc `last`, hoặc thiếu bất kỳ counter nào trong 6 counter chuẩn bị từ chối với `TOKEN_USAGE_INVALID_NOTIFICATION` (TUO-009, TUO-010).
143. **TUO-ID-01** (Invalid ThreadId / TurnId Rejection & UTF-8 Byte Bound & Whitespace): `threadId` hoặc `turnId` không phải string, rỗng, chứa surrounding whitespace (`id.trim() !== id`), vượt quá 256 UTF-8 bytes (`Buffer.byteLength(id, 'utf8') > 256`), hoặc chứa control characters bị từ chối fail-closed với `TOKEN_USAGE_INVALID_NOTIFICATION` mà không tự động trim (TUO-011, TUO-012, TUO-026, TUO-027).
144. **TUO-MCW-01** (Required-But-Nullable ModelContextWindow Rejection): `modelContextWindow` bắt buộc phải là own-property hiện diện; thiếu hoặc mang giá trị `undefined` ném `TOKEN_USAGE_INVALID_NOTIFICATION` (`missing != null`). Nếu có mặt, giá trị không phải `null` hoặc không phải số nguyên không âm an toàn bị từ chối với `TOKEN_USAGE_INVALID_COUNTER` (TUO-023, TUO-024, TUO-025).
145. **TUO-IMMUT-01** (Input / Output Immutability & Detachment): Mutate object đầu vào sau `record()` hoặc mutate kết quả getter không làm biến dạng dữ liệu lưu trữ nội bộ của observer (TUO-013, TUO-014, CAS-104).
146. **TUO-NOACCUM-01** (Snapshot Replacement Without Summation): Các notification lặp lại cho cùng một thread/turn thay thế snapshot cũ chứ tuyệt đối không cộng dồn (TUO-015, TUO-016, TUO-017, CAS-100).
147. **TUO-BOUND-01** (Bounded Storage Eviction): Vượt quá bound `maxThreads` (1024) hoặc `maxTurns` (4096) thực hiện eviction tất định theo thứ tự insertion cũ nhất (TUO-018, TUO-019).
148. **TUO-LOOKUP-01** (No Cross-Thread Fallback): Lookup snapshot theo thread hoặc turn không bao giờ fallback sang thread khác khi không tìm thấy (TUO-020, TUO-021, CAS-098, CAS-099).
149. **CAS-USAGE-01** (Malformed Usage Non-Poisoning): Notification usage malformed bị loại bỏ khỏi observability state mà không làm chết transport hoặc làm gián đoạn audit turn (CAS-101).
150. **CAS-USAGE-02** (Thread Ownership Mismatch Rejection): Notification cho `turnId` có `threadId` sai lệch so với local turn ownership bị từ chối với `TOKEN_USAGE_THREAD_MISMATCH` và không ghi đè dữ liệu hợp lệ (CAS-102).
151. **CAS-USAGE-03** (Early Notification Race Reconciliation): Notification đến trước khi response của `turn/start` thiết lập local ownership được lưu tạm vào pending cache và chỉ trở thành dữ liệu hợp lệ sau khi ownership được xác nhận khớp (CAS-103).
152. **CAS-USAGE-04** (Missing ModelContextWindow Isolated Non-Poisoning): Notification usage chứa counters hợp lệ nhưng thiếu trường `modelContextWindow` bị từ chối fail-closed với `TOKEN_USAGE_INVALID_NOTIFICATION` và emit sự kiện `token_usage_error`, trong khi turn audit hoàn tất bình thường, getters trả về `null`, và transport vẫn hoàn toàn khả dụng cho các request kế tiếp (CAS-105).

## Worker Delivery Acknowledgement & Provenance Negative Matrix (WP-V4-09C / WO-V4-09C-D1: ACK-001..ACK-012)

153. **ACK-NOBOUND-01** (AO Exit 0 With Boundary Absent): Tiến trình `ao send` thoát với mã 0 nhưng không xuất hiện dispatch boundary hợp lệ trong transcript khi hết hạn acknowledgement window (30s) → Adapter trả về lỗi non-definitive, Broker chuyển lifecycle sang `DISPATCH_UNCERTAIN`, số lần gọi AO send = 1, tuyệt đối không tự động gửi lại (no resend) (ACK-02).
154. **ACK-UNAVAIL-01** (Post-Send Transcript Unavailable): Sau khi `ao send` đã gọi, việc đọc/scan transcript bị lỗi (ENOENT, quyền truy cập, stream error) → Adapter trả về non-definitive error, Broker chuyển lifecycle sang `DISPATCH_UNCERTAIN`, AO send count = 1, không retry (ACK-03).
155. **ACK-DRIFT-01** (Post-Send Transcript Mapping Drift): Canonical path của transcript bị thay đổi giữa lúc send và lúc quan sát acknowledgement → Phân loại là mapping drift bất thường, Adapter trả về non-definitive error, Broker chuyển lifecycle sang `DISPATCH_UNCERTAIN`, AO send count = 1, không retry (ACK-04).
156. **ACK-DUP-01** (Duplicate Authoritative Boundary Detected): Phát hiện nhiều hơn 1 record mang exact dispatch boundary cho cùng một dispatch trong transcript → Báo động provenance bất thường, trả về non-definitive error, Broker chuyển `DISPATCH_UNCERTAIN`, không chọn ngẫu nhiên một record, không resend (ACK-05).
157. **ACK-IDENTITY-01** (Contradictory Dispatch Boundary Identity): Record mang đúng dispatch_id nhưng sai lệch `expected_workspace_state_id`, `work_order_id`, hoặc `project_id` → Trả về non-definitive failure, Broker chuyển `DISPATCH_UNCERTAIN`, không resend (ACK-06).
158. **ACK-WAIT-01** (Wait Cannot Re-Observe Proven Boundary - WA-008 Retired): Khi `workerPort.wait()` được gọi trên dispatch đã ở trạng thái `DISPATCH_ACCEPTED` mà không tìm thấy dispatch boundary đã được công nhận trước đó trong snapshot transcript → Báo động vi phạm provenance, trả về `PROVENANCE_AMBIGUOUS` (loại bỏ hoàn toàn quy ước WA-008 cũ trả về `DISPATCH_ACCEPTED`), Broker chuyển lifecycle sang `PROVENANCE_AMBIGUOUS` (ACK-12).
159. **ACK-RESEND-01** (Zero AO Resend In All Uncertainty Paths): Trong tất cả các nhánh thất bại sau send (boundary absent, scan failure, mapping drift, duplicate boundary, timeout), số lần gọi subprocess spawn `ao send` luôn luôn được chặn cứng ở đúng 1 lần duy nhất (ACK-07).

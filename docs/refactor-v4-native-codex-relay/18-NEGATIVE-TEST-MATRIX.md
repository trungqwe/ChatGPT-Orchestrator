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

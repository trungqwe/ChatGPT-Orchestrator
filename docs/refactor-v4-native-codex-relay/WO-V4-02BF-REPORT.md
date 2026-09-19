# 1. Baseline

Parent `a46ab32dc513ef43416c2e5f1503e2b8d09edcfb` trên nhánh `review/v4-wp02b-registry-v2`. Registry v2, migration explicit, backup và chín suite mặc định đã có. WO này chỉ đóng lỗ hổng chứng minh identity của file nguồn migration.

# 2. RV2AUTH-01 Root Cause

Reader cũ chỉ so `dev`/`ino` khi `before.ino && opened.ino` hoặc `opened.ino && after.ino` có giá trị truthy. `undefined`, `null` và `0` có thể tắt phép so, khiến byte từ nguồn chưa chứng minh identity vẫn thành migration authority.

# 3. Mandatory File Identity Contract

Helper thuần `sameMigrationFileIdentity(a, b)` chỉ trả true khi cả hai stats là regular file, `dev`/`ino` đều không null và bằng nhau theo so sánh chính xác. Pathname snapshots còn phải không là symlink. Không fallback sang path, size, mtime, realpath hay hash. Identity không chứng minh được được phân loại `REGISTRY_CORRUPT`.

# 4. Pre / FD / Post Verification

Mỗi lần `readMigrationSource` dùng `lstat(path)` → `open` → `fstat(fd)` → đọc byte → `lstat(path)`. Gate pre/fd chạy **trước khi đọc**; gate fd/post chạy **sau khi đọc nhưng trước khi hash/trả byte**. Cùng hàm này được dùng trong preview, apply ban đầu, apply pre-rename và post-write verification.

# 5. Falsey Identity Handling

`dev == null` và `ino == null` bắt cả `null`/`undefined`; numeric `0` vẫn là identity hợp lệ phải so sánh. RV2-051 inject pre `dev=0, ino=0` và fd `dev=0, ino=1` để xác nhận mismatch bị từ chối.

# 6. Apply Pre-Rename Revalidation

Sau khi backup byte-exact và candidate temp được ghi, apply đọc lại nguồn qua cùng gate. `REGISTRY_CORRUPT` từ lần đọc này được giữ nguyên thay vì gộp thành persist failure. Temp được dọn, không rename v2, target vẫn chứa byte v1.

# 7. Negative Test Evidence

RV2-046..RV2-052 kiểm tra pre/fd/post identity thiếu, hai hướng mismatch, giá trị zero, và apply pre-rename failure. RV2-052 chứng minh cả backup lẫn candidate temp đã được ghi, rename count bằng 0, target v1 byte-exact, backup còn lại byte-exact. Tổng migration suite: RV2-001..RV2-052, 52/52 pass.

# 8. Full Regression Evidence

Local test evidence: `npm test` gồm chín suite deterministic; chạy từng suite độc lập gồm Registry 39/39, migration 52/52, CLI 50/50, SQLite lifecycle 47/47, broker 52/52, worker adapter 55/55, workspace state 51/51, quarantine và native transition. Kết quả exit code cuối được đối chiếu trước commit. Đây không phải bằng chứng GitHub CI; WO này không chạy GitHub CI.

# 9. Target / Backup Mutation Semantics

Lỗi identity trong preview hoặc apply initial read: không backup, không target write. Lỗi trong pre-rename re-read: backup an toàn có thể còn lại, nhưng target v1 không đổi và không có v2 replacement. Backup còn lại là vật liệu phục hồi/chẩn đoán, không phải target mutation.

# 10. Scope Compliance

- Registry v2 semantics changed: **ONLY FILE IDENTITY HARDENING**.
- Broker production modified: **NO**.
- Worker production modified: **NO**.
- Runtime modified: **NO**.
- Migration CLI modified: **NO**.
- Real Registry migrated: **NO**.
- Real default Registry read for migration: **NO**.
- Real default Registry modified: **NO**.
- Real Codex invocation: **NO**.
- Real worker dispatch: **NO**.
- WP-V4-03 started: **NO**.

# 11. Recommendation

External review nên kiểm tra helper identity và RV2-046..052. Sau khi được duyệt, tiếp tục quy trình migration Registry thật theo runbook; không bắt đầu WP-V4-03 trong WO này.

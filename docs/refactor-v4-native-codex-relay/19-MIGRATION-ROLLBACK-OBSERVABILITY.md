# Migration, rollback và observability

Thứ tự: docs → registry → Codex adapter → decision → one-shot → shadow → live → cleanup. Registry migration có backup/dry-run. Modes: `legacy`, `native_shadow`, `native_one_shot`, `native_bounded`; không dual authority.

Bridge binary/submodule đã được operator gỡ trước native implementation. Rollback không được khôi phục Web override vào config Codex. Trong giai đoạn chuyển tiếp, legacy UI/API phải trả lỗi migration rõ ràng; sau native cutover, rollback dùng Git tag/release artifact của native path.

Registry v1→v2: `preview` không ghi; `apply` kiểm tra lại SHA-256 của **byte nguồn**, tạo backup `.v1.*.bak` bằng `wx` trong cùng thư mục, fsync, ghi temp v2 rồi rename. Nguồn symlink/nonregular bị từ chối. Sau rename, bản v2 được đọc và validate lại. Nếu xác minh thất bại, utility cố khôi phục từ backup; nếu khôi phục cũng lỗi, trả `REGISTRY_MIGRATION_ROLLBACK_FAILED` và không cho runtime tiếp tục. Không có khóa liên tiến trình tuyệt đối trong API hiện tại: hash được đọc lại ngay trước rename để giảm TOCTOU, nhưng operator cần dừng mọi writer Registry trong lúc apply. Trên Windows dùng semantics thay thế file của Node `renameSync`; mode file áp dụng theo nền tảng.

RV2AUTH-01 bổ sung gate identity không có fallback: mỗi source acquisition cần `lstat` trước, `fstat` trên descriptor đã mở, và `lstat` sau; cả ba có `dev`/`ino` không null và identity bằng nhau. Identity thiếu hoặc đổi trả `REGISTRY_CORRUPT`. Trong apply, nếu lần re-read trước rename fail thì temp v2 được dọn, target Registry vẫn là byte v1; backup byte-exact có thể còn lại làm chứng cứ và không được coi là target mutation. Hash không thay thế file identity.

Metrics: process health, resume/audit latency, decision/schema status, tier/resolved model, token usage, stale events, dispatch lifecycle và uncertainty. Logs chỉ IDs/metadata đã redact.

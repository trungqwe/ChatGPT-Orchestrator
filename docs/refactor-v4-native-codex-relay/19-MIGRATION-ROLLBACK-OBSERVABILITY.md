# Migration, rollback và observability

Thứ tự: docs → registry → Codex adapter → decision → one-shot → shadow → live → cleanup. Registry migration có backup/dry-run. Modes: `legacy`, `native_shadow`, `native_one_shot`, `native_bounded`; không dual authority.

Bridge binary/submodule đã được operator gỡ trước native implementation. Rollback không được khôi phục Web override vào config Codex. Trong giai đoạn chuyển tiếp, legacy UI/API phải trả lỗi migration rõ ràng; sau native cutover, rollback dùng Git tag/release artifact của native path.

Metrics: process health, resume/audit latency, decision/schema status, tier/resolved model, token usage, stale events, dispatch lifecycle và uncertainty. Logs chỉ IDs/metadata đã redact.

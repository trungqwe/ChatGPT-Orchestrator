# Kế hoạch thực thi cụ thể tiếp theo

## WP-V4-02A — Quarantine legacy bridge

Mục tiêu: app không còn spawn/probe/gọi bridge đã gỡ.

Phạm vi:

- Thay startup/health log liên quan cổng 17841 bằng trạng thái `NATIVE_AUDITOR_NOT_IMPLEMENTED`.
- Các endpoint login/logout/verify/Web audit trả `410 LEGACY_AUDITOR_REMOVED` có JSON ổn định.
- Tắt các nút Web config/audit trong UI, hiển thị “Đang chuyển sang Native Codex”.
- Không giả lập native success và không gọi model.
- Cập nhật package description, launcher copy và tests tương ứng.

Gate: search production không còn executable spawn, fetch tới 17841 hoặc default `chatgpt-web/*`; server/UI smoke pass; broker suites vẫn pass.

## WP-V4-02B — Registry v2

Tạo schema v2 đúng tài liệu, transactional v1 migration, backup/dry-run và `AUDITOR_REGISTRATION_REQUIRED`. Tách model policy khỏi model ID; worker engine allowlist mở qua adapter registry.

Gate: migration round-trip/rollback/corrupt/duplicate-root tests; v1 không bao giờ suy diễn task ID thành thread ID.

## WP-V4-03 — App Server transport

- Sinh TypeScript/JSON schema từ Codex CLI `0.154.0`, commit snapshot và generator command.
- Child process stdio với args array, initialize handshake, request IDs, event routing, bounded buffers, timeout, interrupt và clean shutdown.
- Implement `model/list`, thread start/resume/read, turn start, review start.
- Không model call trong unit tests; dùng protocol fixtures/fake child.

Gate: malformed JSON, process exit, timeout-after-send, duplicate response, schema drift và restart tests; opt-in local smoke chỉ kiểm tra initialize/model list.

## WP-V4-04 — AuditDecisionV1

Compile strict JSON Schema; bind project/thread/turn/workspace IDs ngoài model payload; persist raw validated decision. Decision không hợp lệ không thể tới broker.

Gate: exhaustive decision variants, extra fields, stale state, prompt injection và oversized output.

## WP-V4-05 — Auditor persistence/recovery

Thêm audit store/state machine riêng, exact thread/turn correlation, `AUDIT_UNCERTAIN`, resume/reconcile và explicit replace-thread command.

Gate: relay/App Server crash ở mọi boundary, no silent thread replacement, no duplicate turn.

## WP-V4-06 — Model policy

Resolve logical tier từ `model/list`, supported reasoning effort, preference/fallback config và usage logging. Không hard-code model name.

## WP-V4-07 đến V4-09 — Command surface và one-shot

Thêm `audit start/status/recover/replace-thread`; generic worker registry; hoàn thành snapshot → audit → dispatch → wait → fresh snapshot → same-thread review.

Acceptance: chạy thật trên fixture repo, worker report sai nhưng Codex phát hiện qua source/test, restart giữa vòng vẫn recovery đúng.

## WP-V4-10 đến V4-14

Hardening → shadow → bounded autonomous loop → xóa legacy source/UI hoàn toàn → operator polish.

## Quy tắc thực thi

- Một WP/commit; không gộp cleanup với protocol.
- Targeted tests trước, full broker suite sau.
- Không sửa Codex global config, auth hoặc Desktop lifecycle.
- Không dùng Codex Desktop UI automation.
- Không bật autonomous loop trước shadow evidence.
- Mỗi report phải nêu exact commands/output, remaining risks và rollback.

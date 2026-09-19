# Báo cáo WP-V4-02A — Quarantine legacy bridge

## Kết quả

WP-V4-02A đã cô lập hoàn toàn đường chạy auditor Web khỏi runtime của Pipeline UI.

- `/api/status` không còn probe proxy hoặc chạy doctor; trả `auditor.state = NATIVE_AUDITOR_NOT_IMPLEMENTED`.
- Các endpoint Web cũ và bốn endpoint orchestration phụ thuộc auditor trả HTTP `410` với contract ổn định:
  - `code: LEGACY_AUDITOR_REMOVED`
  - `state: NATIVE_AUDITOR_NOT_IMPLEMENTED`
- `/api/models` không còn công bố model auditor Web; danh sách auditor hiện rỗng và fail closed.
- `/api/models/test` không gọi model khi provider là `chatgpt`.
- UI cấu hình hiển thị “Đang chuyển sang Native Codex”; login, logout, sync, model select và verify bị vô hiệu hóa.
- Package và cửa sổ Electron đã đổi mô tả sang kiến trúc Native Codex.

## Bằng chứng xác minh

Các lệnh đã chạy thành công:

```text
cd pipeline-ui && npm test
node pipeline-ui/test/refactor/broker-core.test.js       # 52/52 pass
node pipeline-ui/test/refactor/registry.test.js          # 39/39 pass
node pipeline-ui/test/refactor/worker-adapter.test.js    # 55/55 pass
node --check pipeline-ui/server.js
node --check pipeline-ui/public/app.js
```

Production scan trả về không có kết quả cho:

```text
codex-chatgpt-web
127.0.0.1:17841
chatgpt-web/
codex exec
```

## Giới hạn có chủ đích

Native Codex App Server chưa được triển khai trong work package này. Không có phản hồi audit giả và không có model call. Các handler cũ vẫn nằm sau middleware `410` để giữ thay đổi này nhỏ, dễ rollback; chúng sẽ được xóa hoàn toàn ở cleanup WP-V4-13 sau khi transport mới qua shadow gate.

## Bước tiếp theo

1. WP-V4-02B: Registry v2 và migration fail closed.
2. WP-V4-03: App Server transport với protocol fixture, timeout, event correlation và clean shutdown.
3. WP-V4-04: `AuditDecisionV1` strict schema trước khi nối auditor vào broker.


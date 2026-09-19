# ChatGPT-Orchestrator

> Kiến trúc đang được chuyển sang **Native Codex Auditor ↔ Thin Relay ↔ Pluggable Worker**.

## Trạng thái

V4 đang ở giai đoạn thiết kế và migration. Production hiện vẫn chứa các đường chạy V3 dựa trên ChatGPT Web; không nên xem tài liệu V4 là tính năng đã hoàn tất.

Mục tiêu V4:

- Codex native qua App Server đọc workspace local, audit và phát quyết định có schema.
- Relay chỉ xác thực identity, freshness, lifecycle, routing và persistence.
- Worker như Antigravity, Gemini hoặc Codex worker sửa mã và chạy test.
- Không dùng ChatGPT Web, browser automation, MCP tunnel hoặc `codex-chatgpt-web` trong critical path.

Tài liệu kiến trúc và lộ trình: [docs/refactor-v4-native-codex-relay/00-README.md](docs/refactor-v4-native-codex-relay/00-README.md).

```text
CODEX AUDITS AND DECIDES
RELAY IDENTIFIES, GUARDS, ROUTES, AND PERSISTS
WORKER IMPLEMENTS AND TESTS
```

Auditor không sửa implementation trong luồng bình thường. Worker report chỉ là gợi ý không đáng tin; Codex kiểm tra source, diff và test thực tế trong workspace.

## Thành phần hiện có

- `pipeline-ui/`: Electron/Express app và broker V3 đang được migration.
- `pipeline-ui/lib/broker/`: registry, lifecycle store, workspace state và worker adapter có thể tái sử dụng.
- `agent-orchestrator/`: submodule worker/orchestration hiện có.
- Đường chạy `codex-chatgpt-web` đã được gỡ khỏi máy và repository.

## Chạy bản hiện tại

```powershell
cd pipeline-ui
npm install
npm run desktop
```

Các màn hình và endpoint production gắn với ChatGPT Web hiện là legacy và sẽ được dọn ở WP-V4-13. Bộ tài liệu V4 thay thế tài liệu V2/V3; Git history lưu lịch sử cũ.

## Giấy phép

MIT. Chủ sở hữu: Thanh Trung ([@trungqwe](https://github.com/trungqwe)).

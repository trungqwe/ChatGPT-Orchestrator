# Source reference memo

## Official capability facts

OpenAI Codex App Server docs xác nhận `model/list`, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `review/start`, `turn/interrupt` và `outputSchema`: https://developers.openai.com/codex/app-server

## Repository facts

V3 có Web-specific registry, durable SQLite worker lifecycle, workspace state, broker và Antigravity adapter. Global Codex config trước khôi phục từng trỏ model/base URL/hook vào `codex-chatgpt-web`.

## Decisions và proposals

Persistent project thread, App Server control plane, read-only auditor policy và logical model tiers là quyết định V4. Registry v2, adapters, schema, resolver và loops là đề xuất chưa implemented ở WP-V4-01.

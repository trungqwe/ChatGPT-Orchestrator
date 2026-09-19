# Codex Auditor Adapter

Interface: `initialize`, `listModels`, `startThread`, `resumeThread`, `readThread`, `startTurn`, `startReview`, `interruptTurn`, `close`.

Adapter sở hữu `codex app-server`, JSONL correlation, exact resume, cwd, sandbox/approval policy, tier resolution, streamed result và `outputSchema` validation. Nó không dispatch worker, approve workspace, sửa source hoặc biến prose lỗi thành decision. Persist provider fields `thread.id` và `thread.sessionId` đúng nguyên bản.

CLI `codex exec`/resume chỉ là fallback operator; không tạo lifecycle authority thứ hai.

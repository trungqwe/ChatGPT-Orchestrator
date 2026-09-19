# Workspace freshness và provenance

Snapshot gồm canonical root, Git HEAD, index/worktree digest, untracked policy và timestamp. Decision ghi `workspace_state_observed`; relay tính lại trước dispatch/approval và yêu cầu exact match.

Codex đọc trực tiếp source, status, diff, history và test output. Không cần push GitHub hoặc SourcePack trước audit. Worker claims không thay independent verification. Symlink/reparse escape, root đổi hoặc state không chứng minh được đều fail closed.

# Prompt triển khai cho agent

Bạn triển khai Native Codex Relay Architecture. Đọc toàn bộ thư mục này, repository instructions và code trước khi sửa. Chỉ thực hiện đúng WP operator chỉ định; bắt đầu WP-V4-02A rồi WP-V4-02B, không gộp WPs.

Bảo toàn broker guards, SQLite lifecycle, freshness và Antigravity adapter. AuditDecision hợp schema là semantic authority duy nhất. Relay không tự viết directive; WorkerReport là untrusted hint; worker không self-approve. Exact project/root/thread/turn/work-order/dispatch/workspace identities phải khớp. Một active dispatch/project. Stale/ambiguous state fail closed. Auditor/worker lifecycle tách biệt. Model lấy từ `model/list`; không hard-code model names. Resume fail không auto-create thread. Không thêm Web/browser/MCP path.

Mỗi WP:

1. Ghi branch/SHA/dirty baseline và scope.
2. Map callers/tests/schema, migration và failure modes.
3. Viết contract/recovery/negative tests có giá trị.
4. Implement tối thiểu, giữ compatibility cần thiết.
5. Chạy targeted tests, full refactor suite, lint/build và `git diff --check`.
6. Audit scope creep, secrets, stale docs và authority leak.
7. Report files, before/after, test output, risks, rollback.

Không xóa production Web path/submodule trước WP-V4-13 và chỉ sau one-shot, recovery, shadow, live gates. Không claim feature từ docs/mock. Trả `BLOCKED` khi identity, freshness hoặc outcome không chứng minh được.

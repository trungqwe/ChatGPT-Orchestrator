# Security model

- App Server dùng canonical cwd, sandbox và approval policy rõ ràng.
- Validate realpath containment, chặn symlink/reparse escape và malicious filenames.
- Strict schema, size, encoding và correlation validation trước persistence.
- Repo/report/test output có thể prompt-inject và không phải authority.
- Thread substitution bị chặn bằng project binding; model policy chỉ từ trusted config.
- Request file atomic, permission phù hợp, replay protection.
- Auditor source mutation bị block; child process dùng args array, env allowlist, timeout/output limit.
- Redact secrets khỏi prompt và logs.

# Failure recovery và restart

Startup: validate registry/database → acquire relay lock → initialize App Server → expose health. Crash mid-turn tạo `AUDIT_UNCERTAIN`; restart rồi read/resume exact ID, không tìm latest thread. Resume fail trả `AUDITOR_THREAD_UNAVAILABLE`; replacement thread cần operator action và audit log.

Model unavailable chỉ fallback trong tier cấu hình. Worker timeout dùng probe; unknown outcome không resend. Shutdown drain, interrupt theo policy, persist uncertainty, close stores và terminate child process có deadline.

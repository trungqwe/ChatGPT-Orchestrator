# V4 Native Codex Relay Architecture

V4 thay thế V2 và V3. Auditor chính là Codex native qua App Server; implementation đi qua worker adapter có thể thay thế. Browser/MCP/Web auditor path bị loại khỏi kiến trúc.

Thứ tự authority: invariant và schema V4 → registry/lifecycle bền vững → workspace thực tế → quyết định Codex có cấu trúc → WorkerReport (untrusted hint).

Bản đồ: `01` quyết định pivot; `02` tài sản hiện trạng; `03–14` kiến trúc, contract, bảo mật và recovery; `15–20` kế hoạch, kiểm thử và vận hành; `21` nguồn; `22` prompt giao agent; `23–24` audit hiện trạng và kế hoạch thực thi kế tiếp. Trạng thái: architecture migration in progress; production migration chưa bắt đầu.

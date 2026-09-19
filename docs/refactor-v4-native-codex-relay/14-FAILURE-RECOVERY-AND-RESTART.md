# Failure recovery và restart

Startup: validate registry/database → acquire relay lock → initialize App Server → expose health. Crash mid-turn tạo `AUDIT_UNCERTAIN`; restart rồi read/resume exact ID, không tìm latest thread. Resume fail trả `AUDITOR_THREAD_UNAVAILABLE`; replacement thread cần operator action và audit log.

Model unavailable chỉ fallback trong tier cấu hình. Worker timeout dùng probe; unknown outcome không resend. Shutdown drain, interrupt theo policy, persist uncertainty, close stores và terminate child process có deadline.

## Phục hồi sự cố trong các pha Materialization (WO-V4-03BR)

- **Lỗi lượt audit đầu tiên (First Turn Failure)**: Nếu lượt audit thực tế đầu tiên thất bại hoặc bị ngắt trước khi chứng minh được materialization và recovery bền vững, tuyệt đối **không bind thread** vào Registry. Giữ nguyên trạng thái `AUDITOR_REGISTRATION_REQUIRED` hoặc trạng thái lỗi cục bộ; không gán ID chưa hoàn tất vào `projects.json`.
- **Crash trước lượt audit đầu tiên (Crash Before First Turn)**: Nếu relay hoặc App Server sập nguồn sau khi `thread/start` thành công nhưng chưa thực hiện lượt audit nào, ID provisional trong bộ nhớ bị hủy hoàn toàn và không phải là authority bền vững. Không suy diễn rằng Registry cần giữ ID này; không quét tìm thread "mới nhất" (latest thread heuristic) để thay thế. Hệ thống fail-closed về `AUDITOR_REGISTRATION_REQUIRED`.
- **Crash sau lượt audit đầu tiên (Crash After First Turn)**: Nếu lượt audit đầu tiên có thể đã vật chất hóa nhưng quá trình kiểm định persistence/recovery bị gián đoạn, chuyển dispatch sang `AUDIT_UNCERTAIN` cho đến khi đối soát xong exact thread/history authority. Nghiêm cấm việc âm thầm tạo thread mới thay thế.

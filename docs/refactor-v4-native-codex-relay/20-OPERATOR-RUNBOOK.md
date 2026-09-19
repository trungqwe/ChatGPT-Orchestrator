# Operator runbook

1. Register canonical project root và worker.
2. Start relay; kiểm tra registry/store/App Server.
3. Create auditor thread một lần; kiểm tra exact ID/cwd rồi persist.
4. Chọn logical model policy và xem runtime resolution.
5. Chạy one-shot; quan sát decision/dispatch IDs.
6. Khi ready, xác nhận fresh snapshot và same-thread review.
7. Stop bằng drain, controlled interrupt, persist và shutdown.

Crash: restart, resume exact thread, probe worker, xử lý uncertainty. Model unavailable: chọn tier hợp lệ. Thay thread chỉ qua explicit operator command, lưu old ID và reason.

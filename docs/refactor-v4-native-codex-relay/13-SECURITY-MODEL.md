# Security model

- Stdio local transport only: Giao tiếp cục bộ qua stdio JSONL; không dùng WebSocket, Unix socket hay remote listeners.
- Spawn an toàn: Luôn gọi qua mảng đối số với `shell: false`. Tuyệt đối không dùng `exec`, `execSync` hay nối chuỗi lệnh shell.
- Môi trường cô lập: Chỉ chuyển tiếp các biến môi trường nền tảng cần thiết và các biến tiền tố `CODEX_`/`OPENAI_`. Không bao giờ ghi log giá trị biến môi trường.
- Bounded stdout/stderr: Giới hạn dòng stdout tối đa 8 MiB (vượt quá báo `CODEX_APP_SERVER_PROTOCOL_LIMIT` và ngắt kết nối). Giới hạn chẩn đoán stderr tối đa 64 KiB trong FIFO tail; không parse stderr làm JSON-RPC authority.
- Không auto-approval: Không tự động chấp thuận (auto-approve) bất kỳ server-initiated request nào từ App Server. Mặc định trả về lỗi fail-closed `SERVER_REQUEST_REJECTED_FAIL_CLOSED`.
- API ổn định: Khởi tạo không bật `experimentalApi: true`. Không sử dụng các API thử nghiệm (`process/*`, dynamic tools, experimental terminals).
- Exact correlation: Tương quan ID request đơn điệu duy nhất. Unknown response ID hoặc trùng lặp response ID đều fail-closed.
- Side-effect uncertainty: Timeout sau write hoặc tiến trình con chết đột ngột đối với các lệnh có tác dụng phụ (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) đều gán mã `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry để tránh nhân đôi thread/turn.
- Read-only auditor intent: Mặc định auditor thread có mục đích read-only; chặn đứng các yêu cầu quyền leo thang như `dangerFullAccess` hay `workspaceWrite`.
- Exact-child shutdown: Quản lý vòng đời tiến trình con qua tham chiếu PID chính xác. Đóng stdin, đợi graceful exit, rồi gửi tín hiệu SIGTERM/SIGKILL tới đúng child PID. Tuyệt đối không dùng `taskkill` hay `pkill` theo tên tiến trình.
- Bảo vệ Registry và Worker: Client/adapter không ghi đè Project Registry, không gọi Broker và không dispatch worker.

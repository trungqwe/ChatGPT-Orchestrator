# Security model

- Stdio local transport only: Giao tiếp cục bộ qua stdio JSONL; không dùng WebSocket, Unix socket hay remote listeners.
- Spawn an toàn: Luôn gọi qua mảng đối số với `shell: false`. Tuyệt đối không dùng `exec`, `execSync` hay nối chuỗi lệnh shell.
- Môi trường cô lập: Chỉ chuyển tiếp các biến môi trường nền tảng cần thiết và các biến tiền tố `CODEX_`/`OPENAI_`. Không bao giờ ghi log giá trị biến môi trường.
- Bounded stdout/stderr: Giới hạn dòng stdout tối đa 8 MiB (vượt quá báo `CODEX_APP_SERVER_PROTOCOL_LIMIT` và ngắt kết nối). Giới hạn chẩn đoán stderr tối đa 64 KiB trong FIFO tail; không parse stderr làm JSON-RPC authority.
- Không auto-approval: Không tự động chấp thuận (auto-approve) bất kỳ server-initiated request nào từ App Server. Phương thức chuẩn `item/commandExecution/requestApproval` và `item/fileChange/requestApproval` mặc định trả về phản hồi từ chối `{ decision: "decline" }` fail-closed; không log nhạy cảm toàn bộ payload (lệnh thực thi, đường dẫn).
- API ổn định: Khởi tạo không bật `experimentalApi: true`. Không sử dụng các API thử nghiệm (`process/*`, dynamic tools, experimental terminals).
- Không forward test-only hooks: Loại bỏ triệt để mọi logic chuyển tiếp các tham số có tiền tố `_` sang provider payload; các hành vi test chỉ được điều khiển qua cờ scenario của test fixture hoặc synthetic ID định sẵn.
- Exact correlation: Tương quan ID request đơn điệu duy nhất. Unknown response ID hoặc trùng lặp response ID đều fail-closed.
- Response shape validation: Yêu cầu chính xác một trong hai trường `result` hoặc `error`. Nếu có cả hai hoặc không có trường nào, fail-closed với `CODEX_APP_SERVER_PROTOCOL_ERROR`.
- Side-effect uncertainty: Timeout sau write, đóng client (`close()`) khi request đã ghi đang chờ, hoặc tiến trình con chết đột ngột đối với các lệnh có tác dụng phụ (`thread/start`, `turn/start`, `review/start`, `turn/interrupt`) đều gán mã `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry để tránh nhân đôi thread/turn.
- Read-only auditor profile: Cấu hình provider chuẩn `sandbox: "readOnly"` và `approvalPolicy: "never"`; chặn đứng và từ chối các trường tự chế như `readOnly`, `dangerFullAccess` hay `workspaceWrite`.
- Exact-child shutdown: Quản lý vòng đời tiến trình con qua tham chiếu PID chính xác. Đóng stdin, đợi graceful exit, rồi gửi tín hiệu SIGTERM/SIGKILL tới đúng child PID. Tuyệt đối không dùng `taskkill` hay `pkill` theo tên tiến trình.
- Bảo vệ Registry và Worker: Client/adapter không ghi đè Project Registry, không gọi Broker và không dispatch worker.

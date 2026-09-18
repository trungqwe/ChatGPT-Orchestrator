# ChatGPT-Orchestrator 🚀

> **Hệ thống điều phối khép kín (Closed-Loop Orchestration System) giữa ChatGPT Web (Senior Technical Architect & Auditor) và Google Antigravity IDE (Gemini Autonomous Worker).**

[![Electron](https://img.shields.io/badge/Electron-Desktop_App-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Antigravity IDE](https://img.shields.io/badge/Antigravity-IDE_Worker-4285F4?logo=google&logoColor=white)](https://antigravity.google/)
[![ChatGPT](https://img.shields.io/badge/ChatGPT_Web-Architect_&_Auditor-10A37F?logo=openai&logoColor=white)](https://chat.openai.com/)

---

## 📖 Tổng Quan Kiến Trúc (Architecture)

ChatGPT-Orchestrator được thiết kế nhằm hiện thực hóa mô hình phân tách vai trò tối ưu trong phát triển phần mềm bằng AI:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 ChatGPT Web (Codex)                    │
                  │   - Senior Technical Architect & Code Auditor          │
                  │   - KHÔNG trực tiếp sinh code / sửa file               │
                  │   - Đọc Báo Cáo Cuối, thẩm định, ra chỉ đạo tiếp theo  │
                  └───────────────────────────▲────────────────────────────┘
                                              │ 
                     (1) Báo Cáo Cuối & Handoff │ (2) Chỉ đạo tiếp theo
                                              │
                  ┌───────────────────────────▼────────────────────────────┐
                  │         ChatGPT-Orchestrator (Desktop App)             │
                  │   - Express API Server & Electron UI                   │
                  │   - Real-time Transcript Observer                      │
                  │   - Tự động nạp lệnh vào khung chat Antigravity IDE   │
                  └───────────────────────────▲────────────────────────────┘
                                              │
                      (4) Trích xuất Báo Cáo   │ (3) Nạp Prompt vào Chatbox
                                              │
                  ┌───────────────────────────▼────────────────────────────┐
                  │            Google Antigravity IDE (Gemini)             │
                  │   - Autonomous Worker thi công sửa code                │
                  │   - Chạy test, kiểm tra branch coverage, git diff      │
                  │   - Tạo Báo Cáo Cuối & Handoff khi kết thúc turn       │
                  └────────────────────────────────────────────────────────┘
```

### 1. Chu Trình Vòng Lặp Khép Kín (Closed-Loop Flow)
1. **Khởi động**: ChatGPT Web nhận yêu cầu từ người dùng hoặc tài liệu kỹ thuật (`ROADMAP.md`, `spec.md`).
2. **Ra chỉ đạo**: ChatGPT Web thẩm định và đưa ra chỉ đạo kỹ thuật chi tiết dưới mục `### 🎯 CHỈ ĐẠO TIẾP THEO CHO ANTIGRAVITY:`.
3. **Nạp tự động vào IDE**: Orchestrator tự động bắt cửa sổ Antigravity IDE và nạp prompt vào khung chat (không chiếm chuột, an toàn cho thao tác song song của lập trình viên).
4. **Agent thi công**: Worker Gemini trên Antigravity IDE nhận lệnh, phân tích, sửa mã nguồn, chạy unit tests, kiểm tra độ phủ (coverage).
5. **Giám sát thời gian thực**: Orchestrator theo dõi file log transcript của phiên làm việc. Khi phát hiện Agent hoàn thành turn (`status: DONE`), Orchestrator tự động trích xuất nội dung **Báo Cáo Cuối & Handoff**.
6. **Thẩm định & Lặp lại**: Báo cáo được tự động đẩy về ChatGPT Web để audit độc lập. Quá trình lặp lại tuần tự 1-1 cho đến khi toàn bộ mục tiêu của Roadmap hoàn tất.

---

## ✨ Tính Năng Nổi Bật

- ⚡ **Closed-Loop Automation**: Chu trình thẩm định -> thi công -> báo cáo -> kiểm toán diễn ra 100% tự động, bảo đảm không bị đứt đoạn hoặc chèn lệnh lặp vô căn cứ.
- 🖥️ **Desktop App Hiện Đại**: Xây dựng trên nền tảng Electron với giao diện Dark Mode cao cấp, font Outfit/Inter, viền gradient tinh tế.
- 📂 **Accordion Danh Mục Kỹ Thuật**: Cột bên trái hiển thị các tài liệu dự án (`ROADMAP.md`, `HANDOFF.md`, `README.md`) dạng accordion thu gọn/mở rộng linh hoạt.
- 🔍 **Khung Đọc Trước Báo Cáo Co Giãn Chuột**: Cho phép kéo giãn chiều cao khung preview tài liệu để đọc báo cáo dài mà không bị che khuất.
- ⚙️ **Tab Cấu Hình Tập Trung**: Hỗ trợ đăng nhập tài khoản ChatGPT Web, đăng xuất đổi tài khoản, kiểm tra trạng thái session, và import danh mục model từ Codex.
- 🧹 **Xóa Lịch Sử Chat Thông Minh**: Chỉ xóa lịch sử hiển thị trên giao diện làm việc của Orchestrator, tuyệt đối không can thiệp hay xóa file cứng của Antigravity IDE.

---

## 🚀 Hướng Dẫn Cài Đặt & Sử Dụng

### Yêu Cầu Hệ Thống
- Hệ điều hành: Windows 10/11
- Node.js: v18.0.0 trở lên
- Python: 3.10 trở lên (hỗ trợ pywin32 để gửi lệnh vào IDE)
- Google Antigravity IDE đã cài đặt
- Trình duyệt Chrome/Edge hoặc Codex ChatGPT Proxy chạy trên cổng 17841

### 1. Cài Đặt Dependencies
Mở PowerShell hoặc Command Prompt tại thư mục dự án:
```bash
cd pipeline-ui
npm install
```

### 2. Khởi Động Nhanh (1-Click)
Chỉ cần nhấp đúp vào file:
```
launch-desktop.bat
```
Hoặc chạy lệnh:
```bash
cd pipeline-ui
npm run desktop
```

### 3. Đẩy Mã Nguồn Lên GitHub Sau Mỗi Phiên Làm Việc
Sử dụng script tự động:
```bash
.\push-to-github.bat
```
Script sẽ tự động kiểm tra thay đổi, tạo commit với mốc thời gian và push lên repository [ChatGPT-Orchestrator](https://github.com/trungqwe/ChatGPT-Orchestrator).

---

## 📁 Cấu Trúc Thư Mục

```
Orchestrator/
├── launch-desktop.bat        # File bat khởi động ứng dụng Desktop 1-click
├── push-to-github.bat        # Script đẩy mã nguồn lên GitHub sau mỗi phiên
├── README.md                 # Tài liệu hướng dẫn sử dụng và kiến trúc
├── .gitignore                # Danh sách loại trừ tệp tin rác/cache
│
├── pipeline-ui/              # Ứng dụng chính Orchestrator (Electron + Express)
│   ├── server.js             # Express API Server, Transcript Observer & Bridge
│   ├── desktop-main.js       # Electron Main Process
│   ├── preload.js            # Electron Preload Bridge
│   ├── send_to_antigravity.py# Script Win32 tự động gửi prompt vào khung chat IDE
│   ├── get_antigravity_convos.py # Quét và trích xuất danh sách phiên Antigravity
│   ├── public/               # Giao diện Web / Desktop
│   │   ├── index.html        # Layout HTML hiện đại, chuẩn UI/UX
│   │   ├── app.js            # Logic frontend, closed-loop engine
│   │   └── style.css         # Bảng màu Dark mode, HSL, Glassmorphism
│   ├── test/                 # Test suites kiểm thử API và vòng lặp
│   └── package.json          # Cấu hình gói và dependencies
│
└── calc-engine/              # Dự án mẫu kiểm thử vòng lặp (AST Parser & Evaluator)
```

---

## 🛡️ Giấy Phép & Bản Quyền
Dự án được phát triển và sở hữu bởi **Thanh Trung** ([@trungqwe](https://github.com/trungqwe)).
Phát hành theo giấy phép MIT.

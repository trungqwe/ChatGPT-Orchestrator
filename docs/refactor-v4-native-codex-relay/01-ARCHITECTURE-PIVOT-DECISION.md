# Quyết định pivot kiến trúc

V3 dùng ChatGPT Web, bridge local, browser/session ownership và Full Harness. Khi bridge dừng, `openai_base_url` local làm Codex Desktop mất backend. Native Codex đã có workspace, terminal và App Server có identity máy đọc được, nên lớp Web không còn đem lại giá trị tương xứng.

Trọng số: correctness 25%, vận hành 20%, maintainability 15%, integration risk 15%, time-to-prove 10%, complexity 5%, performance 5%, cost 5%. Điểm 10 là tốt nhất.

| Phương án | Cơ chế | Điểm | Nhược điểm |
|---|---|---:|---|
| Desktop thủ công | Người dùng chuyển prompt/report | 7.0 | Không tự động hóa lifecycle |
| Điều khiển UI Desktop | Relay thao tác cửa sổ/transcript | 4.8 | Identity mơ hồ, dễ vỡ |
| App Server + relay mỏng | Exact thread, structured turn, adapter | 8.8 | Cần adapter/recovery mới |

Chọn App Server + relay mỏng. V3 là **superseded** vì constraints đổi và có đường native đơn giản hơn. App Server là control plane programmatic; Codex Desktop vẫn là giao diện operator hữu ích nhưng relay không tự động hóa UI Desktop. Triển khai one-shot → shadow → bounded autonomous loop.

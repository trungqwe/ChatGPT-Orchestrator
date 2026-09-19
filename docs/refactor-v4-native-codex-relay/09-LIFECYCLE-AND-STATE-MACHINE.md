# Lifecycle và state machine

```text
AUDIT_CREATED → AUDIT_RUNNING → AUDIT_DECISION_READY
                       ├──────→ AUDIT_FAILED
                       └──────→ AUDIT_UNCERTAIN
```

Auditor và worker dùng state domain riêng. Audit record lưu project/thread/turn, reason, observed workspace, timestamps và raw validated decision. Worker giữ durable dispatch lifecycle hiện có. Restart reconcile từng domain trước khi nối quan hệ.

## Thread Materialization Lifecycle (WO-V4-03BR)

Vòng đời gắn kết định danh Auditor Thread qua các pha vật chất hóa:

```text
Registry: UNBOUND (auditor.thread_id: null, enabled: false)
        ↓
   thread/start (cwd, approvalPolicy="never", sandbox="read-only")
        ↓
PROVISIONAL_UNMATERIALIZED (In-memory live session; thread/read verify exact ID)
        ↓
   Lượt audit thực tế đầu tiên có cấu trúc (theo schema AuditDecisionV1)
        ↓
   Codex may materialize durable history once the first meaningful user turn begins;
   WP05 proves durability explicitly through recovery/resume and does not rely on
   the exact filesystem-materialization event.
        ↓
   Gate kiểm định khôi phục/bền vững (restart App Server & thread/resume ở WP-V4-05)
        ↓
DURABLE_BOUND (Ghi exact thread_id vào Registry v2; auditor.enabled = true)
```

### Phân định vai trò thread/read và thread/resume
- `thread/read` (cùng tiến trình): Chứng minh định danh thread chính xác trong runtime đang chạy, khả năng truy vấn metadata của provider. **Không chứng minh** tính bền vững qua restart hoặc sự tồn tại của file rollout trên đĩa.
- `thread/resume`: Là primitive kiểm chứng tính bền vững và khả năng phục hồi liên tiến trình (cross-process restart recovery). Chỉ có hiệu lực sau khi lịch sử đã được vật chất hóa qua lượt rà soát thực tế đầu tiên.

### Nguyên tắc kinh tế Token (Token Economy & Lock Principle)
- **NO TOKEN SPEND FOR EMPTY MATERIALIZATION**: Tuyệt đối không gửi turn giả, prompt rỗng chỉ để ép App Server sinh file rollout trên đĩa.
- **Phân kỳ chi phí**:
  1. *Khởi tạo thread (Provisioning)*: 0 model turn, 0 token chi phí.
  2. *Lượt audit hữu ích đầu tiên*: Là lượt turn thực tế đầu tiên sinh token theo nhu cầu rà soát code.
  3. *Kiểm định độ bền vững*: Thực hiện sau khi lượt audit hữu ích đã hoàn thành và rollout đã được ghi nhận tự nhiên.

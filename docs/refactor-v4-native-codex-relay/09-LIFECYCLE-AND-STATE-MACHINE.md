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

## Phân Định Ba Miền Thẩm Quyền (Three Authority Domains — WO-V4-05A)

Hệ thống phân tách rạch ròi ba miền thẩm quyền độc lập, không cho phép miền này suy diễn thay cho miền kia:

```text
┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
│   Codex App Server      │     │  Auditor Recovery DB    │     │      Registry V2        │
│   (Provider Domain)     │     │    (Durability Store)   │     │    (Config Authority)   │
├─────────────────────────┤     ├─────────────────────────┤     ├─────────────────────────┤
│ • thread/start, read    │     │ • SQLite fail-closed    │     │ • projects.json v2      │
│ • turn/start, complete  │     │ • State machine journal │     │ • thread_id: exact / null│
│ • thread/resume         │     │ • Validated decision    │     │ • enabled: true / false │
│ • Lazy rollout files    │     │ • Pre-commit boundary   │     │ • Atomic queue mutation │
│ • Zero Registry authority│    │ • Zero model execution  │     │ • AUDITOR_BOUND_READY   │
└─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
```

1. **Codex App Server Domain**: Thực thi runtime, sở hữu lifecycle của thread và rollout file (`~/.codex/sessions`). Provider quyết định thời điểm rollout materialization (tại first accepted `turn/start`). Không sở hữu cấu hình Orchestrator.
2. **Auditor Recovery SQLite Domain** (`auditor_recovery_v1`): Journal lưu vết phục hồi fail-closed (`synchronous=FULL`, `foreign_keys=ON`, integrity check, WAL mode sau validate). Nắm giữ trạng thái chuyển tiếp vòng đời và validated decision bytes + SHA-256. Không tự ý thực thi lại model.
3. **Registry V2 Domain** (`projects.json`): Thẩm quyền cấu hình project duy nhất của broker. Chỉ bind `auditor.thread_id` và kích hoạt `enabled: true` (`AUDITOR_BOUND_READY`) sau khi vượt qua cả validated decision lẫn cross-process resume test.

## Bảy Trạng Thái Vòng Đời Chi Tiết (7 Lifecycle States — WO-V4-05A)

Vòng đời gắn kết Auditor Thread trải qua chuỗi chuyển trạng thái đơn hướng, kiểm soát bằng giao dịch SQLite:

```text
UNBOUND (Registry)
   │
   ▼
[PROVISIONAL_THREAD] ──(thread/start success, in-memory live, zero turn)
   │
   ▼
[FIRST_TURN_STARTING] ──(Pre-commit: ghi audit context vào DB trước khi dispatch turn)
   │
   ▼
[FIRST_TURN_IN_FLIGHT] ──(turn/start accepted, turnId recorded, provider materializes)
   │
   ▼
[DECISION_VALIDATED] ──(Strict AuditDecisionV1 validated, exact bytes ≤128 KiB & SHA-256 persisted)
   │
   ▼
[RESUME_VERIFYING] ──(Client 1 closed, fresh App Server process spawned, thread/resume dispatched)
   │
   ▼
[RESUME_VERIFIED] ──(Second process returns exact matching threadId)
   │
   ▼
[REGISTRY_BINDING] ──(Invoking atomic registry.bindAuditorThread)
   │
   ▼
[DURABLE_BOUND] ──(Registry updated to AUDITOR_BOUND_READY, active bootstrap cleaned up)
```

### Các trạng thái dừng / lỗi (Terminal / Uncertainty States):
- `AUDIT_UNCERTAIN`: Kích hoạt khi có lỗi hoặc sập nguồn trong `FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT`, hoặc `RESUME_VERIFYING`. **TUYỆT ĐỐI CẤM tự ý gửi lại turn/start (no auto-resend)** nhằm tránh side-effects và nhân bản chi phí.
- `BOOTSTRAP_FAILED`: Kích hoạt khi gặp lỗi tiền điều kiện hoặc lỗi không thể khắc phục trong giai đoạn khởi tạo thread hoặc validate schema.

### Nguyên tắc Pre-commit và Persistence Contract:
- **Pre-commit Boundary**: Trạng thái `FIRST_TURN_STARTING` bắt buộc phải được commit bền vững vào SQLite trước khi byte đầu tiên của `turn/start` được ghi xuống stdin của App Server.
- **Strict Decision Contract**: Chỉ lưu `AuditDecisionV1` đã qua hàm `validateAuditDecisionV1()`, chuỗi UTF-8 bytes $\le 128$ KiB, kèm SHA-256 hash tính trên đúng chuỗi byte đó. Tuyệt đối không lưu raw model prose hay unvalidated JSON vào DB. Khi đọc lại, bắt buộc verify SHA-256 rồi mới parse strict và revalidate context.

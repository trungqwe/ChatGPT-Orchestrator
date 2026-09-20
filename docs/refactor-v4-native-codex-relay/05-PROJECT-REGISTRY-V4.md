# Project Registry V4

```json
{"schema_version":2,"projects":{"project-id":{"project_id":"project-id","project_name":"Project","project_root":"D:\\Code\\Project","auditor":{"engine":"codex_app_server","thread_id":null,"cwd":"D:\\Code\\Project","enabled":false,"model_policy":"auditor_standard"},"worker":{"engine":"antigravity","session_id":"exact-session-id","enabled":true,"model_policy":"worker_standard"},"policy":{"max_active_dispatches":1,"require_workspace_state":true}}}}
```

Registry mới mặc định `schema_version: 2`. Runtime gặp v1 trả `REGISTRY_MIGRATION_REQUIRED`, không tự nâng cấp. Broker dispatch request tiếp tục dùng `schema_version: 1` vì đó là giao thức riêng.

`auditor.thread_id` là opaque ID hoặc `null`, tối đa 512 byte UTF-8, không có ký tự điều khiển. `enabled: true` yêu cầu ID đã gắn. `AUDITOR_REGISTRATION_REQUIRED` được **suy ra** từ `thread_id == null`, không lưu thành cờ độc lập. `thread_id != null` kết hợp `enabled` lần lượt tạo `AUDITOR_BOUND_DISABLED` hoặc `AUDITOR_BOUND_READY`. `auditor.cwd` và `project_root` phải cùng canonical filesystem identity; khi ghi, cả hai được chuẩn hóa thành cùng canonical path.

Worker vẫn giới hạn `antigravity`; `worker.model_policy` là `worker_economy` hoặc `worker_standard`. `auditor.model_policy` là `auditor_fast`, `auditor_standard` hoặc `auditor_deep`. Registry không lưu tên model cụ thể. `architecture_deep` chỉ là chính sách nâng cấp theo turn về sau.

Migration v1→v2 chỉ chạy qua admin CLI explicit. Preview đọc và hash byte nguồn, validate toàn bộ v1, canonicalize tất cả root, tạo candidate v2 và không ghi file. Apply cần SHA-256 đã preview, đọc lại nguồn, tạo backup byte-exact trong cùng thư mục, ghi temp file, fsync, rename và validate sau ghi. Metadata auditor v1 bị loại bỏ; **không chuyển `task_id` thành `thread_id`**. Mọi project v1 trở thành auditor unbound/disabled và cần đăng ký thread sau này. Không tạo thread trong WP-V4-02B.

Mỗi lần đọc nguồn migration, kể cả lần re-read ngay trước rename, bắt buộc ba snapshot `lstat(path)` → `fstat(fd)` → `lstat(path)`. Pathname trước/sau không được là symlink; cả ba phải là regular file với `dev` và `ino` không null. Identity `dev`/`ino` phải bằng nhau theo cặp pre/fd và fd/post. Nếu thiếu identity hoặc pathname đổi, trả `REGISTRY_CORRUPT` và không dùng byte vừa đọc làm authority. SHA-256 chỉ bổ sung xác thực nội dung sau khi file identity đã được chứng minh.

## Phân định trạng thái Thread Materialization & Ranh giới Registry V2 (WO-V4-03BR)

Kiến trúc phân định chặt chẽ ba trạng thái vòng đời của thread:

1. `UNBOUND`:
   - `auditor.thread_id == null`, `auditor.enabled == false`.
   - Trạng thái vận hành suy ra: `AUDITOR_REGISTRATION_REQUIRED`.
   - Giữ nguyên cấu trúc Registry v2 hiện tại, không thêm cờ phụ.

2. `PROVISIONAL_UNMATERIALIZED`:
   - `thread/start` thành công trên tiến trình App Server đang chạy; nhận được `thread.id` chính xác; cùng tiến trình có thể dùng `thread/read` để thấy thread.
   - Chưa có lượt rà soát thực tế nào (`turn/start`), file session rollout trên đĩa chưa được Codex vật chất hóa (lazy rollout materialization).
   - Chưa chứng minh được khả năng phục hồi liên tiến trình (`thread/resume` qua restart).
   - Thẩm quyền: **Chỉ tồn tại trong bộ nhớ / cục bộ của phiên làm việc (IN-MEMORY / OPERATION-LOCAL ONLY)**.
   - **Cấm ghi vào Registry**: Tuyệt đối không ghi provisional thread ID vào Registry v2 (`auditor.thread_id` vẫn phải là `null`, `enabled: false`). Lý do: *thread ID tồn tại ≠ lịch sử auditor bền vững có thể resume*.

3. `DURABLE_BOUND`:
   - Chỉ đạt được sau khi: `thread/start` có ID hợp lệ + lượt audit thực tế đầu tiên (`turn/start`) hoàn thành có cấu trúc + lịch sử rollout được provider vật chất hóa + vượt qua bài kiểm tra phục hồi/resume liên tiến trình (`thread/resume` trả về đúng exact ID sau restart) tại WP-V4-05.
   - Khi đó mới ghi `auditor.thread_id = exact_id`, `auditor.enabled = true` vào Registry v2 (`AUDITOR_BOUND_READY`).

**Nguyên tắc bất biến về Registry & Rollout File**:
- Không thay đổi schema Registry v2: không thêm bất kỳ trường nào như `materialized`, `provisional`, `durable`, `resume_verified`.
- Tuyệt đối không dùng `thread.path`, rollout path, hoặc session filename làm định danh authority. Định danh auditor duy nhất là opaque `thread.id`.
- Nghiêm cấm Orchestrator can thiệp filesystem vào rollout: cấm tạo file rollout rỗng, cấm touch file, cấm copy/sửa file `.jsonl` hoặc quét thư mục `.codex/sessions` để ép resume thành công. Provider Codex toàn quyền sở hữu cơ chế persistence của nó.

## Dedicated Atomic API: bindAuditorThread (WP-V4-05A / WO-V4-05AF)

Registry v2 cung cấp API mutation chuyên dụng cho Auditor thread binding:

```js
await registry.bindAuditorThread({
  project_id: projectId,
  thread_id: threadId,
  expected_project_root: expectedProjectRoot,
  expected_model_policy: expectedModelPolicy // optional
})
```

### Ràng buộc và Ngữ nghĩa (Cập nhật sau WO-V4-05AF):
1. **Atomic Mutation Queue**: Chạy hoàn toàn bên trong `serializeMutation()`. Không bao giờ sử dụng mẫu `getProject → mutate → putProject` từ bên ngoài để tránh race conditions.
2. **Thẩm quyền In-Memory có tuần tự hóa & Revalidation Filesystem Runtime**:
   - Sử dụng thẩm quyền in-memory của Registry được tuần tự hóa qua mutation queue (không thực hiện disk re-read không an toàn).
   - Ngay trước khi ghi mutation:
     1. Resolve `existingProject` hiện tại từ bộ nhớ.
     2. Canonicalize và revalidate `existingProject.project_root` trên filesystem.
     3. Chứng minh runtime canonical identity bằng đúng stored identity.
     4. Chứng minh `auditor.cwd` có cùng canonical identity.
     5. Yêu cầu và validate `expected_project_root` bắt buộc phải trùng khớp canonical identity đó.
   - Bất kỳ bước nào không khớp ném `AUDITOR_BINDING_PRECONDITION_FAILED` và không ghi đĩa.
3. **Input Validation**:
   - `projectId`: Bắt buộc tồn tại trong registry; nếu không tồn tại ném `AUDITOR_BINDING_PRECONDITION_FAILED` / `PROJECT_NOT_FOUND`.
   - `threadId`: Bắt buộc là string, không rỗng, không chứa khoảng trắng thừa (`threadId.trim() === threadId`), độ dài UTF-8 $\le 512$ bytes, không chứa ký tự điều khiển (`/[\x00-\x1f\x7f]/`). Vi phạm ném `AUDITOR_BINDING_PRECONDITION_FAILED` hoặc `REGISTRY_SCHEMA_INVALID`.
   - `expected_project_root`: Bắt buộc cung cấp. Thiếu hoặc rỗng ném `AUDITOR_BINDING_PRECONDITION_FAILED`.
4. **Same-Thread Idempotency**: Nếu `project.auditor.thread_id === threadId`, coi là idempotent:
   - Trả về `{ changed: false, project }`.
   - Không thay đổi trường `enabled` (bảo toàn trạng thái `AUDITOR_BOUND_DISABLED` nếu project đã bị disabled trước đó; không bao giờ tự động enable).
5. **Different-Thread Conflict**: Nếu `project.auditor.thread_id != null` và `!== threadId`:
   - Ném lỗi `AUDITOR_BINDING_CONFLICT` (`code: AUDITOR_BINDING_CONFLICT`).
   - Ngăn chặn việc ghi đè hoặc chiếm dụng thread ID của auditor đang gắn kết.
6. **Binding Transition**:
   - Gán `auditor.thread_id = threadId`.
   - Gán `auditor.enabled = true` (nếu đang ở trạng thái unbound `thread_id == null`).
   - Ghi atomically qua temp file + fsync + atomic rename + post-write validation.
   - Trả về `{ changed: true, project }`.
7. **Suy diễn trạng thái vận hành**:
   - `thread_id == null` $\to$ `AUDITOR_REGISTRATION_REQUIRED`.
   - `thread_id != null && enabled === true` $\to$ `AUDITOR_BOUND_READY`.
   - `thread_id != null && enabled === false` $\to$ `AUDITOR_BOUND_DISABLED`.


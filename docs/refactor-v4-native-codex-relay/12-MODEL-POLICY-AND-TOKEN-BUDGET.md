# Model policy và token budget

## 1. Logical Policy Hierarchy

Các chính sách logic được định nghĩa:
- **`auditor_fast`**: Lựa chọn model có mức reasoning effort thấp nhất khả dụng theo thứ tự ưu tiên: `none` -> `minimal` -> `low` -> `medium` -> `high` -> `xhigh` -> `max` -> `ultra`.
- **`auditor_standard`**: Lựa chọn model mặc định của provider (`isDefault === true`) với `defaultReasoningEffort` được quảng bá rõ ràng trong danh sách `supportedReasoningEfforts`. Nếu không có model nào là default, chọn model hợp lệ đầu tiên theo thứ tự catalog cùng advertised default effort của nó. Nếu có nhiều hơn 1 model claiming default, từ chối fail-closed do catalog mơ hồ (`MODEL_POLICY_CATALOG_INVALID`).
- **`auditor_deep`** & **`architecture_deep`**: Lựa chọn model có mức reasoning effort cao nhất khả dụng theo thứ tự ưu tiên: `ultra` -> `max` -> `xhigh` -> `high` -> `medium` -> `low` -> `minimal` -> `none`.
  *Lưu ý:* `architecture_deep` được chấp nhận bởi pure resolver cho turn escalation tương lai, nhưng không được phép đưa vào Registry `auditor.model_policy` trong package 06A.
- **`worker_economy`** & **`worker_standard`**: Là các khái niệm policy của worker, thuộc Antigravity engine. Tuyệt đối KHÔNG resolve worker policies qua Codex App Server catalog; resolver ném lỗi `MODEL_POLICY_INVALID_REQUEST` nếu nhận được worker policy.

## 2. Pure Model Policy Resolver (`model-policy-resolver.js`)

Module độc lập, thuần túy (pure function), không I/O, không gọi provider:
```javascript
resolveAuditorModelPolicy({
  policy,
  models,
  preferences
})
```

Output:
```javascript
{
  catalog_id,       // model.id (cho mục đích provenance / chẩn đoán)
  model,            // model.model (wire selector cho provider)
  reasoning_effort, // exact semantic effort string
  policy            // policy được resolve
}
```

Nguyên tắc bất biến:
- Tuyệt đối không hard-code tên model cụ thể trong mã nguồn production (không có string literal provider model ID, không fallback literal).
- Không đoán mò reasoning effort không được model quảng bá trong `supportedReasoningEfforts`.
- Lựa chọn theo reasoning effort preferences, hòa giải bằng `isDefault === true` hoặc giữ nguyên thứ tự provider catalog. Không sắp xếp theo tên model, display name, phiên bản hay giả định thương hiệu.
- Nếu không có model tương thích: ném `MODEL_POLICY_UNAVAILABLE` fail-closed.

## 3. Catalog Pagination & Safety Bounds (`codex-auditor-adapter.js`)

Phương thức `listModels(options)` được gia cố hỗ trợ phân trang đầy đủ:
- Tiêu thụ cả dạng provider response chuẩn `{ data: [...], nextCursor: ... }` và dạng tương thích `{ models: [...] }`.
- Tham số mặc định: `includeHidden: false`, `limit: 100`.
- Giới hạn an toàn hữu hạn:
  - `MAX_MODEL_LIST_PAGES = 50`
  - `MAX_MODEL_CATALOG_ENTRIES = 1000`
  - `MAX_CURSOR_BYTES = 512` (chuẩn hóa theo source authority)
- Ngữ nghĩa phân trang chính xác (Exact Pagination Boundary):
  - Hỗ trợ từ 1 đến 50 trang: Catalog kết thúc hợp lệ ở trang 50 (`nextCursor === null`) được chấp nhận thành công.
  - Nếu trang 50 tiếp tục trả về `nextCursor` hợp lệ (yêu cầu trang 51), adapter lập tức fail-closed với mã lỗi `CODEX_APP_SERVER_INVALID_RESPONSE` mà tuyệt đối không gửi request trang 51.
- Từ chối fail-closed nếu phát hiện vòng lặp cursor (cycle), cursor lặp lại (repeated), cursor sai định dạng, catalog vượt bound, hoặc trang malformed.

## 4. First-Turn Pinning & Registry Freshness Seal Boundary (`auditor-thread-lifecycle.js`)

Thứ tự tích hợp trong fresh bootstrap:
1. Initial Registry validation & workspace snapshot
2. `client1.initialize()` & `thread/start`
3. `beginBootstrap()`
4. Re-read persisted bootstrap authority
5. **Fresh Registry Gate A** (trước catalog I/O):
   - Đọc fresh Registry qua `registryPort.getProject(projectId)`
   - Kiểm tra nghiêm ngặt `auditor.thread_id === null` và `auditor.enabled === false`
   - Thực thi `assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProject)`
6. `client1.listModels()` (tiêu thụ toàn bộ catalog với phân trang tối đa 50 trang)
7. `resolveAuditorModelPolicy(persistedBootstrap.expected_auditor_model_policy, catalog)`
8. Đóng băng cục bộ kết quả resolved `model` và `reasoning_effort`
9. **Fresh Registry Gate B** (sau khi resolve model, ngay trước `FIRST_TURN_STARTING`):
   - Đọc fresh Registry mới qua `registryPort.getProject(projectId)` (không tái sử dụng kết quả Gate A)
   - Kiểm tra nghiêm ngặt `auditor.thread_id === null` và `auditor.enabled === false`
   - Tái thực thi `assertBootstrapAuthorityMatchesRegistry(persistedBootstrap, freshProjectAfterModelResolution)`
10. Chuyển trạng thái sang `FIRST_TURN_STARTING`
11. `startTurn({ exact threadId, input, outputSchema, model: resolvedModel, effort: resolvedEffort })`

Ngữ nghĩa thất bại tại Gate A, model resolution, hoặc Gate B (Zero-Turn Failure Semantics):
- `startTurn` gọi: 0 lần.
- Model turn: 0.
- `FIRST_TURN_STARTING`: KHÔNG được ghi vào DB.
- Active recovery record giữ nguyên ở `PROVISIONAL_THREAD` (không tự xóa provisional bootstrap).
- Client 1 được đóng an toàn (`client1.close()`).
- Registry mutation: NONE (giữ nguyên unbound).
- `AUDIT_UNCERTAIN`: KHÔNG được ghi vì chưa có turn nào được dispatch.

## 5. Phục hồi và Resume không gọi Model List

Khi phục hồi operation (`recoverAuditorBootstrap`) hoặc giải quyết bất định (`resolveAuditorBootstrapUncertainty`), tuyệt đối KHÔNG gọi `model/list`. Các luồng này xử lý thread/turn đã tồn tại trong lịch sử; không được phép tái resolve để thay đổi authority của model.

## 6. Token Usage Observability (`token-usage-observer.js` & `codex-auditor-adapter.js`)

Hoàn thành quan sát token usage từ provider thông qua notification authoritative:
```text
thread/tokenUsage/updated
```

### 6.1. Cấu trúc dữ liệu chuẩn từ App Server
```javascript
{
  threadId,
  turnId,
  tokenUsage: {
    total: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens
    },
    last: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens
    },
    modelContextWindow
  }
}
```

### 6.2. Các nguyên tắc bất biến (Semantic Rules)
1. **Authoritative Snapshots**: Giá trị từ provider là snapshot chính thức. Tuyệt đối KHÔNG tái dựng usage từ text streaming, KHÔNG đếm token cục bộ, KHÔNG cộng dồn lặp lại các notification, KHÔNG ước lượng chi phí (cost), KHÔNG tự suy diễn cạn kiệt ngân sách (budget exhaustion).
2. **Bảo tồn nguyên vẹn Total và Last**: `tokenUsage.total` là snapshot tích lũy của provider; `tokenUsage.last` là snapshot của turn gần nhất. Bảo tồn cả hai chính xác, không suy diễn trường này từ trường kia, không ép buộc các đẳng thức số học như `totalTokens == inputTokens + outputTokens` do sự khác biệt trong hạch toán caching/reasoning.
3. **Snapshot Replacement (Không cộng dồn)**: Nhiều notification cho cùng một thread/turn là cập nhật snapshot mới thay thế snapshot cũ (`A -> B`), không bao giờ thực hiện `A + B`.
4. **Exact Turn Correlation & Early-Notification Race**:
   - Khi đã có local ownership (`turnId -> threadId`), notification phải khớp đúng `threadId`. Mismatch sẽ bị từ chối với `TOKEN_USAGE_THREAD_MISMATCH` và không ghi đè dữ liệu hợp lệ.
   - Giải quyết race condition khi notification đến trước khi response của `turn/start` hoàn tất: lưu tạm vào bộ đệm bounded pending map (`_pendingTokenUsage`); sau khi local ownership được ghi nhận, pending notification hợp lệ sẽ được điều hòa (reconcile) vào observer. Nếu threadId không khớp, pending notification bị loại bỏ và phát sinh mismatch.
5. **Giới hạn lưu trữ (Bounded Storage)**:
   - Giới hạn lưu trữ: `threads <= 1024`, `turns <= 4096`.
   - Cơ chế thu dọn: Oldest-insertion eviction tất định (`map.keys().next().value`).
   - Snapshot trả về luôn được deep detach để bảo vệ tính bất biến.
6. **Cách ly hoàn toàn với Lifecycle**: Dữ liệu observability không ảnh hưởng và không được phép làm gián đoạn hay thay đổi quyết định audit (`AuditDecisionV1`), trạng thái recovery store, hay Registry binding. Malformed notification bị loại bỏ khỏi observability state mà không làm dừng hay fail tiến trình audit.
7. **No Budget Enforcement By Design**: WO-V4-06B tuyệt đối không áp đặt production token budgets, không có numeric budget limit, không có automatic interrupt. Toàn bộ logic kiểm soát và dừng theo ngân sách thuộc về **WP-V4-12**.

Trạng thái:
- **WP-V4-06A**: `APPROVED_CLOSED`
- **WP-V4-06B**: `COMPLETE`
- **WP-V4-06**: `COMPLETE`
- **WP-V4-07**: `NOT_STARTED`
- **WP-V4-12**: `PENDING` (Budget enforcement)

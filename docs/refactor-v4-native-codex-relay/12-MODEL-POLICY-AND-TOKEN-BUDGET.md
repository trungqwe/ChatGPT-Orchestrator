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
  - `MAX_CURSOR_BYTES = 4096`
- Từ chối fail-closed nếu phát hiện vòng lặp cursor (cycle), cursor lặp lại (repeated), cursor sai định dạng, catalog vượt bound, hoặc trang malformed.

## 4. First-Turn Pinning Boundary (`auditor-thread-lifecycle.js`)

Thứ tự tích hợp trong fresh bootstrap:
1. Initial Registry validation & workspace snapshot
2. `client1.initialize()` & `thread/start`
3. `beginBootstrap()`
4. Re-read persisted bootstrap authority
5. Fresh post-persistence Registry read (R3 gate)
6. Strict UNBOUND check & authority verification
7. `client1.listModels()` (tiêu thụ toàn bộ catalog)
8. `resolveAuditorModelPolicy(persistedBootstrap.expected_auditor_model_policy, catalog)`
9. Chuyển trạng thái sang `FIRST_TURN_STARTING`
10. `startTurn({ exact threadId, input, outputSchema, model, effort })`

Nếu bước resolve hoặc list models thất bại:
- `startTurn` gọi: 0 lần.
- Model turn: 0.
- `FIRST_TURN_STARTING`: KHÔNG được ghi vào DB.
- Active recovery record giữ nguyên ở `PROVISIONAL_THREAD`.
- Registry giữ nguyên trạng thái UNBOUND.
- Client 1 được đóng an toàn.
- Không chuyển sang `AUDIT_UNCERTAIN` vì chưa dispatch lượt inference nào.

## 5. Phục hồi và Resume không gọi Model List

Khi phục hồi operation (`recoverAuditorBootstrap`) hoặc giải quyết bất định (`resolveAuditorBootstrapUncertainty`), tuyệt đối KHÔNG gọi `model/list`. Các luồng này xử lý thread/turn đã tồn tại trong lịch sử; không được phép tái resolve để thay đổi authority của model.

## 6. Token Usage Observability (Kế hoạch WO-V4-06B)

Đo lường token, usage metadata và budget limits được bảo lưu cho package tiếp theo WO-V4-06B sau khi WO-V4-06A được review hoàn tất.

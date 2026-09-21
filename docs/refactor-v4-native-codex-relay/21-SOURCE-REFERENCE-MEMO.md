# Source Reference Memo

## 1. Official Provider Capability Facts

OpenAI Codex App Server protocol (qua stdio JSONL: `initialize` / `initialized`, `model/list`, `thread/start`, `thread/resume`, `thread/read`, `turn/start`, `turn/completed`, `turn/interrupt`, `review/start`, `server-initiated requests`, và `outputSchema`):

- **Turn Completed & Structure**:
  - `TurnCompletedNotification` (`method: "turn/completed"`) chứa object `turn: Turn`.
  - `Turn` chứa các trường định danh và trạng thái: `id`, `status` (`inProgress`, `completed`, `interrupted`, `failed`), `items: ThreadItem[]`, và `itemsView` (`full`, `summary`, `notLoaded`).
- **ThreadItem & MessagePhase**:
  - Item loại `agentMessage` mang trường `text` (nội dung assistant message) và trường `phase` tùy chọn.
  - `MessagePhase` gồm hai giá trị chuẩn: `"commentary"` và `"final_answer"`.
  - `phase` có thể là `null` hoặc `undefined` trong một số context provider hoặc tương thích ngược.
- **Output Schema Enforcement**:
  - `TurnStartParams.outputSchema` được provider sử dụng để ép buộc (constrain) structured output của final assistant message.
- **Thread Start & Sandbox Mode**:
  - `ThreadStartParams`: Chứa các trường `{ cwd, approvalPolicy: "never", sandbox: SandboxMode }`, trong đó `SandboxMode = "read-only" | "workspace-write" | "danger-full-access"` (dạng kebab-case).
  - `TurnStartParams`: Chứa trường `sandboxPolicy: SandboxPolicy`, trong đó `SandboxPolicy` có các biến thể `{ type: "readOnly", ... }`, `{ type: "workspaceWrite", ... }`, `{ type: "dangerFullAccess" }` (dạng camelCase).
- **Review Target**:
  - `ReviewTarget`: Là structured object (`uncommittedChanges`, `baseBranch`, `commit`, `custom`), không phải plain string.
- **Lazy Rollout Materialization (Codex 0.154.0)**:
  - `thread/start` khởi tạo thread trong bộ nhớ với `status: { type: "idle" }` và gán metadata đường dẫn rollout.
  - Codex may materialize durable history once the first meaningful user turn begins; WP05 proves durability explicitly through recovery/resume and does not rely on the exact filesystem-materialization event.
  - `thread/read` truy vấn trực tiếp session in-memory nên đọc thành công exact thread ID ngay cả trước khi rollout materialized.

---

## 2. Orchestrator Policy (WP-V4-03 / WP-V4-04 Distinctions)

1. **Transport Policy (WP-V4-03A / WO-V4-03AG)**:
   - Chỉ cho phép transport stdio JSONL cục bộ với `shell: false`.
   - Khởi tạo với `clientInfo` tĩnh và không bật `experimentalApi`. Write authority bắt buộc hoàn thành ghi `initialized` trước khi vào `READY`.
   - Server-initiated requests mặc định fail-closed với quyết định `{ decision: "decline" }` do chưa có giao diện duyệt của operator; không bao giờ tự động phê duyệt (auto-approve); không log nhạy cảm toàn bộ payload.
   - Chỉ cho phép `review/start` với `delivery = "inline"`; từ chối `detached`. Target bắt buộc là structured object.
   - Bắt buộc `cwd` tuyệt đối khi `thread/start` và cấu hình `sandbox: "read-only"`, `approvalPolicy: "never"`.
   - Loại bỏ hoàn toàn việc forward các param test hook (`_`).
   - Ánh xạ local turn ownership (`turnId -> threadId`) và bounded completion cache để triệt tiêu race condition.
   - Timeout sau write, client `close()`, hoặc crash tiến trình con khi đang chạy lệnh có side-effect chuyển sang `CODEX_APP_SERVER_REQUEST_UNCERTAIN` và không tự động retry.
   - Giới hạn kích thước dòng stdout 8 MiB, giới hạn stderr tail 64 KiB, giới hạn text input 1 MiB.

2. **Semantic Authority Contract Policy (WP-V4-04)**:
   - **No Prose Authority**: Model output hoàn toàn là untrusted input. Mọi quyết định điều phối lifecycle chỉ được rút ra từ schema contract `AuditDecisionV1`.
   - **Terminal Turn Snapshot Authority**: Chỉ chấp nhận turn có `turn.status == 'completed'` và `turn.itemsView == 'full'`. Turn `inProgress`, `interrupted`, `failed` hoặc `itemsView != 'full'` đều fail-closed.
   - **Final Answer Disambiguation**: Chỉ chấp nhận `agentMessage` có `phase == 'final_answer'`. Nếu không có `final_answer`, cho phép đúng một message có null/unknown phase (để tương thích ngược). Nếu có nhiều hơn một final_answer hoặc nhiều hơn một unknown-phase message, reject với `AUDIT_DECISION_OUTPUT_AMBIGUOUS`.
   - **Commentary Never Authority**: Message có `phase == 'commentary'` tuyệt đối không được coi là decision, kể cả khi chứa JSON hợp lệ.
   - **Exact Context Revalidation**: 4 trường identity (`project_id`, `audit_subject_id`, `auditor_thread_id`, `workspace_state_observed`) được khóa cứng trong output schema và bắt buộc revalidate bằng so sánh byte-for-byte ở local validator.
   - **Duplicate-Key Rejection**: Parser JSON từ chối mọi trường hợp duplicate key ở bất kỳ cấp độ nào (`AUDIT_DECISION_DUPLICATE_KEY`).
   - **Workspace State Echo Limitation**: Việc `workspace_state_observed` khớp với input chỉ chứng minh auditor đã quan sát đúng state được giao. Tầng relay điều phối hành động trong tương lai bắt buộc phải tính toán lại một fresh workspace state ngay trước khi apply side-effect.

4. **Explicit Uncertainty Resolution Policy (WP-V4-05AG)**:
   - **Two-Stage Durability**: `AUDIT_UNCERTAIN` is no longer a permanent dead-end. It can be resolved via `resolveAuditorBootstrapUncertainty()` by querying provider thread durability authority (`thread/read`).
   - **Zero Prose Authority for Non-Completed Turns**: For turn status `interrupted` or `failed`, model output is never parsed or credited with decision authority, even if partial messages contain well-formed JSON. The state strictly transitions to `AUDIT_TERMINAL_NO_DECISION`.
   - **Strict Completed Turn Validation**: Transition to `DECISION_VALIDATED` from `AUDIT_UNCERTAIN` requires `itemsView == 'full'`, exactly 1 turn matching `turn_id`, and full valid `AuditDecisionV1` extraction. Any failure leaves `AUDIT_UNCERTAIN` unchanged.
   - **Clean Separation of Resolution and Cleanup**: Resolver persists `AUDIT_TERMINAL_NO_DECISION` and leaves the active row in SQLite. Only subsequent `recoverAuditorBootstrap()` cleans the active row while retaining history.

5. **Model Policy Resolution Authority & First-Turn Pinning (WP-V4-06A)**:
   - **Zero Hard-Coded Model Authority**: Không có bất kỳ tên model cụ thể nào trong mã nguồn production. Mọi mapping từ logical policy sang wire model selector đều dựa vào catalog động qua `model/list`.
   - **Semantic Reasoning Effort Preferences**: Lựa chọn theo semantic reasoning effort strings (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`). Model mặc định hoặc thứ tự catalog của provider là tie-breaker duy nhất.
   - **First-Turn Pinning Boundary**: Việc resolve catalog chỉ xảy ra ở fresh bootstrap sau khi vượt qua R3 Registry freshness gate và ngay trước `FIRST_TURN_STARTING`. Cặp `model` và `effort` được truyền trực tiếp vào `startTurn`.
   - **Fail-Closed on Resolution Failure**: Bất kỳ lỗi nào trong catalog fetch hoặc policy resolution đều dừng vòng đời, để active recovery record ở `PROVISIONAL_THREAD`, gọi `startTurn` 0 lần, và không gây chuyển trạng thái sang `AUDIT_UNCERTAIN`.
   - **Zero Catalog Calls in Recovery**: Phục hồi operation cũ hoặc giải quyết bất định tuyệt đối không gọi `model/list`, đảm bảo tính bất biến của authority trong lịch sử.

---

## 3. Architecture Status

- **WP-V4-02**: APPROVED / CLOSED (Registry v2 schema migration).
- **WP-V4-03**: APPROVED / CLOSED (Transport foundation & real App Server runtime acceptance).
- **WP-V4-04**: APPROVED / CLOSED (`AuditDecisionV1` pure semantic contract & test suite).
- **WP-V4-05A**: APPROVED / CLOSED (Durable thread lifecycle & recovery store).
- **WP-V4-05AG**: APPROVED / CLOSED (Explicit `AUDIT_UNCERTAIN` terminal-turn resolution, V1→V2 atomic migration rollback guarantee, and post-persistence pre-first-turn Registry freshness gate).
- **WP-V4-05B**: APPROVED / CLOSED (R9 real durable lifecycle proven: V1→V2 migration, legacy retirement, single model turn, completed-turn hydration, and cross-process resume).
- **WP-V4-05**: COMPLETE (Final external closure review passed; all production, lifecycle, and recovery contracts verified).
- **WP-V4-06A**: APPROVED_CLOSED (Resolved model policy authority and first-turn pinning).
- **WP-V4-06B**: COMPLETE (Pure token usage observer `token-usage-observer.js`, adapter integration for `thread/tokenUsage/updated`, exact turn correlation, early race resolution, snapshot preservation, bounded storage).
- **WP-V4-06**: COMPLETE (All model policy resolution and token usage observability contracts complete; budget enforcement reserved for WP-V4-12).
- **WP-V4-07**: NOT_STARTED.

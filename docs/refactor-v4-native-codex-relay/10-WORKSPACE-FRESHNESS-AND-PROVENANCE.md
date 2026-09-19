# Workspace Freshness và Provenance

## 1. Snapshot Components

Workspace snapshot (được tính bởi `workspace-state.js`) bao gồm:
- Canonical project root (`project_root_canonical`)
- Git HEAD commit SHA
- Index (staged) và worktree (unstaged) cryptographic digests
- Untracked file manifest digest
- Submodule gitlinks và dirty status digests
- Deterministic `workspace_state_id`

---

## 2. Decision Echo vs Fresh Action Gate

Phân định nghiêm ngặt hai khái niệm:

1. **`decision.workspace_state_observed` (Echo)**:
   - Là giá trị snapshot ID được cung cấp cho auditor turn qua `expectedContext`.
   - Output schema và local validator kiểm tra giá trị này phải khớp byte-for-byte với trusted context ban đầu.
   - Việc `decision.workspace_state_observed == expectedContext.workspace_state_observed` chỉ chứng minh auditor đã quan sát đúng snapshot được giao. Nó **không chứng minh** workspace hiện tại vẫn còn giữ nguyên trạng thái đó.
   - **WP-V4-04 does not recompute current workspace.** WP04 là pure semantic authority contract module.

2. **Relay Freshness Recomputation (Action Gate)**:
   - Trước khi thực hiện bất kỳ side effect nào (như `DISPATCH_WORKER` hoặc `APPROVE_WORK_PACKAGE`), tầng relay điều phối tương lai **bắt buộc phải tính toán lại một fresh workspace state**.
   - Nếu workspace hiện tại khác với `decision.workspace_state_observed`, hành động bị từ chối với lỗi `STALE_AUDIT_STATE`.
   - Không được dựa vào model echo để khẳng định workspace freshness tại thời điểm dispatch/approval.

---

## 3. Independent Provenance

- Codex đọc trực tiếp source, status, diff, git history và test output trên filesystem cục bộ trong chế độ read-only sandbox.
- Không cần push GitHub hoặc tạo SourcePack trước khi audit.
- `WorkerReport` hoàn toàn là `UNTRUSTED_HINT`; mọi quyết định phải dựa trên `independent_verification` do chính auditor thực hiện.
- Bất kỳ symlink escape, submodule traversal không an toàn, hoặc không xác định được workspace state đều fail-closed ngay lập tức.

# WO-V4-02AF — Khôi phục thẩm quyền kiểm thử cho V4 quarantine

# 1. Baseline

- Repository: `https://github.com/trungqwe/ChatGPT-Orchestrator`.
- Parent: `1720badac3b51e9cdc7839ac9aeffe7b4745c014` (`refactor(auditor): quarantine removed web bridge`).
- Branch: `review/v4-wp02a-quarantine-final`, tạo từ đúng parent trong worktree riêng, sạch trước khi sửa.
- Cài dependency bằng `npm ci --ignore-scripts --no-audit --no-fund`; `node_modules` được Git bỏ qua.

# 2. Test Authority Problem

Trước corrective, `npm test` chỉ chạy `legacy-auditor-quarantine` và `native-transition`. Hai suite đó chứng minh trạng thái đóng đường auditor cũ nhưng không chạy sáu suite regression cho broker substrate được giữ lại trong V4.

# 3. Default npm Test Contract

`npm test` hiện chạy nối tiếp tám suite: legacy auditor quarantine, native transition, semantic broker CLI, SQLite lifecycle store, broker core, worker adapter, workspace state và registry. Lệnh hoàn tất với exit code 0. Hai script `test:legacy-api` và `test:legacy-closed-loop` chỉ dành cho kiểm tra legacy tùy chọn; không tham gia cổng mặc định.

# 4. Quarantine Contract Preserved

Suite quarantine chạy độc lập với exit code 0, kiểm tra đủ chín request legacy trả HTTP 410, `ok=false`, `code=LEGACY_AUDITOR_REMOVED` và `state=NATIVE_AUDITOR_NOT_IMPLEMENTED`. `GET /api/status` trả auditor `unavailable` và trạng thái trên, không có `chatgptProxy`. Suite native transition chạy độc lập với exit code 0; catalog auditor tại `/api/models` là `unavailable`, `models=[]`, `defaultModel=null`. Các handler legacy vẫn nằm sau middleware 410; corrective không sửa production code.

# 5. Core Regression Evidence

| Suite chạy độc lập | Kết quả |
|---|---|
| Semantic broker CLI | `CLI-001..CLI-050: 50/50 PASS` |
| SQLite lifecycle store | `SL-001..SL-047: 47/47 PASS` |
| Broker core | `BC-001..BC-052: 52/52 PASS` |
| Worker adapter | `WA-001..WA-055: 55/55 PASS` |
| Workspace state | `WS-001..WS-051: 51/51 PASS` |
| Registry | `RG-001..RG-039: 39/39 PASS` |

Tất cả sáu suite này cũng chạy trong `npm test`. `node --check` cho hai test quarantine/transition và `git diff --check` đều có exit code 0. Đây là bằng chứng local; không có kết quả GitHub CI trong WorkOrder này.

# 6. Legacy Integration Test Classification

- `test/pipeline-api.test.js`: `LEGACY_INTEGRATION / NOT_DEFAULT`. Chạy riêng, exit code 1 tại test 3: assertion `Found registered project workspace-test` thất bại vì fixture project đó không có trong môi trường hiện tại. Test 1 (static UI) và test 2 (health) đã qua. Không sửa fixture hoặc nới assertion.
- `test/closed-loop.test.js`: `RETIRED_BY_V4_ARCHITECTURE`. Không chạy làm thẩm quyền V4 vì còn đòi `chatgpt-web/high`, HTTP 200 từ legacy auditor và luồng Web WorkOrder/verdict đã bị loại bỏ.

# 7. Production Scan

Quét tĩnh `server.js`, `desktop-main.js`, `agent-broker-cli.js`, `package.json`, các file JavaScript trong `lib` và JavaScript/HTML trong `public` không thấy `codex-chatgpt-web`, `127.0.0.1:17841`, `chatgpt-web/` hoặc `codex exec` (exit code 0 theo quy ước không có match). Test quarantine cũng chặn cả bốn mẫu trong các entrypoint production chính. Các mẫu trong test legacy và dữ liệu lịch sử không phải đường thực thi production.

# 8. Documentation Reconciliation

`02-CURRENT-STATE-AND-CARRIED-FORWARD-ASSETS.md` ghi đúng package description đã được cập nhật: `UPDATED_DURING_V4_02A_QUARANTINE`. `17-MASTER-CHECKLIST.md` đánh dấu production bridge quarantine hoàn tất; Registry v2, App Server adapter, one-shot, shadow và legacy cleanup vẫn chưa hoàn tất.

# 9. Scope Compliance

Các file thay đổi chỉ gồm `pipeline-ui/package.json`, `pipeline-ui/test/refactor/legacy-auditor-quarantine.test.js`, hai tài liệu hiện trạng/checklist và báo cáo này. `pipeline-ui/test/native-transition.test.js` không cần sửa. Đối chiếu scope bằng `git diff --name-status 1720badac3b51e9cdc7839ac9aeffe7b4745c014...HEAD` sau commit.

server.js modified: NO

public UI modified: NO

desktop-main.js modified: NO

broker production modified: NO

registry production modified: NO

SQLite schema modified: NO

worker adapter production modified: NO

App Server implemented: NO

Registry v2 started: NO

Legacy Web auditor re-enabled: NO

codex-chatgpt-web restored: NO

port 17841 restored: NO

codex exec auditor path restored: NO

Real auditor invocation: NO

Real worker dispatch: NO

# 10. Recommendation

`READY_FOR_WP_V4_02A_FINAL_EXTERNAL_REVIEW`. Cổng deterministic V4 và regression substrate đã được khôi phục; lỗi fixture của legacy pipeline API được phân loại riêng, không che giấu thành công CI hay xem suite Web đã nghỉ là thẩm quyền. Chưa bắt đầu WP-V4-02B hoặc WP-V4-03.

# Work Order Report: WO-V4-03B
## Real Native Codex App Server Transport Acceptance

### Executive Summary

| Attribute | Value |
|---|---|
| Repository | `https://github.com/trungqwe/ChatGPT-Orchestrator` |
| Branch | `review/v4-wp03b-real-app-server-acceptance` |
| Parent Commit | `64f7ba894383f80b29179a5bca342e29866baa32` |
| Installed Codex Version | `codex-cli 0.154.0` |
| Transport Protocol | stdio JSONL (`codex app-server --listen stdio://`) |
| Real Runtime Evidence | LOCAL OPERATOR / AGENT EXECUTION |
| GitHub Source Evidence | SEPARATE |
| GitHub CI | NOT_PRESENT |
| Overall Result | `WP_V4_03B_BLOCKED` |

---

# 1. Baseline

- **Approved Parent SHA**: `64f7ba894383f80b29179a5bca342e29866baa32` (`fix(auditor): correct thread sandbox wire enum`).
- **Initial Repository Status**:
  - `git branch --show-current`: `review/v4-wp03a-codex-app-server-transport-seal`
  - Switched to: `review/v4-wp03b-real-app-server-acceptance`
  - Ambient untracked file: `manifest.json` preserved untouched.
  - Zero working tree modifications.
- **Pre-Acceptance Registry Baseline**:
  - File path: `%USERPROFILE%\.orchestrator\projects.json`
  - SHA-256: `81BA9A424D66694F80EDA66A607AF3549AB7E7AB72E1E13229FEAD84EC9F10EE`
- **Pre-Acceptance Test Regression**:
  - Executed `npm test` in `pipeline-ui` (10 test suites, 380 total assertions).
  - All suites passed cleanly (exit code 0):
    - Agent Broker CLI: 50/50 PASS
    - SQLite Lifecycle Store: 47/47 PASS
    - Workspace State: 48/48 PASS
    - Registry Migration v2: 52/52 PASS
    - Codex App Server Client & Adapter: 84/84 PASS
    - Legacy Registry & Store suites: 99/99 PASS

---

# 2. Installed Codex Version

- Executed command: `codex --version`
- Exact command output:
  ```text
  codex-cli 0.154.0
  ```

---

# 3. Installed Stable Schema Evidence

Generated TypeScript schema bindings via `codex app-server generate-ts --out <TEMP_DIR>` into temporary directory outside git, inspected bounded facts, and deleted temporary directory immediately.

| Schema Fact | Requirement | Installed Evidence | Conformance |
|---|---|---|---|
| `v2/ThreadStartParams.ts` has `sandbox` | YES | `sandbox?: SandboxMode \| null;` | PASS |
| `v2/SandboxMode.ts` contains `read-only` | YES | `export type SandboxMode = "read-only" \| "workspace-write" \| "danger-full-access";` | PASS |
| `v2/AskForApproval.ts` contains `never` | YES | `export type AskForApproval = "untrusted" \| "on-request" \| { "granular": ... } \| "never";` | PASS |

---

# 4. Real Initialize Evidence

- Transport invocation: `codex app-server --listen stdio://` via stdio pipes (`shell: false`).
- Invocation: `adapter.initialize()` sending standard JSON-RPC 2.0 `initialize` request followed by `initialized` notification.
- Status: **PASS**
- Spawned App Server Child Process PID: `30804`
- Handshake result metadata returned by provider:
  ```json
  {
    "userAgent": "chatgpt_orchestrator/0.154.0 (Windows 10.0.19045; x86_64) unknown (chatgpt_orchestrator; 4)",
    "codexHome": "C:\\Users\\Admin\\.codex",
    "platformFamily": "windows",
    "platformOs": "windows"
  }
  ```

---

# 5. Real Model List Evidence

- Invocation: `adapter.listModels()` sending `model/list`.
- Status: **PASS**
- Return type: `Array` (length = 5)
- Available models returned by real runtime:
  - `gpt-6-astra`
  - `gpt-5.6-sol`
  - `gpt-5.6-terra`
  - `gpt-5.6-luna`
  - `gpt-5.5`
- No model policy enforced, no model chosen for turn execution.

---

# 6. Disposable Workspace

- Temporary directory created outside git repository:
  `C:\Users\Admin\AppData\Local\Temp\orchestrator-v4-wp03b-1789839389784-2728`
- Baseline inspection before App Server start:
  - File count: `0`
  - Child directory count: `0`
- Pure disposable isolation verified.

---

# 7. Real Thread Start Evidence

- Invocation: `adapter.startThread({ cwd: tempDir })`
- Security defaults enforced by reviewed adapter without caller overrides:
  - `approvalPolicy`: `"never"`
  - `sandbox`: `"read-only"`
- Provider response: **PASS**
- Returned exact opaque thread ID $T$:
  ```text
  01a0babd-b491-7362-9723-7343f129d29f
  ```
- Provider status returned: `{"type": "idle"}`
- Provider allocated rollout path:
  `C:\Users\Admin\.codex\sessions\2026\09\20\rollout-2026-09-20T00-36-29-01a0babd-b491-7362-9723-7343f129d29f.jsonl`
- Zero turns, zero reviews started.

---

# 8. Exact Thread Read Evidence

- Invocation: `adapter.readThread({ threadId: T, includeTurns: false })`
- Provider response: **PASS**
- Returned thread ID: `01a0babd-b491-7362-9723-7343f129d29f`
- Exact ID verification: `readId === T` -> **YES**
- Verified turns array from provider: `turns: []` (count = 0).
- Confirmed zero turns were executed or hydrated.

---

# 9. Exact Thread Resume Evidence

- Invocation: `adapter.resumeThread({ threadId: T })`
- Provider response: **BLOCKED / PROVIDER REJECTION**
- Exact JSON-RPC Error returned by real App Server:
  ```json
  {
    "code": -32600,
    "message": "no rollout found for thread id 01a0babd-b491-7362-9723-7343f129d29f"
  }
  ```
- Root Cause Analysis:
  1. In `codex-cli 0.154.0`, calling `thread/start` creates a thread session in memory in an `idle` state.
  2. Codex CLI creates and writes rollout files (`.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) on disk only when turns or write actions occur.
  3. When `thread/resume` is requested for a thread that is not actively executing a turn, Codex App Server attempts to load the thread from disk via its rollout file.
  4. Because no turn was executed on this disposable thread, no rollout file exists on disk.
  5. As a result, Codex App Server fails closed with `-32600: no rollout found for thread id`.
  6. By contrast, `thread/read` succeeds because it queries the active in-memory session.

---

# 10. Thread Identity Stability

| Operation | Thread ID | Status |
|---|---|---|
| `thread/start` | `01a0babd-b491-7362-9723-7343f129d29f` | PASS |
| `thread/read` | `01a0babd-b491-7362-9723-7343f129d29f` | PASS (Exact Match) |
| `thread/resume` | N/A (Provider Error -32600) | BLOCKED |
| Identity Stability | **BLOCKED** (cannot verify resume ID) | BLOCKED |

---

# 11. No Turn / Review Evidence

- `adapter.startTurn()` called: **NO**
- `adapter.startReview()` called: **NO**
- `adapter.interruptTurn()` called: **NO**
- Worker dispatch executed: **NO**
- Orchestrator Registry binding: **NO**
- Model reasoning token cost: **0 tokens**

---

# 12. Process Cleanup

- Exact spawned App Server child PID: `30804`
- Shutdown method: `adapter.close()`
- Post-close process probe: `process.kill(30804, 0)` returned `ESRCH` (process cleanly terminated).
- Leaked test child processes: `0`
- Global process kill (`taskkill /IM codex.exe`) executed: `NO` (unrelated background Codex processes untouched).

---

# 13. Workspace / Registry Immutability

- **Temporary Workspace Mutation**:
  - Files before: `0`, Files after: `0`
  - Dirs before: `0`, Dirs after: `0`
  - Workspace source mutation: **NO**
- **Repository Git Working Tree**:
  - Tracked file modifications: `0`
  - Untracked additions: `0` (ambient `manifest.json` unchanged)
  - Repository source modified by runtime: **NO**
- **Registry Immutability**:
  - File: `%USERPROFILE%\.orchestrator\projects.json`
  - Pre-acceptance SHA-256: `81BA9A424D66694F80EDA66A607AF3549AB7E7AB72E1E13229FEAD84EC9F10EE`
  - Post-acceptance SHA-256: `81BA9A424D66694F80EDA66A607AF3549AB7E7AB72E1E13229FEAD84EC9F10EE`
  - Real Registry modified: **NO**
  - Disposable thread persisted: **NO**

---

# 14. Non-Blocking Documentation Debt

- **Classification**: `NON_BLOCKING_DOCUMENTATION_DEBT`
- **Location**: `pipeline-ui/lib/auditor/codex-auditor-adapter.js` (line 174)
- **Description**: JSDoc comment states `Sends approvalPolicy="never" and sandbox="readOnly"` while production code at line 212 correctly sends `sandbox: 'read-only'`.
- **Action**: Preserved untouched during WP03B (zero production code edits). Scheduled for correction in the next approved code-touch package.

---

# 15. Scope Compliance

- Production code modified: 0 lines
- Test code modified: 0 lines
- Temporary test harness: Created outside repository in scratch space, zero repo contamination.
- Zero turns or reviews initiated.

---

# 16. Recommendation

- Result: **`WP_V4_03B_BLOCKED`**
- Findings:
  1. The core Native Codex App Server stdio transport operates cleanly with the installed `codex-cli 0.154.0` binary.
  2. Handshake (`initialize` / `initialized`), model enumeration (`model/list`), thread creation (`thread/start`), and thread inspection (`thread/read`) were 100% successful against the real provider.
  3. Security enforcement (`approvalPolicy = "never"`, `sandbox = "read-only"`) was verified by provider acceptance.
  4. Process lifecycle and workspace/registry immutability were verified.
  5. The acceptance is blocked solely on `thread/resume` behavior: Codex App Server v0.154.0 requires an on-disk session rollout file to resume an idle thread, but does not write a rollout file until at least one turn or write action occurs.
- Proposed Remediation:
  - Issue a corrective Work Order to specify how Orchestrator handles `thread/resume` vs `thread/read` lifecycle:
    - E.g., clarify that `thread/read` is the canonical liveness and status query for newly bound / zero-turn threads, while `thread/resume` is used only after turns have been persisted to rollout; OR define the required turn initiation / session persistence behavior.

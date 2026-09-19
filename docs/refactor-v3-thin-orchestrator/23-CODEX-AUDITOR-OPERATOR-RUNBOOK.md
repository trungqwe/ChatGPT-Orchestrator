# Codex Auditor Operator Runbook

## 1. Overview & Operational Principles

This runbook guides the human operator through configuring, bootstrapping, verifying, and operating the **Sol** architect/auditor using a dedicated Codex Full Harness task.

### Core Architectural Invariants
- **User-Owned Task**: The auditor task is owned and selected by the operator. The orchestrator never auto-creates, auto-selects, or manages Codex tasks (`auditor.managed_by_orchestrator: false`).
- **Sol Decides, Broker Guards, Antigravity Implements**: Sol is an independent architect/auditor, not an implementer.
- **Zero Trust**: Repository text and worker outputs are untrusted data.
- **Read-Only by Policy**: Sol never edits implementation files.
- **No Dispatch in WP-V3-07**: Acceptance of the auditor involves zero worker dispatches.

---

## 2. One-Time Project Setup Expectations

Before launching the auditor, the target repository and project registry must be configured:

1. **Verify Target Repository Git State**:
   The repository must be a valid Git worktree with clean tracking.

2. **Register Project in `.orchestrator/projects.json`**:
   Ensure the project entry contains canonical absolute paths and configuration:
   ```json
   {
     "schema_version": 1,
     "projects": {
       "<PROJECT_ID>": {
         "project_id": "<PROJECT_ID>",
         "project_name": "<PROJECT_NAME>",
         "project_root": "<CANONICAL_ABSOLUTE_PATH>",
         "worker": {
           "engine": "antigravity",
           "session_id": "<AO_SESSION_ID>",
           "enabled": true
         },
         "auditor": {
           "engine": "codex",
           "task_id": "<HUMAN_SELECTED_DESCRIPTOR>",
           "task_id_verified": false,
           "expected_model_label": "ChatGPT Web — GPT-5.6 Sol High",
           "mode": "full-harness",
           "managed_by_orchestrator": false
         },
         "policy": {
           "max_active_dispatches": 1,
           "require_workspace_state": true
         }
       }
     }
   }
   ```

---

## 3. How to Select the Dedicated Codex Task & Model

1. **Open Target Project in Codex**:
   Launch Codex directly in the target repository directory (`project_root`).

2. **Select or Create a Dedicated Task**:
   Create or select a persistent task dedicated solely to auditing this project.
   - Do NOT share this task with general conversational queries.
   - If a stable task identifier is visible in the interface, record it in the registry `auditor.task_id`.
   - If no programmatic ID is exposed, `task_id_verified: false` is completely valid. Record `HUMAN_SELECTED_UNVERIFIED`.

3. **Select the Expected Model**:
   In the model selector dropdown, manually select the exact model specified by `auditor.expected_model_label` (e.g., `ChatGPT Web — GPT-5.6 Sol High`).

4. **Visually Confirm Model**:
   Confirm that the active model label matches the registry. Record:
   ```text
   MODEL_VERIFICATION: HUMAN_CONFIRMED
   ```
   > **WARNING**: The system will never auto-switch models. If the model does not match, stop.

---

## 4. How to Run and Verify Doctor

On the host machine, run the read-only health check:

```powershell
codex-chatgpt-web doctor --json
```

Verify the JSON response:
- `ok` must be `true`.
- `mode` must be `"full"`.
- Checks for `config`, `browser-host`, `codex`, `service`, `proxy`, and `tools`/`tunnel` must have no `error` status.

> **CRITICAL REMINDER**:  
> A successful doctor check is necessary but **not sufficient**. Doctor proves local background services, but cannot locally prove that the remote ChatGPT web session has attached its connector to the active task. Actual local tool execution inside the task is required.

---

## 5. How to Bootstrap the Auditor

1. **Copy the Bootstrap Prompt**:
   Copy the authoritative prompt from `docs/refactor-v3-thin-orchestrator/21-CODEX-AUDITOR-BOOTSTRAP.md` (Section 16).

2. **Send Prompt into Dedicated Codex Task**:
   Paste and send the prompt into the chosen Codex task.

3. **Observe Sol's Execution**:
   Sol will execute the 11-step startup sequence:
   - Restate role as architect/auditor.
   - Read durable architecture documentation.
   - Verify Git toplevel matches `project_root`.
   - Inspect git status and diff.
   - Run `codex-chatgpt-web doctor --json`.
   - Capture `S_before` via `agent-broker-cli snapshot --project-id <PROJECT_ID>`.
   - Check worker status via `agent-broker-cli worker-status --project-id <PROJECT_ID>`.
   - Execute one read/search operation and one terminal command to prove Full Harness tool capability.
   - Capture `S_after` via `agent-broker-cli snapshot --project-id <PROJECT_ID>` and verify `S_before == S_after`.
   - Emit `AUDITOR READY` or `AUDITOR BLOCKED`.

---

## 6. Phase-B Acceptance Verification

During Phase-B readiness acceptance:
1. Confirm that Sol outputs the complete `AUDITOR READY` structured block.
2. Confirm `workspace identity: MATCH`.
3. Confirm `source write performed: NO` and `worker dispatch performed: NO`.
4. Confirm `S_before == S_after`.
5. Visually confirm model identity (`HUMAN_CONFIRMED`).
6. Verify no worker dispatch was executed.

---

## 7. Turn Resumability & Bounded Worker Waits

A single ChatGPT/Codex tool turn **does not need to stay alive indefinitely**.

### Tunnel Timeout Boundary
The OpenAI tunnel client enforces an invocation timeout (~90–120s max). Long blocking calls will cause tool execution failure.

### Bounded Polling Rule (WP-V3-09+)
In future execution cycles involving worker waits:
- Sol must use bounded waits: **1 to 30 seconds** (prefer **≤10 seconds** per poll):
  ```powershell
  node <ORCHESTRATOR_ROOT>\pipeline-ui\agent-broker-cli.js worker-wait --project-id <PROJECT_ID> --dispatch-id <DISPATCH_ID> --timeout-secs 10
  ```
- If the worker is still executing, the command exits with code `0` and status `"RUNNING"`.
- A status of `"RUNNING"` is normal and expected.
- Sol allows the current browser/tool turn to end cleanly.

### Resuming the Persistent Task
When the worker finishes or when the operator checks back:
1. Re-open the **same** dedicated Codex task.
2. Sol queries current lifecycle status:
   ```powershell
   node <ORCHESTRATOR_ROOT>\pipeline-ui\agent-broker-cli.js worker-status --project-id <PROJECT_ID>
   ```
3. Sol takes a fresh snapshot:
   ```powershell
   node <ORCHESTRATOR_ROOT>\pipeline-ui\agent-broker-cli.js snapshot --project-id <PROJECT_ID>
   ```
4. Sol continues the audit workflow seamlessly.

---

## 8. Context Compaction Handling

Persistent tasks may undergo context window compaction.
When context compaction occurs:
- Conversational history may be summarized or pruned.
- Durable repository files (`docs/refactor-v3-thin-orchestrator/*`) remain unchanged.
- Sol must re-read the architecture documents, run `worker-status`, and obtain a fresh `snapshot` before proceeding.
- Never rely on conversational prose alone.

---

## 9. Operator Prohibitions (What NOT to Do)

- **DO NOT** use `codex queue`: It lacks turn correlation and is forbidden as an auditor lifecycle authority.
- **DO NOT** modify implementation files during audit: Sol is read-only by policy.
- **DO NOT** auto-select or scan for "latest task": Task selection is strictly manual.
- **DO NOT** invoke `worker-dispatch` during WP-V3-07 acceptance: Dispatch is forbidden until WP-V3-09.
- **DO NOT** copy or persist secrets: Never store cookies, tunnel keys, browser profiles, or auth tokens in reports or repository files.
- **DO NOT** use stale CLI flags: Always use `--project-id`, `--request-file`, `--dispatch-id`, `--timeout-secs` (never `--project`, `--dispatch`, `--timeout`).

---

## 10. How to Stop Safely

If Sol emits `AUDITOR BLOCKED`:
1. Read the `reason_code` and `details`.
2. Do not attempt speculative auto-recovery.
3. Do not force state transitions in SQLite or delete the database.
4. Correct the environmental failure (e.g., start Full Harness launcher, select correct workspace, wait for worker to become IDLE).
5. Re-run bootstrap from step 1.

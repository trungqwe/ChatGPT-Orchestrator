# Codex Auditor Health Checklist & Contract

## 1. Objective & Authority

This document defines the authoritative health contract and verification checklist for accepting a user-selected, persistent Codex Full Harness task as the **Sol** architect/auditor.

Under the v3 thin orchestrator architecture:
- Sol is the independent auditor and architect.
- Broker is the deterministic guard and state machine.
- The auditor task is user-owned (`auditor.managed_by_orchestrator: false`).
- Real-task acceptance occurs only after complete verification of all required health conditions.

---

## 2. Verification Classification

To eliminate ambiguity and prevent fabricated proof, all checks are categorized into four distinct verification classes:

1. **MACHINE-PROVABLE**: Programmatically verified via deterministic tool or CLI exit codes and structured JSON output.
2. **HUMAN-CONFIRMED**: Visually verified by the human operator because current host runtime interfaces do not expose programmatic truth.
3. **TASK-PROVABLE**: Verified by successfully executing an actual local tool operation inside the target Codex task.
4. **NOT PROVABLE IN MVP**: Structural or environmental limitations where OS-level guarantees do not exist; mitigated via prompt policy and before/after verification.

---

## 3. Comprehensive Health Checklist Matrix

| Check Item | Description | Verification Class | Required Condition | Failure Action |
| :--- | :--- | :--- | :--- | :--- |
| **Doctor Overall Health** | `codex-chatgpt-web doctor --json` | `MACHINE-PROVABLE` | `doctor.ok == true` | Stop: `FULL_HARNESS_UNHEALTHY` |
| **Doctor Harness Mode** | `codex-chatgpt-web doctor --json` | `MACHINE-PROVABLE` | `doctor.mode == "full"` | Stop: `FULL_HARNESS_TOOLS_UNAVAILABLE` |
| **Doctor Check Categories** | Inspect all reported doctor checks | `MACHINE-PROVABLE` | Zero `error` status in config, browser-host, codex, proxy, tunnel | Stop: `FULL_HARNESS_UNHEALTHY` |
| **Workspace Git Root** | `git rev-parse --show-toplevel` | `MACHINE-PROVABLE` | Exact canonical match with `project_root` | Stop: `WRONG_WORKSPACE` |
| **Broker Freshness Snapshot** | `agent-broker-cli snapshot --project-id <ID>` | `MACHINE-PROVABLE` | Returns valid JSON with `workspace_state_id` | Stop: `BROKER_UNAVAILABLE` |
| **Broker Worker Status** | `agent-broker-cli worker-status --project-id <ID>` | `MACHINE-PROVABLE` | `worker_state == "IDLE"` | Stop: `WORKER_NOT_IDLE` |
| **Actual Source-Read Tool** | Read or search local repository file | `TASK-PROVABLE` | Successful read without error | Stop: `FULL_HARNESS_TOOLS_UNAVAILABLE` |
| **Actual Terminal Tool** | Run read-only command (`git status`) | `TASK-PROVABLE` | Successful execution without error | Stop: `FULL_HARNESS_TOOLS_UNAVAILABLE` |
| **Connector Attachment** | ChatGPT connector linked to task | `TASK-PROVABLE` | Proven by actual tool execution (see Sec. 5) | Stop: `FULL_HARNESS_TOOLS_UNAVAILABLE` |
| **Expected Model Label** | Selected ChatGPT Web Sol model | `HUMAN-CONFIRMED` | Visual confirmation matches `expected_model_label` | Stop: `MODEL_NOT_CONFIRMED` |
| **Auditor Task Identity** | Selection of dedicated persistent task | `HUMAN-CONFIRMED` | `VERIFIED` or `HUMAN_SELECTED_UNVERIFIED` | Valid in MVP; do not guess |
| **Source Write Prevention** | No file modifications during audit | `NOT PROVABLE IN MVP` | Prompt discipline; `S_before == S_after` | Stop: `WORKSPACE_CHANGED_DURING_BOOTSTRAP` |
| **No Worker Dispatch** | Zero dispatch in WP-V3-07 acceptance | `MACHINE-PROVABLE` | Zero `worker-dispatch` calls executed | Stop: Immediate acceptance rejection |

---

## 4. Doctor Health Primitive & Semantics

The installed `codex-chatgpt-web` binary provides the primary health command:

```powershell
codex-chatgpt-web doctor --json
```

### Necessary, But NOT Sufficient
For automated Full Harness acceptance, the following conditions are strictly necessary:
```json
{
  "ok": true,
  "mode": "full"
}
```
However, a clean doctor output is **NOT SUFFICIENT** on its own.
```text
doctor ready != connector/task Full Harness capability proven
```

### Required Full-Mode Check Inspection
The doctor JSON checks must be inspected. Every check must have `status: "ok"` or acceptable informational `"warning"`. Any check with `status: "error"` is fatal.
Depending on the runtime version, Full Harness mode reports check IDs such as:
- `config` — Configuration file valid and parseable
- `browser-host` — Embedded launcher browser authenticated and reachable
- `codex` — Codex integration and model route installed
- `service` — Runtime service active
- `proxy` — Responses proxy healthy on loopback
- `tunnel-binary`, `tunnel-key`, `tunnel-service`, `tunnel-runtime` — Tunnel binary, runtime key security, and service status
- `connector` — Remote ChatGPT web connector status

### Doctor Contract & Connector Warning Boundary
- **Core Contract**: `doctor.ok == true`, `doctor.mode == "full"`, and `no check.status == "error"`.
- **Connector Warning Rule**: A `connector` warning from doctor is expected because local doctor cannot locally prove remote connector attachment:
  ```text
  connector warning from doctor != automatic health failure
  ```
  when `doctor.ok == true`, `doctor.mode == "full"`, and zero error checks are present.
- End-to-end connector usability must be proven by actual local tool execution inside the dedicated Codex task.

---

## 5. Connector Limitation & Actual Tool Proof

### The Doctor Limitation
`codex-chatgpt-web doctor` tests the local background services, browser host, and proxy. It **cannot locally prove** that the remote ChatGPT web session has successfully connected its MCP connector to the active Codex task.

Therefore, doctor alone cannot prove connector attachment.

### Task-Level Tool Proof Requirement
Readiness requires direct behavioral proof inside the dedicated Codex task:
1. **Local Source Read / Search**: Sol must perform a local file read (e.g., viewing `package.json` or `README.md`) or semantic search using task tools.
2. **Local Terminal Execution**: Sol must execute a read-only shell command (e.g., `git status --short`).

If either tool fails or returns an error, Full Harness is unattached, and the auditor must emit `AUDITOR BLOCKED` with `reason_code: FULL_HARNESS_TOOLS_UNAVAILABLE`.

---

## 6. Model Verification Boundary

The project registry specifies:
```json
"expected_model_label": "ChatGPT Web — GPT-5.6 Sol High"
```
This is an **expectation**, not a machine-verifiable identity.
- Neither `doctor`, task titles, registry labels, nor old conversational text provide machine proof of the active model.
- The human operator must visually confirm that the selected model in the ChatGPT/Codex interface matches `expected_model_label`.
- The readiness report records:
  ```text
  MODEL_VERIFICATION:
  HUMAN_CONFIRMED
  ```
  (or in structured readiness block `model verification: HUMAN_CONFIRMED`)
  or if unconfirmed:
  ```text
  MODEL_VERIFICATION:
  BLOCKED
  ```
- The orchestrator and auditor must NEVER automatically switch models.

---

## 7. Task Identity & No Automatic Task Management

The project registry records:
```json
"auditor": {
  "task_id": "user-selected-task-id-or-descriptor",
  "task_id_verified": false
}
```
If `task_id_verified == false`, this is completely valid for MVP.

The human operator owns the selection of the dedicated persistent task. The system must NOT:
- Search for "latest task"
- Heuristically match recent tasks by CWD or window title
- Scan rollout history
- Use `codex queue` as lifecycle or auditor authority (do not use `codex queue`)

If stable task ID is visible and matches registry: `VERIFIED`.  
Otherwise: `HUMAN_SELECTED_UNVERIFIED`.

---

## 8. Workspace Identity Verification

Sol must execute:
```powershell
git rev-parse --show-toplevel
```
and compare the canonical path against `project_root` in the registry.

If the paths do not match:
```text
AUDITOR BLOCKED
reason_code:
WRONG_WORKSPACE
```
No worker dispatch or further audit steps may occur.

---

## 9. Before / After Workspace Snapshot Equality Proof

Because OS-level read-only sandboxing is not available in the current environment:
1. Immediately after proving Git root matches `project_root` (Step 4), capture `S_before = snapshot.workspace_state_id`.
2. Perform all subsequent read-only inspections, doctor checks, worker status queries, and task-level tool proofs.
3. Capture `S_after = snapshot.workspace_state_id`.
4. Verify:
   ```text
   S_before == S_after
   ```

If `S_before !== S_after`:
```text
AUDITOR BLOCKED
reason_code:
WORKSPACE_CHANGED_DURING_BOOTSTRAP
```
This proves that no observable final workspace-state difference occurred across the audited bootstrap interval under the prompt-policy boundary.

---

## 10. No Worker Dispatch in WP-V3-07

WP-V3-007A and Phase-B acceptance are strictly confined to auditor readiness.
```text
worker-dispatch is FORBIDDEN in WP-V3-07
```
- No real or test dispatches to Antigravity
- No Agent Orchestrator (AO) messages
- No "hello world" worker requests

The first authorized worker cycle will occur in **WP-V3-09**.

---

## 11. No Secrets Policy & Output Sanitization

Health reporting must strictly adhere to data privacy and security boundaries:

### Forbidden Data in Reports / Artifacts
- Cookies (browser cookies)
- Browser storage (localStorage, sessionStorage)
- Tunnel runtime keys (tunnel keys and auth tokens)
- Control tokens (OpenAI / ChatGPT control tokens)
- Connector secrets
- Full raw private configuration files or environment dumps

### Allowed Sanitized Report Fields
- Runtime version (e.g., `5.0.8`)
- Doctor overall status (`ok: true/false`)
- Doctor mode (`full`, `browser-only`)
- Check IDs, status strings (`ok`, `warning`, `error`), and concise summary messages

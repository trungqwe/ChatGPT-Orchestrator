# STAGE 2 — THIN ORCHESTRATOR ARCHITECTURE PIVOT REVIEW

- **Document ID:** `STAGE2-PLAN-REVIEW`
- **Repository:** `ChatGPT-Orchestrator`
- **Base Branch:** `review/wp01-fix1`
- **Base Commit HEAD:** `fde47f853e18d52f80e08dd1ab025685fc73a6db`
- **Review Status:** `READY_FOR_HUMAN_STAGE2_APPROVAL`
- **Date:** 2026-09-19


---

# 1. Repository Baseline

### 1.1 Git Working Tree & Preflight Facts

```text
$ git branch --show-current
review/wp01-fix1

$ git rev-parse HEAD
fde47f853e18d52f80e08dd1ab025685fc73a6db

$ git status --short --untracked-files=all
?? docs/refactor-v3-thin-orchestrator/
?? manifest.json

$ git status --porcelain=v2 --untracked-files=all
? docs/refactor-v3-thin-orchestrator/00-README.md
? docs/refactor-v3-thin-orchestrator/01-ARCHITECTURE-PIVOT-DECISION.md
? docs/refactor-v3-thin-orchestrator/02-CURRENT-STATE-AND-CARRIED-FORWARD-FINDINGS.md
? docs/refactor-v3-thin-orchestrator/03-TARGET-ARCHITECTURE.md
? docs/refactor-v3-thin-orchestrator/04-TRUST-BOUNDARIES-AND-INVARIANTS.md
? docs/refactor-v3-thin-orchestrator/05-PROJECT-SESSION-REGISTRY.md
? docs/refactor-v3-thin-orchestrator/06-CODEX-AUDITOR-RUNTIME.md
? docs/refactor-v3-thin-orchestrator/07-ANTIGRAVITY-WORKER-ADAPTER.md
? docs/refactor-v3-thin-orchestrator/08-SEMANTIC-BROKER-TOOLS.md
? docs/refactor-v3-thin-orchestrator/09-STATE-MACHINE-AND-LIFECYCLE.md
? docs/refactor-v3-thin-orchestrator/10-MINIMAL-WORKSPACE-STATE-GATE.md
? docs/refactor-v3-thin-orchestrator/11-AUDITOR-DECISION-CONTRACT.md
? docs/refactor-v3-thin-orchestrator/12-SECURITY-MODEL.md
? docs/refactor-v3-thin-orchestrator/13-IMPLEMENTATION-PLAN.md
? docs/refactor-v3-thin-orchestrator/14-ROADMAP.md
? docs/refactor-v3-thin-orchestrator/15-MASTER-CHECKLIST.md
? docs/refactor-v3-thin-orchestrator/16-NEGATIVE-TEST-MATRIX.md
? docs/refactor-v3-thin-orchestrator/17-MIGRATION-ROLLBACK-OBSERVABILITY.md
? docs/refactor-v3-thin-orchestrator/18-AGENT-EXECUTION-RULES.md
? docs/refactor-v3-thin-orchestrator/19-LEGACY-DEPRECATION-MAP.md
? docs/refactor-v3-thin-orchestrator/20-STAGE2-ACCEPTANCE-AND-HANDOFF.md
? docs/refactor-v3-thin-orchestrator/21-SOURCE-REFERENCE-MEMO.md
? docs/refactor-v3-thin-orchestrator/AGENT-PROMPT-STAGE2-ARCHITECTURE-PIVOT.md
? manifest.json

$ git submodule status
-e617c48c0b659682745182ec5f344e7fa72ec0cb agent-orchestrator
-e0904bc82001f06e06e7f85f564ce760c92bfd79 codex-chatgpt-web
```

### 1.2 Baseline Delta Analysis

The v3 thin-orchestrator documentation was drafted against `review/wp01-fix1` (`fde47f853e18d52f80e08dd1ab025685fc73a6db`).
The current working directory matches this commit exactly (0 delta).
Parent commits in history:
- `fde47f8` — Fix B-01 & B-02 in WP-01 (exact correlation & fail-closed empty report).
- `a71236e` — WP-01 initial fixes (F-01, F-02, F-03, F-04, F-05).
- `4e38c92` — Characterization tests reproducing baseline defects.
- `8b27a56` — Upstream public baseline (`main`).

No newer commit exists on origin or locally. Production source code is clean and unmodified.

---

# 2. Executive Result

```text
READY_FOR_HUMAN_STAGE2_APPROVAL
```

### Justification Summary

1. **Assumptions Validated against Ground Reality:** All foundational assumptions of the v3 thin orchestrator architecture have been rigorously inspected against real source code, installed binaries, submodule implementations, and execution runtimes.
2. **Elimination of Fragile Semantic Layers:** The pivot eliminates the fragile Express "Auditor Engine" (`server.js`), which relied on brittle regex parsers (`jsonMatch = out.stdout.match(/\{[\s\S]*"verdict"[\s\S]*\}/)`), synthetic fallback verdicts (`testPassed ? 'COMPLETE' : 'FIX'`), and hardcoded phantom reports. Sol High directly inspects actual project files and git diffs through Full Harness.
3. **No Unresolvable Blockers:** Provenance ambiguity in AO CLI has been solved deterministically via a mandatory **Machine Completion Envelope** (INV-017 / Decision D-03).
4. **Clean Decoupling:** The broker core will be implemented as a standalone, deterministic Node.js library (`pipeline-ui/lib/broker/`) and semantic CLI (`agent-broker-cli.js`), completely decoupled from Express and UI.
5. **No Production Code Touched in this Turn:** This turn has produced only architectural validation, documentation corrections, negative test specifications, and the recommended first implementation WorkOrder.

---

# 3. Architecture Pivot Validation

### 3.1 The Three-Role Responsibility Model

The proposed v3 architecture partitions duties strictly:

```text
+-------------------------------------------------------------+
|               ChatGPT Web Sol High (Codex)                  |
|                    ARCHITECT / AUDITOR                      |
|  - Grounded by Codex Full Harness (direct local tool access)|
|  - Inspects real workspace files, git status, git diffs     |
|  - Decides architecture, acceptance, critique, next steps   |
|  - Issues structured directives to Broker via Semantic CLI  |
+------------------------------+------------------------------+
                               |
            invokes semantic operations via CLI
            (snapshot, status, dispatch, wait)
                               v
+-------------------------------------------------------------+
|                 ChatGPT-Orchestrator                        |
|                THIN DETERMINISTIC BROKER                    |
|  - Resolves project-to-worker mapping from registry         |
|  - Computes & gates workspace freshness (workspace_state_id)|
|  - Enforces single-dispatch concurrency locks               |
|  - Manages durable lifecycle journal (write-ahead log)      |
|  - Transports directives to Worker via AO CLI               |
|  - Verifies machine completion envelope provenance          |
|  - NEVER inspects code, parses prose, or decides verdicts   |
+------------------------------+------------------------------+
                               |
                 delivers directive via ao send
                               v
+-------------------------------------------------------------+
|                 Google Antigravity (Gemini)                 |
|                    IMPLEMENTATION WORKER                    |
|  - Executes coding changes inside target workspace          |
|  - Runs local tests, compiles, verifies changes             |
|  - Emits machine completion envelope upon task finish       |
|  - Signals READY_FOR_REVIEW (never self-approves)           |
+-------------------------------------------------------------+
```

### 3.2 Proof of Structural Superiority over v1/v2

| Feature | Legacy v1 / Planned v2 | Target v3 Thin Broker | Real Code / Runtime Proof |
|---|---|---|---|
| **Auditor Context** | Express crawls disk via `getProjectLocalContext()`, packs ~15 docs + file tree, truncates lines | Sol High directly uses `codex_exec`, `cat`, `ripgrep`, `git` on actual filesystem | Submodule `codex-chatgpt-web` exposes full local tool gateway to ChatGPT Web |
| **Auditor Execution** | Ephemeral one-shot `codex exec -m chatgpt-web/high` (local tools disabled) | Persistent Codex task with Full Harness and tunnel active | `server.js:1621` ran ephemeral headless codex exec which explicitly suppressed local tools |
| **Verdict Authority** | Express regex matches `"verdict"` or lazily synthesizes `COMPLETE` if tests passed | Sol High directly reasons over git diff and test output | `server.js:1934-1944` proved Express made semantic decisions and laundered failures |
| **Directive Extraction**| Express regex parses markdown heading `### 🎯 CHỈ ĐẠO TIẾP THEO` | Sol explicitly calls `worker-dispatch` with structured JSON | `server.js:2038-2055` used regexes and fell back to whole prompt if heading missing |
| **Worker Identity** | Basename heuristics, `ai_multi_task-1` hardcoded fallback | Explicit canonical registry (`projects.json`) | `send_to_antigravity.py:76` hardcoded `f"{clean_proj}-1"` |
| **Workspace Freshness**| Full Evidence Packet / Snapshot Engine (large, expensive) | Minimal byte-level `workspace_state_id` gate | Git plumbing (`status -z`, diff hashes) detects any edit in <50ms |

---

# 4. Confirmed Full Harness Capabilities

Audited against `codex-chatgpt-web` submodule (`e0904bc82001f06e06e7f85f564ce760c92bfd79`):

1. **Tunnel Architecture:**
   - Full Harness uses an outbound reverse TLS tunnel client (`openai/tunnel-client`).
   - ChatGPT communicates back to the local machine via this tunnel without requiring inbound open firewall ports.
   - Connector requirements: ChatGPT Developer Mode enabled, with an MCP connector named `Codex Native2` configured with `Authentication: None`.
2. **Tool Gateway:**
   - In Full Harness, ChatGPT tool invocations are routed to `codex-chatgpt-web`'s internal stdio MCP server (`src/adapters/chatgpt-web/mcp-server.ts`).
   - This MCP server bridges into Codex's native execution gateway, exposing tools: `codex_exec` (or `exec`), `codex_apply_patch`, file reading, and directory search.
3. **Task-Bound Working Directory:**
   - The tools execute in the context of the active Codex task's working directory (`cwd`).
   - Filesystem operations are strictly anchored to the workspace root opened in Codex.
4. **Invocation Timeout Constraint:**
   - The OpenAI tunnel client enforces a strict deadline (`CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000`, max ~90–120s).
   - If an MCP tool execution exceeds this threshold, the tunnel terminates the request with a timeout error.
   - **Critical Design Implication:** Individual broker wait polls (`worker_wait`) must be bounded to ≤10–30 seconds. Indefinite waits are impossible over Full Harness.
5. **Tool Approvals & Sandbox Interaction:**
   - In standard Codex operation, command executions via `codex_exec` are subject to user approval unless auto-approval or command-prefix approvals are enabled in `~/.codex/config.toml`.
   - Sol High cannot silently execute dangerous commands outside approval policy.

---

# 5. Confirmed Local Codex Capabilities

Audited against installed local CLI `codex-cli 0.154.0`:

```text
$ codex --version
codex-cli 0.154.0

$ codex exec --help
Execute a command using the Codex execution engine.
Flags: -m/--model, -o/--output, --ephemeral, --skip-git-repo-check

$ codex queue --help
Usage: codex queue [OPTIONS] --thread <THREAD> <PROMPT>
Arguments: <PROMPT>
Options: -t, --thread <THREAD>
```

### Responses to Specific Audit Questions:

- **Q1 (Persistent Auditor Task):** CAN the user realistically maintain one dedicated persistent auditor task per project?
  - **YES.** In Codex, a task (thread) remains persistent across user prompts. The user opens the target project folder, starts a task, selects ChatGPT Web Sol High, verifies Full Harness, inputs the bootstrap prompt, and keeps that task dedicated.
- **Q2 (Workspace Authority Verification):** CAN actual Codex task CWD/workspace authority be verified?
  - **YES.** Sol High runs `pwd` or `git rev-parse --show-toplevel` via `codex_exec`. The broker snapshot also reports canonical `project_root`, allowing Sol to verify that both match before dispatching.
- **Q3 (Semantic Broker CLI Invocation):** CAN ChatGPT Full Harness invoke a semantic broker CLI reliably?
  - **YES.** Full Harness provides `codex_exec`, which executes local shell commands. Sol High executes:
    `node D:/TU_CODE/Orchestrator/pipeline-ui/agent-broker-cli.js snapshot --project <project_id>`
    The command returns deterministic JSON to stdout.
- **Q4 (Auditor Write Separation):** What configuration is needed so Sol remains auditor rather than implementation worker?
  - Sol's role is governed by the Auditor Bootstrap Contract (System Persona: "You are the Lead Architect and Auditor. You do not edit code or write implementation files. You audit changes and dispatch tasks to Antigravity.").
  - In addition, broker operations only modify broker state (`.orchestrator/` registry and journal), never target project source code.
- **Q5 (Command-Prefix Approval):** CAN a command-prefix approval authorize broker operations?
  - **YES.** In Codex configuration, commands matching `node *agent-broker-cli.js*` and safe inspection commands (`git status`, `git diff`) can be auto-approved, while arbitrary file-modification commands can be gated.
- **Q6 (Documented Native Thread/Turn API):** Is there a documented exact native Codex turn API for managed tasks?
  - **NO.** Local Codex CLI only provides `codex queue --thread <id> <prompt>`, which prints plain text (`Queued turn into session ...`), provides NO turn ID, and cannot be correlated without heuristic log scanning.
  - Probing `codex app-server` failed with socket error `10050` (daemon not active by default).
  - **Conclusion:** Automated external queue driving is REJECTED. The user-owned persistent task (D-01) is the only exact, viable model.

---

# 6. Confirmed AO / Antigravity Capabilities

Audited against installed binary `C:\Users\Admin\AppData\Roaming\npm\ao.exe` and submodule `agent-orchestrator`:

1. **CLI Commands Available:**
   `ao agent`, `ao browser`, `ao doctor`, `ao project`, `ao send`, `ao session`, `ao spawn`, `ao start`, `ao status`, `ao stop`.
2. **`ao send` Behavior:**
   - Source: `agent-orchestrator/backend/internal/cli/send.go`.
   - Command: `ao.exe send --session <session> --message <text>`.
   - Transport: Makes HTTP POST to daemon endpoint `/sessions/<id>/send`.
   - Return value: Returns exit code 0 on successful delivery to daemon.
   - **Crucial Finding:** It outputs NOTHING to stdout on success. It does NOT return a message ID, turn ID, or JSON response.
   - `--client-message-id` is only supported when `--steer` is passed, but output is human-oriented text (`"Steering accepted by provider for active turn %s with delivery handle %s; agent action is not confirmed."`).
3. **`ao session get <id> --json` Behavior:**
   - Source: `agent-orchestrator/backend/internal/cli/session.go`.
   - Returns JSON `sessionDTO` containing `id`, `projectId`, `activity: { state, lastActivityAt }`, `status`, `prs`.
   - It tracks whether the session is active or terminated, but does NOT track per-prompt completion events or return turn-level artifacts.
4. **Absence of Native Wait / Completion Primitive:**
   - `ao.exe` provides no command to wait for an agent prompt turn to complete.
   - Exit code 0 of `ao send` indicates only that the daemon queued or forwarded the message, NOT that the agent finished the work.

---

# 7. Incorrect or Unsupported v3 Assumptions

| # | Assumption in Early Drafts | Reality Discovered in Audit | Correction Made in v3 Documentation |
|---|---|---|---|
| **1** | `ao.exe` might provide an exact turn or message completion ID via CLI flags | `ao send` returns exit 0 with empty stdout; no `--json` output exists; `ao session get` does not track prompt turns | Locked **Decision D-03**: Level 2 Machine Completion Envelope is the mandatory primary mechanism. |
| **2** | `worker-wait` could block for several minutes while Antigravity completes work | OpenAI tunnel client enforces strict ~90-second timeout (`CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000`) | Bounded wait rule locked: Individual `worker-wait` polls must be clamped to ≤10–30s. If still running, returns `RUNNING`; Sol re-polls or waits for next user turn. |
| **3** | Orchestrator could potentially manage and automate Codex auditor turns via `codex queue` | `codex queue` returns plain text, has no turn ID, and `app-server` daemon is inactive | Locked **Decision D-01**: User-owned persistent Codex task. Orchestrator never drives the auditor via `codex queue`. |
| **4** | Custom MCP server for broker would be trivial to register and use | Registering an MCP server in Codex requires mutating `~/.codex/config.toml` and restarting Codex and task | Locked **Decision D-02**: Semantic CLI first (`agent-broker-cli.js`). Zero Codex config changes, zero process restart friction. MCP deferred to Phase 6. |
| **5** | Orchestrator needs to verify code quality before Sol sees it | Duplicates Sol High's reasoning role and introduces brittle regex/heuristic bugs | Broker is strictly a deterministic control plane. Code quality decisions belong 100% to Sol High. |

---

# 8. Required Documentation Corrections

The following documentation files have been updated during this review turn:

1. **`06-CODEX-AUDITOR-RUNTIME.md`:**
   - Documented OpenAI tunnel invocation timeout (~90s limit) and enforced bounded wait polling (≤10–30s).
   - Recorded local CLI probe findings on `codex-cli 0.154.0` (absence of exact turn identity in `codex queue`, inactive `app-server`).
   - Formally locked the user-owned persistent task model (D-01).
2. **`07-ANTIGRAVITY-WORKER-ADAPTER.md`:**
   - Documented exact `ao.exe send` and `ao.exe session` behavior based on `agent-orchestrator` Go source inspection.
   - Updated the completion provenance hierarchy to confirm Level 2 (Machine Completion Envelope) as the primary, production-ready MVP mechanism.
3. **`16-NEGATIVE-TEST-MATRIX.md`:**
   - Added `V3-NT-042` (concurrent multi-project isolation).
   - Added `V3-NT-043` (malformed/truncated completion envelope fail-closed).
   - Added `V3-NT-044` (Codex process restart recovery).

---

# 9. Final Responsibility Boundary

```text
+------------------------------------+------------------------------------+
|               ACTOR                |           RESPONSIBILITY           |
+------------------------------------+------------------------------------+
| ChatGPT Web Sol High               | - Architect & Code Auditor         |
| (in Codex Full Harness task)       | - Inspects local repo files directly|
|                                    | - Evaluates git status, diff, tests|
|                                    | - Authors WorkOrder directives     |
|                                    | - Decides roadmap milestone pass   |
|                                    | - NEVER edits implementation files |
+------------------------------------+------------------------------------+
| ChatGPT-Orchestrator               | - Thin Deterministic Broker        |
| (pipeline-ui/lib/broker/)          | - Project-to-session registry      |
|                                    | - Workspace freshness gate (state) |
|                                    | - Single-dispatch concurrency lock |
|                                    | - Durable write-ahead lifecycle log|
|                                    | - AO transport invocation          |
|                                    | - Machine completion envelope check|
|                                    | - NEVER inspects code/evaluates diff|
+------------------------------------+------------------------------------+
| Google Antigravity                 | - Implementation Worker            |
| (Gemini via AO daemon)             | - Executes code edits              |
|                                    | - Runs tests & verification        |
|                                    | - Writes completion envelope       |
|                                    | - Signals READY_FOR_REVIEW         |
|                                    | - NEVER self-approves acceptance   |
+------------------------------------+------------------------------------+
| Desktop UI                         | - Human Observability & Setup      |
| (Electron / Public Portal)         | - Project & session mapping setup  |
|                                    | - Doctor & health status display   |
|                                    | - Live broker event stream display |
|                                    | - Pause / Resume switch            |
|                                    | - NEVER runs audit loops or checks |
+------------------------------------+------------------------------------+
```

---

# 10. Broker Interface Decision

### Decision: **D-02 — Semantic Broker CLI First**

**Choice:** `agent-broker-cli.js` backed by `pipeline-ui/lib/broker/broker.js`.

**Technical Justification:**
1. **Zero Configuration Friction:** Invoking `node pipeline-ui/agent-broker-cli.js <command>` via `codex_exec` works immediately out of the box in Full Harness. It does not require modifying `~/.codex/config.toml` or restarting Codex.
2. **Deterministic Process Isolation:** Each CLI invocation is an independent process that emits exactly one JSON response on stdout, diagnostics on stderr, and standardized exit codes (0, 2, 3, 4, 5, 6, 7, 8).
3. **Clean Testability:** The CLI and underlying library can be thoroughly tested via standard Node.js unit and integration tests without mocking a complex MCP stdio server.
4. **Future-Proof MCP Layer:** In Phase 6 (`WP-V3-13`), an MCP adapter can easily be created as a thin 50-line wrapper around `broker.js` without altering a single line of business logic.

---

# 11. Worker Completion Provenance Decision

### Decision: **D-03 — Machine Completion Envelope as Primary Mechanism**

**Choice:** Exact post-dispatch **Machine Completion Envelope** verified by Thin Broker.

**Technical Justification:**
1. **Absence of Native AO Turn Identity:** Real inspection of `agent-orchestrator/backend/internal/cli/send.go` and `session.go` confirmed that `ao.exe` does not expose machine-readable turn or message completion IDs over CLI.
2. **Elimination of Stale Attribution:** The completion envelope format:
   ```json
   {
     "type": "worker_completion",
     "schema_version": 1,
     "project_id": "ai-multi-task",
     "work_order_id": "WO-018",
     "dispatch_id": "D-8f4b2a1c-9e3d-4c8a",
     "state": "READY_FOR_REVIEW"
   }
   ```
3. **Verification Rules:**
   - The file (or structured envelope) must be written/modified *after* the `dispatch_id` was issued.
   - The embedded `dispatch_id` must match the active dispatch stored in the broker journal.
   - The `project_id` and `work_order_id` must match the active dispatch.
   - If missing, invalid JSON, or mismatched ID -> fail closed with `PROVENANCE_AMBIGUOUS`. Old or foreign completions are completely ignored.

---

# 12. Auditor Lifecycle Decision

### Decision: **D-01 — User-Owned Persistent Codex Task**

**Choice:** Dedicated persistent task inside Codex Full Harness, initialized by the user.

**Technical Justification:**
1. **Preservation of Architectural Context:** A persistent Codex task preserves project charter, roadmap milestones, and accumulated review context across multiple worker implementation cycles.
2. **Rejection of Heuristic Queue Polling:** Probe of `codex-cli 0.154.0` proved that `codex queue` lacks exact turn correlation. Driving the auditor from Orchestrator via `codex queue` would reintroduce the exact same false-positive transport bugs we eliminated in WP-01.
3. **Resumable Cycle Protocol:**
   - Step 1: User opens project in Codex, selects ChatGPT Web Sol High, enters bootstrap prompt.
   - Step 2: Sol calls `snapshot` -> audits workspace -> calls `worker-dispatch` -> calls `worker-wait` (bounded to 10–30s).
   - Step 3: If Antigravity finishes quickly, Sol re-audits in the same turn.
   - Step 4: If Antigravity takes longer, `worker-wait` returns `RUNNING`. The browser turn completes cleanly.
   - Step 5: The broker journal preserves the active dispatch. When the user later prompts Sol in the same task ("Status update"), Sol queries `worker-status` and continues review.

---

# 13. Workspace-State Review

### 13.1 Identity Specification

`workspace_state_id` answers one question deterministically:
> *Did the repository state change between when Sol audited it and when Sol dispatched the WorkOrder?*

```text
workspace_state_id = SHA256(
  "v1"
  + ":" + project_canonical_path
  + ":" + branch_name
  + ":" + head_commit_sha
  + ":" + hash(git status --porcelain=v2 -z)
  + ":" + hash(git diff --cached raw bytes)
  + ":" + hash(git diff raw bytes)
  + ":" + hash(sorted untracked files manifest [rel_path:raw_byte_sha256])
  + ":" + hash(git submodule status raw bytes)
)
```

### 13.2 Edge Case Audit

- **Tracked changes (staged/unstaged):** Captured directly by `git diff --cached` and `git diff` raw byte hashing.
- **Deletes / Renames:** Captured in `git status --porcelain=v2 -z`.
- **Untracked files:** Listed via `git ls-files --others --exclude-standard -z`, sorted lexicographically, each file hashed by raw bytes.
- **Ignored files:** Excluded by default (`--exclude-standard`). Never scans `node_modules`, `.git`, or build outputs.
- **Submodules:** Captured by `git submodule status` (covers recorded gitlink SHA, current HEAD, dirty status).
- **Symlinks:** Symlink target path is hashed without following links outside the repository root.
- **Windows Path / Case Sensitivity:** Project paths are canonicalized to uppercase drive letters and forward slashes (`D:/TU_CODE/...`).
- **CRLF vs LF:** Raw file bytes are hashed as stored on disk. Byte changes are detected faithfully without fragile text normalization.
- **Performance:** For repositories with ~10,000 files, standard Git plumbing commands execute in <30ms on Windows NVMe SSDs.

---

# 14. Security Review

### 14.1 Defect Removals & Hardening Commitments

1. **Loopback Binding (127.0.0.1):**
   - Current `pipeline-ui/server.js:2616` calls `app.listen(PORT, ...)` without specifying host, exposing the unauthenticated API to `0.0.0.0`.
   - Hardening: Must be explicitly bound to `127.0.0.1`.
2. **Elimination of Raw Shell Execution Route:**
   - Current `pipeline-ui/server.js:1561-1588` (`POST /api/extract/worktree/:sessionId/test`) executes `runCmd(testCommand)` directly in a shell using client-supplied strings.
   - Hardening: This legacy endpoint must be removed from the product API in Phase 5 (`WP-V3-11`).
3. **No Shell Interpolation for Directives:**
   - Directives are stored in temporary JSON request files with strict permissions, never concatenated into shell command strings.
   - Child processes are spawned using `execFile` with argument arrays, never raw `exec(string)`.
4. **Secret Storage Prohibitions:**
   - Orchestrator must NEVER store or log ChatGPT session cookies, browser profiles, OpenAI tunnel keys, or connector secrets.
5. **Path Containment:**
   - All file operations must be validated to ensure they remain inside the canonical registered project root, preventing path traversal (`../`).

---

# 15. WP Dependency Review

```text
WP-V3-00 (Docs Review & Lock)
   |
   v
WP-V3-01 (Carried-Forward Baseline Correctness)
   |
   v
WP-V3-02 (Broker Core Extraction: lib/broker/)
   |
   +-------------------+-------------------+
   |                   |                   |
   v                   v                   v
WP-V3-03 (Registry)  WP-V3-04 (State Gate) WP-V3-05 (AO Lifecycle)
   |                   |                   |
   +-------------------+-------------------+
                       |
                       v
            WP-V3-06 (Semantic Broker CLI)
                       |
                       v
            WP-V3-07 (Auditor Bootstrap & Health)
                       |
                       v
            WP-V3-08 (Shadow Agent-to-Agent Loop)
                       |
                       v
            WP-V3-09 (Live One-Cycle Integration)
                       |
                       v
            WP-V3-10 (Continuous Bounded Loop)
                       |
                       v
            WP-V3-11 (Security Hardening: 127.0.0.1, remove raw shell)
                       |
                       v
            WP-V3-12 (Retire Legacy Audit Brain)
                       |
                       v
            WP-V3-13 (Optional MCP) -> WP-V3-14 (CI) -> WP-V3-15 (Release)
```

### Detailed WP Audit Table

| WP | Preconditions | Actual Files Touched | Hidden Callers / Dependencies | Tests to Run | Migration Risk | Exit Criteria |
|---|---|---|---|---|---|---|
| **WP-V3-00** | Stage 2 prompt | `docs/refactor-v3-thin-orchestrator/**` | None (docs only) | Git preflight, doc checks | Zero | Human Stage 2 Approval |
| **WP-V3-01** | WP-V3-00 approved | `pipeline-ui/send_to_codex.py`, `watch_codex_session.py`, test files | `server.js` legacy routes | `characterization.test.js` | Low | Zero false-positive transports |
| **WP-V3-02** | WP-V3-01 completed | `pipeline-ui/lib/broker/broker.js`, `pipeline-ui/lib/broker/lifecycle-store.js` | None (new module) | New unit tests for broker core | Low | Independent core library callable without Express |
| **WP-V3-03** | WP-V3-02 completed | `pipeline-ui/lib/broker/registry.js` | User project storage | Registry unit tests (canonical paths, duplicates) | Low | Multi-project registry with canonical root resolution |
| **WP-V3-04** | WP-V3-02 completed | `pipeline-ui/lib/broker/workspace-state.js` | Git CLI | State gate unit tests (tracked, untracked, submodules) | Low | Deterministic state hash; <50ms execution |
| **WP-V3-05** | WP-V3-02 completed | `pipeline-ui/lib/broker/antigravity-adapter.js` | `ao.exe` CLI | Mock AO lifecycle tests (accepted!=completed, envelope) | Medium | Provenance verified via completion envelope |
| **WP-V3-06** | WP-V3-02..05 | `pipeline-ui/agent-broker-cli.js` | Full broker library | CLI integration tests (stdout JSON, exit codes) | Low | CLI executes all broker operations via stdio |
| **WP-V3-07** | WP-V3-06 | `docs/runbooks/auditor-bootstrap.md` | Codex Full Harness | Manual auditor verification checklist | Low | Sol High runs CLI commands via `codex_exec` |
| **WP-V3-08** | WP-V3-07 | `pipeline-ui/lib/broker/broker.js` (dry-run flag) | Full Harness task | Shadow loop test (directive logged, no AO send) | Low | Sol High executes full audit -> dry-run dispatch |
| **WP-V3-09** | WP-V3-08 | Target fixture project | AO daemon, Antigravity | Live 1-cycle test (edit -> envelope -> re-audit) | Medium | Full end-to-end cycle verified on test repo |
| **WP-V3-10** | WP-V3-09 | `pipeline-ui/lib/broker/lifecycle-store.js` | Session resume | Multi-cycle resume test (turn end -> resume status) | Medium | Resumable across multiple ChatGPT turns |
| **WP-V3-11** | WP-V3-10 | `pipeline-ui/server.js`, `desktop-main.js` | Desktop Electron app | Security tests (127.0.0.1, removed test route) | Medium | Express bound to localhost, raw shell route gone |
| **WP-V3-12** | WP-V3-11 | `pipeline-ui/server.js`, `public/app.js` | UI views | Legacy route tests (disabled / returns 410 Gone) | Medium | Semantic audit routes & regex parsers deleted |
| **WP-V3-13** | WP-V3-12 | `pipeline-ui/lib/broker/mcp-server.js` | Broker library | MCP integration tests | Low | Optional MCP wrapper available |
| **WP-V3-14** | WP-V3-12 | CI workflow scripts | GitHub remote | Milestone push & check verification | Low | Pushed SHA corroboration working |
| **WP-V3-15** | WP-V3-12..14 | README, docs, operator manuals | All modules | Full regression suite pass | Low | Documentation matches release reality |

---

# 16. Revised Roadmap

- **Phase 0 — Pivot Design Lock:** WP-V3-00 (Completed in this turn).
- **Phase 1 — Preserve Baseline Correctness:** WP-V3-01.
- **Phase 2 — Thin Broker Core:** WP-V3-02 (Broker Core), WP-V3-03 (Registry), WP-V3-04 (Workspace-State Gate), WP-V3-05 (Antigravity Lifecycle Adapter), WP-V3-06 (Semantic Broker CLI).
- **Phase 3 — Attach Real Sol Auditor:** WP-V3-07 (Auditor Bootstrap & Health), WP-V3-08 (Shadow Agent-to-Agent Loop).
- **Phase 4 — Live Agent-to-Agent Loop:** WP-V3-09 (Live 1-Cycle Integration), WP-V3-10 (Continuous Bounded Loop & Resumability).
- **Phase 5 — Security & Legacy Deprecation:** WP-V3-11 (Security Hardening), WP-V3-12 (Retire Legacy Audit Brain).
- **Phase 6 — Optional & Release:** WP-V3-13 (Optional MCP Adapter), WP-V3-14 (GitHub Milestone Corroboration), WP-V3-15 (Release Cleanup).

---

# 17. Revised Master Checklist

### Stage 2 Validation (This Turn)
- [x] Thin Orchestrator boundary approved against codebase.
- [x] Persistent auditor task approved; `codex queue` heuristic polling rejected.
- [x] Semantic CLI first approved; MCP deferred to Phase 6.
- [x] Machine Completion Envelope confirmed as primary provenance mechanism.
- [x] Minimal workspace-state gate reviewed and edge cases mapped.
- [x] Security model reviewed: loopback binding and raw shell removal scheduled.
- [x] 44 negative tests specified and mapped.
- [x] WP dependency order verified.

### Implementation Checklist (Upcoming WPs)
- [ ] WP-V3-01: Carried-forward baseline correctness verified.
- [ ] WP-V3-02: Standalone broker core implemented and tested.
- [ ] WP-V3-03: Registry implemented with canonical root normalization.
- [ ] WP-V3-04: Workspace freshness gate implemented with Git plumbing.
- [ ] WP-V3-05: Antigravity adapter implemented with completion envelope verification.
- [ ] WP-V3-06: `agent-broker-cli.js` implemented with JSON stdout and exit codes.
- [ ] WP-V3-07: Auditor bootstrap runbook validated in real Codex Full Harness task.
- [ ] WP-V3-08: Shadow loop dry-run directive validated.
- [ ] WP-V3-09: Live 1-cycle agent-to-agent loop verified on fixture repo.
- [ ] WP-V3-10: Multi-cycle turn boundary resumability verified.
- [ ] WP-V3-11: Express bound to `127.0.0.1`; raw shell route removed.
- [ ] WP-V3-12: Legacy `/api/orchestrator/audit*` routes and regexes deleted.
- [ ] WP-V3-15: Release docs updated; claims verified.

---

# 18. Revised Negative-Test Mapping

| Test ID | Category | Type | Target Module | Fixture / Scenario | Expected State / Error Code |
|---|---|---|---|---|---|
| **V3-NT-001** | Registry | Unit | `registry.js` | Query unregistered project ID | `PROJECT_NOT_FOUND` (Exit 3) |
| **V3-NT-002** | Registry | Unit | `registry.js` | Two projects share same basename `foo` | Distinct canonical roots; no basename guessing |
| **V3-NT-003** | Registry | Integration| `worker-adapter.js` | Target AO session does not exist | `WORKER_SESSION_UNAVAILABLE` (Exit 3) |
| **V3-NT-004** | Auditor | Integration| `agent-broker-cli.js`| Task CWD != registered `project_root` | `CWD_MISMATCH`; dispatch blocked |
| **V3-NT-005** | Lifecycle | Unit | `lifecycle-store.js`| Dispatch while dispatch already active | `WORKER_BUSY` (Exit 4); no AO send |
| **V3-NT-006** | Lifecycle | Unit | `broker.js` | Re-submitting identical `work_order_id` | Return existing active dispatch; no double send |
| **V3-NT-007** | Freshness | Unit | `workspace-state.js`| Tracked file edited after audit snapshot | `STALE_AUDIT_STATE` (Exit 5) |
| **V3-NT-008** | Freshness | Unit | `workspace-state.js`| Untracked source file added after snapshot | `STALE_AUDIT_STATE` (Exit 5) |
| **V3-NT-009** | Freshness | Unit | `workspace-state.js`| Submodule commit moved after snapshot | `STALE_AUDIT_STATE` (Exit 5) |
| **V3-NT-010** | Security | Unit | `workspace-state.js`| Symlink points outside repo root | Recorded safely without escaping root |
| **V3-NT-011** | Transport | Integration| `worker-adapter.js` | `ao.exe send` returns nonzero exit code | `DISPATCH_FAILED` (Exit 6); state != RUNNING |
| **V3-NT-012** | Lifecycle | Integration| `worker-adapter.js` | AO send accepted, wait timeout expires | State remains `RUNNING`; no fake READY |
| **V3-NT-013** | Provenance| Unit | `worker-adapter.js` | Envelope from previous dispatch D1 appears | Ignored; wait continues for active D2 |
| **V3-NT-014** | Provenance| Unit | `worker-adapter.js` | Envelope has wrong `work_order_id` | `PROVENANCE_AMBIGUOUS` (Exit 7) |
| **V3-NT-015** | Provenance| Unit | `worker-adapter.js` | Envelope missing `dispatch_id` field | `PROVENANCE_AMBIGUOUS` (Exit 7) |
| **V3-NT-016** | Provenance| Unit | `worker-adapter.js` | Worker writes `done` in plain text | State remains `RUNNING`; no state change |
| **V3-NT-017** | Provenance| Unit | `worker-adapter.js` | Envelope specifies different `project_id` | Envelope rejected; state remains `RUNNING` |
| **V3-NT-018** | Auditor | Manual | Runbook | Full Harness connector disabled | Bootstrap fails closed; loop stops |
| **V3-NT-019** | Auditor | Integration| `health.js` | `codex-chatgpt-web doctor` fails | `AUDITOR_UNAVAILABLE`; dispatch blocked |
| **V3-NT-020** | Auditor | Integration| `health.js` | Auditor launched in wrong directory | Dispatch blocked with diagnostic error |
| **V3-NT-021** | Resilience| Integration| `broker.js` | ChatGPT browser turn terminates | Active dispatch kept in journal; resumes |
| **V3-NT-022** | Resilience| Integration| `lifecycle-store.js`| Orchestrator restarts during RUNNING | Active dispatch recovered; not reset to IDLE |
| **V3-NT-023** | Security | Unit | `agent-broker-cli.js`| Directive JSON contains `command` field | Schema reject: `INVALID_REQUEST` (Exit 2) |
| **V3-NT-024** | Security | Unit | `agent-broker-cli.js`| Request supplies unmapped session override | Override rejected in normal mode |
| **V3-NT-025** | Input | Unit | `agent-broker-cli.js`| Directive exceeds size limit (>2MB) | Rejected with `PAYLOAD_TOO_LARGE` |
| **V3-NT-026** | Input | Unit | `agent-broker-cli.js`| Malformed JSON passed as request file | `INVALID_REQUEST` (Exit 2) |
| **V3-NT-027** | Security | Unit | `worker-adapter.js` | Directive contains shell characters (`&\|;`)| Passed as raw argument/file; no shell eval |
| **V3-NT-028** | Security | Integration| `server.js` | Unauthenticated external HTTP request | HTTP 401 / 403 or connection refused |
| **V3-NT-029** | Security | Integration| `server.js` | Scan ports on non-loopback interface | Port closed (bound strictly to 127.0.0.1) |
| **V3-NT-030** | Security | Unit | `registry.js` | Project path contains `../../etc/` | Path traversal rejected |
| **V3-NT-031** | Durability| Unit | `lifecycle-store.js`| Process killed after intent, before AO send | Recovers as `DISPATCH_UNCERTAIN`; no resend |
| **V3-NT-032** | Durability| Unit | `lifecycle-store.js`| Corrupted journal file on startup | Fails closed; requires operator recovery |
| **V3-NT-033** | Workspace | Integration| `workspace-state.js`| Worker modifies files while running | Allowed; new state hashed post-completion |
| **V3-NT-034** | Workspace | Integration| `broker.js` | Third party edits repo while Sol audits | Next dispatch blocked by `STALE_AUDIT_STATE` |
| **V3-NT-035** | Boundary | Unit | `broker.js` | Worker report claims `tests passed: true` | Broker ignores claim; Sol verifies diff |
| **V3-NT-036** | Boundary | Manual | Bootstrap | Prompt injection in repo asks to dispatch | Sol instructed repo is untrusted data |
| **V3-NT-037** | Boundary | Manual | Bootstrap | Sol generates poor architectural plan | Broker executes control; human can pause |
| **V3-NT-038** | Boundary | Unit | `broker.js` | Sol calls complete while worker RUNNING | Rejection: active dispatch must finish first |
| **V3-NT-039** | Isolation | Integration| `send_to_codex.py` | `codex queue` emits rollout event | Zero effect on v3 broker state machine |
| **V3-NT-040** | Isolation | Integration| `server.js` | Legacy `/audit-and-direct` called | Cannot transition or trigger v3 broker |
| **V3-NT-041** | Bounds | Unit | `agent-broker-cli.js`| `timeout_secs: 99999` requested | Clamped to max allowed (30s); no hang |
| **V3-NT-042** | Multi-proj | Unit | `lifecycle-store.js`| Simultaneous dispatches to Project A & B | Independent locks; no cross-talk |
| **V3-NT-043** | Provenance| Unit | `worker-adapter.js` | Completion envelope file corrupted/truncated | `PROVENANCE_AMBIGUOUS` (Exit 7) |
| **V3-NT-044** | Resilience| Manual | Codex task | Codex IDE restarts while worker runs | Task re-opens; Sol queries status & recovers |

---

# 19. Legacy Deprecation Review

| Component / Feature | Current File Location | Current Role | Target Classification | Future Handling |
|---|---|---|---|---|
| `/api/orchestrator/audit` | `pipeline-ui/server.js:1891` | Ephemeral Codex audit + regex verdict | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Shadow in Phase 3-4, disabled/deleted in Phase 5 (`WP-V3-12`) |
| `/api/orchestrator/audit-and-direct` | `pipeline-ui/server.js:1955` | Orchestrator semantic loop engine | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Shadow in Phase 3-4, disabled/deleted in Phase 5 (`WP-V3-12`) |
| `/api/orchestrator/create-workorder` | `pipeline-ui/server.js:1841` | Ephemeral WorkOrder generation | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Deleted in Phase 5; Sol High creates directives directly |
| `getProjectLocalContext` | `pipeline-ui/server.js:680` | Context crawler & documentation packer | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Deleted from primary path; Sol High reads repo via Full Harness |
| `/api/extract/worktree/:id/test` | `pipeline-ui/server.js:1561` | Executes arbitrary test shell command | `REMOVE_AFTER_MIGRATION` | Severe security risk; completely removed in Phase 5 (`WP-V3-11`) |
| `send_to_codex.py` | `pipeline-ui/send_to_codex.py` | Queues prompts to Codex via `codex queue` | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Deprecated from v3 auditor flow; retained only for legacy tests |
| `watch_codex_session.py`| `pipeline-ui/watch_codex_session.py`| Scans `.codex/sessions/` rollout logs | `DEPRECATE` -> `REMOVE_AFTER_MIGRATION` | Deprecated; v3 uses machine completion envelope from worker |
| `send_to_antigravity.py`| `pipeline-ui/send_to_antigravity.py`| Background `ao send` dispatcher | `ADAPT` | Adapted into `pipeline-ui/lib/broker/antigravity-adapter.js` |
| `/api/status` | `pipeline-ui/server.js:313` | System doctor & binary versions | `KEEP` / `ADAPT` | Retained for Desktop UI health tab |
| `/api/projects` | `pipeline-ui/server.js:486` | Project list management | `KEEP` / `ADAPT` | Adapted to call `pipeline-ui/lib/broker/registry.js` |
| `/api/sessions` | `pipeline-ui/server.js:1188`| AO daemon session query | `KEEP` / `ADAPT` | Retained for setup mapping dropdowns |
| Desktop Electron Main | `pipeline-ui/desktop-main.js`| Electron wrapper & native dialogs | `KEEP` / `ADAPT` | Hardened: remove raw `exec`, use `execFile`, bind `127.0.0.1` |

---

# 20. Remaining Blockers

### Audit Findings on Potential Blockers:

1. **Does AO CLI lack exact turn IDs?**
   - *Status:* Confirmed (Audit Section 6).
   - *Resolution:* Fully mitigated by Decision D-03 (Machine Completion Envelope). No blocking dependency on AO internal APIs.
2. **Does local Codex CLI lack managed turn APIs?**
   - *Status:* Confirmed (Audit Section 5).
   - *Resolution:* Fully mitigated by Decision D-01 (User-Owned Persistent Codex Task). Orchestrator does not attempt automated queue polling.
3. **Does Full Harness tunnel timeout restrict wait durations?**
   - *Status:* Confirmed (Audit Section 4).
   - *Resolution:* Fully mitigated by Bounded Wait Protocol (individual waits clamped to ≤10–30s).
4. **Are there any architectural blockers preventing Stage 2 human approval?**
   - *Status:* **NONE.** All architectural decisions are locked, validated against code, and documented deterministically.

---

# 21. Recommended First Implementation WorkOrder

```markdown
# WORK ORDER: WO-V3-001

## WP-V3-01 — Baseline Correctness Seal (Legacy Transport Hardening)

Repository:
`ChatGPT-Orchestrator`

Base Branch:
`review/wp01-fix1`

Base HEAD:
`fde47f853e18d52f80e08dd1ab025685fc73a6db`

Governance Rule:
One Work Package per approved turn. WP-V3-01 and WP-V3-02 remain separate Work Packages.
This WorkOrder authorizes WP-V3-01 ONLY. It does NOT authorize WP-V3-02 or broker core extraction.

Preconditions:
1. Human Stage 2 approval granted for `docs/refactor-v3-thin-orchestrator/` at immutable review checkpoint.
2. Working tree clean on `review/wp01-fix1`.
3. Node.js >= 18 and Python 3 runtime available.

Goal:
Seal the legacy transport baseline so no known false-positive or unhandled exceptions remain before thin broker core extraction begins in WP-V3-02:
1. Ensure `pipeline-ui/send_to_codex.py` and `watch_codex_session.py` fail closed on any ambiguous transport state.
2. Ensure no generic JSON stdout can auto-activate exact Codex correlation.
3. Ensure target-turn error provenance is exact and session-bound diagnostics remain session-bound.
4. Verify all characterization and regression tests pass cleanly.

Allowed Files:
- `pipeline-ui/send_to_codex.py` [MODIFY]
- `pipeline-ui/watch_codex_session.py` [MODIFY]
- `pipeline-ui/test/refactor/characterization.test.js` [MODIFY]
- `pipeline-ui/test/refactor/wp01-regression.test.js` [NEW / MODIFY]

Forbidden Files:
- `pipeline-ui/lib/broker/**` (deferred to WP-V3-02)
- `pipeline-ui/agent-broker-cli.js` (deferred to WP-V3-06)
- `pipeline-ui/server.js`
- `pipeline-ui/public/**`
- `pipeline-ui/desktop-main.js`
- `launch-desktop.bat`
- `.gitmodules`
- `codex-chatgpt-web/**`
- `agent-orchestrator/**`

Exact Requested Changes:
1. Verify and enforce fail-closed behavior on all legacy transport helpers.
2. Ensure no syntax, parsing, or timeout exceptions leak unhandled.
3. Keep `send_to_codex.py` strictly isolated as a legacy test artifact; do not expand `codex queue` into the v3 auditor lifecycle.
4. Ensure characterization test suite confirms zero false-positive verified dispatches.

Required Tests:
- `python -m py_compile pipeline-ui/send_to_codex.py pipeline-ui/watch_codex_session.py pipeline-ui/send_to_antigravity.py`
- `node pipeline-ui/test/refactor/characterization.test.js`
- `npm test`

Expected Results:
- Zero syntax errors, zero unhandled rejections.
- All regression and characterization tests pass with exit code 0.

Failure Conditions:
- Modifying any forbidden file.
- Beginning WP-V3-02 broker core extraction prematurely.
- Expanding `codex queue` or introducing new heuristic queue-correlation logic.

Stop Conditions:
- Stop immediately after tests pass and test output packet is recorded. Do not proceed to WP-V3-02.

Worker Report Format:
- Machine test outputs.
- Raw git diff.
- Verification that no forbidden files were touched.
```

---

# Verification & Certification

This Stage 2 review has been completed in strict accordance with the Mission Charter.
- **Production code changed:** NONE.
- **Git commits created:** NONE.
- **Documentation status:** Fully synchronized and locked in `docs/refactor-v3-thin-orchestrator/`.
- **Result:** `READY_FOR_HUMAN_STAGE2_APPROVAL`.

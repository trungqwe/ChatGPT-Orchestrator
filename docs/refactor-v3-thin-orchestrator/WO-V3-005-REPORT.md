# WorkOrder Report: WO-V3-005

## WP-V3-05: Exact Antigravity Worker Lifecycle Adapter

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Working Branch**: `review/v3-wp05-antigravity-adapter`
- **Parent Branch**: `review/v3-wp04-workspace-state-seal`
- **Parent SHA**: `14983186b8edf960ecb3c029cc9edd52ab0b2912`
- **Architecture Authority**: `review/v3-stage2-architecture` (`3001dce9e0d010f4b68fc7b061072ec9b30f093d`)
- **Status**: `READY_FOR_WP_V3_05_EXTERNAL_REVIEW`

---

# 1. Baseline & Objective

WorkOrder `WO-V3-005` implements the concrete broker `workerPort` adapter for the Antigravity worker harness, interfacing through the Agent Orchestrator (AO) runtime.

### Governing Principles:
```text
SOL DECIDES
BROKER GUARDS + ROUTES
ANTIGRAVITY IMPLEMENTS
```

The adapter:
- **DELIVERS**: Formats dispatch envelope with exact orchestrator identity and triggers delivery via `ao send`.
- **OBSERVES**: Streams physical Antigravity transcript events using bounded memory and strict line delimitation.
- **BINDS IDENTITY**: Requires strict machine completion envelopes and exact dispatch boundary correlation.

The adapter does **NOT**:
- Audit code or judge implementation quality.
- Parse `WorkerReport` markdown or infer completion from prose phrases (`done`, `complete`, `finished`).
- Choose projects, sessions, or use format heuristics (`LIKE`, `latest`, mtime, cwd matching).

---

# 2. Local Environment & AO Probe Findings

### Evidence Categorization
- **LOCAL LIVE PROBE EVIDENCE**: Observed directly from local machine probe commands in Node v22.17.0 and Windows environment.
- **SOURCE INSPECTION**: Code analysis of existing thin-orchestrator broker, contracts, and lifecycle store.
- **MOCK / INJECTED TEST EVIDENCE**: Automated unit and integration test fixtures (`WA-001` .. `WA-042`, `BC-001` .. `BC-051`).
- **REAL AO SEND EXECUTED**: **NO** (Strictly forbidden by WP-V3-05 scope; deferred to WP-V3-09).

### Environment Capabilities
| Capability | Observed Value | Authority Status |
| :--- | :--- | :--- |
| Node Version | `v22.17.0` | Local live probe |
| SQLite Engine | `node:sqlite` (`DatabaseSync`) | Built-in native module verified available |
| Fallback Used? | **NONE** | No Python, no npm packages, no sqlite3 CLI |
| AO Binary | `C:\Users\Admin\AppData\Roaming\npm\ao.exe` | Version `dev` verified |
| AO Database Path | `C:\Users\Admin\.ao\data\ao.db` | Verified readable |
| AO DB Access Mode | `{ readOnly: true }` | Read-only connection, zero mutation |

### Database Schema (`sessions` table)
Probe of `C:\Users\Admin\.ao\data\ao.db` identified table `sessions` with the following relevant columns:
- `id` (TEXT, Primary Key): Exact AO session UUID.
- `project_id` (TEXT): Associated AO project name/ID.
- `harness` (TEXT): Harness identifier (`'agy'` for Antigravity).
- `agent_session_id` (TEXT): Provider conversation UUID corresponding to Antigravity brain storage.
- `native_transcript_path` (TEXT): Filesystem path to transcript JSONL under `AppData\Roaming\...\brain\<agent_session_id>\.system_generated\logs\transcript.jsonl`.

### Transcript Storage & Event Schema
Antigravity stores conversation transcripts in JSON Lines format:
- Path pattern: `<appDataDir>\brain\<agent_session_id>\.system_generated\logs\transcript.jsonl`
- User Events: `record.source === 'USER_EXPLICIT' && record.type === 'USER_INPUT'`
- Model Final Events: `record.source === 'MODEL' && record.type === 'PLANNER_RESPONSE'` with `record.status === 'DONE'`
- Tool/Intermediate Events: `type: 'VIEW_FILE'`, `type: 'RUN_COMMAND'`, etc. (explicitly excluded from completion authority)

---

# 3. Addendum Amendments Implementation (A-01 .. A-25)

1. **A-01 / A-02 / A-19 / A-20: Exact Session Identity**:
   - Format-based UUID inference is completely forbidden. An AO session UUID and provider conversation UUID are distinct namespaces.
   - Exact query: `SELECT * FROM sessions WHERE id = ?`. Exactly 1 row required.
   - Missing row returns `WORKER_SESSION_UNAVAILABLE` before any `ao send` call.
   - Requires `harness === 'agy'`. Harness mismatch fails closed with `WORKER_SESSION_UNAVAILABLE`.
   - `project_id` is validated for consistency; cannot be used to retarget or query other sessions.

2. **A-03 / A-25: Transcript Path Safety & Exact Mapping**:
   - Evaluates `native_transcript_path` and `agent_session_id`.
   - Realpaths the transcript file and verifies it is a regular file residing strictly inside the designated Antigravity brain storage directory. No directory scanning.

3. **A-04 / A-05: Read-Only Built-In SQLite**:
   - Uses `node:sqlite` `DatabaseSync(dbPath, { readOnly: true })`.
   - No `CREATE`, `UPDATE`, `DELETE`, or mutating PRAGMAs. Read failures yield `WORKER_WAIT_UNAVAILABLE`.

4. **A-06: Non-Definitive `ao send` Failures**:
   - Failure before send invocation (e.g. invalid descriptor, missing session row) is definitive (`ok: false, definitive: true`).
   - Once `ao send` has been spawned, non-zero exit or process error is ambiguous (`ok: false, definitive: false`), causing the broker to transition active dispatch to `DISPATCH_UNCERTAIN`. Resend is not authorized.

5. **A-07 / A-08: Broker Handling of `PROVENANCE_AMBIGUOUS`**:
   - `broker.js` contains a minimal compatibility branch:
     ```javascript
     if (waitRes.code === ERROR_CODES.PROVENANCE_AMBIGUOUS) {
       const provRes = await this.lifecycleStore.transition(
         activeDispatch.id,
         LIFECYCLE_STATES.PROVENANCE_AMBIGUOUS,
         { reason: 'WORKER_PROVENANCE_AMBIGUOUS', details: waitRes.details || null }
       );
       if (!provRes.ok) {
         return { ok: false, code: ERROR_CODES.LIFECYCLE_STORE_FAILURE, ... };
       }
       return { ok: false, code: ERROR_CODES.PROVENANCE_AMBIGUOUS, ... };
     }
     ```
   - Verified by `BC-050` and `BC-051`.

6. **A-09: Exact Line-0 Dispatch Boundary**:
   - Boundary search inspects only eligible `USER_INPUT` events.
   - Line 0 of `content` must strictly equal `[ORCHESTRATOR_DISPATCH_V1]`.
   - Line 1 must parse as valid JSON matching `type: 'worker_dispatch'`, `schema_version: 1`, `project_id`, `work_order_id`, `dispatch_id`, and `expected_workspace_state_id`.
   - Directives containing fake markers inside their body cannot establish a boundary (`WA-037`).

7. **A-10 / A-11: Exact Standalone Completion Line & Concluded Model Records**:
   - Completion marker must be a standalone line: `[ORCHESTRATOR_COMPLETION_V1] <single JSON object>`.
   - Markdown quotes, prose prefixes, trailing non-whitespace characters, or multiple JSON objects on the line are rejected.
   - Enclosing record must have `source: 'MODEL'`, `type: 'PLANNER_RESPONSE'`, and `status: 'DONE'`. Intermediate or non-final records are rejected (`WA-038`).

8. **A-12: Physical Ordering Authority**:
   - Physical JSONL line order in the transcript file is the sole boundary authority. Timestamp and `step_index` are retained for diagnostics only.

9. **A-13 / A-14 / A-15: Streaming Bounded Scanner & Append Safety**:
   - `scanSession(sessionId, visitor)` reads the transcript file in 64 KiB buffer chunks using file descriptors.
   - Streaming lines are decoded using strict UTF-8 (`fatal: true`).
   - If the final line in a snapshot lacks a trailing `\n`, it is treated as an incomplete concurrent append and withheld until the next poll tick (`WA-040`).
   - A malformed completed line triggers source integrity failure (`WA-041`).
   - Memory footprint is bounded independently of transcript size (`WA-042`).

10. **A-16 / A-17: Monotonic Deadline Polling**:
    - Polling runs until terminal completion/conflict is detected or monotonic deadline expires (`performance.now()`).
    - Timeout parameter is clamped to `1..30` seconds. Non-terminal states return `DISPATCH_ACCEPTED` (if boundary not yet in transcript) or `RUNNING` (boundary present, completion pending).

11. **A-18: Dynamic Mapping Change Fail-Closed**:
    - Re-verifies exact AO session to transcript path mapping across scan ticks.
    - If mapping changes mid-wait for the same dispatch, fails closed with `PROVENANCE_AMBIGUOUS` (`WA-039`).

12. **A-21 / A-22 / A-23: Completion Provenance Rules**:
    - Envelopes with foreign `dispatch_id` (e.g. previous dispatch `D1`) are ignored.
    - Envelopes claiming current `dispatch_id` with mismatched `project_id`, `work_order_id`, or `state !== 'READY_FOR_REVIEW'` yield `PROVENANCE_AMBIGUOUS`.
    - Malformed JSON on an exact completion marker line after the boundary yields `PROVENANCE_AMBIGUOUS`.
    - Multiple completion envelopes for the same active dispatch yield `PROVENANCE_AMBIGUOUS`.

13. **A-24: Zero Dispatch-Local Memory Reconstruction**:
    - An entirely fresh adapter instance initialized with only immutable project and dispatch parameters re-derives session mapping and re-finds the dispatch boundary from the raw transcript (`WA-024`).

---

# 4. Architecture & Component Wiring

### New Production Modules
1. `pipeline-ui/lib/broker/antigravity-completion-source.js`:
   - Interfaces with AO SQLite database (`ao.db`) via read-only `node:sqlite`.
   - Resolves exact session rows, checks harness authority, and validates transcript path containment.
   - Implements append-safe streaming line visitor `scanSession(sessionId, visitor)`.

2. `pipeline-ui/lib/broker/worker-adapter.js`:
   - Factory `createAntigravityWorkerPort(options)` returning standard port contract `{ dispatch, wait, status, formatDispatchEnvelope }`.
   - Binds to registry worker descriptor and executes `ao send --session <session_id>` with argument arrays (`shell: false`).
   - Manages monotonic wait loop, dispatch boundary detection, and completion validation.

### Broker Compatibility Modifications
- `pipeline-ui/lib/broker/broker.js`:
  1. Forwards `expected_workspace_state_id: request.expected_workspace_state_id` to `workerPort.dispatch`.
  2. Mappings adapter-returned `PROVENANCE_AMBIGUOUS` error to lifecycle state `PROVENANCE_AMBIGUOUS`.

---

# 5. Section 95: Provenance Table

| Observation | Before/after boundary? | Identity exact? | Authoritative? | Result |
| :--- | :--- | :--- | :--- | :--- |
| Plain "done" / "complete" prose | After | No | **NO** | Ignored (`RUNNING`) |
| Old D1 completion before D2 boundary | Before | Foreign (`dispatch_id = D1`) | **NO** | Ignored (Pre-boundary) |
| Old D1 completion after D2 boundary | After | Foreign (`dispatch_id = D1`) | **NO** | Ignored (`RUNNING`) |
| D2 exact completion envelope in `PLANNER_RESPONSE` (`DONE`) | After | Yes (`dispatch_id = D2`, all fields match) | **YES** | `READY_FOR_REVIEW` |
| D2 completion with wrong work order / project | After | Mismatched | **NO** | `PROVENANCE_AMBIGUOUS` |
| D2 completion marker with malformed JSON | After | Unparseable | **NO** | `PROVENANCE_AMBIGUOUS` |
| Multiple D2 completion envelopes | After | Conflicting | **NO** | `PROVENANCE_AMBIGUOUS` |
| Completion marker inside `USER_INPUT` directive | At / Before | N/A (User source) | **NO** | Ignored (Not model output) |
| Completion marker inside intermediate tool record (`VIEW_FILE`) | After | N/A (Tool type) | **NO** | Ignored (`RUNNING`) |
| Completion text from another AO session | N/A | Wrong session | **NO** | Never read (Session isolated) |

---

# 6. Section 96: Wait State Table

| Observation | Adapter Response | Broker Consequence |
| :--- | :--- | :--- |
| Send accepted, boundary absent in transcript | `{ ok: true, state: 'DISPATCH_ACCEPTED' }` | Lifecycle remains `DISPATCH_ACCEPTED` |
| Boundary present, completion absent (deadline expired) | `{ ok: true, state: 'RUNNING' }` | Lifecycle transitions `RUNNING` |
| Exact completion envelope observed | `{ ok: true, state: 'READY_FOR_REVIEW', completion: {...} }` | Lifecycle transitions `READY_FOR_REVIEW` |
| Temporary observer failure (DB locked, transcript unreadable) | `{ ok: false, code: 'WORKER_WAIT_UNAVAILABLE' }` | Broker returns error, lifecycle untouched |
| Definitive pre-send failure (invalid session / harness) | `{ ok: false, code: 'WORKER_SESSION_UNAVAILABLE', definitive: true }` | Broker returns failure, dispatch aborted |
| Ambiguous `ao send` failure (process error / non-zero exit) | `{ ok: false, code: 'TRANSPORT_ERROR', definitive: false }` | Broker transitions `DISPATCH_UNCERTAIN` |
| Provenance ambiguity (marker malformed / conflicting envelopes) | `{ ok: false, code: 'PROVENANCE_AMBIGUOUS' }` | Broker transitions `PROVENANCE_AMBIGUOUS` |

---

# 7. Section 97: Restart / Durability Table

| Capability | WP-V3-05 Status | Reason |
| :--- | :--- | :--- |
| Adapter Reconstruction Provenance | **IMPLEMENTED** | Fresh adapter instance re-derives session mapping and re-finds dispatch boundary from raw transcript (`WA-024`). |
| Exact Dispatch Boundary Re-discovery | **IMPLEMENTED** | Line-0 canonical header search in physical JSONL transcript reconstructs exact boundary without memory. |
| Broker Lifecycle Persistence | **NOT IMPLEMENTED IN WP-V3-05** | Lifecycle store is in-memory volatile by architecture (`review/v3-stage2-architecture`). |
| Full Process Restart Recovery | **NOT CLAIMED** | Requires persistent lifecycle store and coordinator state recovery (deferred to future WPs). |

---

# 8. Test Matrix Verification

### Worker Adapter Suite (`WA-001` .. `WA-042`)
Command: `node pipeline-ui/test/refactor/worker-adapter.test.js`
Result: **42/42 PASS**
```text
[WA-001] Valid dispatch invocation formats envelope and calls ao send ... ✓ PASSED
[WA-002] Formatted dispatch envelope includes required header and metadata ... ✓ PASSED
[WA-003] Worker registration lookup missing worker section fails closed ... ✓ PASSED
[WA-004] Worker session id missing fails closed ... ✓ PASSED
[WA-005] Non-zero ao send exit code returns ok: false, definitive: false ... ✓ PASSED
[WA-006] Pre-send validation failure returns definitive: true ... ✓ PASSED
[WA-007] Spawn error returns ok: false with non-definitive error ... ✓ PASSED
[WA-008] Valid completion envelope transitions to READY_FOR_REVIEW ... ✓ PASSED
[WA-009] Wait before boundary appears returns DISPATCH_ACCEPTED ... ✓ PASSED
[WA-010] Wait after boundary but before completion returns RUNNING ... ✓ PASSED
[WA-011] Stale completion from previous dispatch ignored ... ✓ PASSED
[WA-012] Prose "done" or "complete" does not trigger completion ... ✓ PASSED
[WA-013] Completion envelope with wrong work_order_id fails PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-014] Completion envelope with wrong project_id fails PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-015] Completion envelope with invalid JSON fails PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-016] Completion envelope with unknown state fails PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-017] Duplicate completion envelopes fail PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-018] Completion envelope with missing required field fails PROVENANCE_AMBIGUOUS ... ✓ PASSED
[WA-019] USER_INPUT containing completion marker is ignored ... ✓ PASSED
[WA-020] Tool output containing completion marker is ignored ... ✓ PASSED
[WA-021] Wait timeout clamp enforces min 1s max 30s ... ✓ PASSED
[WA-022] Missing transcript file returns WORKER_WAIT_UNAVAILABLE ... ✓ PASSED
[WA-023] Malformed transcript line fails closed ... ✓ PASSED
[WA-024] Reconstruction: new adapter instance observes existing completed dispatch ... ✓ PASSED
[WA-025] Status returns current observable worker state ... ✓ PASSED
[WA-026] AO sqlite lookup finds exact session row ... ✓ PASSED
[WA-027] AO sqlite missing session returns WORKER_SESSION_UNAVAILABLE ... ✓ PASSED
[WA-028] AO sqlite harness mismatch returns WORKER_SESSION_UNAVAILABLE ... ✓ PASSED
[WA-029] AO sqlite read error returns WORKER_WAIT_UNAVAILABLE ... ✓ PASSED
[WA-030] AO transcript outside expected directory fails path traversal check ... ✓ PASSED
[WA-031] ao send uses exact session_id argument array (shell: false) ... ✓ PASSED
[WA-032] Directives passed untouched in envelope body ... ✓ PASSED
[WA-033] Multiple dispatches in same session ordered by physical transcript position ... ✓ PASSED
[WA-034] Whitespace around completion marker parsed safely ... ✓ PASSED
[WA-035] Completion envelope embedded in markdown code block rejected ... ✓ PASSED
[WA-036] AO session ID and provider conversation ID are different UUIDs ... ✓ PASSED
[WA-037] Directive containing fake dispatch marker cannot create boundary ... ✓ PASSED
[WA-038] Intermediate / non-final model output cannot complete dispatch ... ✓ PASSED
[WA-039] Transcript / source mapping changes during active wait fails closed ... ✓ PASSED
[WA-040] Trailing partially-written JSONL record is not parsed as completion ... ✓ PASSED
[WA-041] Completed malformed JSONL record fails source integrity ... ✓ PASSED
[WA-042] Transcript scanner remains bounded on large history ... ✓ PASSED
```

### Broker Core Suite (`BC-001` .. `BC-051`)
Command: `node pipeline-ui/test/refactor/broker-core.test.js`
Result: **51/51 PASS**
- `BC-049`: `expected_workspace_state_id` forwarded unchanged to `workerPort.dispatch`.
- `BC-050`: `workerPort.wait` returns exact `PROVENANCE_AMBIGUOUS` -> broker lifecycle becomes `PROVENANCE_AMBIGUOUS`.
- `BC-051`: Provenance transition failure -> `LIFECYCLE_STORE_FAILURE`.

### Workspace State Regression (`WS-001` .. `WS-051`)
Command: `node pipeline-ui/test/refactor/workspace-state.test.js`
Result: **51/51 PASS**

### Registry Regression (`RG-001` .. `RG-039`)
Command: `node pipeline-ui/test/refactor/registry.test.js`
Result: **39/39 PASS**

### Characterization & WP-V3-01 Regression
- `node pipeline-ui/test/refactor/wp01-regression.test.js`: **17/17 PASS** (`L-NT-029` .. `L-NT-045`)
- `node pipeline-ui/test/refactor/characterization.test.js`: **PASS**

### `npm test`
- Result: Exited with code 1 (`AssertionError: Found registered project workspace-test`).
- Classification: `UNCHANGED_PRE_EXISTING_FAILURE` (baseline fixture defect documented in WO-V3-001).

---

# 9. Invariant Verification

- **PROV-01 (Machine Authority)**: Verified. Completion requires exact standalone marker `[ORCHESTRATOR_COMPLETION_V1]` with valid JSON payload. Prose matching is entirely absent.
- **PROV-02 (Identity Binding)**: Verified. Completion envelope must strictly match `project_id`, `work_order_id`, and `dispatch_id`. Any mismatch fails closed with `PROVENANCE_AMBIGUOUS`.
- **PROV-03 (Exact Session Mapping)**: Verified. Resolution queries `sessions.id = ?` using built-in `node:sqlite` in read-only mode. No heuristics, no format guessing.
- **PROV-04 (Boundary Isolation)**: Verified. Boundary is established strictly at line 0 of `USER_INPUT`. Pre-boundary events and stale completions are ignored.
- **PROV-05 (Fail-Closed Transport)**: Verified. Post-spawn `ao send` failures yield `DISPATCH_UNCERTAIN`. Adapter ambiguity yields `PROVENANCE_AMBIGUOUS`.

---

# 10. Scope Compliance (Section 98)

```text
WP-V3-06 started:
NO

Semantic CLI:
NO

WP-V3-07 started:
NO

Codex bootstrap:
NO

Real AO implementation directive sent:
NO

server.js modified:
NO

UI modified:
NO

registry.js modified:
NO

workspace-state.js modified:
NO

lifecycle-store.js modified:
NO

package.json modified:
NO
```

Broker modifications made:
1. Passed `expected_workspace_state_id: request.expected_workspace_state_id` to `workerPort.dispatch`.
2. Mapped adapter `PROVENANCE_AMBIGUOUS` to lifecycle state `PROVENANCE_AMBIGUOUS` with transition error check.

Untracked files:
- `manifest.json` (ambient, untouched and uncommitted).

---

# 11. Conclusion & Result

```text
READY_FOR_WP_V3_05_EXTERNAL_REVIEW
```

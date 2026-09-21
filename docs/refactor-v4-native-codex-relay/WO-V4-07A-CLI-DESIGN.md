# WO-V4-07A CLI DESIGN — Audit / Recover CLI Contract

- **Work Order**: WO-V4-07A-PUB (publication gate revision)
- **Parent Commit**: `119e93f96b8e5eddaf81b8ddefba4b485c76f554`
- **Status**: DESIGN / CONTRACT ONLY — No production code modified
- **WP-V4-06**: `COMPLETE`
- **WP-V4-07**: `DESIGN_IN_REVIEW`

---

## Source-Alignment Gate Results

The following defects were identified and corrected before publication:

**Gate A — CLI outputs are projections**: `registry_project` is a raw return field of `inspectAuditorBootstrap()` but is explicitly NOT forwarded to CLI JSON output. Only an approved projected field set is emitted. `decision_json`, `validated_decision`, and `decision` are never emitted in any path. `worker.session_id` is not emitted. Corrected in §3.1 with explicit allowlist documentation.

**Gate B — inspect Registry limitation**: `inspectAuditorBootstrap()` silences Registry read exceptions and maps both "Registry unavailable" and "project not found" to `registry_binding_state: PROJECT_NOT_FOUND`. The CLI cannot and does not distinguish `REGISTRY_UNAVAILABLE` from `PROJECT_NOT_FOUND`. The exit-code matrix does not assign a distinct code for Registry unavailability in the inspect path. Documented explicitly in §3.1 and §5.

**Gate C — provider inspection failure remains AUDIT_UNCERTAIN**: `resolveAuditorBootstrapUncertainty()` on provider `readThread` failure returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: '...' }` — it does NOT throw a distinct provider-unavailable error. Therefore, provider inspection failure belongs at **exit 5** (AUDIT_UNCERTAIN semantic hold), not at a separate provider exit. Exit 7 has been removed from the matrix. The `reason` string prefix is NOT parsed to derive exit authority.

**Gate D — NO_ACTIVE_BOOTSTRAP is successful/idempotent**: `recover` and `retire-legacy` return `ok: true, status: 'NO_ACTIVE_BOOTSTRAP'` when no active bootstrap exists. This is exit 0.

**Gate E — legacy retirement is explicit only**: `retire-legacy` requires `--confirm`. It delegates exclusively to `retireLegacyAuditorBootstrapWithoutAuthority`. `recover` never auto-retires legacy authority.

**Open Questions**: All four resolved in §10.

---

## 1. Source Authority Inventory

### 1.1. Lifecycle module

**File**: `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`

Exports four externally callable lifecycle APIs:

| Function | Sync/Async | Provider calls | Recovery-store mutations | Registry reads | Registry mutations |
|---|---|---|---|---|---|
| `inspectAuditorBootstrap` | async | none | none | 1 read (optional, best-effort) | none |
| `recoverAuditorBootstrap` | async | 1 x adapterFactory + resumeThread (cases 3-5 only) | deleteActiveBootstrap / transitionBootstrap | 1-2 reads (cases 1b, 3-5) | 1 x bindAuditorThread (case 5 only) |
| `resolveAuditorBootstrapUncertainty` | async | 1 x adapterFactory + readThread (non-mutating provider read) | 0 or 1 x transitionBootstrap | 1 read | none |
| `retireLegacyAuditorBootstrapWithoutAuthority` | async | none | 1 x retireLegacyBootstrap | 1 read | none |

#### API classification detail

**`inspectAuditorBootstrap(options)`**

```
read-only:               YES
recovery-store mutation: NO
Registry mutation:       NO
provider read:           NO
provider side effect:    NO
model turn:              NO
```

Reads `recoveryStore.getActiveBootstrap(projectId)` and `recoveryStore.getBootstrapHistory(projectId)`, then optionally reads the Registry project to classify `registry_binding_state`. Raw return shape from lifecycle:
```
{ project_id, active_bootstrap, history, registry_binding_state, registry_project }
```

The CLI projects ONLY an approved field subset into JSON output. `registry_project` is never forwarded. See §3.1 for the exact output allowlist.

Registry read behavior: Failures in the Registry read (including exceptions and project-not-found) are both silenced by the lifecycle function and mapped to `registry_binding_state = 'PROJECT_NOT_FOUND'`. The CLI cannot distinguish `REGISTRY_UNAVAILABLE` from `PROJECT_NOT_FOUND` via this API. No CLI exit code claims this distinction. If the distinction is needed in a future implementation, it requires a separate lifecycle API enhancement with a machine-readable classification field.

**`recoverAuditorBootstrap(options)`**

```
read-only:               NO (cases PROVISIONAL, FIRST_TURN_*, DECISION_VALIDATED..REGISTRY_BINDING mutate recovery store)
recovery-store mutation: YES — deleteActiveBootstrap or transitionBootstrap (state-dependent)
Registry mutation:       YES — bindAuditorThread (REGISTRY_BINDING case only)
provider read:           YES — resumeThread (RESUME_VERIFYING case, non-model)
provider side effect:    NO (no turn/start)
model turn:              NO
```

State to action mapping:
- `PROVISIONAL_THREAD` -> deleteActiveBootstrap (no provider calls, no Registry reads)
- `FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT` -> transitionBootstrap(..., AUDIT_UNCERTAIN) (no provider calls, no Registry reads)
- `AUDIT_UNCERTAIN` (already) -> return AUDIT_UNCERTAIN status (no mutation)
- `AUDIT_TERMINAL_NO_DECISION` -> verifies Registry unbound, then deleteActiveBootstrap
- `DECISION_VALIDATED` -> transitionBootstrap(RESUME_VERIFYING) + provider resumeThread + transitionBootstrap(RESUME_VERIFIED) + proceeds to REGISTRY_BINDING
- `RESUME_VERIFYING` -> provider resumeThread + transitionBootstrap(RESUME_VERIFIED) + proceeds to REGISTRY_BINDING
- `RESUME_VERIFIED` -> transitionBootstrap(REGISTRY_BINDING) + REGISTRY_BINDING
- `REGISTRY_BINDING` -> drift check, then bindAuditorThread + deleteActiveBootstrap

Requires `authority_version === 1` for states `DECISION_VALIDATED..REGISTRY_BINDING`; throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` for `authority_version === 0`.

**`resolveAuditorBootstrapUncertainty(options)`**

```
read-only:               NO (may write DECISION_VALIDATED or AUDIT_TERMINAL_NO_DECISION)
recovery-store mutation: YES — 0 or 1 x transitionBootstrap
Registry mutation:       NO
provider read:           YES — readThread (non-model read-only provider call)
provider side effect:    NO
model turn:              NO
```

Preconditions: active bootstrap in `AUDIT_UNCERTAIN`, Registry project exists, auditor unbound, `authority_version === 1`. Spawns a fresh provider client, calls `readThread({ includeTurns: true })`, closes client unconditionally in `finally`. Caller-supplied `threadId`, `turnId`, `turnStatus`, or `decision` are explicitly forbidden.

Outcome classification (all returned as structured result objects, never thrown):
- Provider `readThread` fails -> `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'PROVIDER_INSPECTION_FAILED: ...' }` — no recovery-store mutation. Maps to exit 5.
- Thread ID mismatch -> `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'THREAD_ID_MISMATCH: ...' }` — no mutation. Exit 5.
- Turn history invalid -> `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'TURN_HISTORY_INVALID: ...' }` — no mutation. Exit 5.
- `interrupted`/`failed` turn -> AUDIT_TERMINAL_NO_DECISION (recovery-store mutation). Exit 0.
- `completed` turn with valid decision -> DECISION_VALIDATED (recovery-store mutation). Exit 0.
- non-terminal / unrecognized status -> `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'TURN_NONTERMINAL: ...' }` — no mutation. Exit 5.

The CLI reads `status` from the returned object to determine exit code. The `reason` string prefix is NOT parsed to derive exit authority.

**`retireLegacyAuditorBootstrapWithoutAuthority(options)`**

```
read-only:               NO
recovery-store mutation: YES — retireLegacyBootstrap (appends history -> LEGACY_AUTHORITY_RETIRED, deletes active row)
Registry mutation:       NO
provider read:           NO
provider side effect:    NO
model turn:              NO
```

Preconditions: active bootstrap with `authority_version === 0`, Registry project exists and auditor is unbound (`thread_id === null`, `enabled === false`). The `operation_id` is read internally from `recoveryStore.getActiveBootstrap`; no caller supply permitted.

### 1.2. Recovery store

**File**: `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`

Key state constants:
```
PROVISIONAL_THREAD       FIRST_TURN_STARTING      FIRST_TURN_IN_FLIGHT
DECISION_VALIDATED       RESUME_VERIFYING         RESUME_VERIFIED
REGISTRY_BINDING         AUDIT_UNCERTAIN           AUDIT_TERMINAL_NO_DECISION
LEGACY_AUTHORITY_RETIRED
```

Allowed transitions (from -> to):
```
PROVISIONAL_THREAD       -> FIRST_TURN_STARTING | AUDIT_UNCERTAIN
FIRST_TURN_STARTING      -> FIRST_TURN_IN_FLIGHT | AUDIT_UNCERTAIN
FIRST_TURN_IN_FLIGHT     -> DECISION_VALIDATED | AUDIT_UNCERTAIN
DECISION_VALIDATED       -> RESUME_VERIFYING | AUDIT_UNCERTAIN
RESUME_VERIFYING         -> RESUME_VERIFIED | AUDIT_UNCERTAIN
RESUME_VERIFIED          -> REGISTRY_BINDING | AUDIT_UNCERTAIN
REGISTRY_BINDING         -> AUDIT_UNCERTAIN
AUDIT_UNCERTAIN          -> AUDIT_TERMINAL_NO_DECISION | DECISION_VALIDATED
AUDIT_TERMINAL_NO_DECISION -> (terminal)
LEGACY_AUTHORITY_RETIRED   -> (terminal, history only - no active row)
```

Schema version: `2`. Active bootstrap table: `auditor_bootstrap` (1 row per project). History table: `auditor_bootstrap_history`.

### 1.3. Registry

**File**: `pipeline-ui/lib/broker/registry.js`

`getAuditorBindingState(auditor)` exhaustive return values (verified from source):

| Return value | Condition |
|---|---|
| `AUDITOR_REGISTRATION_REQUIRED` | `auditor.thread_id === null` |
| `AUDITOR_BOUND_READY` | `auditor.thread_id !== null && auditor.enabled === true` |
| `AUDITOR_BOUND_DISABLED` | `auditor.thread_id !== null && auditor.enabled !== true` |

Plus two values added by the `inspectAuditorBootstrap` lifecycle wrapper:

| Return value | Condition |
|---|---|
| `PROJECT_NOT_FOUND` | Registry read exception or project missing |
| `UNKNOWN` | `registryPort` not provided to inspect |

`bindAuditorThread` is the only Registry mutation in any lifecycle path. It is guarded by drift validation (`assertBootstrapAuthorityMatchesRegistry`) immediately before invocation.

### 1.4. Existing broker CLI

**File**: `pipeline-ui/agent-broker-cli.js`

Commands: `snapshot`, `worker-status`, `worker-dispatch`, `worker-wait`. Does not include any auditor recovery surface. Establishes the following patterns to replicate:
- Strict argument parser rejecting unknown commands, unknown flags, duplicates, and positional args.
- Machine-readable JSON stdout for all output including errors.
- `FORBIDDEN_FLAGS` set blocking routing/execution overrides.
- `mapErrorCodeToExitCode` table driven by `err.code`, not `err.message`.
- `writeStderr` for diagnostics only.

### 1.5. Real-state freeze (WO-V4-07A)

```
auditor.thread_id:       01a0be36-97bb-7831-8adb-02e1c1e70be0
auditor.enabled:         true
recovery schema:         2
active recovery:         NONE
```

Zero real thread/start, turn/start, model turns, Registry mutation, or recovery mutation during WO-V4-07A.

---

## 2. Proposed Command Surface

The WP-V4-07 CLI is a separate entry point from `agent-broker-cli.js`. Proposed file: `pipeline-ui/auditor-recover-cli.js`.

Four commands are defined. Legacy retirement is a distinct explicit operator command; it is never invoked automatically by `recover`.

### 2.1. `inspect`

Read-only status query. Returns the active bootstrap record and history. Emits only an explicit allowlist of fields — never raw lifecycle return objects.

```
Command:     inspect
Required:    --project-id <project-id>
Optional:    (none)
Forbidden:   --thread-id --turn-id --decision --turn-status --project-root
             --cwd --model --effort --operation-id
JSON stdout: see §3.1
Stderr:      diagnostic only (no secrets)
Exits:       see §5
Mutates:     NO
Operator intent required: NO
```

### 2.2. `recover`

Drives the crash-recovery state machine for one project. Delegates entirely to `recoverAuditorBootstrap`. Never auto-retires legacy authority. Never re-issues `turn/start`.

```
Command:     recover
Required:    --project-id <project-id>
Optional:    (none)
Forbidden:   --thread-id --turn-id --decision --turn-status --project-root
             --cwd --model --effort --operation-id
JSON stdout: see §3.2
Stderr:      diagnostic only (no secrets)
Exits:       see §5
Mutates:     YES (state-dependent - see §6)
Operator intent required: YES (caller must understand this may bind Registry)
```

`recover` does not permit specifying a target state. The lifecycle function drives the state machine from its observed position.

### 2.3. `resolve-uncertainty`

Resolves `AUDIT_UNCERTAIN` via non-model provider `readThread`. Delegates entirely to `resolveAuditorBootstrapUncertainty`. Provider failure preserves `AUDIT_UNCERTAIN` at exit 5; it is not a distinct CLI/process error.

```
Command:     resolve-uncertainty
Required:    --project-id <project-id>
Optional:    (none)
Forbidden:   --thread-id --turn-id --decision --turn-status --project-root
             --cwd --model --effort --operation-id
JSON stdout: see §3.3
Stderr:      diagnostic only (no secrets)
Exits:       see §5
Mutates:     YES (0 or 1 transition depending on provider response)
Operator intent required: YES (spawns provider connection)
```

### 2.4. `retire-legacy`

Explicit operator command to retire an `authority_version === 0` bootstrap. Must never be invoked automatically. Delegates exclusively to `retireLegacyAuditorBootstrapWithoutAuthority`.

```
Command:     retire-legacy
Required:    --project-id <project-id>  --confirm
Optional:    (none)
Forbidden:   --thread-id --turn-id --decision --operation-id
             --project-root --cwd --model --effort
JSON stdout: see §3.4
Stderr:      diagnostic only
Exits:       see §5
Mutates:     YES - LEGACY_AUTHORITY_RETIRED history + deletes active row
Operator intent required: YES (--confirm required)
```

Preconditions enforced by lifecycle (not duplicated in CLI):
- active bootstrap exists
- `authority_version === 0`
- fresh Registry project exists
- `auditor.thread_id === null`
- `auditor.enabled === false`

---

## 3. JSON Output Schemas

All commands emit exactly one JSON object to stdout followed by `\n`. No partial output. No pretty-printing. All fields emitted are explicitly enumerated below — no spread of raw lifecycle return objects.

Stderr is for diagnostics only. No secrets in any output channel.

### 3.1. `inspect` response

The CLI projects the following explicit allowlist from the lifecycle result. `registry_project` from the lifecycle return is NOT forwarded. `decision_json` and `validated_decision` are NOT forwarded. `expected_project_root_identity` is NOT forwarded (internal identity key).

**Permitted `active_bootstrap` fields (allowlist)**:
`project_id`, `operation_id`, `audit_subject_id`, `thread_id`, `turn_id`, `workspace_state_observed`, `state`, `has_decision` (derived: `decision_json !== null`), `decision_sha256`, `authority_version`, `expected_project_root`, `expected_auditor_model_policy`, `created_at`, `updated_at`

**Permitted `history` entry fields (allowlist)**:
`history_seq`, `operation_id`, `previous_state`, `next_state`, `iso`

Note: `registry_binding_state` uses the exhaustive vocabulary from §1.3: `AUDITOR_REGISTRATION_REQUIRED`, `AUDITOR_BOUND_READY`, `AUDITOR_BOUND_DISABLED`, `PROJECT_NOT_FOUND`, `UNKNOWN`. `REGISTRY_UNAVAILABLE` is not a distinct value — both Registry exceptions and missing project map to `PROJECT_NOT_FOUND`.

**Success — no active bootstrap**:
```json
{
  "ok": true,
  "operation": "inspect",
  "project_id": "chatgpt-orchestrator",
  "active_bootstrap": null,
  "history": [],
  "registry_binding_state": "AUDITOR_BOUND_READY"
}
```

**Success — active bootstrap present**:
```json
{
  "ok": true,
  "operation": "inspect",
  "project_id": "chatgpt-orchestrator",
  "active_bootstrap": {
    "project_id": "chatgpt-orchestrator",
    "operation_id": "op-abc123",
    "audit_subject_id": "string",
    "thread_id": "string",
    "turn_id": null,
    "workspace_state_observed": "string",
    "state": "PROVISIONAL_THREAD",
    "has_decision": false,
    "decision_sha256": null,
    "authority_version": 1,
    "expected_project_root": "/path/to/root",
    "expected_auditor_model_policy": "standard",
    "created_at": "2026-09-21T05:00:00.000Z",
    "updated_at": "2026-09-21T05:00:00.000Z"
  },
  "history": [
    {
      "history_seq": 1,
      "operation_id": "op-abc123",
      "previous_state": null,
      "next_state": "PROVISIONAL_THREAD",
      "iso": "2026-09-21T05:00:00.000Z"
    }
  ],
  "registry_binding_state": "AUDITOR_REGISTRATION_REQUIRED"
}
```

**Error**:
```json
{
  "ok": false,
  "operation": "inspect",
  "code": "INVALID_CLI_REQUEST",
  "error": "string"
}
```

### 3.2. `recover` response

**Success — no active bootstrap (idempotent)**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "string",
  "status": "NO_ACTIVE_BOOTSTRAP"
}
```

**Success — bootstrap cleared**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "string",
  "status": "RECOVERED_CLEARED",
  "previous_state": "PROVISIONAL_THREAD",
  "thread_id": "string"
}
```

**Success — terminal no-decision cleared**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "string",
  "status": "RECOVERED_TERMINAL_NO_DECISION_CLEARED",
  "previous_state": "AUDIT_TERMINAL_NO_DECISION",
  "thread_id": "string"
}
```

**Success — DURABLE_BOUND**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "string",
  "status": "DURABLE_BOUND",
  "thread_id": "string",
  "reconciled": true
}
```

**Semantic halt — AUDIT_UNCERTAIN preserved** (exit 5):
```json
{
  "ok": false,
  "operation": "recover",
  "project_id": "string",
  "status": "AUDIT_UNCERTAIN",
  "thread_id": "string",
  "code": "AUDIT_UNCERTAIN",
  "message": "string"
}
```

**Error**:
```json
{
  "ok": false,
  "operation": "recover",
  "project_id": "string",
  "code": "string",
  "error": "string"
}
```

### 3.3. `resolve-uncertainty` response

The `decision` object (AuditDecisionV1) is NEVER emitted. Only `decision_sha256` is emitted when a decision is validated.

**Success — resolved to DECISION_VALIDATED**:
```json
{
  "ok": true,
  "operation": "resolve-uncertainty",
  "project_id": "string",
  "status": "DECISION_VALIDATED",
  "thread_id": "string",
  "turn_id": "string",
  "decision_sha256": "string"
}
```

**Success — resolved to AUDIT_TERMINAL_NO_DECISION**:
```json
{
  "ok": true,
  "operation": "resolve-uncertainty",
  "project_id": "string",
  "status": "AUDIT_TERMINAL_NO_DECISION",
  "thread_id": "string",
  "turn_id": "string",
  "turn_status": "interrupted"
}
```

**Semantic hold — AUDIT_UNCERTAIN preserved** (exit 5). Includes provider failure, thread mismatch, history invalid, non-terminal, or decision validation failure. The `reason` field is bounded to 1024 UTF-8 bytes and is informational only — not parsed by callers to determine exit authority:
```json
{
  "ok": false,
  "operation": "resolve-uncertainty",
  "project_id": "string",
  "status": "AUDIT_UNCERTAIN",
  "thread_id": "string",
  "turn_id": null,
  "code": "AUDIT_UNCERTAIN",
  "reason": "PROVIDER_INSPECTION_FAILED: ..."
}
```

**Error**:
```json
{
  "ok": false,
  "operation": "resolve-uncertainty",
  "project_id": "string",
  "code": "string",
  "error": "string"
}
```

### 3.4. `retire-legacy` response

**Success**:
```json
{
  "ok": true,
  "operation": "retire-legacy",
  "project_id": "string",
  "operation_id": "string",
  "status": "RETIRED_LEGACY_AUTHORITY_UNAVAILABLE"
}
```

**Error**:
```json
{
  "ok": false,
  "operation": "retire-legacy",
  "project_id": "string",
  "code": "string",
  "error": "string"
}
```

---

## 4. Input / Flag Contract

### 4.1. Forbidden flags (all commands)

The following are forbidden on all commands and must produce `INVALID_CLI_REQUEST` / exit 2:

```
--thread-id           --turn-id              --decision
--turn-status         --project-root         --cwd
--cwd-override        --model                --effort
--operation-id        --session              --session-id
--worker-session      --shell                --exec
--powershell          --bash                 --cmd
--argv
```

Any token not starting with `--` (positional arguments) is also forbidden after the command name.

### 4.2. Flag parsing rules (inherited from agent-broker-cli.js pattern)

- `--flag value` and `--flag=value` are both accepted.
- Duplicate singleton flags: reject with `INVALID_CLI_REQUEST`.
- Missing value for a flag requiring value: reject.
- Unknown flag for a given command: reject.
- Unexpected positional argument after command: reject.
- `--help` / `-h` / `help`: emit help JSON listing all allowed commands, exit 0.

### 4.3. Input string bounds

| Input | Validation rule |
|---|---|
| `--project-id` | Required. Must match `^[a-z0-9][a-z0-9._-]{0,127}$`. Max 128 UTF-8 bytes. |
| `--confirm` (retire-legacy only) | Boolean presence flag. No value. Presence = operator consent. |

No other string inputs are accepted. No file inputs. No arbitrary JSON inputs.

---

## 5. Exit-Code Matrix

Exit codes are derived from the `status` or `code` field of the lifecycle result object, or from structured error codes. Exit codes are NEVER derived by parsing `reason`, `error`, or `message` string content.

| Exit | Classification | Semantic |
|---|---|---|
| `0` | Success | Command completed successfully (including NO_ACTIVE_BOOTSTRAP idempotent) |
| `1` | (intentionally unused) | Reserved for unhandled Node.js process exception; not assigned by CLI logic |
| `2` | CLI/process error | Invalid CLI request: unknown command, unknown flag, duplicate flag, forbidden flag, missing required flag, unexpected positional, bounds violation |
| `3` | Lifecycle error | Project not found in Registry (for commands that require Registry confirmation) |
| `4` | Lifecycle error | No active recovery — project has no active bootstrap (for commands that require one) |
| `5` | **Semantic uncertain** | Command completed; result is AUDIT_UNCERTAIN. Recovery store is stable. Human intervention required. Includes provider inspection failure that safely preserves uncertainty. |
| `6` | Lifecycle error | Precondition failure — drift detected, authority mismatch, Registry unbound check failed |
| `8` | Lifecycle error | Recovery corruption — decision hash mismatch, invalid state, broken history chain |
| `9` | Lifecycle error | Resume verification failure — thread/resume returned wrong ID or threw |
| `10` | Lifecycle error | Registry bind failure — bindAuditorThread rejected or threw |
| `11` | Lifecycle error | Runtime initialization failure — could not open recovery store or Registry |

**Exit 1 is intentionally unused** by CLI logic so that it unambiguously signals an unhandled process exception (Node.js default behavior). This allows operators to distinguish "uncertainty preserved — human intervention required" (exit 5) from "CLI bug / crash" (exit 1).

**Exit 7 is absent** because provider inspection failure in `resolveAuditorBootstrapUncertainty` returns `AUDIT_UNCERTAIN` (exit 5), not a thrown error. No separate exit for provider unavailability is assigned until the lifecycle API is enhanced with a machine-readable classification field.

---

## 6. Mutation Matrix

| Command | Recovery-store mutates | Registry mutates | Provider call type |
|---|---|---|---|
| `inspect` | NO | NO | none |
| `recover` (PROVISIONAL_THREAD) | YES — delete active row | NO | none |
| `recover` (FIRST_TURN_STARTING / IN_FLIGHT) | YES — transition to AUDIT_UNCERTAIN | NO | none |
| `recover` (AUDIT_UNCERTAIN already) | NO | NO | none |
| `recover` (AUDIT_TERMINAL_NO_DECISION) | YES — delete active row | NO | none (Registry read only) |
| `recover` (DECISION_VALIDATED / RESUME_VERIFYING) | YES — transitions + final delete | NO | resumeThread (non-model) |
| `recover` (RESUME_VERIFIED) | YES — REGISTRY_BINDING + delete | NO | none (Registry read + bind) |
| `recover` (REGISTRY_BINDING) | YES — delete active row | YES — bindAuditorThread | none |
| `resolve-uncertainty` (no turn_id) | NO | NO | none |
| `resolve-uncertainty` (provider failure / mismatch / non-terminal) | NO | NO | readThread (non-model) |
| `resolve-uncertainty` (interrupted / failed turn) | YES — AUDIT_TERMINAL_NO_DECISION | NO | readThread (non-model) |
| `resolve-uncertainty` (completed + valid decision) | YES — DECISION_VALIDATED | NO | readThread (non-model) |
| `retire-legacy` | YES — retire history + delete active row | NO | none (Registry read only) |

---

## 7. Security Invariants

### 7.1. Parsing

1. Parser rejects unknown commands with exact error message listing allowed commands.
2. Parser rejects unknown flags for a given command.
3. Parser rejects duplicate singleton flags.
4. Parser rejects unexpected positional arguments.
5. Parser rejects all forbidden routing/identity override flags (§4.1).
6. All input strings are validated against their bounds before any lifecycle function is called.
7. `--project-id` must match `^[a-z0-9][a-z0-9._-]{0,127}$` before any IO.

### 7.2. Output allowlists

8. CLI output is an explicit projection — no spread of raw lifecycle result objects (`...lifecycleResult` patterns are forbidden in the implementation).
9. `decision_json` is NEVER emitted on stdout under any command or error path.
10. `validated_decision` is NEVER emitted.
11. `decision` (the AuditDecisionV1 object) is NEVER emitted.
12. `registry_project` (the raw Registry project record) is NEVER forwarded to JSON output.
13. Only `has_decision` (bool derived from `decision_json !== null`) and `decision_sha256` (hex string) describe decision presence in inspect output.
14. Exit codes are derived from `result.status` or `err.code` — never from parsing `reason`, `error`, or `message` text.
15. No secrets (API tokens, environment variables, registry `worker.session_id`) appear in any output.

### 7.3. Execution surface

16. No shell execution. CLI invokes lifecycle functions directly; `adapterFactory` encapsulates all provider process spawning.
17. No arbitrary file input.
18. No "latest thread discovery": `project_id` is the sole lookup key; the lifecycle derives all IDs internally.
19. No automatic resend of `turn/start`. `bootstrapAuditorThread` is never called from the recovery CLI.
20. No replacement thread creation.
21. No automatic legacy retirement from `recover`. `retire-legacy` is always an explicit operator action.

---

## 8. Integration-Test Design

All tests are deterministic. No real model turns, no real provider connections, no real Registry mutations. Injection pattern from ATL test suite applies throughout.

### 8.1. Proposed test file

`pipeline-ui/test/refactor/auditor-recover-cli.test.js`

### 8.2. Test matrix (ARC-001..ARC-053)

| Test ID | Scenario | Expected exit | Expected status / code |
|---|---|---|---|
| ARC-001 | inspect — no active bootstrap | 0 | `active_bootstrap: null` |
| ARC-002 | inspect — PROVISIONAL_THREAD | 0 | `state: PROVISIONAL_THREAD` |
| ARC-003 | inspect — AUDIT_UNCERTAIN | 0 | `state: AUDIT_UNCERTAIN` |
| ARC-004 | inspect — DECISION_VALIDATED, has_decision: true | 0 | `has_decision: true`, `decision_sha256` present |
| ARC-005 | inspect — `decision_json` absent at every depth of JSON output | 0 | no `decision_json` key |
| ARC-006 | inspect — Registry read failure mapped to `PROJECT_NOT_FOUND` | 0 | `registry_binding_state: PROJECT_NOT_FOUND` (exit 0, best-effort) |
| ARC-007 | inspect — unknown flag | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-008 | inspect — missing `--project-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-009 | inspect — `--project-id` uppercase letters (invalid format) | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-010 | inspect — duplicate `--project-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-011 | inspect — forbidden flag `--thread-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-012 | inspect — positional arg after command | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-013 | recover — NO_ACTIVE_BOOTSTRAP | 0 | `status: NO_ACTIVE_BOOTSTRAP` |
| ARC-014 | recover — PROVISIONAL_THREAD cleared | 0 | `status: RECOVERED_CLEARED` |
| ARC-015 | recover — FIRST_TURN_STARTING -> AUDIT_UNCERTAIN | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-016 | recover — FIRST_TURN_IN_FLIGHT -> AUDIT_UNCERTAIN | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-017 | recover — AUDIT_UNCERTAIN already -> preserved | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-018 | recover — DECISION_VALIDATED -> DURABLE_BOUND (resume succeeds) | 0 | `status: DURABLE_BOUND` |
| ARC-019 | recover — RESUME_VERIFYING -> DURABLE_BOUND (resume succeeds) | 0 | `status: DURABLE_BOUND` |
| ARC-020 | recover — RESUME_VERIFIED -> DURABLE_BOUND | 0 | `status: DURABLE_BOUND` |
| ARC-021 | recover — REGISTRY_BINDING already bound same thread (idempotent) | 0 | `status: DURABLE_BOUND` |
| ARC-022 | recover — AUDIT_TERMINAL_NO_DECISION cleared | 0 | `status: RECOVERED_TERMINAL_NO_DECISION_CLEARED` |
| ARC-023 | recover — `authority_version === 0` in DECISION_VALIDATED -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-024 | recover — authority drift (project_root changed) -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-025 | recover — resume verification fails (wrong thread ID returned) | 9 | `code: AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED` |
| ARC-026 | recover — Registry bind fails | 10 | `code: AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED` |
| ARC-027 | recover — corrupt recovery (decision hash mismatch) | 8 | `code: AUDITOR_RECOVERY_CORRUPT` |
| ARC-028 | recover — project not found (AUDIT_TERMINAL_NO_DECISION path) | 3 | `code: PROJECT_NOT_FOUND` |
| ARC-029 | recover — forbidden flag `--operation-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-030 | resolve-uncertainty — not in AUDIT_UNCERTAIN state | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-031 | resolve-uncertainty — no active bootstrap | 4 | `code: NO_ACTIVE_BOOTSTRAP` |
| ARC-032 | resolve-uncertainty — AUDIT_UNCERTAIN, no turn_id -> preserved | 5 | `status: AUDIT_UNCERTAIN`, `reason` contains `TURN_HISTORY_INVALID` |
| ARC-033 | resolve-uncertainty — provider readThread fails -> AUDIT_UNCERTAIN preserved (NOT exit 7) | 5 | `status: AUDIT_UNCERTAIN`, `reason` contains `PROVIDER_INSPECTION_FAILED` |
| ARC-034 | resolve-uncertainty — thread ID mismatch from provider -> preserved | 5 | `reason` contains `THREAD_ID_MISMATCH` |
| ARC-035 | resolve-uncertainty — turn count != 1 -> preserved | 5 | `reason` contains `TURN_HISTORY_INVALID` |
| ARC-036 | resolve-uncertainty — turn interrupted -> AUDIT_TERMINAL_NO_DECISION | 0 | `status: AUDIT_TERMINAL_NO_DECISION` |
| ARC-037 | resolve-uncertainty — turn failed -> AUDIT_TERMINAL_NO_DECISION | 0 | `status: AUDIT_TERMINAL_NO_DECISION` |
| ARC-038 | resolve-uncertainty — turn completed, valid decision -> DECISION_VALIDATED; no `decision` field in output | 0 | `status: DECISION_VALIDATED`, `decision_sha256` present, no `decision` key |
| ARC-039 | resolve-uncertainty — turn completed, invalid decision -> preserved | 5 | `reason` contains `DECISION_VALIDATION_FAILED` |
| ARC-040 | resolve-uncertainty — turn non-terminal (inProgress) -> preserved | 5 | `reason` contains `TURN_NONTERMINAL` |
| ARC-041 | resolve-uncertainty — `authority_version === 0` -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-042 | resolve-uncertainty — authority drift -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-043 | resolve-uncertainty — forbidden flag `--turn-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-044 | retire-legacy — `authority_version === 0`, unbound -> success | 0 | `status: RETIRED_LEGACY_AUTHORITY_UNAVAILABLE` |
| ARC-045 | retire-legacy — no active bootstrap | 4 | `code: NO_ACTIVE_BOOTSTRAP` |
| ARC-046 | retire-legacy — `authority_version === 1` (not legacy) | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-047 | retire-legacy — Registry auditor bound (`thread_id !== null`) | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-048 | retire-legacy — missing `--confirm` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-049 | retire-legacy — forbidden flag `--operation-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-050 | `--help` | 0 | `operation: help`, all four commands listed |
| ARC-051 | Unknown command | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-052 | No command at all | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-053 | inspect — no `decision_json` field in `history` entries | 0 | verified by output key inspection |

### 8.3. Test infrastructure requirements

- All lifecycle functions are injected via the options pattern used in the ATL suite (no direct process invocation of lifecycle).
- `adapterFactory` is a controlled stub returning fake provider clients.
- `registryPort` is a controlled stub with configurable project fixture and binding state.
- `recoveryStore` uses `createSqliteAuditorRecoveryStore` with tmpdir file backing (no production SQLite path).
- No real process spawning. No real provider connections. No production Registry reads.
- Each test suite emits `ALL AUDITOR RECOVER CLI TESTS PASSED (ARC-001 .. ARC-053: 53/53 PASS)` on success.

---

## 9. Implementation File Plan

No production code is modified in WO-V4-07A. The following files will be created or modified in WO-V4-07B:

| File | Action | Purpose |
|---|---|---|
| `pipeline-ui/auditor-recover-cli.js` | NEW | CLI entry point: arg parser, explicit output projections, command dispatch, exit codes |
| `pipeline-ui/test/refactor/auditor-recover-cli.test.js` | NEW | Deterministic test suite ARC-001..ARC-053 |
| `pipeline-ui/package.json` | MODIFY `scripts.test` | Append `auditor-recover-cli.test.js` to the test chain |
| `docs/.../15-IMPLEMENTATION-PLAN.md` | MODIFY | Update to reflect WP-V4-07B scope |

No modifications to:
- `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
- `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`
- `pipeline-ui/lib/broker/registry.js`
- `pipeline-ui/agent-broker-cli.js`

---

## 10. Open Questions

All questions are classified as `RESOLVED_FOR_07B` or `BLOCKS_07B`.

### Q1 — adapterFactory injection in production

**Status**: `RESOLVED_FOR_07B`

**Resolution**: The CLI will use `createBrokerRuntime` (the same factory used by `agent-broker-cli.js`) for its runtime initialization. `createBrokerRuntime` already creates and exposes `recoveryStore` and `registryPort`. `adapterFactory` will be constructed in a new `createAuditorAdapterFactory(options)` helper in `auditor-recover-cli.js` using the project's existing Codex App Server adapter pattern. This follows the established precedent and requires no new factory module. The injection point for tests remains the `options` object pattern from the ATL suite.

### Q2 — registry_binding_state vocabulary

**Status**: `RESOLVED_FOR_07B`

**Resolution**: The exhaustive vocabulary is now verified from `registry.js` source (L83-L86) and documented in §1.3. The five possible values are: `AUDITOR_REGISTRATION_REQUIRED`, `AUDITOR_BOUND_READY`, `AUDITOR_BOUND_DISABLED`, `PROJECT_NOT_FOUND`, `UNKNOWN`. These are the exact strings the JSON output schema uses. No additional discovery required.

### Q3 — retire-legacy --confirm gate

**Status**: `RESOLVED_FOR_07B`

**Resolution**: `--confirm` is a boolean presence flag (no value). Presence = operator consent. Absence = `INVALID_CLI_REQUEST` / exit 2. This follows POSIX conventions and keeps parsing unambiguous. No `--confirm=RETIRE_LEGACY` value is required or accepted (a value would make `--confirm` a key-value flag, adding parsing complexity for no benefit). ARC-048 covers the missing-confirm case.

### Q4 — recover AUDIT_UNCERTAIN with turn_id === null

**Status**: `RESOLVED_FOR_07B`

**Resolution**: When `recoverAuditorBootstrap` returns `{ ok: false, status: 'AUDIT_UNCERTAIN' }` (including the turn_id-missing case), the CLI maps this to exit 5. The CLI does NOT automatically invoke `resolve-uncertainty`. The operator must call `resolve-uncertainty` explicitly after `recover` returns exit 5. ARC-017 verifies that `recover` on an already-uncertain bootstrap exits 5. ARC-032 verifies `resolve-uncertainty` on a bootstrap with no `turn_id` also exits 5. The distinction between these two cases is observable from the exit-5 JSON output (`recover` includes `message`; `resolve-uncertainty` includes `reason`). No further ambiguity.

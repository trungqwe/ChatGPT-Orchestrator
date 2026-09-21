# WO-V4-07A CLI DESIGN — Audit / Recover CLI Contract (Revision 2)

- **Work Order**: WO-V4-07A-R2 (adapter factory signature / authority cwd / source-exact error inventory)
- **Correction Parent**: `0d401207334e2412caf62c642ee5cd52203c048e`
- **Authoritative Implementation Source Baseline**: `119e93f96b8e5eddaf81b8ddefba4b485c76f554`
- **Status**: DESIGN / CONTRACT ONLY — No production code modified
- **WP-V4-06**: `COMPLETE`
- **WP-V4-07A**: `BLOCKED_PENDING_R2_EXTERNAL_REVIEW`
- **WP-V4-07B**: `NOT_STARTED`

---

## Source-Alignment Gate Results

The following architectural and semantic invariants are established across Revisions 1 and 2:

**Gate A — CLI outputs are projections, never raw lifecycle results**: CLI commands project strictly defined allowlists. Never use `{ ...lifecycleResult }`. Raw lifecycle return fields such as `registry_project`, `decision_json`, `validated_decision`, and `decision` (AuditDecisionV1) are NEVER emitted in any output channel. `worker.session_id` is never emitted.

**Gate B — inspect Registry limitation**: `inspectAuditorBootstrap()` silences Registry read exceptions and maps both Registry unavailability and missing project to `registry_binding_state: PROJECT_NOT_FOUND` (exit 0). The CLI does not invent a distinct `REGISTRY_UNAVAILABLE` exit or state.

**Gate C — provider inspection failure remains AUDIT_UNCERTAIN**: `resolveAuditorBootstrapUncertainty()` on provider `readThread` failure returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: '...' }` — it does NOT throw a distinct error. Therefore, provider inspection failure maps to **exit 5** (semantic AUDIT_UNCERTAIN hold). Reason string prefixes are NOT parsed to derive exit authority.

**Gate D — Source-exact no-active semantics**:
The three lifecycle commands do NOT share identical no-active behavior:
1. `recover`: `recoverAuditorBootstrap()` returns `{ ok: true, status: 'NO_ACTIVE_BOOTSTRAP' }`. The CLI emits `status: 'NO_ACTIVE_BOOTSTRAP'` and exits **0** (idempotent success, ARC-013).
2. `resolve-uncertainty`: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` when no active bootstrap exists. The CLI exits **6** with `code: 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED'` (ARC-031). It is NOT transformed into `NO_ACTIVE_BOOTSTRAP` / exit 4.
3. `retire-legacy`: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` when no active bootstrap exists. The CLI exits **6** with `code: 'AUDITOR_LIFECYCLE_PRECONDITION_FAILED'` (ARC-045). Gate-D claims of successful `NO_ACTIVE_BOOTSTRAP` return for retire-legacy are deleted.

**Gate E — No preflight authority duplication**: The CLI never performs an out-of-band `recoveryStore.getActiveBootstrap()` or pre-reads Registry prior to invoking lifecycle functions solely to manufacture custom error classifications. Doing so would introduce Time-Of-Check-To-Time-Of-Use (TOCTOU) hazards. Lifecycle API remains the sole authority.

**Gate F — Correct project-not-found semantics**: In `recover`, `resolve-uncertainty`, and `retire-legacy`, missing or unreadable Registry projects are wrapped by the lifecycle as `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`. The CLI does not examine error message text to manufacture `PROJECT_NOT_FOUND`. Missing project in these paths exits **6** (`AUDITOR_LIFECYCLE_PRECONDITION_FAILED`). `inspect` remains the sole exception because the lifecycle returns `registry_binding_state: 'PROJECT_NOT_FOUND'` at exit 0.

**Gate G — Direct auditor recovery runtime composition**: `createBrokerRuntime` (`pipeline-ui/lib/broker/runtime.js`) is NOT the auditor recovery runtime. Its `lifecycleStore` is the worker/broker lifecycle store, not `sqlite-auditor-recovery-store`. WP-V4-07B composes the runtime directly via `createAuditorRecoveryCliRuntime(options)` using `createProjectRegistry()`, `createSqliteAuditorRecoveryStore()`, and `CodexAuditorAdapter`.

**Gate H — Exit matrix alignment & operational error fallback**:
- Exits `3`, `4`, and `7` are `RESERVED_NOT_CURRENTLY_EMITTED` because current lifecycle code produces no structured error codes mapping to them at the CLI boundary.
- Operational unmapped structured errors fall back to **exit 12** (`CLI_RUNTIME_FAILURE`). Safe machine-readable `code` is preserved in JSON output, raw stack traces are never exposed, and fallback is never derived from message text.

**Gate I — Correct mutation matrix**: Bind-capable recover paths (`DECISION_VALIDATED`, `RESUME_VERIFYING`, `RESUME_VERIFIED`, `REGISTRY_BINDING`) have `Registry YES, CONDITIONAL` — `bindAuditorThread` executes if the Registry is not already bound to the exact same thread; if already bound, Registry write is skipped idempotently while active recovery is cleared.

**Gate J (R2) — Adapter factory signature & lifecycle authority cwd**:
Lifecycle invokes `adapterFactory({ phase, cwd })`. The factory accepts this exact signature. In the factory construction:
```javascript
new CodexAuditorAdapter({
  ...adapterOptions,
  cwd
})
```
The lifecycle-supplied `cwd` strictly overrides any programmatic `adapterOptions.cwd`. `phase` provides context for diagnostics and test assertions, but cannot alter cwd authority, thread identity, model, or effort.

**Gate K (R2) — Source-exact recovery error inventory**:
The error code inventory in §1.2 strictly mirrors `RECOVERY_ERROR_CODES` from `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`. Non-existent codes like `AUDITOR_RECOVERY_DB_ERROR` are removed.

**Gate L (R2) — Runtime initialization phase authority**:
Runtime construction is a distinct phase. Any error thrown during `createAuditorRecoveryCliRuntime()` maps unconditionally to **exit 11** (`CLI_RUNTIME_INITIALIZATION_FAILURE`), preserving the safe machine-readable code in JSON. Initialization errors are never routed through operational fallback (exit 12).

**Gate M (R2) — Top-level unexpected failure boundary**:
To enforce the invariant of exactly one JSON stdout object and zero raw stack traces, process-entry uncaught exceptions are trapped by a top-level error boundary. This boundary emits a bounded JSON error and sets `process.exitCode = 1` (`TOP_LEVEL_UNEXPECTED_FAILURE`).

---

## 1. Source Authority Inventory

### 1.1. Lifecycle module

**File**: `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`

Exports four externally callable lifecycle APIs:

| Function | Sync/Async | Provider calls | Recovery-store mutations | Registry reads | Registry mutations |
|---|---|---|---|---|---|
| `inspectAuditorBootstrap` | async | none | none | 1 read (best-effort) | none |
| `recoverAuditorBootstrap` | async | 1 x adapterFactory + resumeThread (cases 3-4) | deleteActiveBootstrap / transitionBootstrap | 1-2 reads (cases 1b, 3-5) | 1 x bindAuditorThread (conditional, cases 3-5) |
| `resolveAuditorBootstrapUncertainty` | async | 1 x adapterFactory + readThread (non-mutating read) | 0 or 1 x transitionBootstrap | 1 read | none |
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
Reads `recoveryStore.getActiveBootstrap(projectId)` and `recoveryStore.getBootstrapHistory(projectId)`, then optionally reads the Registry project to classify `registry_binding_state`.
- Missing active bootstrap: returns `{ project_id, active_bootstrap: null, history, registry_binding_state }`.
- Missing or failing Registry read: silently caught and mapped to `registry_binding_state: 'PROJECT_NOT_FOUND'`.
- Raw lifecycle return includes `registry_project`, which is NEVER forwarded to CLI output.

**`recoverAuditorBootstrap(options)`**
```
read-only:               NO (mutates recovery store; conditionally mutates Registry)
recovery-store mutation: YES — deleteActiveBootstrap or transitionBootstrap
Registry mutation:       YES, CONDITIONAL — bindAuditorThread (DECISION_VALIDATED..REGISTRY_BINDING)
provider read:           YES — resumeThread (non-model)
provider side effect:    NO (no turn/start)
model turn:              NO
```
State to action mapping:
- No active bootstrap: returns `{ ok: true, status: 'NO_ACTIVE_BOOTSTRAP', project_id }`. No throw. Exit 0.
- `PROVISIONAL_THREAD`: calls `deleteActiveBootstrap`. Returns `status: 'RECOVERED_CLEARED'`. Exit 0.
- `FIRST_TURN_STARTING`, `FIRST_TURN_IN_FLIGHT`: calls `transitionBootstrap(..., AUDIT_UNCERTAIN)`. Returns `status: 'AUDIT_UNCERTAIN'`. Exit 5.
- `AUDIT_UNCERTAIN`: returns `status: 'AUDIT_UNCERTAIN'`. No mutation. Exit 5.
- `AUDIT_TERMINAL_NO_DECISION`: reads Registry project; if missing, throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (exit 6). Verifies auditor is unbound; calls `deleteActiveBootstrap`. Returns `status: 'RECOVERED_TERMINAL_NO_DECISION_CLEARED'`. Exit 0.
- `DECISION_VALIDATED`: requires `authority_version === 1`. Transitions to `RESUME_VERIFYING`, calls provider `resumeThread`, transitions to `RESUME_VERIFIED`, transitions to `REGISTRY_BINDING`, verifies drift, calls `bindAuditorThread` if Registry is not already bound to exact same thread, calls `deleteActiveBootstrap`. Returns `status: 'DURABLE_BOUND'`. Exit 0.
- `RESUME_VERIFYING`: resumes from verification step; calls provider `resumeThread`, transitions to `RESUME_VERIFIED`, transitions to `REGISTRY_BINDING`, conditional `bindAuditorThread`, `deleteActiveBootstrap`. Returns `status: 'DURABLE_BOUND'`. Exit 0.
- `RESUME_VERIFIED`: transitions to `REGISTRY_BINDING`, conditional `bindAuditorThread`, `deleteActiveBootstrap`. Returns `status: 'DURABLE_BOUND'`. Exit 0.
- `REGISTRY_BINDING`: drift check, conditional `bindAuditorThread` (skipped if already bound to same thread), `deleteActiveBootstrap`. Returns `status: 'DURABLE_BOUND'`. Exit 0.

**`resolveAuditorBootstrapUncertainty(options)`**
```
read-only:               NO (may write DECISION_VALIDATED or AUDIT_TERMINAL_NO_DECISION)
recovery-store mutation: YES — 0 or 1 x transitionBootstrap
Registry mutation:       NO
provider read:           YES — readThread (non-model read-only provider call)
provider side effect:    NO
model turn:              NO
```
Preconditions enforced by lifecycle (all throw `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` / exit 6):
- Registry project exists (if missing or read fails: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`).
- Project auditor is unbound (`thread_id === null`, `enabled === false`).
- Active bootstrap exists (if missing: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` with `'No active bootstrap record found...'`).
- Active bootstrap state is `AUDIT_UNCERTAIN`.
- `authority_version === 1`.
- Expected project root matches Registry.

Outcomes returned as structured objects:
- `turn_id` missing / empty -> returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'TURN_HISTORY_INVALID: ...' }`. Exit 5.
- Provider `readThread` fails -> returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'PROVIDER_INSPECTION_FAILED: ...' }`. Exit 5.
- Thread ID mismatch -> returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'THREAD_ID_MISMATCH: ...' }`. Exit 5.
- Turn count != 1 -> returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'TURN_HISTORY_INVALID: ...' }`. Exit 5.
- `interrupted` or `failed` turn -> transitions to `AUDIT_TERMINAL_NO_DECISION`. Returns `ok: true, status: 'AUDIT_TERMINAL_NO_DECISION'`. Exit 0.
- `completed` turn + valid decision -> transitions to `DECISION_VALIDATED`. Returns `ok: true, status: 'DECISION_VALIDATED'`. Exit 0.
- Non-terminal / unrecognized turn status -> returns `{ ok: false, status: 'AUDIT_UNCERTAIN', reason: 'TURN_NONTERMINAL: ...' }`. Exit 5.

**`retireLegacyAuditorBootstrapWithoutAuthority(options)`**
```
read-only:               NO
recovery-store mutation: YES — retireLegacyBootstrap (appends history -> LEGACY_AUTHORITY_RETIRED, deletes active row)
Registry mutation:       NO
provider read:           NO
provider side effect:    NO
model turn:              NO
```
Preconditions enforced by lifecycle (all throw `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` / exit 6):
- Active bootstrap exists (if missing: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` with `'No active bootstrap found...'`).
- `authority_version === 0` (if not 0: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`).
- Registry project exists (if missing or read fails: throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED`).
- Auditor is unbound in Registry (`thread_id === null`, `enabled === false`).
- Operation ID is derived internally from active record; caller supply is forbidden.

### 1.2. Recovery store

**File**: `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`

Key state constants:
```
PROVISIONAL_THREAD       FIRST_TURN_STARTING      FIRST_TURN_IN_FLIGHT
DECISION_VALIDATED       RESUME_VERIFYING         RESUME_VERIFIED
REGISTRY_BINDING         AUDIT_UNCERTAIN          AUDIT_TERMINAL_NO_DECISION
LEGACY_AUTHORITY_RETIRED
```

Source-exact error codes (`RECOVERY_ERROR_CODES`):
```
AUDITOR_RECOVERY_CORRUPT
AUDITOR_RECOVERY_SCHEMA_INVALID
AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT
AUDITOR_RECOVERY_NOT_FOUND
AUDITOR_RECOVERY_INVALID_TRANSITION
AUDITOR_RECOVERY_INVALID_REQUEST
AUDITOR_RECOVERY_CLOSED
```
*(Note: `AUDITOR_RECOVERY_DB_ERROR` does NOT exist in source and is not part of this inventory).*

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

Schema version: `2`. Tables: `auditor_bootstrap` (1 active row per project), `auditor_bootstrap_history`.

### 1.3. Registry

**File**: `pipeline-ui/lib/broker/registry.js`

`getAuditorBindingState(auditor)` exhaustive return values (verified from source):

| Return value | Condition |
|---|---|
| `AUDITOR_REGISTRATION_REQUIRED` | `auditor.thread_id === null` |
| `AUDITOR_BOUND_READY` | `auditor.thread_id !== null && auditor.enabled === true` |
| `AUDITOR_BOUND_DISABLED` | `auditor.thread_id !== null && auditor.enabled !== true` |

Lifecycle wrapper (`inspectAuditorBootstrap`) additions:

| Return value | Condition |
|---|---|
| `PROJECT_NOT_FOUND` | Registry read exception or project missing |
| `UNKNOWN` | `registryPort` not provided to inspect |

`bindAuditorThread` is the sole Registry mutation in any recovery path. It is guarded by drift validation (`assertBootstrapAuthorityMatchesRegistry`) immediately prior to execution.

### 1.4. Runtime composition & phase authority (Revision 2)

**Correction**: `createBrokerRuntime` (`pipeline-ui/lib/broker/runtime.js`) is NOT the auditor recovery runtime. It creates and exposes:
```javascript
{
  broker,
  registryPort,
  workspacePort,
  workerPort,
  lifecycleStore, // Worker/broker lifecycle store — NOT auditor recovery store!
  close
}
```
`createBrokerRuntime` does NOT create or expose `sqlite-auditor-recovery-store`. It must NEVER be used to back the auditor recovery CLI.

**Production Runtime Composition**:
WP-V4-07B composes the auditor recovery runtime directly from root authorities:
```javascript
const { createProjectRegistry } = require('./lib/broker/registry');
const { createSqliteAuditorRecoveryStore } = require('./lib/relay/sqlite-auditor-recovery-store');
const { CodexAuditorAdapter } = require('./lib/auditor/codex-auditor-adapter');
```

Authority defaults:
- Registry: `createProjectRegistry()` -> defaults to `~/.orchestrator/projects.json`
- Recovery store: `createSqliteAuditorRecoveryStore()` -> defaults to `~/.orchestrator/auditor-recovery.sqlite3`

**Runtime Initialization Phase Authority**:
Runtime initialization is a distinct lifecycle phase. Any error thrown during runtime construction maps unconditionally to **exit 11**:
```javascript
let runtime;
try {
  runtime = await createAuditorRecoveryCliRuntime(options);
} catch (err) {
  return {
    exitCode: 11,
    response: {
      ok: false,
      operation: options.operation || 'init',
      code: err.code || 'CLI_RUNTIME_INITIALIZATION_FAILURE',
      error: err.message
    }
  };
}
```
This applies whether the error code is `REGISTRY_CORRUPT`, `REGISTRY_SCHEMA_INVALID`, `REGISTRY_MIGRATION_REQUIRED`, `AUDITOR_RECOVERY_CORRUPT`, `AUDITOR_RECOVERY_SCHEMA_INVALID`, `AUDITOR_RECOVERY_CLOSED`, or any other initialization failure. Initialization errors are NEVER sent to the operational fallback (exit 12).

The CLI runtime factory exposes at minimum:
```javascript
{
  registryPort,
  recoveryStore,
  adapterFactory,
  close: async () => { ... }
}
```
Contract:
- `close()` must close `recoveryStore`.
- Does NOT instantiate the worker lifecycle store.
- Does NOT instantiate worker adapters.
- Does NOT instantiate the generic broker.
- Test-only dependency injection is accepted through the programmatic `options` object.

### 1.5. Adapter factory contract (Revision 2)

The lifecycle authority calls `adapterFactory` with an object containing `phase` and canonical `cwd`:
```javascript
adapterFactory({
  phase: 'resume_verify', // or 'uncertainty_inspect'
  cwd: verifiedAuthority.canonicalProjectRoot
})
```

Production factory implementation:
```javascript
function createAuditorAdapterFactory(options = {}) {
  const adapterOptions = {
    ...(options.adapterOptions || {})
  };

  return async ({ phase, cwd } = {}) => {
    if (typeof cwd !== 'string' || !cwd.trim()) {
      const err = new Error('Lifecycle canonical cwd is required');
      err.code = 'AUDITOR_CLI_RUNTIME_INVALID_CWD';
      throw err;
    }

    return new CodexAuditorAdapter({
      ...adapterOptions,
      cwd
    });
  };
}
```

Contract rules:
1. Ordering: `...adapterOptions` THEN `cwd`. The lifecycle-provided canonical `cwd` strictly takes precedence over any `adapterOptions.cwd` passed in programmatic/test options.
2. `phase` may be logged or inspected in test assertions, but must NOT alter thread identity, cwd, model, or effort.
3. Transport: `codex app-server --listen stdio://` (default `CodexAppServerClient` construction).
4. No CLI flag may override: `codex` binary, `cwd`, `thread_id`, `turn_id`, `model`, or `effort`.

### 1.6. Existing broker CLI patterns

**File**: `pipeline-ui/agent-broker-cli.js`

Establishes patterns replicated in `auditor-recover-cli.js`:
- Strict argument parser rejecting unknown commands, unknown flags, duplicates, and positional arguments.
- Machine-readable JSON stdout for all output including errors.
- `FORBIDDEN_FLAGS` set blocking routing/execution overrides.
- Operational error mapping driven by `err.code`, never by regex matching on `err.message`.
- Stderr for diagnostics only.
- Guaranteed runtime cleanup in `finally` blocks.

### 1.7. Real-state freeze (WO-V4-07A)

```
auditor.thread_id:       01a0be36-97bb-7831-8adb-02e1c1e70be0
auditor.enabled:         true
recovery schema:         2
active recovery:         NONE
```
Zero real thread/start, turn/start, model turns, Registry mutation, or recovery mutation during WO-V4-07A.

---

## 2. Proposed Command Surface

The WP-V4-07 CLI is a separate entry point: `pipeline-ui/auditor-recover-cli.js`.

Four explicit commands are defined. Legacy retirement is a distinct operator command; it is never invoked automatically by `recover`.

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
Exits:       0, 1, 2, 6, 8, 11, 12
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
Exits:       0, 1, 2, 5, 6, 8, 9, 10, 11, 12
Mutates:     YES (recovery store; conditionally binds Registry in validated/verified/binding states)
Operator intent required: YES (caller must understand this may bind Registry)
```

No target state flag is accepted. The lifecycle function drives the state machine from its observed position.

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
Exits:       0, 1, 2, 5, 6, 8, 11, 12
Mutates:     YES (0 or 1 transition depending on provider response)
Operator intent required: YES (spawns provider connection)
```

Preconditions are verified by the lifecycle function. If no active bootstrap exists, lifecycle throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (exit 6).

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
Exits:       0, 1, 2, 6, 8, 11, 12
Mutates:     YES (appends LEGACY_AUTHORITY_RETIRED history + deletes active row)
Operator intent required: YES (--confirm presence flag required)
```

Preconditions are verified by the lifecycle function. If no active bootstrap exists, lifecycle throws `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (exit 6).

---

## 3. JSON Output Schemas

All commands emit exactly one JSON object to stdout followed by `\n`. No partial output. No pretty-printing. All emitted fields are strictly projected from explicit allowlists — never using object spreads (`...lifecycleResult`).

### 3.1. `inspect` response

The CLI projects the following explicit allowlist. `registry_project` is NOT forwarded. `decision_json` and `validated_decision` are NOT forwarded. `expected_project_root_identity` is NOT forwarded.

**Permitted `active_bootstrap` fields (allowlist)**:
`project_id`, `operation_id`, `audit_subject_id`, `thread_id`, `turn_id`, `workspace_state_observed`, `state`, `has_decision` (derived boolean: `decision_json !== null`), `decision_sha256`, `authority_version`, `expected_project_root`, `expected_auditor_model_policy`, `created_at`, `updated_at`

**Permitted `history` entry fields (allowlist)**:
`history_seq`, `operation_id`, `previous_state`, `next_state`, `iso`

**Permitted `registry_binding_state` values**:
`AUDITOR_REGISTRATION_REQUIRED`, `AUDITOR_BOUND_READY`, `AUDITOR_BOUND_DISABLED`, `PROJECT_NOT_FOUND`, `UNKNOWN`.

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
    "audit_subject_id": "subj-xyz",
    "thread_id": "th-001",
    "turn_id": null,
    "workspace_state_observed": "clean",
    "state": "PROVISIONAL_THREAD",
    "has_decision": false,
    "decision_sha256": null,
    "authority_version": 1,
    "expected_project_root": "/canonical/root",
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

### 3.2. `recover` response

**Success — no active bootstrap (idempotent, exit 0)**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "status": "NO_ACTIVE_BOOTSTRAP"
}
```

**Success — bootstrap cleared (exit 0)**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "status": "RECOVERED_CLEARED",
  "previous_state": "PROVISIONAL_THREAD",
  "thread_id": "th-001"
}
```

**Success — terminal no-decision cleared (exit 0)**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "status": "RECOVERED_TERMINAL_NO_DECISION_CLEARED",
  "previous_state": "AUDIT_TERMINAL_NO_DECISION",
  "thread_id": "th-001"
}
```

**Success — DURABLE_BOUND (exit 0)**:
```json
{
  "ok": true,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "status": "DURABLE_BOUND",
  "thread_id": "th-001",
  "reconciled": true
}
```

**Semantic hold — AUDIT_UNCERTAIN preserved (exit 5)**:
```json
{
  "ok": false,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "status": "AUDIT_UNCERTAIN",
  "thread_id": "th-001",
  "code": "AUDIT_UNCERTAIN",
  "message": "Audit execution status uncertain; intervention required"
}
```

### 3.3. `resolve-uncertainty` response

The `decision` object (AuditDecisionV1) is NEVER emitted. Only `decision_sha256` is emitted when a decision is validated.

**Success — resolved to DECISION_VALIDATED (exit 0)**:
```json
{
  "ok": true,
  "operation": "resolve-uncertainty",
  "project_id": "chatgpt-orchestrator",
  "status": "DECISION_VALIDATED",
  "thread_id": "th-001",
  "turn_id": "turn-001",
  "decision_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

**Success — resolved to AUDIT_TERMINAL_NO_DECISION (exit 0)**:
```json
{
  "ok": true,
  "operation": "resolve-uncertainty",
  "project_id": "chatgpt-orchestrator",
  "status": "AUDIT_TERMINAL_NO_DECISION",
  "thread_id": "th-001",
  "turn_id": "turn-001",
  "turn_status": "interrupted"
}
```

**Semantic hold — AUDIT_UNCERTAIN preserved (exit 5)**:
```json
{
  "ok": false,
  "operation": "resolve-uncertainty",
  "project_id": "chatgpt-orchestrator",
  "status": "AUDIT_UNCERTAIN",
  "thread_id": "th-001",
  "turn_id": null,
  "code": "AUDIT_UNCERTAIN",
  "reason": "PROVIDER_INSPECTION_FAILED: connection refused"
}
```

### 3.4. `retire-legacy` response

**Success (exit 0)**:
```json
{
  "ok": true,
  "operation": "retire-legacy",
  "project_id": "chatgpt-orchestrator",
  "operation_id": "op-legacy-001",
  "status": "RETIRED_LEGACY_AUTHORITY_UNAVAILABLE"
}
```

### 3.5. Error schemas (all commands)

**Top-Level Process Error (exit 1 — TOP_LEVEL_UNEXPECTED_FAILURE)**:
Trapped by the process entry boundary for uncaught exceptions:
```json
{
  "ok": false,
  "operation": "cli",
  "code": "TOP_LEVEL_UNEXPECTED_FAILURE",
  "error": "An unexpected process failure occurred"
}
```
Rules: sets `process.exitCode = 1`, emits one JSON object to stdout, no raw stack trace.

**Standard Structured Error (exits 2, 6, 8, 9, 10)**:
```json
{
  "ok": false,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "code": "AUDITOR_LIFECYCLE_PRECONDITION_FAILED",
  "error": "No active bootstrap record found for project 'chatgpt-orchestrator'"
}
```

**Runtime Initialization Error (exit 11 — CLI_RUNTIME_INITIALIZATION_FAILURE)**:
Emitted when runtime creation fails in the init phase:
```json
{
  "ok": false,
  "operation": "init",
  "code": "AUDITOR_RECOVERY_SCHEMA_INVALID",
  "error": "Recovery store schema version mismatch"
}
```

**Operational Unmapped Structured Error Fallback (exit 12 — CLI_RUNTIME_FAILURE)**:
When an operational error (after successful init) carries a machine-readable `.code` that is not explicitly in the exit map:
```json
{
  "ok": false,
  "operation": "recover",
  "project_id": "chatgpt-orchestrator",
  "code": "AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT",
  "error": "operation_id mismatch on active bootstrap"
}
```
Rules:
- Exit code is strictly **12**.
- Machine-readable code is preserved in `.code`.
- Diagnostic message is safely bounded (max 1024 UTF-8 bytes).
- Raw stack traces are NEVER exposed.
- Never derived from matching text in `error.message`.

---

## 4. Input / Flag Contract

### 4.1. Forbidden flags (all commands)

The following are forbidden on all commands and produce `INVALID_CLI_REQUEST` / exit 2:
```
--thread-id           --turn-id              --decision
--turn-status         --project-root         --cwd
--cwd-override        --model                --effort
--operation-id        --session              --session-id
--worker-session      --shell                --exec
--powershell          --bash                 --cmd
--argv
```
Any token not starting with `--` (positional arguments) is forbidden after the command name.

### 4.2. Flag parsing rules

- Both `--flag value` and `--flag=value` formats are accepted.
- Duplicate singleton flags: reject with `INVALID_CLI_REQUEST` / exit 2.
- Missing required value for a key-value flag: reject with exit 2.
- Unknown flag for a given command: reject with exit 2.
- Unexpected positional argument after command: reject with exit 2.
- `--help` / `-h` / `help`: emit help JSON listing allowed commands, exit 0.

### 4.3. Input string bounds

| Input | Validation rule |
|---|---|
| `--project-id` | Required. Must match `^[a-z0-9][a-z0-9._-]{0,127}$`. Max 128 UTF-8 bytes. |
| `--confirm` (retire-legacy only) | Boolean presence flag. No value allowed. Presence = operator consent. |

---

## 5. Exit-Code Matrix

Exit codes are derived exclusively from lifecycle phase, `result.status`, or structured `err.code`. Exit codes are NEVER derived by parsing `reason`, `error`, or `message` string content.

| Exit | Classification | Semantic | Trigger Condition |
|---|---|---|---|
| `0` | Success | Command completed successfully | Success outcome; `recover` returns `NO_ACTIVE_BOOTSTRAP` |
| `1` | Process error | Top-level unexpected failure | Uncaught exception caught at process boundary (`TOP_LEVEL_UNEXPECTED_FAILURE`), JSON stdout, no stack trace |
| `2` | CLI/process error | Invalid CLI request | Unknown command, unknown/duplicate/forbidden flag, bounds failure |
| `3` | **RESERVED** | `RESERVED_NOT_CURRENTLY_EMITTED` | No lifecycle path emits structured code at CLI boundary (wrapped as PRECONDITION_FAILED exit 6) |
| `4` | **RESERVED** | `RESERVED_NOT_CURRENTLY_EMITTED` | No lifecycle path emits structured code at CLI boundary (resolve/retire throw PRECONDITION_FAILED exit 6; recover returns exit 0) |
| `5` | **Semantic uncertain** | Semantic hold — AUDIT_UNCERTAIN | Result status `AUDIT_UNCERTAIN` (including provider inspection failure) |
| `6` | Lifecycle error | Precondition failure | `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (no active bootstrap in resolve/retire; project missing in recover/resolve/retire; drift/unbound mismatch) |
| `7` | **RESERVED** | `RESERVED_NOT_CURRENTLY_EMITTED` | Provider readThread failure returns status `AUDIT_UNCERTAIN` (exit 5), not thrown error |
| `8` | Lifecycle error | Recovery corrupt | `AUDITOR_RECOVERY_CORRUPT` (during command execution) |
| `9` | Lifecycle error | Resume verification failure | `AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED` |
| `10` | Lifecycle error | Registry bind failure | `AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED` |
| `11` | **Runtime init error** | Runtime initialization failure | Any error during `createAuditorRecoveryCliRuntime()` construction (e.g. `REGISTRY_CORRUPT`, `AUDITOR_RECOVERY_SCHEMA_INVALID`) |
| `12` | **Runtime fallback** | Operational unmapped structured error (`CLI_RUNTIME_FAILURE`) | Unmapped operational `.code` during command execution (e.g. `AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT`) |

**Clarifications on Reserved Exits**:
- **Exit 3 & 4**: Neither the recovery store nor the lifecycle module exposes distinct machine-readable error codes `PROJECT_NOT_FOUND` or `NO_ACTIVE_BOOTSTRAP` as thrown exceptions across the CLI boundary. In `resolve-uncertainty` and `retire-legacy`, missing active records throw `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (exit 6). In `recover`, missing active records return `{ ok: true, status: 'NO_ACTIVE_BOOTSTRAP' }` (exit 0). In `recover`, `resolve-uncertainty`, and `retire-legacy`, missing projects throw `AUDITOR_LIFECYCLE_PRECONDITION_FAILED` (exit 6). Exits 3 and 4 are therefore designated `RESERVED_NOT_CURRENTLY_EMITTED`.
- **Exit 7**: Provider inspection failure in `resolveAuditorBootstrapUncertainty` returns `{ ok: false, status: 'AUDIT_UNCERTAIN' }` (exit 5), not a thrown error. Exit 7 is designated `RESERVED_NOT_CURRENTLY_EMITTED`.

---

## 6. Mutation Matrix

| Command | State / Condition | Recovery-Store Mutation | Registry Mutation | Provider Call |
|---|---|---|---|---|
| `inspect` | Any | NO | NO | none |
| `recover` | `NO_ACTIVE_BOOTSTRAP` | NO | NO | none |
| `recover` | `PROVISIONAL_THREAD` | YES (`deleteActiveBootstrap`) | NO | none |
| `recover` | `FIRST_TURN_STARTING` / `IN_FLIGHT` | YES (`transitionBootstrap` to `AUDIT_UNCERTAIN`) | NO | none |
| `recover` | `AUDIT_UNCERTAIN` (already) | NO | NO | none |
| `recover` | `AUDIT_TERMINAL_NO_DECISION` | YES (`deleteActiveBootstrap`) | NO | none (Registry read only) |
| `recover` | `DECISION_VALIDATED` | YES (transitions + `deleteActiveBootstrap`) | **YES, CONDITIONAL** | `resumeThread` (non-model) |
| `recover` | `RESUME_VERIFYING` | YES (transitions + `deleteActiveBootstrap`) | **YES, CONDITIONAL** | `resumeThread` (non-model) |
| `recover` | `RESUME_VERIFIED` | YES (transition + `deleteActiveBootstrap`) | **YES, CONDITIONAL** | none |
| `recover` | `REGISTRY_BINDING` | YES (`deleteActiveBootstrap`) | **YES, CONDITIONAL** | none |
| `resolve-uncertainty` | `turn_id` missing | NO | NO | none |
| `resolve-uncertainty` | provider failure / mismatch / non-terminal | NO | NO | `readThread` (non-model) |
| `resolve-uncertainty` | turn `interrupted` / `failed` | YES (transition to `AUDIT_TERMINAL_NO_DECISION`) | NO | `readThread` (non-model) |
| `resolve-uncertainty` | turn `completed` + valid decision | YES (transition to `DECISION_VALIDATED`) | NO | `readThread` (non-model) |
| `retire-legacy` | `authority_version === 0` | YES (`retireLegacyBootstrap` -> history + delete active) | NO | none (Registry read only) |

**Definition of `Registry YES, CONDITIONAL`**:
`bindAuditorThread` executes if the Registry is not already bound to the exact same thread. If the Registry is already bound to the exact same thread, the Registry write is skipped idempotently, but active recovery cleanup (`deleteActiveBootstrap`) still occurs.

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
8. CLI output is an explicit projection — no spread of raw lifecycle result objects (`{ ...lifecycleResult }` is forbidden).
9. `decision_json` is NEVER emitted on stdout under any command or error path.
10. `validated_decision` is NEVER emitted.
11. `decision` (the AuditDecisionV1 object) is NEVER emitted.
12. `registry_project` (the raw Registry project record) is NEVER forwarded to JSON output.
13. Only `has_decision` (bool derived from `decision_json !== null`) and `decision_sha256` (hex string) describe decision presence in inspect output.
14. Exit codes are derived from lifecycle phase, `result.status`, or `err.code` — never from parsing `reason`, `error`, or `message` text.
15. No secrets (API tokens, environment variables, registry `worker.session_id`) appear in any output.

### 7.3. Execution surface & runtime composition
16. No shell execution. CLI invokes lifecycle functions directly; `adapterFactory` encapsulates provider process spawning.
17. No arbitrary file input.
18. No "latest thread discovery": `project_id` is the sole lookup key; the lifecycle derives all IDs internally.
19. No automatic resend of `turn/start`. `bootstrapAuditorThread` is never called from the recovery CLI.
20. No replacement thread creation.
21. No automatic legacy retirement from `recover`. `retire-legacy` is always an explicit operator action.
22. Runtime is composed directly from `createProjectRegistry()`, `createSqliteAuditorRecoveryStore()`, and `CodexAuditorAdapter`. `createBrokerRuntime` is NOT used.
23. Lifecycle-supplied canonical `cwd` takes absolute precedence in `adapterFactory`, overriding any caller/test options.

---

## 8. Integration-Test Design

All tests are deterministic. No real model turns, no real provider connections, no real Registry mutations.

### 8.1. Proposed test file

`pipeline-ui/test/refactor/auditor-recover-cli.test.js`

### 8.2. Test matrix (ARC-001..ARC-058)

| Test ID | Scenario | Expected Exit | Expected Status / Code / Assertion |
|---|---|---|---|
| ARC-001 | inspect — no active bootstrap | 0 | `active_bootstrap: null` |
| ARC-002 | inspect — PROVISIONAL_THREAD | 0 | `state: PROVISIONAL_THREAD` |
| ARC-003 | inspect — AUDIT_UNCERTAIN | 0 | `state: AUDIT_UNCERTAIN` |
| ARC-004 | inspect — DECISION_VALIDATED, has_decision: true | 0 | `has_decision: true`, `decision_sha256` present |
| ARC-005 | inspect — `decision_json` absent at every depth of JSON output | 0 | no `decision_json` key in output |
| ARC-006 | inspect — Registry read failure mapped to `PROJECT_NOT_FOUND` | 0 | `registry_binding_state: PROJECT_NOT_FOUND` (exit 0, best-effort) |
| ARC-007 | inspect — unknown flag | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-008 | inspect — missing `--project-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-009 | inspect — `--project-id` uppercase letters (invalid format) | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-010 | inspect — duplicate `--project-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-011 | inspect — forbidden flag `--thread-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-012 | inspect — positional arg after command | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-013 | recover — NO_ACTIVE_BOOTSTRAP | 0 | `status: NO_ACTIVE_BOOTSTRAP` (idempotent success) |
| ARC-014 | recover — PROVISIONAL_THREAD cleared | 0 | `status: RECOVERED_CLEARED` |
| ARC-015 | recover — FIRST_TURN_STARTING -> AUDIT_UNCERTAIN | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-016 | recover — FIRST_TURN_IN_FLIGHT -> AUDIT_UNCERTAIN | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-017 | recover — AUDIT_UNCERTAIN already -> preserved | 5 | `status: AUDIT_UNCERTAIN` |
| ARC-018 | recover — DECISION_VALIDATED -> DURABLE_BOUND | 0 | `status: DURABLE_BOUND`, asserts `bindAuditorThread` invoked when Registry begins unbound |
| ARC-019 | recover — RESUME_VERIFYING -> DURABLE_BOUND | 0 | `status: DURABLE_BOUND`, asserts `bindAuditorThread` invoked when Registry begins unbound |
| ARC-020 | recover — RESUME_VERIFIED -> DURABLE_BOUND | 0 | `status: DURABLE_BOUND`, asserts `bindAuditorThread` invoked when Registry begins unbound |
| ARC-021 | recover — REGISTRY_BINDING already bound same thread | 0 | `status: DURABLE_BOUND`, asserts NO Registry write invoked |
| ARC-022 | recover — AUDIT_TERMINAL_NO_DECISION cleared | 0 | `status: RECOVERED_TERMINAL_NO_DECISION_CLEARED` |
| ARC-023 | recover — `authority_version === 0` in DECISION_VALIDATED -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-024 | recover — authority drift (project_root changed) -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-025 | recover — resume verification fails (wrong thread ID returned) | 9 | `code: AUDITOR_LIFECYCLE_RESUME_VERIFY_FAILED` |
| ARC-026 | recover — Registry bind fails | 10 | `code: AUDITOR_LIFECYCLE_REGISTRY_BIND_FAILED` |
| ARC-027 | recover — corrupt recovery (decision hash mismatch) | 8 | `code: AUDITOR_RECOVERY_CORRUPT` |
| ARC-028 | recover — terminal-no-decision, project missing | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-029 | recover — forbidden flag `--operation-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-030 | resolve-uncertainty — not in AUDIT_UNCERTAIN state | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-031 | resolve-uncertainty — no active bootstrap | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-032 | resolve-uncertainty — AUDIT_UNCERTAIN, no turn_id -> preserved | 5 | `status: AUDIT_UNCERTAIN`, `reason` contains `TURN_HISTORY_INVALID` |
| ARC-033 | resolve-uncertainty — provider readThread fails -> AUDIT_UNCERTAIN preserved (NOT exit 7) | 5 | `status: AUDIT_UNCERTAIN`, `reason` contains `PROVIDER_INSPECTION_FAILED` |
| ARC-034 | resolve-uncertainty — thread ID mismatch from provider -> preserved | 5 | `reason` contains `THREAD_ID_MISMATCH` |
| ARC-035 | resolve-uncertainty — turn count != 1 -> preserved | 5 | `reason` contains `TURN_HISTORY_INVALID` |
| ARC-036 | resolve-uncertainty — turn interrupted -> AUDIT_TERMINAL_NO_DECISION | 0 | `status: AUDIT_TERMINAL_NO_DECISION` |
| ARC-037 | resolve-uncertainty — turn failed -> AUDIT_TERMINAL_NO_DECISION | 0 | `status: AUDIT_TERMINAL_NO_DECISION` |
| ARC-038 | resolve-uncertainty — turn completed, valid decision -> DECISION_VALIDATED | 0 | `status: DECISION_VALIDATED`, `decision_sha256` present, no `decision` key |
| ARC-039 | resolve-uncertainty — turn completed, invalid decision -> preserved | 5 | `reason` contains `DECISION_VALIDATION_FAILED` |
| ARC-040 | resolve-uncertainty — turn non-terminal (inProgress) -> preserved | 5 | `reason` contains `TURN_NONTERMINAL` |
| ARC-041 | resolve-uncertainty — `authority_version === 0` -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-042 | resolve-uncertainty — authority drift -> precondition failure | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-043 | resolve-uncertainty — forbidden flag `--turn-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-044 | retire-legacy — `authority_version === 0`, unbound -> success | 0 | `status: RETIRED_LEGACY_AUTHORITY_UNAVAILABLE` |
| ARC-045 | retire-legacy — no active bootstrap | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-046 | retire-legacy — `authority_version === 1` (not legacy) | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-047 | retire-legacy — Registry auditor bound (`thread_id !== null`) | 6 | `code: AUDITOR_LIFECYCLE_PRECONDITION_FAILED` |
| ARC-048 | retire-legacy — missing `--confirm` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-049 | retire-legacy — forbidden flag `--operation-id` | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-050 | `--help` | 0 | `operation: help`, all four commands listed |
| ARC-051 | Unknown command | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-052 | No command at all | 2 | `code: INVALID_CLI_REQUEST` |
| ARC-053 | inspect — no `decision_json` field in `history` entries | 0 | verified by output key inspection |
| ARC-054 | unmapped operational structured error fallback | 12 | `code: AUDITOR_RECOVERY_BOOTSTRAP_CONFLICT` preserved, no stack trace, classification `CLI_RUNTIME_FAILURE` |
| ARC-055 | adapterFactory receives `{ phase, cwd }` signature | 0 | created adapter receives exact `cwd = '/canonical/project'`, not object or undefined |
| ARC-056 | adapterFactory authority cwd overrides injected `adapterOptions.cwd` | 0 | created adapter `cwd` matches lifecycle canonical root, not `/attacker/override` |
| ARC-057 | runtime factory throws `AUDITOR_RECOVERY_SCHEMA_INVALID` | 11 | `code: AUDITOR_RECOVERY_SCHEMA_INVALID`, one JSON object, no stack trace |
| ARC-058 | runtime factory throws `REGISTRY_CORRUPT` | 11 | `code: REGISTRY_CORRUPT`, one JSON object, no stack trace |

Total planned count: **58 tests** (ARC-001 .. ARC-058).

### 8.3. Test infrastructure requirements

- Lifecycle functions injected via programmatic `options` object pattern.
- `adapterFactory` is a controlled stub returning mock provider clients, validating call signature `{ phase, cwd }`.
- `registryPort` is a controlled stub with configurable project fixtures and call recording.
- `recoveryStore` uses `createSqliteAuditorRecoveryStore` with temporary directory file backing.
- Each test suite run emits `ALL AUDITOR RECOVER CLI TESTS PASSED (ARC-001 .. ARC-058: 58/58 PASS)` on success.

---

## 9. Implementation File Plan

No production code is modified in WO-V4-07A-R2. The following files will be created or modified in WO-V4-07B:

| File | Action | Purpose |
|---|---|---|
| `pipeline-ui/auditor-recover-cli.js` | NEW | CLI entry point: strict parser, runtime composition (`createAuditorRecoveryCliRuntime`), adapter factory, explicit output projection, exit mapping, command dispatch, top-level error boundary, guaranteed runtime close |
| `pipeline-ui/test/refactor/auditor-recover-cli.test.js` | NEW | Deterministic test suite ARC-001..ARC-058 |
| `pipeline-ui/package.json` | MODIFY `scripts.test` | Append `auditor-recover-cli.test.js` to the test chain |
| `docs/.../15-IMPLEMENTATION-PLAN.md` | MODIFY | Update to reflect WP-V4-07B scope |

Explicit non-modification boundary:
- `pipeline-ui/lib/relay/auditor-thread-lifecycle.js`
- `pipeline-ui/lib/relay/sqlite-auditor-recovery-store.js`
- `pipeline-ui/lib/broker/registry.js`
- `pipeline-ui/lib/broker/runtime.js`
- `pipeline-ui/agent-broker-cli.js`

If implementation in 07B requires changes to any of the above files, STOP immediately: `WP_V4_07B_SCOPE_EXPANSION_REQUIRED`.

---

## 10. Open Questions

All questions are classified as `RESOLVED_FOR_07B`.

### Q1 — Auditor recovery runtime composition, phase authority, and adapterFactory signature

**Status**: `RESOLVED_FOR_07B`

**Resolution**:
1. `createBrokerRuntime` (`pipeline-ui/lib/broker/runtime.js`) is NOT used as the auditor recovery runtime. Its `lifecycleStore` is the worker/broker lifecycle store, not `sqlite-auditor-recovery-store`.
2. The recovery CLI directly composes `createProjectRegistry()`, `createSqliteAuditorRecoveryStore()`, and `createAuditorAdapterFactory()`.
3. Runtime initialization is an explicit phase: any construction error maps to **exit 11**.
4. `createAuditorAdapterFactory` accepts `{ phase, cwd } = {}` as invoked by lifecycle authority. Construction enforces `...adapterOptions` THEN `cwd` so lifecycle canonical `cwd` authority cannot be overridden.
5. Top-level unexpected process failure is caught by an entry boundary emitting exit 1 with bounded JSON and no stack trace.

### Q2 — registry_binding_state vocabulary

**Status**: `RESOLVED_FOR_07B`

**Resolution**: Verified from `registry.js` (L83-L86) and lifecycle inspect wrapper: `AUDITOR_REGISTRATION_REQUIRED`, `AUDITOR_BOUND_READY`, `AUDITOR_BOUND_DISABLED`, `PROJECT_NOT_FOUND`, `UNKNOWN`.

### Q3 — retire-legacy --confirm gate

**Status**: `RESOLVED_FOR_07B`

**Resolution**: `--confirm` is a boolean presence flag (no value). Presence = operator consent. Absence = `INVALID_CLI_REQUEST` / exit 2.

### Q4 — recover AUDIT_UNCERTAIN with turn_id === null

**Status**: `RESOLVED_FOR_07B`

**Resolution**: When `recoverAuditorBootstrap` returns `{ ok: false, status: 'AUDIT_UNCERTAIN' }`, CLI exits 5. The CLI never automatically invokes `resolve-uncertainty`. The operator must call `resolve-uncertainty` explicitly.

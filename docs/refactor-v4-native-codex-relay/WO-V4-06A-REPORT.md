# WORK ORDER REPORT: WO-V4-06A

## RUNTIME MODEL CATALOG AUTHORITY / LOGICAL POLICY RESOLUTION / FIRST-TURN MODEL+EFFORT PINNING

- **Work Order**: WO-V4-06A
- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Commit**: `f6237a73b7db8dbba324d7416df52a10792be1d0`
- **Branch**: `impl/v4-wp06a-model-policy-resolver`
- **Status**: `READY_FOR_WP_V4_06A_EXTERNAL_REVIEW`
- **WP-V4-05 Status**: `APPROVED_CLOSED`
- **WP-V4-06 Status**: `IN_PROGRESS` (06A Complete, 06B Pending)
- **WP-V4-07 Status**: `NOT_STARTED`

---

## 1. Executive Summary

WO-V4-06A establishes runtime model catalog authority for Native Codex auditor threads without hard-coding any concrete model names or assumptions into the production codebase. Logical auditor policies (`auditor_fast`, `auditor_standard`, `auditor_deep`, `architecture_deep`) are dynamically resolved against the provider's visible runtime catalog (`model/list`). The exact resolved wire `model` selector and `reasoning_effort` are pinned and forwarded to the first meaningful audit turn (`turn/start`).

---

## 2. Implementation Summary

### 2.1 Pure Policy Resolver (`pipeline-ui/lib/auditor/model-policy-resolver.js`)
- **Pure Functional API**: `resolveAuditorModelPolicy({ policy, models, preferences })`. Performs zero I/O, network calls, or mutations.
- **Stable Error Codes**:
  - `MODEL_POLICY_INVALID_REQUEST`: Invalid inputs, empty/whitespace strings, unknown policy, or worker policies (`worker_economy`, `worker_standard`) which are out of Codex scope.
  - `MODEL_POLICY_CATALOG_INVALID`: Malformed catalog, missing required model/id fields, duplicate wire model selectors, multiple default models (`isDefault === true`).
  - `MODEL_POLICY_UNAVAILABLE`: Empty catalog, all models hidden, unadvertised default effort, or no visible model compatible with configured effort preferences.
- **Zero Hard-Coded Model Assumptions**: No provider model names exist in the module. Preferences are expressed strictly via semantic effort levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`).
- **Tie-Breaking Rule**: Evaluates semantic effort levels from highest preference to fallback. Within the first matching level, prefers `isDefault === true`, then preserves provider catalog order.

### 2.2 Hardened Catalog Pagination (`pipeline-ui/lib/auditor/codex-auditor-adapter.js`)
- Hardened `listModels(options)` to consume multi-page catalogs via `nextCursor` loops while preserving backward compatibility with single-page fixtures (`data` or `models` format).
- Defaults: `includeHidden: false`, `limit: 100`.
- Finite Safety Bounds:
  - `MAX_MODEL_LIST_PAGES = 50`
  - `MAX_MODEL_CATALOG_ENTRIES = 1000`
  - `MAX_CURSOR_BYTES = 4096`
- Strictly rejects pagination cycles, repeated cursors, malformed cursor strings, and catalog overflows fail-closed.
- Extended `startTurn({ threadId, input, outputSchema, model, effort })` with client-side bounds and control-character validation, forwarding exact values to provider stdio JSONL.

### 2.3 First-Turn Pinning Boundary (`pipeline-ui/lib/relay/auditor-thread-lifecycle.js`)
- Integrated in `bootstrapAuditorThread` strictly between the R3 Registry freshness gate and `FIRST_TURN_STARTING`.
- Resolver consumes `persistedBootstrap.expected_auditor_model_policy` and the complete runtime catalog.
- Fail-Closed Semantics:
  - If `model/list`, catalog validation, or policy resolution fails, execution halts immediately before `FIRST_TURN_STARTING`.
  - Zero model turns are dispatched (`startTurn` called 0 times).
  - Recovery state remains in `PROVISIONAL_THREAD` (never transitioning to `AUDIT_UNCERTAIN`).
  - Registry remains unbound (`auditor.thread_id === null`).
  - Client 1 is closed cleanly.
- Historical Recovery Invariant: `recoverAuditorBootstrap` and `resolveAuditorBootstrapUncertainty` make zero `model/list` calls, preserving historical thread authority.

---

## 3. Deterministic Verification

All 14 deterministic test suites pass with exit code 0 (`npm test`):

| Test Suite | Identifier | Tests | Status |
|---|---|---|---|
| Model Policy Resolver | MPR-001 .. MPR-021 | 21 | PASS |
| Codex App Server Client & Adapter | CAS-001 .. CAS-094 | 94 | PASS |
| Auditor Thread Lifecycle | ATL-001 .. ATL-129 | 129 | PASS |
| Audit Decision | AD-001 .. AD-122 | 122 | PASS |
| Auditor Recovery Store | ARS-001 .. ARS-082 | 82 | PASS |
| Registry V2 Core & Migration | RG / RV2 | 91 | PASS |
| Broker / Workspace / Worker / Quarantine | Other Refactor | 8 suites | PASS |
| **Total Deterministic Suites** | **14 suites** | **All Pass** | **PASS** |

### Key Test Ranges Added
- **MPR-001 .. MPR-021**: Pure resolver test coverage (standard, fast, deep, architecture_deep, worker policies rejected, malformed catalog, duplicate selectors, multiple defaults, unknown efforts, tie-break rules, zero hardcoded models).
- **CAS-085 .. CAS-094**: Catalog pagination (`data` response, multi-page cursor forwarding, repeated cursor rejection, malformed cursor rejection, catalog size bound, `startTurn` model/effort validation and wire forwarding).
- **ATL-123 .. ATL-129**: Lifecycle order verification (listModels after R3 gate, before FIRST_TURN_STARTING, fail-closed leaves PROVISIONAL_THREAD with 0 turns, resolved model+effort forwarded to startTurn, drift rejected before catalog call, recovery path makes 0 catalog calls).

---

## 4. Read-Only Live Acceptance Probe

A real read-only probe was performed against the active Native Codex App Server:
- **Operations Executed**: `initialize`, `model/list`, `resolveAuditorModelPolicy`, `close`.
- **Thread Operations**: 0
- **Model Turns**: 0
- **Tokens Consumed**: 0
- **Live Catalog Findings**:
  - Model Count: 5 visible models
  - Default Model: 1 model claiming `isDefault: true`
  - Resolved Policy: `auditor_standard`
  - Resolved `catalog_id`: `gpt-6-astra`
  - Resolved `model`: `gpt-6-astra`
  - Resolved `reasoning_effort`: `low`
  - Effort Compatibility: Explicitly verified against model's `supportedReasoningEfforts` (`low` advertised).
- **State Freeze Verification**:
  - Registry byte SHA-256: byte-for-byte identical before and after.
  - Recovery DB byte SHA-256: byte-for-byte identical before and after.
  - Active Recovery Bootstrap: `NONE` (count: 0).
  - Bound Auditor Thread: `01a0be36-97bb-7831-8adb-02e1c1e70be0` (frozen, unchanged).

---

## 5. Scope & Boundary Conformance

- **Production Files Modified**: Exactly 3 files:
  1. `pipeline-ui/lib/auditor/model-policy-resolver.js` (NEW)
  2. `pipeline-ui/lib/auditor/codex-auditor-adapter.js` (MODIFIED)
  3. `pipeline-ui/lib/relay/auditor-thread-lifecycle.js` (MODIFIED)
- **Registry / Recovery Schemas**: Completely untouched (Registry schema v2, Recovery store user_version 2).
- **Token Observability**: Explicitly omitted, reserved for WO-V4-06B.
- **Worker Policies**: Explicitly rejected by Codex resolver as out-of-scope.
- **Source Audit**: 0 hard-coded model names in production code; no literal fallbacks.

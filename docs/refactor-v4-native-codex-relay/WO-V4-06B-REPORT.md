# WO-V4-06B-R1 COMPLETION REPORT

## 1. Executive Summary

- **Work Order**: WO-V4-06B-R1-R3 (Fresh Worktree / Terminal-Proof Procedural Replay)
- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Authoritative Parent**: `2ad4a4b57bb004c973842983192e7cd264727d72`
- **Reviewed R1 Commit**: `5b8c2a64574892c6304ff087825735a65010b7c0`
- **Branch**: `fix/v4-wp06b-r1-strict-usage-validation-r3`
- **Status**:
  - `WP-V4-06A`: `APPROVED_CLOSED`
  - `WP-V4-06B`: `BLOCKED_PENDING_R1_R3_EXTERNAL_REVIEW`
  - `WP-V4-06`: `IN_PROGRESS`
  - `WP-V4-07`: `NOT_STARTED`
  - `WP-V4-12`: `PENDING` (Budget enforcement)

### Procedural Replay Evidence
A fresh Git worktree was created directly from `2ad4a4b57bb004c973842983192e7cd264727d72`.

The pre-patch 15-suite regression printed terminal sentinel `{"completed":true,"status":0,"phase":"pre_patch"}` before reviewed R1 was applied.

Production/test content remains identical to reviewed R1 `5b8c2a64574892c6304ff087825735a65010b7c0`.

---

## 2. Protocol Characterization & Verification

The installed runtime App Server binary (`codex-cli 0.154.0`) was inspected via `codex app-server generate-json-schema` and verified against the runtime protocol definition:
- Method: `thread/tokenUsage/updated`

### 2.1. Provider Schema Authority
- `threadId`: string
- `turnId`: string
- `tokenUsage`:
  - `total`: `{ totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }`
  - `last`: `{ totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }`
  - `modelContextWindow`: required-but-nullable own-property (`missing != null`). Accepted values: `null` or non-negative safe integer.

### 2.2. Local Orchestrator Validation Policy
Enforced at the local consumer boundary (not attributed to the provider JSON schema):
- IDs (`threadId`, `turnId`): non-empty string, <= 256 UTF-8 bytes (`Buffer.byteLength(id, 'utf8') <= 256`), no surrounding whitespace (`id.trim() === id`), no control characters.

---


## 3. Implementation Details

### 3.1. Pure Token-Usage Observer (`token-usage-observer.js`)
- **Location**: `pipeline-ui/lib/auditor/token-usage-observer.js`
- Pure bounded validator and observer with zero I/O and zero provider dependencies.
- **Factory**: `createTokenUsageObserver(options)`:
  - `maxThreads = 1024`
  - `maxTurns = 4096`
- **Validation**:
  - Bounded non-empty strings for `threadId` and `turnId`:
    - Byte length enforced via UTF-8 bytes (`Buffer.byteLength(id, 'utf8') <= 256`).
    - Surrounding whitespace strictly rejected fail-closed without trimming (`id.trim() === id`).
    - No control characters.
  - All 6 token counters required in both `total` and `last`: `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`.
  - All counters must be non-negative safe integers (`Number.isSafeInteger(v) && v >= 0`).
  - `modelContextWindow` is **required-but-nullable** (`Object.prototype.hasOwnProperty.call(tokenUsage, 'modelContextWindow')`):
    - Missing property (`delete tokenUsage.modelContextWindow`) or `undefined` throws `TOKEN_USAGE_INVALID_NOTIFICATION`. Missing is NOT fabricated as `null`.
    - Explicit `null` is preserved as `null`.
    - If not `null`, must be a non-negative safe integer (`Number.isSafeInteger(v) && v >= 0`), else throws `TOKEN_USAGE_INVALID_COUNTER`.
  - Rejects: missing objects, arrays where objects expected, NaN, Infinity, negative values, fractions, unsafe integers, missing counters, invalid IDs, surrounding whitespace, IDs exceeding 256 UTF-8 bytes.
  - Stable errors: `TOKEN_USAGE_INVALID_NOTIFICATION`, `TOKEN_USAGE_INVALID_COUNTER`, `TOKEN_USAGE_THREAD_MISMATCH`.
- **Storage & Eviction**:
  - Bounded map `_threads` (`threadId -> snapshot`, max 1024).
  - Bounded map `_turns` (`${threadId}:${turnId} -> snapshot`, max 4096).
  - Deterministic oldest-insertion eviction (`map.keys().next().value`).
- **Immutability & Detachment**:
  - Full input immutability: deep detach on `record()`.
  - Full output detachment: deep detach on `getLatestForThread()` and `getLatestForTurn()`.
  - Snapshot replacement: repeated notifications for the same thread/turn REPLACE the latest snapshot; NEVER accumulate/add.
  - Zero local tokenization, zero estimation, zero summation.

### 3.2. Adapter Integration & Exact Turn Correlation (`codex-auditor-adapter.js`)
- **Location**: `pipeline-ui/lib/auditor/codex-auditor-adapter.js` (unmodified in R1, proven correct in WP-V4-06B review)
- Listens to transport client notification: `thread/tokenUsage/updated`.
- **Exact Turn Correlation & Early Race Resolution**:
  - Bounded `_pendingTokenUsage` map (max 4096) buffers valid notifications arriving before local ownership is known.
  - When notification arrives:
    - If turn ownership is already known:
      - If `turnOwnership.get(turnId) === notification.threadId`: records into observer, emits `token_usage` events.
      - If `turnOwnership.get(turnId) !== notification.threadId`: surfaces `TOKEN_USAGE_THREAD_MISMATCH` without poisoning valid usage or audit authority.
    - If turn ownership is NOT known yet (early notification race):
      - Validates structure; if valid, buffers into `_pendingTokenUsage`.
  - Centralized `recordTurnOwnership(turnId, threadId)`:
    - Called by `startTurn`, `startReview`, `interruptTurn`.
    - If pending notification exists: verifies `pending.threadId === threadId`. If match, records into observer and emits event; if mismatch, discards and surfaces mismatch.
- **Getters**:
  - `getLatestTokenUsageForThread(threadId)`: returns detached snapshot or `null`.
  - `getLatestTokenUsageForTurn({ threadId, turnId })`: returns detached snapshot or `null`. Never falls back across threads.
- **Lifecycle Safety**:
  - Observability state is completely detached from audit decision and lifecycle logic.
  - Malformed usage notifications are rejected from observability state without poisoning audit authority.
  - Zero lifecycle source modification.

### 3.3. Test Fixture (`fake-codex-app-server.js`)
- Added protocol-realistic emission of `thread/tokenUsage/updated`:
  - `turn_with_token_usage`: standard valid notification.
  - `repeated_token_usage`: multiple notifications verifying replacement without summation.
  - `token_usage_thread_mismatch`: mismatched threadId.
  - `malformed_token_usage`: malformed counter payload.
  - `early_token_usage`: notification emitted before `turn/start` response is written (race test).
  - `token_usage_missing_mcw`: valid counters with `modelContextWindow` intentionally omitted (CAS-105).

---

## 4. Verification Results

### 4.1. Unit Test Suites
- **TUO Suite** (`test/refactor/token-usage-observer.test.js`):
  - **27/27 PASS** (`TUO-001` .. `TUO-027`)
  - TUO-024: missing `modelContextWindow` rejected fail-closed, state remains empty
  - TUO-025: explicit `undefined` `modelContextWindow` rejected
  - TUO-026: UTF-8 ID byte bound enforced (> 256 bytes rejected, <= 256 bytes accepted)
  - TUO-027: surrounding whitespace in `threadId` / `turnId` rejected without trimming
- **CAS Suite** (`test/refactor/codex-app-server-client.test.js`):
  - **105/105 PASS** (`CAS-001` .. `CAS-105`)
  - CAS-097: valid usage notification captured
  - CAS-098: exact thread lookup
  - CAS-099: exact turn lookup
  - CAS-100: repeated snapshot replaces, does not add
  - CAS-101: malformed usage rejected from observability state
  - CAS-102: thread ownership mismatch rejected
  - CAS-103: valid early notification before local ownership reconciles correctly
  - CAS-104: getter result mutation does not alter cached state
  - CAS-105: missing `modelContextWindow` does not poison adapter, turn completes normally, transport remains usable

### 4.2. Full Deterministic Regression (`npm test`)
- 15 deterministic test suites pass (`exit 0`):
  - `TUO`: 27
  - `CAS`: 105
  - `MPR`: 21
  - `ATL`: 133
  - `AD`: 122
  - `ARS`: 82

### 4.3. Real State Freeze Verification
- Recovery schema `user_version`: 2
- Active recovery: NONE
- Registry `auditor.thread_id`: `01a0be36-97bb-7831-8adb-02e1c1e70be0`
- Registry `auditor.enabled`: true
- Real `thread/start`: 0
- Real `turn/start`: 0
- Real model turns: 0
- Real Registry mutations: 0
- Real recovery store mutations: 0
- Real AGY messages: 0
- Real worker dispatch: 0
- Live usage notification acceptance: `NOT_RUN_NO_NEW_MODEL_TURN_AUTHORIZED`

---

## 5. Source Audit Proof

- **Required modelContextWindow presence**: Enforced via `Object.prototype.hasOwnProperty.call(tokenUsage, 'modelContextWindow')`.
- **Missing modelContextWindow**: Throws `TOKEN_USAGE_INVALID_NOTIFICATION`, not fabricated as `null`.
- **Undefined modelContextWindow**: Throws `TOKEN_USAGE_INVALID_NOTIFICATION`.
- **Explicit null preserved**: Validated and stored as `null`.
- **UTF-8 byte bound enforced**: Checked via `Buffer.byteLength(id, 'utf8') <= 256`.
- **Surrounding whitespace rejected**: Checked via `id.trim() === id`.
- **No local tokenizer**: Confirmed zero local tokenizer libraries or token count estimators.
- **No token estimation**: All usage values come strictly from authoritative provider notifications.
- **No repeated-snapshot summation**: Snapshots replace previous values; never added or accumulated.
- **No production token budget numbers**: Zero token limits, caps, or threshold checks. Budget enforcement is reserved exclusively for WP-V4-12.
- **No automatic interrupt**: Zero interrupts triggered by token telemetry.
- **No Registry schema change**: Registry schemas and files untouched.
- **No recovery store schema change**: Recovery store schemas and files untouched.
- **Bounded storage**: Strict bounds enforced (1024 threads, 4096 turns, 4096 pending) with deterministic oldest-insertion eviction.

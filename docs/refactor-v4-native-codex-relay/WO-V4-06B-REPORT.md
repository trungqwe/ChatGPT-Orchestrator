# WO-V4-06B COMPLETION REPORT

## 1. Executive Summary

- **Work Order**: WO-V4-06B (Provider Token-Usage Observability & Exact Turn Correlation)
- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Authoritative Parent**: `324a754685d6dfc1c4fc7759854a87ec84ff7586`
- **Branch**: `impl/v4-wp06b-token-usage-observability`
- **Status**:
  - `WP-V4-06A`: `APPROVED_CLOSED`
  - `WP-V4-06B`: `COMPLETE`
  - `WP-V4-06`: `COMPLETE`
  - `WP-V4-07`: `NOT_STARTED`
  - `WP-V4-12`: `PENDING` (Budget enforcement)

---

## 2. Protocol Characterization & Verification

The installed runtime App Server binary (`codex-cli 0.154.0`) was inspected via `codex app-server generate-json-schema` and verified against the runtime protocol definition:
- Method: `thread/tokenUsage/updated`
- Required properties:
  - `threadId`: string
  - `turnId`: string
  - `tokenUsage`:
    - `total`: `{ totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }`
    - `last`: `{ totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }`
    - `modelContextWindow`: non-negative safe integer or `null`

---

## 3. Implementation Details

### 3.1. Pure Token-Usage Observer (`token-usage-observer.js`)
- **Location**: `pipeline-ui/lib/auditor/token-usage-observer.js`
- Pure bounded validator and observer with zero I/O and zero provider dependencies.
- **Factory**: `createTokenUsageObserver(options)`:
  - `maxThreads = 1024`
  - `maxTurns = 4096`
- **Validation**:
  - Bounded non-empty strings for `threadId` and `turnId` (<= 256 bytes, no control characters).
  - All 6 token counters required in both `total` and `last`: `totalTokens`, `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`.
  - All counters must be non-negative safe integers (`Number.isSafeInteger(v) && v >= 0`).
  - `modelContextWindow` must be `null` or non-negative safe integer.
  - Rejects: missing objects, arrays where objects expected, NaN, Infinity, negative values, fractions, unsafe integers, missing counters, invalid IDs.
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
- **Location**: `pipeline-ui/lib/auditor/codex-auditor-adapter.js`
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
  - No lifecycle source modification required.

### 3.3. Test Fixture (`fake-codex-app-server.js`)
- Added protocol-realistic emission of `thread/tokenUsage/updated`:
  - `turn_with_token_usage`: standard valid notification.
  - `repeated_token_usage`: multiple notifications verifying replacement without summation.
  - `token_usage_thread_mismatch`: mismatched threadId.
  - `malformed_token_usage`: malformed counter payload.
  - `early_token_usage`: notification emitted before `turn/start` response is written (race test).

---

## 4. Verification Results

### 4.1. Unit Test Suites
- **TUO Suite** (`test/refactor/token-usage-observer.test.js`):
  - **23/23 PASS** (`TUO-001` .. `TUO-023`)
- **CAS Suite** (`test/refactor/codex-app-server-client.test.js`):
  - **104/104 PASS** (`CAS-001` .. `CAS-104`)
  - CAS-097: valid usage notification captured
  - CAS-098: exact thread lookup
  - CAS-099: exact turn lookup
  - CAS-100: repeated snapshot replaces, does not add
  - CAS-101: malformed usage rejected from observability state
  - CAS-102: thread ownership mismatch rejected
  - CAS-103: valid early notification before local ownership reconciles correctly
  - CAS-104: getter result mutation does not alter cached state

### 4.2. Full Deterministic Regression (`npm test`)
- 15 deterministic test suites pass (`exit 0`):
  - `TUO`: 23
  - `CAS`: 104
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

- **No local tokenizer**: Confirmed zero local tokenizer libraries or token count estimators.
- **No token estimation**: All usage values come strictly from authoritative provider notifications.
- **No repeated-snapshot summation**: Snapshots replace previous values; never added or accumulated.
- **No production token budget numbers**: Zero token limits, caps, or threshold checks. Budget enforcement is reserved exclusively for WP-V4-12.
- **No automatic interrupt**: Zero interrupts triggered by token telemetry.
- **No Registry schema change**: Registry schemas and files untouched.
- **No recovery store schema change**: Recovery store schemas and files untouched.
- **Bounded storage**: Strict bounds enforced (1024 threads, 4096 turns, 4096 pending) with deterministic oldest-insertion eviction.

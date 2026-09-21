# Authoritative Antigravity Delivery Acknowledgement & Provenance Design (WO-V4-09C-D1)

## 1. Incident Authority & Context

During the real one-shot acceptance execution (**WP-V4-09C-P1**), the runtime executed Turn A successfully on the bound Codex thread, issuing `DISPATCH_WORKER` with work order `wp-v4-09c-readonly-worker-acceptance-001`. The broker dispatched the worker via `ao.exe send`, which exited with status `0`. The broker transitioned the lifecycle to `DISPATCH_ACCEPTED` and waited for completion. The cycle timed out after 30 seconds with `status: WORKER_PENDING`.

Subsequent read-only forensic investigations established:
- **P1-R1**: Exact boundary count = 0, exact completion count = 0.
- **P1-R2**: Across the entire authoritative transcript (64 records), `[ORCHESTRATOR_DISPATCH_V1]` appeared 0 times, matching dispatch payloads = 0, completion markers = 0. Classification: `DISPATCH_PAYLOAD_ABSENT`.

### Core Finding
```text
AO process exit 0 != authoritative worker delivery proof
```
An exit status of `0` from `ao.exe send` merely acknowledges that the CLI command completed; it does not prove that the message was received by or rendered into the authoritative worker session transcript. Treating process exit `0` as sufficient authority to declare `DISPATCH_ACCEPTED` creates a provenance gap where dispatches can become lost while marked accepted.

---

## 2. Core Delivery Authority Rule

1. **Transport Command vs. Delivery Authority**:
   ```text
   AO exit status 0 = transport-command acknowledgement only
   ```
   Process exit `0` **MUST NOT** by itself authorize the lifecycle state `DISPATCH_ACCEPTED`.

2. **Authoritative Transcript Delivery Acknowledgement**:
   For Antigravity production dispatch, authoritative delivery acknowledgement requires positive observation of the exact dispatch boundary in the Registry-resolved authoritative transcript.

3. **Exact Dispatch Boundary Specification**:
   A transcript record constitutes an authoritative dispatch boundary if and only if **all** of the following hold:
   - `record.source === "USER_EXPLICIT"`
   - `record.type === "USER_INPUT"`
   - Content physical line 0 is exactly:
     ```text
     [ORCHESTRATOR_DISPATCH_V1]
     ```
   - Content physical line 1 parses as valid JSON matching:
     ```json
     {
       "type": "worker_dispatch",
       "schema_version": 1,
       "project_id": "<exact current project_id>",
       "work_order_id": "<exact current work_order_id>",
       "dispatch_id": "<exact current dispatch_id>",
       "expected_workspace_state_id": "<exact current expected_workspace_state_id>"
     }
     ```

---

## 3. Dispatch Sequence Specification

The updated production dispatch sequence in `worker-adapter.js` is defined as:

```text
1. Validate worker descriptor & project configuration
2. Resolve authoritative transcript (createAntigravityCompletionSource)
3. Snapshot canonical transcript path identity
4. Render exact dispatch envelope
5. Invoke AO send ONCE
   â”œâ”€â”€ Non-zero exit code / timeout / spawn exception:
   â”‚   â””â”€â”€ Return existing non-definitive failure -> broker transitions to DISPATCH_UNCERTAIN
   â””â”€â”€ Exit status 0:
       â””â”€â”€ Enter bounded boundary-acknowledgement observation window:
           â”œâ”€â”€ Monotonic polling against authoritative transcript (pollIntervalMs default: 250ms)
           â”œâ”€â”€ Re-verify session & transcript mapping stability
           â”œâ”€â”€ Scan transcript for exact dispatch boundary
           â”œâ”€â”€ Exact boundary observed:
           â”‚   â””â”€â”€ Return { ok: true, state: "DISPATCH_ACCEPTED" }
           â””â”€â”€ Boundary not observed by deadline / error / contradiction:
               â””â”€â”€ Return { ok: false, definitive: false, error: "<diagnostic>" }
                   â””â”€â”€ Broker persists DISPATCH_UNCERTAIN
```

### Invariants
- **No AO resend**: `ao.exe send` is called at most once per dispatch attempt.
- **No second dispatch**: The adapter never automatically retries dispatch upon unproven boundary.
- **No heuristic delivery inference**: In the absence of an exact boundary, delivery cannot be assumed.

---

## 4. Bounded Acknowledgement Window

1. **Configuration**:
   - Default acknowledgement timeout: `30,000 ms` (`DEFAULT_DISPATCH_ACK_TIMEOUT_MS = 30000`).
   - Maximum allowable: `30,000 ms` (`MAX_DISPATCH_ACK_TIMEOUT_MS = 30000`).
   - Minimum allowable: `1 ms` (`MIN_DISPATCH_ACK_TIMEOUT_MS = 1`).
2. **Public API Immutability**:
   - `WorkerPortV1.dispatch(args)` public signature remains unchanged.
   - Acknowledgement timeout configuration is adapter-local (injectable via `options.dispatchAckTimeoutMs` for testing).
3. **Monotonic Timing & Polling**:
   - Timeouts are evaluated using monotonic clock (`clock.monotonic()`).
   - Existing dependency-injected clock and sleep facilities (`options.clock`, `options.sleep`, `options.pollIntervalMs`) are utilized.

---

## 5. Session & Transcript Stability During Acknowledgement

1. Prior to calling `ao send`, the adapter resolves the session transcript and records the canonical path.
2. During the post-send acknowledgement observation loop:
   - The adapter re-resolves the exact session via `completionSource.resolveSessionTranscript(sessionId, project)` on each scan iteration.
   - If the resolved canonical transcript path changes after the send attempt, transcript mapping drift has occurred.
   - Outcome: **Non-definitive failure** (`{ ok: false, definitive: false, error: "Transcript mapping changed during dispatch acknowledgement" }`).
   - The broker persists `DISPATCH_UNCERTAIN`. No resend is permitted.

---

## 6. Exact ACK Result & Invariants

1. **Successful Acknowledgement**:
   Only when exactly one authoritative boundary matching all identity fields is confirmed in the transcript:
   ```js
   return {
     ok: true,
     state: DISPATCH_STATES.DISPATCH_ACCEPTED
   };
   ```
2. **Separation of Concerns**:
   - The dispatch method **MUST NOT** claim `READY_FOR_REVIEW` during dispatch acknowledgement, even if a completion record is already present in the transcript.
   - Completion observation is the exclusive domain of `workerPort.wait()`.

---

## 7. Failure & Ambiguity Semantics

| Scenario | Adapter Return | Broker Action | Durable State |
|---|---|---|---|
| AO exit 0, deadline expired, 0 boundaries found | `{ ok: false, definitive: false, error: "Dispatch delivery boundary was not observed within acknowledgement deadline" }` | Handles non-definitive dispatch failure | `DISPATCH_UNCERTAIN` |
| AO exit 0, transcript resolution unavailable / scan error / corrupt UTF-8 | `{ ok: false, definitive: false, error: "<diagnostic>" }` | Handles non-definitive dispatch failure | `DISPATCH_UNCERTAIN` |
| AO exit 0, transcript mapping changed during ack | `{ ok: false, definitive: false, error: "Transcript mapping changed during dispatch acknowledgement" }` | Handles non-definitive dispatch failure | `DISPATCH_UNCERTAIN` |
| AO exit 0, multiple exact boundaries observed | `{ ok: false, definitive: false, error: "Duplicate current dispatch boundary records observed" }` | Handles non-definitive dispatch failure | `DISPATCH_UNCERTAIN` |
| AO exit 0, contradictory expected workspace state ID on matching dispatch | `{ ok: false, definitive: false, error: "Contradictory expected_workspace_state_id on matching dispatch identity" }` | Handles non-definitive dispatch failure | `DISPATCH_UNCERTAIN` |

In all failure paths following an AO send attempt, the failure is **non-definitive** because the command was executed and delivery might have succeeded without verifiable evidence. This correctly triggers the broker's established `DISPATCH_UNCERTAIN` lifecycle transition without introducing new lifecycle states.

---

## 8. Wait Contract Hardening & WA-008 Retirement

### Problem
Under the previous design (WA-008), if `workerPort.wait()` reached its deadline without seeing any dispatch boundary, it assumed delivery had succeeded and returned `{ ok: true, state: "DISPATCH_ACCEPTED" }`.

### Hardened Rule
Under the new delivery acknowledgement contract, `DISPATCH_ACCEPTED` is **only** returned once the boundary has already been verified on disk. Consequently:
1. If a subsequent `workerPort.wait()` invocation cannot observe the already-proven exact boundary within the transcript snapshot, provenance has been violated.
2. **WA-008 is retired**: The adapter **MUST NOT** return `DISPATCH_ACCEPTED` when the boundary is missing at wait deadline.
3. Instead, the adapter returns:
   ```js
   return {
     ok: false,
     code: ERROR_CODES.PROVENANCE_AMBIGUOUS,
     dispatch_id,
     error: "Authoritative dispatch boundary previously acknowledged could not be found in transcript during wait"
   };
   ```
4. The broker maps this to `PROVENANCE_AMBIGUOUS` lifecycle state.

---

## 9. Contract & Broker Scope Boundaries

1. **`contracts.js`**:
   - Zero changes.
   - Lifecycle state enum (`DISPATCH_STATES`), active states (`ACTIVE_STATES`), transition rules, and error codes (`ERROR_CODES`) are completely preserved.
2. **`broker.js`**:
   - Zero changes.
   - The broker already handles `{ ok: false, definitive: false }` from `dispatchWorker()` by transitioning `DISPATCHING -> DISPATCH_UNCERTAIN`.
   - The broker already handles `code: ERROR_CODES.PROVENANCE_AMBIGUOUS` from `waitWorker()` by transitioning to `PROVENANCE_AMBIGUOUS`.

---

## 10. Production Implementation Target & Boundaries

- **Target Source Scope**:
  - `pipeline-ui/lib/broker/worker-adapter.js`
  - `pipeline-ui/test/refactor/worker-adapter.test.js`
- **Protected Files (zero modification)**:
  - `pipeline-ui/lib/broker/broker.js`
  - `pipeline-ui/lib/broker/contracts.js`
  - `pipeline-ui/lib/broker/lifecycle-store.js`
  - `pipeline-ui/lib/broker/sqlite-lifecycle-store.js`
  - `pipeline-ui/lib/broker/worker-adapter-registry.js`
  - `pipeline-ui/lib/broker/runtime.js`
  - `pipeline-ui/lib/relay/one-shot-cycle.js`
  - All Project Registry and Codex Auditor modules.

---

## 11. Deterministic Test Matrix (ACK-01..ACK-12)

The implementation work order must supply deterministic unit and integration test coverage:

- **ACK-01**: AO exit 0 + exact authoritative boundary observed within deadline â†’ `{ ok: true, state: "DISPATCH_ACCEPTED" }`.
- **ACK-02**: AO exit 0 + boundary absent through deadline â†’ `{ ok: false, definitive: false }`, AO send count = 1, no resend.
- **ACK-03**: AO exit 0 + transcript scan throws / file unavailable after send â†’ non-definitive failure.
- **ACK-04**: AO exit 0 + transcript mapping changes after send â†’ non-definitive failure.
- **ACK-05**: AO exit 0 + duplicate exact current boundary observed â†’ non-definitive failure.
- **ACK-06**: AO exit 0 + contradictory dispatch identity (mismatched workspace state ID) â†’ non-definitive failure.
- **ACK-07**: Single-send proof: in all post-send failure and uncertainty paths, `spawnSync` is invoked exactly once.
- **ACK-08**: Acknowledgement timeout bounding (clamped between 1 ms and 30,000 ms, monotonic clock evaluation).
- **ACK-09**: Exact boundary acknowledgement does NOT emit `READY_FOR_REVIEW`.
- **ACK-10**: Wait with observed boundary + no completion envelope within timeout â†’ `{ ok: true, state: "RUNNING" }`.
- **ACK-11**: Wait with observed boundary + valid matching completion envelope â†’ `{ ok: true, state: "READY_FOR_REVIEW" }`.
- **ACK-12**: Wait with no authoritative boundary present in transcript â†’ returns `PROVENANCE_AMBIGUOUS` (retiring WA-008).

### Broker Integration Proof
- **ACK-INT-01**: Broker `dispatchWorker()` begins `DISPATCHING`. AO process exits 0. No dispatch boundary appears in transcript. Adapter returns non-definitive error. Broker transitions durable lifecycle to `DISPATCH_UNCERTAIN`. Total AO sends = 1, zero retries.

---

## 12. Unit Assumption Retirement

Existing tests in `pipeline-ui/test/refactor/worker-adapter.test.js` making stale assumptions must be updated:
- **WA-005**: Previous assumption that AO process exit 0 immediately yields `DISPATCH_ACCEPTED` must be updated to require boundary observation.
- **WA-008**: Previous assumption that a missing boundary at wait deadline returns `DISPATCH_ACCEPTED` is formally retired and replaced with `PROVENANCE_AMBIGUOUS`.

---

## 13. Existing P1 Dispatch & Acceptance Re-run Protocol

1. **Existing Dispatch Remains Frozen**:
   The real dispatch `D-64b46bf3-2853-452a-8220-3c056d27810d` generated during P1 remains in `DISPATCH_ACCEPTED` state. This design work order (D1) performs **zero** lifecycle reconciliation.
2. **Subsequent Reconciliation Work Order**:
   Following implementation approval, a dedicated operator reconciliation work order will transition the stalled dispatch:
   ```text
   DISPATCH_ACCEPTED -> PROVENANCE_AMBIGUOUS
   ```
   via existing lifecycle authority without invoking worker wait or auditor turns.
3. **Fresh Acceptance Work Order**:
   The P1 guard (`%TEMP%\wp-v4-09c-p1-real-cycle.executed.guard`) will remain untouched. A future acceptance run (P2) will use a fresh run identity, new work order ID, and fresh guard.

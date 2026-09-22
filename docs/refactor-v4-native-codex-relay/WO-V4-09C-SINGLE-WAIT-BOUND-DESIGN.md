# Extended Single-Wait Bound for Real One-Shot Worker Completion Design (WO-V4-09C-WAIT-D1)

## 1. Incident Authority & P5 Failure Evidence

During the authorized real one-shot acceptance execution (**WP-V4-09C-P5**), Turn A succeeded on the bound Codex auditor thread (`01a0be36-97bb-7831-8adb-02e1c1e70be0`), issuing an authoritative `DISPATCH_WORKER` decision with work order `wp-v4-09c-readonly-worker-acceptance-005`.

The coordinator observed:
1. **Turn A Completion**: `DISPATCH_WORKER` returned with clean provenance; the P4-E1 child environment authority fix was confirmed operational.
2. **Fresh Dispatch Acknowledged**: Broker dispatch `D-c15ff996-4996-4ba7-beba-dfe4184c6fa6` was dispatched via `ao.exe send` and reached `DISPATCH_ACCEPTED` upon authoritative transcript acknowledgement.
3. **Single Wait Window**: The broker invoked `broker.waitWorker()` under the current 30-second maximum timeout bound (`workerWaitTimeoutSecs: 30`).
4. **Premature Wait Expiry**: At deadline (+30s), the worker had not yet emitted a completion marker into the transcript. The wait returned `state: RUNNING`.
5. **Coordinator Terminal Result**: Following sealed single-wait semantics, `runOneShotCycle()` terminated with `status: WORKER_PENDING`, `code: null`.
6. **Cycle Immutability**: Turn B was **NOT REACHED**, and P5 was sealed as `EXECUTED_NOT_FULL_PASS`, with retries strictly **FORBIDDEN**.

---

## 2. P5-F1 Forensics & Late Valid Completion Finding

Read-only forensic investigation (**WO-V4-09C-P5-F1**) inspected the canonical worker transcript (`6307ff6e-407f-4253-8bf5-684c33bd31b2/.system_generated/logs/transcript.jsonl`):
- **Exact Dispatch Boundary**: Record index 2 contained the exact current dispatch envelope (`D-c15ff996-4996-4ba7-beba-dfe4184c6fa6`, count = 1, contradictory = 0).
- **Legitimate Worker Activity**: Following dispatch delivery, the Antigravity worker actively executed multiple comprehensive read-only acceptance checks (git status verification, file existence checks, and deterministic test suite runs across `codex-app-server-client.test.js` and `worker-adapter.test.js`).
- **Exact Completion Machine Line**: At record index 29, the worker emitted the exact, fully conformant standalone completion marker:
  ```text
  [ORCHESTRATOR_COMPLETION_V1] {"type":"worker_completion","schema_version":1,"project_id":"chatgpt-orchestrator","work_order_id":"wp-v4-09c-readonly-worker-acceptance-005","dispatch_id":"D-c15ff996-4996-4ba7-beba-dfe4184c6fa6","state":"READY_FOR_REVIEW"}
  ```
- **Timing Analysis**: The completion record appeared approximately 35–45 seconds after dispatch delivery—shortly after the 30-second broker wait window had already expired.
- **Absence of Provider Errors**: Zero 429 records, zero `RESOURCE_EXHAUSTED` records, and zero process crash events were observed.
- **Sealed Classification**:
  ```text
  ROOT_CAUSE: LATE_VALID_COMPLETION
  PROVENANCE: CLEAN
  ```

---

## 3. P5-RC1 Reconciliation Outcome

Following the sealed F1 findings, a one-time lifecycle reconciliation (**WO-V4-09C-P5-RC1**) was authorized and executed:
- The dispatch state was reconciled:
  ```text
  RUNNING -> READY_FOR_REVIEW
  ```
- Complete chronological lifecycle history was preserved:
  ```text
  DISPATCHING -> DISPATCH_ACCEPTED -> RUNNING -> READY_FOR_REVIEW
  ```
- The project active dispatch lock was released (`postActive === null`), returning broker worker status to `IDLE`.
- **RC1 Boundary Constraint**: RC1 established clean terminal lifecycle state for dispatch `D-c15ff996-4996-4ba7-beba-dfe4184c6fa6`, but did **NOT** retroactively trigger Turn B or alter the fact that P5 ended as `NOT_FULL_PASS`.

---

## 4. Current 30-Second Shared Timeout Authority

Inspection of the codebase confirms that timeout bounds are defined centrally and consumed consistently:
1. **Central Authority** (`pipeline-ui/lib/broker/contracts.js`):
   ```javascript
   const LIMITS = Object.freeze({
     MAX_DIRECTIVE_BYTES: 2 * 1024 * 1024,
     DEFAULT_TIMEOUT_SECS: 10,
     MIN_TIMEOUT_SECS: 1,
     MAX_TIMEOUT_SECS: 30
   });
   ```
2. **Broker Clamping** (`pipeline-ui/lib/broker/broker.js`):
   ```javascript
   let timeoutSecs = request.timeout_secs;
   if (typeof timeoutSecs !== 'number' || isNaN(timeoutSecs)) timeoutSecs = LIMITS.DEFAULT_TIMEOUT_SECS;
   if (timeoutSecs > LIMITS.MAX_TIMEOUT_SECS) timeoutSecs = LIMITS.MAX_TIMEOUT_SECS;
   if (timeoutSecs < LIMITS.MIN_TIMEOUT_SECS) timeoutSecs = LIMITS.MIN_TIMEOUT_SECS;
   ```
3. **Worker Adapter Clamping** (`pipeline-ui/lib/broker/worker-adapter.js`):
   ```javascript
   let timeoutSecs = args.timeout_secs;
   if (typeof timeoutSecs !== 'number' || isNaN(timeoutSecs)) timeoutSecs = LIMITS.DEFAULT_TIMEOUT_SECS;
   if (timeoutSecs > LIMITS.MAX_TIMEOUT_SECS) timeoutSecs = LIMITS.MAX_TIMEOUT_SECS;
   if (timeoutSecs < LIMITS.MIN_TIMEOUT_SECS) timeoutSecs = LIMITS.MIN_TIMEOUT_SECS;
   ```
4. **Relay Clamping** (`pipeline-ui/lib/relay/one-shot-cycle.js`):
   ```javascript
   workerWaitTimeoutSecs = Math.min(
     BROKER_LIMITS.MAX_TIMEOUT_SECS,
     Math.max(BROKER_LIMITS.MIN_TIMEOUT_SECS, rawWorkerWaitTimeoutSecs)
   );
   ```

**Architectural Insight**: There is no hidden worker-adapter timeout. All components share `LIMITS.MAX_TIMEOUT_SECS`. The 30-second ceiling is enforced uniformly across the broker, worker adapter, and one-shot cycle coordinator.

---

## 5. Chosen Remediation: EXTENDED_SINGLE_WAIT_BOUND (300 Seconds)

The remediation is sealed as **`EXTENDED_SINGLE_WAIT_BOUND`**:

```javascript
const LIMITS = Object.freeze({
  MAX_DIRECTIVE_BYTES: 2 * 1024 * 1024,
  DEFAULT_TIMEOUT_SECS: 10,
  MIN_TIMEOUT_SECS: 1,
  MAX_TIMEOUT_SECS: 300 // 5 minutes
});
```

### Key Properties
- **MAX_TIMEOUT_SECS**: Increased from `30` to `300` seconds (5 minutes).
- **DEFAULT_TIMEOUT_SECS**: Preserved at `10` seconds. Unspecified caller waits remain short and bounded.
- **MIN_TIMEOUT_SECS**: Preserved at `1` second.
- **Finite and Bounded**: 300 seconds provides ample margin for thorough real worker execution (which completed in ~45s in P5) while remaining strictly finite and preventing unbounded hangs.

---

## 6. Unchanged 10-Second Default & Backward Compatibility

Callers that omit `timeout_secs` or pass non-numeric values continue to receive `DEFAULT_TIMEOUT_SECS = 10`. Only callers that explicitly request a higher timeout (e.g., up to `300`) will have their wait window extended. This preserves exact backward compatibility with all unit and integration tests relying on default timeout behavior.

---

## 7. Exactly-One-Wait Invariant Preserved

The coordinator invariant is strictly preserved:
```text
broker.waitWorker() calls inside runOneShotCycle(): AT MOST 1
```
No polling loop, recursive wait, or second wait attempt is introduced into `runOneShotCycle()`. If the single bounded wait expires while the worker is still in `RUNNING` or `DISPATCH_ACCEPTED`, the result remains `status: WORKER_PENDING`.

---

## 8. Explicit Rejection of V4-09 Continuation & Retry Semantics

We explicitly reject adding a post-`WORKER_PENDING` continuation mechanism within work package `WP-V4-09C`:
1. **Architecture of V4-09 Full Cycle**: The 14 full-cycle invariants require a continuous single-process coordinator execution:
   - Registered auditor starts bound and enabled
   - Turn A executed on bound thread
   - Direct broker dispatch
   - Direct broker wait reaching `READY_FOR_REVIEW`
   - Gate D / S2 workspace verification
   - Turn B executed on the **same logical thread and same adapter instance**
   - S3 verification and clean adapter close
2. **Continuation Flaws**: A multi-phase continuation architecture (e.g., process 1 exits `WORKER_PENDING`, process 2 resumes wait, process 3 spawns new adapter for Turn B) breaks the 14-invariant atomic proof and introduces state synchronization and race risks.
3. **Scope Discipline**: Durable resumption after external events may be considered in future recovery work packages (e.g., `V4-10`), but is explicitly **out of scope** for V4-09 single-cycle acceptance.

---

## 9. Unchanged Provenance & Failure Semantics

The extended wait bound does **NOT** weaken fail-closed provenance validation:
- `PROVENANCE_AMBIGUOUS` is still triggered immediately if:
  - An acknowledged dispatch boundary disappears from the transcript during wait polling.
  - Contradictory dispatch boundaries are observed.
  - Duplicate or contradictory completion markers are observed.
- `WORKER_WAIT_UNAVAILABLE` is still triggered immediately if:
  - Worker session configuration is invalid or missing.
  - Completion source fails integrity checks or SQLite errors occur.
- Non-authoritative records (e.g., worker prose, partial JSON) are never treated as completion authority.

---

## 10. Deterministic Regression Test Matrix (WAIT-BOUND-001..012)

All verification must be 100% deterministic using fake clocks and mock transcript feeds. **No test may execute a real wall-clock sleep of 300 seconds.**

| Test ID | Target File | Scope & Assertion |
|---|---|---|
| `WAIT-BOUND-001` | `contracts.test.js` | `LIMITS.MAX_TIMEOUT_SECS === 300` and `LIMITS.DEFAULT_TIMEOUT_SECS === 10`. |
| `WAIT-BOUND-002` | `broker-core.test.js` | `broker.waitWorker({ timeout_secs: 300 })` passes exact `300` to `workerPort.wait`. |
| `WAIT-BOUND-003` | `broker-core.test.js` | `broker.waitWorker({ timeout_secs: 999 })` clamps timeout to `300`. |
| `WAIT-BOUND-004` | `worker-adapter.test.js` | Worker adapter accepts exact `timeout_secs: 300` and calculates deadline with monotonic clock +300,000ms. |
| `WAIT-BOUND-005` | `worker-adapter.test.js` | Worker adapter clamps `timeout_secs: 500` to `300`. |
| `WAIT-BOUND-006` | `one-shot-cycle.test.js` | `runOneShotCycle({ workerWaitTimeoutSecs: 300 })` passes `timeout_secs: 300` to `broker.waitWorker`. |
| `WAIT-BOUND-007` | `one-shot-cycle.test.js` | `runOneShotCycle({ workerWaitTimeoutSecs: 450 })` clamps wait timeout to `300`. |
| `WAIT-BOUND-008` | `one-shot-cycle.test.js` | `broker.waitWorker` is called at most once during an entire one-shot cycle execution. |
| `WAIT-BOUND-009` | `one-shot-cycle.test.js` | If worker state is `RUNNING` at the 300s deadline, coordinator cleanly returns `status: WORKER_PENDING`. |
| `WAIT-BOUND-010` | `one-shot-cycle.test.js` | If worker emits `READY_FOR_REVIEW` at t=45s (before 300s deadline), wait immediately resolves and proceeds to Gate D and Turn B. |
| `WAIT-BOUND-011` | `broker-core.test.js` | If `timeout_secs` is omitted or `undefined`, broker and adapter default to `10` seconds. |
| `WAIT-BOUND-012` | `one-shot-cycle.test.js` | Verify no loop or retry calls `waitWorker` a second time after `WORKER_PENDING`. |

---

## 11. Future P6 Real Acceptance Policy

When real acceptance P6 is authorized:
1. The execution script **MUST** explicitly specify:
   ```javascript
   runOneShotCycle({
     ...
     workerWaitTimeoutSecs: 300
   });
   ```
2. The real worker will be permitted up to 300 seconds to perform its independent verification and emit `[ORCHESTRATOR_COMPLETION_V1]`.
3. If the completion arrives at ~40–60s (as evidenced by P5), `broker.waitWorker()` will exit early upon detecting the completion marker, immediately advancing to Gate D, Turn B, and cycle approval.

---

## 12. Rollback Rule

If implementation or testing reveals that extending `MAX_TIMEOUT_SECS` causes unanticipated side effects or breaks existing broker invariants:
1. Revert `pipeline-ui/lib/broker/contracts.js` back to `MAX_TIMEOUT_SECS: 30`.
2. Stop work immediately and declare `WAIT_BOUND_REVERTED_EXTERNAL_REVIEW_REQUIRED`.
3. Do not attempt ad-hoc workarounds or monkey-patching of individual component limits.

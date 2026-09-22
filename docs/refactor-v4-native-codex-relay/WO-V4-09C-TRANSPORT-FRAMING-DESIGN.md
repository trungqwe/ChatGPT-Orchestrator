# WO-V4-09C-TRANSPORT-FRAMING-DESIGN

## Antigravity Transcript Framing Compatibility — Design Seal (Revision 1)

**Authority:**
- Gate 1 / U1: `APPROVED_CLOSED`
- Gate 2 / U2: `APPROVED_CLOSED`
- Gate 3 / P2-RC: `APPROVED_CLOSED`
- Gate 4: `APPROVED_CLOSED`
- WO-V4-09C-P3: `EXECUTED_NOT_FULL_PASS`
- WO-V4-09C-P3-F1-R1: `APPROVED_CLOSED`
- WO-V4-09C-P3-RC: `APPROVED_CLOSED`
- WO-V4-09C-TF-D1: `CHANGES_REQUIRED`
- Work Order: `WO-V4-09C-TF-D1-R1`
- Parent Commit: `5571c367c6e2105a7afeda68cd93f34783b0a2b4`
- Status: `DESIGN_COMPLETE / PENDING_EXTERNAL_REVIEW`

---

## 1. Incident Evidence

During the execution of `WO-V4-09C-P3` against real runtime session `chatgpt-orchestrator-2` with dispatch ID `D-a08ac318-2e3b-4f3a-9c8f-07e89e58da7a`, the dispatch envelope was delivered to the worker via `ao.exe send`. The worker CLI and Antigravity provider recorded the input into the native transcript file at:
`C:\Users\Admin\.gemini\antigravity-cli\brain\4e645c82-1bc0-4c1a-9788-8301d3a098ea\.system_generated\logs\transcript.jsonl`

Read-only forensic inspection of the resulting transcript revealed the following physical record:

### Record 64 Structural Metadata
- **Physical index:** `64`
- **Source:** `"USER_EXPLICIT"`
- **Type:** `"USER_INPUT"`
- **Status:** `"DONE"`
- **Total physical lines:** `19`
- **First 3 physical lines:**
  - `rawLines[0]`: `"<USER_REQUEST>"`
  - `rawLines[1]`: `"[ORCHESTRATOR_DISPATCH_V1]"`
  - `rawLines[2]`: `"{\"type\":\"worker_dispatch\",\"schema_version\":1,\"project_id\":\"chatgpt-orchestrator\",\"work_order_id\":\"wp-v4-09c-readonly-worker-acceptance-003\",\"dispatch_id\":\"D-a08ac318-2e3b-4f3a-9c8f-07e89e58da7a\",\"expected_workspace_state_id\":\"sha256:e33ec2040e46b4e0faa18b78b7ee3783c86cf12774f64e7c3505aeecd90a21fb\"}"`
- **Last 3 physical lines:**
  - `rawLines[16]`: `"<ADDITIONAL_METADATA>"`
  - `rawLines[17]`: `"The current local time is: 2026-09-22T04:16:12+07:00."`
  - `rawLines[18]`: `"</ADDITIONAL_METADATA>"`
- **Closing tag line:** `rawLines[15]` equals `"</USER_REQUEST>"`
- **Wrapper open count (`<USER_REQUEST>`):** `1`
- **Wrapper close count (`</USER_REQUEST>`):** `1`
- **Physical position of marker `[ORCHESTRATOR_DISPATCH_V1]`:** line `1`
- **Physical position of exact dispatch JSON:** line `2`

### Failure Mechanism
Production `classifyDispatchBoundaryRecord()` in `pipeline-ui/lib/broker/worker-adapter.js` evaluated candidates strictly using:
```javascript
if (rawLines[0] !== '[ORCHESTRATOR_DISPATCH_V1]' || !rawLines[1]) {
  return { isCandidate: false };
}
```
Because the native provider protocol framed the user request within `<USER_REQUEST>`, `rawLines[0]` contained `"<USER_REQUEST>"` rather than `"[ORCHESTRATOR_DISPATCH_V1]"`. Consequently, the classifier returned `{ isCandidate: false }` across all polling intervals for 30 seconds until the acknowledgement deadline expired. This caused `dispatchWorker()` to transition the dispatch to `DISPATCH_UNCERTAIN` despite synchronous disk persistence of the exact dispatch payload at 21:16:04Z.

---

## 2. Current Contract Baseline

The design strictly preserves all existing core guarantees established across V4-08 and V4-09:

1. **Source and Type Invariance:** Record must have `record.source === 'USER_EXPLICIT'` and `record.type === 'USER_INPUT'`.
2. **Exact Identity Matching:** Dispatch control JSON must match all sealed fields:
   - `type === 'worker_dispatch'`
   - `schema_version === 1`
   - `project_id === expected.project_id`
   - `work_order_id === expected.work_order_id`
   - `dispatch_id === expected.dispatch_id`
   - `expected_workspace_state_id === expected.expected_workspace_state_id`
3. **Contradiction Detection:** Current `dispatch_id` with any mismatched control field remains a strict contradiction (`isContradiction: true`), triggering non-definitive `DISPATCH_UNCERTAIN` and halting resends.
4. **Foreign Dispatch Segregation:** Any record claiming a different `dispatch_id` is treated as unrelated historical context (`isForeign: true`).
5. **Duplicate Boundary Rejection:** Multiple boundary occurrences for the current dispatch trigger immediate failure.
6. **Single AO Send & Zero Resend:** At most one AO send per dispatch cycle; zero resends after uncertainty.
7. **Mapping Stability:** Session resolution must remain canonically contained and invariant across polling.
8. **Bounded Scanning:** Memory-bounded 64 KiB chunk processing with line size enforcement.
9. **Unwrapped Backward Compatibility:** The canonical unwrapped form (`rawLines[0] === '[ORCHESTRATOR_DISPATCH_V1]'`) remains 100% valid and accepted.

---

## 3. Provider-Framing Survey

A read-only survey of all `source === 'USER_EXPLICIT' && type === 'USER_INPUT'` records in the authoritative native Antigravity transcript was conducted:

| Record Index | Line Count | Line 0 | Closing Element | Wrapper Open Count | Wrapper Close Count | Trailing Metadata Blocks |
|---|---|---|---|---|---|---|
| 0 | 9 | `"<USER_REQUEST>"` | Line 2: `"</USER_REQUEST>"` | 1 | 1 | `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>` |
| 64 | 19 | `"<USER_REQUEST>"` | Line 15: `"</USER_REQUEST>"` | 1 | 1 | `<ADDITIONAL_METADATA>` |

### Survey Findings & Claim Scope
Across every eligible `USER_EXPLICIT` / `USER_INPUT` record observed in this authoritative session transcript, the native provider used `<USER_REQUEST>` framing.

This evidence establishes the runtime shape required for compatibility with this observed production path; it does not claim every future Antigravity version or transport implementation must use the same framing.

Key structural observations from this session:
1. The user-submitted content in both observed records begins on physical line 1 immediately following line 0 `<USER_REQUEST>`.
2. Both records contain provider-appended metadata blocks (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`) after the closing `</USER_REQUEST>` tag.
3. In both records, neither the opening tag nor the marker contains leading whitespace.

---

## 4. Architectural Options Analysis

Three remediation locations were evaluated:

### Option A: Normalize Provider Framing inside `antigravity-completion-source.js`
- **Mechanism:** `scanResolvedSession` unwraps `<USER_REQUEST>` or normalizes `record.content` before passing it to the visitor.
- **Authority Ownership:** Flawed. `CompletionSource` is designed to be a raw, byte-level authoritative transcript reader.
- **Raw Transcript Preservation:** Destroyed. Normalizing or rewriting content in the reader hides real provider payload representation.
- **Security & Provenance Risk:** High. Modifying `record.content` breaks raw hash verification and creates semantic divergence between the physical file and the in-memory object.
- **Provider Coupling:** High. Tight-couples the generic low-level file scanner with Antigravity-specific message formatting.

### Option B: Teach `classifyDispatchBoundaryRecord()` an Exact Provider-Framing Grammar (Recommended)
- **Mechanism:** Keep `antigravity-completion-source.js` purely raw and unmutated. Extend `classifyDispatchBoundaryRecord()` in `worker-adapter.js` to recognize both canonical unwrapped and exact provider-wrapped forms.
- **Authority Ownership:** Correct. `worker-adapter.js` is the authoritative owner of the dispatch envelope protocol and boundary semantics.
- **Raw Transcript Preservation:** 100% preserved. The transcript reader delivers raw records untouched.
- **Security & Provenance Risk:** Bounded by the exact dual-envelope grammar and fail-closed wrapper-count requirements.
- **Dispatch ACK & Wait Parity:** Natural and complete. Both ACK and `wait()` share `classifyDispatchBoundaryRecord()`, ensuring identical parsing.
- **Test Surface:** Focused on unit and adapter contract tests.

### Option C: Change Dispatch Envelope to Force Unwrapped Transcript Representation
- **Mechanism:** Attempt to invoke `ao.exe` or modify flags/envelope formatting so that Antigravity omits `<USER_REQUEST>`.
- **Feasibility:** Infeasible. The `<USER_REQUEST>` tag is injected internally by the Antigravity engine/binary when consuming prompt inputs from standard input or CLI arguments.
- **Security & Provenance Risk:** High. Attempting to bypass provider core framing requires non-standard command-line hacks or modifying external provider binaries.

### Architectural Decision
**Option B is selected.** `createAntigravityCompletionSource()` remains a raw, unmutated reader. `classifyDispatchBoundaryRecord()` in `worker-adapter.js` becomes aware of the exact sealed provider framing.

---

## 5. Design Preference Validation

The design confirms the architectural separation:
- **`antigravity-completion-source.js` owns:**
  - Filesystem authority and existence validation.
  - Canonical realpath containment under `brainDir`.
  - Memory-bounded stream decoding (64 KiB buffer).
  - Snapshot size bounding and concurrent-append safety.
  - Strict JSONL record deserialization without payload mutation.
- **`worker-adapter.js` owns:**
  - Semantic interpretation of worker dispatch envelopes and completion records.
  - Verification of dispatch boundaries against expected session and work order.
  - Dispatch acknowledgement timeout and wait polling loops.

---

## 6. Sealed Wrapped-Boundary Grammar

`classifyDispatchBoundaryRecord(record, expected)` shall support exactly two valid envelope shapes:

### Shape 1: Canonical Unwrapped Form
```text
rawLines[0] === '[ORCHESTRATOR_DISPATCH_V1]'
rawLines[1] === <valid JSON control object>
```
- Line 0 must match `[ORCHESTRATOR_DISPATCH_V1]` exactly (no leading/trailing whitespace).
- Line 1 must parse as a JSON object claiming `type === 'worker_dispatch'`.

### Shape 2: Provider-Wrapped Form (Antigravity Native)
```text
rawLines[0] === '<USER_REQUEST>'
rawLines[1] === '[ORCHESTRATOR_DISPATCH_V1]'
rawLines[2] === <valid JSON control object>
...
rawLines[K] === '</USER_REQUEST>'   (where K >= 3)
[optional post-close provider suffix lines]
```

**Sealed Structural Requirements:**
1. `rawLines[0]` must strictly equal `'<USER_REQUEST>'` (case-sensitive, no leading/trailing whitespace).
2. `rawLines[1]` must strictly equal `'[ORCHESTRATOR_DISPATCH_V1]'` (no leading/trailing whitespace).
3. `rawLines[2]` must parse as a valid JSON object.
4. **Exact Open/Close Line Counts:**
   - Over the complete record (`rawLines`), the count of physical lines strictly equal to `'<USER_REQUEST>'` must equal exactly `1`.
   - Over the complete record (`rawLines`), the count of physical lines strictly equal to `'</USER_REQUEST>'` must equal exactly `1`.
5. **Exact Wrapper Positions:**
   - The unique opening line must be at physical index `0`.
   - The unique closing line `rawLines[K]` must have index `K >= 3`.
6. **Closing Wrapper Position relative to EOF:**
   - Real runtime evidence establishes that `</USER_REQUEST>` is not required to be at EOF; optional provider suffix lines may follow `K`.
7. **Strict Rejection:**
   All of the following structural anomalies fail closed (`isCandidate: false`):
   - Nested opening wrapper (`<USER_REQUEST>` appearing more than once).
   - Second opening wrapper anywhere in the record (including in suffix).
   - Duplicate closing wrapper (`</USER_REQUEST>` appearing more than once).
   - Missing closing wrapper (`</USER_REQUEST>` count === 0).
   - Opening wrapper at any index other than `0`.
   - Closing wrapper appearing before control JSON (index `K < 3`).
   - Marker or control JSON appearing only after the closing wrapper.

---

## 7. Suffix Authority and Treatment

Real P3 evidence proves that `</USER_REQUEST>` is followed by provider-appended blocks (e.g., `<ADDITIONAL_METADATA>...</ADDITIONAL_METADATA>`).

### Sealed Distinction:
- **`USER_REQUEST` framing block (lines 0 through K):**
  - **Authority-bearing.** Contains the dispatch boundary marker, control JSON, and directive payload.
- **Post-`</USER_REQUEST>` suffix (lines K+1 to EOF):**
  - **Non-authoritative for dispatch-boundary identity.**

### Suffix Treatment: Opaque Provider-Owned Suffix (Option A Sealed)
The suffix is treated as **opaque provider-owned non-authoritative data**.
- **Rationale:** Production transcripts already exhibit multiple suffix elements (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`). Enumerating an exhaustive grammar of permissible provider metadata blocks would create unnecessary fragility against benign provider runtime updates. Dispatch boundary classification has zero need for suffix semantics.
- **Inviolable Invariant:** Even under opaque suffix handling, the complete-record count invariant (`<USER_REQUEST>` count === 1 and `</USER_REQUEST>` count === 1) strictly applies across the entire array of `rawLines`. Therefore, opaque suffix content cannot smuggle an additional opening or closing wrapper tag.
- **No Authority Smuggling:** Content after the unique `</USER_REQUEST>` line must never:
  - Establish a dispatch boundary.
  - Repair an otherwise malformed boundary.
  - Override dispatch JSON.
  - Create contradiction authority.
  - Create foreign-dispatch authority.

---

## 8. Directive-Content Fail-Closed Semantics

If the user's directive content itself produces a physical line strictly equal to:
```text
<USER_REQUEST>
```
or:
```text
</USER_REQUEST>
```
such that the complete-record count of either token exceeds 1, the provider-wrapped record **fails closed** (`isCandidate: false`).

- **Intentional Design Decision:** This is completely intentional. The classifier will NOT attempt nested parsing, heuristic XML tag pairing, or fuzzy guesses as to which tag "belongs" to the provider versus the directive text.
- **Security Guarantee:** Ambiguous wrapper structure immediately yields a non-authoritative candidate. It will not be recognized as a valid boundary. Dispatch acknowledgement will time out into `DISPATCH_UNCERTAIN` rather than misinterpreting corrupted boundaries. No resend will occur.

---

## 9. Anti-Relaxation Guarantees (WA-047 Preservation)

The existing `WA-047` invariant ("fail-closed dispatch boundary candidate check rejects non-dispatch records") remains strictly preserved. Under no circumstances will the implementation use:
- `trimStart()` or `trim()` on lines to overlook whitespace.
- Forward searches (`indexOf('[ORCHESTRATOR_DISPATCH_V1]')`, `search()`, regex scanning across lines).
- Arbitrary prefix skipping or blank-line tolerance.
- Generic XML/HTML tag stripping.

### Non-Authoritative / Rejected Examples
All of the following MUST evaluate to `{ isCandidate: false }`:
- `" " + envelope` (leading whitespace before marker or tag).
- `"\n" + envelope` (leading empty line before tag or marker).
- `"NOTE:\n" + envelope` (arbitrary prose prefix).
- `"prefix\n<USER_REQUEST>\n..."` (prose preceding wrapper).
- `"<UNKNOWN>\n[ORCHESTRATOR_DISPATCH_V1]\n..."` (unrecognized wrapper tag).
- `"<USER_REQUEST> extra text\n[ORCHESTRATOR_DISPATCH_V1]\n..."` (non-exact opening tag).
- `"<USER_REQUEST>\n<USER_REQUEST>\n..."` (nested/duplicate opening wrappers).
- `"<USER_REQUEST>\n[ORCHESTRATOR_DISPATCH_V1]\n{...}"` with no closing `</USER_REQUEST>`.
- Multiple `</USER_REQUEST>` lines anywhere in the record.
- Marker appearing at physical line 2 or later when line 0 is not `<USER_REQUEST>`.
- Marker and control JSON located entirely in the post-close suffix.

---

## 10. Contradiction Semantics Inside Valid Framing

If a record satisfies either the unwrapped or the wrapped framing grammar and its parsed control object claims the current `dispatch_id` (`dObj.dispatch_id === expected.dispatch_id`), it is subjected to exact identity verification:
```javascript
const contradictions = [];
if (dObj.type !== 'worker_dispatch') contradictions.push(...);
if (dObj.schema_version !== 1) contradictions.push(...);
if (dObj.project_id !== expected.project_id) contradictions.push(...);
if (dObj.work_order_id !== expected.work_order_id) contradictions.push(...);
if (expected.expected_workspace_state_id !== undefined && 
    dObj.expected_workspace_state_id !== expected.expected_workspace_state_id) contradictions.push(...);
```
- If any contradiction exists:
  - Return `{ isCandidate: true, isContradiction: true, error: ... }`.
  - Dispatch ACK polling halts immediately.
  - Dispatch transitions to `DISPATCH_UNCERTAIN`.
  - Resends are permanently forbidden.
- Wrapper support does NOT degrade contradictions into missing boundaries or foreign history.

---

## 11. Duplicate Current-Boundary Semantics

Wrapped and unwrapped forms represent the same boundary authority.
- If a scan encounters:
  - 2 unwrapped exact boundaries, OR
  - 2 wrapped exact boundaries, OR
  - 1 unwrapped exact boundary + 1 wrapped exact boundary
- The outcome is identical:
  - `exactCount > 1` -> Immediate rejection.
  - Dispatch ACK fails with `"Duplicate current dispatch boundary records observed"`.
  - Active wait fails with `PROVENANCE_AMBIGUOUS`.
- There is zero precedence between representations.

---

## 12. Wait Contract and Parser Parity

`workerPort.wait()` currently calls `classifyDispatchBoundaryRecord()` at lines 468-489:
```javascript
const classification = classifyDispatchBoundaryRecord(record, {
  project_id,
  work_order_id,
  dispatch_id,
  expected_workspace_state_id
});
```
Because both `dispatchWorker()` and `waitWorker()` rely on the exact same function, extending `classifyDispatchBoundaryRecord()` guarantees 100% boundary interpretation parity across dispatch acknowledgement and wait provenance verification.
- `wait()` will never diverge from dispatch ACK.
- After a wrapped boundary is accepted by dispatch ACK, `wait()` will successfully rediscover that exact same boundary upon re-scanning the transcript.

---

## 13. Completion Record Scope Decision

Inspection of `worker-adapter.js` (lines 491-550) establishes that completion records require:
- `record.source === 'MODEL'`
- `record.type === 'PLANNER_RESPONSE'`
- `record.status === 'DONE'`
- Standalone `[ORCHESTRATOR_COMPLETION_V1]` marker outside markdown fences and blockquotes.

No evidence from the inspected P3 runtime requires `USER_REQUEST` framing support for `MODEL` / `PLANNER_RESPONSE` completion records. The native provider framing `<USER_REQUEST>` applies to user prompt inputs (`USER_EXPLICIT` / `USER_INPUT`).

**Sealed Decision:**
```text
COMPLETION_CLASSIFIER_CHANGE: NOT REQUIRED
```
The completion classifier remains completely untouched.

---

## 14. Proposed Implementation Scope

### Minimal File Set for Future Implementation
1. `pipeline-ui/lib/broker/worker-adapter.js`
   - Update `classifyDispatchBoundaryRecord()` to support the sealed grammar (unwrapped + exact wrapped with strict counts and opaque suffix support).
2. `pipeline-ui/test/refactor/worker-adapter.test.js`
   - Add deterministic unit test coverage for TF-001..TF-019 and update ACK tests.
3. `docs/refactor-v4-native-codex-relay/07-WORKER-ADAPTER-CONTRACT.md`
   - Document the dual-envelope boundary contract.
4. `docs/refactor-v4-native-codex-relay/15-IMPLEMENTATION-PLAN.md`
   - Update progress tracking upon completion of implementation work order.

### Strictly Protected Files (Must NOT Be Modified)
- `pipeline-ui/lib/broker/antigravity-completion-source.js`
- `pipeline-ui/lib/broker/broker.js`
- `pipeline-ui/lib/broker/contracts.js`
- `pipeline-ui/lib/broker/runtime.js`
- `pipeline-ui/lib/broker/sqlite-lifecycle-store.js`
- `pipeline-ui/lib/relay/one-shot-cycle.js`

---

## 15. Required Future Test Matrix

Deterministic unit tests to be implemented in `worker-adapter.test.js`:

| Test ID | Scenario | Expected Outcome |
|---|---|---|
| `TF-001` | Canonical unwrapped exact boundary | `isExact: true`, `isCandidate: true` |
| `TF-002` | Exact provider-wrapped boundary with unique opening at line 0, marker at line 1, control JSON at line 2, unique closing at K >= 3, and allowed provider suffix after K | `isExact: true`, `isCandidate: true` |
| `TF-003` | Provider-wrapped current dispatch with mismatched `work_order_id` or `state_id` | `isContradiction: true`, `isCandidate: true` |
| `TF-004` | Arbitrary prose preceding unwrapped marker (`"Prefix\n[ORCHESTRATOR_DISPATCH_V1]"`) | `isCandidate: false` |
| `TF-005` | Leading whitespace before `<USER_REQUEST>` or marker | `isCandidate: false` |
| `TF-006` | Unrecognized wrapper tag (e.g. `<SYSTEM_PROMPT>`, `<CUSTOM_WRAPPER>`) | `isCandidate: false` |
| `TF-007` | Malformed wrapper (missing closing tag, non-exact opening tag) | `isCandidate: false` |
| `TF-008` | Two wrapped exact boundaries for same current dispatch | ACK returns duplicate boundary error |
| `TF-009` | One unwrapped exact + one wrapped exact boundary for same current dispatch | ACK returns duplicate boundary error |
| `TF-010` | Foreign dispatch ID enclosed in valid provider wrapper | `isForeign: true`, `isCandidate: true` |
| `TF-011` | Dispatch ACK observes valid wrapped boundary in mock transcript | Emits exactly 1 AO send, returns `DISPATCH_ACCEPTED` |
| `TF-012` | Wait rediscovery on session containing valid wrapped boundary | Discovers boundary, successfully parses subsequent completion |
| `TF-013` | Wait on session with missing/malformed wrapper boundary | Yields `PROVENANCE_AMBIGUOUS` |
| `TF-014` | Completion classifier rejection of fenced code / blockquotes | Semantic behavior unchanged |
| `TF-015` | P3 Record-64 structural fixture: line 0 `<USER_REQUEST>`, line 1 marker, line 2 exact synthetic control JSON, unique closing `</USER_REQUEST>`, synthetic `<ADDITIONAL_METADATA>` suffix, no real directive prose | `isCandidate: true`, `isExact: true` |
| `TF-016` | Second `<USER_REQUEST>` physical line in record | `isCandidate: false` (rejected by count check) |
| `TF-017` | Second `</USER_REQUEST>` physical line in record | `isCandidate: false` (rejected by count check) |
| `TF-018` | Valid wrapped boundary + opaque post-close provider metadata | `isExact: true`, `isCandidate: true` |
| `TF-019` | Marker / control JSON located only after closing wrapper | `isCandidate: false` (no authority in suffix) |

Existing test suite `WA-047` and all baseline worker-adapter tests must continue to pass.

---

## 16. Real-Acceptance Policy After Fix

1. **Retirement of P3:**
   - Cycle P3 was executed once under `WO-V4-09C-P3` and resulted in `EXECUTED_NOT_FULL_PASS`.
   - Dispatch `D-a08ac318-2e3b-4f3a-9c8f-07e89e58da7a` was reconciled to `PROVENANCE_AMBIGUOUS` under `WO-V4-09C-P3-RC`.
   - The P3 execution guard at `%TEMP%\wp-v4-09c-p3-real-cycle.executed.guard` remains permanently in place.
   - P3 retry is **strictly forbidden**.
2. **Future Acceptance Requirements:**
   - Any future real-cycle acceptance must be separately authorized under a new work order.
   - It must generate fresh runtime identities:
     - New phase identifier (e.g. P4).
     - New `audit_subject_id`.
     - New worker `work_order_id`.
     - New dedicated execution guard.
     - Fresh broker-generated `dispatch_id`.
   - No future acceptance may be started or executed under this work order.

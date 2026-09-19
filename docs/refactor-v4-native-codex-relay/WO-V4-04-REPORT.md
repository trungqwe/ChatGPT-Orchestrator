# WORK ORDER WO-V4-04 REPORT

## AUDITDECISIONV1 — STRUCTURED SEMANTIC AUTHORITY CONTRACT

---

### 1. Baseline

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Approved Parent Commit**: `70e710be9413dd2d0eebb797827071604eb7bfd6`
- **Parent Work Package**: `WP-V4-03` (Transport foundation & real App Server runtime acceptance; WO-V4-03BR lazy rollout reclassification approved).
- **Target Branch**: `review/v4-wp04-audit-decision-v1`
- **Work Package Under Execution**: `WP-V4-04: STARTING → COMPLETE`
- **Work Package Not Started**: `WP-V4-05: NOT STARTED`
- **Guiding Principles**:
  - `MODEL OUTPUT IS UNTRUSTED UNTIL VALIDATED`
  - `SCHEMA-VALID OUTPUT ≠ FRESH WORKSPACE AUTHORITY`
  - Relay must never obtain lifecycle authority by parsing prose, regex, markdown blocks, or trailing heuristic matches.
  - Pure semantic contract module: zero side-effects, zero real model turns, zero Registry writes, zero worker dispatch calls.

---

### 2. AuditDecisionV1 Shape

The canonical shape of `AuditDecisionV1` is deterministic and rigid. It contains exactly 11 top-level keys with `additionalProperties: false`:

```json
{
  "schema_version": 1,
  "decision": "DISPATCH_WORKER",
  "project_id": "project-id",
  "audit_subject_id": "subject-id",
  "auditor_thread_id": "opaque-thread-id",
  "workspace_state_observed": "workspace-state-id",
  "summary": "Concise decision summary",
  "independent_verification": [
    {
      "kind": "SOURCE_INSPECTION",
      "result": "PASS",
      "evidence": "Inspected exact source/diff..."
    }
  ],
  "work_order": {
    "work_order_id": "wo-123",
    "directive": "Worker implementation directive",
    "verification": [
      "Run exact deterministic verification..."
    ],
    "worker_model_policy": "worker_standard"
  },
  "requested_evidence": [],
  "blocker": null
}
```

- **Allowlist of Decisions**: Exactly `DISPATCH_WORKER`, `REQUEST_EVIDENCE`, `APPROVE_WORK_PACKAGE`, `BLOCKED`, `STOP`. No aliases, no lowercase compatibility, no free-form strings.
- **Schema Version**: Exactly integer `1`. Rejects `"1"`, `0`, `2`, `null`.
- **Top-Level Keys**: Exactly 11 keys required. Extra keys (e.g. `reasoning`, `confidence`, `action`, `command`) reject fail-closed.
- **Always-Present Branch Fields**: `work_order` (object | null), `requested_evidence` (array), and `blocker` (string | null) are always present in the payload.

---

### 3. Exact Context Binding

Every validation operation requires exact trusted context provided by the orchestrator relay:
- `project_id`: which registered project is being audited.
- `audit_subject_id`: opaque exact subject currently under audit (e.g., work package ID or task ID; protocol does not depend on `WP-*` format).
- `auditor_thread_id`: exact current Codex thread ID.
- `workspace_state_observed`: exact workspace snapshot ID supplied to this audit turn.

**Validation Rules**:
- Exact byte-for-byte string equality against trusted expected context.
- No trimming before/after validation.
- No case folding.
- No Unicode normalization.
- No prefix matching.
- Any discrepancy immediately throws `AUDIT_DECISION_CONTEXT_MISMATCH`.

---

### 4. Output Schema Factory

The function `buildAuditDecisionV1OutputSchema(expectedContext)` generates a provider-compatible JSON Schema:
- Identity fields (`project_id`, `audit_subject_id`, `auditor_thread_id`, `workspace_state_observed`) are embedded directly into the schema using single-value enums (`enum: [expectedValue]`).
- `schema_version` is embedded via `enum: [1]`.
- Decision allowlist is embedded via `enum: ["DISPATCH_WORKER", "REQUEST_EVIDENCE", "APPROVE_WORK_PACKAGE", "BLOCKED", "STOP"]`.
- `additionalProperties: false` is declared at every object level.
- Single fixed top-level shape: avoids complex conditional keywords (`if/then/else`, `dynamicRef`, custom keywords) to maximize structured-output compatibility across providers.
- **Defensive Schema Immutability**: Schema output is deeply cloned on return. Mutation of a returned schema cannot alter exported constants or future schemas.
- **Defense in Depth**: Local validator does not assume provider structured output enforcement is sufficient; local validation repeats all structural, context, and branch checks.

---

### 5. Strict JSON Parsing

The module implements a strict recursive-descent JSON parser (`parseStrictJson`) using only the Node standard library:
- Maximum raw UTF-8 byte size bound: 128 KiB. Oversized input rejects with `AUDIT_DECISION_TOO_LARGE`.
- Whitespace handling: Leading and trailing JSON whitespace (`\x20`, `\x09`, `\x0A`, `\x0D`) is permitted.
- Rejection of non-JSON text: Markdown fences (` ```json `), prefix prose, suffix prose, trailing commas, or multiple JSON documents are strictly rejected with `AUDIT_DECISION_INVALID_JSON`.
- No prose fallback or JSON repair logic is permitted.

---

### 6. Duplicate-Key Protection

Standard JavaScript `JSON.parse` silently uses "last-key-wins" behavior. Under a security authority contract, duplicate keys could allow malicious payloads to bypass validation.
- `parseStrictJson` tracks property keys at every object nesting level during lexical analysis.
- If any object contains a duplicate key name (e.g. `{"decision": "BLOCKED", "decision": "APPROVE_WORK_PACKAGE"}`), the parser immediately aborts with `AUDIT_DECISION_DUPLICATE_KEY`.
- Tested across top-level and deeply nested structures (AD-058, AD-059).

---

### 7. Branch Semantics

Decision branch rules are strictly enforced by `validateAuditDecisionV1`:

| Decision | `work_order` | `requested_evidence` | `blocker` | Verification Invariant | Error on Violation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `DISPATCH_WORKER` | `object` | `[]` (length == 0) | `null` | 1 .. 32 items | `AUDIT_DECISION_BRANCH_INVALID` |
| `REQUEST_EVIDENCE` | `null` | `length >= 1` | `null` | 1 .. 32 items | `AUDIT_DECISION_BRANCH_INVALID` |
| `APPROVE_WORK_PACKAGE` | `null` | `[]` (length == 0) | `null` | **All** results == `PASS` | `AUDIT_DECISION_BRANCH_INVALID` |
| `BLOCKED` | `null` | `[]` (length == 0) | `non-empty string` | 1 .. 32 items | `AUDIT_DECISION_BRANCH_INVALID` |
| `STOP` | `null` | `[]` (length == 0) | `null` | 1 .. 32 items | `AUDIT_DECISION_BRANCH_INVALID` |

For `APPROVE_WORK_PACKAGE`, any `independent_verification` item with `result == 'FAIL'` or `result == 'INCONCLUSIVE'` immediately causes validation to fail-closed.

---

### 8. Independent Verification Contract

Verification items are strict objects rather than arbitrary strings:
- **Keys**: Exactly `kind`, `result`, `evidence`. `additionalProperties: false`.
- **Allowed Kinds**: `SOURCE_INSPECTION`, `DIFF_INSPECTION`, `TEST_EXECUTION`, `PROVENANCE_CHECK`, `WORKSPACE_FRESHNESS`, `RUNTIME_EVIDENCE`, `OTHER`.
- **Allowed Results**: `PASS`, `FAIL`, `INCONCLUSIVE`. No numeric scores, percentages, or confidence floats.
- **Evidence String**: Non-empty, UTF-8 byte length ≤ 4096 (4 KiB), control characters forbidden.
- **Item Count Bounds**: Minimum 1, maximum 32 items.

---

### 9. Terminal Turn Authority

`extractAuditDecisionV1FromTurn(turn, expectedContext)` enforces:
- **Turn Status**: Must be `completed`. Turns with `inProgress`, `interrupted`, or `failed` are rejected with `AUDIT_DECISION_TURN_NOT_COMPLETED`.
- **Turn Items View**: Must be `itemsView === 'full'`. Partial snapshots (`notLoaded`, `summary`) are rejected with `AUDIT_DECISION_ITEMS_INCOMPLETE`.
- **Turn ID**: Retains lifecycle authority outside the decision payload; caller supplies expected turn separately.

---

### 10. Agent Message Selection

Message extraction follows strict filtering rules:
1. Filter `turn.items` to items where `item.type === 'agentMessage'`. Non-agent items (`reasoning`, `plan`, `commandExecution`, `fileChange`, `mcpToolCall`, `userMessage`) are completely ignored.
2. Filter for items with `phase === 'final_answer'`:
   - If exactly 1 message has `phase === 'final_answer'`, it is selected as the decision carrier.
   - If > 1 message has `phase === 'final_answer'`, fail with `AUDIT_DECISION_OUTPUT_AMBIGUOUS`.
3. If 0 messages have `phase === 'final_answer'`:
   - Explicit `phase === 'commentary'` messages are ignored (commentary is NEVER decision authority).
   - Agent messages with `phase === null || phase === undefined` are evaluated:
     - If exactly 1 exists: selected for backward/legacy compatibility.
     - If 0 exist: fail with `AUDIT_DECISION_OUTPUT_MISSING`.
     - If > 1 exist: fail with `AUDIT_DECISION_OUTPUT_AMBIGUOUS`.

---

### 11. Workspace Freshness Boundary

- `decision.workspace_state_observed` matching `expectedContext.workspace_state_observed` proves only that the auditor observed the snapshot provided to it.
- **WP-V4-04 does not recompute current workspace.**
- Before any side effect (e.g., worker dispatch or work package approval), future relay action gates must freshly recompute workspace state and compare it against observed state immediately before execution. If stale, the action must fail-closed with `STALE_AUDIT_STATE`.

---

### 12. Negative Tests

78 test cases were implemented in `pipeline-ui/test/refactor/audit-decision.test.js` (exceeding the target of 60):
- **AD-001 .. AD-005**: Positive valid decision parsing and validation for all 5 branches.
- **AD-006 .. AD-010**: Non-object, schema_version mismatch, unknown decision, missing top-level keys, extra top-level keys.
- **AD-011 .. AD-016**: Context identity mismatches (project, subject, thread, workspace_state, case/whitespace variations, invalid context).
- **AD-017 .. AD-033**: Branch semantics violations (work_order missing on dispatch, present on non-dispatch, requested_evidence empty on request_evidence, present on other branches, blocker on wrong branches, missing on blocked, approve with FAIL, approve with INCONCLUSIVE).
- **AD-034 .. AD-036**: Summary bounds (empty, whitespace, > 8 KiB, control characters).
- **AD-037 .. AD-042**: Verification array bounds, invalid keys, invalid kinds, invalid results, evidence string bounds.
- **AD-043 .. AD-048**: Work order schema bounds, work_order_id bounds, directive bounds (> 64 KiB), verification bounds, worker_model_policy reject concrete model names.
- **AD-049 .. AD-051**: Requested evidence bounds (> 32 items, > 4 KiB), blocker string bounds (> 8 KiB).
- **AD-052 .. AD-061**: Raw JSON parsing negatives (raw size > 128 KiB, syntax errors, markdown fences, prefix/suffix prose, multiple docs, duplicate top-level keys, duplicate nested keys, trailing commas, whitespace handling).
- **AD-062 .. AD-064**: Output schema exact context binding, schema immutability/isolation, validated output deep freeze immutability.
- **AD-065 .. AD-073**: Turn extraction negatives (turn status != completed, itemsView != full, non-agentMessage items, phase selection, ambiguous final_answers, ambiguous unknown-phase messages, missing agent messages).
- **AD-074 .. AD-077**: `awaitAuditDecisionV1` integration tests (thread ID mismatch pre-wait, interrupted/failed turns, full fake App Server end-to-end extraction, outputSchema forwarding through startTurn).
- **AD-078**: Prompt injection resistance (payloads attempting project identity override or forced approval fail-closed).

---

### 13. Full Regression Evidence

All 11 deterministic test suites passed with exit code 0:
1. `legacy-auditor-quarantine.test.js`: PASS
2. `native-transition.test.js`: PASS
3. `agent-broker-cli.test.js`: CLI-001..CLI-050: 50/50 PASS
4. `sqlite-lifecycle-store.test.js`: SL-001..SL-047: 47/47 PASS
5. `broker-core.test.js`: BC-001..BC-052: 52/52 PASS
6. `worker-adapter.test.js`: WA-001..WA-055: 55/55 PASS
7. `workspace-state.test.js`: WS-001..WS-051: 51/51 PASS
8. `registry.test.js`: RG-001..RG-039: 39/39 PASS
9. `registry-v2-migration.test.js`: RV2-001..RV2-052: 52/52 PASS
10. `codex-app-server-client.test.js`: CAS-001..CAS-084: 84/84 PASS
11. `audit-decision.test.js`: AD-001..AD-110: 110/110 PASS

---

### 14. Security

- **No Prose Authority**: Prose, markdown code blocks, and heuristic keyword extraction are completely eliminated from lifecycle decisions.
- **Duplicate-Key Rejection**: Eliminates JavaScript's "last-key-wins" parser override vulnerability.
- **Bounded Diagnostics**: Error messages include safe field path indicators and bounded summaries; raw LLM payloads, large directives, and malformed strings are never dumped into error logs.
- **Deep Freeze Immutability**: Validated decision objects and their nested children are recursively frozen (`Object.freeze`), preventing runtime tampering after validation.
- **Zero External Dependencies**: Implemented strictly with Node standard library; zero npm attack surface expansion.

---

### 15. Scope Compliance

- Production module created: `pipeline-ui/lib/relay/audit-decision.js` (sole allowed production file).
- No forbidden production files modified (`codex-app-server-client.js`, `codex-auditor-adapter.js`, broker, registry-v2-migrate, desktop-main, server, public files untouched).
- Test fixture updated safely: `pipeline-ui/test/fixtures/fake-codex-app-server.js` (supported structured turn snapshots under explicit test scenarios; no `_testHook` production parameter leaks).
- Real Codex operations during WP04:
  - Real Codex thread created: **NO**
  - Real Codex turn started: **NO**
  - Real Codex review started: **NO**
  - Real Registry modified: **NO**
  - Real worker dispatch: **NO**
- WP-V4-05 started: **NO**

---

### 16. Recommendation

`WP-V4-04` has met all quality gates, architectural invariants, and negative test requirements. The structured semantic authority contract `AuditDecisionV1` is fully verified and ready for external review.

**Status**: `READY_FOR_WP_V4_04_SEAL_EXTERNAL_REVIEW`

---

### 17. External Review Correction (WO-V4-04F)

- **Original implementation report claim**:
  LOCAL WORKER CLAIM (`Bounded Diagnostics: PASS`, `Prototype safety: PASS`)
- **External review**:
  BLOCKED pending WO-V4-04F
- **Findings Identified**:
  - `AD-AUTH-01`: Parser used ordinary object literal `{}` with `obj[key] = val`, causing `__proto__` to invoke internal prototype setter instead of creating own property, potentially evading `additionalProperties` check.
  - `AD-AUTH-02`: Error diagnostics in duplicate keys, extra keys, and context mismatches echoed unvalidated model-controlled keys or actual values without finite bounds. Adapter `waitForTurnCompletion` failure attached raw turn objects.
- **Resolution**:
  Resolved in `WO-V4-04F` via prototype-free `Object.create(null)` representation, `isPlainJsonObject` validation, centralized `MAX_ERROR_MESSAGE_BYTES = 1024`, safe field-only context diagnostics, and full test expansion (AD-001..AD-095).

---

### 18. External Review Final Seal (WO-V4-04G)

- **Blocker Identified**:
  - `AD-AUTH-03`: Inherited required authority field. Top-level required-field presence logic used `!hasOwnProperty.call(value, key) && !(key in value)`, which allowed required fields to be satisfied through prototype chain (e.g. `Object.prototype.blocker = null`).
- **Resolution**:
  - Replaced prototype chain lookups with exact own-property checking (`Object.prototype.hasOwnProperty.call(value, key)` only; no `key in value`).
  - Introduced `inspectPlainJsonDataObject` using `Reflect.ownKeys` to detect and reject symbol properties, non-enumerable hidden properties, and accessor properties (`get`, `set`).
  - Inspected property descriptors prior to property access, ensuring attacker-controlled getters are never executed (counter remains 0).
  - Applied the same own-property and plain JSON data object rules to nested `work_order` and `independent_verification[i]`.
  - Hardened `expectedContext` to plain objects with exact own data properties and no accessors.
  - Expanded test suite to AD-001..AD-110 (110/110 PASS) with strict `Object.prototype` pollution cleanup in `finally` blocks.

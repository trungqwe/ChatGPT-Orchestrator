# AuditDecisionV1 — Structured Semantic Authority Contract

`AuditDecisionV1` defines the strict machine authority contract for Native Codex auditor turn outputs.
The orchestrator relay must never obtain lifecycle authority by parsing prose, markdown, or heuristically matching text.

## 1. Guiding Principles

- **MODEL OUTPUT IS UNTRUSTED UNTIL VALIDATED.**
- **SCHEMA-VALID OUTPUT ≠ FRESH WORKSPACE AUTHORITY.**
- **NO PROSE FALLBACK**: Markdown fences (` ```json `), prefix prose, suffix prose, trailing commas, or multiple JSON documents are strictly rejected.
- **DETERMINISTIC SINGLE SHAPE**: Provider-facing JSON Schema uses a single flat, rigid top-level shape without conditional keywords (`if/then/else`, `dynamicRef`, `anyOf`) to ensure maximum provider structured-output compatibility. Decision-specific branch semantics are validated deterministically on the local relay.
- **EXACT CONTEXT BINDING**: Four identity fields (`project_id`, `audit_subject_id`, `auditor_thread_id`, `workspace_state_observed`) are embedded as single-value enums in the output schema and must match expected context byte-for-byte during local validation.
- **FAIL CLOSED**: Any malformed JSON, duplicate keys, extra/missing properties, schema violation, context mismatch, or branch rule failure immediately rejects the turn as non-authoritative.

---

## 2. Decision Allowlist

Exactly five allowed decision values. No aliases, no lowercase compatibility, no free-form strings:

1. `DISPATCH_WORKER`
2. `REQUEST_EVIDENCE`
3. `APPROVE_WORK_PACKAGE`
4. `BLOCKED`
5. `STOP`

---

## 3. Canonical JSON Structure

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
      "evidence": "Inspected exact source changes..."
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

All 11 top-level keys are **REQUIRED OWN PROPERTIES**. No omission. Inherited replacement via the prototype chain is strictly rejected (`Object.prototype.hasOwnProperty.call(value, key)` is required; `key in value` is forbidden). `additionalProperties: false` is strictly enforced.

Authority objects (top-level, `work_order`, and `independent_verification[i]`) must be plain JSON data objects (`prototype === Object.prototype || prototype === null`) inspected via `Reflect.ownKeys(...)`. Direct inputs containing symbol properties, non-enumerable properties, or accessor properties (`get`, `set`) are rejected fail-closed with `AUDIT_DECISION_SCHEMA_INVALID` without invoking getters.

Trusted `expectedContext` is similarly hardened: must be a plain object (`Object.prototype` or `null` prototype) where the 4 authority fields (`project_id`, `audit_subject_id`, `auditor_thread_id`, `workspace_state_observed`) are own non-accessor string data properties.

---

## 4. Top-Level Field Contracts

| Field | Type | Constraint | Description |
| :--- | :--- | :--- | :--- |
| `schema_version` | integer | Exactly `1` | Numeric integer 1 (not string `"1"`, 0, or 2). |
| `decision` | string | Enum | One of the 5 canonical decisions. |
| `project_id` | string | Exact byte match | Matches `expectedContext.project_id`. |
| `audit_subject_id` | string | Exact byte match | Matches `expectedContext.audit_subject_id`. |
| `auditor_thread_id` | string | Exact byte match | Matches `expectedContext.auditor_thread_id`. |
| `workspace_state_observed` | string | Exact byte match | Matches `expectedContext.workspace_state_observed`. |
| `summary` | string | Non-empty, UTF-8 ≤ 8 KiB | Concise decision narrative (not machine authority). No control characters. |
| `independent_verification` | array | 1 .. 32 items | Structured verification evidence items. |
| `work_order` | object \| null | Strict object or null | Work order directive if dispatching. |
| `requested_evidence` | array | 0 .. 32 strings | Evidence items requested from worker/environment. |
| `blocker` | string \| null | Non-empty (≤ 8 KiB) or null | Description of blocker when blocked. |

---

## 5. Independent Verification Item Contract

Each item in `independent_verification` must be an object with exactly three required keys:

```json
{
  "kind": "SOURCE_INSPECTION",
  "result": "PASS",
  "evidence": "Inspected exact source/diff..."
}
```

- **`kind`**: Exactly one of:
  - `SOURCE_INSPECTION`
  - `DIFF_INSPECTION`
  - `TEST_EXECUTION`
  - `PROVENANCE_CHECK`
  - `WORKSPACE_FRESHNESS`
  - `RUNTIME_EVIDENCE`
  - `OTHER`
- **`result`**: Exactly one of:
  - `PASS`
  - `FAIL`
  - `INCONCLUSIVE`
- **`evidence`**: Non-empty string, UTF-8 byte length ≤ 4096 (4 KiB). Allows standard multi-line whitespace (`\t`, `\n`, `\r`); forbids control characters (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F).
- **`additionalProperties`**: `false`.

---

## 6. Work Order Contract

When `work_order` is an object:

```json
{
  "work_order_id": "opaque-id",
  "directive": "Worker implementation directive",
  "verification": [
    "Run exact deterministic verification..."
  ],
  "worker_model_policy": "worker_standard"
}
```

- **`work_order_id`**: Non-empty string, UTF-8 byte length ≤ 512 bytes. Forbids all control characters (0x00-0x1F, 0x7F). No `WO-` prefix required.
- **`directive`**: Non-empty string, UTF-8 byte length ≤ 65536 (64 KiB). Allows standard multi-line whitespace (`\t`, `\n`, `\r`); forbids control characters (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F).
- **`verification`**: Array of 1 .. 32 non-empty strings, each UTF-8 byte length ≤ 4096 (4 KiB). Allows `\t`, `\n`, `\r`; forbids control characters.
- **`worker_model_policy`**: Exactly `worker_economy` or `worker_standard`. Concrete model names (e.g. `gpt-5`, `gemini`) are forbidden.
- **`additionalProperties`**: `false`.

---

## 7. Branch Semantics Validation

Local validation enforces deterministic branch invariants:

### 7.1. `DISPATCH_WORKER`
- `work_order != null` (must be valid work order object)
- `requested_evidence.length == 0`
- `blocker == null`

### 7.2. `REQUEST_EVIDENCE`
- `work_order == null`
- `requested_evidence.length >= 1`
- `blocker == null`

### 7.3. `APPROVE_WORK_PACKAGE`
- `work_order == null`
- `requested_evidence.length == 0`
- `blocker == null`
- **EVERY** `independent_verification[i].result == 'PASS'`. Any `FAIL` or `INCONCLUSIVE` rejects approval fail-closed.

### 7.4. `BLOCKED`
- `work_order == null`
- `requested_evidence.length == 0`
- `blocker != null` (non-empty string ≤ 8 KiB)

### 7.5. `STOP`
- `work_order == null`
- `requested_evidence.length == 0`
- `blocker == null`
- `summary` carries the stop narrative. `STOP` is not `BLOCKED`.

---

## 8. Provider Output Schema vs Local Validator

1. `buildAuditDecisionV1OutputSchema(expectedContext)` generates a provider-compatible JSON Schema where:
   - `project_id`, `audit_subject_id`, `auditor_thread_id`, and `workspace_state_observed` are locked via `enum: [expectedValue]`.
   - `schema_version` is locked via `enum: [1]`.
   - `decision` is locked via `enum: ["DISPATCH_WORKER", ...]`.
   - All fields are marked `required`.
   - `additionalProperties: false` is declared at each level.
2. Local validation (`parseAuditDecisionV1Text` and `validateAuditDecisionV1`) independently parses the JSON text with duplicate-key detection and revalidates all types, bounds, context values, and branch constraints.
3. Provider structured output schema serves as defense-in-depth; local validation remains the sole final authority.

---

## 9. Error Codes

| Error Code | Meaning |
| :--- | :--- |
| `AUDIT_DECISION_INVALID_JSON` | Syntax error, markdown fences, prefix/suffix prose, multiple docs, or trailing commas. |
| `AUDIT_DECISION_DUPLICATE_KEY` | Duplicate object keys detected at any nesting level. |
| `AUDIT_DECISION_TOO_LARGE` | Raw JSON string exceeds maximum size bound (128 KiB). |
| `AUDIT_DECISION_SCHEMA_INVALID` | Field missing, extra key, type violation, or bounds check failure. |
| `AUDIT_DECISION_CONTEXT_MISMATCH` | Identity field does not byte-for-byte match trusted expected context. |
| `AUDIT_DECISION_BRANCH_INVALID` | Invariant violation for the specific decision branch. |
| `AUDIT_DECISION_TURN_NOT_COMPLETED` | Turn status is not `completed` (e.g. `inProgress`, `interrupted`, `failed`). |
| `AUDIT_DECISION_ITEMS_INCOMPLETE` | Turn `itemsView` is not `full`. |
| `AUDIT_DECISION_OUTPUT_MISSING` | No candidate `agentMessage` found in terminal turn. |
| `AUDIT_DECISION_OUTPUT_AMBIGUOUS` | Multiple `final_answer` or multiple unknown-phase agent messages found. |

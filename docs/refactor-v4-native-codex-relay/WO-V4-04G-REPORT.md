# WORK ORDER WO-V4-04G REPORT

## AUDITDECISIONV1 — OWN-PROPERTY / PLAIN-DATA AUTHORITY FINAL SEAL

---

### 1. Baseline

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Commit**: `1d5d1764961658ed07077ca2e18e689cc43d6176` (`fix(relay): seal AuditDecision JSON authority`)
- **Review Branch**: `review/v4-wp04-audit-decision-v1-seal`
- **Pre-Execution Review State**:
  - WP-V4-04: NOT YET APPROVED
  - 04F Prototype-Free JSON Parser: PASS
  - 04F Bounded Diagnostics: PASS
  - Only Remaining Blocker: `AD-AUTH-03 INHERITED REQUIRED AUTHORITY FIELD`
- **Objective**:
  - Eliminate prototype-chain authority satisfaction across all authority objects (`AuditDecisionV1`, nested `work_order`, nested `independent_verification[i]`, and trusted `expectedContext`).
  - Enforce exact own-property checking (`Object.prototype.hasOwnProperty.call(obj, key)` only; no `key in obj`).
  - Implement plain JSON data object inspection via `Reflect.ownKeys` to reject symbol properties, non-enumerable hidden properties, and accessor properties (`get`, `set`) without executing getters.
  - Prove immunity to `Object.prototype` pollution and verify all 11 deterministic regression suites pass.

---

### 2. AD-AUTH-03 Root Cause

In prior versions of `pipeline-ui/lib/relay/audit-decision.js`, the top-level required property check was implemented as:

```javascript
for (const key of REQUIRED_TOP_LEVEL_KEYS) {
  if (!Object.prototype.hasOwnProperty.call(value, key) && !(key in value)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `AuditDecisionV1 missing required top-level key '${key}'`,
      { path: '$', missing_property: key }
    );
  }
}
```

The clause `&& !(key in value)` caused a critical flaw:
If an unrelated component in the process polluted `Object.prototype` (for instance, `Object.prototype.blocker = null`), then `'blocker' in value` evaluated to `true`, preventing the missing own-property error from being thrown. Consequently, a direct JavaScript object missing its own `blocker` property could inherit the field through the prototype chain and be accepted as authoritative.

In an authority system:
```text
INHERITED FIELD ≠ JSON DECISION FIELD
```

---

### 3. Own-Property Authority Rule

Under WO-V4-04G:
1. Every required field of `AuditDecisionV1` must be an **OWN PROPERTY** of the validated object.
2. The `in` operator (`key in value`) is completely forbidden for authority determination.
3. Checking logic is strictly:
   ```javascript
   if (!Object.prototype.hasOwnProperty.call(value, key)) {
     throw createAuditDecisionError(
       ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
       `AuditDecisionV1 missing required top-level key '${key}'`,
       { path: '$', missing_property: key }
     );
   }
   ```
4. Exactly the 11 required own string properties are permitted at the top-level:
   - `schema_version`
   - `decision`
   - `project_id`
   - `audit_subject_id`
   - `auditor_thread_id`
   - `workspace_state_observed`
   - `summary`
   - `independent_verification`
   - `work_order`
   - `requested_evidence`
   - `blocker`
5. No missing own property, no inherited replacement, and no extra own properties.

---

### 4. Plain JSON Data Objects

The helper function `inspectPlainJsonDataObject(val, path)` was introduced to strictly audit candidate JSON data objects before reading authority fields:

```javascript
function inspectPlainJsonDataObject(val, path = '$') {
  if (!isPlainJsonObject(val)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
      `Value at ${path} must be a plain JSON object`,
      { path }
    );
  }

  const ownKeys = Reflect.ownKeys(val);
  const stringKeys = [];

  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden symbol property at ${path}`,
        { path }
      );
    }

    const desc = Object.getOwnPropertyDescriptor(val, key);
    if (!desc) {
      continue;
    }

    if (desc.get !== undefined || desc.set !== undefined) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden accessor property at ${path}`,
        { path, property: key }
      );
    }

    if (!desc.enumerable) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_SCHEMA_INVALID,
        `AuditDecision contains forbidden non-enumerable property at ${path}`,
        { path, property: key }
      );
    }

    stringKeys.push(key);
  }

  return stringKeys;
}
```

- Prototype constraint: Requires `Object.getPrototypeOf(val) === Object.prototype || Object.getPrototypeOf(val) === null`. Custom prototypes (classes, modified prototypes) fail closed.
- Inventory via `Reflect.ownKeys`: Captures both non-enumerable properties and symbol properties that standard `Object.keys()` silently ignores.

---

### 5. Accessor / Symbol / Hidden Property Handling

1. **Symbol Properties**:
   - JSON does not define symbol keys. Any own symbol property detected on top-level, `work_order`, or `independent_verification[i]` throws `AUDIT_DECISION_SCHEMA_INVALID`.
2. **Non-Enumerable Hidden Properties**:
   - Hidden metadata properties (`enumerable: false`) are rejected fail-closed with `AUDIT_DECISION_SCHEMA_INVALID`.
3. **Accessor Properties Without Getter Invocation**:
   - Authority properties must be ordinary data properties.
   - Any property having `desc.get !== undefined` or `desc.set !== undefined` is rejected with `AUDIT_DECISION_SCHEMA_INVALID`.
   - By inspecting `Object.getOwnPropertyDescriptor(val, key)` before accessing `val[key]`, getter functions are **never executed**.
   - Verified in unit tests: a side-effecting getter with an execution counter remains at exactly `0` after rejection (AD-102, AD-103, AD-104, AD-110).
4. **Nested Structures**:
   - `work_order` must contain exactly the 4 required own string data properties (`work_order_id`, `directive`, `verification`, `worker_model_policy`).
   - `independent_verification[i]` must contain exactly the 3 required own string data properties (`kind`, `result`, `evidence`).

---

### 6. Expected Context Hardening

The trusted context validator `assertExpectedContext(expectedContext)` was hardened:

```javascript
function assertExpectedContext(expectedContext) {
  if (!isPlainJsonObject(expectedContext)) {
    throw createAuditDecisionError(
      ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
      'expectedContext must be a plain object with Object.prototype or null prototype'
    );
  }

  const requiredFields = [
    'project_id',
    'audit_subject_id',
    'auditor_thread_id',
    'workspace_state_observed'
  ];

  for (const field of requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(expectedContext, field)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext missing required own property '${field}'`,
        { field }
      );
    }

    const desc = Object.getOwnPropertyDescriptor(expectedContext, field);
    if (desc && (desc.get !== undefined || desc.set !== undefined)) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext property '${field}' cannot be an accessor`,
        { field }
      );
    }

    const val = expectedContext[field];
    if (typeof val !== 'string' || val.trim().length === 0) {
      throw createAuditDecisionError(
        ERROR_CODES.AUDIT_DECISION_CONTEXT_MISMATCH,
        `expectedContext.${field} must be a non-empty string`,
        { field }
      );
    }
  }
}
```

- Rejects custom prototype contexts (`AUDIT_DECISION_CONTEXT_MISMATCH`).
- Prevents missing context identities from being satisfied via `Object.prototype` (AD-099).
- Prevents accessor properties on context identity fields without invoking getters (AD-110).

---

### 7. Object.prototype Pollution Tests

All pollution tests in `pipeline-ui/test/refactor/audit-decision.test.js` guarantee exact descriptor cleanup in `finally` blocks:

1. **AD-096**: `Object.prototype.blocker = null`; decision missing own `blocker` rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
2. **AD-097**: `Object.prototype.decision = 'STOP'`; decision missing own `decision` rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
3. **AD-098**: `Object.prototype.workspace_state_observed = <expected>`; decision missing own `workspace_state_observed` rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
4. **AD-099**: `Object.prototype.auditor_thread_id = <expected>`; expectedContext missing own `auditor_thread_id` rejects with `AUDIT_DECISION_CONTEXT_MISMATCH`.
5. **AD-100**: Direct decision with own symbol property rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
6. **AD-101 & AD-106**: Direct decision with non-enumerable hidden property rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
7. **AD-102**: Direct decision with getter on `decision` rejects with `AUDIT_DECISION_SCHEMA_INVALID`; getter counter remains `0`.
8. **AD-103**: Nested `work_order` with inherited field or getter rejects; getter counter remains `0`.
9. **AD-104**: Nested `independent_verification[0]` with inherited field or getter rejects; getter counter remains `0`.
10. **AD-105**: Valid decision under unrelated `Object.prototype.unrelatedPollution = 'polluted_value'` validates cleanly to deeply-frozen, detached authority object without copying polluted properties.
11. **AD-107 & AD-108**: Symbol property on `work_order` or `independent_verification[i]` rejects with `AUDIT_DECISION_SCHEMA_INVALID`.
12. **AD-109**: ExpectedContext with custom prototype rejects with `AUDIT_DECISION_CONTEXT_MISMATCH`.
13. **AD-110**: Getter on ExpectedContext authority field rejects with `AUDIT_DECISION_CONTEXT_MISMATCH`; getter counter remains `0`.

---

### 8. AuditDecision Regression Evidence

- Command executed:
  ```bash
  node pipeline-ui/test/refactor/audit-decision.test.js
  ```
- Result:
  ```text
  Starting AuditDecisionV1 test suite (AD-001 .. AD-110)...
  ...
  ======================================================================
  ALL AUDITDECISION TESTS PASSED (AD-001 .. AD-110: 110/110 PASS)
  ======================================================================
  ```
- Count: **110/110 PASS** (minimum requirement was 105; 5 optional recommended tests added).
- Exit Code: `0`

---

### 9. Full Regression Evidence

- Command executed:
  ```bash
  cd pipeline-ui && npm test
  ```
- Result across all 11 deterministic test suites:
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
- Total Default Deterministic Suites: **11**
- Exit Code: `0`

---

### 10. Scope Compliance

- Production code modified:
  - `pipeline-ui/lib/relay/audit-decision.js` (only allowed production file)
- Test code modified:
  - `pipeline-ui/test/refactor/audit-decision.test.js` (only allowed test file)
- Forbidden files untouched:
  - `pipeline-ui/lib/auditor/**`: untouched
  - `pipeline-ui/lib/broker/**`: untouched
  - `pipeline-ui/test/fixtures/**`: untouched
  - `pipeline-ui/package.json`: untouched
  - `pipeline-ui/server.js`: untouched
  - `pipeline-ui/desktop-main.js`: untouched
  - `pipeline-ui/agent-broker-cli.js`: untouched
  - `pipeline-ui/registry-v2-migrate.js`: untouched
- Real Operations Guard:
  - Real Codex thread created: **NO**
  - Real Codex turn started: **NO**
  - Real Registry modified: **NO**
  - Real worker dispatch: **NO**
  - WP-V4-05 started: **NO**

---

### 11. Recommendation

The blocker `AD-AUTH-03` has been completely sealed. The machine authority contract `AuditDecisionV1` now strictly requires exact own data properties, rejects prototype inheritance, rejects symbols, accessors, and non-enumerable properties without getter side-effects, and withstands arbitrary `Object.prototype` pollution.

**Status**: `READY_FOR_WP_V4_04_SEAL_EXTERNAL_REVIEW`

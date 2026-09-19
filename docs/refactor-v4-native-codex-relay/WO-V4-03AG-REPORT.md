# WO-V4-03AG REPORT: Codex App Server — Thread Sandbox Wire Enum Final Seal

## 1. Baseline

- **Repository**: `https://github.com/trungqwe/ChatGPT-Orchestrator`
- **Parent Commit**: `0f266f4ecba26b596157f8aec152064db9efc730` (`fix(auditor): seal stable app-server protocol`)
- **Review Branch**: `review/v4-wp03a-codex-app-server-transport-seal`
- **Objective**: Resolve `CASPROTO-05 THREAD SANDBOX WIRE ENUM CONFUSION` by correcting the wire representation of `thread/start.sandbox` to kebab-case `read-only`, strictly distinguishing it from turn-level camelCase `readOnly` `SandboxPolicy`.

## 2. CASPROTO-05 Root Cause

During the previous corrective (WO-V4-03AF), production code was updated to send:
```json
{
  "sandbox": "readOnly"
}
```
for `thread/start`. This confused two distinct OpenAI Codex App Server protocol types:
1. `ThreadStartParams.sandbox` -> `SandboxMode` (kebab-case: `"read-only"`, `"workspace-write"`, `"danger-full-access"`).
2. `TurnStartParams.sandboxPolicy.type` -> `SandboxPolicy` (camelCase: `"readOnly"`, `"workspaceWrite"`, `"dangerFullAccess"`).

These are separate, non-interchangeable types in the App Server schema.

## 3. SandboxMode vs SandboxPolicy

```text
ThreadStartParams sandbox wire:
read-only

Turn SandboxPolicy read-only type:
readOnly

These are distinct protocol types:
YES
```

- **Thread lifecycle**: Uses `SandboxMode` which is a string union of kebab-case values (`"read-only" | "workspace-write" | "danger-full-access"`).
- **Turn override**: Uses `SandboxPolicy` which is a tagged union with camelCase discriminators (`{ "type": "readOnly", ... } | { "type": "workspaceWrite", ... } | { "type": "dangerFullAccess" }`).
- **WP-V4-03A Policy**: Inherits thread security policy; does not implement turn-level overrides (`TurnStartParams.sandboxPolicy`).

## 4. Production Correction

- In `pipeline-ui/lib/auditor/codex-auditor-adapter.js`:
  - Defined explicit frozen constant:
    ```js
    const THREAD_SANDBOX_MODES = Object.freeze({
      READ_ONLY: 'read-only',
      WORKSPACE_WRITE: 'workspace-write',
      DANGER_FULL_ACCESS: 'danger-full-access'
    });
    ```
  - Exported `THREAD_SANDBOX_MODES` in `module.exports`.
  - Updated `startThread` payload:
    ```js
    const requestParams = {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only'
    };
    ```
  - Maintained security guards rejecting invented boolean fields (`readOnly`, `workspaceWrite`, `dangerFullAccess`).

## 5. Fake Provider Strictness

- In `pipeline-ui/test/fixtures/fake-codex-app-server.js`:
  - Added strict validation for `params.sandbox` in `case 'thread/start':`:
    ```js
    const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
    if (params.sandbox !== undefined && !VALID_SANDBOX_MODES.has(params.sandbox)) {
      writeLine({
        id,
        error: {
          code: -32602,
          message: `Invalid params for thread/start: invalid sandbox mode '${params.sandbox}', expected one of ['read-only', 'workspace-write', 'danger-full-access']`
        }
      });
      return;
    }
    ```
  - Rejects camelCase `readOnly` or any invalid enum with JSON-RPC error `-32602`.

## 6. Generated Schema Evidence

Inspection of locally generated TypeScript schemas (`codex app-server generate-ts`):
- **`v2/ThreadStartParams.ts`**:
  ```typescript
  export type ThreadStartParams = {
    ...
    approvalPolicy?: AskForApproval | null,
    sandbox?: SandboxMode | null,
    ...
  };
  ```
- **`v2/SandboxMode.ts`**:
  ```typescript
  export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
  ```
- **`v2/SandboxPolicy.ts`**:
  ```typescript
  export type SandboxPolicy =
    | { "type": "dangerFullAccess" }
    | { "type": "readOnly", networkAccess: boolean }
    | { "type": "externalSandbox", networkAccess: NetworkAccess }
    | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean, excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean };
  ```

## 7. CAS Evidence

The CAS suite was expanded to **CAS-001..CAS-084**:
- `CAS-061`: thread/start sends sandbox=read-only (PASS)
- `CAS-082`: provider contract snapshot asserts key stable field names including `threadStart.sandbox = 'read-only'` and `turnSandboxPolicyReadOnlyType = 'readOnly'` (PASS)
- `CAS-083`: thread/start never sends camelCase readOnly SandboxMode (PASS)
- `CAS-084`: fake provider rejects wrong thread SandboxMode enum (PASS)

**Result: CAS-001..CAS-084: 84/84 PASS**

## 8. Full Regression Evidence

Full `npm test` executed across all 10 deterministic suites:
- `WP-V4-02A legacy auditor quarantine`: PASS
- `Native transition contract`: PASS
- `CLI-001 .. CLI-050`: 50/50 PASS
- `SL-001 .. SL-047`: 47/47 PASS
- `BC-001 .. BC-052`: 52/52 PASS
- `WA-001 .. WA-055`: 55/55 PASS
- `WS-001 .. WS-051`: 51/51 PASS
- `RG-001 .. RG-039`: 39/39 PASS
- `RV2-001 .. RV2-052`: 52/52 PASS
- `CAS-001 .. CAS-084`: 84/84 PASS

**Overall npm test Exit Code**: 0

## 9. Scope Compliance

```text
Registry production modified:
NO

Broker modified:
NO

Runtime integrated:
NO

Server/UI integrated:
NO

AuditDecision implemented:
NO

Thread persistence implemented:
NO

Model resolver implemented:
NO

Real thread created:
NO

Real turn started:
NO

Real review started:
NO

Real worker dispatch:
NO

WP-V4-03B started:
NO

WP-V4-04 started:
NO
```

## 10. Recommendation

`READY_FOR_WP_V4_03A_SEAL_EXTERNAL_REVIEW`

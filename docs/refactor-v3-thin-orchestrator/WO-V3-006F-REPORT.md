# WO-V3-006F — Final Correctness Closure Report

**Work Order**: WO-V3-006F<br/>
**Status**: COMPLETE<br/>
**Result**: `READY_FOR_WP_V3_06_FINAL_EXTERNAL_REVIEW`<br/>
**Parent Branch**: `review/v3-wp06-semantic-cli`<br/>
**Parent SHA**: `62db0ba06a9c04954b3a4a4b767506c017513b0e`<br/>
**Working Branch**: `review/v3-wp06-semantic-cli-final`<br/>
**Architecture Authority**: `3001dce9e0d010f4b68fc7b061072ec9b30f093d`<br/>

---

## 1. Baseline

WO-V3-006 implemented the thin semantic command-line interface (`agent-broker-cli.js`) and runtime factory (`runtime.js`) for the four authorized commands: `snapshot`, `worker-status`, `worker-dispatch`, and `worker-wait`. External review identified seven correctness blockers (`CLIAUTH-01` through `CLIAUTH-07`) relating to registry option naming, test isolation, real child-process verification, post-open race defense, descriptor identity checking, complete stream reading, and report accuracy.

WO-V3-006F provides complete closure for all seven items while strictly maintaining all approved architectural invariants:
```text
SOL DECIDES
BROKER GUARDS AND ROUTES
ANTIGRAVITY IMPLEMENTS
CLI ONLY TRANSPORTS SEMANTIC OPERATIONS
```

---

## 2. CLIAUTH-01 Registry Runtime Wiring

- **Issue**: `createBrokerRuntime()` forwarded `registryPath: options.registryPath` to `createProjectRegistry()`. The approved `createProjectRegistry` factory in `registry.js` accepts `registryFilePath`, causing custom registry paths to be silently ignored and defaulting to `<home>/.orchestrator/projects.json`.
- **Fix**: In `pipeline-ui/lib/broker/runtime.js`, explicit option mapping is now enforced:
  ```javascript
  const registryFilePath = options.registryPath || options.registryFilePath;
  const registryPort = options.registryPort || createProjectRegistry({
    registryFilePath,
    fs: options.registryFs || options.fs
  });
  ```
- **Verification**: Verified in `CLI-041`. When `registryPath` points to a temporary custom registry, `createBrokerRuntime` initializes strictly against that path, and the default user registry is never consulted or modified.

---

## 3. CLIAUTH-02 Test Isolation

- **Issue**: `createTestEnv` in `agent-broker-cli.test.js` called `createProjectRegistry({ registryPath })`. Because the option was misnamed, tests were writing fixture data (`test-project`) into the user's real default registry `<home>/.orchestrator/projects.json`.
- **Fix**:
  1. `createTestEnv` now passes `createProjectRegistry({ registryFilePath: registryPath })`.
  2. Added mandatory disk verification asserting that `fs.existsSync(registryPath) === true` and that the file contains the fixture project.
  3. All test runtimes and CLI executions operate strictly within per-test temporary directories.

---

## 4. Default Registry Side-Effect Check

A read-only SHA-256 hash check of the default user registry was conducted before and after executing the entire CLI test suite:

- **Default Registry Path**: `C:\Users\Admin\.orchestrator\projects.json`
- **Default Registry Before-Suite SHA-256**: `81ba9a424d66694f80eda66a607af3549ab7e7ab72e1e13229fead84ec9f10ee`
- **Default Registry After-Suite SHA-256**: `81ba9a424d66694f80eda66a607af3549ab7e7ab72e1e13229fead84ec9f10ee`
- **Changed by Corrected Suite**: **`NO`** (Unchanged)

---

## 5. CLIAUTH-03 Production Process Entrypoint

To ensure full production process entrypoint validity without mocking `runCli`:
- **Worker Status Child Process (`CLI-043`)**: Spawns `node --no-warnings pipeline-ui/agent-broker-cli.js worker-status --project-id <fixture>` under an isolated temporary environment (`HOME=<temp>`, `USERPROFILE=<temp>`). Confirmed `exit 0`, valid single-JSON stdout (`worker_state: IDLE`), and completely empty stderr without AO calls.
- **Uncertain Wait Child Process (`CLI-044`)**: Prepopulates a temporary lifecycle SQLite database with a dispatch in `DISPATCH_UNCERTAIN`. Spawns `node --no-warnings pipeline-ui/agent-broker-cli.js worker-wait ...`. Confirmed `exit 6`, valid JSON response (`DISPATCH_UNCERTAIN`), and empty stderr without invoking the worker.

---

## 6. CLIAUTH-04 Post-Open Path Authority

- **Issue**: Previously, if post-open `lstatSync` threw, `statPost` was set to `null` and execution continued.
- **Fix**: In `readAndValidateRequestFile`:
  ```javascript
  let postStat;
  try {
    postStat = fsModule.lstatSync(canonicalFilePath);
  } catch (err) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: `Cannot post-stat request file pathname: ${err.message}`,
      deleteFile: false
    };
  }

  if (
    !statPre || typeof statPre.isFile !== 'function' || !statPre.isFile() ||
    !fdStat || typeof fdStat.isFile !== 'function' || !fdStat.isFile() ||
    !postStat || typeof postStat.isFile !== 'function' || !postStat.isFile()
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file must be a regular file across pre, fd, and post stat checks',
      deleteFile: false
    };
  }
  ```
- **Verification**: Verified in `CLI-045` (post-lstat throws -> `exit 2`, 0 bytes read) and `CLI-046` (post-stat returns non-regular file -> `exit 2`, 0 bytes read).

---

## 7. CLIAUTH-05 Descriptor Identity

- **Issue**: Identity comparison previously checked `if (fstat.ino && statPre.ino && statPost && statPost.ino)` which could skip verification if inodes were unavailable or zero.
- **Fix**: Integrated approved `sameFileIdentity` from `workspace-state.js`:
  ```javascript
  if (!sameFileIdentity(statPre, fdStat) || !sameFileIdentity(fdStat, postStat)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      error: 'Request file descriptor identity does not match pathname identity (pre/fd/post identity mismatch)',
      deleteFile: false
    };
  }
  ```
  `sameFileIdentity` treats missing or non-matching `dev`/`ino` properties as unavailable and fails closed.
- **Verification**: Verified in `CLI-015` (injected mismatched inode swap race) and `CLI-047` (missing descriptor identity fails closed without downgrade).

---

## 8. CLIAUTH-06 Complete FD Reads

- **Issue**: A single `readSync(...)` was assumed to return all file bytes.
- **Fix**: Replaced single read with an explicit read loop verifying `totalBytesRead === fdStat.size`:
  ```javascript
  fileBytes = Buffer.alloc(fdStat.size);
  let totalBytesRead = 0;
  while (totalBytesRead < fdStat.size) {
    const bytesToRead = fdStat.size - totalBytesRead;
    const bytesRead = fsModule.readSync(
      fd,
      fileBytes,
      totalBytesRead,
      bytesToRead,
      null
    );
    if (typeof bytesRead !== 'number' || bytesRead <= 0) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        error: `Premature EOF: expected ${fdStat.size} bytes but only read ${totalBytesRead} bytes`,
        deleteFile: false
      };
    }
    totalBytesRead += bytesRead;
  }
  ```
- **Verification**: Verified in `CLI-048` (chunked 16-byte reads assemble complete payload, exit 0) and `CLI-049` (premature EOF fails closed with `INVALID_REQUEST`, exit 2).

---

## 9. Request-File Security Contract

| Case | Read? | Parsed? | Deleted? | Broker Called? |
|:-----|:-----:|:-------:|:--------:|:--------------:|
| Valid request inside request root | YES | YES | YES | YES |
| Malformed JSON inside request root | YES | NO | YES | NO |
| Path outside broker request root | NO | NO | NO | NO |
| Symlink inside request root | NO | NO | NO | NO |
| Oversized (> 2,359,296 bytes) | NO | NO | NO | NO |
| Invalid UTF-8 bytes | YES | NO | YES | NO |
| Insecure POSIX permissions (0644) | NO | NO | NO | NO |
| File descriptor swap race | NO | NO | NO | NO |
| Post-lstat pathname disappearance | NO | NO | NO | NO |
| Post-lstat non-regular file | NO | NO | NO | NO |
| Descriptor identity unavailable | NO | NO | NO | NO |
| Premature EOF during read | NO | NO | NO | NO |

---

## 10. Actual Request Size Limit

- **Configured Limit**: `LIMITS.MAX_DIRECTIVE_BYTES = 2 * 1024 * 1024` (2 MiB = 2,097,152 bytes).
- **Overhead Allowance**: `256 * 1024` bytes (256 KiB = 262,144 bytes).
- **Exact Numeric Byte Limit (`MAX_REQUEST_FILE_BYTES`)**: **`2,359,296 bytes`** (2.25 MiB).

---

## 11. Fresh-Runtime vs Actual-Process Evidence

- **Fresh-Runtime Evidence (`CLI-006`, `CLI-039`)**: Demonstrates persistence across separately instantiated `createBrokerRuntime` objects within the same Node process sharing a single SQLite database file.
- **Actual Child-Process Evidence (`CLI-043`, `CLI-044`)**: Demonstrates real OS-level process boundary execution where fresh Node processes (`child_process.spawnSync`) start from `pipeline-ui/agent-broker-cli.js`, load isolated home directories, query durable state, emit single JSON objects to stdout, and exit cleanly.

---

## 12. CLI Negative Test Matrix

The extended CLI test suite (`agent-broker-cli.test.js`) verifies all 50 test scenarios:

| Test ID | Scenario | Expected Outcome | Exit Code | Result |
|:--------|:---------|:-----------------|:---------:|:------:|
| `CLI-001` | Snapshot registered project | `ok: true`, valid `workspace_state_id` | `0` | PASS |
| `CLI-002` | Snapshot unknown project | `PROJECT_NOT_FOUND` | `3` | PASS |
| `CLI-003` | Snapshot calls AO | AO transport call count = 0 | `0` | PASS |
| `CLI-004` | Worker status idle | `worker_state: 'IDLE'` | `0` | PASS |
| `CLI-005` | Worker status unknown project | `PROJECT_NOT_FOUND` | `3` | PASS |
| `CLI-006` | Worker status preserves durable state | Reopened runtime reads persisted state | `0` | PASS |
| `CLI-007` | Worker status with deleted project root | Reports durable state without project root | `0` | PASS |
| `CLI-008` | Valid dispatch file | `DISPATCH_ACCEPTED` | `0` | PASS |
| `CLI-009` | Dispatch request consumed | Request file deleted after read | `0` | PASS |
| `CLI-010` | Malformed JSON in request file | `INVALID_REQUEST`, file deleted | `2` | PASS |
| `CLI-011` | Invalid UTF-8 bytes | `INVALID_REQUEST`, file deleted | `2` | PASS |
| `CLI-012` | Oversized request file | `PAYLOAD_TOO_LARGE`, not deleted | `2` | PASS |
| `CLI-013` | Request file outside broker root | Rejected before read, file untouched | `2` | PASS |
| `CLI-014` | Symlink request file | Rejected before open | `2` | PASS |
| `CLI-015` | File descriptor swap race | Rejected fail-closed | `2` | PASS |
| `CLI-016` | Insecure POSIX file permissions (0644) | Rejected before dispatch | `2` | PASS |
| `CLI-017` | Unknown request JSON key | `INVALID_REQUEST` | `2` | PASS |
| `CLI-018` | Raw command request key | `INVALID_REQUEST` (V3-NT-023) | `2` | PASS |
| `CLI-019` | Session override request key | `INVALID_REQUEST` (V3-NT-024) | `2` | PASS |
| `CLI-020` | Shell metacharacters in directive | Parsed verbatim as data, no shell eval | `0` | PASS |
| `CLI-021` | Stale workspace state on dispatch | `STALE_AUDIT_STATE` | `5` | PASS |
| `CLI-022` | Worker busy on parallel work order | `WORKER_BUSY` | `4` | PASS |
| `CLI-023` | Duplicate active WorkOrder conflict | `DUPLICATE_WORK_ORDER_CONFLICT` | `4` | PASS |
| `CLI-024` | Idempotent dispatch replay | `idempotent_replay: true`, 0 second send | `0` | PASS |
| `CLI-025` | Ambiguous worker dispatch result | `DISPATCH_UNCERTAIN` persisted | `6` | PASS |
| `CLI-026` | Wait nonterminal (RUNNING) | `state: 'RUNNING'` | `0` | PASS |
| `CLI-027` | Wait terminal ready | `state: 'READY_FOR_REVIEW'` | `0` | PASS |
| `CLI-028` | Wait provenance ambiguous | `PROVENANCE_AMBIGUOUS` | `7` | PASS |
| `CLI-029` | Wait against DISPATCH_UNCERTAIN | Fails closed, 0 worker calls | `6` | PASS |
| `CLI-030` | Wait dispatch not found | `DISPATCH_NOT_FOUND` | `3` | PASS |
| `CLI-031` | Wait dispatch project mismatch | `DISPATCH_PROJECT_MISMATCH` | `3` | PASS |
| `CLI-032` | Corrupt SQLite lifecycle store | Single JSON error object, never IDLE | `8` | PASS |
| `CLI-033` | Exactly one stdout JSON object | Clean JSON parse, no trailing text | `0` / `2` | PASS |
| `CLI-034` | Handled results stderr empty | Handled failure emits stderr == "" | `2` | PASS |
| `CLI-035` | Unknown CLI flag / positional arg | `INVALID_REQUEST` before DB open | `2` | PASS |
| `CLI-036` | Invalid wait timeout value | `INVALID_REQUEST` | `2` | PASS |
| `CLI-037` | Request file operation mismatch | `INVALID_REQUEST` before broker call | `2` | PASS |
| `CLI-038` | Request file cleanup failure | Result preserved, bounded stderr diagnostic | `0` | PASS |
| `CLI-039` | Cross-runtime dispatch -> status -> wait | Shared SQLite DB across 3 runtimes | `0` | PASS |
| `CLI-040` | Static AST check for execution surfaces | No child_process, shell, exec in CLI | `0` | PASS |
| `CLI-041` | Custom registry path runtime wiring | `createBrokerRuntime` honors custom path | `0` | PASS |
| `CLI-042` | Fixture registry is physically temp | Temp file exists and contains project | `0` | PASS |
| `CLI-043` | Actual process status | Child process worker-status returns IDLE | `0` | PASS |
| `CLI-044` | Actual process uncertain wait | Child process wait returns DISPATCH_UNCERTAIN | `6` | PASS |
| `CLI-045` | Post-lstat pathname disappearance | Post-lstat throws -> fails closed, 0 read | `2` | PASS |
| `CLI-046` | Post path non-regular file | Post-lstat non-regular -> fails closed, 0 read | `2` | PASS |
| `CLI-047` | Descriptor identity unavailable | Missing dev/ino -> fails closed, 0 read | `2` | PASS |
| `CLI-048` | Short read chunks | 16-byte reads reassembled completely | `0` | PASS |
| `CLI-049` | Premature EOF | Incomplete stream fails closed before parse | `2` | PASS |
| `CLI-050` | Default registry unchanged | Default registry hash verified unchanged | `0` | PASS |

---

## 13. Regression Evidence

- `node pipeline-ui/test/refactor/agent-broker-cli.test.js`: **50/50 PASS** (`CLI-001 .. CLI-050`)
- `node pipeline-ui/test/refactor/sqlite-lifecycle-store.test.js`: **47/47 PASS** (`SL-001 .. SL-047`)
- `node pipeline-ui/test/refactor/broker-core.test.js`: **52/52 PASS** (`BC-001 .. BC-052`)
- `node pipeline-ui/test/refactor/worker-adapter.test.js`: **55/55 PASS** (`WA-001 .. WA-055`)
- `node pipeline-ui/test/refactor/workspace-state.test.js`: **51/51 PASS** (`WS-001 .. WS-051`)
- `node pipeline-ui/test/refactor/registry.test.js`: **39/39 PASS** (`RG-001 .. RG-039`)
- `node pipeline-ui/test/refactor/wp01-regression.test.js`: **17/17 PASS** (`L-NT-029 .. L-NT-045`)
- `node pipeline-ui/test/refactor/characterization.test.js`: **PASS** (Invariants enforced; baseline defects deferred)

---

## 14. npm Classification

Ran `npm test` in `pipeline-ui`:
```text
> pipeline-ui@1.0.0 test
> node test/pipeline-api.test.js && node test/closed-loop.test.js

--- Starting Pipeline Portal Automated Tests ---
[TEST] Server listening on http://127.0.0.1:4099
[TEST 1] Testing static UI delivery (GET /)...
✓ PASS: Static UI delivery verified.
[TEST 2] Testing system health status (GET /api/status)...
✓ PASS: Health status verified. AO: offline, ChatGPT: ready, Agy: 1.2.5
[TEST 3] Testing projects API (GET /api/projects)...
❌ TEST FAILED: AssertionError [ERR_ASSERTION]: Found registered project workspace-test
    at runTests (D:\TU_CODE\Orchestrator\pipeline-ui\test\pipeline-api.test.js:72:12)
```
Classification: **`UNCHANGED_PRE_EXISTING_FAILURE`** at `pipeline-api.test.js:72:12`.

---

## 15. Scope Compliance

```text
WP-V3-07 started:
NO

Codex bootstrap:
NO

WP-V3-08 started:
NO

Shadow dispatch:
NO

Real AO implementation directive sent:
NO

broker.js modified:
NO

registry.js modified:
NO

workspace-state.js modified:
NO

worker-adapter.js modified:
NO

sqlite-lifecycle-store.js modified:
NO

server.js modified:
NO

package.json modified:
NO

UI modified:
NO
```

---

## 16. Possible Prior Registry Pollution

Read-only inspection of `<home>/.orchestrator/projects.json` before running the corrected suite revealed:
- **POSSIBLE_PRIOR_CLI_TEST_REGISTRY_POLLUTION**: **`YES`**
- **project_id**: `test-project`
- **project_root**: `C:\Users\Admin\AppData\Local\Temp\broker-cli-test-sIzyHb\cli-039-1789797145122-43\repo`
- **Resembles prior broker-cli-test temp fixture**: `true`
- **Root currently exists on disk**: `false`

Per Section 11 instructions, this entry was NOT automatically removed or repaired to avoid destructive overwrites of potentially legitimate user data. The corrected test suite did not touch or modify this file (SHA-256 remained strictly identical before and after the test run).

---

## 17. Recommendation

All blockers (`CLIAUTH-01` through `CLIAUTH-07`) are resolved:
1. `createBrokerRuntime` passes `registryFilePath` with exact option mapping.
2. CLI test suite uses isolated temporary registries exclusively; default user registry is provably untouched.
3. Actual child-process entrypoint verified for `worker-status` and durable `worker-wait`.
4. Post-open lstat pathname disappearance and non-regular paths fail closed.
5. Exact descriptor identity verified via `sameFileIdentity`.
6. Complete stream read loop implemented with premature EOF rejection.
7. Report figures and broker method names aligned with actual implementation.

Final Status: **`READY_FOR_WP_V3_06_FINAL_EXTERNAL_REVIEW`**.

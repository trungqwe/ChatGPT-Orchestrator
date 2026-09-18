# Stage 1 — Design Lock & Implementation Plan Validation Report

**Repository:** `ChatGPT-Orchestrator`  
**Baseline Commit:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`  
**Stage:** Stage 1 — Plan Validation & Design Lock  
**Production Code Changes:** **NONE (0 lines modified)**  

---

# 1. Repository Baseline

The following baseline properties were captured directly from the local repository:

- **Current Branch:** `main`
- **Current HEAD SHA:** `8b27a567cc7b058c0782e0370dcc295e1a304a79`
- **Working Tree State:** Tracked repository files are 100% clean. The only local additions are the planning documentation suite (`docs/refactor-v2/`) and the root metadata descriptor (`manifest.json`).
- **Submodule State:**
  - `agent-orchestrator`: `e617c48c0b659682745182ec5f344e7fa72ec0cb`
  - `codex-chatgpt-web`: `e0904bc82001f06e06e7f85f564ce760c92bfd79`
- **Baseline Delta:** Exactly `0` commits between the planning baseline and local HEAD. No concurrent commits or divergent branches exist.

---

# 2. Executive Result

```text
READY_FOR_HUMAN_PLAN_APPROVAL
```

### Rationale:
Every assumption, dependency, and defect noted in the audit has been independently verified against the active codebase. All hidden callers (`public/app.js`, `test/pipeline-api.test.js`), missing architecture decisions (untracked content hashing, Windows canonicalization, fallback verification contract, auth delivery), and missing negative tests (NT-021 to NT-024) have been synchronized into the `docs/refactor-v2/` documentation suite. The plan is deterministic, fail-closed, and ready for human sign-off.

---

# 3. Confirmed Findings

### F-01 (CS-001) — Syntax Error in Antigravity Dispatcher
- **File & Line:** [`pipeline-ui/send_to_antigravity.py:61`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/send_to_antigravity.py#L61)
- **Observed Code:** `clean_proj = project_keyword.lower().replace(/[^a-z0-9_-]/, '_') if hasattr(...)`
- **Machine Evidence:** `python -m py_compile pipeline-ui/send_to_antigravity.py` exits with code `1`:
  ```text
  File "pipeline-ui/send_to_antigravity.py", line 61
    clean_proj = project_keyword.lower().replace(/[^a-z0-9_-]/, '_') ...
                                                  ^
  SyntaxError: invalid decimal literal
  ```
- **Impact:** The Python file fails to compile. The background dispatch path for Antigravity Worker is broken in this snapshot.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for resolution in WP-01.

---

### F-02 (CS-002) — Codex Dispatch Sets `verified=True` Without Observing `task_started`
- **File & Line:** [`pipeline-ui/send_to_codex.py:224-228`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/send_to_codex.py#L224-L228)
- **Observed Control Flow:**
  1. `codex queue` executes.
  2. Loop runs up to 2.5s scanning for `task_started`.
  3. If not found within 2.5s, `turn_started` remains `False` and `new_turn_id` is `None`.
  4. Code immediately follows with:
     ```python
     result["success"] = True
     result["verified"] = True
     result["turn_id"] = new_turn_id  # None!
     result["message"] = f"... (xác thực: task_started)!"
     ```
- **Evidence:** Server daemon logs show `turn=null` with `verified=true`.
- **Impact:** Deterministic false-positive verification. Downstream systems cannot distinguish an active turn from an unobserved turn.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for resolution in WP-01.

---

### F-03 (CS-003) — Watcher Returns Stale Previous Report on Timeout
- **File & Line:** [`pipeline-ui/watch_codex_session.py:215-220`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/watch_codex_session.py#L215-L220)
- **Observed Code:**
  ```python
  # Timeout reached: fallback to latest report if available
  fallback = extract_latest_codex_report(project_keyword)
  if fallback.get("success"):
      fallback["timeout_warning"] = True
      return fallback
  ```
- **Impact:** On timeout (180s), if the session contains an earlier completed turn, watcher returns that older report with `success=true`. The test harness in `test_codex_3_rounds.js:108` checked only `success && report_text`, falsely declaring Round 3 a PASS.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for resolution in WP-01.

---

### F-04 (CS-004) — Audit Route Inspects Implementer's Testimony, Not Code
- **File & Line:** [`pipeline-ui/server.js:1910-1985`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L1910-L1985)
- **Observed Flow:**
  - `getProjectLocalContext(projectId)` reads only a 2-level directory tree (first 15 entries per folder) and whitelisted markdown files sliced to 4,500 characters.
  - The prompt provides: (1) Tree, (2) Truncated Docs, (3) WorkerReport.
  - **Zero** source files, **zero** git diffs, **zero** git status outputs, and **zero** machine test outputs are provided to the auditor.
- **Impact:** Reviewer is entirely anchored to the worker's self-reported claims ("con hát mẹ khen").
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; addressed in WP-05, WP-06, WP-08.

---

### F-05 (CS-005) — Missing WorkerReport Synthesizes a Positive Completion Statement
- **File & Line:** [`pipeline-ui/server.js:1935-1936, 1945-1946`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L1935-L1936)
- **Observed Code:**
  ```javascript
  } else {
    effectiveReportText = 'OpenAI Codex Extension Worker báo cáo hoàn thành nhiệm vụ theo roadmap kỹ thuật.';
  }
  ```
- **Impact:** When evidence is completely missing, the system synthesizes a positive claim of completion.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for removal in WP-05/WP-12.

---

### F-06 (CS-006) — Malformed Model Output Defaults to `COMPLETE` if Worker Claimed `testPassed`
- **File & Line:** [`pipeline-ui/server.js:1889-1899`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L1889-L1899)
- **Observed Code:**
  ```javascript
  if (!parsed) {
    const passed = workerReport.testPassed;
    parsed = {
      verdict: passed ? 'COMPLETE' : 'FIX',
      summary: passed ? 'All acceptance criteria and tests passed.' : 'Test execution failed.'
  ```
- **Impact:** Protocol failure (malformed JSON from model) is converted into full milestone completion based on the worker's own claim.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for removal in WP-07/WP-12.

---

### F-07 (CS-007) — Semantic Verdict Laundering into Machine Test Field
- **File & Line:** [`pipeline-ui/server.js:2046`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L2046)
- **Observed Code:**
  ```javascript
  antigravityReport: {
    testPassed: verdict !== 'FIX',
  ```
- **Impact:** A prose conclusion from the LLM is written into a field named `testPassed`, disguising semantic opinion as empirical machine test evidence.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for separation in WP-08/WP-12.

---

### F-08 (CS-008) — Verdict Determination via Brittle Substring Matching
- **File & Line:** [`pipeline-ui/server.js:2008-2017`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L2008-L2017)
- **Observed Code:**
  ```javascript
  if (lowerResp.includes('lỗi') || lowerResp.includes('thất bại') || lowerResp.includes('sửa') || lowerResp.includes('verdict: fix')) {
    verdict = 'FIX';
  }
  ```
- **Impact:** A sentence like *"Worker đã sửa toàn bộ lỗi và hoàn thành xuất sắc"* erroneously triggers `FIX`. Line 2005 also falls back to using the last paragraph as the directive prompt.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for replacement in WP-07/WP-12.

---

### F-09 (CS-009) — Server Omits Explicit Host Parameter
- **File & Line:** [`pipeline-ui/server.js:2571`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L2571)
- **Observed Code:** `const server = app.listen(PORT, () => {`
- **Impact:** Node.js default when host is omitted is unspecified `::` or `0.0.0.0`, potentially binding to external network interfaces rather than strict loopback.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for resolution in WP-02.

---

### F-10 (CS-010) — Unauthenticated Arbitrary Shell Execution Endpoint
- **File & Line:** [`pipeline-ui/server.js:1516-1533`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/server.js#L1516-L1533)
- **Observed Code:**
  ```javascript
  app.post('/api/extract/worktree/:sessionId/test', async (req, res) => {
    const testCommand = req.body.command || 'node test.js';
    const result = await runCmd(testCommand, worktreePath);
  ```
- **Callers Discovered:**
  1. [`pipeline-ui/public/app.js:1614, 1986`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/public/app.js#L1614)
  2. [`pipeline-ui/test/pipeline-api.test.js:120`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/test/pipeline-api.test.js#L120)
- **Impact:** Any client able to send HTTP POST to port 4000 can execute arbitrary shell commands under the user's privilege without authentication.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md` and expanded in `04-IMPLEMENTATION-PLAN.md` (WP-02).

---

### F-11 (CS-011) — "100% Zero-Intrusion" Claim Exceeds Instrumentation
- **File & Line:** [`pipeline-ui/test/test_codex_3_rounds.js:65, 82-85`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/test/test_codex_3_rounds.js#L65)
- **Observed Code:** Samples mouse coordinates at two discrete points (`(x1, y1)` and `(x2, y2)`).
- **Impact:** Does not continuously monitor mouse movement, keyboard events, foreground window changes, clipboard changes, or fullscreen game interaction.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for correction in WP-12.

---

### F-12 (CS-012) — Default Test Script Excludes Multi-Round Integration Tests
- **File & Line:** [`pipeline-ui/package.json:9`](file:///d:/TU_CODE/Orchestrator/pipeline-ui/package.json#L9)
- **Observed Code:** `"test": "node test/pipeline-api.test.js && node test/closed-loop.test.js"`
- **Impact:** `npm test` does not execute `test_codex_3_rounds.js`. The claim of "verified in 3 rounds" is from an ad-hoc test, not the regression test gate.
- **Documentation Status:** Documented in `01-CURRENT-STATE-AUDIT.md`; scheduled for resolution in WP-00/WP-12.

---

# 4. Incorrect / Outdated Documentation Discovered & Corrected

| Document | Section | Initial Statement | Defect / Reason | Corrected Statement in Docs |
| :--- | :--- | :--- | :--- | :--- |
| `04-IMPLEMENTATION-PLAN.md` | WP-02 | Files to touch listed only `server.js` and desktop health probes. | Omitted `public/app.js` and `pipeline-api.test.js`, which actively call `/api/extract/worktree/:sessionId/test`. | Added `public/app.js` and `pipeline-api.test.js` to files to touch; added IPC auth delivery mechanism. |
| `04-IMPLEMENTATION-PLAN.md` | WP-04 | Only mentioned `.orchestrator/verification.json`. | Missing policy for unconfigured projects; would cause permanent `BLOCKED` status. | Added deterministic Default Fallback Verification Contract based on repo manifest (`package.json`, `pyproject.toml`, generic). |
| `04-IMPLEMENTATION-PLAN.md` | WP-06 | Stated target CWD must be added to `runCodexWithPrompt`. | Lacked exact signature and CLI flags (`-C <dir>`, `-s read-only`, child_process `cwd`). | Updated signature to `runCodexWithPrompt(targetModel, promptText, options = {})` passing `-C` and `-s read-only`. |
| `08-AUDIT-SNAPSHOT-PROTOCOL.md` | §3, §8, §11 | Conceptual formula included `canonical_untracked_manifest` without content hashing. | Renaming or mutating untracked file contents would not change the snapshot fingerprint. Also lacked Windows CRLF/slash normalization. | Defined untracked manifest as `relative_path:content_sha256`; added Section 11 for canonical Windows serialization. |
| `10-NEGATIVE-TEST-MATRIX.md` | Matrix | Ended at NT-020. | Missing edge cases: malformed UTF-8, path traversal, killed verifier process, and concurrent audit race conditions. | Added NT-021 (UTF-8), NT-022 (Path Traversal), NT-023 (Killed process), NT-024 (Concurrent Audits). |
| `06-MASTER-CHECKLIST.md` | Checklist | Checklist items did not reflect expanded test matrix or frontend callers. | Reviewer would not be able to verify callers or new negative test cases. | Updated checklist items in Phase 1, Phase 2, Phase 3, Phase 4, and Release Gate. |

---

# 5. Locked Architecture Decisions

The following architecture decisions are explicitly locked:

1. **Snapshot Storage & Lifecycle**:
   - Stored in-memory during active audit execution.
   - Persisted to `.orchestrator/snapshots/<snapshot_id>.json` on audit completion.
   - Cleaned up automatically after 7 days or on project deregistration.
2. **Verification Config Precedence**:
   - Priority 1: Explicit project-level `.orchestrator/verification.json`.
   - Priority 2: Manifest-driven fallback (Node `npm test` / Python `pytest` / Git `git diff --check`).
   - Priority 3: Generic fallback (`git_diff_check`).
3. **Authentication Token Delivery**:
   - Server generates a 32-byte cryptographically secure hex secret on boot (`crypto.randomBytes(32).toString('hex')`).
   - Saved locally to `.orchestrator/auth_token` with restrictive OS permissions (read-only by owner).
   - Delivered to Electron renderer via `preload.js` (`window.orchestratorAuthToken`).
   - Delivered to test runners via `process.env.ORCHESTRATOR_API_TOKEN` or reading `.orchestrator/auth_token`.
4. **Active Inspector Fallback Policy**:
   - Active Inspector requires verified Full Harness, healthy tunnel, valid connector, and target CWD.
   - If health check fails: Fall back explicitly to `audit_capability = "evidence_packet"`.
   - The capability downgrade is permanently recorded in the audit result schema; silent fallback is forbidden.
5. **Concurrency & Lock Ownership**:
   - Single-flight mutex lock per project (`.orchestrator/audit.lock`).
   - Overlapping audit requests receive HTTP `409 Conflict` (`CONCURRENT_AUDIT_REJECTED`).
6. **Schema Versioning**:
   - All machine schemas (`audit-snapshot`, `verification-contract`, `audit-result`) include `"schema_version": 1`.
7. **Migration Compatibility Strategy**:
   - Legacy routes continue operating in Phase 1–5 alongside the new pipeline using feature flags (`ORCH_STRUCTURED_AUDIT=true`).
   - Deprecated routes (`/api/orchestrator/audit`) and unauthenticated endpoints are decommissioned in Phase 6.

---

# 6. Work Package Dependency Review

| WP | Title | Order | Dependencies | Files to Touch | Critical Tests | Risk / Recommendation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **WP-00** | Characterization Tests | 1 | Baseline commit | `pipeline-ui/test/refactor/*`, `pipeline-ui/package.json` | Baseline regression reproduction | **Low risk**. Does not touch production code. |
| **WP-01** | Transport Correctness | 2 | WP-00 | `send_to_antigravity.py`, `send_to_codex.py`, `watch_codex_session.py`, `server.js` | NT-001..004, NT-014, NT-017 | **High priority**. Fixes syntax error and false-positive dispatch. |
| **WP-02** | Security Hardening | 3 | WP-01 | `server.js`, `desktop-main.js`, `preload.js`, `public/app.js`, `test/pipeline-api.test.js` | NT-011, NT-012, NT-013, NT-022 | **Medium risk**. Must update frontend callers in `public/app.js` and test helper. |
| **WP-03** | Snapshot Engine | 4 | WP-01 | `pipeline-ui/lib/audit-snapshot.js` (NEW) | NT-008, NT-009, NT-021 | **Self-contained**. New isolated module with pure unit tests. |
| **WP-04** | Verification Contract | 5 | WP-03 | `pipeline-ui/lib/verification-contract.js` (NEW), `server.js` | NT-005, NT-010, NT-023 | **Medium risk**. Requires fallback policy for unconfigured projects. |
| **WP-05** | Evidence Packet Builder | 6 | WP-03, WP-04 | `pipeline-ui/lib/evidence-packet.js` (NEW), `server.js` | NT-006, NT-018, NT-020 | **Medium risk**. Replaces prompt dumping with structured factual packet. |
| **WP-06** | Active Inspector & CWD | 7 | WP-05 | `pipeline-ui/server.js` | NT-015, NT-016 | **Medium risk**. Adds `-C <dir>` and `-s read-only` to `runCodexWithPrompt`. |
| **WP-07** | Structured Auditor Protocol | 8 | WP-05, WP-06 | `pipeline-ui/lib/audit-schema.js` (NEW), `server.js` | NT-007, NT-019 | **High impact**. Eliminates substring parsing; enforces JSON Schema. |
| **WP-08** | Claim Reconciliation | 9 | WP-07 | `pipeline-ui/server.js`, `pipeline-ui/public/app.js` | NT-005, NT-006 | **Low risk**. Categorizes claims as corroborated, contradicted, or unverified. |
| **WP-09** | Directive Gate | 10 | WP-03, WP-07, WP-08 | `pipeline-ui/server.js` | NT-007, NT-008, NT-009, NT-017, NT-024 | **High impact**. Blocks dispatch on snapshot drift, protocol error, or missing checks. |
| **WP-10** | Negative Regression Suite | 11 | WP-01..WP-09 | `pipeline-ui/test/refactor/negative-suite.test.js` (NEW) | Full NT-001 through NT-024 | **Validation gate**. All 24 negative fault injection tests must pass. |
| **WP-11** | GitHub Checkpoint | 12 | WP-09 | `pipeline-ui/lib/github-checkpoint.js` (NEW), `server.js` | Milestone checkpoint validation | **Low risk**. Milestone-based second-source check. |
| **WP-12** | Cleanup & Deprecation | 13 | WP-10, WP-11 | `pipeline-ui/server.js`, `README.md` | Full regression suite (`npm test`) | **Final cleanup**. Deletes legacy fallback code and claims. |

---

# 7. Revised Roadmap

```text
NO ORDER CHANGE REQUIRED
```

The sequence from Phase 0 through Phase 6 remains strictly ordered:
- **Phase 0:** Plan Approval & Design Lock (WP-00 characterization prep)
- **Phase 1:** Stop False Positives & Critical Security (WP-00, WP-01, WP-02)
- **Phase 2:** Establish Evidence Integrity (WP-03, WP-04, WP-05)
- **Phase 3:** Active Inspector & CWD Authority (WP-06, WP-07, WP-08)
- **Phase 4:** Directive Gate & Negative Regression (WP-09, WP-10)
- **Phase 5:** Milestone GitHub Checkpoint (WP-11)
- **Phase 6:** Legacy Cleanup & Final Verification (WP-12)

---

# 8. Master Checklist (Authoritative Reference)

### Phase 1 — Critical Correctness & Security
- [ ] Add characterization tests reproducing current defects (`test/refactor/characterization.test.js`)
- [ ] Fix Antigravity Python syntax in `send_to_antigravity.py:61`
- [ ] Verify Python compile succeeds: `python -m py_compile pipeline-ui/send_to_antigravity.py`
- [ ] Fix Codex dispatch state semantics (`queued`, `turn_started`, `verified`, `turn_id`)
- [ ] Require observed matching `task_started` before setting `verified=true`
- [ ] Remove stale-report success fallback on timeout in `watch_codex_session.py`
- [ ] Bind report extraction to exact `target_turn_id`
- [ ] Bind Express to explicit loopback `127.0.0.1`
- [ ] Add local auth secret generation and bearer token validation
- [ ] Update `public/app.js` and `pipeline-api.test.js` to send auth token and call semantic check endpoint
- [ ] Remove generic raw command execution from normal API
- [ ] Replace absolute zero-intrusion claims with exact measured properties

### Phase 2 — Evidence Integrity
- [ ] Implement `AuditSnapshot` class in `lib/audit-snapshot.js`
- [ ] Implement canonical fingerprinting (including untracked file content SHA-256 and Windows CRLF/slash normalization)
- [ ] Implement snapshot revalidation before dispatch
- [ ] Implement `VerificationContract` in `lib/verification-contract.js` with manifest-driven fallback
- [ ] Implement allowlisted semantic check runners (`git_diff_check`, `npm_test`, `python_compile`, `pytest`)
- [ ] Bind all machine evidence objects to `snapshot_id`
- [ ] Hash raw stdout/stderr with SHA-256
- [ ] Enforce output bounds and truncation flags
- [ ] Implement `EvidencePacket` builder in `lib/evidence-packet.js`
- [ ] Classify WorkerReport explicitly as `UNTRUSTED_CLAIMS`

### Phase 3 — Active Inspector
- [ ] Pass target CWD as trusted process configuration (`-C <dir>` and child_process `cwd`)
- [ ] Configure read-only auditor sandbox (`-s read-only`)
- [ ] Verify Full Harness health (tunnel, broker, connector) before declaring active capability
- [ ] Detect browser-only mode and declare explicit capability downgrade
- [ ] Support model-driven retrieval (on-demand read/search)
- [ ] Implement JSON Schema validation for audit result (`lib/audit-schema.js`)
- [ ] Enforce fail-closed parsing (no substring matching, no fallback to COMPLETE)
- [ ] Implement claim/evidence reconciliation matrix

### Phase 4 — Directive Gate & Negative Regression
- [ ] Enforce pre-dispatch snapshot revalidation
- [ ] Verify worker idle state before dispatch
- [ ] Verify session and project identity match
- [ ] Reject stale audit results and malformed directives
- [ ] Reject dispatch when mandatory verification checks are missing
- [ ] Run full negative test matrix (NT-001 through NT-024)

### Phase 5 — GitHub Checkpoint
- [ ] Compare local candidate commit SHA with remote pushed SHA at milestone
- [ ] Verify remote diff consistency
- [ ] Ingest remote CI/status checks when configured
- [ ] Persist checkpoint provenance

### Phase 6 — Legacy Cleanup & Release
- [ ] Delete substring verdict parser (`server.js`)
- [ ] Delete last-paragraph directive fallback
- [ ] Delete synthetic positive missing-report fallback
- [ ] Remove/migrate legacy `testPassed` field
- [ ] Register test tiers in `package.json` (`test:unit`, `test:negative`, `test:integration`)
- [ ] Update README architecture and documentation

---

# 9. Invariant & Test Mapping

| Invariant | Finding | Work Package | Negative Test ID | Acceptance Criterion |
| :--- | :--- | :--- | :--- | :--- |
| **INV-001** (Exact-turn provenance) | F-02, F-03 | WP-01 | NT-002, NT-004 | Completion event turn ID must strictly match requested turn ID. |
| **INV-002** (No stale fallback) | F-03 | WP-01 | NT-003 | Watcher timeout returns `success=false`; prior turn report cannot be attributed. |
| **INV-003** (Snapshot identity) | F-04 | WP-03 | NT-008 | Every evidence record and audit result carries identical `snapshot_id`. |
| **INV-004** (No cross-snapshot evidence) | F-04 | WP-03, WP-09 | NT-009 | Mutating working tree during audit invalidates snapshot; directive blocked. |
| **INV-005** (Missing evidence is not positive) | F-05 | WP-04, WP-05 | NT-010, NT-018 | Missing report or missing mandatory check results in `BLOCKED`. |
| **INV-006** (Protocol failure is not pass) | F-06 | WP-07 | NT-007 | Malformed auditor JSON yields `AUDIT_PROTOCOL_ERROR`; no dispatch. |
| **INV-007** (Worker never defines acceptance) | F-04 | WP-04 | NT-005 | Failed required check blocks approval even if worker claims 100% pass. |
| **INV-008** (Verdict is not machine evidence) | F-07 | WP-08 | NT-019 | Verdict conclusions are strictly separated from raw machine exit codes. |
| **INV-009** (Loopback & authenticated) | F-09 | WP-02 | NT-011, NT-012 | Listener binds `127.0.0.1`; requests without bearer token return 401. |
| **INV-010** (No arbitrary shell input) | F-10 | WP-02 | NT-013, NT-022 | Shell execution endpoint accepts only allowlisted semantic check IDs. |
| **INV-011** (Inspector is read-only) | Architecture | WP-06 | NT-016 | Auditor process runs under `-s read-only`; file modification forbidden. |
| **INV-012** (No silent capability downgrade) | Architecture | WP-06 | NT-015 | Unavailable Full Harness explicitly records `evidence_packet` mode. |
| **INV-013** (Dispatch only from structured) | F-08 | WP-07, WP-09 | NT-007, NT-019 | No fallback to last paragraph; directive must be schema-validated. |
| **INV-014** (Recheck immediately before dispatch) | Architecture | WP-09 | NT-009, NT-017 | Mutated tree or busy worker causes dispatch rejection. |
| **INV-015** (Claims match instrumentation) | F-11 | WP-02, WP-12 | NT-014 | Absolute claims removed unless proven by instrumented test suite. |

---

# 10. Security Gate

Before the local control API is declared hardened, the following five criteria must be satisfied:

1. **Strict Loopback Binding**: `server.js` binds explicitly to `127.0.0.1`. Verification test confirms no listener on `0.0.0.0` or external adapters.
2. **Mandatory Local Authentication**: Privileged routes (`/api/orchestrator/*`, `/api/antigravity/dispatch`, `/api/worker/*`, `/api/extract/*`) enforce `Authorization: Bearer <token>` matching `.orchestrator/auth_token`.
3. **Elimination of Arbitrary Shell Execution**: Generic `POST .../test` with `{ command: "..." }` is decommissioned; replaced with semantic `{ check_id: "..." }` resolved by the trusted Verification Contract.
4. **Canonical Path Containment**: All file extraction requests resolve paths via `path.resolve` and verify `safePath.startsWith(projectRoot)` to prevent directory traversal or symlink escapes.
5. **No Shell String Concatenation**: All verifier and helper invocations use `execFile` or argument arrays; untrusted inputs are never interpolated into shell strings.

---

# 11. Stage 1 Remaining Blockers

```text
NONE
```

All architectural, dependency, test matrix, and security ambiguities have been resolved and codified into `docs/refactor-v2/`.

---

# 12. Recommended First Implementation WorkOrder

The following WorkOrder is prepared for the first implementation turn upon human plan approval:

```markdown
# WorkOrder: WO-REFACTOR-001 — Baseline Characterization Tests

## Goal
Freeze baseline commit 8b27a567cc7b058c0782e0370dcc295e1a304a79 and implement characterization tests in `pipeline-ui/test/refactor/characterization.test.js` that reproduce existing false-positive and safety defects without altering production code.

## Base Commit
8b27a567cc7b058c0782e0370dcc295e1a304a79

## Allowed Files to Touch
- `pipeline-ui/test/refactor/characterization.test.js` (NEW)
- `pipeline-ui/package.json` (add `"test:characterization"` script)

## Strictly Forbidden Files
- `pipeline-ui/server.js`
- `pipeline-ui/send_to_antigravity.py`
- `pipeline-ui/send_to_codex.py`
- `pipeline-ui/watch_codex_session.py`
- All other production source code files

## Preconditions
1. Verify `git rev-parse HEAD` equals `8b27a567cc7b058c0782e0370dcc295e1a304a79`.
2. Verify clean git working tree on tracked files (`git status --porcelain`).

## Exact Implementation Steps
1. Create directory `pipeline-ui/test/refactor/`.
2. Implement `characterization.test.js` with isolated test cases demonstrating:
   - Case 1: `send_to_antigravity.py` fails `python -m py_compile` (SyntaxError).
   - Case 2: `send_to_codex.py` control flow returns `verified=true` even when `task_started` is not observed.
   - Case 3: `watch_codex_session.py` returns stale previous report on timeout fallback.
   - Case 4: `server.js` `/api/orchestrator/audit` derives `verdict: COMPLETE` when model JSON is malformed but worker claimed `testPassed: true`.
   - Case 5: `server.js` `/api/extract/worktree/:sessionId/test` executes arbitrary shell strings without token auth.
3. Add script `"test:characterization": "node test/refactor/characterization.test.js"` to `pipeline-ui/package.json`.

## Mandatory Verification Command
```bash
npm run test:characterization
```

## Expected Results
- All 5 characterization tests execute and report the exact defective behaviors currently in the baseline codebase.
- No production files are modified.

## Stop Condition
Produce WorkerReport detailing test results and STOP. Do not begin WP-01.
```

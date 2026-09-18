# Master Refactor Checklist

## Stage 1 — Documentation

- [ ] Current-state audit approved
- [ ] Target architecture approved
- [ ] Trust boundaries approved
- [ ] Implementation plan approved
- [ ] Verification Contract approved
- [ ] Snapshot Protocol approved
- [ ] Audit Result Schema approved
- [ ] Security hardening design approved
- [ ] Negative test matrix approved
- [ ] Migration/rollback design approved

## Phase 1 — Critical correctness/security

- [ ] Add characterization tests
- [ ] Fix Antigravity Python syntax
- [ ] Add Python compile check
- [ ] Fix Codex dispatch state semantics
- [ ] Require observed matching `task_started`
- [ ] Remove stale-report success fallback
- [ ] Bind report to exact turn
- [ ] Bind Express to `127.0.0.1`
- [ ] Add local auth to privileged routes
- [ ] Update `public/app.js` and `pipeline-api.test.js` to send auth token and call semantic check endpoint
- [ ] Remove generic raw command execution from normal API
- [ ] Replace absolute zero-intrusion claims

## Phase 2 — Evidence integrity

- [ ] Implement snapshot object
- [ ] Implement snapshot fingerprint (including untracked file content hashing)
- [ ] Implement revalidation
- [ ] Implement verification config and default fallback resolver
- [ ] Implement allowlisted semantic checks
- [ ] Bind all evidence to snapshot ID
- [ ] Hash raw output
- [ ] Bound/truncate evidence safely
- [ ] Build evidence packet
- [ ] Mark WorkerReport as claim data

## Phase 3 — Active inspector

- [ ] Pass target CWD as trusted process config (`-C` and child_process `cwd`)
- [ ] Use read-only audit sandbox (`-s read-only`)
- [ ] Verify Full Harness health
- [ ] Detect browser-only mode
- [ ] Detect missing tunnel/connector
- [ ] Declare audit capability in result
- [ ] Add model-driven read/search
- [ ] Add structured JSON output
- [ ] Validate schema
- [ ] Add claim/evidence reconciliation

## Phase 4 — Directive gate

- [ ] Validate result before dispatch
- [ ] Revalidate snapshot before dispatch
- [ ] Verify worker idle
- [ ] Verify session/project identity
- [ ] Reject stale result
- [ ] Reject malformed directive
- [ ] Reject missing mandatory evidence
- [ ] Run full negative test matrix (NT-001 through NT-024)

## Phase 5 — GitHub checkpoint

- [ ] Record pushed SHA
- [ ] Compare local/pushed SHA
- [ ] Compare diff at checkpoint
- [ ] Read checks/CI if available
- [ ] Persist checkpoint provenance

## Phase 6 — Cleanup

- [ ] Delete substring verdict parser
- [ ] Delete last-paragraph directive fallback
- [ ] Delete positive missing-report fallback
- [ ] Remove/rename fake `testPassed`
- [ ] Register test tiers in package scripts
- [ ] Update README architecture
- [ ] Update security docs
- [ ] Update operational runbook

## Release gate

- [ ] `npm test`
- [ ] refactor unit tests
- [ ] negative regression tests (NT-001 through NT-024) pass
- [ ] Codex integration tests
- [ ] Antigravity integration tests
- [ ] security tests
- [ ] snapshot race test
- [ ] malformed model output test
- [ ] stale report test
- [ ] user-facing claims reviewed against evidence

# v3 Master Checklist

## Stage 2 design

- [ ] Thin Orchestrator boundary approved
- [ ] Persistent auditor task approved
- [ ] CLI-first broker decision approved or corrected
- [ ] Raw AO direct control rejected as default
- [ ] Registry schema approved
- [ ] Worker lifecycle approved
- [ ] Workspace-state gate approved
- [ ] Security model approved
- [ ] Negative tests approved
- [ ] Migration/deprecation plan approved

## Phase 1 correctness

- [ ] Generic JSON cannot auto-activate exact Codex correlation
- [ ] Target-turn error provenance exact
- [ ] Session-bound diagnostics stay session-bound
- [ ] Legacy stale-report success impossible
- [ ] characterization regression suite passes

## Phase 2 broker

- [ ] broker library independent of Express
- [ ] registry persistent
- [ ] duplicate basenames handled
- [ ] worker session explicit
- [ ] workspace-state deterministic
- [ ] tracked mutation changes state
- [ ] untracked mutation changes state
- [ ] submodule mutation changes state
- [ ] symlink escape safe
- [ ] AO capability probe documented
- [ ] dispatch envelope has work-order/dispatch IDs
- [ ] old completion cannot satisfy active dispatch
- [ ] bounded wait implemented
- [ ] semantic CLI has no arbitrary shell

## Phase 3 auditor

- [ ] dedicated Codex task setup works
- [ ] user-selected Sol model retained
- [ ] Full Harness health verified
- [ ] actual task CWD equals registered project root
- [ ] source read/search works
- [ ] git status/diff works
- [ ] broker snapshot/status callable
- [ ] bootstrap prompt validated
- [ ] auditor source-write policy tested

## Phase 4 live loop

- [ ] dry-run directive succeeds
- [ ] stale workspace dispatch rejected
- [ ] duplicate dispatch rejected
- [ ] real AO dispatch accepted
- [ ] completion binds active dispatch
- [ ] Sol inspects worker diff directly
- [ ] Sol creates next directive
- [ ] bounded wait/resume works
- [ ] pause switch works
- [ ] Orchestrator restart recovery tested
- [ ] Codex/browser turn end recovery documented

## Phase 5 security/cleanup

- [ ] Express loopback-only
- [ ] privileged API protected
- [ ] normal raw-shell route removed
- [ ] path containment tests pass
- [ ] secrets excluded from logs
- [ ] old audit-and-direct disabled
- [ ] substring verdict parser removed
- [ ] missing-report positive fallback removed
- [ ] fake `testPassed` laundering removed
- [ ] old context packer removed or display-only

## Release

- [ ] broker unit tests
- [ ] lifecycle negative tests
- [ ] workspace-state tests
- [ ] AO integration tests
- [ ] Full Harness manual acceptance
- [ ] one-cycle live acceptance
- [ ] multi-cycle resumability acceptance
- [ ] security tests
- [ ] GitHub checkpoint test
- [ ] README architecture updated
- [ ] user-facing claims reviewed

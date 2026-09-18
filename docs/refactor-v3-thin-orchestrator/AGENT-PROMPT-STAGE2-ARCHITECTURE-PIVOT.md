# PROMPT FOR AGENT
## STAGE 2 — THIN ORCHESTRATOR ARCHITECTURE PIVOT REVIEW

Repository:

`ChatGPT-Orchestrator`

New architecture docs:

`docs/refactor-v3-thin-orchestrator/`

Reference used while drafting:

`review/wp01-fix1`
`fde47f853e18d52f80e08dd1ab025685fc73a6db`

This is a **documentation/design validation turn only**.

DO NOT implement production code.

---

# 0. Mission

Independently audit the v3 architecture against:

- actual current repository;
- installed Codex runtime;
- pinned `codex-chatgpt-web` submodule/runtime;
- actual AO/Antigravity integration.

Proposed architecture:

```text
ChatGPT Web Sol High in dedicated Codex Full Harness task
    = architect / auditor

Antigravity
    = implementation worker

ChatGPT-Orchestrator
    = thin deterministic broker
```

Do not assume this proposal is correct.

Attempt to disprove unsupported assumptions, repair documentation and make the implementation plan deterministic enough for a weak implementation agent.

---

# 1. Hard scope

Allowed edits:

```text
docs/refactor-v3-thin-orchestrator/**
```

Forbidden production edits include:

```text
pipeline-ui/**
launch-desktop.bat
.gitmodules
codex-chatgpt-web submodule source/runtime configuration
user config
```

Do NOT:

```text
git reset --hard
git clean
git rebase
git commit
git push
```

This turn is architecture validation only.

---

# 2. Preflight

Run and record:

```bash
git branch --show-current
git rev-parse HEAD
git status --short --untracked-files=all
git status --porcelain=v2 --untracked-files=all
git submodule status
```

If current HEAD differs from the documentation reference, do not reset. Audit relevant delta.

---

# 3. Read all v3 docs

Read every file under:

`docs/refactor-v3-thin-orchestrator/`

Authority order:

1. `04-TRUST-BOUNDARIES-AND-INVARIANTS.md`
2. `08-SEMANTIC-BROKER-TOOLS.md`
3. `09-STATE-MACHINE-AND-LIFECYCLE.md`
4. `10-MINIMAL-WORKSPACE-STATE-GATE.md`
5. `06-CODEX-AUDITOR-RUNTIME.md`
6. `13-IMPLEMENTATION-PLAN.md`
7. `14-ROADMAP.md`

Do not silently choose one side when documents conflict. Report and correct the conflict.

---

# 4. Inspect actual Orchestrator implementation

At minimum inspect:

```text
pipeline-ui/server.js
pipeline-ui/send_to_codex.py
pipeline-ui/watch_codex_session.py
pipeline-ui/send_to_antigravity.py
pipeline-ui/desktop-main.js
pipeline-ui/preload.js
pipeline-ui/public/app.js
pipeline-ui/package.json
pipeline-ui/test/**
pipeline-ui/pipeline_settings.json
pipeline-ui/user-projects.json if present
launch-desktop.bat
.gitmodules
```

Search for:

```text
audit-and-direct
/api/orchestrator/audit
workerReport
testPassed
verdict
COMPLETE
FIX
dispatchPromptToCodex
waitCodexReport
send_to_antigravity
ao.exe
runAo
worker/engine
exchangeHistory
getProjectLocalContext
runCodexWithPrompt
codex exec
codex queue
app.listen
exec(
execFile(
```

For each legacy function/route, classify:

```text
KEEP
ADAPT
DEPRECATE
REMOVE_AFTER_MIGRATION
UNKNOWN_DEPENDENCY
```

Do not rely only on file names; find callers.

---

# 5. Verify `codex-chatgpt-web` assumptions

Inspect the actual pinned submodule at:

`codex-chatgpt-web`

Also inspect installed runtime capability where safe.

Verify:

- Browser-only vs Full Harness semantics;
- whether Full Harness binds tools to the current Codex task;
- task-bound CWD/workspace authority;
- tunnel/connector responsibilities;
- model selection ownership;
- launcher/background behavior;
- tool-call/approval behavior;
- whether a custom Codex MCP tool would surface through Full Harness;
- whether native exec can reliably invoke the proposed semantic CLI;
- relevant bounded wait/tool timeouts.

Do not expose or copy:

- cookies;
- browser profile;
- Tunnel/API keys;
- connector secrets.

Only record safe capability facts.

---

# 6. Verify local Codex capability

Use safe, non-mutating probes such as:

```bash
codex --version
codex --help
codex exec --help
codex app-server --help
```

Determine:

1. Can the user maintain a dedicated persistent task operationally?
2. Can the actual task CWD/workspace be verified?
3. Can Full Harness call a semantic CLI reliably?
4. What sandbox/approval is needed for broker side effects without allowing auditor source edits?
5. Is a narrow command-prefix approval possible?
6. Is there a documented exact native thread/turn API suitable for a future managed auditor?

Do NOT implement managed task control.

Forbidden fallback:

```text
codex queue
+ rollout timing heuristic
```

---

# 7. Verify AO / Antigravity capability

Probe help/status/capability safely. Do not send a real production WorkOrder.

Determine actual support for:

```text
session identity
send
message ID
turn ID
status
transcript
completion
cancel
```

The v3 docs intentionally do not assume AO exposes exact turn/message IDs.

Decision:

- if AO has stronger exact IDs, revise worker adapter to use them;
- if not, prove the dispatch/work-order completion-envelope design is viable;
- if neither works reliably, mark the architecture BLOCKED rather than inventing identity.

---

# 8. Challenge CLI-first broker design

The proposed MVP is:

```text
semantic CLI first
MCP adapter later if useful
```

Evaluate from actual environment:

1. Can Full Harness invoke the CLI under intended auditor sandbox?
2. Does broker need write access outside target repo for locks/journal?
3. Can that be narrowly authorized without giving Sol implementation-write capability?
4. Would a small Codex MCP server actually be simpler/safer?
5. Is there already a native integration surface that eliminates both custom CLI and MCP?

If MCP-first is demonstrably simpler, revise the docs.

Do not choose MCP only because it looks cleaner on a diagram.

---

# 9. Challenge persistent auditor task

Verify whether the user-owned persistent task is realistic across:

- normal turns;
- long worker execution;
- context compaction;
- Codex restart;
- launcher/browser restart;
- model persistence;
- task continuation.

If one browser turn cannot wait long enough, confirm that bounded broker waits + later continuation in the same Codex task is sufficient.

If persistent-task model is not viable, propose the simplest exact alternative using documented task/thread identity.

Do not return to heuristic queue/rollout correlation.

---

# 10. Challenge agent-to-agent loop

Analyze these cases:

```text
worker runs longer than current Sol/browser turn
Codex process restarts
Orchestrator restarts
Antigravity restarts
user edits repo during audit
user edits while worker runs
completion envelope missing
completion envelope malformed
old completion appears
wrong project completion appears
two projects active
repo prompt injection asks Sol to dispatch something dangerous
```

Update state machine/docs when necessary.

---

# 11. Review `workspace_state_id`

Validate:

- dirty tracked state;
- staged/unstaged;
- deletes/renames;
- untracked;
- ignored policy;
- symlinks;
- submodules;
- Windows case/drive/path behavior;
- file mode/executable bit where relevant;
- performance.

Keep this object minimal.

Do NOT turn it back into the v2 Evidence Packet/Auditor Engine.

---

# 12. Review security boundary

Inspect actual:

- Express listener;
- raw shell route(s);
- Electron IPC/preload;
- AO invocation;
- project path handling;
- temp file handling;
- registry/journal storage.

Ensure v3 does not require Orchestrator to store ChatGPT/tunnel/browser credentials.

---

# 13. Audit WP ordering

Review every `WP-V3-00` through `WP-V3-15`.

For each produce:

```text
WP
preconditions
actual files likely touched
hidden callers/dependencies
tests
migration risk
exit criteria
ordering correction if any
```

Specifically challenge ordering between:

```text
broker core
registry
workspace-state
AO lifecycle
semantic CLI
Codex auditor bootstrap
security hardening
legacy removal
```

Move/split/merge WPs when actual code dependencies demand it.

---

# 14. Lock these decisions

The Stage 2 report must explicitly decide:

## D-01 Auditor lifecycle

User-owned persistent Codex task, or a better exact mechanism.

## D-02 Broker exposure

Semantic CLI first, MCP first, or another verified simpler mechanism.

## D-03 Worker completion provenance

AO-native exact identity, dispatch envelope, or BLOCKED.

## D-04 Auditor write policy

How source stays auditor-read-only while broker dispatch remains permitted.

## D-05 UI role after pivot

Exactly what remains in UI and what semantic brain disappears.

## D-06 Legacy route migration

Which legacy audit routes stay temporarily, when they become read-only/shadow, and when they are removed.

---

# 15. Negative test review

Review every `V3-NT-*` case.

For each map:

```text
unit/integration/manual
fixture
module
exact expected state/error
```

Add missing cases.

Do not delete difficult tests merely to make implementation easier.

---

# 16. Required output file

Create:

`docs/refactor-v3-thin-orchestrator/STAGE2-PLAN-REVIEW.md`

Required sections:

```text
# 1. Repository Baseline
# 2. Executive Result
# 3. Architecture Pivot Validation
# 4. Confirmed Full Harness Capabilities
# 5. Confirmed Local Codex Capabilities
# 6. Confirmed AO / Antigravity Capabilities
# 7. Incorrect or Unsupported v3 Assumptions
# 8. Required Documentation Corrections
# 9. Final Responsibility Boundary
# 10. Broker Interface Decision
# 11. Worker Completion Provenance Decision
# 12. Auditor Lifecycle Decision
# 13. Workspace-State Review
# 14. Security Review
# 15. WP Dependency Review
# 16. Revised Roadmap
# 17. Revised Master Checklist
# 18. Revised Negative-Test Mapping
# 19. Legacy Deprecation Review
# 20. Remaining Blockers
# 21. Recommended First Implementation WorkOrder
```

---

# 17. Executive result

Use exactly one:

```text
READY_FOR_HUMAN_STAGE2_APPROVAL
```

or:

```text
V3_PLAN_REQUIRES_CORRECTION
```

You may correct docs in this turn and still return READY if no architectural blocker remains.

Never self-approve Stage 2.

---

# 18. First implementation WorkOrder

Draft but do NOT execute it.

Required fields:

```text
ID
goal
base HEAD
preconditions
allowed files
forbidden files
exact changes
tests
failure conditions
stop conditions
report format
```

If carried-forward WP-01 defects remain, first WorkOrder closes them.

Otherwise begin with broker-core extraction.

---

# 19. No production implementation

Even if obvious, do NOT:

- bind Express to loopback;
- create broker CLI;
- edit AO dispatcher;
- remove audit routes;
- add MCP server;
- change Codex integration.

This turn only locks architecture.

---

# 20. Final chat response

Return:

```text
STAGE 2 ARCHITECTURE PIVOT REVIEW

Branch:
...

HEAD:
...

Result:
READY_FOR_HUMAN_STAGE2_APPROVAL
or
V3_PLAN_REQUIRES_CORRECTION

Docs changed:
- ...

Key corrections:
- ...

Final auditor lifecycle:
...

Final broker exposure:
...

Worker provenance mechanism:
...

Remaining blockers:
...

Recommended first WorkOrder:
...

Production code changed:
NONE

Commit created:
NONE

Report:
docs/refactor-v3-thin-orchestrator/STAGE2-PLAN-REVIEW.md
```

Then STOP.

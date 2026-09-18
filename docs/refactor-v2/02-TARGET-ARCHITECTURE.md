# Target Architecture

## 1. System objective

Transform the system into an evidence-driven, fail-closed orchestration loop.

The auditor must never need to trust a worker statement when an independent machine observation is available.

## 2. Logical components

```text
User
  |
  v
Orchestrator Controller
  |
  +--> WorkOrder Registry
  |
  +--> Worker Adapter ------------------------------+
  |                                                |
  |                                                v
  |                                           Local Worker
  |                                                |
  |                                                v
  |                                         Local Working Tree
  |                                                |
  +--> Snapshot Engine <----------------------------+
  |       |
  |       +--> Git facts
  |       +--> changed-file manifest
  |       +--> content/diff hashes
  |
  +--> Verification Engine
  |       |
  |       +--> trusted checks from Verification Contract
  |       +--> raw exit codes/stdout/stderr
  |
  +--> Auditor Runtime
          |
          +--> baseline evidence packet
          +--> active read/search tools when available
          +--> structured JSON verdict
          |
          v
      Directive Gate
          |
          +--> dispatch only if protocol/snapshot gates pass
```

## 3. Evidence lanes

### Lane A — Worker claims

WorkerReport is retained because it is useful.

However it is classified as:

`UNTRUSTED_CLAIMS`

The worker may claim:

- files changed;
- tests passed;
- bug fixed;
- no remaining risk.

None of these claims independently authorize PASS.

### Lane B — Machine evidence

Produced by Orchestrator-owned components:

- `git status --porcelain=v2`
- branch / HEAD / upstream refs
- diff manifest
- diff/content hashes
- verification command IDs
- exact exit codes
- bounded stdout/stderr
- timestamps
- evidence hashes.

Machine evidence must carry `snapshot_id`.

### Lane C — Active auditor inspection

When Full Harness is available:

- read changed files;
- search callers/importers;
- inspect related tests;
- inspect configs/contracts;
- run only permitted verifier actions.

When Full Harness is unavailable:

- auditor receives a deterministic evidence packet plus bounded source excerpts chosen by Orchestrator policy;
- audit must declare reduced capability.

### Lane D — GitHub checkpoint

Optional for each micro-loop, recommended for milestones:

- exact committed SHA;
- remote diff;
- remote history;
- CI/checks when configured.

## 4. Fundamental rule

The system must distinguish:

```text
WHAT WORKER CLAIMED
WHAT MACHINE OBSERVED
WHAT AUDITOR CONCLUDED
```

Those three data classes must have different schemas and storage fields.

## 5. Audit lifecycle

```text
PREPARE
  -> SNAPSHOT_CREATED
  -> VERIFICATION_RUNNING
  -> EVIDENCE_READY
  -> AUDITOR_RUNNING
  -> AUDIT_RESULT_READY
  -> SNAPSHOT_RECHECK
  -> DIRECTIVE_GATE
  -> DISPATCHED | BLOCKED
```

At every arrow, failure is explicit.

There is no implicit success transition.

## 6. Snapshot race protection

Before auditor starts:

- capture snapshot fingerprint.

Immediately before dispatch:

- recompute fingerprint.

If fingerprints differ:

`SNAPSHOT_INVALIDATED`

The audit result is discarded for dispatch purposes.

## 7. Capability modes

### Mode A — Active Inspector

Requirements:

- Full Harness verified;
- connector/tunnel healthy;
- correct project CWD/workspace root;
- read-only audit policy;
- active tool capability confirmed.

### Mode B — Evidence Packet

Used when active tools are unavailable.

Requirements:

- snapshot;
- independent diff;
- verification results;
- changed-file contents/excerpts under deterministic policy.

The result must record:

`audit_capability = "evidence_packet"`

No code should silently pretend it was Active Inspector mode.

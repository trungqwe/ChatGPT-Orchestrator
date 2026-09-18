# Minimal Workspace-State Gate

## Purpose

v3 removes the large evidence/snapshot engine from the normal path but retains one deterministic question:

> Is the repository state used by Sol still the state about to authorize worker dispatch?

## Inputs

`workspace_state_id` minimum inputs:

- canonical project identity;
- branch;
- HEAD;
- `git status --porcelain=v2 -z`;
- staged diff hash;
- unstaged diff hash;
- nonignored untracked manifest + raw-content hashes;
- submodule status when present.

Conceptual:

```text
SHA256(
  version
  + project_identity
  + branch
  + HEAD
  + hash(porcelain_v2_z)
  + hash(staged_diff)
  + hash(unstaged_diff)
  + hash(untracked_manifest)
  + hash(submodule_status)
)
```

## Not an evidence packet

Do not include WorkerReport/model prose/test narrative. This object exists only for freshness/staleness protection.

## Canonicalization

### Paths

Normalize stored relative paths to `/`.

### Git diff/status

Prefer raw Git-produced bytes for hashing. Do not invent cross-platform text normalization unless all producers/tests prove it deterministic.

### Untracked files

Hash raw file bytes. Do **not** normalize CRLF before content hashing; workspace identity should detect actual byte changes.

### JSON metadata

Stable key order, UTF-8, no locale formatting.

## Ignored/generated files

Default excludes ignored files. Project policy may opt specific ignored artifacts in when behaviorally relevant.

## Symlinks

Hash/record symlink identity/target metadata without following a link outside project root.

## Submodules

Record:

- submodule path;
- recorded gitlink SHA;
- observed HEAD;
- dirty status.

## Dispatch gate

Sol obtains `S1` before deciding directive. Broker recomputes `S2` immediately before dispatch.

`S1 != S2` -> `STALE_AUDIT_STATE`.

Sol re-inspects before any new dispatch.

## After worker completion

Sol obtains a fresh state ID and audits that actual state.

## Performance

Measure before optimizing. Exclude ignored dependency/build trees by default and use Git plumbing where possible.

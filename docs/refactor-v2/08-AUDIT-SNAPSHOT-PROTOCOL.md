# Audit Snapshot Protocol

## 1. Objective

Prevent an audit from combining evidence produced from different local states.

## 2. Snapshot creation

Immediately after worker turn completion and before verification:

capture:

- project path;
- branch;
- HEAD;
- upstream ref/SHA;
- porcelain v2 status;
- staged diff;
- unstaged diff;
- untracked manifest;
- relevant content hashes.

## 3. Snapshot ID

Generate from a canonical serialized fingerprint.

Do not use timestamp alone.

Example conceptual formula:

```text
SHA256(
  head_sha
  + branch
  + canonical_status
  + staged_diff_hash
  + unstaged_diff_hash
  + canonical_untracked_manifest
)
```

## 4. Dirty working tree

Dirty state is allowed.

Snapshot protocol exists specifically to audit local uncommitted work.

Dirty must not mean invalid.

Unexpected mutation after snapshot means invalid.

## 5. Revalidation

Perform:

- after verification;
- before model audit if verification took significant time;
- immediately before directive dispatch.

## 6. Snapshot invalidation

If fingerprint changes:

```json
{
  "status": "BLOCKED_SNAPSHOT_INVALIDATED",
  "expected_snapshot_id": "...",
  "observed_snapshot_id": "..."
}
```

Do not reuse the old auditor verdict.

## 7. Evidence binding

Every machine-evidence object includes:

`snapshot_id`

Every auditor result includes:

`audited_snapshot_id`

Every directive includes:

`base_snapshot_id`

## 8. Untracked files

Untracked files relevant to changed behavior must be included in fingerprint and inspection.

The `canonical_untracked_manifest` is constructed by:
1. Scanning all non-gitignored untracked files in the repository root.
2. Computing the SHA-256 of the raw file contents for each untracked file.
3. Formatting entries as `<normalized_relative_path>:<content_sha256>`.
4. Sorting entries lexicographically by relative path.

Do not silently ignore untracked source/test/config files.

## 9. Large/binary files

Record metadata/hash rather than injecting raw bytes into model context unless specifically required.

## 10. GitHub checkpoint mapping

At a committed checkpoint:

```text
snapshot.head_sha == pushed_commit_sha
working tree clean
```

allows direct mapping to remote immutable state.

If dirty:

GitHub represents only the committed portion; record this explicitly.

## 11. Canonical Windows serialization rules

To ensure deterministic snapshot reproducibility across Windows and POSIX environments:
1. **Path separators**: All file paths must be normalized using POSIX forward slashes (`/`).
2. **Line endings**: Git diffs and file content hashes must normalize CRLF (`\r\n`) to LF (`\n`) before hashing.
3. **JSON ordering**: Snapshot objects must use deterministic key sorting (e.g. `fast-json-stable-stringify`) before computing `fingerprint`.
4. **Encoding**: All strings must be encoded as UTF-8.

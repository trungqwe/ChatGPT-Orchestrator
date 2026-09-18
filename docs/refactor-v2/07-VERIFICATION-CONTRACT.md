# Verification Contract

## 1. Purpose

Define which checks are authoritative for implementation acceptance.

A WorkerReport does not define mandatory tests.

A worker-proposed command is never automatically trusted.

## 2. Contract ownership

Owned by:

Orchestrator / project configuration reviewed before execution.

Not owned by:

- worker;
- auditor prose;
- HTTP caller.

## 3. Example schema

```json
{
  "schema_version": 1,
  "project_id": "AI_Multi_Task",
  "checks": [
    {
      "id": "git.diff_check",
      "type": "git_diff_check",
      "required": true
    },
    {
      "id": "project.default_test",
      "type": "npm_script",
      "script": "test",
      "required": true,
      "timeout_ms": 180000
    }
  ]
}
```

## 4. Command policy

Prefer semantic execution.

Examples:

`npm_script:test`

not:

`npm test && curl ...`

The verifier implementation constructs the process invocation.

## 5. Evidence result

Required fields:

- evidence ID;
- snapshot ID;
- check ID;
- required flag;
- started/ended timestamps;
- exit code;
- stdout/stderr;
- truncation flag;
- hashes;
- runner version where relevant.

## 6. Failure semantics

Required check exit nonzero:

- implementation cannot be approved.

Required check cannot run:

- audit is BLOCKED.

Optional check failure:

- report explicitly; contract determines whether blocking.

## 7. Worker extension

Worker may emit:

```json
{
  "suggested_checks": [...]
}
```

Orchestrator may execute them as supplemental evidence.

They cannot replace mandatory checks.

## 8. Secrets

Outputs must pass a redaction layer before being sent to a model.

Never deliberately include:

- `.env` secrets;
- auth tokens;
- cookies;
- browser storage state;
- private keys.

## 9. Versioning

Every evidence packet stores the verification-contract hash.

This makes historical audit results reproducible.

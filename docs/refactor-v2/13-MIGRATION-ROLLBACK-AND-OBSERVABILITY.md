# Migration, Rollback, and Observability

## 1. Migration principle

Do not replace the entire orchestration path in one commit.

Use feature flags and parallel evidence recording.

## 2. Suggested flags

```text
ORCH_NEW_SNAPSHOT_ENGINE
ORCH_VERIFICATION_CONTRACT
ORCH_STRUCTURED_AUDIT
ORCH_ACTIVE_INSPECTOR
ORCH_SECURE_LOCAL_API
```

Defaults should become safe as each phase is validated.

## 3. Shadow mode

Before allowing a new auditor path to dispatch:

- run it in shadow mode;
- compare its result with legacy path;
- persist differences;
- do not let shadow output modify worker state.

## 4. Rollback

Every phase should be revertible independently.

Do not mix:

- security changes;
- snapshot engine;
- UI redesign;
- model prompt rewrite;

in one giant commit.

## 5. Observability events

Recommended event names:

- `snapshot.created`
- `snapshot.invalidated`
- `verification.started`
- `verification.finished`
- `audit.started`
- `audit.protocol_error`
- `audit.finished`
- `directive.blocked`
- `directive.dispatched`
- `worker.turn_started`
- `worker.turn_completed`
- `worker.turn_timeout`

## 6. Correlation

Every log event carries:

- project ID;
- WorkOrder ID;
- snapshot ID;
- audit ID;
- dispatch ID;
- turn ID when known.

## 7. Metrics

Track:

- false-positive prevention events;
- stale-report attempts blocked;
- snapshot invalidations;
- verifier failures;
- audit protocol failures;
- active-inspector availability rate;
- median audit time;
- tool-call count.

## 8. User-facing error messages

Prefer precise states:

“Audit blocked: repository changed after snapshot.”

not:

“Something went wrong.”

## 9. Release notes

When migration completes, document:

- old behavior removed;
- new trust model;
- limitations;
- exact meaning of “verified”.

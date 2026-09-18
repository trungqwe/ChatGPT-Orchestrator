# State Machine and Lifecycle

## Project control state

```text
SETUP_REQUIRED
READY
AUDITOR_ACTIVE
WORKER_DISPATCHING
WORKER_RUNNING
READY_FOR_REVIEW
AUDITOR_REVIEWING
BLOCKED
COMPLETE
```

These are control states, not code-quality verdicts.

## Dispatch state

```text
CREATED -> VALIDATING -> DISPATCHING -> DISPATCH_ACCEPTED -> RUNNING -> READY_FOR_REVIEW
```

Failure branches:

```text
INVALID_REQUEST
WORKER_BUSY
STALE_AUDIT_STATE
DISPATCH_FAILED
PROVENANCE_AMBIGUOUS
WORKER_FAILED
```

## Identity

WorkOrder identity:

- project ID;
- work-order ID.

Delivery attempt identity:

- dispatch ID.

Retry same WorkOrder -> new dispatch ID.

## Auditor procedure

```text
INSPECT -> DECIDE -> SNAPSHOT -> DISPATCH -> WAIT -> REVIEW -> DECIDE
```

Broker does not infer these reasoning phases from model prose.

## Critical distinction

```text
worker READY_FOR_REVIEW != implementation accepted
```

It only tells Sol to inspect.

## Transition rules

### READY -> WORKER_DISPATCHING

Requires valid mapping, no active dispatch, workspace match and lock.

### WORKER_RUNNING -> READY_FOR_REVIEW

Requires completion identity bound to active dispatch.

### READY_FOR_REVIEW -> AUDITOR_REVIEWING

Sol begins direct inspection. This may be only UI/event state.

### AUDITOR_REVIEWING -> WORKER_DISPATCHING

Only through a valid `worker_dispatch` call.

### AUDITOR_REVIEWING -> COMPLETE

Optional `workflow_complete`; no automatic merge/release.

## Busy behavior

MVP rejects second active dispatch; no hidden queue of parallel worker WorkOrders.

## Process restart

Persist active dispatch/work-order/session/state/timestamps/base workspace ID.

On restart reconcile with AO. If identity cannot be proven -> `PROVENANCE_AMBIGUOUS`, not IDLE.

## Crash between AO send and journal result

Use write-ahead intent:

1. persist `DISPATCHING` with dispatch ID;
2. call AO;
3. persist accepted/failure.

Crash after AO accepted but before result persistence is ambiguous. Do not resend automatically.

## Wait semantics

`worker_wait` returns after at most configured bound. A 10-second poll timeout is normally nonterminal `RUNNING`, not WorkOrder failure.

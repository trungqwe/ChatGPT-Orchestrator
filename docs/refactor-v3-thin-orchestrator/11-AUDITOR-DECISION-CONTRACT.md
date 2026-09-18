# Auditor Decision Contract

## Principle

Broker does not need to parse a complete audit-result object. The operational machine contract is the semantic tool call.

Human-facing Sol prose is allowed; only a valid broker request causes worker dispatch.

## Auditor reasoning states

Sol may reason as:

```text
FIX_REQUIRED
NEXT_WORK_ORDER
BLOCKED
ROADMAP_COMPLETE
```

Broker does not parse those words.

## Dispatch request is authoritative operation

Required fields:

- project ID;
- work-order ID;
- expected workspace-state ID;
- directive.

Optional metadata:

- decision ID;
- concise reason summary;
- roadmap reference.

## Directive quality requirements

Sol directive should specify:

- goal;
- scope;
- allowed/forbidden files;
- preconditions;
- exact requested changes;
- tests;
- failure/stop conditions;
- required completion envelope.

Broker does not semantically grade it.

## Roadmap complete

Sol does not dispatch. It reports to the human and may optionally record `workflow_complete`.

No automatic merge/push/release.

## Blocked

Missing Full Harness, incorrect workspace, unresolved architecture decision or failed broker mapping means no speculative worker dispatch.

## Pause

A user pause flag makes dispatch return `PAUSED_BY_USER`.

## Forbidden legacy behavior

- last-paragraph dispatch;
- WorkerReport-derived directive;
- `lỗi`/`sửa` parsing;
- `testPassed` → COMPLETE;
- malformed model result fallback.

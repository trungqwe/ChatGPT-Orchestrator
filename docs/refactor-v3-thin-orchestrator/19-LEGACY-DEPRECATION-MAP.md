# Legacy Deprecation Map

## Keep/adapt

### Project management UI

Keep and adapt to explicit registry.

### Antigravity session discovery

Keep for setup suggestions; never silently change active mapping.

### Status/doctor UI

Keep and add v3 health/state.

### Exchange/audit history

May remain as event/history display. Do not treat as acceptance truth.

### GitHub utilities

Keep for milestone corroboration.

## Replace/reshape

### `send_to_antigravity.py`

Evolve into worker-adapter semantics: mapped session, dispatch ID, accepted != completed.

### `send_to_codex.py`

Not part of primary v3 auditor loop. Retain only for legacy features until removal.

### `watch_codex_session.py`

Not primary v3 auditor result transport.

## Remove from primary path

- `/api/orchestrator/audit` semantic brain;
- `/api/orchestrator/audit-and-direct` semantic brain;
- WorkerReport semantic parser;
- prose substring verdict parser;
- last-paragraph directive extraction;
- model verdict -> `testPassed`;
- missing-report positive fallback;
- shallow context builder used only to feed old auditor.

## Raw shell test route

Remove from normal API. Developer-only route, if retained, is isolated/disabled/authenticated and never used by broker.

## Evidence Packet Builder

Not a v3 MVP prerequisite. Only future explicit degraded-mode feature.

## Verification Contract

Do not build the large v2 verifier engine merely because old docs specify it. Sol directly executes verification through Full Harness. A smaller policy/check system can be added later if real use requires deterministic mandatory checks.

## Snapshot Engine

Replace with minimal workspace freshness fingerprint; no broad evidence store.

## Structured Auditor Result Schema

Replace operationally with broker request schema. Human-facing Sol result can remain prose because broker does not parse it.

## GitHub micro-loop

No push required for every audit. Full Harness sees local code. Push at milestones.

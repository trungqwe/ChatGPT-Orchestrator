# Structured Audit Result Contract

## 1. Goal

Eliminate verdict inference from prose.

## 2. Conceptual schema

```json
{
  "schema_version": 1,
  "audit_id": "A-...",
  "project_id": "...",
  "audited_snapshot_id": "...",
  "audit_capability": "active_inspector",
  "status": "FIX_REQUIRED",
  "claim_reconciliation": [
    {
      "claim_id": "C-1",
      "classification": "CONTRADICTED",
      "evidence_ids": ["E-4"],
      "reason": "..."
    }
  ],
  "findings": [
    {
      "id": "F-1",
      "severity": "HIGH",
      "category": "correctness",
      "file": "pipeline-ui/send_to_codex.py",
      "line_hint": 224,
      "summary": "...",
      "evidence_ids": ["E-7"]
    }
  ],
  "required_actions": [
    {
      "id": "R-1",
      "description": "...",
      "acceptance_criteria": ["..."]
    }
  ],
  "next_directive": {
    "work_order_id": "...",
    "base_snapshot_id": "...",
    "instructions": "..."
  }
}
```

## 3. Allowed audit statuses

### `FIX_REQUIRED`

Evidence supports concrete defects requiring implementation changes.

### `READY_FOR_NEXT_WORKORDER`

Current scoped work satisfies its acceptance contract; more roadmap work remains.

### `BLOCKED_INSUFFICIENT_EVIDENCE`

Required facts/checks are missing.

### `BLOCKED_SNAPSHOT_INVALIDATED`

Repository changed during audit.

### `AUDIT_PROTOCOL_ERROR`

Model output failed the structured protocol.

### `ROADMAP_COMPLETE`

Only valid when the entire approved roadmap and all final gates are satisfied.

## 4. Forbidden behavior

Do not:

- derive status by searching prose;
- turn invalid JSON into PASS;
- dispatch a last paragraph as fallback directive;
- use a result whose snapshot ID no longer matches.

## 5. Human-readable content

Markdown narrative may be generated as a secondary display.

Machine state comes only from validated fields.

## 6. Dispatch rule

`next_directive` is dispatchable only after:

- schema valid;
- status permits another worker turn;
- snapshot revalidation passes;
- directive gate passes.

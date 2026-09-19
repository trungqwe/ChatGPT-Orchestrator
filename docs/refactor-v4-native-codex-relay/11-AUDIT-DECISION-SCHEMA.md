# AuditDecisionV1

Decision allowlist: `DISPATCH_WORKER`, `REQUEST_EVIDENCE`, `APPROVE_WORK_PACKAGE`, `BLOCKED`, `STOP`.

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"required":["schema_version","decision","summary","workspace_state_observed","independent_verification"],"properties":{"schema_version":{"const":1},"decision":{"enum":["DISPATCH_WORKER","REQUEST_EVIDENCE","APPROVE_WORK_PACKAGE","BLOCKED","STOP"]},"summary":{"type":"string","minLength":1},"workspace_state_observed":{"type":"string","minLength":1},"independent_verification":{"type":"array","items":{"type":"string"}},"work_order":{"type":"object","additionalProperties":false,"required":["work_order_id","directive","verification"],"properties":{"work_order_id":{"type":"string","minLength":1},"directive":{"type":"string","minLength":1},"verification":{"type":"array","minItems":1,"items":{"type":"string"}},"worker_model_policy":{"type":"string"}}},"requested_evidence":{"type":"array","items":{"type":"string"}},"blocker":{"type":"string"}},"allOf":[{"if":{"properties":{"decision":{"const":"DISPATCH_WORKER"}}},"then":{"required":["work_order"]},"else":{"not":{"required":["work_order"]}}},{"if":{"properties":{"decision":{"const":"REQUEST_EVIDENCE"}}},"then":{"required":["requested_evidence"]}}]}
```

Schema mismatch, extra fields, stale state hoặc identity mismatch fail closed.

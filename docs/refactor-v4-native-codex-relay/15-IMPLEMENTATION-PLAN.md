# Implementation plan

| WP | Kết quả | Gate |
|---|---|---|
| V4-01 | Architecture reset | Static docs validation |
| V4-02A | Quarantine Web bridge path | app không spawn/probe bridge |
| V4-02B | Registry v2 + migration explicit | 39 RG + 52 RV2 và rollback tests; chưa apply trên Registry thật |
| V4-03A | Transport core implemented | 60 CAS tests pass; fake fixture + deterministic protocol |
| V4-03B | Real App Server acceptance | REAL_APP_SERVER_ACCEPTANCE_PENDING (opt-in smoke tool sẵn sàng) |
| V4-04 | AuditDecisionV1 | schema negatives |
| V4-05 | Thread persistence/recovery | crash tests |
| V4-06 | Model resolver | catalog/fallback tests |
| V4-07 | Audit/recover CLI | integration tests |
| V4-08 | Generic worker boundary | Antigravity regression |
| V4-09 | One-shot full cycle | real workspace acceptance |
| V4-10 | Recovery/provenance | fault matrix |
| V4-11 | Shadow mode | divergence gate |
| V4-12 | Bounded loop | budget/stop gates |
| V4-13 | Legacy Web/MCP source/UI cleanup | native proven + rollback |
| V4-14 | Operator UI polish | usability acceptance |

Không bắt đầu WP kế tiếp khi gate chưa đạt.

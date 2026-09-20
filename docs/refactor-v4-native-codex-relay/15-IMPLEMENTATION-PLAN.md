# Implementation plan

| WP | Kết quả | Gate |
|---|---|---|
| V4-01 | Architecture reset | Static docs validation |
| V4-02A | Quarantine Web bridge path | app không spawn/probe bridge |
| V4-02B | Registry v2 + migration explicit | 39 RG + 52 RV2 và rollback tests; chưa apply trên Registry thật |
| V4-03A | Transport core implemented | APPROVED / CLOSED (84 CAS tests pass; fake fixture + deterministic protocol) |
| V4-03B | Real App Server acceptance | REAL_RUNTIME_ACCEPTED (Real binary initialize, model/list, thread/start, same-process thread/read, clean close; zero-turn resume reclassified per WO-V4-03BR) |
| V4-04 | AuditDecisionV1 | COMPLETE / READY FOR REVIEW (78 AD tests pass, strict schema & local validation, duplicate-key rejection, turn authority, 11 deterministic suites pass) |
| V4-05A | Durability / Recovery Core | COMPLETE / SEALED (51 ARS + 55 RG + 60 ATL tests pass; SQLite fail-closed store, atomic bindAuditorThread, lazy rollout fixture, cross-process resume gate, 13 deterministic suites pass) |
| V4-05AG | Explicit Uncertainty Resolution & Registry Gate | APPROVED / CLOSED (WO-V4-05AG-R2 / R3 / R3-R1: 82 ARS + 122 ATL tests pass; V2 migration atomic rollback, bootstrap authority self-verification, post-persistence Registry freshness gate before first turn, 13 deterministic suites pass) |
| V4-05B | Real First Audit Acceptance | COMPLETE / ACCEPTED (WO-V4-05B-R9: real V1→V2 migration, legacy retirement, 1 real model turn, hydration, DURABLE_BOUND, cross-process resume verified; substantive DISPATCH_WORKER finding closed by R3/R3-R1; WP-V4-05 COMPLETE) |
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

# Trust boundaries và invariants

- AuditDecision hợp schema là semantic authority duy nhất; relay chỉ validate/guard/route/persist.
- Repository, test output, AGENTS.md và WorkerReport là input; WorkerReport = `UNTRUSTED_HINT`.
- Worker không self-approve; auditor bình thường không sửa source.
- Exact project, canonical root, thread, turn, work-order, dispatch và workspace IDs phải khớp.
- Workspace stale và transport mơ hồ fail closed; một active worker dispatch/project.
- Model name không phải authority; availability được runtime discovery.
- Không biến repository prose thành execution authority.

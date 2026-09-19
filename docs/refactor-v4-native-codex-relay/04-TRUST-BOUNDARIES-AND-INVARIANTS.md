# Trust Boundaries và Invariants

1. **Semantic Authority Pipeline**:
   - Provider `outputSchema` + strict local prototype-free JSON parsing (with duplicate-key rejection, prototype mutation prevention, and size bounds) + local schema validation + exact context validation + branch semantics + bounded diagnostic guarantees are **all required** before semantic authority exists.
   - Model output is completely untrusted until all validation layers succeed.
   - Valid schema output ≠ fresh workspace authority.

2. **Input vs Authority Distinction**:
   - Repository source, test output, `AGENTS.md`, and `WorkerReport` are untrusted inputs.
   - `WorkerReport` remains strictly an `UNTRUSTED_HINT`. Auditor decisions must stand on independent verification.
   - Worker cannot self-approve; native Codex auditor in read-only sandbox cannot modify project source.

3. **Exact Identity Binding**:
   - Exact `project_id`, canonical project root, `audit_subject_id`, `auditor_thread_id`, and `workspace_state_observed` must match expected trusted context byte-for-byte.
   - Workspace state observed in the turn output is an echo of the input context; relay must freshly recompute workspace state immediately prior to applying lifecycle actions.

4. **Turn and Transport Lifecycle**:
   - Only terminal turns with `turn.status == 'completed'` and `turn.itemsView == 'full'` can carry decision authority.
   - Interrupted, failed, or in-progress turns carry zero decision authority (fail closed).
   - Only `agentMessage` items with `phase == 'final_answer'` (or a single message with null/unknown phase if no final_answer exists) can carry decision authority. Commentary messages are never authority.
   - Codex may materialize durable history once the first meaningful user turn begins; WP05 proves durability explicitly through recovery/resume and does not rely on the exact filesystem-materialization event.

5. **Fail-Closed Invariants**:
   - Single active worker dispatch per project.
   - Corrupt state, stale workspace state, ambiguous transport results, or duplicate keys immediately fail closed.
   - Model names in configuration or output policy are logical (`worker_standard`, `worker_economy`); availability is determined by runtime discovery, never model assertion.

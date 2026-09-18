# Project / Session / Auditor Registry

## Purpose

Deterministically answer:

> Which project root, Antigravity session and Codex auditor task belong together?

No model guesses this mapping.

## Suggested storage

Orchestrator-owned local user-data file, e.g.:

`.orchestrator/projects.json`

Prefer outside target repositories for machine-specific mapping.

## Schema

```json
{
  "schema_version": 1,
  "projects": {
    "ai-multi-task": {
      "project_id": "ai-multi-task",
      "project_name": "AI_Multi_Task",
      "project_root": "D:/TU_CODE/AI_Multi_Task",
      "worker": {
        "engine": "antigravity",
        "session_id": "ai_multi_task-1",
        "enabled": true
      },
      "auditor": {
        "engine": "codex",
        "task_id": "user-selected-task-id-or-descriptor",
        "task_id_verified": false,
        "expected_model_label": "ChatGPT Web — GPT-5.6 Sol High",
        "mode": "full-harness",
        "managed_by_orchestrator": false
      },
      "policy": {
        "max_active_dispatches": 1,
        "require_workspace_state": true
      }
    }
  }
}
```

## Project identity

Store absolute/canonical root. Do not identify projects only by basename because multiple roots may share a name.

## Setup

User explicitly selects:

1. project folder;
2. Antigravity session;
3. dedicated Codex auditor task/descriptor;
4. expected model label.

Discovery can suggest values but must not silently change mappings.

## Auditor task identity

If current Codex UI/CLI cannot expose a stable task ID programmatically, store a human-selected descriptor and `task_id_verified=false`.

MVP remains valid because the user runs the bootstrap prompt inside the intended task. Managed routing is a future exact-API feature.

## Worker session validation

Probe AO and use strongest stable identity available. Do not assume `<project>-1` is always correct.

## Registry mutation

Only explicit setup/admin/user actions change project root, worker session or auditor mapping. Sol cannot mutate mapping through normal worker-dispatch requests.

## Secrets

Registry contains no ChatGPT cookies, tunnel keys, browser storage or passwords.

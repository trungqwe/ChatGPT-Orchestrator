# Worker Adapter Contract

```ts
dispatch({projectId, workOrderId, dispatchId, directive, workspaceStateId})
wait({projectId, dispatchId, timeoutMs})
probe({projectId, dispatchId})
cancel?.({projectId, dispatchId})
```

Completion bind `project_id`, `work_order_id`, `dispatch_id`; plain `DONE` không hợp lệ. `READY_FOR_REVIEW` không chứng minh test pass. Antigravity là adapter đầu tiên; Codex worker và engine khác dùng cùng contract.

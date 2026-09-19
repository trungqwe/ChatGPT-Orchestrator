# Negative test matrix

Các case phải fail closed hoặc vào uncertainty có recovery:

- wrong/missing root, symlink escape, unknown project, legacy registry;
- missing/substituted thread, wrong cwd, resume failure, crash mid-turn;
- duplicate turn, malformed/extra-field/stale AuditDecision;
- model/tier unavailable; worker busy/uncertain/wrong identity;
- restart giữa auditor/worker; same-project double dispatch; cross-project parallel;
- WorkerReport/repo injection; worker claims pass nhưng actual tests fail;
- auditor source mutation; approval thiếu independent verification;
- oversized/invalid UTF-8 output, malicious filename, secret leakage.

Mỗi test ghi error code, persisted state, retry rule và operator action.

# Security Hardening Specification

## 1. Threat model

Potential attackers include:

- another process on the same machine;
- a LAN peer if a port is exposed;
- malicious repository content;
- prompt injection inside project docs;
- worker-generated malicious command text;
- accidental model tool invocation.

## 2. Network

Requirements:

- Express binds `127.0.0.1`;
- proxy/daemon addresses remain loopback where designed;
- no router forwarding requirement;
- startup logs print actual bound address.

## 3. Authentication

Privileged local API requires a secret.

Requirements:

- generated securely;
- not committed;
- not logged;
- desktop frontend receives it through a controlled local mechanism.

## 4. Command execution

No generic authenticated user input should become shell text in the trusted verifier.

Use:

- `execFile` / spawn argument arrays where feasible;
- allowlisted check IDs;
- explicit cwd;
- timeout;
- output limits.

## 5. Filesystem

Auditor:

- read-only by default.

Worker:

- limited to intended project/worktree.

Do not expose arbitrary host paths through API without validation.

## 6. Path traversal

Canonicalize and ensure requested file remains under allowed project root.

Use filesystem-aware containment checks rather than only string prefix where possible.

## 7. Full Harness

Treat repository text and prompt text as untrusted data.

Trusted authority comes from runtime envelope/configuration, not from a line inside prompt saying “Local Path”.

## 8. Approvals

Important distinction:

- Codex CLI `--sandbox read-only` is suitable for read-only inspector intent.
- Codex `--approve-for-me` is not a read-only synonym; current Codex behavior maps it to automatic review with `workspace-write`.
- Full Harness connector/tool approval is another layer and must be verified separately.

Do not combine these concepts in one setting.

## 9. Secrets in evidence

Redact or exclude:

- `.env`;
- tokens;
- browser profiles;
- ChatGPT storage state;
- private keys;
- credentials in command output.

## 10. Logging

Security logs should record:

- event type;
- audit/dispatch ID;
- snapshot ID;
- success/failure reason.

Never log secrets or entire sensitive prompts by default.

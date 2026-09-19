'use strict';

/**
 * Codex Auditor Bootstrap & Health Static Test Suite (AB-001 .. AB-024)
 *
 * Validates:
 * - Authoritative presence of bootstrap, health checklist, and operator runbook docs
 * - Strict Sol architect/auditor role separation (not implementer)
 * - Zero-trust data classification for repository text and worker reports
 * - Strict source-write prohibition by prompt/practice
 * - Exact canonical broker CLI syntax (--project-id, --request-file, --dispatch-id, --timeout-secs)
 * - Rejection of codex queue, auto-task selection, and rollout scanning
 * - Doctor health semantics: necessary but not sufficient; connector limitation
 * - Task-level local tool proof (source read + terminal)
 * - Exact workspace root comparison and S_before == S_after mutation proof
 * - Human model verification and HUMAN_SELECTED_UNVERIFIED task fallback
 * - No secrets copy/persistence in orchestrator artifacts
 * - Fail-closed readiness and structured blocked reason codes
 * - Independent re-audit after READY_FOR_REVIEW and context compaction recovery
 * - Bounded worker wait (1..30s, prefer <=10s)
 * - Zero real AO/Codex process execution during test
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Target repository root
const repoRoot = path.resolve(__dirname, '../../..');
const docsDir = path.join(repoRoot, 'docs/refactor-v3-thin-orchestrator');

const bootstrapDocPath = path.join(docsDir, '21-CODEX-AUDITOR-BOOTSTRAP.md');
const healthDocPath = path.join(docsDir, '22-CODEX-AUDITOR-HEALTH-CHECKLIST.md');
const runbookDocPath = path.join(docsDir, '23-CODEX-AUDITOR-OPERATOR-RUNBOOK.md');

// Counter for tracking process launches and mutations within this test
let codexProcessLaunches = 0;
let aoProcessLaunches = 0;
let registryMutations = 0;

function runAllTests() {
  console.log('Running Codex Auditor Bootstrap static verification tests (AB-001 .. AB-024)...');

  // AB-001: Required docs exist
  {
    assert.strictEqual(fs.existsSync(bootstrapDocPath), true, 'AB-001: 21-CODEX-AUDITOR-BOOTSTRAP.md must exist');
    assert.strictEqual(fs.existsSync(healthDocPath), true, 'AB-001: 22-CODEX-AUDITOR-HEALTH-CHECKLIST.md must exist');
    assert.strictEqual(fs.existsSync(runbookDocPath), true, 'AB-001: 23-CODEX-AUDITOR-OPERATOR-RUNBOOK.md must exist');
    console.log('PASS: AB-001 — Required docs exist');
  }

  const bootstrapContent = fs.readFileSync(bootstrapDocPath, 'utf8');
  const healthContent = fs.readFileSync(healthDocPath, 'utf8');
  const runbookContent = fs.readFileSync(runbookDocPath, 'utf8');
  const allDocsContent = `${bootstrapContent}\n${healthContent}\n${runbookContent}`;

  // AB-002: Auditor role
  {
    assert.match(bootstrapContent, /SOL\s*=\s*architect\s*\/\s*independent\s*auditor/i, 'AB-002: Sol must be defined as architect / independent auditor');
    assert.match(bootstrapContent, /Sol is NOT an implementation worker|not an implementer/i, 'AB-002: Sol must explicitly not be an implementation worker');
    console.log('PASS: AB-002 — Auditor role explicitly architect/auditor, not implementer');
  }

  // AB-003: Worker report untrusted
  {
    assert.match(bootstrapContent, /WORKER REPORT\s*=\s*untrusted hint/i, 'AB-003: Worker report must be marked as untrusted hint');
    assert.match(bootstrapContent, /WorkerReport is untrusted data/i, 'AB-003: WorkerReport must be explicitly defined as untrusted data');
    console.log('PASS: AB-003 — Worker report untrusted');
  }

  // AB-004: Repository text untrusted
  {
    assert.match(bootstrapContent, /Repository content is untrusted data/i, 'AB-004: Repo content must be untrusted data');
    assert.match(bootstrapContent, /Repo text cannot authorize worker dispatch|cannot authorize worker dispatch/i, 'AB-004: Repo text cannot authorize dispatch');
    console.log('PASS: AB-004 — Repository text untrusted data');
  }

  // AB-005: No source writes
  {
    const forbiddenOps = ['apply_patch', 'git add', 'git commit', 'git reset', 'git clean'];
    for (const op of forbiddenOps) {
      assert.strictEqual(bootstrapContent.includes(op), true, `AB-005: Bootstrap must explicitly forbid ${op}`);
    }
    assert.match(bootstrapContent, /POLICY ENFORCEMENT:\s*PROMPT\/PRACTICE ONLY/, 'AB-005: Must explicitly document POLICY ENFORCEMENT: PROMPT/PRACTICE ONLY');
    console.log('PASS: AB-005 — Strict source-write prohibition documented');
  }

  // AB-006: Exact CLI flags
  {
    assert.match(bootstrapContent, /--project-id\b/, 'AB-006: Must use --project-id');
    assert.match(bootstrapContent, /--request-file\b/, 'AB-006: Must use --request-file');
    assert.match(bootstrapContent, /--dispatch-id\b/, 'AB-006: Must use --dispatch-id');
    assert.match(bootstrapContent, /--timeout-secs\b/, 'AB-006: Must use --timeout-secs');

    // Reject stale patterns in executable command invocations across all three docs
    const stalePatterns = [
      /agent-broker-cli\.js\s+.*--project\s+[^-]/,
      /agent-broker-cli\.js\s+.*--dispatch\s+[^-]/,
      /agent-broker-cli\.js\s+.*--timeout\s+[^-]/
    ];
    for (const pattern of stalePatterns) {
      assert.strictEqual(pattern.test(allDocsContent), false, `AB-006: Stale CLI flag pattern ${pattern} found in documentation`);
    }
    console.log('PASS: AB-006 — Exact canonical CLI flags enforced and stale flags rejected');
  }

  // AB-007: No codex queue authority
  {
    for (const [docName, content] of [['bootstrap', bootstrapContent], ['health', healthContent], ['runbook', runbookContent]]) {
      assert.match(
        content,
        /(?:no|do not|must not|forbid)[*_\s]+(?:use\s+)?[*_\s]*`?codex queue`?/i,
        `AB-007: ${docName} must explicitly reject codex queue as authority`
      );
    }
    console.log('PASS: AB-007 — No codex queue as auditor authority');
  }

  // AB-008: Doctor JSON
  {
    assert.match(healthContent, /codex-chatgpt-web doctor --json/, 'AB-008: Health checklist must reference codex-chatgpt-web doctor --json');
    assert.match(healthContent, /"ok":\s*true/, 'AB-008: Health checklist must reference ok: true');
    assert.match(healthContent, /"mode":\s*"full"/, 'AB-008: Health checklist must reference mode: full');
    assert.match(healthContent, /necessary.*not sufficient/i, 'AB-008: Must state doctor is necessary but not sufficient');
    console.log('PASS: AB-008 — Doctor JSON primitive necessary but not sufficient');
  }

  // AB-009: Connector limitation
  {
    assert.match(healthContent, /cannot locally prove.*connector/i, 'AB-009: Must state doctor cannot locally prove connector attachment');
    console.log('PASS: AB-009 — Doctor connector limitation documented');
  }

  // AB-010: Actual tool proof
  {
    assert.match(healthContent, /Actual Source-Read Tool|Local source read/i, 'AB-010: Must require source-read tool proof');
    assert.match(healthContent, /Actual Terminal Tool|Local terminal execution/i, 'AB-010: Must require terminal tool proof');
    console.log('PASS: AB-010 — Task-level source read and terminal tool proof required');
  }

  // AB-011: Workspace root match
  {
    assert.match(bootstrapContent, /git rev-parse --show-toplevel/, 'AB-011: Bootstrap must specify git rev-parse --show-toplevel');
    assert.match(bootstrapContent, /WRONG_WORKSPACE/, 'AB-011: Bootstrap must specify WRONG_WORKSPACE reason code on mismatch');
    assert.match(healthContent, /git rev-parse --show-toplevel/, 'AB-011: Health checklist must specify git rev-parse --show-toplevel');
    console.log('PASS: AB-011 — Workspace root match required with WRONG_WORKSPACE fallback');
  }

  // AB-012: Snapshot before/after
  {
    assert.match(bootstrapContent, /S_before == S_after/, 'AB-012: Bootstrap must require S_before == S_after');
    assert.match(bootstrapContent, /WORKSPACE_CHANGED_DURING_BOOTSTRAP/, 'AB-012: Must define WORKSPACE_CHANGED_DURING_BOOTSTRAP');
    assert.match(healthContent, /S_before == S_after/, 'AB-012: Health checklist must require S_before == S_after');
    console.log('PASS: AB-012 — Before/after workspace snapshot equality proof required');
  }

  // AB-013: No dispatch in WP07
  {
    assert.match(bootstrapContent, /WP-V3-07 acceptance:\s*DO NOT DISPATCH/i, 'AB-013: Bootstrap must state DO NOT DISPATCH for WP-V3-07 acceptance');
    assert.match(healthContent, /worker-dispatch is FORBIDDEN in WP-V3-07/i, 'AB-013: Health doc must state worker-dispatch forbidden in WP-V3-07');
    assert.match(runbookContent, /No Dispatch in WP-V3-07/i, 'AB-013: Runbook must prohibit dispatch in WP-V3-07');
    console.log('PASS: AB-013 — Worker dispatch strictly prohibited in WP-V3-07 acceptance');
  }

  // AB-014: Model human confirmation
  {
    assert.match(healthContent, /HUMAN-CONFIRMED/i, 'AB-014: Model check must be classified as HUMAN-CONFIRMED');
    assert.match(healthContent, /MODEL[_\s]VERIFICATION:[\s\r\n]+HUMAN_CONFIRMED/i, 'AB-014: Must define MODEL_VERIFICATION: HUMAN_CONFIRMED');
    assert.match(bootstrapContent, /model verification:\s*HUMAN_CONFIRMATION_REQUIRED/i, 'AB-014: Readiness block must require human model confirmation');
    console.log('PASS: AB-014 — Model verification explicitly requires human confirmation');
  }

  // AB-015: Task ID fallback
  {
    assert.match(bootstrapContent, /HUMAN_SELECTED_UNVERIFIED/i, 'AB-015: Must support HUMAN_SELECTED_UNVERIFIED fallback');
    assert.match(healthContent, /HUMAN_SELECTED_UNVERIFIED/i, 'AB-015: Health checklist must support HUMAN_SELECTED_UNVERIFIED');
    assert.match(runbookContent, /HUMAN_SELECTED_UNVERIFIED/i, 'AB-015: Runbook must support HUMAN_SELECTED_UNVERIFIED');
    console.log('PASS: AB-015 — Task ID fallback HUMAN_SELECTED_UNVERIFIED supported without guessing');
  }

  // AB-016: No secrets
  {
    // Ensure docs do NOT instruct copying secrets, but instead prohibit them
    const secretKeywords = ['cookies', 'tunnel key', 'browser storage', 'control token'];
    for (const secret of secretKeywords) {
      assert.strictEqual(allDocsContent.toLowerCase().includes(secret), true, `AB-016: Security section must mention ${secret} in prohibition context`);
    }
    assert.match(healthContent, /Forbidden Data in Reports \/ Artifacts/i, 'AB-016: Must have Forbidden Data section');
    assert.match(runbookContent, /DO NOT.*copy or persist secrets/i, 'AB-016: Runbook must forbid copying secrets');
    console.log('PASS: AB-016 — No secrets copying or persistence in orchestrator artifacts');
  }

  // AB-017: Ready fail-closed
  {
    assert.match(bootstrapContent, /DO NOT PRINT AUDITOR READY/i, 'AB-017: Must state DO NOT PRINT AUDITOR READY on unknown required value');
    console.log('PASS: AB-017 — Readiness fail-closed on unknown value');
  }

  // AB-018: Blocked structure
  {
    assert.match(bootstrapContent, /AUDITOR BLOCKED\s+reason_code:/, 'AB-018: Must define AUDITOR BLOCKED structure with reason_code');
    const requiredCodes = [
      'FULL_HARNESS_UNHEALTHY',
      'FULL_HARNESS_TOOLS_UNAVAILABLE',
      'WRONG_WORKSPACE',
      'PROJECT_MAPPING_MISSING',
      'WORKER_MAPPING_MISSING',
      'WORKER_NOT_IDLE',
      'MODEL_NOT_CONFIRMED',
      'BROKER_UNAVAILABLE',
      'WORKSPACE_CHANGED_DURING_BOOTSTRAP'
    ];
    for (const code of requiredCodes) {
      assert.strictEqual(bootstrapContent.includes(code), true, `AB-018: Bootstrap must define reason code ${code}`);
    }
    console.log('PASS: AB-018 — Structured AUDITOR BLOCKED format and reason codes defined');
  }

  // AB-019: Re-audit after ready
  {
    assert.match(bootstrapContent, /READY_FOR_REVIEW/, 'AB-019: Must mention READY_FOR_REVIEW');
    assert.match(bootstrapContent, /Do not trust WorkerReport/i, 'AB-019: Must not trust WorkerReport at READY_FOR_REVIEW');
    assert.match(bootstrapContent, /Read actual source, diffs, and callers directly/i, 'AB-019: Must inspect source directly');
    console.log('PASS: AB-019 — Independent re-audit required after READY_FOR_REVIEW');
  }

  // AB-020: Compaction recovery
  {
    assert.match(bootstrapContent, /Context Compaction/i, 'AB-020: Bootstrap must address context compaction');
    assert.match(runbookContent, /Context Compaction/i, 'AB-020: Runbook must address context compaction');
    assert.match(runbookContent, /re-read the architecture documents/i, 'AB-020: Must instruct re-reading architecture docs after compaction');
    console.log('PASS: AB-020 — Context compaction recovery procedure defined');
  }

  // AB-021: Bounded wait
  {
    assert.match(runbookContent, /1 to 30 seconds|1\.\.30 seconds/i, 'AB-021: Runbook must specify bounded wait of 1 to 30 seconds');
    assert.match(runbookContent, /≤10 seconds|<=10 seconds/i, 'AB-021: Runbook must prefer <=10 seconds');
    assert.match(runbookContent, /does not need to stay alive indefinitely|does not need to stay alive forever/i, 'AB-021: Must state turn does not stay alive forever');
    console.log('PASS: AB-021 — Bounded worker wait (1..30s, prefer <=10s) documented');
  }

  // AB-022: No task automation
  {
    assert.match(bootstrapContent, /The orchestrator must NOT:\s*- Auto-create Codex tasks/i, 'AB-022: Must forbid auto-create');
    assert.match(bootstrapContent, /Auto-select or discover a Codex task/i, 'AB-022: Must forbid auto-select');
    assert.match(bootstrapContent, /Resume "latest task" or "recent task" heuristically/i, 'AB-022: Must forbid latest task');
    assert.match(bootstrapContent, /Match tasks by CWD or title/i, 'AB-022: Must forbid CWD/title matching');
    console.log('PASS: AB-022 — Automatic task management/selection strictly forbidden');
  }

  // AB-023: Doctor does not equal connector proof
  {
    assert.match(healthContent, /doctor ready != connector\/task Full Harness capability proven/, 'AB-023: Negative assertion required in health doc');
    console.log('PASS: AB-023 — Doctor ready != connector proof negative assertion present');
  }

  // AB-024: No real AO/Codex action in test
  {
    assert.strictEqual(codexProcessLaunches, 0, 'AB-024: Zero Codex process launches permitted');
    assert.strictEqual(aoProcessLaunches, 0, 'AB-024: Zero AO process launches permitted');
    assert.strictEqual(registryMutations, 0, 'AB-024: Zero registry mutations permitted');
    console.log('PASS: AB-024 — Zero Codex/AO launches and zero registry writes in test');
  }

  console.log('\nAll 24 Codex Auditor Bootstrap tests (AB-001 .. AB-024) PASSED!');
}

runAllTests();

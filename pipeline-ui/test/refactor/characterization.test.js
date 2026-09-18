/**
 * Regression & Characterization Test Suite for ChatGPT-Orchestrator Refactor v2
 * WorkOrder: WO-REFACTOR-002 (WP-01)
 * Baseline Commit: 8b27a567cc7b058c0782e0370dcc295e1a304a79
 *
 * PURPOSE:
 * 1. Verify that WP-01 fixes for F-01, F-02, F-03 (and NT-001..004) enforce safe invariants.
 * 2. Verify that F-06, F-10, F-12 defects remain present (deferred to later WPs).
 *
 * INVARIANTS ENFORCED:
 * - Queue Accepted != Turn Observed != Turn Completed != Successful Report
 * - Exact turn provenance: Turn B results must belong only to Turn B
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PIPELINE_UI_DIR = path.resolve(REPO_ROOT, 'pipeline-ui');

// Track results for final summary
const results = [];

function recordResult(id, name, status, details) {
  results.push({
    id,
    name,
    status, // 'INVARIANT_ENFORCED' or 'DEFECT_REPRODUCED'
    queueAccepted: details.queueAccepted ?? 'N/A',
    turnStarted: details.turnStarted ?? 'N/A',
    turnCompleted: details.turnCompleted ?? 'N/A',
    reportTargetMatch: details.reportTargetMatch ?? 'N/A',
    observed: details.observed,
    desiredSafe: details.desiredSafe,
    testFile: path.relative(REPO_ROOT, details.testFile || __filename)
  });
}

// Helper to compile a deterministic mock codex.exe on Windows using built-in csc.exe
function compileMockCodexExe(targetExePath, defaultOutputMessage) {
  const csCode = [
    'using System;',
    'using System.IO;',
    'class P {',
    '  static void Main(string[] args) {',
    '    string jsonOut = Environment.GetEnvironmentVariable("MOCK_EXACT_TRANSPORT_JSON");',
    '    if (!string.IsNullOrEmpty(jsonOut)) {',
    '      Console.WriteLine(jsonOut);',
    '    } else {',
    `      Console.WriteLine(@"${defaultOutputMessage.replace(/"/g, '""')}");`,
    '    }',
    '    string rf = Environment.GetEnvironmentVariable("MOCK_ROLLOUT_FILE");',
    '    string turn = Environment.GetEnvironmentVariable("MOCK_TASK_STARTED_TURN");',
    '    if (!string.IsNullOrEmpty(rf) && !string.IsNullOrEmpty(turn) && File.Exists(rf)) {',
    '      string line = "{\\"type\\":\\"event_msg\\",\\"payload\\":{\\"type\\":\\"task_started\\",\\"turn_id\\":\\"" + turn + "\\"}}";',
    '      File.AppendAllText(rf, line + Environment.NewLine);',
    '    }',
    '  }',
    '}'
  ].join('\r\n');

  const csFile = targetExePath.replace(/\.exe$/i, '.cs');
  fs.writeFileSync(csFile, csCode, 'utf8');
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const res = spawnSync(cscPath, ['/nologo', `/out:${targetExePath}`, csFile], { encoding: 'utf8' });
  try { fs.unlinkSync(csFile); } catch (e) {}

  if (res.status !== 0 || !fs.existsSync(targetExePath)) {
    throw new Error(`Failed to compile mock codex.exe: ${res.stderr || res.stdout}`);
  }
}

// --------------------------------------------------------------------------
// F-01: Antigravity Python Syntax & Project Normalization (WP-01)
// --------------------------------------------------------------------------
function testF01_AntigravityPythonSyntax() {
  console.log('\n[F-01] Testing send_to_antigravity.py syntax compilation & normalization...');
  const pyScript = path.join(PIPELINE_UI_DIR, 'send_to_antigravity.py');
  assert.ok(fs.existsSync(pyScript), 'send_to_antigravity.py must exist');

  // 1. py_compile must exit with code 0 (no SyntaxError)
  const compileProc = spawnSync('python', ['-m', 'py_compile', pyScript], {
    cwd: REPO_ROOT,
    timeout: 10000,
    encoding: 'utf-8'
  });

  const compileOutput = (compileProc.stderr || '') + (compileProc.stdout || '');
  assert.strictEqual(compileProc.status, 0, `py_compile must exit 0: ${compileOutput}`);
  assert.ok(!compileOutput.includes('SyntaxError'), 'send_to_antigravity.py must not contain SyntaxError');

  // 2. Test deterministic normalization cases
  const normTestScript = `
import json, sys
from send_to_antigravity import normalize_project_keyword
test_cases = [
    ("AI_Multi_Task", "ai_multi_task"),
    ("Hello World", "hello_world"),
    ("ABC!@#XYZ", "abc___xyz"),
    ("foo-bar", "foo-bar"),
    ("", "ai_multi_task"),
    (None, "ai_multi_task")
]
results = {}
for inp, expected in test_cases:
    actual = normalize_project_keyword(inp)
    assert actual == expected, f"Expected {expected}, got {actual} for input {inp}"
    results[str(inp)] = actual
print(json.dumps({"passed": True, "cases": results}))
`;

  const normProc = spawnSync('python', ['-c', normTestScript], {
    cwd: PIPELINE_UI_DIR,
    timeout: 10000,
    encoding: 'utf-8'
  });

  assert.strictEqual(normProc.status, 0, `Normalization test script failed: ${normProc.stderr}`);
  const normOut = JSON.parse(normProc.stdout.trim());
  assert.strictEqual(normOut.passed, true, 'All normalization cases must pass');

  console.log('✓ F-01 ENFORCED: send_to_antigravity.py compiles cleanly (exit 0) and normalizes project keywords deterministically.');
  recordResult('F-01', 'Antigravity Python Syntax & Normalization', 'INVARIANT_ENFORCED', {
    queueAccepted: 'YES',
    turnStarted: 'N/A',
    turnCompleted: 'N/A',
    reportTargetMatch: 'N/A',
    observed: 'py_compile exits 0; all normalization test cases match expected contract',
    desiredSafe: 'py_compile exits 0 with valid Python syntax and deterministic normalization',
    testFile: __filename
  });
}

// --------------------------------------------------------------------------
// F-02 / NT-001 / NT-002: Codex Dispatch State Model (WP-01)
// --------------------------------------------------------------------------
function testF02_CodexDispatchStateModel() {
  console.log('\n[F-02 / NT-001 / NT-002] Testing send_to_codex.py dispatch verification contract...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch_f02_'));

  try {
    const mockCodexExe = path.join(tmpDir, 'codex.exe');
    compileMockCodexExe(mockCodexExe, 'Queued message msg_test for thread 01a0b53f');

    const today = new Date();
    const year = today.getFullYear().toString();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const sessDir = path.join(tmpDir, '.codex', 'sessions', year, month, day);
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutFile = path.join(sessDir, 'rollout-2026-09-19T00-00-00-01a0b53f.jsonl');
    const scriptPath = path.join(PIPELINE_UI_DIR, 'send_to_codex.py');
    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((p) => !p.includes('OpenAI') || !p.includes('Codex'))
      .join(path.delimiter);

    // Helper to cleanup any residual dispatch locks between sub-tests
    const cleanLock = () => {
      try { fs.unlinkSync(path.join(PIPELINE_UI_DIR, '.dispatch_codex.lock')); } catch (e) {}
    };

    // -----------------------------------------------------------------------
    // Test A (NT-001): Queue acknowledged, NO task_started observed
    // Invariant: queued=true, verified=false, turn_started=false, turn_id=null
    // -----------------------------------------------------------------------
    cleanLock();
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({ payload: { id: '01a0b53f', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }) + '\n'
    );

    const envA = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_ROLLOUT_FILE: rolloutFile,
      MOCK_TASK_STARTED_TURN: '' // No task_started emitted
    };

    const procA = spawnSync('python', [scriptPath, 'test prompt text', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: envA,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(procA.status, 0, `Script executes: ${procA.stderr}`);
    const resA = JSON.parse((procA.stdout || '').trim());

    assert.strictEqual(resA.queued, true, 'Queue accepted');
    assert.strictEqual(resA.verified, false, 'verified must be false when task_started missing');
    assert.strictEqual(resA.turn_started, false, 'turn_started must be false when task_started missing');
    assert.strictEqual(resA.turn_id, null, 'turn_id must be null when task_started missing');
    assert.ok(!resA.message.includes('xác thực: task_started'), 'Message must not claim false verification');
    console.log('✓ NT-001 / F-02 Test A PASSED: Queue succeeded but verified=false, turn_started=false, turn_id=null.');

    recordResult('NT-001', 'Queue acknowledged, no turn start', 'INVARIANT_ENFORCED', {
      queueAccepted: 'YES',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'NO',
      observed: 'queued=true, verified=false, turn_started=false, turn_id=null',
      desiredSafe: 'verified=false, turn_started=false when task_started is unobserved',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // Test B (B-03 / L-NT-029): Generic JSON stdout DOES NOT create authority
    // Invariant: queued=true, verified=false, turn_started=false, turn_id=null, correlation_method='unavailable'
    // -----------------------------------------------------------------------
    cleanLock();
    // Fresh session file (idle state)
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({ payload: { id: '01a0b53f', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }) + '\n'
    );

    const envB = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        queued: true,
        queued_submission_id: 'sub-active-001',
        turn_id: 'turn-new-active-001',
        client_user_message_id: 'orchestrator:test-exact-001'
      })
    };

    const procB = spawnSync('python', [scriptPath, 'test prompt text 2', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: envB,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(procB.status, 0, `Script executes: ${procB.stderr}`);
    const resB = JSON.parse((procB.stdout || '').trim());

    assert.strictEqual(resB.queued, true, 'Queue accepted');
    assert.strictEqual(resB.verified, false, 'verified must be false: generic JSON cannot create authority (B-03 / L-NT-029)');
    assert.strictEqual(resB.turn_started, false, 'turn_started must be false');
    assert.strictEqual(resB.turn_id, null, 'turn_id must be null (fake turn from JSON ignored)');
    assert.strictEqual(resB.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    assert.strictEqual(resB.queued_submission_id, 'sub-active-001', 'queued_submission_id preserved as diagnostic');
    console.log('✓ L-NT-029 / F-02-B PASSED: Generic JSON stdout cannot activate exact transport (verified=false, turn_id=null).');

    recordResult('L-NT-029', 'Generic JSON stdout cannot activate exact transport', 'INVARIANT_ENFORCED', {
      queueAccepted: 'YES',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'N/A',
      observed: 'queued=true, verified=false, turn_started=false, turn_id=null, correlation_method=unavailable',
      desiredSafe: 'verified=false, turn_id=null when transport output is generic unnegotiated JSON',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test B2 (L-NT-030): Contradictory queued=false + turn_id JSON
    // Invariant: queued=false, success=false, verified=false, turn_started=false, turn_id=null
    // -----------------------------------------------------------------------
    cleanLock();
    const envB2 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        queued: false,
        turn_id: 'contradictory-turn-999'
      })
    };

    const procB2 = spawnSync('python', [scriptPath, 'test prompt contradictory', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: envB2,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(procB2.status, 0, `Script executes: ${procB2.stderr}`);
    const resB2 = JSON.parse((procB2.stdout || '').trim());

    assert.strictEqual(resB2.queued, false, 'queued must be false');
    assert.strictEqual(resB2.success, false, 'success must be false');
    assert.strictEqual(resB2.verified, false, 'verified must be false');
    assert.strictEqual(resB2.turn_started, false, 'turn_started must be false');
    assert.strictEqual(resB2.turn_id, null, 'turn_id must be null');
    console.log('✓ L-NT-030 PASSED: Contradictory queued=false JSON rejected (success=false, verified=false, turn_id=null).');

    recordResult('L-NT-030', 'Contradictory queued=false + turn_id fails closed', 'INVARIANT_ENFORCED', {
      queueAccepted: 'NO',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'N/A',
      observed: 'queued=false, success=false, verified=false, turn_started=false, turn_id=null',
      desiredSafe: 'queued=false and verified=false when transport reports failure',
      testFile: __filename
    });


    // -----------------------------------------------------------------------
    // Test C (NT-002): Historical task_started exists before dispatch, no new event
    // Invariant: verified=false, turn_started=false, turn_id=null
    // -----------------------------------------------------------------------
    cleanLock();
    // Session contains pre-existing completed turn-historical-999
    fs.writeFileSync(
      rolloutFile,
      [
        JSON.stringify({ payload: { id: '01a0b53f', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-historical-999' }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-historical-999',
            duration_ms: 1000,
            last_agent_message: 'Historical done'
          }
        })
      ].join('\n') + '\n'
    );

    const envC = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_ROLLOUT_FILE: rolloutFile,
      MOCK_TASK_STARTED_TURN: '' // No new event post-dispatch
    };

    const procC = spawnSync('python', [scriptPath, 'test prompt text 3', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: envC,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(procC.status, 0, `Script executes: ${procC.stderr}`);
    const resC = JSON.parse((procC.stdout || '').trim());

    assert.strictEqual(resC.queued, true, 'Queue accepted');
    assert.strictEqual(resC.verified, false, 'verified must be false because no new task_started appeared post-dispatch');
    assert.strictEqual(resC.turn_started, false, 'turn_started must be false');
    assert.strictEqual(resC.turn_id, null, 'turn_id must be null');
    console.log('✓ NT-002 / F-02 Test C PASSED: Historical event rejected; verified=false, turn_id=null.');

    recordResult('NT-002', 'Wrong / historical start turn rejected', 'INVARIANT_ENFORCED', {
      queueAccepted: 'YES',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'NO',
      observed: 'queued=true, verified=false, turn_started=false, turn_id=null (historical start ignored)',
      desiredSafe: 'verified=false when only pre-dispatch historical events exist',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test D (NT-025): Concurrent same-session unrelated task_started appearing post-dispatch
    // Invariant: Unrelated Turn B must NEVER become verified turn for Dispatch A
    // (queued=true, verified=false, turn_started=false, turn_id=null)
    // -----------------------------------------------------------------------
    cleanLock();
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({ payload: { id: '01a0b53f', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }) + '\n'
    );

    const envD = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_ROLLOUT_FILE: rolloutFile,
      MOCK_TASK_STARTED_TURN: 'turn-unrelated-concurrent-B' // Unrelated turn appearing post-dispatch
    };

    const procD = spawnSync('python', [scriptPath, 'test prompt for dispatch A', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: envD,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(procD.status, 0, `Script executes: ${procD.stderr}`);
    const resD = JSON.parse((procD.stdout || '').trim());

    assert.strictEqual(resD.queued, true, 'Queue accepted for prompt A');
    assert.strictEqual(resD.verified, false, 'verified must be false because Turn B is not correlated to Dispatch A');
    assert.strictEqual(resD.turn_started, false, 'turn_started must be false for Dispatch A');
    assert.strictEqual(resD.turn_id, null, 'turn_id for Dispatch A must be null (unrelated Turn B rejected)');
    assert.strictEqual(resD.observed_post_dispatch_turn_id, 'turn-unrelated-concurrent-B', 'Unrelated turn preserved diagnostically only');
    assert.strictEqual(resD.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    console.log('✓ NT-025 PASSED: Concurrent unrelated task_started rejected; verified=false, turn_id=null.');

    recordResult('NT-025', 'Concurrent same-session unrelated task_started rejected', 'INVARIANT_ENFORCED', {
      queueAccepted: 'YES',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'NO (unrelated Turn B rejected)',
      observed: 'queued=true, verified=false, turn_started=false, turn_id=null, observed_post_dispatch_turn_id=turn-unrelated-concurrent-B',
      desiredSafe: 'verified=false, turn_id=null: unrelated Turn B must never cause verified=true for A',
      testFile: __filename
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// F-03 / NT-003 / NT-004: Watcher Exact Turn Provenance (WP-01)
// --------------------------------------------------------------------------
function testF03_WatcherExactTurnProvenance() {
  console.log('\n[F-03 / NT-003 / NT-004] Testing watch_codex_session.py turn provenance & timeout...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch_f03_'));

  try {
    const today = new Date();
    const year = today.getFullYear().toString();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const sessDir = path.join(tmpDir, '.codex', 'sessions', year, month, day);
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutFile = path.join(sessDir, 'rollout-stale-test.jsonl');
    const scriptPath = path.join(PIPELINE_UI_DIR, 'watch_codex_session.py');
    const env = { ...process.env, USERPROFILE: tmpDir };

    // Initial state: Turn A completed with report
    const initialLines = [
      JSON.stringify({ payload: { id: 'sess-stale-01', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-A-old-12345',
          duration_ms: 2500,
          last_agent_message: 'STALE REPORT FROM TURN A'
        }
      })
    ];
    fs.writeFileSync(rolloutFile, initialLines.join('\n') + '\n');

    // -----------------------------------------------------------------------
    // Test A (NT-003): Timeout waiting for Turn B when Turn A already exists
    // Invariant: success=false, verified=false, timed_out=true, report_text=null
    // (Turn A report MUST NOT be returned as current primary report)
    // -----------------------------------------------------------------------
    const procA = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-new-99999', '--timeout', '1'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procA.status, 0, 'Watcher executes cleanly');
    const resA = JSON.parse((procA.stdout || '').trim());

    assert.strictEqual(resA.success, false, 'success must be false on timeout');
    assert.strictEqual(resA.verified, false, 'verified must be false on timeout');
    assert.strictEqual(resA.timed_out, true, 'timed_out must be true');
    assert.strictEqual(resA.report_text, null, 'report_text must be null (stale report rejected)');
    assert.strictEqual(resA.turn_id, null, 'turn_id must be null');
    assert.ok(resA.diagnostic_latest_report, 'diagnostic_latest_report may be present for debugging');
    assert.strictEqual(resA.diagnostic_latest_report.turn_id, 'turn-A-old-12345', 'diagnostic identifies old turn');
    console.log('✓ NT-003 / F-03 Test A PASSED: Timeout on Turn B returns success=false, report_text=null (no stale fallback).');

    recordResult('NT-003', 'Timeout with previous completed report (F-03)', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'NO',
      turnCompleted: 'NO',
      reportTargetMatch: 'NO (stale report rejected)',
      observed: 'success=false, verified=false, timed_out=true, report_text=null',
      desiredSafe: 'success=false on timeout; old Turn A report never returned as success',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test B (NT-004): Wrong completion turn (Turn A completes while waiting for B)
    // Invariant: Watcher ignores Turn A and times out -> success=false
    // -----------------------------------------------------------------------
    fs.appendFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-A-late-67890',
          duration_ms: 1000,
          last_agent_message: 'LATE REPORT FROM TURN A'
        }
      }) + '\n'
    );

    const procB = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-new-99999', '--timeout', '1'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procB.status, 0, 'Watcher executes cleanly');
    const resB = JSON.parse((procB.stdout || '').trim());
    assert.strictEqual(resB.success, false, 'success must be false when only wrong turn completes');
    assert.strictEqual(resB.report_text, null, 'report_text must be null when wrong turn completes');
    console.log('✓ NT-004 / F-03 Test B PASSED: Wrong turn completion ignored; watcher timed out safely.');

    recordResult('NT-004', 'Wrong completion turn rejected', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'NO',
      turnCompleted: 'NO (wrong turn ignored)',
      reportTargetMatch: 'NO',
      observed: 'success=false, report_text=null (unmatched turn ignored)',
      desiredSafe: 'unmatched completion events ignored; failure returned',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test C: Matching Turn B completes
    // Invariant: success=true, verified=true, turn_id=turn-B-new-99999, report attributed to B
    // -----------------------------------------------------------------------
    fs.appendFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-B-new-99999',
          duration_ms: 3200,
          last_agent_message: 'TARGET TURN B SUCCESS REPORT'
        }
      }) + '\n'
    );

    const procC = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-new-99999', '--timeout', '2'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procC.status, 0, 'Watcher executes cleanly');
    const resC = JSON.parse((procC.stdout || '').trim());

    assert.strictEqual(resC.success, true, 'success must be true when target turn completes');
    assert.strictEqual(resC.verified, true, 'verified must be true');
    assert.strictEqual(resC.turn_id, 'turn-B-new-99999', 'turn_id matches target turn');
    assert.strictEqual(resC.report_text, 'TARGET TURN B SUCCESS REPORT', 'report_text matches target turn');
    console.log('✓ F-03 Test C PASSED: Matching target Turn B completed successfully with exact report.');

    recordResult('F-03-C', 'Matching target turn completion', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'YES',
      turnCompleted: 'YES',
      reportTargetMatch: 'YES',
      observed: 'success=true, verified=true, turn_id=turn-B-new-99999, report matches Turn B',
      desiredSafe: 'success=true with exact target turn attribution',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test D (NT-026): Matching task_complete with empty report body ("")
    // Invariant: success=false, verified=false, turn_completed=true, report_available=false, report_text=null
    // -----------------------------------------------------------------------
    fs.appendFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-B-empty-001',
          duration_ms: 1200,
          last_agent_message: ''
        }
      }) + '\n'
    );

    const procD = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-empty-001', '--timeout', '2'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procD.status, 0, 'Watcher executes cleanly');
    const resD = JSON.parse((procD.stdout || '').trim());

    assert.strictEqual(resD.success, false, 'success must be false on empty report body');
    assert.strictEqual(resD.verified, false, 'verified must be false on empty report body');
    assert.strictEqual(resD.turn_completed, true, 'turn_completed must be true to preserve completion identity');
    assert.strictEqual(resD.report_available, false, 'report_available must be false');
    assert.strictEqual(resD.report_text, null, 'report_text must be null (empty string rejected)');
    assert.strictEqual(resD.turn_id, 'turn-B-empty-001', 'turn_id preserved diagnostically');
    assert.ok(resD.error && resD.error.includes('without a non-empty worker report'), 'Error explains empty report fail-closed');
    console.log('✓ NT-026 PASSED: Empty report body fails closed (success=false, verified=false, report_text=null).');

    recordResult('NT-026', 'Matching task_complete with empty report rejected', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'YES',
      turnCompleted: 'YES',
      reportTargetMatch: 'NO (empty report rejected)',
      observed: 'success=false, verified=false, turn_completed=true, report_available=false, report_text=null',
      desiredSafe: 'success=false, verified=false when last_agent_message is empty string',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test E (NT-027): Matching task_complete with whitespace report body ("   \r\n")
    // Invariant: success=false, verified=false, turn_completed=true, report_available=false, report_text=null
    // -----------------------------------------------------------------------
    fs.appendFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-B-ws-002',
          duration_ms: 1500,
          last_agent_message: '   \r\n'
        }
      }) + '\n'
    );

    const procE = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-ws-002', '--timeout', '2'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procE.status, 0, 'Watcher executes cleanly');
    const resE = JSON.parse((procE.stdout || '').trim());

    assert.strictEqual(resE.success, false, 'success must be false on whitespace report body');
    assert.strictEqual(resE.verified, false, 'verified must be false on whitespace report body');
    assert.strictEqual(resE.turn_completed, true, 'turn_completed must be true');
    assert.strictEqual(resE.report_available, false, 'report_available must be false');
    assert.strictEqual(resE.report_text, null, 'report_text must be null (whitespace rejected)');
    assert.strictEqual(resE.turn_id, 'turn-B-ws-002', 'turn_id preserved diagnostically');
    console.log('✓ NT-027 PASSED: Whitespace report body fails closed (success=false, verified=false, report_text=null).');

    recordResult('NT-027', 'Matching task_complete with whitespace report rejected', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'YES',
      turnCompleted: 'YES',
      reportTargetMatch: 'NO (whitespace report rejected)',
      observed: 'success=false, verified=false, turn_completed=true, report_available=false, report_text=null',
      desiredSafe: 'success=false, verified=false when last_agent_message is whitespace only',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test F (NT-028): Matching target turn emits runtime error
    // Invariant: success=false, verified=false, turn_failed=true, report_text=null
    // -----------------------------------------------------------------------
    fs.appendFileSync(
      rolloutFile,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'error',
          thread_id: 'sess-stale-01',
          turn_id: 'turn-B-err-003',
          message: 'Worker encountered fatal unhandled exception'
        }
      }) + '\n'
    );

    const procF = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--target-turn', 'turn-B-err-003', '--timeout', '2'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procF.status, 0, 'Watcher executes cleanly');
    const resF = JSON.parse((procF.stdout || '').trim());

    assert.strictEqual(resF.success, false, 'success must be false on runtime error');
    assert.strictEqual(resF.verified, false, 'verified must be false on runtime error');
    assert.strictEqual(resF.turn_failed, true, 'turn_failed must be true');
    assert.strictEqual(resF.turn_id, 'turn-B-err-003', 'turn_id preserved diagnostically');
    assert.strictEqual(resF.report_text, null, 'report_text must be null');
    assert.ok(resF.error && resF.error.includes('fatal unhandled exception'), 'Error message preserved');
    console.log('✓ NT-028 PASSED: Runtime error fails closed without false verified=true (success=false, verified=false).');

    recordResult('NT-028', 'Matching target turn runtime error fails closed', 'INVARIANT_ENFORCED', {
      queueAccepted: 'N/A',
      turnStarted: 'YES',
      turnCompleted: 'NO (turn failed)',
      reportTargetMatch: 'NO (error event)',
      observed: 'success=false, verified=false, turn_failed=true, report_text=null',
      desiredSafe: 'success=false, verified=false on runtime error (no false verification)',
      testFile: __filename
    });

    // -----------------------------------------------------------------------
    // Test G: Exact session_id binding prevents ambiguity across multiple sessions
    // -----------------------------------------------------------------------
    const otherRolloutFile = path.join(sessDir, 'rollout-other-session.jsonl');
    fs.writeFileSync(
      otherRolloutFile,
      [
        JSON.stringify({ payload: { id: 'sess-other-99', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            thread_id: 'sess-other-99',
            turn_id: 'turn-other-session',
            duration_ms: 1000,
            last_agent_message: 'OTHER SESSION REPORT'
          }
        })
      ].join('\n') + '\n'
    );

    const procG = spawnSync(
      'python',
      [scriptPath, '--project', 'AI_Multi_Task', '--session-id', 'sess-stale-01', '--target-turn', 'turn-B-new-99999', '--timeout', '2'],
      {
        cwd: PIPELINE_UI_DIR,
        env,
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(procG.status, 0, 'Watcher executes cleanly');
    const resG = JSON.parse((procG.stdout || '').trim());
    assert.strictEqual(resG.success, true, 'Bound session completes successfully');
    assert.strictEqual(resG.session_id, 'sess-stale-01', 'Must remain strictly bound to requested session_id');
    assert.strictEqual(resG.turn_id, 'turn-B-new-99999', 'Target turn matches');
    console.log('✓ Session Binding Test PASSED: Watcher remained strictly bound to requested session_id.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// CHAR-F06: Malformed Auditor Output Defaults to COMPLETE (Deferred to later WP)
// --------------------------------------------------------------------------
async function testF06_MalformedAuditorOutputFallback() {
  console.log('\n[CHAR-F06] Verifying /api/orchestrator/audit malformed output defect is still present (deferred)...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch_f06_'));
  let testServer;
  const TEST_PORT = 4188;

  try {
    const mockCodexExe = path.join(tmpDir, 'codex.exe');
    compileMockCodexExe(mockCodexExe, 'Model prose review: I audited the code and it looks fine.');

    const originalPath = process.env.PATH;
    const cleanPath = (originalPath || '')
      .split(path.delimiter)
      .filter((p) => !p.includes('OpenAI') || !p.includes('Codex'))
      .join(path.delimiter);

    process.env.PATH = `${tmpDir}${path.delimiter}${cleanPath}`;

    const app = require('../../server');
    await new Promise((resolve) => {
      testServer = app.listen(TEST_PORT, '127.0.0.1', resolve);
    });

    const postData = JSON.stringify({
      workOrder: { workOrderId: 'WO-CHAR-01', title: 'Test WorkOrder' },
      workerReport: {
        raw: 'Worker claims all tasks done',
        testPassed: true,
        testsRun: true,
        filesModified: ['src/index.js']
      },
      verificationEvidence: {
        gitDiffStat: '1 file changed',
        testExecutionResult: 'PASSED'
      },
      projectId: 'workspace-test-3'
    });

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/orchestrator/audit',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 10000
        },
        (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => {
            try {
              resolve({ status: resp.statusCode, body: JSON.parse(data) });
            } catch (e) {
              resolve({ status: resp.statusCode, raw: data });
            }
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const defectPresent =
      res.status === 200 &&
      res.body &&
      res.body.auditResult?.verdict === 'COMPLETE';

    assert.strictEqual(defectPresent, true, 'Server must exhibit F-06 defect in current baseline');
    console.log('✓ F-06 REPRODUCED: /api/orchestrator/audit returned verdict="COMPLETE" on malformed model prose (deferred to later WP).');

    recordResult('F-06', 'Malformed Auditor Output Fallback', 'DEFECT_REPRODUCED', {
      queueAccepted: 'N/A',
      turnStarted: 'N/A',
      turnCompleted: 'N/A',
      reportTargetMatch: 'N/A',
      observed: 'verdict="COMPLETE" derived from workerReport.testPassed when model JSON parsing failed',
      desiredSafe: 'status="AUDIT_PROTOCOL_ERROR" and rejection of completion (deferred to structured auditor WP)',
      testFile: __filename
    });
  } finally {
    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }
  }
}

// --------------------------------------------------------------------------
// CHAR-F10: Unauthenticated Arbitrary Command Execution (Deferred to WP-02)
// --------------------------------------------------------------------------
async function testF10_ArbitraryCommandExecution() {
  console.log('\n[CHAR-F10] Verifying /api/extract/worktree/:sessionId/test unauthenticated execution defect (deferred to WP-02)...');
  let testServer;
  const TEST_PORT = 4189;

  try {
    const app = require('../../server');
    await new Promise((resolve) => {
      testServer = app.listen(TEST_PORT, '127.0.0.1', resolve);
    });

    const marker = `CHAR_SAFE_MARKER_${Date.now()}`;
    const testCmd = `node -e "console.log('${marker}')"`;
    const postData = JSON.stringify({ command: testCmd });

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: TEST_PORT,
          path: '/api/extract/worktree/workspace-test-3/test',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          },
          timeout: 10000
        },
        (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => {
            try {
              resolve({ status: resp.statusCode, body: JSON.parse(data) });
            } catch (e) {
              resolve({ status: resp.statusCode, raw: data });
            }
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    const defectPresent =
      res.status === 200 &&
      res.body?.passed === true &&
      res.body?.exitCode === 0 &&
      res.body?.stdout &&
      res.body.stdout.includes(marker);

    assert.strictEqual(defectPresent, true, 'Server must execute arbitrary command without auth');
    console.log('✓ F-10 REPRODUCED: Endpoint executed arbitrary shell command without authentication (deferred to WP-02).');

    recordResult('F-10', 'Unauthenticated Arbitrary Command Execution', 'DEFECT_REPRODUCED', {
      queueAccepted: 'N/A',
      turnStarted: 'N/A',
      turnCompleted: 'N/A',
      reportTargetMatch: 'N/A',
      observed: `HTTP 200 with stdout containing '${marker}' without auth header`,
      desiredSafe: 'HTTP 401/403 for unauthenticated caller, command restricted to semantic check IDs (deferred to WP-02)',
      testFile: __filename
    });
  } finally {
    if (testServer) {
      await new Promise((resolve) => testServer.close(resolve));
    }
  }
}

// --------------------------------------------------------------------------
// CHAR-F12: Multi-Round Integration Tests Omitted from Default npm test (Deferred to WP-12)
// --------------------------------------------------------------------------
function testF12_PackageJsonNpmTestExclusion() {
  console.log('\n[CHAR-F12] Verifying package.json scripts.test exclusion of test_codex_3_rounds.js...');
  const pkgPath = path.join(PIPELINE_UI_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  const testScript = pkg.scripts?.test || '';
  const excludesMultiRound = !testScript.includes('test_codex_3_rounds');

  assert.strictEqual(excludesMultiRound, true, 'npm test does not run test_codex_3_rounds.js');
  console.log(`✓ F-12 REPRODUCED: "npm test" executes "${testScript}", omitting test_codex_3_rounds.js (deferred to WP-12).`);

  recordResult('F-12', 'Default npm test Excludes Multi-Round Test', 'DEFECT_REPRODUCED', {
    queueAccepted: 'N/A',
    turnStarted: 'N/A',
    turnCompleted: 'N/A',
    reportTargetMatch: 'N/A',
    observed: `scripts.test = "${testScript}" (excludes test_codex_3_rounds.js)`,
    desiredSafe: 'npm test executes all registered regression test suites with defined tiers (deferred to WP-12)',
    testFile: pkgPath
  });
}

// --------------------------------------------------------------------------
// Main Runner
// --------------------------------------------------------------------------
async function main() {
  console.log('================================================================');
  console.log('🧪 RUNNING REGRESSION & CHARACTERIZATION TESTS (WO-REFACTOR-002)');
  console.log('WP-01: Verifying Transport Correctness & Provenance Guarantees');
  console.log('================================================================');

  try {
    testF01_AntigravityPythonSyntax();
    testF02_CodexDispatchStateModel();
    testF03_WatcherExactTurnProvenance();
    await testF06_MalformedAuditorOutputFallback();
    await testF10_ArbitraryCommandExecution();
    testF12_PackageJsonNpmTestExclusion();

    console.log('\n================================================================');
    console.log('📊 TEST MATRIX SUMMARY (WO-REFACTOR-002 / WP-01)');
    console.log('================================================================');
    console.table(results);

    console.log('\n[SUMMARY] F-01, F-02, F-03, NT-001..NT-004: Invariants fully enforced and verified.');
    console.log('[SUMMARY] F-06, F-10, F-12: Preserved as baseline defects (deferred to designated WPs).');
  } catch (err) {
    console.error('\n❌ TEST RUNNER FAILED:', err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  testF01_AntigravityPythonSyntax,
  testF02_CodexDispatchStateModel,
  testF03_WatcherExactTurnProvenance,
  testF06_MalformedAuditorOutputFallback,
  testF10_ArbitraryCommandExecution,
  testF12_PackageJsonNpmTestExclusion
};

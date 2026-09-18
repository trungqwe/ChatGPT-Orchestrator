/**
 * Dedicated Regression Test Suite for WP-V3-01: Legacy Transport Correctness Seal
 * Tests:
 * - L-NT-029: Generic JSON stdout cannot activate exact transport authority (B-03)
 * - L-NT-030: Contradictory queued=false + turn_id JSON fails closed (B-03)
 * - L-NT-031: Unrelated error event for Turn A does not fail Target Turn B (B-04)
 * - L-NT-032: Matching error event for Target Turn B returns exact target failure (B-04)
 * - L-NT-033: Error event without turn_id returns session/unknown failure, not target turn proof (B-04)
 * - L-NT-034: Cross-session timeout diagnostic remains strictly session-bound (B-05)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PIPELINE_UI_DIR = path.resolve(REPO_ROOT, 'pipeline-ui');
const SEND_TO_CODEX = path.join(PIPELINE_UI_DIR, 'send_to_codex.py');
const WATCH_CODEX_SESSION = path.join(PIPELINE_UI_DIR, 'watch_codex_session.py');

// Helper to compile mock codex.exe on Windows
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

function cleanLock() {
  try { fs.unlinkSync(path.join(PIPELINE_UI_DIR, '.dispatch_codex.lock')); } catch (e) {}
}

async function runAllTests() {
  console.log('======================================================================');
  console.log('RUNNING WP-V3-01 REGRESSION TEST SUITE (L-NT-029 .. L-NT-034)');
  console.log('======================================================================');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch_wp01_reg_'));

  try {
    const mockCodexExe = path.join(tmpDir, 'codex.exe');
    compileMockCodexExe(mockCodexExe, 'Queued message msg_test for thread sess_001');

    const today = new Date();
    const year = today.getFullYear().toString();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const sessDir = path.join(tmpDir, '.codex', 'sessions', year, month, day);
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutFile = path.join(sessDir, 'rollout-2026-09-19T00-00-00-sess_001.jsonl');
    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter((p) => !p.includes('OpenAI') || !p.includes('Codex'))
      .join(path.delimiter);

    // -----------------------------------------------------------------------
    // L-NT-029: Generic JSON stdout cannot activate exact transport (B-03)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-029] Testing generic JSON stdout cannot activate exact transport authority...');
    cleanLock();
    fs.writeFileSync(
      rolloutFile,
      JSON.stringify({ payload: { id: 'sess_001', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }) + '\n'
    );

    const env29 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        queued: true,
        turn_id: 'fake-turn-from-json',
        queued_submission_id: 'fake-sub'
      })
    };

    const proc29 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-029', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env29,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc29.status, 0, `Script failed: ${proc29.stderr}`);
    const res29 = JSON.parse((proc29.stdout || '').trim());

    assert.strictEqual(res29.queued, true, 'queued must be true when acknowledged');
    assert.strictEqual(res29.verified, false, 'verified must be false: generic JSON cannot create authority');
    assert.strictEqual(res29.turn_started, false, 'turn_started must be false');
    assert.strictEqual(res29.turn_id, null, 'fake-turn-from-json must NEVER become authoritative turn_id');
    assert.strictEqual(res29.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    assert.strictEqual(res29.queued_submission_id, 'fake-sub', 'queued_submission_id preserved as diagnostic');
    console.log('✓ L-NT-029 PASSED: Generic JSON stdout rejected as transport authority.');

    // -----------------------------------------------------------------------
    // L-NT-030: Contradictory queued=false + turn_id fails closed (B-03)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-030] Testing contradictory queued=false + turn_id fails closed...');
    cleanLock();
    const env30 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        queued: false,
        turn_id: 'contradictory-turn'
      })
    };

    const proc30 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-030', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env30,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc30.status, 0, `Script failed: ${proc30.stderr}`);
    const res30 = JSON.parse((proc30.stdout || '').trim());

    assert.strictEqual(res30.queued, false, 'queued must be false');
    assert.strictEqual(res30.success, false, 'success must be false');
    assert.strictEqual(res30.verified, false, 'verified must be false');
    assert.strictEqual(res30.turn_started, false, 'turn_started must be false');
    assert.strictEqual(res30.turn_id, null, 'turn_id must be null');
    assert.ok(!(res30.queued === false && res30.verified === true), 'Forbidden invariant violated: queued=false and verified=true');
    console.log('✓ L-NT-030 PASSED: Contradictory queued=false + turn_id fails closed.');

    // -----------------------------------------------------------------------
    // L-NT-031: Unrelated error event for Turn A does not fail Target Turn B (B-04)
    // Fixture: Target B; error for A; then valid task_complete for B
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-031] Testing wrong-turn error does not terminate watch or fail target turn...');
    const rolloutFile31 = path.join(sessDir, 'rollout-2026-09-19T00-00-01-sess_31.jsonl');
    fs.writeFileSync(
      rolloutFile31,
      [
        JSON.stringify({ payload: { id: 'sess_31', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'error', turn_id: 'turn-A-wrong', message: 'Syntax error in turn A' }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-B-target',
            duration_ms: 1200,
            last_agent_message: 'Turn B completed implementation successfully.'
          }
        })
      ].join('\n') + '\n'
    );

    const proc31 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_31', '--target-turn', 'turn-B-target', '--timeout', '5'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc31.status, 0, `Watcher failed: ${proc31.stderr}`);
    const res31 = JSON.parse((proc31.stdout || '').trim());

    assert.strictEqual(res31.success, true, 'Turn B must succeed despite earlier Turn A error');
    assert.strictEqual(res31.verified, true, 'verified must be true for Turn B');
    assert.strictEqual(res31.turn_id, 'turn-B-target', 'turn_id must match target Turn B');
    assert.strictEqual(res31.report_text, 'Turn B completed implementation successfully.', 'report_text must belong to Turn B');
    assert.strictEqual(res31.turn_failed, undefined, 'turn_failed must not be set on success');
    console.log('✓ L-NT-031 PASSED: Unrelated Turn A error ignored; Target Turn B completed successfully.');

    // -----------------------------------------------------------------------
    // L-NT-032: Matching error event for Target Turn B (B-04)
    // Fixture: Target B; error for B
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-032] Testing matching error event returns exact target failure provenance...');
    const rolloutFile32 = path.join(sessDir, 'rollout-2026-09-19T00-00-02-sess_32.jsonl');
    fs.writeFileSync(
      rolloutFile32,
      [
        JSON.stringify({ payload: { id: 'sess_32', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'error', turn_id: 'turn-B-target', message: 'Fatal build error in Turn B' }
        })
      ].join('\n') + '\n'
    );

    const proc32 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_32', '--target-turn', 'turn-B-target', '--timeout', '5'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc32.status, 0, `Watcher failed: ${proc32.stderr}`);
    const res32 = JSON.parse((proc32.stdout || '').trim());

    assert.strictEqual(res32.success, false, 'success must be false on matching error');
    assert.strictEqual(res32.verified, false, 'verified must be false on error');
    assert.strictEqual(res32.turn_failed, true, 'turn_failed must be true when error matches target turn');
    assert.strictEqual(res32.turn_id, 'turn-B-target', 'turn_id must be target turn B');
    assert.strictEqual(res32.target_turn_id, 'turn-B-target', 'target_turn_id must be target turn B');
    assert.strictEqual(res32.report_text, null, 'report_text must be null on failure');
    assert.ok(res32.error.includes('Fatal build error in Turn B'), 'Error message preserved');
    console.log('✓ L-NT-032 PASSED: Matching error attributes failure to target turn B with report_text=null.');

    // -----------------------------------------------------------------------
    // L-NT-033: Error without turn_id returns session/unknown failure (B-04)
    // Fixture: Target B; error without turn_id
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-033] Testing error without turn_id returns session/unknown failure, not target turn proof...');
    const rolloutFile33 = path.join(sessDir, 'rollout-2026-09-19T00-00-03-sess_33.jsonl');
    fs.writeFileSync(
      rolloutFile33,
      [
        JSON.stringify({ payload: { id: 'sess_33', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'error', message: 'Generic container crash without turn ID' }
        })
      ].join('\n') + '\n'
    );

    const proc33 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_33', '--target-turn', 'turn-B-target', '--timeout', '5'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc33.status, 0, `Watcher failed: ${proc33.stderr}`);
    const res33 = JSON.parse((proc33.stdout || '').trim());

    assert.strictEqual(res33.success, false, 'success must be false');
    assert.strictEqual(res33.verified, false, 'verified must be false');
    assert.strictEqual(res33.turn_failed, false, 'turn_failed must NOT be true when error has unknown turn provenance');
    assert.strictEqual(res33.watch_failed, true, 'watch_failed must be true');
    assert.strictEqual(res33.error_scope, 'session_or_unknown', 'error_scope must be session_or_unknown');
    assert.strictEqual(res33.target_turn_id, 'turn-B-target', 'target_turn_id preserved');
    assert.strictEqual(res33.turn_id, null, 'turn_id must be null');
    assert.strictEqual(res33.report_text, null, 'report_text must be null');
    console.log('✓ L-NT-033 PASSED: Unknown-turn error reported as watch_failed without claiming target turn failed.');

    // -----------------------------------------------------------------------
    // L-NT-034: Cross-session timeout diagnostic remains session-bound (B-05)
    // Fixture: Same project; Session A has old report A1, target B never completes.
    // Session X (newer) has report X1.
    // Invocation: --session-id A --target-turn B
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-034] Testing timeout diagnostic remains strictly session-bound to Session A...');
    // Create Session A (older timestamp)
    const rolloutFileA = path.join(sessDir, 'rollout-2026-09-19T00-00-04-sess_A.jsonl');
    fs.writeFileSync(
      rolloutFileA,
      [
        JSON.stringify({ payload: { id: 'sess_A', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-A1-old',
            duration_ms: 1000,
            last_agent_message: 'Report from Session A'
          }
        })
      ].join('\n') + '\n'
    );

    // Create Session X (newer timestamp) with different report
    const rolloutFileX = path.join(sessDir, 'rollout-2026-09-19T00-00-05-sess_X.jsonl');
    fs.writeFileSync(
      rolloutFileX,
      [
        JSON.stringify({ payload: { id: 'sess_X', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-X1-new',
            duration_ms: 2000,
            last_agent_message: 'Report from NEWER Session X'
          }
        })
      ].join('\n') + '\n'
    );

    // Ensure session X has newer mtime
    const now = Date.now() / 1000;
    fs.utimesSync(rolloutFileA, now - 100, now - 100);
    fs.utimesSync(rolloutFileX, now, now);

    const proc34 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--project', 'AI_Multi_Task', '--session-id', 'sess_A', '--target-turn', 'turn-B-never', '--timeout', '1'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc34.status, 0, `Watcher failed: ${proc34.stderr}`);
    const res34 = JSON.parse((proc34.stdout || '').trim());

    assert.strictEqual(res34.success, false, 'success must be false on timeout');
    assert.strictEqual(res34.timed_out, true, 'timed_out must be true');
    assert.ok(res34.diagnostic_latest_report, 'diagnostic_latest_report must be present');
    assert.strictEqual(res34.diagnostic_latest_report.session_id, 'sess_A', 'diagnostic report MUST come from session A');
    assert.strictEqual(res34.diagnostic_latest_report.turn_id, 'turn-A1-old', 'diagnostic report must be turn A1');
    assert.strictEqual(res34.diagnostic_latest_report.report_text, 'Report from Session A', 'diagnostic report must be from session A');
    assert.notStrictEqual(res34.diagnostic_latest_report.session_id, 'sess_X', 'diagnostic report must NEVER leak from newer session X');
    console.log('✓ L-NT-034 PASSED: Timeout diagnostic remained strictly session-bound to Session A.');

    console.log('\n======================================================================');
    console.log('ALL WP-V3-01 REGRESSION TESTS PASSED (L-NT-029 .. L-NT-034: 6/6 PASS)');
    console.log('======================================================================');

  } finally {
    cleanLock();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

runAllTests().catch((err) => {
  console.error('[TEST SUITE ERROR]', err);
  process.exit(1);
});

/**
 * Dedicated Regression Test Suite for WP-V3-01: Legacy Transport Correctness Seal
 * Tests:
 * - L-NT-029: Generic JSON stdout cannot activate exact transport or queue authority (B-03 / B-03B)
 * - L-NT-030: Contradictory queued=false + turn_id JSON fails closed (B-03 / B-03B)
 * - L-NT-031: Unrelated error event for Turn A does not fail Target Turn B (B-04)
 * - L-NT-032: Matching error event for Target Turn B returns exact target failure (B-04)
 * - L-NT-033: Error event without turn_id returns session/unknown failure, not target turn proof (B-04)
 * - L-NT-034: Cross-session timeout diagnostic remains strictly session-bound (B-05)
 * - L-NT-035: JSON without queued field does not establish queue acceptance (B-03B)
 * - L-NT-036: JSON with queued=true cannot create queue authority or overwrite IDs (B-03B)
 * - L-NT-037: Loose text (e.g. 'for thread ...') does not establish queue acceptance (B-03B)
 * - L-NT-038: Mixed turn/report provenance rejected; report strictly bound to task_complete (B-06)
 * - L-NT-039: Incomplete new turn response_item does not rewrite completed report (B-06)
 * - L-NT-040: Empty task_complete does not borrow text from response_item (B-06)
 * - L-NT-041: Embedded ACK phrase within other text rejected as queue acceptance (B-07)
 * - L-NT-042: ACK for wrong session fails closed with ACK_SESSION_MISMATCH (B-07)
 * - L-NT-043: Exact matching ACK for requested session accepted with diagnostic submission ID (B-07)
 * - L-NT-044: Multiple matching ACK lines fail closed with AMBIGUOUS_QUEUE_ACK (B-07)
 * - L-NT-045: Multiple conflicting ACK lines fail closed with AMBIGUOUS_QUEUE_ACK (B-07)
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
    '    string txtOut = Environment.GetEnvironmentVariable("MOCK_STDOUT_TEXT");',
    '    string jsonOut = Environment.GetEnvironmentVariable("MOCK_EXACT_TRANSPORT_JSON");',
    '    if (!string.IsNullOrEmpty(txtOut)) {',
    '      Console.WriteLine(txtOut);',
    '    } else if (!string.IsNullOrEmpty(jsonOut)) {',
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
  console.log('RUNNING WP-V3-01 REGRESSION TEST SUITE (L-NT-029 .. L-NT-045)');
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
    // L-NT-029: Generic JSON stdout cannot activate exact transport or queue authority (B-03 / B-03B)
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

    assert.strictEqual(res29.queued, false, 'queued must be false: generic JSON is not an ACK (B-03B)');
    assert.strictEqual(res29.success, false, 'success must be false without recognized ACK');
    assert.strictEqual(res29.verified, false, 'verified must be false: generic JSON cannot create authority');
    assert.strictEqual(res29.turn_started, false, 'turn_started must be false');
    assert.strictEqual(res29.turn_id, null, 'fake-turn-from-json must NEVER become authoritative turn_id');
    assert.strictEqual(res29.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    assert.strictEqual(res29.queued_submission_id, null, 'fake-sub must not become queued_submission_id');
    console.log('✓ L-NT-029 PASSED: Generic JSON stdout rejected as transport and queue authority.');

    // -----------------------------------------------------------------------
    // L-NT-030: Contradictory queued=false + turn_id fails closed (B-03 / B-03B)
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

    // -----------------------------------------------------------------------
    // L-NT-035: JSON without queued field does not establish queue acceptance (B-03B)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-035] Testing JSON without queued field does not establish queue acceptance...');
    cleanLock();
    const env35 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        id: 'random-json-object'
      })
    };

    const proc35 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-035', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env35,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc35.status, 0, `Script failed: ${proc35.stderr}`);
    const res35 = JSON.parse((proc35.stdout || '').trim());

    assert.strictEqual(res35.success, false, 'success must be false for arbitrary JSON');
    assert.strictEqual(res35.queued, false, 'queued must be false without recognized ACK');
    assert.strictEqual(res35.verified, false, 'verified must be false');
    assert.strictEqual(res35.turn_started, false, 'turn_started must be false');
    assert.strictEqual(res35.turn_id, null, 'turn_id must be null');
    assert.strictEqual(res35.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    console.log('✓ L-NT-035 PASSED: JSON without queued field rejected as queue acceptance.');

    // -----------------------------------------------------------------------
    // L-NT-036: JSON with queued=true cannot create queue authority or overwrite IDs (B-03B)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-036] Testing JSON queued=true cannot create queue authority or overwrite IDs...');
    cleanLock();
    const env36 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_EXACT_TRANSPORT_JSON: JSON.stringify({
        queued: true,
        turn_id: 'fake-turn',
        queued_submission_id: 'fake-sub',
        client_user_message_id: 'attacker-controlled'
      })
    };

    const proc36 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-036', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env36,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc36.status, 0, `Script failed: ${proc36.stderr}`);
    const res36 = JSON.parse((proc36.stdout || '').trim());

    assert.strictEqual(res36.success, false, 'success must be false');
    assert.strictEqual(res36.queued, false, 'queued must be false: JSON cannot create queue authority');
    assert.strictEqual(res36.verified, false, 'verified must be false');
    assert.strictEqual(res36.turn_id, null, 'turn_id must be null');
    assert.strictEqual(res36.queued_submission_id, null, 'fake-sub must not become queued_submission_id');
    assert.strictEqual(res36.client_user_message_id, `orchestrator:${res36.dispatch_id}`, 'client_user_message_id must remain local diagnostic');
    console.log('✓ L-NT-036 PASSED: JSON queued=true rejected; IDs not overwritten.');

    // -----------------------------------------------------------------------
    // L-NT-037: Loose text (e.g. 'for thread ...') does not establish queue acceptance (B-03B)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-037] Testing loose text does not establish queue acceptance...');
    cleanLock();
    const env37A = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'warning generated for thread session-123'
    };

    const proc37A = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-037 A', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env37A,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc37A.status, 0, `Script failed: ${proc37A.stderr}`);
    const res37A = JSON.parse((proc37A.stdout || '').trim());
    assert.strictEqual(res37A.success, false, 'success must be false for loose text');
    assert.strictEqual(res37A.queued, false, 'queued must be false for loose text');

    cleanLock();
    const env37B = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'for thread session-123'
    };

    const proc37B = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-037 B', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env37B,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc37B.status, 0, `Script failed: ${proc37B.stderr}`);
    const res37B = JSON.parse((proc37B.stdout || '').trim());
    assert.strictEqual(res37B.success, false, 'success must be false for loose text');
    assert.strictEqual(res37B.queued, false, 'queued must be false for loose text');
    console.log('✓ L-NT-037 PASSED: Loose text patterns rejected as queue acceptance.');

    // -----------------------------------------------------------------------
    // L-NT-038: Mixed turn/report provenance rejected (B-06)
    // Fixture: task_complete A with REPORT A; later response_item assistant with TEXT FROM LATER TURN B
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-038] Testing mixed turn/report provenance rejected...');
    const rolloutFile38 = path.join(sessDir, 'rollout-2026-09-19T00-00-06-sess_38.jsonl');
    fs.writeFileSync(
      rolloutFile38,
      [
        JSON.stringify({ payload: { id: 'sess_38', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-A',
            duration_ms: 1500,
            last_agent_message: 'REPORT A'
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ text: 'TEXT FROM LATER TURN B' }]
          }
        })
      ].join('\n') + '\n'
    );

    const proc38 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_38', '--latest'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc38.status, 0, `Watcher failed: ${proc38.stderr}`);
    const res38 = JSON.parse((proc38.stdout || '').trim());

    assert.strictEqual(res38.success, true, 'success must be true');
    assert.strictEqual(res38.turn_id, 'turn-A', 'turn_id must be turn-A');
    assert.strictEqual(res38.report_text, 'REPORT A', 'report_text MUST come from task_complete A, never later response_item');
    assert.notStrictEqual(res38.report_text, 'TEXT FROM LATER TURN B', 'Must not borrow text from response_item');
    console.log('✓ L-NT-038 PASSED: Report text strictly bound to matching task_complete record.');

    // -----------------------------------------------------------------------
    // L-NT-039: Incomplete new turn must not rewrite completed report (B-06)
    // Fixture: task_complete A with REPORT A; task_started B; response_item B with "PARTIAL B"
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-039] Testing incomplete new turn does not rewrite completed report...');
    const rolloutFile39 = path.join(sessDir, 'rollout-2026-09-19T00-00-07-sess_39.jsonl');
    fs.writeFileSync(
      rolloutFile39,
      [
        JSON.stringify({ payload: { id: 'sess_39', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-A',
            duration_ms: 1500,
            last_agent_message: 'REPORT A'
          }
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-B' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ text: 'PARTIAL B' }]
          }
        })
      ].join('\n') + '\n'
    );

    const proc39 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_39', '--latest'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc39.status, 0, `Watcher failed: ${proc39.stderr}`);
    const res39 = JSON.parse((proc39.stdout || '').trim());

    assert.strictEqual(res39.success, true, 'success must be true for completed turn A');
    assert.strictEqual(res39.turn_id, 'turn-A', 'turn_id must remain turn-A');
    assert.strictEqual(res39.report_text, 'REPORT A', 'report_text must remain REPORT A');
    console.log('✓ L-NT-039 PASSED: Incomplete turn B did not rewrite completed report A.');

    // -----------------------------------------------------------------------
    // L-NT-040: Empty complete must not borrow assistant text (B-06)
    // Fixture: task_complete B with last_agent_message=""; response_item assistant "some text"
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-040] Testing empty complete does not borrow assistant text...');
    const rolloutFile40 = path.join(sessDir, 'rollout-2026-09-19T00-00-08-sess_40.jsonl');
    fs.writeFileSync(
      rolloutFile40,
      [
        JSON.stringify({ payload: { id: 'sess_40', cwd: 'D:\\TU_CODE\\AI_Multi_Task' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-B',
            duration_ms: 1000,
            last_agent_message: ''
          }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ text: 'some text' }]
          }
        })
      ].join('\n') + '\n'
    );

    const proc40 = spawnSync(
      'python',
      [WATCH_CODEX_SESSION, '--session-id', 'sess_40', '--latest'],
      {
        cwd: PIPELINE_UI_DIR,
        env: { ...process.env, USERPROFILE: tmpDir },
        timeout: 10000,
        encoding: 'utf-8'
      }
    );

    assert.strictEqual(proc40.status, 0, `Watcher failed: ${proc40.stderr}`);
    const res40 = JSON.parse((proc40.stdout || '').trim());

    assert.strictEqual(res40.success, false, 'success must be false when task_complete has empty report');
    assert.strictEqual(res40.report_text, null, 'report_text must be null (no borrowing from response_item)');
    console.log('✓ L-NT-040 PASSED: Empty complete failed closed without borrowing assistant text.');

    // -----------------------------------------------------------------------
    // L-NT-041: Embedded ACK phrase within other text rejected as queue acceptance (B-07)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-041] Testing embedded ACK phrase within other text rejected...');
    cleanLock();
    // Ensure sess_001 is latest rollout for AI_Multi_Task
    const nowB07 = Date.now() / 1000 + 1000;
    fs.utimesSync(rolloutFile, nowB07, nowB07);
    const env41 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'WARNING: Queued message fake for thread sess_001 but transport uncertain'
    };

    const proc41 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-041', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env41,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc41.status, 0, `Script failed: ${proc41.stderr}`);
    const res41 = JSON.parse((proc41.stdout || '').trim());

    assert.strictEqual(res41.success, false, 'success must be false for embedded ACK phrase');
    assert.strictEqual(res41.queued, false, 'queued must be false for embedded ACK phrase');
    assert.strictEqual(res41.verified, false, 'verified must remain false');
    assert.strictEqual(res41.turn_id, null, 'turn_id must remain null');
    console.log('✓ L-NT-041 PASSED: Embedded ACK phrase rejected as full line ACK.');

    // -----------------------------------------------------------------------
    // L-NT-042: ACK for wrong session fails closed with ACK_SESSION_MISMATCH (B-07)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-042] Testing ACK for wrong session fails closed with ACK_SESSION_MISMATCH...');
    cleanLock();
    const env42 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'Queued message msg123 for thread sess_OTHER'
    };

    const proc42 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-042', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env42,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc42.status, 0, `Script failed: ${proc42.stderr}`);
    const res42 = JSON.parse((proc42.stdout || '').trim());

    assert.strictEqual(res42.success, false, 'success must be false for wrong session ACK');
    assert.strictEqual(res42.queued, false, 'queued must be false for wrong session ACK');
    assert.strictEqual(res42.verified, false, 'verified must be false');
    assert.strictEqual(res42.turn_id, null, 'turn_id must be null');
    assert.ok(res42.error.includes('ACK_SESSION_MISMATCH'), 'Error must indicate ACK_SESSION_MISMATCH');
    console.log('✓ L-NT-042 PASSED: ACK for wrong session rejected with ACK_SESSION_MISMATCH.');

    // -----------------------------------------------------------------------
    // L-NT-043: Exact matching ACK for requested session accepted with diagnostic submission ID (B-07)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-043] Testing exact matching ACK for requested session accepted...');
    cleanLock();
    const env43 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'Queued message msg123 for thread sess_001'
    };

    const proc43 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-043', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env43,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc43.status, 0, `Script failed: ${proc43.stderr}`);
    const res43 = JSON.parse((proc43.stdout || '').trim());

    assert.strictEqual(res43.success, true, 'success must be true on exact matching ACK');
    assert.strictEqual(res43.queued, true, 'queued must be true on exact matching ACK');
    assert.strictEqual(res43.verified, false, 'verified must remain false');
    assert.strictEqual(res43.turn_started, false, 'turn_started must remain false');
    assert.strictEqual(res43.turn_id, null, 'turn_id must remain null');
    assert.strictEqual(res43.queued_submission_id, 'msg123', 'queued_submission_id must match ACK message ID');
    assert.strictEqual(res43.correlation_method, 'unavailable', 'correlation_method must be unavailable');
    console.log('✓ L-NT-043 PASSED: Exact matching ACK for requested session successfully accepted.');

    // -----------------------------------------------------------------------
    // L-NT-044: Multiple matching ACK lines fail closed with AMBIGUOUS_QUEUE_ACK (B-07)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-044] Testing multiple matching ACK lines fail closed with AMBIGUOUS_QUEUE_ACK...');
    cleanLock();
    const env44 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'Queued message msg123 for thread sess_001\r\nQueued message msg456 for thread sess_001'
    };

    const proc44 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-044', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env44,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc44.status, 0, `Script failed: ${proc44.stderr}`);
    const res44 = JSON.parse((proc44.stdout || '').trim());

    assert.strictEqual(res44.success, false, 'success must be false on multiple ACKs');
    assert.strictEqual(res44.queued, false, 'queued must be false on multiple ACKs');
    assert.strictEqual(res44.verified, false, 'verified must remain false');
    assert.strictEqual(res44.turn_id, null, 'turn_id must remain null');
    assert.ok(res44.error.includes('AMBIGUOUS_QUEUE_ACK'), 'Error must indicate AMBIGUOUS_QUEUE_ACK');
    console.log('✓ L-NT-044 PASSED: Multiple matching ACKs rejected fail-closed.');

    // -----------------------------------------------------------------------
    // L-NT-045: Multiple conflicting ACK lines fail closed with AMBIGUOUS_QUEUE_ACK (B-07)
    // -----------------------------------------------------------------------
    console.log('\n[L-NT-045] Testing multiple conflicting ACK lines fail closed with AMBIGUOUS_QUEUE_ACK...');
    cleanLock();
    const env45 = {
      ...process.env,
      USERPROFILE: tmpDir,
      PATH: `${tmpDir}${path.delimiter}${cleanPath}`,
      MOCK_STDOUT_TEXT: 'Queued message msg123 for thread sess_001\r\nQueued message msg456 for thread sess_OTHER'
    };

    const proc45 = spawnSync('python', [SEND_TO_CODEX, 'test prompt L-NT-045', 'AI_Multi_Task'], {
      cwd: PIPELINE_UI_DIR,
      env: env45,
      timeout: 10000,
      encoding: 'utf-8'
    });

    assert.strictEqual(proc45.status, 0, `Script failed: ${proc45.stderr}`);
    const res45 = JSON.parse((proc45.stdout || '').trim());

    assert.strictEqual(res45.success, false, 'success must be false on conflicting ACKs');
    assert.strictEqual(res45.queued, false, 'queued must be false on conflicting ACKs');
    assert.strictEqual(res45.verified, false, 'verified must remain false');
    assert.strictEqual(res45.turn_id, null, 'turn_id must remain null');
    assert.ok(res45.error.includes('AMBIGUOUS_QUEUE_ACK'), 'Error must indicate AMBIGUOUS_QUEUE_ACK');
    console.log('✓ L-NT-045 PASSED: Multiple conflicting ACKs rejected fail-closed.');

    console.log('\n======================================================================');
    console.log('ALL WP-V3-01 REGRESSION TESTS PASSED (L-NT-029 .. L-NT-045: 17/17 PASS)');
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

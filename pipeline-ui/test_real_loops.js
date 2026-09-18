const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;
const PROJECT_ID = 'calc-engine';
const AGY_SESSION_ID = 'c4cbb9a8-4a91-44bc-a270-32a99cc13ac2';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSessionState(since = 0) {
  const res = await fetch(`${BASE_URL}/api/antigravity/session-state/${AGY_SESSION_ID}?projectId=${PROJECT_ID}&since=${since}`);
  return await res.json();
}

async function triggerAudit(userPrompt = '') {
  console.log(`\n🧠 Sending request to ChatGPT Web (model: chatgpt-web/high)...`);
  const res = await fetch(`${BASE_URL}/api/orchestrator/audit-and-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      antigravitySessionId: AGY_SESSION_ID,
      model: 'chatgpt-web/high',
      userPrompt,
      mode: 'auto'
    })
  });
  return await res.json();
}

async function runLoop(loopNumber) {
  console.log(`\n======================================================================`);
  console.log(`🚀 BẮT ĐẦU VÒNG LẶP ${loopNumber} (REAL LOOP ${loopNumber}) TRÊN ${PROJECT_ID.toUpperCase()}`);
  console.log(`======================================================================`);

  // 1. Probe current baseline step count
  const initialProbe = await getSessionState(0);
  const baselineSteps = initialProbe.totalSteps || 0;
  console.log(`📌 Baseline Antigravity step count: ${baselineSteps}`);
  console.log(`📌 Target Worker Session: ${AGY_SESSION_ID}`);

  // 2. Trigger ChatGPT Web audit & direct
  const auditStartTime = Date.now();
  const auditRes = await triggerAudit('');
  const auditDuration = ((Date.now() - auditStartTime) / 1000).toFixed(1);

  if (!auditRes || auditRes.error) {
    console.error(`❌ ChatGPT Web Audit failed:`, auditRes?.error);
    return { success: false, error: auditRes?.error };
  }

  const directive = auditRes.item?.chatgptMessage?.directivePrompt || auditRes.item?.chatgptAudit?.nextDirectivePrompt;
  const verdict = auditRes.item?.chatgptMessage?.verdict || auditRes.item?.chatgptAudit?.verdict;
  const dispatched = auditRes.item?.dispatched;
  const targetWin = auditRes.item?.dispatchTarget || auditRes.item?.targetWindow;

  console.log(`\n✅ ChatGPT Web Audit hoàn tất trong ${auditDuration}s:`);
  console.log(`   - Verdict: ${verdict}`);
  console.log(`   - Tự động nạp vào IDE: ${dispatched ? 'THÀNH CÔNG' : 'CHƯA'} -> Target: ${targetWin}`);
  console.log(`   - Chỉ đạo tiếp theo:\n${(directive || '').slice(0, 300)}...\n`);

  // 3. Observe Antigravity working on IDE
  console.log(`👀 Đang quan sát Antigravity Agent thi công trên IDE (Baseline steps: ${baselineSteps})...`);
  let pollCount = 0;
  let hasStarted = false;
  let isFinished = false;
  let finalReport = null;
  let finalSteps = baselineSteps;
  const maxPolls = 180; // up to ~7.5 minutes

  while (pollCount < maxPolls && !isFinished) {
    await sleep(2500);
    pollCount++;

    const state = await getSessionState(baselineSteps);
    if (!state || !state.success) continue;

    finalSteps = state.totalSteps;

    if (!hasStarted && (state.isWorking || state.totalSteps > baselineSteps)) {
      hasStarted = true;
      console.log(`   ⚡ [T+${(pollCount * 2.5).toFixed(0)}s] Agent ĐÃ BẮT ĐẦU NHẬN LỆNH trên IDE! (Bước ${state.totalSteps})`);
    }

    if (state.isWorking) {
      if (pollCount % 4 === 0 || state.totalSteps !== finalSteps) {
        console.log(`   🔨 [T+${(pollCount * 2.5).toFixed(0)}s] Agent đang thi công trên IDE... (Bước ${state.totalSteps}, loại: ${state.lastStepType || 'tool'})`);
      }
    }

    if (hasStarted && state.isFinished && state.totalSteps > baselineSteps) {
      isFinished = true;
      finalReport = state.report;
      console.log(`\n🎉 [T+${(pollCount * 2.5).toFixed(0)}s] PHÁT HIỆN ANTIGRAVITY HOÀN THÀNH NHIỆM VỤ TRÊN IDE!`);
      console.log(`   - Tổng số bước: ${state.totalSteps} (Tăng +${state.totalSteps - baselineSteps} bước)`);
      console.log(`   - Báo cáo kết quả:\n${(finalReport || '').slice(0, 500)}...\n`);
      break;
    }
  }

  if (!isFinished) {
    console.error(`❌ Timeout: Antigravity chưa hoàn thành sau ${pollCount * 2.5}s.`);
    return { success: false, error: 'Timeout waiting for Antigravity' };
  }

  // 4. Verify local repository tests and files
  console.log(`🔍 Xác minh độc lập repo ${PROJECT_ID}:`);
  try {
    const testOut = execSync('node test.js', { cwd: path.join(__dirname, '..', 'calc-engine'), encoding: 'utf8' });
    console.log(`   ✅ node test.js PASS:\n${testOut.trim().split('\n').slice(-5).join('\n')}`);
  } catch (err) {
    console.warn(`   ⚠️ node test.js output:\n${err.stdout || err.message}`);
  }

  try {
    const gitStatus = execSync('git status --short', { cwd: path.join(__dirname, '..', 'calc-engine'), encoding: 'utf8' });
    console.log(`   📁 Git status:\n${gitStatus.trim() || '(working tree clean)'}`);
  } catch (e) {}

  return {
    success: true,
    loopNumber,
    baselineSteps,
    finalSteps,
    verdict,
    reportLength: (finalReport || '').length
  };
}

async function main() {
  console.log(`======================================================================`);
  console.log(`   TIẾN TRÌNH THỰC HIỆN 3 VÒNG LẶP TỰ ĐỘNG KHÉP KÍN (CLOSED-LOOP)     `);
  console.log(`   DỰ ÁN: CALC-ENGINE | MODEL: CHATGPT-WEB/HIGH | AGY: ANTIGRAVITY IDE`);
  console.log(`======================================================================`);

  const results = [];
  for (let loop = 1; loop <= 3; loop++) {
    const res = await runLoop(loop);
    results.push(res);
    if (!res.success) {
      console.error(`❌ Vòng lặp ${loop} không thành công. Dừng tiến trình.`);
      break;
    }
    console.log(`\n>>> HOÀN THÀNH THÀNH CÔNG VÒNG LẶP ${loop}! Nghỉ 3 giây trước vòng lặp tiếp theo...\n`);
    await sleep(3000);
  }

  console.log(`\n======================================================================`);
  console.log(`               TỔNG KẾT KẾT QUẢ KIỂM THỬ 3 VÒNG LẶP                   `);
  console.log(`======================================================================`);
  results.forEach(r => {
    if (r.success) {
      console.log(`✅ Vòng ${r.loopNumber}: Thành công | Bước: ${r.baselineSteps} -> ${r.finalSteps} | Verdict: ${r.verdict}`);
    } else {
      console.log(`❌ Vòng ${r.loopNumber}: Thất bại (${r.error})`);
    }
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

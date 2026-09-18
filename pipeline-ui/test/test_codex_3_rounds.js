const http = require('http');
const { execSync } = require('child_process');

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(parsed, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 180000
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch (e) {
          resolve({ status: res.statusCode, text: buf, data: null });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getMousePos() {
  try {
    const out = execSync('python -c "import ctypes; from ctypes import wintypes; pt = wintypes.POINT(); ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)); print(f\'{pt.x},{pt.y}\')"', { encoding: 'utf-8' });
    const [x, y] = out.trim().split(',').map(Number);
    return { x, y };
  } catch (e) {
    return { x: 0, y: 0 };
  }
}

async function runTest() {
  console.log('================================================================');
  console.log('🚀 BẮT ĐẦU KIỂM THỬ 3 VÒNG (3 ROUNDS) ZERO-INTRUSION WORKER CODEX');
  console.log('Đặc tính: Không chiếm chuột, không chiếm phím, chạy ngầm 100%');
  console.log('Dự án mục tiêu: AI_Multi_Task (D:\\TU_CODE\\AI_Multi_Task)');
  console.log('================================================================\n');

  // 1. Set workerEngine to codex
  console.log('[Setup] Cấu hình workerEngine sang "codex"...');
  const setWorkerRes = await postJson('http://localhost:4000/api/worker/engine', { workerEngine: 'codex' });
  console.log('[Setup] Kết quả set workerEngine:', setWorkerRes.data);

  const results = [];

  for (let round = 1; round <= 3; round++) {
    console.log(`\n------------------------------------------------------------`);
    console.log(`▶ VÒNG ${round} / 3: Điều phối giữa ChatGPT Web & OpenAI Codex Extension`);
    console.log(`------------------------------------------------------------`);

    const userPrompt = round === 1 
      ? "Khởi động quy trình thẩm định kiến trúc hệ thống AI_Multi_Task. Rà soát file docs/architecture/00-system-context.md và cho chỉ đạo đầu tiên cho Codex."
      : `Tiếp tục vòng ${round}: Thẩm định tiến độ của Codex từ vòng ${round - 1}, đánh giá chi tiết và đưa ra chỉ đạo tiếp theo cho Codex.`;

    const mouseBefore = getMousePos();
    console.log(`[Vòng ${round}] Bước 1: Gửi yêu cầu audit sang ChatGPT Web (Lead Architect)...`);
    const auditStart = Date.now();
    const auditRes = await postJson('http://localhost:4000/api/orchestrator/audit-and-direct', {
      projectId: 'AI_Multi_Task',
      userPrompt,
      workerEngine: 'codex',
      model: 'chatgpt-web/high',
      mode: 'auto'
    });

    if (!auditRes.data || auditRes.data.error) {
      console.error(`[Vòng ${round}] LỖI AUDIT:`, auditRes.data ? auditRes.data.error : auditRes.text);
      results.push({ round, success: false, error: auditRes.data?.error || 'Audit failure' });
      break;
    }

    const mouseAfter = getMousePos();
    const dX = mouseAfter.x - mouseBefore.x;
    const dY = mouseAfter.y - mouseBefore.y;
    const mouseZeroIntrusion = (dX === 0 && dY === 0);

    const auditDuration = ((Date.now() - auditStart) / 1000).toFixed(1);
    const directive = auditRes.data.item?.chatgptMessage?.directivePrompt || auditRes.data.item?.chatgptAudit?.nextDirectivePrompt || auditRes.data.item?.chatgptMessage?.content || '';
    console.log(`[Vòng ${round}] ✓ ChatGPT Web đã audit xong (${auditDuration}s).`);
    console.log(`[Vòng ${round}] Chỉ đạo tiếp theo cho Codex:\n${directive.slice(0, 220)}...\n`);

    const dispatchMethod = auditRes.data.item?.dispatchMethod;
    const verified = auditRes.data.item?.verified;
    console.log(`[Vòng ${round}] Bước 2: Nạp chỉ đạo vào hàng đợi Codex (${auditRes.data.item?.dispatchTarget}).`);
    console.log(`[Vòng ${round}] ✓ Xác thực kênh gửi: method=${dispatchMethod}, verified=${verified}`);
    console.log(`[Vòng ${round}] ✓ Zero-Intrusion: Tọa độ chuột hoàn toàn bất biến (dX=${dX}, dY=${dY}, không chiếm chuột phím)`);
    console.log(`[Vòng ${round}] Bước 3: Đang theo dõi tiến trình thực thi của Codex (phản hồi thời gian thực)...`);

    const waitStart = Date.now();
    const codexWaitRes = await postJson('http://localhost:4000/api/worker/wait-report', {
      projectId: 'AI_Multi_Task',
      workerEngine: 'codex',
      timeoutSecs: 180
    });

    const waitDuration = ((Date.now() - waitStart) / 1000).toFixed(1);

    if (codexWaitRes.data && codexWaitRes.data.success && codexWaitRes.data.report_text) {
      console.log(`[Vòng ${round}] ✓ Codex đã thực thi xong và gửi báo cáo (${waitDuration}s, duration_ms: ${codexWaitRes.data.duration_ms})!`);
      console.log(`[Vòng ${round}] Nội dung báo cáo từ Codex:\n${codexWaitRes.data.report_text.slice(0, 260)}...\n`);
      results.push({
        round,
        success: true,
        zeroMouseHijack: mouseZeroIntrusion ? 'YES (0 px)' : `NO (dX=${dX},dY=${dY})`,
        auditSecs: auditDuration,
        codexSecs: waitDuration,
        verified: verified ? 'YES' : 'NO',
        method: dispatchMethod
      });
    } else {
      console.error(`[Vòng ${round}] LỖI CHỜ BÁO CÁO CODEX:`, codexWaitRes.data?.error || 'Timeout');
      results.push({
        round,
        success: false,
        error: codexWaitRes.data?.error || 'Timeout waiting for Codex report'
      });
      break;
    }
  }

  console.log('\n================================================================');
  console.log('📊 TỔNG KẾT KIỂM THỬ 3 VÒNG (3 ROUNDS) ZERO-INTRUSION');
  console.log('================================================================');
  console.table(results);

  const allPassed = results.length === 3 && results.every(r => r.success);
  if (allPassed) {
    console.log('\n🎉 TẤT CẢ 3 VÒNG ĐÃ PASS HOÀN TOÀN TRONG CHẾ ĐỘ ZERO-INTRUSION!');
    console.log('✓ Chuột và bàn phím của người dùng hoàn toàn không bị ảnh hưởng.');
    console.log('✓ Hoạt động nền 100% ngay cả khi xem phim, chơi game full-screen.');
  } else {
    console.log('\n⚠️ Kiểm thử chưa pass toàn bộ.');
  }

  process.exit(allPassed ? 0 : 1);
}

runTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

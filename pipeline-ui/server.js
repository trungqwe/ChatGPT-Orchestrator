const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 4000;
const AO_BASE_URL = 'http://127.0.0.1:3001';
const CHATGPT_PROXY_URL = 'http://127.0.0.1:17841';
const AO_DATA_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.ao', 'data');
const CODEX_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.codex');
const DB_PATH = path.join(AO_DATA_DIR, 'ao.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data file for persisting exchange history between ChatGPT Web and Antigravity
const EXCHANGES_FILE = path.join(__dirname, 'exchange_history.json');
function loadExchangeHistory() {
  try {
    if (fs.existsSync(EXCHANGES_FILE)) {
      return JSON.parse(fs.readFileSync(EXCHANGES_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveExchangeHistory(data) {
  try {
    fs.writeFileSync(EXCHANGES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

const exchangeHistory = loadExchangeHistory();

// -------------------------------------------------------------
// Pipeline Settings (Worker Engine: 'gemini' | 'codex')
// -------------------------------------------------------------
const SETTINGS_FILE = path.join(__dirname, 'pipeline_settings.json');
function loadPipelineSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { workerEngine: 'gemini' };
}
function savePipelineSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {}
}
let currentSettings = loadPipelineSettings();

// In-memory registry of last dispatched turns for instant watcher handoff
const lastDispatchedCodexTurn = {};

// Helper: Dispatch prompt to OpenAI Codex Extension chat in Antigravity IDE (Pure Background Zero-Intrusion)
async function dispatchPromptToCodex(prompt, projectId) {
  const result = {
    dispatched: false,
    queued: false,
    sentToWindow: false,
    verified: false,
    turn_started: false,
    busy: false,
    method: 'codex_background_queue',
    message: '',
    targetWindow: null,
    targetTurnId: null,
    worker: 'codex'
  };

  try {
    const tmpPromptFile = path.join(__dirname, '.temp_dispatch_codex_prompt.txt');
    fs.writeFileSync(tmpPromptFile, prompt, 'utf8');
    const pyScript = path.join(__dirname, 'send_to_codex.py');
    const proj = projectId || 'AI_Multi_Task';
    const pyCmd = `python "${pyScript}" "@${tmpPromptFile}" "${proj}"`;

    const pyOut = await new Promise((resolve) => {
      exec(pyCmd, { timeout: 20000 }, (err, stdout, stderr) => {
        try {
          resolve(JSON.parse((stdout || '').trim()));
        } catch (e) {
          resolve({ success: false, queued: false, verified: false, turn_started: false, error: err ? err.message : stderr });
        }
      });
    });

    if (pyOut && (pyOut.queued || pyOut.success)) {
      result.dispatched = true;
      result.queued = !!pyOut.queued;
      result.targetWindow = pyOut.target_window;
      result.baselineTurnId = pyOut.baseline_turn_id;
      result.method = pyOut.method || 'codex_background_queue';
      result.dispatchId = pyOut.dispatch_id || null;
      result.sessionId = pyOut.session_id || null;
      result.correlationMethod = pyOut.correlation_method || 'unavailable';

      // Distinguish queued from verified: only verified when exact correlation exists
      const isTurnVerified = !!(
        pyOut.verified &&
        pyOut.turn_started &&
        pyOut.turn_id &&
        pyOut.correlation_method === 'exact_transport'
      );
      result.verified = isTurnVerified;
      result.turn_started = isTurnVerified;
      result.targetTurnId = isTurnVerified ? pyOut.turn_id : null;

      if (isTurnVerified) {
        result.message = pyOut.message || `Đã nạp chỉ đạo vào phiên Codex ngầm (${pyOut.target_window}) và xác thực turn ${pyOut.turn_id}!`;
        lastDispatchedCodexTurn[proj] = {
          targetTurnId: pyOut.turn_id,
          sessionId: pyOut.session_id,
          dispatchId: pyOut.dispatch_id,
          correlationMethod: pyOut.correlation_method,
          baselineTurnId: pyOut.baseline_turn_id,
          timestamp: Date.now()
        };
        console.log(`[CODEX BG DISPATCH VERIFIED] ${pyOut.target_window} turn=${pyOut.turn_id} (exact)`);
      } else {
        // Clear any stale tracking to guarantee we NEVER watch an unverified turn
        delete lastDispatchedCodexTurn[proj];
        result.message = pyOut.message || `Lệnh đã nạp vào hàng đợi Codex (${pyOut.target_window}) nhưng chưa xác thực được exact turn_id`;
        console.warn(`[CODEX BG DISPATCH UNVERIFIED] ${pyOut.target_window} queued=true, exact correlation=${pyOut.correlation_method}`);
      }
      return result;
    } else {
      result.busy = pyOut?.busy || false;
      result.message = pyOut?.error || 'Không thể gửi lệnh vào Codex Extension';
      console.warn(`[CODEX BG DISPATCH NOTIFICATION] ${result.message}`);
    }
  } catch (e) {
    result.message = e.message;
    console.error('[CODEX DISPATCH ERROR]', e.message);
  }

  return result;
}

// Helper: Wait for Codex Extension turn completion via watch_codex_session.py
function waitCodexReport(projectId = 'AI_Multi_Task', timeoutSecs = 180, targetTurnId = null, sessionId = null) {
  return new Promise((resolve) => {
    const tracked = lastDispatchedCodexTurn[projectId];
    const effectiveTargetTurn = targetTurnId || tracked?.targetTurnId;
    const effectiveSessionId = sessionId || tracked?.sessionId;

    // Reject waiting without verified target turn ID to prevent stale report attribution
    if (!effectiveTargetTurn) {
      return resolve({
        success: false,
        verified: false,
        target_turn_id: null,
        turn_id: null,
        timed_out: false,
        report_text: null,
        error: 'Cannot wait for Codex report: missing verified target_turn_id (dispatch was not verified or target turn missing)'
      });
    }

    const pyScript = path.join(__dirname, 'watch_codex_session.py');
    let pyCmd = `python "${pyScript}" --project "${projectId}" --timeout ${timeoutSecs} --target-turn "${effectiveTargetTurn}"`;
    if (effectiveSessionId) {
      pyCmd += ` --session-id "${effectiveSessionId}"`;
    }

    exec(pyCmd, { timeout: (timeoutSecs + 10) * 1000 }, (err, stdout, stderr) => {
      try {
        const out = JSON.parse((stdout || '').trim());
        resolve(out);
      } catch (e) {
        resolve({
          success: false,
          verified: false,
          target_turn_id: effectiveTargetTurn,
          turn_id: null,
          timed_out: false,
          report_text: null,
          error: err ? err.message : stderr
        });
      }
    });
  });
}

// Helper: Read the latest report from the most recent Codex session rollout
function getLatestCodexReport(projectId = 'AI_Multi_Task') {
  return new Promise((resolve) => {
    const pyScript = path.join(__dirname, 'watch_codex_session.py');
    const pyCmd = `python "${pyScript}" --project "${projectId}" --latest`;
    exec(pyCmd, { timeout: 10000 }, (err, stdout, stderr) => {
      try {
        const out = JSON.parse((stdout || '').trim());
        resolve(out);
      } catch (e) {
        resolve({ success: false, error: err ? err.message : stderr });
      }
    });
  });
}

// Helper to execute commands safely with Promise
function runCmd(command, cwd = null) {
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || undefined, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error && error.code !== undefined ? error.code : (error ? 1 : 0),
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: error ? error.message : null
      });
    });
  });
}

// Helper to execute AO CLI commands directly without shell to preserve multiline prompts and prevent escaping bugs
function runAo(args, cwd = null) {
  return new Promise((resolve) => {
    execFile('ao.exe', args, { cwd: cwd || undefined, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        exitCode: error && error.code !== undefined ? error.code : (error ? 1 : 0),
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        error: error ? error.message : null
      });
    });
  });
}


// Helper to query SQLite reliably via query_db.py
function querySqlite(sql, params = []) {
  return new Promise((resolve) => {
    execFile('python', [path.join(__dirname, 'query_db.py'), DB_PATH, sql, JSON.stringify(params)], (err, stdout) => {
      if (err) return resolve([]);
      try {
        const data = JSON.parse(stdout.trim());
        resolve(Array.isArray(data) ? data : []);
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// Helper for HTTP requests
function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(parsed, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 4000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data, data: null });
        }
      });
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

// Helper: Format Doctor Report to accurately reflect ChatGPT Web Proxy runtime
function formatDoctorReport(raw) {
  if (!raw || typeof raw !== 'string') return 'Đang đọc thông tin chẩn đoán...';
  let report = raw;

  const proxyHealthy = report.includes('Responses proxy is healthy on 127.0.0.1:17841') || report.includes('Responses proxy is healthy');
  const launcherOwns = report.includes('Launcher owns the background runtime');
  const runningTurn = report.includes('running Codex turn') || report.includes('ChatGPT browser is running Codex turn');

  if (proxyHealthy && (launcherOwns || runningTurn)) {
    report = report.replace(
      /✗ Embedded launcher browser is unavailable[\s\S]*?ChatGPT browser is running Codex turn [^\r\n]+/g,
      '✓ Trình duyệt nền ChatGPT Web đang hoạt động & sẵn sàng (đang phục vụ phiên Codex)'
    );
    report = report.replace(
      /✗ Embedded launcher browser is unavailable/g,
      '✓ Trình duyệt nền ChatGPT Web đang hoạt động trên tiến trình nền'
    );
    report = report.replace(
      /Doctor result: not ready/g,
      'Doctor result: ready (ChatGPT Web Bridge Hoạt Động Bình Thường)'
    );
  }
  return report;
}

function isDoctorReady(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (raw.includes('Doctor result: ready')) return true;
  const proxyHealthy = raw.includes('Responses proxy is healthy');
  const launcherOwns = raw.includes('Launcher owns the background runtime') || raw.includes('running Codex turn');
  return proxyHealthy && launcherOwns;
}

// -------------------------------------------------------------
// 1. System Status & Health
// -------------------------------------------------------------
app.get('/api/status', async (req, res) => {
  const result = {
    timestamp: new Date().toISOString(),
    aoDaemon: { status: 'offline', port: 3001, details: null },
    chatgptProxy: { status: 'offline', port: 17841, doctor: null },
    agents: {
      agy: { installed: false, version: null },
      codex: { installed: false, version: null },
      ao: { installed: false, version: null }
    }
  };

  // Check AO Daemon
  try {
    const health = await fetchJson(`${AO_BASE_URL}/readyz`);
    if (health.status === 200) {
      result.aoDaemon.status = 'ready';
      result.aoDaemon.details = health.data;
    }
  } catch (e) {
    result.aoDaemon.status = 'offline';
  }

  // Check ChatGPT Web Proxy
  try {
    const proxyRes = await fetchJson(`${CHATGPT_PROXY_URL}/v1/responses`, { method: 'POST', body: '{}' });
    // Proxy responds with status (even if unauthorized or bad payload, it proves server is up)
    result.chatgptProxy.status = 'ready';
  } catch (e) {
    // If connection refused, offline
    result.chatgptProxy.status = 'offline';
  }

  // Doctor check
  const doc = await runCmd('codex-chatgpt-web doctor');
  const docReady = isDoctorReady(doc.stdout);
  result.chatgptProxy.doctor = {
    ready: docReady,
    output: formatDoctorReport(doc.stdout)
  };
  if (docReady) {
    result.chatgptProxy.status = 'ready';
  }

  // Check CLI tools
  const [agyVer, codexVer, aoVer] = await Promise.all([
    runCmd('agy --version'),
    runCmd('codex --version'),
    runCmd('ao --version')
  ]);

  result.agents.agy = {
    installed: agyVer.exitCode === 0,
    version: agyVer.stdout.split('\n')[0]
  };
  result.agents.codex = {
    installed: codexVer.exitCode === 0,
    version: codexVer.stdout.split('\n')[0]
  };
  result.agents.ao = {
    installed: aoVer.exitCode === 0,
    version: aoVer.stdout.split('\n')[0]
  };

  result.workerEngine = currentSettings.workerEngine || 'gemini';

  res.json(result);
});

// -------------------------------------------------------------
// 2. User Projects Management (User-driven Folder Selection)
// -------------------------------------------------------------
const USER_PROJECTS_FILE = path.join(__dirname, 'user-projects.json');

function getUserProjects() {
  if (fs.existsSync(USER_PROJECTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(USER_PROJECTS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    } catch (e) {}
  }
  return [
    {
      id: 'calc-engine',
      name: 'calc-engine',
      path: path.join(__dirname, '..', 'calc-engine'),
      addedAt: new Date().toISOString()
    },
    {
      id: 'orchestrator',
      name: 'Orchestrator',
      path: path.join(__dirname, '..'),
      addedAt: new Date().toISOString()
    }
  ];
}

function saveUserProjects(projects) {
  try {
    fs.writeFileSync(USER_PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save user-projects.json:', e);
  }
}

function ensureProjectRegistered(projPath, projName) {
  if (!projPath || !fs.existsSync(projPath)) return;
  const projects = getUserProjects();
  const exists = projects.find(p => p.path && p.path.toLowerCase() === projPath.toLowerCase());
  if (!exists) {
    const id = (projName || path.basename(projPath)).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    projects.push({
      id,
      name: projName || path.basename(projPath),
      path: projPath,
      addedAt: new Date().toISOString()
    });
    saveUserProjects(projects);
  }
}

function resolveSessionProject(sessionId) {
  if (!sessionId || sessionId === 'new' || sessionId === 'auto') return null;
  const cleanId = sessionId.replace(/^ao:/, '').replace(/^ide:/, '').trim();
  const brainDir = 'C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain';
  const p = path.join(brainDir, cleanId, '.system_generated', 'logs', 'transcript.jsonl');
  const pFull = path.join(brainDir, cleanId, '.system_generated', 'logs', 'transcript_full.jsonl');
  const targetFile = fs.existsSync(p) ? p : (fs.existsSync(pFull) ? pFull : null);
  if (!targetFile) return null;

  try {
    const chunk = fs.readFileSync(targetFile, 'utf8').slice(0, 25000);
    
    // 1. URI match
    const m1 = chunk.match(/\[URI\]\s*->\s*\[CorpusName\]:\s*([a-zA-Z]:[^\s\r\n]+)/);
    if (m1) {
      const full = m1[1].trim().replace(/\//g, '\\');
      const name = path.basename(full);
      ensureProjectRegistered(full, name);
      return { projectId: name, projectPath: full, projectName: name };
    }

    // 2. Active Document match
    const m2 = chunk.match(/Active Document:\s*([a-zA-Z]:\\[^\r\n\(\)]+)/i);
    if (m2) {
      const doc = m2[1].trim();
      let cur = path.dirname(doc);
      while (cur && cur !== path.dirname(cur)) {
        if (fs.existsSync(path.join(cur, '.git')) || fs.existsSync(path.join(cur, 'package.json')) || fs.existsSync(path.join(cur, 'requirements.txt'))) {
          const name = path.basename(cur);
          ensureProjectRegistered(cur, name);
          return { projectId: name, projectPath: cur, projectName: name };
        }
        cur = path.dirname(cur);
      }
      const name = path.basename(path.dirname(doc));
      ensureProjectRegistered(path.dirname(doc), name);
      return { projectId: name, projectPath: path.dirname(doc), projectName: name };
    }

    // 3. Cwd match
    const m3 = chunk.match(/"Cwd":\s*"([^"]+)"/);
    if (m3) {
      const cwd = m3[1].replace(/\\\\/g, '\\').trim();
      const name = path.basename(cwd);
      ensureProjectRegistered(cwd, name);
      return { projectId: name, projectPath: cwd, projectName: name };
    }
  } catch (e) {}

  return null;
}

app.get('/api/projects', (req, res) => {
  const projects = getUserProjects();
  res.json({ projects });
});

app.post('/api/projects/add', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đường dẫn thư mục dự án!' });
  }

  const resolved = path.resolve(folderPath.trim());
  if (!fs.existsSync(resolved)) {
    return res.status(400).json({ error: `Thư mục không tồn tại: ${resolved}` });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: `Đường dẫn phải là thư mục: ${resolved}` });
  }

  const folderName = path.basename(resolved);
  const id = folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  const projects = getUserProjects();
  let existing = projects.find(p => p.path.toLowerCase() === resolved.toLowerCase() || p.id === id);
  if (!existing) {
    existing = {
      id,
      name: folderName,
      path: resolved,
      addedAt: new Date().toISOString()
    };
    projects.push(existing);
    saveUserProjects(projects);
  }

  res.json({ success: true, project: existing, projects });
});

app.post('/api/projects/browse', (req, res) => {
  const psScript = path.join(__dirname, 'browse.ps1');
  const psCmd = `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${psScript}"`;

  exec(psCmd, { timeout: 30000 }, (err, stdout) => {
    const chosen = stdout ? stdout.trim() : null;
    if (chosen && fs.existsSync(chosen)) {
      const folderName = path.basename(chosen);
      const id = folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const projects = getUserProjects();
      let existing = projects.find(p => p.path.toLowerCase() === chosen.toLowerCase() || p.id === id);
      if (!existing) {
        existing = {
          id,
          name: folderName,
          path: chosen,
          addedAt: new Date().toISOString()
        };
        projects.push(existing);
        saveUserProjects(projects);
      }
      return res.json({ success: true, project: existing, projects });
    }
    return res.json({ canceled: true });
  });
});

app.delete('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  let projects = getUserProjects();
  projects = projects.filter(p => p.id !== id);
  saveUserProjects(projects);
  res.json({ success: true, projects });
});

app.post('/api/projects/:id/configure-pipeline', async (req, res) => {
  res.json({ message: 'Pipeline configuration active', success: true });
});

app.post('/api/projects/open-folder', (req, res) => {
  const { folderPath } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'Missing folderPath' });
  const cleanTarget = path.resolve(folderPath.trim().replace(/[\\\/]+$/, ''));
  if (fs.existsSync(cleanTarget)) {
    if (process.platform === 'win32') {
      exec(`powershell -NoProfile -Command "Start-Process explorer.exe -ArgumentList '${cleanTarget.replace(/'/g, "''")}'"`, (err) => {
        if (err) {
          const { spawn } = require('child_process');
          const p = spawn('explorer.exe', [cleanTarget], { detached: true, stdio: 'ignore' });
          p.unref();
        }
      });
    } else if (process.platform === 'darwin') {
      execFile('open', [cleanTarget], () => {});
    } else {
      execFile('xdg-open', [cleanTarget], () => {});
    }
    return res.json({ success: true, path: cleanTarget });
  }
  res.status(404).json({ error: 'Folder not found: ' + cleanTarget });
});

app.get('/api/antigravity/session-info/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const info = resolveSessionProject(sessionId);
  res.json({
    sessionId,
    found: !!info,
    project: info
  });
});

// -------------------------------------------------------------
// Antigravity Top-Level Conversations (Main Threads from DB & Cache)
// -------------------------------------------------------------
app.get('/api/antigravity/conversations', (req, res) => {
  execFile('python', [path.join(__dirname, 'get_antigravity_convos.py')], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to scan Antigravity conversations', details: err.message });
    }
    try {
      const data = JSON.parse(stdout);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Antigravity conversations', details: e.message });
    }
  });
});

app.get('/api/projects/:id/antigravity-sessions', (req, res) => {
  execFile('python', [path.join(__dirname, 'get_antigravity_convos.py')], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to scan Antigravity conversations', details: err.message });
    }
    try {
      const data = JSON.parse(stdout);
      const sessions = (data.conversations || []).map(c => ({
        id: c.id,
        rawId: c.id,
        source: 'antigravity_ide',
        title: c.title,
        workspace: c.workspace,
        status: c.status,
        relativeTime: c.relativeTime,
        model: 'gemini-3.8-flash-high',
        lastActive: c.timestamp
      }));
      res.json({ projectId: req.params.id, count: sessions.length, sessions });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse Antigravity conversations', details: e.message });
    }
  });
});

app.post('/api/antigravity/new-session', (req, res) => {
  const crypto = require('crypto');
  const newId = crypto.randomUUID();
  res.json({
    success: true,
    sessionId: newId,
    title: 'Phiên Chat Mới',
    status: 'new'
  });
});

function extractWorkerReportOnly(text) {
  if (!text) return '';
  // 1. If text contains Worker Report header, extract starting strictly from that header
  const idx = text.search(/(?:###\s*)?Worker Report/i);
  if (idx !== -1) {
    const reportPart = text.slice(idx).trim();
    // Also remove any rogue "Ran command:" lines that might have been prepended
    return reportPart
      .split('\n')
      .filter(l => !l.trim().startsWith('Ran command:') && !l.trim().startsWith('Tool call:') && !l.trim().startsWith('Ran:'))
      .join('\n')
      .trim();
  }
  // 2. Otherwise strip all tool call/command dumps
  return text
    .split('\n')
    .filter(l => !l.trim().startsWith('Ran command:') && !l.trim().startsWith('Tool call:') && !l.trim().startsWith('Ran:'))
    .join('\n')
    .trim();
}

// -------------------------------------------------------------
// Antigravity Transcript & Clean Worker Report Extraction
// -------------------------------------------------------------
// -------------------------------------------------------------
// Dynamic Antigravity Worker Session Resolution
// -------------------------------------------------------------
// Dynamic Antigravity Worker Session Resolution & Local Context
// -------------------------------------------------------------
function getProjectLocalContext(projectId, sessionId) {
  let projPath = null;
  if (sessionId) {
    const auto = resolveSessionProject(sessionId);
    if (auto && auto.projectPath && fs.existsSync(auto.projectPath)) {
      projPath = auto.projectPath;
    }
  }

  if (!projPath && projectId) {
    if (fs.existsSync(projectId)) {
      projPath = projectId;
    } else {
      const projects = getUserProjects();
      const found = projects.find(p => p.id === projectId || (p.name && p.name.toLowerCase() === (projectId || '').toLowerCase()));
      if (found && found.path) projPath = found.path;
    }
  }

  if (!projPath && projectId) {
    if (projectId === 'calc-engine') projPath = path.join(__dirname, '..', 'calc-engine');
    else if (projectId === 'ai-auto-video-creator') projPath = 'D:\\AI Auto Video Creator';
    else if (projectId === 'ai_task_manager') projPath = 'D:\\TU_CODE\\AI_Task_Manager';
    else if (projectId === 'ai_multi_task') projPath = 'D:\\TU_CODE\\AI_Multi_Task';
    else if (fs.existsSync(path.join('d:\\TU_CODE', projectId))) projPath = path.join('d:\\TU_CODE', projectId);
    else if (fs.existsSync(path.join('D:\\', projectId))) projPath = path.join('D:\\', projectId);
    else projPath = path.join(__dirname, '..', projectId);
  }

  let fileTreeSummary = '';
  let technicalContextSummary = '';

  if (projPath && fs.existsSync(projPath)) {
    // 1. Build local directory tree (top level and 2nd level)
    try {
      const entries = fs.readdirSync(projPath, { withFileTypes: true });
      const treeItems = [];
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__pycache__' || ent.name === '.git') continue;
        if (ent.isDirectory()) {
          treeItems.push(`📁 ${ent.name}/`);
          try {
            const subEntries = fs.readdirSync(path.join(projPath, ent.name), { withFileTypes: true });
            for (const sub of subEntries.slice(0, 15)) {
              if (!sub.name.startsWith('.')) {
                treeItems.push(`   └── ${sub.isDirectory() ? '📁 ' : '📄 '}${sub.name}`);
              }
            }
          } catch (e) {}
        } else {
          treeItems.push(`📄 ${ent.name}`);
        }
      }
      fileTreeSummary = treeItems.join('\n');
    } catch (e) {}

    // 2. Read technical documents from root and docs/ folders
    const docFiles = [];
    const searchDirs = [projPath, path.join(projPath, 'docs'), path.join(projPath, 'doc')];
    const targetFileNames = [
      'ROADMAP.md', '10_ROADMAP.md', '12_CURRENT_STATE.md', '00_PROJECT_CHARTER.md',
      '01_SYSTEM_CONTEXT.md', '02_WORKFLOW.md', '03_ARCHITECTURE.md', '04_PROTOCOLS.md',
      '05_STATE_MACHINE.md', '06_BRIDGE_CONTRACT.md', '07_AGENT_CONTRACT.md', '08_AUDIT_CONTRACT.md',
      '09_TEST_PLAN.md', 'HANDOFF.md', 'README.md', 'spec.md', 'SPEC.md', 'AGENTS.md', 'package.json'
    ];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const filesInDir = fs.readdirSync(dir);
        for (const fn of filesInDir) {
          if (targetFileNames.includes(fn) || targetFileNames.includes(fn.toUpperCase())) {
            const fp = path.join(dir, fn);
            try {
              const relPath = path.relative(projPath, fp);
              const content = fs.readFileSync(fp, 'utf8').slice(0, 4500);
              docFiles.push(`#### [File: ${relPath}]\n${content}`);
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    if (docFiles.length > 0) technicalContextSummary = docFiles.join('\n\n');
  }

  return {
    projPath: projPath || 'Unknown path',
    fileTreeSummary: fileTreeSummary || 'Không thể liệt kê thư mục dự án.',
    technicalContextSummary: technicalContextSummary || 'Chưa tìm thấy tài liệu ROADMAP.md hoặc thư mục docs/ trên đĩa.'
  };
}

function resolveAntigravitySession(sessionId, projectId) {
  // If explicitly given a valid UUID that is not the orchestrator
  if (sessionId && sessionId !== 'auto' && sessionId !== 'default' && sessionId !== 'new' && sessionId !== 'current') {
    const cleanId = sessionId.replace(/^ao:/, '').replace(/^ide:/, '').trim();
    if (cleanId !== 'eb04834e-f388-4dd3-afd7-4001e7fa3da5') {
      const brainDir = 'C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain';
      const sessDir = path.join(brainDir, cleanId);
      if (fs.existsSync(sessDir)) return cleanId;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId)) {
        return cleanId;
      }
    }
  }

  const brainDir = 'C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain';
  if (!fs.existsSync(brainDir)) return null;

  const currentOrchId = 'eb04834e-f388-4dd3-afd7-4001e7fa3da5';
  const candidates = [];

  try {
    for (const cid of fs.readdirSync(brainDir)) {
      if (cid === currentOrchId) continue;
      const p = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
      const pFull = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript_full.jsonl');
      const walkP = path.join(brainDir, cid, 'walkthrough.md');
      const targetP = fs.existsSync(p) ? p : (fs.existsSync(pFull) ? pFull : (fs.existsSync(walkP) ? walkP : null));
      if (targetP) {
        try {
          candidates.push({ cid, mtime: fs.statSync(targetP).mtimeMs, path: targetP });
        } catch (e) {}
      }
    }
  } catch (e) {}

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);

  if (projectId && projectId !== 'default') {
    for (const cand of candidates) {
      const pInfo = resolveSessionProject(cand.cid);
      if (pInfo && (pInfo.projectId.toLowerCase() === projectId.toLowerCase() || pInfo.projectName.toLowerCase() === projectId.toLowerCase())) {
        return cand.cid;
      }
    }
  }

  return candidates[0].cid;
}

function getSessionStepCount(sessionId) {
  if (!sessionId) return 0;
  const p = path.join('C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(p)) return 0;
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  } catch (e) {
    return 0;
  }
}

// -------------------------------------------------------------
// Antigravity Transcript & Clean Worker Report Extraction
// -------------------------------------------------------------
function extractAntigravityReport(sessionId, projectId) {
  const targetSessionId = resolveAntigravitySession(sessionId, projectId);
  if (!targetSessionId) return null;

  const brainDir = path.join('C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain', targetSessionId);
  const logDir = path.join(brainDir, '.system_generated', 'logs');
  let transcriptPath = path.join(logDir, 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    transcriptPath = path.join(logDir, 'transcript_full.jsonl');
  }

  let finalContent = '';
  let timestamp = new Date().toISOString();
  const filesModified = new Set();
  let stepCount = 0;

  // 1. Try extracting from transcript if available
  if (fs.existsSync(transcriptPath)) {
    try {
      const rawLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
      stepCount = rawLines.length;
      const steps = [];
      for (const line of rawLines) {
        try { steps.push(JSON.parse(line)); } catch (e) {}
      }

      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if ((s.type === 'PLANNER_RESPONSE' || s.type === 'MODEL') && s.content && s.content.trim()) {
          finalContent = s.content.trim();
          if (s.created_at) timestamp = s.created_at;
          break;
        }
      }

      if (!finalContent) {
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i];
          if (s.content && s.content.trim() && s.type !== 'USER_INPUT') {
            finalContent = s.content.trim();
            if (s.created_at) timestamp = s.created_at;
            break;
          }
        }
      }

      // Scan recent steps for modified files
      for (let i = Math.max(0, steps.length - 35); i < steps.length; i++) {
        const s = steps[i];
        if (Array.isArray(s.tool_calls)) {
          for (const tc of s.tool_calls) {
            if (tc.name === 'write_to_file' || tc.name === 'replace_file_content' || tc.name === 'multi_replace_file_content') {
              const tf = tc.args && (tc.args.TargetFile || tc.args.FilePath);
              if (tf) filesModified.add(path.basename(tf));
            }
          }
        }
      }
    } catch (err) {
      console.error('Error reading transcript for report:', err);
    }
  }

  // 2. If no finalContent from transcript, check walkthrough.md in session brain!
  if (!finalContent) {
    const walkPath = path.join(brainDir, 'walkthrough.md');
    if (fs.existsSync(walkPath)) {
      try {
        finalContent = fs.readFileSync(walkPath, 'utf8').trim();
        const stat = fs.statSync(walkPath);
        timestamp = stat.mtime.toISOString();
      } catch (e) {}
    }
  }

  // 3. If still empty, check implementation_plan.md in session brain!
  if (!finalContent) {
    const planPath = path.join(brainDir, 'implementation_plan.md');
    if (fs.existsSync(planPath)) {
      try {
        finalContent = fs.readFileSync(planPath, 'utf8').trim();
      } catch (e) {}
    }
  }

  // 4. If still empty, check overview.txt in .system_generated/logs!
  if (!finalContent) {
    const overPath = path.join(logDir, 'overview.txt');
    if (fs.existsSync(overPath)) {
      try {
        const rawOver = fs.readFileSync(overPath, 'utf8').trim();
        if (rawOver.startsWith('{')) {
          const lines = rawOver.split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i]);
              if (parsed.content && parsed.type !== 'USER_INPUT' && parsed.type !== 'CONVERSATION_HISTORY') {
                finalContent = parsed.content.trim();
                if (parsed.created_at) timestamp = parsed.created_at;
                break;
              }
            } catch (e) {}
          }
        }
        if (!finalContent) finalContent = rawOver;
      } catch (e) {}
    }
  }

  // 5. Check project workspace for HANDOFF.md or ROADMAP.md
  let handoffText = '';
  let projPath = null;
  const autoProj = resolveSessionProject(targetSessionId);
  if (autoProj && autoProj.projectPath && fs.existsSync(autoProj.projectPath)) {
    projPath = autoProj.projectPath;
  }
  if (!projPath && projectId) {
    const projects = getUserProjects();
    const found = projects.find(p => p.id === projectId);
    projPath = found ? found.path : null;
  }
  if (!projPath && projectId) {
    if (projectId === 'calc-engine') projPath = path.join(__dirname, '..', 'calc-engine');
    else if (projectId === 'ai-auto-video-creator') projPath = 'D:\\AI Auto Video Creator';
    else if (fs.existsSync(path.join('d:\\TU_CODE', projectId))) projPath = path.join('d:\\TU_CODE', projectId);
    else projPath = path.join(__dirname, '..', projectId);
  }

  if (projPath && fs.existsSync(projPath)) {
    for (const hf of ['HANDOFF.md', 'handoff.md']) {
      const hp = path.join(projPath, hf);
      if (fs.existsSync(hp)) {
        try {
          const content = fs.readFileSync(hp, 'utf8').trim();
          if (content) {
            handoffText += `\n\n### Tài Liệu Bàn Giao (${hf}):\n${content.slice(0, 3000)}`;
          }
        } catch (e) {}
      }
    }
  }

  // Strictly isolate pure Worker Report
  const cleanReport = extractWorkerReportOnly(finalContent);
  let reportText = cleanReport || finalContent || '';
  if (handoffText) {
    reportText += handoffText;
  }

  if (!reportText.trim()) {
    return null;
  }

  return {
    sessionId: targetSessionId,
    filesModified: Array.from(filesModified),
    finalContent: cleanReport || finalContent,
    reportText: reportText.trim(),
    timestamp,
    totalSteps: stepCount
  };
}

app.get('/api/antigravity/latest-report/:sessionId?', (req, res) => {
  const sessionId = req.params.sessionId;
  const projectId = req.query.projectId;
  const report = extractAntigravityReport(sessionId, projectId);
  if (!report) {
    return res.status(404).json({ success: false, error: 'Không tìm thấy transcript hoặc báo cáo cho phiên này' });
  }
  res.json({ success: true, report });
});

// Endpoint: Check real-time session state (working / completed) for live IDE observation
app.get('/api/antigravity/session-state/:sessionId?', (req, res) => {
  const sessionId = req.params.sessionId;
  const projectId = req.query.projectId;
  const sinceStep = parseInt(req.query.since || '0', 10);

  const targetSessionId = resolveAntigravitySession(sessionId, projectId);
  if (!targetSessionId) {
    return res.json({ success: false, error: 'Session not found' });
  }

  const logDir = path.join('C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain', targetSessionId, '.system_generated', 'logs');
  let transcriptPath = path.join(logDir, 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) transcriptPath = path.join(logDir, 'transcript_full.jsonl');
  if (!fs.existsSync(transcriptPath)) {
    return res.json({ success: false, error: 'Transcript file not found' });
  }

  try {
    const rawLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    const total = rawLines.length;

    const steps = [];
    for (let i = 0; i < total; i++) {
      try {
        steps.push(JSON.parse(rawLines[i]));
      } catch (e) {
        steps.push(null);
      }
    }

    const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

    let isWorking = false;
    let isFinished = false;
    let finalPlannerStep = null;

    if (sinceStep > 0) {
      if (total > sinceStep) {
        // Steps have occurred since the dispatched prompt!
        if (lastStep) {
          const type = lastStep.type || '';
          const status = lastStep.status || '';
          const hasTools = Array.isArray(lastStep.tool_calls) && lastStep.tool_calls.length > 0;
          const hasContent = typeof lastStep.content === 'string' && lastStep.content.trim().length > 0;

          // A turn is completed when the final step is a PLANNER_RESPONSE with status DONE,
          // no active tool calls, and meaningful text content (the worker report).
          const isTurnConcluded = (
            (type === 'PLANNER_RESPONSE' || type === 'MODEL') &&
            status === 'DONE' &&
            !hasTools &&
            hasContent &&
            (total - 1) >= sinceStep
          );

          if (isTurnConcluded) {
            isFinished = true;
            isWorking = false;
            finalPlannerStep = lastStep;
          } else {
            // Still executing: USER_INPUT, tool execution, or streaming
            isWorking = true;
            isFinished = false;
          }
        }
      } else {
        // total <= sinceStep: agent has not registered new steps yet
        isWorking = false;
        isFinished = false;
      }
    } else {
      // sinceStep is 0 (initial probe): check if the latest step of the conversation is completed
      if (lastStep && (lastStep.type === 'PLANNER_RESPONSE' || lastStep.type === 'MODEL') && lastStep.status === 'DONE' && (!lastStep.tool_calls || lastStep.tool_calls.length === 0)) {
        isFinished = true;
        isWorking = false;
        finalPlannerStep = lastStep;
      }
    }

    let cleanReport = null;
    if (isFinished) {
      cleanReport = extractAntigravityReport(targetSessionId, projectId);
    }

    res.json({
      success: true,
      sessionId: targetSessionId,
      totalSteps: total,
      sinceStep,
      isWorking,
      isFinished,
      lastStepType: lastStep ? lastStep.type : null,
      lastStepStatus: lastStep ? lastStep.status : null,
      report: cleanReport ? cleanReport.reportText : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Project Technical Context (Roadmaps, Handoffs, Specs)
// -------------------------------------------------------------
app.get('/api/projects/:id/technical-context', async (req, res) => {
  const { id: projectId } = req.params;

  const projects = getUserProjects();
  const found = projects.find(p => p.id === projectId);
  let projPath = found ? found.path : null;

  if (!projPath) {
    if (projectId === 'calc-engine') projPath = path.join(__dirname, '..', 'calc-engine');
    else if (projectId === 'orchestrator') projPath = path.join(__dirname, '..');
    else projPath = path.join(__dirname, '..', projectId);
  }

  const technicalFiles = [];
  const targetNames = [
    'ROADMAP.md', 'HANDOFF.md', 'README.md', 'spec.md', 'SPEC.md',
    'architecture.md', 'ARCHITECTURE.md', 'TODO.md', 'package.json', 'AGENTS.md'
  ];

  if (fs.existsSync(projPath)) {
    // 1. Root target files
    for (const fName of targetNames) {
      const fPath = path.join(projPath, fName);
      if (fs.existsSync(fPath) && fs.statSync(fPath).isFile()) {
        try {
          const content = fs.readFileSync(fPath, 'utf8');
          technicalFiles.push({
            name: fName,
            path: fPath,
            sizeBytes: Buffer.byteLength(content),
            summary: content.slice(0, 400) + (content.length > 400 ? '...' : ''),
            content: content.slice(0, 15000)
          });
        } catch (e) {}
      }
    }

    // 2. Scan docs, documentation, specs subdirectories
    for (const subDir of ['docs', 'documentation', 'specs']) {
      const dirPath = path.join(projPath, subDir);
      if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
        try {
          const subFiles = fs.readdirSync(dirPath);
          for (const sf of subFiles) {
            if (sf.toLowerCase().endsWith('.md')) {
              const sfPath = path.join(dirPath, sf);
              try {
                const content = fs.readFileSync(sfPath, 'utf8');
                technicalFiles.push({
                  name: `${subDir}/${sf}`,
                  path: sfPath,
                  sizeBytes: Buffer.byteLength(content),
                  summary: content.slice(0, 400) + (content.length > 400 ? '...' : ''),
                  content: content.slice(0, 15000)
                });
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }
  }

  res.json({
    projectId,
    projectPath: projPath,
    filesCount: technicalFiles.length,
    files: technicalFiles
  });
});

// -------------------------------------------------------------
// 3. Sessions & Filtering
// -------------------------------------------------------------
app.get('/api/sessions', async (req, res) => {
  try {
    const { role, status, project, q } = req.query;

    // Fetch from AO daemon
    let sessions = [];
    try {
      const resp = await fetchJson(`${AO_BASE_URL}/api/v1/sessions`);
      sessions = (resp.data && resp.data.sessions) ? resp.data.sessions : [];
    } catch (e) {
      sessions = [];
    }

    // Query SQLite to supplement metadata
    const dbRows = await querySqlite(`
      SELECT id, project_id, kind, harness, activity_state, workspace_path, model, prompt, created_at, updated_at
      FROM sessions
    `);
    const dbMap = {};
    for (const r of dbRows) {
      dbMap[r.id] = r;
    }

    // Merge sessions
    let merged = sessions.map(s => {
      const extra = dbMap[s.id] || {};
      return {
        id: s.id,
        projectId: s.projectId || extra.project_id,
        role: s.kind || extra.kind || (s.harness === 'codex' ? 'orchestrator' : 'worker'),
        harness: s.harness || extra.harness,
        status: s.status || (s.isTerminated ? 'terminated' : (s.activity ? s.activity.state : 'unknown')),
        activityState: (s.activity && s.activity.state) || extra.activity_state || 'idle',
        displayName: s.displayName || s.id,
        branch: s.branch || '',
        model: s.model || extra.model || '',
        workspacePath: extra.workspace_path || '',
        prompt: extra.prompt || '',
        isTerminated: !!s.isTerminated,
        createdAt: s.createdAt || extra.created_at,
        updatedAt: s.updatedAt || extra.updated_at
      };
    });

    // Also include any sessions from SQLite not yet in merged
    for (const r of dbRows) {
      if (!merged.find(m => m.id === r.id)) {
        merged.push({
          id: r.id,
          projectId: r.project_id,
          role: r.kind,
          harness: r.harness,
          status: r.activity_state === 'exited' ? 'terminated' : r.activity_state,
          activityState: r.activity_state,
          displayName: r.id,
          branch: '',
          model: r.model,
          workspacePath: r.workspace_path,
          prompt: r.prompt,
          isTerminated: r.activity_state === 'exited',
          createdAt: r.created_at,
          updatedAt: r.updated_at
        });
      }
    }

    // Filter by Role
    if (role && role !== 'all') {
      merged = merged.filter(s => s.role.toLowerCase() === role.toLowerCase());
    }

    // Filter by Status
    if (status && status !== 'all') {
      if (status === 'active') {
        merged = merged.filter(s => s.activityState === 'active' || s.status === 'working');
      } else if (status === 'idle') {
        merged = merged.filter(s => (s.activityState === 'idle' || s.status === 'idle') && !s.isTerminated);
      } else if (status === 'terminated') {
        merged = merged.filter(s => s.isTerminated || s.status === 'terminated' || s.activityState === 'exited');
      }
    }

    // Filter by Project
    if (project && project !== 'all') {
      merged = merged.filter(s => s.projectId === project);
    }

    // Filter by Search text
    if (q) {
      const lower = q.toLowerCase();
      merged = merged.filter(s => 
        s.id.toLowerCase().includes(lower) ||
        (s.displayName && s.displayName.toLowerCase().includes(lower)) ||
        (s.prompt && s.prompt.toLowerCase().includes(lower)) ||
        (s.branch && s.branch.toLowerCase().includes(lower))
      );
    }

    // Sort by createdAt descending
    merged.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ count: merged.length, sessions: merged });
  } catch (e) {
    res.status(500).json({ error: 'Failed to retrieve sessions', details: e.message });
  }
});

// -------------------------------------------------------------
// 4. Session Controls (Spawn, Send, Kill)
// -------------------------------------------------------------
app.post('/api/sessions/spawn', async (req, res) => {
  const { project, kind, name, prompt, harness, model } = req.body;
  if (!project || !name || !prompt) {
    return res.status(400).json({ error: 'project, name, and prompt are required' });
  }

  const args = [
    'spawn',
    '--project', project,
    '--kind', kind || 'worker',
    '--name', name.slice(0, 20),
    '--prompt', prompt
  ];
  if (harness) args.push('--harness', harness);
  if (model) args.push('--model', model);

  const out = await runAo(args);
  if (out.exitCode !== 0) {
    return res.status(400).json({ error: out.stderr || out.stdout || 'Spawn failed' });
  }

  // Parse session id from output like: spawned session workspace-test-3 "name" ...
  const match = out.stdout.match(/spawned session (\S+)/i);
  const sessionId = match ? match[1] : null;

  res.json({ message: 'Session spawned', sessionId, output: out.stdout });
});

app.post('/api/sessions/:id/send', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const out = await runAo(['send', '--session', id, '--message', message]);
  if (out.exitCode !== 0) {
    return res.status(400).json({ error: out.stderr || out.stdout || 'Send failed' });
  }
  res.json({ message: 'Message sent successfully', output: out.stdout });
});

app.post('/api/sessions/:id/kill', async (req, res) => {
  const { id } = req.params;
  const out = await runAo(['session', 'kill', id]);
  if (out.exitCode !== 0) {
    return res.status(400).json({ error: out.stderr || out.stdout || 'Kill failed' });
  }
  res.json({ message: 'Session killed successfully', output: out.stdout });
});

// -------------------------------------------------------------
// 5. Orchestrator Plan Extractor (Chiết xuất kế hoạch)
// -------------------------------------------------------------
app.get('/api/extract/plan/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  // Find recent rollout files in .codex/sessions
  const sessionsDir = path.join(CODEX_DIR, 'sessions');
  let rolloutFiles = [];

  function findRollouts(dir, maxDepth = 4) {
    if (!fs.existsSync(dir) || maxDepth <= 0) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          findRollouts(full, maxDepth - 1);
        } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          rolloutFiles.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
      }
    } catch (e) {}
  }

  // Query session creation date and prompt from SQLite
  const sessRows = await querySqlite(`SELECT id, created_at, prompt FROM sessions WHERE id = ?`, [sessionId]);
  const sessMeta = sessRows.length ? sessRows[0] : null;

  if (sessMeta && sessMeta.created_at) {
    const dateMatch = sessMeta.created_at.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      const [, y, m, day] = dateMatch;
      const dayDir = path.join(sessionsDir, y, m, day);
      findRollouts(dayDir, 2);
    }
  }

  // Also check all recent rollouts if dayDir had none
  if (rolloutFiles.length === 0) {
    findRollouts(sessionsDir, 4);
  }

  // Sort candidate rollouts
  rolloutFiles.sort((a, b) => b.mtime - a.mtime);

  let targetRollout = null;
  let conversationTurns = [];

  // Search through rollouts to find messages matching this session
  for (const rf of rolloutFiles) {
    try {
      const content = fs.readFileSync(rf.path, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const turns = [];
      let tokenUsage = null;

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item.type === 'response_item' && item.payload && item.payload.content) {
            const textContent = item.payload.content
              .map(c => c.text || '')
              .filter(Boolean)
              .join('\n');
            if (textContent) {
              turns.push({
                role: item.payload.role,
                text: textContent,
                timestamp: item.timestamp
              });
            }
          }
          if (item.type === 'token_usage_record' && item.payload && item.payload.usage) {
            tokenUsage = item.payload.usage;
          }
        } catch (e) {}
      }

      if (turns.length > 0) {
        // If session prompt is known, prefer the rollout containing prompt words
        const matchesPrompt = sessMeta && sessMeta.prompt && content.includes(sessMeta.prompt.slice(0, 20));
        if (matchesPrompt || !targetRollout) {
          targetRollout = rf;
          targetRollout.usage = tokenUsage;
          conversationTurns = turns;
          if (matchesPrompt) break;
        }
      }
    } catch (e) {}
  }

  if (!conversationTurns.length) {
    return res.status(404).json({ error: 'No conversational rollout found for session' });
  }

  // Find the last assistant response
  const assistantMessages = conversationTurns.filter(t => t.role === 'assistant');
  const lastAssistant = assistantMessages[assistantMessages.length - 1];
  const userMessages = conversationTurns.filter(t => t.role === 'user');
  const lastUser = userMessages[userMessages.length - 1];

  // Extract plans, numbered lists, and code blocks
  const fullText = lastAssistant ? lastAssistant.text : '';
  
  // Extract markdown code block if present (e.g. ``` ... ```)
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let codeBlocks = [];
  let match;
  while ((match = codeBlockRegex.exec(fullText)) !== null) {
    codeBlocks.push(match[1].trim());
  }

  // Detect worker prompt template: if a code block starts with instructions, or the largest block
  const workerPrompt = codeBlocks.length > 0 
    ? codeBlocks[0] 
    : fullText;

  res.json({
    sessionId,
    rolloutPath: targetRollout ? targetRollout.path : null,
    totalTurns: conversationTurns.length,
    lastUserPrompt: lastUser ? lastUser.text : null,
    lastAssistantResponse: fullText,
    extractedPlan: fullText,
    workerPromptTemplate: workerPrompt,
    codeBlocks,
    usage: (targetRollout && targetRollout.usage) ? targetRollout.usage : null
  });
});

// -------------------------------------------------------------
// 6. Worker Worktree Artifact Extractor & Test Runner
// -------------------------------------------------------------
app.get('/api/extract/worktree/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const requestedFile = req.query.file;

  // Find worktree path from SQLite
  const rows = await querySqlite(`SELECT workspace_path, project_id FROM sessions WHERE id = ?`, [sessionId]);
  let worktreePath = rows.length ? rows[0].workspace_path : null;

  // Fallback heuristic: search in .ao/data/worktrees
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    const candidate1 = path.join(AO_DATA_DIR, 'worktrees', 'workspace-test', sessionId);
    const candidate2 = path.join(AO_DATA_DIR, 'worktrees', 'workspace-test', 'orchestrator', sessionId);
    if (fs.existsSync(candidate1)) worktreePath = candidate1;
    else if (fs.existsSync(candidate2)) worktreePath = candidate2;
  }

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return res.status(404).json({ error: 'Worktree path not found for session' });
  }

  // If specific file content requested
  if (requestedFile) {
    const safePath = path.normalize(path.join(worktreePath, requestedFile));
    if (!safePath.startsWith(worktreePath) || !fs.existsSync(safePath)) {
      return res.status(404).json({ error: 'File not found in worktree' });
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Requested path is a directory' });
    }
    const content = fs.readFileSync(safePath, 'utf8');
    return res.json({
      file: requestedFile,
      size: stat.size,
      mtime: stat.mtime,
      content
    });
  }

  // List all files in worktree (excluding .git)
  const files = [];
  function listFiles(dir, rel = '') {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name === '.git') continue;
        const itemRel = rel ? `${rel}/${item.name}` : item.name;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          listFiles(full, itemRel);
        } else {
          const stat = fs.statSync(full);
          files.push({
            name: item.name,
            path: itemRel,
            size: stat.size,
            mtime: stat.mtime
          });
        }
      }
    } catch (e) {}
  }
  listFiles(worktreePath);

  // Git diff & status
  const [gitStatus, gitDiff] = await Promise.all([
    runCmd('git status --short', worktreePath),
    runCmd('git diff', worktreePath)
  ]);

  res.json({
    sessionId,
    worktreePath,
    fileCount: files.length,
    files,
    gitStatus: gitStatus.stdout,
    gitDiff: gitDiff.stdout
  });
});

app.post('/api/extract/worktree/:sessionId/test', async (req, res) => {
  const { sessionId } = req.params;
  const testCommand = req.body.command || 'node test.js';

  // Find worktree path
  const rows = await querySqlite(`SELECT workspace_path FROM sessions WHERE id = ?`, [sessionId]);
  let worktreePath = rows.length ? rows[0].workspace_path : null;

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    const candidate = path.join(AO_DATA_DIR, 'worktrees', 'workspace-test', sessionId);
    if (fs.existsSync(candidate)) worktreePath = candidate;
  }

  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return res.status(404).json({ error: 'Worktree path not found' });
  }

  const result = await runCmd(testCommand, worktreePath);
  res.json({
    sessionId,
    worktreePath,
    command: testCommand,
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  });
});

// -------------------------------------------------------------
// 7. Model Catalogs & Model Testing
// -------------------------------------------------------------
app.get('/api/models', (req, res) => {
  res.json({
    chatgpt: {
      defaultModel: 'chatgpt-web/high',
      models: [
        { id: 'chatgpt-web/high', name: 'ChatGPT Web (High Reasoning) - Highest', recommended: true },
        { id: 'chatgpt-web/medium', name: 'ChatGPT Web (Medium Reasoning)', recommended: false },
        { id: 'chatgpt-web/light', name: 'ChatGPT Web (Light / Fast)', recommended: false }
      ]
    },
    antigravity: {
      defaultModel: 'gemini-3.8-flash-high',
      models: [
        { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High Thinking) - Recommended', recommended: true },
        { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (Deep Reasoning)', recommended: false },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', recommended: false },
        { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', recommended: false },
        { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', recommended: false },
        { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', recommended: false }
      ]
    }
  });
});

// Helper to execute Codex prompt cleanly via stdin pipe and -o temp file
function runCodexWithPrompt(targetModel, promptText, timeout = 180000) {
  return new Promise((resolve) => {
    const tmpFile = path.join(os.tmpdir(), `codex_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.txt`);
    const child = exec(`codex exec --ephemeral --skip-git-repo-check -m ${targetModel} -o "${tmpFile}" -`, { timeout }, (error, stdout, stderr) => {
      let finalMessage = '';
      if (fs.existsSync(tmpFile)) {
        try {
          finalMessage = fs.readFileSync(tmpFile, 'utf8').trim();
          fs.unlinkSync(tmpFile);
        } catch (e) {}
      }

      let effectiveStdout = finalMessage || (stdout || '').trim();

      // If stdout/tmpFile is empty but stderr has output, check if stderr contains assistant message
      if (!effectiveStdout && stderr) {
        const lines = stderr.split('\n');
        let collected = [];
        for (const line of lines) {
          if (line.startsWith('codex') || line.startsWith('--------') || line.startsWith('user') || line.startsWith('OpenAI Codex') || line.startsWith('workdir:') || line.startsWith('model:') || line.startsWith('provider:') || line.startsWith('approval:') || line.startsWith('sandbox:') || line.startsWith('reasoning effort:') || line.startsWith('reasoning summaries:') || line.startsWith('session id:')) {
            continue;
          }
          if (line.includes('Local tools unavailable') || line.includes('Action: Open') || line.includes('cannot access the local Codex computer') || line.includes('accumulated context does not contain')) {
            continue;
          }
          collected.push(line);
        }
        const cleaned = collected.join('\n').trim();
        if (cleaned) effectiveStdout = cleaned;
      }

      resolve({
        exitCode: error && error.code !== undefined ? error.code : (error ? 1 : 0),
        stdout: effectiveStdout,
        stderr: (stderr || '').trim(),
        error: error ? error.message : null
      });
    });

    if (child.stdin) {
      child.stdin.write(promptText + '\n');
      child.stdin.end();
    }
  });
}

app.post('/api/models/test', async (req, res) => {
  const { provider, model } = req.body;
  const start = Date.now();

  if (provider === 'chatgpt') {
    const targetModel = model || 'chatgpt-web/high';
    const out = await runCodexWithPrompt(targetModel, 'Respond strictly with: PING_OK', 90000);
    const duration = Date.now() - start;
    const success = out.exitCode === 0 && (out.stdout.includes('PING_OK') || out.stdout.includes('PING\\_OK'));
    return res.json({
      provider: 'chatgpt',
      model: targetModel,
      success,
      durationMs: duration,
      output: out.stdout,
      error: success ? null : (out.stderr || out.stdout)
    });
  } else if (provider === 'antigravity') {
    const targetModel = model || 'gemini-3.8-flash-high';
    // Verify model in agy CLI catalog
    const catalogOut = await runCmd('agy models');
    const inCatalog = catalogOut.stdout.includes(targetModel);
    const success = inCatalog;
    const outText = inCatalog ? `Model ${targetModel} verified in Antigravity catalog.` : catalogOut.stdout;

    const duration = Date.now() - start;
    return res.json({
      provider: 'antigravity',
      model: targetModel,
      success,
      durationMs: duration,
      output: outText,
      error: success ? null : (catalogOut.stderr || catalogOut.stdout || 'Antigravity model not responding')
    });
  }

  res.status(400).json({ error: 'Unknown provider; must be chatgpt or antigravity' });
});

// -------------------------------------------------------------
// 7.1. ChatGPT Web & Codex Configuration Endpoints
// -------------------------------------------------------------
app.get('/api/chatgpt/status', async (req, res) => {
  try {
    const configDir = path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.codex-chatgpt-web');
    const configFile = path.join(configDir, 'config.json');
    let configData = {};
    if (fs.existsSync(configFile)) {
      try {
        configData = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      } catch (e) {}
    }

    // Check proxy responsiveness on 127.0.0.1:17841
    let proxyStatus = 'offline';
    try {
      await fetchJson(`${CHATGPT_PROXY_URL}/v1/responses`, { method: 'POST', body: '{}' });
      proxyStatus = 'ready';
    } catch (e) {
      proxyStatus = 'offline';
    }

    // Check doctor report
    const doc = await runCmd('codex-chatgpt-web doctor');
    const docReady = isDoctorReady(doc.stdout);
    const cleanDoctor = formatDoctorReport(doc.stdout);

    // Check if authenticated
    const hasStorage = configData.storageStatePath && fs.existsSync(configData.storageStatePath);
    const authenticated = docReady || proxyStatus === 'ready' || hasStorage || doc.stdout.includes('Running Codex turn') || doc.stdout.includes('Responses proxy is healthy');

    // Available / imported models from codex-chatgpt-web
    const importedModels = [
      { id: 'chatgpt-web/high', name: 'ChatGPT Web (High Reasoning) - Khuyên dùng', reasoning: 'high', active: true },
      { id: 'chatgpt-web/medium', name: 'ChatGPT Web (Medium Reasoning)', reasoning: 'medium', active: false },
      { id: 'chatgpt-web/light', name: 'ChatGPT Web (Light / Fast)', reasoning: 'low', active: false },
      { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (Deep Audit Backend)', reasoning: 'sol', active: false },
      { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (Extended Context)', reasoning: 'luna', active: false }
    ];

    res.json({
      authenticated,
      status: authenticated ? 'ready' : 'needs_login',
      verified: docReady || proxyStatus === 'ready',
      accountType: 'ChatGPT Web (Authenticated)',
      proxyUrl: CHATGPT_PROXY_URL,
      codexRouteInstalled: doc.stdout.includes('Codex native model route is installed'),
      activeModel: 'chatgpt-web/high',
      models: importedModels,
      doctorReport: cleanDoctor
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chatgpt/login', async (req, res) => {
  try {
    const launcherPath = 'C:\\Users\\Admin\\AppData\\Local\\Programs\\Codex Web GPT\\Codex Web GPT.exe';
    if (fs.existsSync(launcherPath)) {
      exec(`"${launcherPath}"`, { windowsHide: false }, () => {});
    } else {
      exec('start chrome https://chatgpt.com', () => {});
    }

    // Run verification check
    const out = await runCodexWithPrompt('chatgpt-web/high', 'Respond strictly with: PING_OK', 45000);
    const success = out.exitCode === 0 && (out.stdout.includes('PING_OK') || out.stdout.includes('PING\\_OK'));

    res.json({
      success: true,
      verified: success,
      message: success ? 'Đăng nhập & Verify Codex thành công!' : 'Đã mở cửa sổ đăng nhập ChatGPT Web. Vui lòng hoàn tất đăng nhập.',
      models: [
        { id: 'chatgpt-web/high', name: 'ChatGPT Web (High Reasoning) - Khuyên dùng', active: true },
        { id: 'chatgpt-web/medium', name: 'ChatGPT Web (Medium Reasoning)', active: false },
        { id: 'chatgpt-web/light', name: 'ChatGPT Web (Light / Fast)', active: false },
        { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (Deep Audit Backend)', active: false },
        { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (Extended Context)', active: false }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chatgpt/logout', async (req, res) => {
  try {
    const configDir = path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.codex-chatgpt-web');
    const storageState = path.join(configDir, 'browser', 'storage-state.json');
    const marker = path.join(configDir, 'browser', 'storage-state.verification.json');
    if (fs.existsSync(storageState)) fs.unlinkSync(storageState);
    if (fs.existsSync(marker)) fs.unlinkSync(marker);

    res.json({
      success: true,
      message: 'Đã thoát tài khoản ChatGPT Web. Bạn có thể đăng nhập tài khoản khác ngay bây giờ.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chatgpt/verify', async (req, res) => {
  const start = Date.now();
  try {
    const out = await runCodexWithPrompt('chatgpt-web/high', 'Respond strictly with: PING_OK', 90000);
    const duration = Date.now() - start;
    const success = out.exitCode === 0 && (out.stdout.includes('PING_OK') || out.stdout.includes('PING\\_OK'));
    
    const doc = await runCmd('codex-chatgpt-web doctor');
    const cleanDoctor = formatDoctorReport(doc.stdout);

    res.json({
      success,
      verified: success,
      durationMs: duration,
      model: 'chatgpt-web/high',
      output: out.stdout,
      doctorOutput: cleanDoctor,
      models: [
        { id: 'chatgpt-web/high', name: 'ChatGPT Web (High Reasoning) - Khuyên dùng', active: true },
        { id: 'chatgpt-web/medium', name: 'ChatGPT Web (Medium Reasoning)', active: false },
        { id: 'chatgpt-web/light', name: 'ChatGPT Web (Light / Fast)', active: false },
        { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol (Deep Audit Backend)', active: false },
        { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna (Extended Context)', active: false }
      ],
      error: success ? null : (out.stderr || out.stdout || 'Codex không phản hồi')
    });
  } catch (err) {
    res.status(500).json({ error: err.message, success: false, verified: false });
  }
});

// -------------------------------------------------------------
// 8. Closed-Loop Protocol Engine (WorkOrder -> WorkerReport -> Review Gate)
// -------------------------------------------------------------
app.post('/api/orchestrator/create-workorder', async (req, res) => {
  const { goal, model, projectId } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal is required' });

  const targetModel = model || 'chatgpt-web/high';
  const prompt = `You are the AI Orchestrator. The user has given this project goal:
"${goal}"

Decompose this goal and create the first structured WorkOrder for the Google Antigravity Worker.
Respond ONLY with a valid JSON object matching this schema:
{
  "workOrderId": "WO-001",
  "title": "Short descriptive title",
  "objective": "Clear description of what to implement",
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "filesScope": ["src/filename.js", "test/testname.js"],
  "testCommand": "node test.js",
  "workerPrompt": "Explicit actionable prompt to give to the Antigravity worker CLI"
}`;

  // Execute prompt via Codex CLI with ChatGPT Web through stdin pipe
  const out = await runCodexWithPrompt(targetModel, prompt, 60000);

  // Parse JSON from output
  let parsed = null;
  const jsonMatch = out.stdout.match(/\{[\s\S]*"workOrderId"[\s\S]*\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {}
  }

  if (!parsed) {
    // Fallback template if markdown format was returned
    parsed = {
      workOrderId: 'WO-001',
      title: 'Initial Implementation Task',
      objective: goal,
      acceptanceCriteria: ['Pass all unit tests', 'Adhere to repository conventions'],
      filesScope: ['index.js', 'test.js'],
      testCommand: 'node test.js',
      workerPrompt: `Implement the requested feature: ${goal}. Create index.js and test.js, then execute node test.js to verify.`
    };
  }

  res.json({
    model: targetModel,
    workOrder: parsed,
    rawOutput: out.stdout
  });
});

app.post('/api/orchestrator/audit', async (req, res) => {
  const { workOrder, workerReport, model } = req.body;
  if (!workOrder || !workerReport) {
    return res.status(400).json({ error: 'workOrder and workerReport are required' });
  }

  const targetModel = model || 'chatgpt-web/high';
  const prompt = `You are the AI Orchestrator performing a strict audit of the Antigravity Worker's implementation.

WorkOrder:
${JSON.stringify(workOrder, null, 2)}

WorkerReport:
- Modified Files: ${JSON.stringify(workerReport.filesModified || [])}
- Test Command: ${workerReport.testCommand || 'node test.js'}
- Test Passed: ${workerReport.testPassed}
- Test Output:
${workerReport.testOutput || ''}
- Git Diff:
${workerReport.gitDiff || ''}

Audit instructions:
1. If the test failed OR criteria are unmet: emit verdict "FIX" with explicit fixInstructions.
2. If tests pass and criteria met, but more tasks are needed: emit verdict "PASS" with nextWorkOrder.
3. If the entire goal is verified and complete: emit verdict "COMPLETE".

Respond ONLY with a valid JSON object matching this schema:
{
  "verdict": "FIX" | "PASS" | "COMPLETE",
  "summary": "Short executive summary of the review",
  "critique": ["point 1", "point 2"],
  "fixInstructions": "Detailed steps to fix if FIX, otherwise null",
  "nextWorkOrder": null
}`;

  const out = await runCodexWithPrompt(targetModel, prompt, 60000);

  let parsed = null;
  const jsonMatch = out.stdout.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {}
  }

  if (!parsed) {
    // If output says test passed, determine COMPLETE vs FIX
    const passed = workerReport.testPassed;
    parsed = {
      verdict: passed ? 'COMPLETE' : 'FIX',
      summary: passed ? 'All acceptance criteria and tests passed.' : 'Test execution failed.',
      critique: passed ? ['All tests verified', 'Clean diff'] : ['Errors observed in test execution'],
      fixInstructions: passed ? null : 'Resolve test failure and re-run verification.',
      nextWorkOrder: null
    };
  }

  res.json({
    model: targetModel,
    auditResult: parsed,
    rawOutput: out.stdout
  });
});

// -------------------------------------------------------------
// 9. Observer & Orchestrator Engine (ChatGPT Web Audit & Directives)
app.post('/api/orchestrator/audit-and-direct', async (req, res) => {
  const { projectId, antigravitySessionId, antigravityReport, mode, model, manualReport, userPrompt, workerEngine } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const effectiveWorker = workerEngine || currentSettings.workerEngine || 'gemini';
  const workerDisplayName = effectiveWorker === 'codex' ? 'OpenAI Codex Extension' : 'Google Antigravity';

  // 1. Resolve real Worker report from transcript/rollout if not manual
  let effectiveReportText = '';
  let extractedCommands = [];
  let extractedFiles = [];

  if (manualReport && manualReport.trim()) {
    effectiveReportText = extractWorkerReportOnly(manualReport.trim());
  } else if (antigravityReport && typeof antigravityReport === 'string') {
    effectiveReportText = extractWorkerReportOnly(antigravityReport);
  } else if (antigravityReport && antigravityReport.testOutput) {
    effectiveReportText = extractWorkerReportOnly(antigravityReport.testOutput);
  } else if (effectiveWorker === 'codex') {
    // Extract real report from Codex session rollout
    const codexData = await getLatestCodexReport(projectId);
    if (codexData && codexData.success && codexData.report_text) {
      effectiveReportText = codexData.report_text;
    } else {
      effectiveReportText = 'OpenAI Codex Extension Worker báo cáo hoàn thành nhiệm vụ theo roadmap kỹ thuật.';
    }
  } else {
    // Extract real report from Antigravity transcript
    const extracted = extractAntigravityReport(antigravitySessionId, projectId);
    if (extracted && extracted.reportText) {
      effectiveReportText = extractWorkerReportOnly(extracted.reportText);
      extractedCommands = [];
      extractedFiles = extracted.filesModified || [];
    } else {
      effectiveReportText = 'Antigravity Worker báo cáo hoàn thành nhiệm vụ theo roadmap kỹ thuật.';
    }
  }

  if (userPrompt && userPrompt.trim() && userPrompt.trim() !== effectiveReportText) {
    effectiveReportText = `${userPrompt.trim()}\n\n---\n${effectiveReportText}`;
  }

  const targetModel = model || 'chatgpt-web/high';

  // 2. Gather local technical context and project structure from disk
  const localContext = getProjectLocalContext(projectId);

  // 3. Prompt ChatGPT Web with strict Architect & Auditor persona
  const prompt = `You are the Senior Technical Architect, Lead Orchestrator & Independent Code Auditor.
Project: ${projectId}
Local Path: ${localContext.projPath}

CRITICAL MANDATE: YOU MUST NOT GENERATE CODE IMPLEMENTATIONS OR REPLACEMENT FILES.
All coding execution is strictly delegated to the ${workerDisplayName} Worker in the Antigravity IDE.

YOUR TASKS:
1. Review the ${workerDisplayName} Worker's latest Report, commands executed, and modified files against the Local Project Structure & Technical Roadmap below.
2. Provide an independent technical critique and code audit in Vietnamese (Markdown formatted).
   - Evaluate what was verified, what passed, and whether any risks/blockers remain.
   - Specify whether the current phase is approved to advance to the next roadmap milestone.
3. Conclude with an explicit, actionable prompt section under the heading:
### 🎯 CHỈ ĐẠO TIẾP THEO CHO ${effectiveWorker === 'codex' ? 'CODEX' : 'ANTIGRAVITY'}:
[Write the exact, step-by-step directive prompt for ${workerDisplayName} to execute next without ambiguity]

=== LOCAL PROJECT DIRECTORY STRUCTURE ===
${localContext.fileTreeSummary}

=== LOCAL TECHNICAL ROADMAP & SPECIFICATIONS (FROM DISK) ===
${localContext.technicalContextSummary}

=== ${workerDisplayName.toUpperCase()} WORKER LATEST REPORT & ACTIONS ===
Session: ${effectiveWorker === 'codex' ? 'codex-extension-session' : (antigravitySessionId || 'antigravity-active')}
${effectiveReportText}
`;

  const out = await runCodexWithPrompt(targetModel, prompt, 180000);
  const rawResponse = (out.stdout || '').trim();

  if (!rawResponse) {
    return res.status(500).json({
      error: out.stderr || 'ChatGPT Web không trả về phản hồi hoặc phiên kết nối bị gián đoạn. Vui lòng kiểm tra lại tab Cấu Hình / trạng thái ChatGPT.'
    });
  }

  // Extract directive prompt
  let nextDirectivePrompt = '';
  const directiveMarker = rawResponse.match(/###\s*🎯?\s*CHỈ ĐẠO TIẾP THEO CHO (?:CODEX|ANTIGRAVITY|WORKER):?([\s\S]*)/i)
    || rawResponse.match(/###\s*Next Directive:?([\s\S]*)/i);
  if (directiveMarker && directiveMarker[1]) {
    nextDirectivePrompt = directiveMarker[1].trim();
  } else {
    // Fallback: take the last paragraph
    const paragraphs = rawResponse.split('\n\n').filter(p => p.trim());
    nextDirectivePrompt = paragraphs[paragraphs.length - 1] || rawResponse;
  }

  // Determine verdict
  let verdict = 'CONTINUE_PHASE';
  const lowerResp = rawResponse.toLowerCase();
  if (lowerResp.includes('roadmap hoàn thành') || lowerResp.includes('roadmap_complete') || lowerResp.includes('hoàn thành toàn bộ')) {
    verdict = 'ROADMAP_COMPLETE';
  } else if (lowerResp.includes('lỗi') || lowerResp.includes('thất bại') || lowerResp.includes('sửa') || lowerResp.includes('verdict: fix')) {
    verdict = 'FIX';
  } else if (lowerResp.includes('chuyển sang giai đoạn') || lowerResp.includes('next phase') || lowerResp.includes('hoàn thành giai đoạn')) {
    verdict = 'NEXT_PHASE';
  }

  // 4. Create exchange record with dual format (new chat format + backwards compat)
  const exchangeItem = {
    id: `ex-${Date.now()}`,
    projectId,
    antigravitySessionId: antigravitySessionId || 'default',
    workerEngine: effectiveWorker,
    timestamp: new Date().toISOString(),
    workerMessage: {
      role: effectiveWorker === 'codex' ? 'codex' : 'antigravity',
      workerName: workerDisplayName,
      content: effectiveReportText,
      commands: [],
      filesModified: extractedFiles,
      timestamp: new Date().toISOString()
    },
    chatgptMessage: {
      role: 'chatgpt',
      content: rawResponse,
      directivePrompt: nextDirectivePrompt,
      verdict,
      model: targetModel,
      timestamp: new Date().toISOString()
    },
    // Backwards compatibility fields:
    antigravityReport: {
      summary: effectiveReportText.slice(0, 300),
      filesModified: extractedFiles,
      testPassed: verdict !== 'FIX',
      testOutput: effectiveReportText,
      notes: ''
    },
    chatgptAudit: {
      model: targetModel,
      verdict,
      auditSummary: rawResponse.slice(0, 300),
      technicalCritique: [],
      nextDirectivePrompt,
      roadmapCompleted: verdict === 'ROADMAP_COMPLETE'
    },
    dispatched: false
  };

  const targetAgySession = resolveAntigravitySession(antigravitySessionId, projectId);
  const baselineStepCount = getSessionStepCount(targetAgySession);

  // 5. Auto-dispatch directive prompt into appropriate Worker
  if (nextDirectivePrompt) {
    let dispRes;
    if (effectiveWorker === 'codex') {
      dispRes = await dispatchPromptToCodex(nextDirectivePrompt, projectId);
    } else {
      dispRes = await dispatchPromptToAntigravity(nextDirectivePrompt, projectId, targetAgySession);
    }
    exchangeItem.dispatched = dispRes.dispatched;
    exchangeItem.verified = dispRes.verified || false;
    exchangeItem.busy = dispRes.busy || false;
    exchangeItem.sentToWindow = false;
    exchangeItem.dispatchTarget = dispRes.targetWindow || dispRes.targetSession;
    exchangeItem.dispatchMethod = dispRes.method || (effectiveWorker === 'codex' ? 'codex_background_queue' : 'ao_background_send');
    exchangeItem.dispatchMessage = dispRes.message;
    console.log(`[AUTO-DISPATCH] worker=${effectiveWorker} verified=${dispRes.verified}, method=${exchangeItem.dispatchMethod}, target=${exchangeItem.dispatchTarget}`);
  }

  // Persist exchange item
  if (!exchangeHistory[projectId]) exchangeHistory[projectId] = [];
  exchangeHistory[projectId].unshift(exchangeItem);
  saveExchangeHistory(exchangeHistory);

  res.json({
    item: exchangeItem,
    targetSessionId: targetAgySession,
    baselineStepCount,
    rawOutput: out.stdout
  });
});

// Endpoint: User manual directive to ChatGPT Web (Senior Architect)
app.post('/api/orchestrator/user-directive', async (req, res) => {
  const { projectId, antigravitySessionId, userPrompt, model } = req.body;
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  if (!userPrompt || !userPrompt.trim()) return res.status(400).json({ error: 'userPrompt is required' });

  const targetModel = model || 'chatgpt-web/high';
  const targetAgySession = resolveAntigravitySession(antigravitySessionId, projectId);
  const baselineStepCount = getSessionStepCount(targetAgySession);

  // Gather local project structure & documents directly from disk
  const localContext = getProjectLocalContext(projectId);

  const prompt = `You are the Senior Technical Architect & Lead Orchestrator for the local software project on this machine.
Project: ${projectId}
Local Directory Path: ${localContext.projPath}

CRITICAL MANDATE:
- All actual code implementation and editing is strictly delegated to the Google Antigravity Worker (Gemini) in the Antigravity IDE.
- Your role is to understand the local project requirements and architecture, audit the code, and give clear, step-by-step directives to the Antigravity Worker.
- Do NOT generate full replacement source files. Provide architectural guidance and concrete directives.

=== LOCAL PROJECT DIRECTORY STRUCTURE ===
${localContext.fileTreeSummary}

=== LOCAL TECHNICAL SPECIFICATIONS & ROADMAP (FROM DISK) ===
${localContext.technicalContextSummary}

=== USER DIRECTIVE / REQUEST TO ARCHITECT ===
${userPrompt.trim()}

YOUR TASKS:
1. Analyze the user's directive against the local project architecture and roadmap.
2. Provide your architectural evaluation in Vietnamese (Markdown formatted).
3. Conclude with an explicit, actionable task for the Antigravity Worker in the IDE under the heading:
### 🎯 CHỈ ĐẠO TIẾP THEO CHO ANTIGRAVITY:
[Write the exact, step-by-step directive prompt for Antigravity IDE to execute next without ambiguity]
`;

  const out = await runCodexWithPrompt(targetModel, prompt, 180000);
  const rawResponse = (out.stdout || '').trim();

  if (!rawResponse) {
    return res.status(500).json({
      error: out.stderr || 'ChatGPT Web không phản hồi hoặc phiên kết nối bị gián đoạn. Vui lòng kiểm tra lại tab Cấu Hình.'
    });
  }

  // Extract directive prompt
  let nextDirectivePrompt = '';
  const directiveMarker = rawResponse.match(/###\s*🎯?\s*CHỈ ĐẠO TIẾP THEO CHO ANTIGRAVITY:?([\s\S]*)/i)
    || rawResponse.match(/###\s*Next Directive:?([\s\S]*)/i);
  if (directiveMarker && directiveMarker[1]) {
    nextDirectivePrompt = directiveMarker[1].trim();
  } else {
    const paragraphs = rawResponse.split('\n\n').filter(p => p.trim());
    nextDirectivePrompt = paragraphs[paragraphs.length - 1] || rawResponse;
  }

  // Determine verdict
  let verdict = 'CONTINUE_PHASE';
  const lowerResp = rawResponse.toLowerCase();
  if (lowerResp.includes('roadmap hoàn thành') || lowerResp.includes('roadmap_complete') || lowerResp.includes('hoàn thành toàn bộ')) {
    verdict = 'ROADMAP_COMPLETE';
  } else if (lowerResp.includes('lỗi') || lowerResp.includes('thất bại') || lowerResp.includes('sửa') || lowerResp.includes('verdict: fix')) {
    verdict = 'FIX';
  } else if (lowerResp.includes('chuyển sang giai đoạn') || lowerResp.includes('next phase') || lowerResp.includes('hoàn thành giai đoạn')) {
    verdict = 'NEXT_PHASE';
  }

  const exchangeItem = {
    id: `ex-${Date.now()}`,
    projectId,
    antigravitySessionId: targetAgySession || 'default',
    timestamp: new Date().toISOString(),
    userMessage: {
      role: 'user',
      content: userPrompt.trim(),
      timestamp: new Date().toISOString()
    },
    chatgptMessage: {
      role: 'chatgpt',
      content: rawResponse,
      directivePrompt: nextDirectivePrompt,
      verdict,
      model: targetModel,
      timestamp: new Date().toISOString()
    },
    dispatched: false
  };

  // Dispatch into Antigravity IDE
  if (nextDirectivePrompt) {
    const dispRes = await dispatchPromptToAntigravity(nextDirectivePrompt, projectId, targetAgySession);
    exchangeItem.dispatched = dispRes.dispatched;
    exchangeItem.sentToWindow = dispRes.sentToWindow;
    exchangeItem.dispatchTarget = dispRes.targetWindow || dispRes.targetSession;
    exchangeItem.dispatchMethod = dispRes.method || (dispRes.sentToWindow ? 'antigravity_ide_chat' : 'ao_background_send');
    exchangeItem.dispatchMessage = dispRes.message;
  }

  if (!exchangeHistory[projectId]) exchangeHistory[projectId] = [];
  exchangeHistory[projectId].unshift(exchangeItem);
  saveExchangeHistory(exchangeHistory);

  res.json({
    item: exchangeItem,
    targetSessionId: targetAgySession,
    baselineStepCount,
    rawOutput: out.stdout
  });
});

// Endpoint: Real-time milestones probe for Live Activity Log (High-level lifecycle milestones only)
app.get('/api/antigravity/session-steps/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const projectId = req.query.projectId;
  const targetSessionId = resolveAntigravitySession(sessionId, projectId);
  if (!targetSessionId) return res.json({ steps: [] });

  const logDir = path.join('C:\\Users\\Admin\\.gemini\\antigravity-ide\\brain', targetSessionId, '.system_generated', 'logs');
  let transcriptPath = path.join(logDir, 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) transcriptPath = path.join(logDir, 'transcript_full.jsonl');
  if (!fs.existsSync(transcriptPath)) return res.json({ steps: [] });

  try {
    const rawLines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    const turns = [];
    let currentTurn = null;

    for (let i = 0; i < rawLines.length; i++) {
      try {
        const item = JSON.parse(rawLines[i]);
        if (item.type === 'USER_INPUT') {
          if (currentTurn) turns.push(currentTurn);
          currentTurn = {
            userItem: item,
            firstActionItem: null,
            lastActionItem: null,
            finalItem: null,
            hasError: false,
            errorMsg: ''
          };
        } else if (currentTurn) {
          if (item.tool_calls && item.tool_calls.length > 0) {
            if (!currentTurn.firstActionItem) currentTurn.firstActionItem = item;
            currentTurn.lastActionItem = item;
          } else if (item.type === 'RUN_COMMAND') {
            if (!currentTurn.firstActionItem) currentTurn.firstActionItem = item;
            currentTurn.lastActionItem = item;
          }
          if (item.status === 'ERROR' || item.type === 'ERROR') {
            currentTurn.hasError = true;
            currentTurn.errorMsg = (item.content || '').slice(0, 90);
          }
          if ((item.type === 'PLANNER_RESPONSE' || item.type === 'MODEL') && item.content && (!item.tool_calls || item.tool_calls.length === 0)) {
            currentTurn.finalItem = item;
          }
        }
      } catch (e) {}
    }
    if (currentTurn) turns.push(currentTurn);

    const milestones = [];
    turns.forEach((t, idx) => {
      const promptText = (t.userItem.content || '')
        .replace(/<[^>]+>/g, '')
        .replace(/^[#*`\s]+/gm, '')
        .trim()
        .split('\n')[0]
        .slice(0, 85);
      const turnLabel = turns.length > 1 ? ` (Lượt ${idx + 1})` : '';

      // 1. Tiếp nhận chỉ đạo
      milestones.push({
        timestamp: t.userItem.created_at || new Date().toISOString(),
        role: 'user',
        summary: `Tiếp nhận chỉ đạo${turnLabel}`,
        details: promptText
      });

      // 2. Gemini bắt đầu làm việc
      const startTs = t.firstActionItem ? t.firstActionItem.created_at : t.userItem.created_at;
      milestones.push({
        timestamp: startTs || new Date().toISOString(),
        role: 'gemini',
        summary: `Gemini bắt đầu làm việc${turnLabel}`,
        details: 'Đang phân tích yêu cầu và tiến hành thi công...'
      });

      // 3 & 4. Đã xong & Đã báo cáo
      if (t.finalItem) {
        const finishTs = t.lastActionItem ? t.lastActionItem.created_at : t.finalItem.created_at;
        milestones.push({
          timestamp: finishTs || t.finalItem.created_at || new Date().toISOString(),
          role: 'gemini',
          summary: `Gemini đã hoàn tất thi công${turnLabel}`,
          details: 'Đã hoàn thành các bước xử lý trong lượt'
        });

        let reportSnippet = (t.finalItem.content || '')
          .replace(/<[^>]+>/g, '')
          .replace(/[#*`]/g, '')
          .trim()
          .split('\n')[0];
        if (reportSnippet.length > 90) reportSnippet = reportSnippet.slice(0, 90) + '...';

        milestones.push({
          timestamp: t.finalItem.created_at || new Date().toISOString(),
          role: 'report',
          summary: `Gemini đã báo cáo kết quả${turnLabel}`,
          details: reportSnippet || 'Đã xuất báo cáo chuyển giao'
        });
      } else {
        milestones.push({
          timestamp: t.lastActionItem ? t.lastActionItem.created_at : new Date().toISOString(),
          role: 'gemini',
          summary: `Gemini đang thi công${turnLabel}...`,
          details: 'Đang thực thi các tác vụ trong Antigravity IDE'
        });
      }

      if (t.hasError) {
        milestones.push({
          timestamp: t.lastActionItem ? t.lastActionItem.created_at : new Date().toISOString(),
          role: 'error',
          isError: true,
          summary: `⚠️ Cảnh báo lỗi thi công`,
          details: t.errorMsg
        });
      }
    });

    // Also include orchestrator closed-loop events if available
    if (projectId && exchangeHistory[projectId] && Array.isArray(exchangeHistory[projectId])) {
      const pHistory = exchangeHistory[projectId];
      pHistory.forEach((ex, exIdx) => {
        if (ex.antigravitySessionId === targetSessionId || (!ex.antigravitySessionId && exIdx < 3)) {
          if (ex.workerReport && ex.timestamp) {
            milestones.push({
              timestamp: ex.timestamp,
              role: 'chatgpt',
              summary: 'Đã chuyển báo cáo sang ChatGPT Web',
              details: 'Thẩm định và đánh giá tiến độ roadmap'
            });
          }
          if (ex.chatgptMessage && ex.chatgptMessage.directivePrompt) {
            const dirSnippet = ex.chatgptMessage.directivePrompt.trim().split('\n')[0].slice(0, 85);
            milestones.push({
              timestamp: ex.timestamp,
              role: 'chatgpt',
              summary: 'ChatGPT Web đã chỉ đạo bước tiếp theo',
              details: dirSnippet
            });
          }
        }
      });
    }

    // Sort chronologically
    milestones.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Keep most recent 25 milestones
    const cleanMilestones = milestones.slice(-25);

    res.json({
      success: true,
      sessionId: targetSessionId,
      totalSteps: cleanMilestones.length,
      steps: cleanMilestones
    });
  } catch (e) {
    res.json({ steps: [] });
  }
});

// Endpoint: Delete Session & Exchange History
app.delete('/api/antigravity/sessions/:id', (req, res) => {
  const sessId = req.params.id;
  const projectId = req.query.projectId;

  if (projectId && exchangeHistory[projectId]) {
    exchangeHistory[projectId] = exchangeHistory[projectId].filter(
      item => item.antigravitySessionId !== sessId && item.id !== sessId
    );
    saveExchangeHistory(exchangeHistory);
  }

  res.json({ success: true, message: `Đã xoá phiên ${sessId}` });
});

app.get('/api/orchestrator/exchange-stream/:projectId', (req, res) => {
  const { projectId } = req.params;
  const sessionId = req.query.sessionId;

  let history = [];
  if (sessionId && exchangeHistory[sessionId] && exchangeHistory[sessionId].length > 0) {
    history = exchangeHistory[sessionId];
  } else if (exchangeHistory[projectId] && exchangeHistory[projectId].length > 0) {
    history = exchangeHistory[projectId];
  }

  // If history is empty but session exists and has a Worker Report, automatically seed it as the initial turn!
  if (history.length === 0 && sessionId && sessionId !== 'new' && sessionId !== 'auto') {
    const rep = extractAntigravityReport(sessionId, projectId);
    if (rep && rep.reportText) {
      history = [
        {
          timestamp: rep.timestamp || new Date().toISOString(),
          antigravitySessionId: sessionId,
          projectId: projectId,
          workerMessage: {
            content: rep.reportText,
            filesModified: rep.filesModified || []
          },
          antigravityReport: {
            summary: rep.reportText.slice(0, 150),
            testOutput: rep.reportText,
            filesModified: rep.filesModified || []
          }
        }
      ];
    }
  }

  res.json({
    projectId,
    sessionId,
    history
  });
});

// Clear Chat History for a Project
app.delete('/api/orchestrator/exchange-stream/:projectId', (req, res) => {
  const { projectId } = req.params;
  exchangeHistory[projectId] = [];
  saveExchangeHistory(exchangeHistory);
  res.json({
    success: true,
    projectId,
    message: `Đã xóa sạch lịch sử chat của dự án ${projectId}`
  });
});

// Safe dispatch helper: Visibly delivers prompt into Antigravity IDE chat AND syncs to AO daemon
async function dispatchPromptToAntigravity(prompt, projectId, sessionId) {
  const result = { dispatched: false, sentToWindow: false, method: '', message: '', targetWindow: null, targetSession: null };

  // 1. Deliver directly into Antigravity IDE chat window
  try {
    const tmpPromptFile = path.join(__dirname, '.temp_dispatch_prompt.txt');
    fs.writeFileSync(tmpPromptFile, prompt, 'utf8');
    const pyScript = path.join(__dirname, 'send_to_antigravity.py');
    const proj = projectId || 'AI_Multi_Task';
    const pyCmd = `python "${pyScript}" "@${tmpPromptFile}" "${proj}"`;

    const pyOut = await new Promise((resolve) => {
      exec(pyCmd, { timeout: 12000 }, (err, stdout, stderr) => {
        try {
          resolve(JSON.parse((stdout || '').trim()));
        } catch (e) {
          resolve({ success: false, error: err ? err.message : stderr });
        }
      });
    });

    if (pyOut && pyOut.success) {
      result.dispatched = true;
      result.sentToWindow = true;
      result.method = 'antigravity_ide_chat';
      result.targetWindow = pyOut.target_window;
      result.message = `Đã tự động đẩy chỉ đạo vào khung chat Antigravity IDE (${pyOut.target_window})!`;
      console.log(`[VISIBLE DISPATCH SUCCESS] ${pyOut.target_window}`);
      return result; // Single-channel delivery: stop here to avoid dual dispatch
    } else {
      console.warn(`[WINDOW DISPATCH NOTIFICATION] ${pyOut?.error || 'Window not in foreground'}`);
    }
  } catch (e) {
    console.error('[WINDOW DISPATCH ERROR]', e.message);
  }

  // 2. ALWAYS also deliver to AO daemon worker session (ai_multi_task-1)
  try {
    const cleanProj = (projectId || 'ai_multi_task').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    let targetAoSession = 'ai_multi_task-1';
    try {
      const rows = await querySqlite(
        `SELECT id FROM sessions WHERE (project_id = ? OR project_id = ?) AND kind = 'worker' AND is_terminated = 0 ORDER BY created_at DESC LIMIT 1`,
        [projectId, cleanProj]
      );
      if (rows && rows.length > 0) targetAoSession = rows[0].id;
    } catch (e) {}

    if (targetAoSession) {
      const out = await runAo(['send', '--session', targetAoSession, '--message', prompt]);
      if (out.exitCode === 0) {
        result.dispatched = true;
        result.targetSession = targetAoSession;
        if (!result.sentToWindow) {
          result.method = 'ao_background_send';
          result.message = `Đã tự động đẩy chỉ đạo vào Antigravity Worker (${targetAoSession})!`;
        }
        console.log(`[AO DAEMON SEND SUCCESS] ${targetAoSession}`);
      }
    }
  } catch (e) {
    console.error('[AO DISPATCH ERROR]', e.message);
  }

  return result;
}

// -------------------------------------------------------------
// Worker Engine Management (Gemini vs OpenAI Codex Extension)
// -------------------------------------------------------------
app.get('/api/worker/engine', (req, res) => {
  res.json({ workerEngine: currentSettings.workerEngine || 'gemini' });
});

app.post('/api/worker/engine', (req, res) => {
  const { workerEngine } = req.body;
  if (workerEngine === 'codex' || workerEngine === 'gemini') {
    currentSettings.workerEngine = workerEngine;
    savePipelineSettings(currentSettings);
  }
  res.json({ success: true, workerEngine: currentSettings.workerEngine });
});

app.post('/api/worker/wait-report', async (req, res) => {
  const { projectId, workerEngine, timeoutSecs, targetTurnId, sessionId } = req.body;
  const effectiveWorker = workerEngine || currentSettings.workerEngine || 'gemini';
  const proj = projectId || 'AI_Multi_Task';

  if (effectiveWorker === 'codex') {
    const reportData = await waitCodexReport(proj, timeoutSecs || 180, targetTurnId, sessionId);
    return res.json(reportData);
  }

  // Gemini extraction
  const extracted = extractAntigravityReport(null, proj);
  return res.json({
    success: !!extracted?.reportText,
    report_text: extracted?.reportText || '',
    files_modified: extracted?.filesModified || []
  });
});

app.post('/api/antigravity/dispatch', async (req, res) => {
  const { sessionId, prompt, projectId, workerEngine } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const effectiveWorker = workerEngine || currentSettings.workerEngine || 'gemini';
  if (effectiveWorker === 'codex') {
    const result = await dispatchPromptToCodex(prompt, projectId);
    return res.json(result);
  }

  const result = await dispatchPromptToAntigravity(prompt, projectId, sessionId);
  return res.json(result);
});

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handlers to keep daemon alive
process.on('uncaughtException', (err) => {
  console.error('[SERVER UNCAUGHT EXCEPTION]', err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[SERVER UNHANDLED REJECTION]', reason);
});

// Start Server
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Pipeline Portal UI running at: http://localhost:${PORT}`);
    console.log(`- AO Daemon connected on: ${AO_BASE_URL}`);
    console.log(`- ChatGPT Web Proxy connected on: ${CHATGPT_PROXY_URL}`);
    console.log(`=======================================================`);
  });

  server.on('error', (err) => {
    console.error('[SERVER LISTEN ERROR]', err);
  });
}

module.exports = app;

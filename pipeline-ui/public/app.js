// ==========================================================================
// ChatGPT Web & Antigravity Pipeline Portal - Frontend Logic
// ==========================================================================

const state = {
  status: null,
  projects: [],
  sessions: [],
  filters: {
    role: 'all',
    status: 'all',
    project: 'all',
    q: ''
  },
  activeSession: null,
  activeTab: 'observer',
  extractedData: null,
  selectedProject: null,
  selectedAgySession: null,
  activeExchangeHistory: [],
  lastDirectivePrompt: null,
  isClosedLoopRunning: false,
  isObserving: false
};

// Toast Notification
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -------------------------------------------------------------
// API Calls
// -------------------------------------------------------------
async function apiGet(endpoint) {
  try {
    const res = await fetch(endpoint);
    return await res.json();
  } catch (e) {
    console.error(`API GET ${endpoint} error:`, e);
    return null;
  }
}

async function apiPost(endpoint, body) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (e) {
    console.error(`API POST ${endpoint} error:`, e);
    return { error: e.message };
  }
}

async function apiDelete(endpoint) {
  try {
    const res = await fetch(endpoint, { method: 'DELETE' });
    return await res.json();
  } catch (e) {
    console.error(`API DELETE ${endpoint} error:`, e);
    return { error: e.message };
  }
}

// -------------------------------------------------------------
// Engine Status & Health
// -------------------------------------------------------------
async function loadStatus() {
  const data = await apiGet('/api/status');
  if (!data) return;
  state.status = data;

  // AO Daemon
  const aoPill = document.getElementById('pill-ao');
  const aoVal = document.getElementById('val-ao');
  if (aoPill && aoVal) {
    if (data.aoDaemon && data.aoDaemon.status === 'ready') {
      aoPill.className = 'status-pill ready';
      aoVal.textContent = `Online (Port 3001)`;
    } else {
      aoPill.className = 'status-pill offline';
      aoVal.textContent = 'Offline';
    }
  }

  // ChatGPT Web Proxy
  const gptPill = document.getElementById('pill-chatgpt');
  const gptVal = document.getElementById('val-chatgpt');
  if (gptPill && gptVal) {
    if (data.chatgptProxy && data.chatgptProxy.status === 'ready') {
      gptPill.className = 'status-pill ready';
      gptVal.textContent = 'Ready (Port 17841)';
    } else {
      gptPill.className = 'status-pill offline';
      gptVal.textContent = 'Offline';
    }
  }

  // Antigravity
  const agyPill = document.getElementById('pill-agy');
  const agyVal = document.getElementById('val-agy');
  if (agyPill && agyVal) {
    if (data.agents && data.agents.agy && data.agents.agy.installed) {
      agyPill.className = 'status-pill ready';
      agyVal.textContent = `Ready (${data.agents.agy.version || 'v1.2.4'})`;
    } else {
      agyPill.className = 'status-pill offline';
      agyVal.textContent = 'Not Found';
    }
  }

  // Update Doctor tab outputs
  const docOutput = document.getElementById('doctor-output');
  const docBadge = document.getElementById('doctor-badge');
  if (docOutput && data.chatgptProxy && data.chatgptProxy.doctor && data.chatgptProxy.doctor.output) {
    docOutput.textContent = data.chatgptProxy.doctor.output;
    if (docBadge) {
      docBadge.textContent = data.chatgptProxy.doctor.ready ? 'Ready' : 'Issues';
      docBadge.className = data.chatgptProxy.doctor.ready ? 'badge badge-emerald' : 'badge badge-rose';
    }
  }

  const aoOutput = document.getElementById('ao-runtime-output');
  if (aoOutput) {
    if (data.aoDaemon && data.aoDaemon.details) {
      aoOutput.textContent = JSON.stringify(data.aoDaemon.details, null, 2);
    } else {
      aoOutput.textContent = `Daemon status: ${data.aoDaemon ? data.aoDaemon.status : 'offline'}`;
    }
  }
}

// -------------------------------------------------------------
// Direct 1-Click Project Folder Picker (Zero Sub-Modal, Native Windows Dialog)
// -------------------------------------------------------------
async function openNativeFolderPickerAndAdd() {
  try {
    let chosenPath = null;

    // 1. Electron Native Directory Dialog (instant Win32/Shell folder picker)
    if (window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
      chosenPath = await window.electronAPI.selectFolder();
    } else {
      // 2. Standalone Web Browser Fallback
      try {
        const res = await apiPost('/api/projects/browse', {});
        if (res && res.success && res.project) {
          state.selectedProject = res.project.id;
          await loadProjects();
          onProjectSelected(res.project.id);
          showToast(`Đã mở dự án: ${res.project.name}!`, 'success');
          return;
        }
      } catch (e) {
        console.warn('Backend browse fallback failed:', e);
      }
      chosenPath = prompt('Nhập hoặc dán đường dẫn thư mục dự án trên máy (Ví dụ: D:\\TU_CODE\\Orchestrator\\calc-engine):');
    }

    if (chosenPath && chosenPath.trim()) {
      const res = await apiPost('/api/projects/add', { folderPath: chosenPath.trim() });
      if (res && res.project) {
        state.selectedProject = res.project.id;
        await loadProjects();
        onProjectSelected(res.project.id);
        showToast(`Đã mở thành công dự án: ${res.project.name}!`, 'success');
      } else if (res && res.error) {
        showToast(`Lỗi: ${res.error}`, 'error');
      }
    }
  } catch (err) {
    console.error('Lỗi khi mở thư mục dự án:', err);
    showToast('Không thể mở cửa sổ chọn thư mục.', 'error');
  }
}

// -------------------------------------------------------------
// Projects Management
// -------------------------------------------------------------
async function loadProjects() {
  const data = await apiGet('/api/projects');
  if (!data || !data.projects) return;
  state.projects = data.projects;

  const statProjCount = document.getElementById('stat-projects-count');
  if (statProjCount) statProjCount.textContent = state.projects.length;

  // Populate Filter, Modal, and Global selects
  const select = document.getElementById('filter-project-select');
  const spawnSelect = document.getElementById('spawn-project');
  const globalProjSelect = document.getElementById('global-project-select');

  if (select) select.innerHTML = '<option value="all">Tất cả dự án đã mở</option>';
  if (spawnSelect) spawnSelect.innerHTML = '';
  if (globalProjSelect) globalProjSelect.innerHTML = '';

  state.projects.forEach(p => {
    if (select) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.path})`;
      select.appendChild(opt);
    }

    if (spawnSelect) {
      const sOpt = document.createElement('option');
      sOpt.value = p.id;
      sOpt.textContent = `${p.name} [${p.id}]`;
      spawnSelect.appendChild(sOpt);
    }

    if (globalProjSelect) {
      const gOpt = document.createElement('option');
      gOpt.value = p.id;
      gOpt.textContent = `📁 ${p.name}`;
      gOpt.title = p.path;
      globalProjSelect.appendChild(gOpt);
    }
  });


  // Render Projects Grid if element exists
  const container = document.getElementById('projects-container');
  if (container) {
    container.innerHTML = '';

    state.projects.forEach(p => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.innerHTML = `
        <div class="project-header">
          <span class="project-title">${escapeHtml(p.name)}</span>
          <span class="badge badge-cyan">Custom Folder</span>
        </div>
        <div class="project-path">${escapeHtml(p.path)}</div>
        <div style="display:flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem;">
          <button class="btn btn-primary btn-xs btn-switch-proj" data-id="${p.id}">
            Chọn Dự Án Này
          </button>
        </div>
      `;
      container.appendChild(card);
    });

    container.querySelectorAll('.btn-switch-proj').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const pid = e.currentTarget.dataset.id;
        if (globalProjSelect) globalProjSelect.value = pid;
        onProjectSelected(pid);
        showToast(`Đã chuyển sang dự án: ${pid}!`, 'success');
      });
    });
  }
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// Model Catalogs & Live Testing
// -------------------------------------------------------------
async function loadModelCatalogs() {
  const data = await apiGet('/api/models');
  if (!data) return;

  const chatgptSelect = document.getElementById('select-model-chatgpt');
  if (chatgptSelect && data.chatgpt && data.chatgpt.models) {
    chatgptSelect.innerHTML = '';
    data.chatgpt.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === data.chatgpt.defaultModel) opt.selected = true;
      chatgptSelect.appendChild(opt);
    });
  }

  const agySelect = document.getElementById('select-model-antigravity');
  if (agySelect && data.antigravity && data.antigravity.models) {
    agySelect.innerHTML = '';
    data.antigravity.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === data.antigravity.defaultModel) opt.selected = true;
      agySelect.appendChild(opt);
    });
  }
}

// Observer & Orchestrator Logic
// -------------------------------------------------------------
async function onProjectSelected(projectId) {
  state.selectedProject = projectId;
  localStorage.setItem('orchestrator_selected_project', projectId);

  // Update topbar select if mismatched
  const projSelect = document.getElementById('global-project-select');
  if (projSelect && projSelect.value !== projectId) {
    projSelect.value = projectId;
  }

  // Update display pill
  const dispProj = document.getElementById('disp-active-project');
  if (dispProj) {
    const pObj = state.projects.find(p => p.id === projectId);
    dispProj.textContent = pObj ? `${pObj.name} (${projectId})` : projectId;
  }

  // Load associated data safely in parallel
  loadAntigravitySessions(projectId).catch(e => console.error('loadAntigravitySessions error:', e));
  loadTechnicalContext(projectId).catch(e => console.error('loadTechnicalContext error:', e));
  loadExchangeStream(projectId).catch(e => console.error('loadExchangeStream error:', e));
}

async function loadAntigravitySessions(projectId) {
  const agySelect = document.getElementById('global-antigravity-session-select');
  if (!agySelect) return;

  const res = await apiGet('/api/antigravity/conversations');
  state.conversations = res?.conversations || [];
  agySelect.innerHTML = '';

  const badgeNavSess = document.getElementById('badge-nav-sessions-count');
  if (badgeNavSess && res && res.conversations) {
    badgeNavSess.textContent = res.conversations.length;
  }

  // Option 1: Create New Session
  const newOpt = document.createElement('option');
  newOpt.value = 'new';
  newOpt.textContent = '✨ + Tạo Phiên Chat Mới (New Conversation)';
  agySelect.appendChild(newOpt);

  if (res && res.conversations && res.conversations.length > 0) {
    const currentList = res.conversations.filter(c => c.status === 'current');
    const runningList = res.conversations.filter(c => c.status === 'running');
    const recentList = res.conversations.filter(c => c.status === 'recent');

    if (currentList.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '📍 Phiên Hiện Tại (Current)';
      currentList.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const wsTag = s.workspace ? ` [📁 ${s.workspace}]` : '';
        opt.textContent = `🟢 ${s.title}${wsTag} (${s.relativeTime})`;
        grp.appendChild(opt);
      });
      agySelect.appendChild(grp);
    }

    if (runningList.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '⚡ Phiên Đang Chạy (Running)';
      runningList.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const wsTag = s.workspace ? ` [📁 ${s.workspace}]` : '';
        opt.textContent = `⚡ ${s.title}${wsTag} (${s.relativeTime})`;
        grp.appendChild(opt);
      });
      agySelect.appendChild(grp);
    }

    if (recentList.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '🕒 Lịch Sử Gần Đây (Recent)';
      recentList.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        const wsTag = s.workspace ? ` [📁 ${s.workspace}]` : '';
        opt.textContent = `💬 ${s.title}${wsTag} (${s.relativeTime})`;
        grp.appendChild(opt);
      });
      agySelect.appendChild(grp);
    }
  }

  // Preserve 'new' session if currently chosen
  if (state.selectedAgySession === 'new') {
    agySelect.value = 'new';
  } else {
    // Set default selection to Current worker session if available
    const currentItem = res?.conversations?.find(c => c.status === 'current');
    if (!state.selectedAgySession || state.selectedAgySession === 'auto' || state.selectedAgySession === 'eb04834e-f388-4dd3-afd7-4001e7fa3da5') {
      state.selectedAgySession = currentItem ? currentItem.id : (res?.conversations?.[0]?.id || 'new');
    }

    if (state.selectedAgySession) {
      agySelect.value = state.selectedAgySession;
    }
    if (!agySelect.value && currentItem) {
      agySelect.value = currentItem.id;
      state.selectedAgySession = currentItem.id;
    }
  }

  if (state.selectedAgySession && state.selectedAgySession !== 'new') {
    onAgySessionChanged(state.selectedAgySession, false);
  } else {
    const dispSess = document.getElementById('disp-active-session');
    if (dispSess) dispSess.textContent = '✨ Phiên Chat Mới (Chờ nhận lệnh...)';
  }
}

function onAgySessionChanged(sessionId, shouldReloadStream = true) {
  if (!sessionId || sessionId === 'new') {
    handleNewSessionSelected();
    return;
  }
  state.selectedAgySession = sessionId;
  const sess = (state.conversations || []).find(c => c.id === sessionId);
  
  if (sess) {
    state.selectedProject = sess.projectId || sess.workspace || 'default';
    state.selectedProjectPath = sess.projectPath || '';
    state.selectedProjectName = sess.workspace || sess.projectId || 'Dự án';
  }

  const agySelect = document.getElementById('global-antigravity-session-select');
  if (agySelect && agySelect.value !== sessionId) {
    agySelect.value = sessionId;
  }

  const dispSess = document.getElementById('disp-active-session');
  if (dispSess) {
    dispSess.textContent = sess ? sess.title : sessionId;
  }

  const dispProj = document.getElementById('disp-active-project');
  if (dispProj) {
    const wsName = sess?.workspace || state.selectedProject;
    const wsPath = sess?.projectPath ? ` (${sess.projectPath})` : '';
    dispProj.textContent = `${wsName}${wsPath}`;
  }

  const btnOpenFolder = document.getElementById('btn-open-session-folder');
  if (btnOpenFolder) {
    btnOpenFolder.title = sess?.projectPath ? `Mở thư mục: ${sess.projectPath}` : 'Mở thư mục dự án tương ứng';
  }

  if (shouldReloadStream) {
    loadExchangeStream(state.selectedProject, sessionId);
    pollAgentLiveSteps();
  }
}

async function loadTechnicalContext(projectId) {
  const container = document.getElementById('tech-files-list');
  const badge = document.getElementById('badge-tech-files-count');
  if (!container) return;

  container.innerHTML = '<div class="text-muted" style="font-size:0.75rem;">Đang quét lộ trình kỹ thuật...</div>';
  const data = await apiGet(`/api/projects/${projectId}/technical-context`);

  if (!data || !data.files || data.files.length === 0) {
    if (badge) badge.textContent = '0 Files';
    container.innerHTML = '<div class="text-muted" style="font-size:0.75rem;">Không tìm thấy file lộ trình (ROADMAP.md, HANDOFF.md...).</div>';
    return;
  }

  if (badge) badge.textContent = `${data.files.length} Files`;
  container.innerHTML = '';

  data.files.forEach((f, idx) => {
    const item = document.createElement('div');
    item.className = 'tech-file-item';
    const isRoadmap = f.name.toLowerCase().includes('roadmap') || f.name.toLowerCase().includes('handoff');
    item.innerHTML = `
      <div class="tech-file-info">
        <span class="tech-file-name ${isRoadmap ? 'highlight-file' : ''}">📄 ${escapeHtml(f.name)}</span>
        <span class="tech-file-size">${Math.round(f.sizeBytes / 1024 * 10) / 10} KB</span>
      </div>
      <button class="tech-file-accordion-btn" title="Mở rộng / Thu gọn xem trước file">
        <span class="accordion-arrow">▼</span>
        <span>Xem</span>
      </button>
    `;

    const togglePreview = (e) => {
      if (e) e.stopPropagation();
      const previewBox = document.getElementById('tech-file-preview-box');
      const filenameEl = document.getElementById('preview-filename');
      const contentEl = document.getElementById('preview-file-content');
      
      // If currently previewing this file and it's visible, toggle hide
      if (previewBox && !previewBox.classList.contains('hidden') && filenameEl && filenameEl.textContent === f.name) {
        previewBox.classList.add('hidden');
        item.classList.remove('selected');
      } else if (previewBox && filenameEl && contentEl) {
        filenameEl.textContent = f.name;
        contentEl.textContent = f.content || f.summary || '(File rỗng)';
        previewBox.classList.remove('hidden');
        document.querySelectorAll('.tech-file-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
      }
    };

    item.addEventListener('click', togglePreview);
    container.appendChild(item);

    // Auto-preview first roadmap file on load
    if (idx === 0 && isRoadmap) {
      setTimeout(() => togglePreview(null), 100);
    }
  });
}

async function loadExchangeStream(projectId, sessionId) {
  const container = document.getElementById('exchange-stream-container');
  const emptyState = document.getElementById('stream-empty-state');
  if (!container) return;

  const sessParam = sessionId || state.selectedAgySession || '';
  const projParam = projectId || state.selectedProject || 'default';
  const data = await apiGet(`/api/orchestrator/exchange-stream/${projParam}?sessionId=${sessParam}`);
  state.activeExchangeHistory = (data && data.history) ? data.history : [];

  if (state.activeExchangeHistory.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    container.querySelectorAll('.exchange-turn').forEach(el => el.remove());
    const btnDisp = document.getElementById('btn-dispatch-prompt-to-agy');
    if (btnDisp) btnDisp.disabled = true;
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');
  renderExchangeStream(state.activeExchangeHistory);
}

function formatChatMarkdown(text) {
  if (!text) return '';
  let str = escapeHtml(text);
  // Code blocks: ```lang\ncode\n```
  str = str.replace(/```([a-zA-Z0-9_\-\.]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    return `<div class="code-block-wrapper"><div class="code-block-header"><span>${lang || 'text'}</span></div><pre><code>${code.trim()}</code></pre></div>`;
  });
  // Headings
  str = str.replace(/^### (.*$)/gim, '<h4 class="chat-md-h4">$1</h4>');
  str = str.replace(/^## (.*$)/gim, '<h3 class="chat-md-h3">$1</h3>');
  // Bold
  str = str.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  str = str.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  // Lists
  str = str.replace(/^\s*[-*]\s+(.*$)/gim, '<li class="chat-md-li">$1</li>');
  str = str.replace(/((?:<li class="chat-md-li">[\s\S]*?<\/li>\s*)+)/g, '<ul class="chat-md-ul">$1</ul>');
  // Double line breaks to paragraphs
  str = str.replace(/\n\n+/g, '</p><p>');
  str = str.replace(/\n/g, '<br/>');
  return `<p>${str}</p>`;
}

function renderExchangeStream(history) {
  const container = document.getElementById('exchange-stream-container');
  if (!container) return;

  // Clear previous rendered turns
  container.querySelectorAll('.exchange-turn').forEach(el => el.remove());

  // Render from oldest to newest (history is stored newest first, so we reverse for natural chat flow)
  const items = [...history].reverse();

  items.forEach((item, index) => {
    const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '';
    
    // Extract worker report details (dual support: new workerMessage or legacy antigravityReport)
    const workerMsg = item.workerMessage || {};
    const rep = item.antigravityReport || {};
    const workerContent = workerMsg.content || rep.testOutput || rep.summary || '';
    const commandsRan = workerMsg.commands || [];
    const filesModified = workerMsg.filesModified || rep.filesModified || [];

    // Extract ChatGPT audit details (dual support: new chatgptMessage or legacy chatgptAudit)
    const gptMsg = item.chatgptMessage || {};
    const aud = item.chatgptAudit || {};
    const gptContent = gptMsg.content || aud.auditSummary || '';
    const directivePrompt = gptMsg.directivePrompt || aud.nextDirectivePrompt || '';
    const verdict = gptMsg.verdict || aud.verdict || 'AUDITED';

    let verdictClass = 'verdict-badge-blue';
    let verdictLabel = 'Đã Thẩm Định';
    if (verdict === 'ROADMAP_COMPLETE') {
      verdictClass = 'verdict-badge-green';
      verdictLabel = '🎉 Hoàn Thành';
    } else if (verdict === 'NEXT_PHASE') {
      verdictClass = 'verdict-badge-green';
      verdictLabel = '✅ Chuyển Phase';
    } else if (verdict === 'FIX') {
      verdictClass = 'verdict-badge-red';
      verdictLabel = '⚠️ Sửa Lỗi';
    } else if (verdict === 'CONTINUE_PHASE') {
      verdictClass = 'verdict-badge-amber';
      verdictLabel = '⚡ Tiếp Tục Phase';
    }

    // 1. Turn divider
    const turnDivider = document.createElement('div');
    turnDivider.className = 'chat-turn-divider exchange-turn';
    turnDivider.innerHTML = `<span>Trao Đổi #${items.length - index} • ${timeStr}</span>`;
    container.appendChild(turnDivider);

    // 2. User Bubble (if this turn originated from direct User instruction)
    if (item.userMessage && item.userMessage.content) {
      const rowUser = document.createElement('div');
      rowUser.className = 'chat-bubble-row row-user exchange-turn';
      rowUser.innerHTML = `
        <div class="chat-bubble bubble-user">
          <div class="bubble-header">
            <div class="bubble-sender-group">
              <span class="bubble-avatar avatar-user">👤</span>
              <span class="bubble-name">Chỉ Đạo Từ User</span>
              <span class="bubble-role role-user">User Direct</span>
            </div>
            <span class="bubble-time">${timeStr}</span>
          </div>
          <div class="bubble-body">
            <div class="chat-markdown-content">
              ${formatChatMarkdown(item.userMessage.content)}
            </div>
          </div>
        </div>
      `;
      container.appendChild(rowUser);
    }

    // 3. Left Bubble: Antigravity Agent (Worker Report) - only if worker reported
    if (workerContent && workerContent.trim()) {
      const rowAgent = document.createElement('div');
      rowAgent.className = 'chat-bubble-row row-agent exchange-turn';
      rowAgent.innerHTML = `
        <div class="chat-bubble bubble-agent">
          <div class="bubble-header">
            <div class="bubble-sender-group">
              <span class="bubble-avatar avatar-agent">⚡</span>
              <span class="bubble-name">Antigravity Agent</span>
              <span class="bubble-role role-worker">Worker</span>
            </div>
            <span class="bubble-time">${timeStr}</span>
          </div>
          <div class="bubble-body">
            ${filesModified && filesModified.length > 0 ? `
              <div class="chat-meta-chips">
                <span class="meta-label">File:</span>
                ${filesModified.map(f => `<span class="chip-file">📄 ${escapeHtml(f)}</span>`).join(' ')}
              </div>` : ''}
            <div class="chat-markdown-content">
              ${formatChatMarkdown(workerContent)}
            </div>
          </div>
        </div>
      `;
      container.appendChild(rowAgent);
    }

    // 3. Right Bubble: ChatGPT Web (Lead Architect & Auditor)
    if (gptContent && gptContent.trim()) {
      const rowGpt = document.createElement('div');
      rowGpt.className = 'chat-bubble-row row-chatgpt exchange-turn';
      rowGpt.innerHTML = `
        <div class="chat-bubble bubble-chatgpt">
          <div class="bubble-header">
            <div class="bubble-header-left">
              <span class="verdict-pill ${verdictClass}">${escapeHtml(verdictLabel)}</span>
              <span class="bubble-time">${timeStr}</span>
            </div>
            <div class="bubble-sender-group">
              <span class="bubble-role role-architect">Auditor</span>
              <span class="bubble-name">ChatGPT Web</span>
              <span class="bubble-avatar avatar-chatgpt">🧠</span>
            </div>
          </div>
          <div class="bubble-body">
            <div class="chat-markdown-content">
              ${formatChatMarkdown(gptContent)}
            </div>

            ${directivePrompt ? `
              <div class="bubble-directive-box">
                <div class="directive-box-header">
                  <div class="directive-box-title">
                    <span class="directive-icon">🎯</span>
                    <strong>Chỉ Đạo Tiếp Theo:</strong>
                  </div>
                  <div class="directive-box-actions">
                    <button class="btn btn-secondary btn-xs btn-copy-dir" title="Sao chép prompt">📋 Copy</button>
                    <button class="btn btn-success btn-xs btn-dispatch-dir" title="Nạp trực tiếp vào khung chat Antigravity IDE">⚡ Nạp Vào IDE</button>
                  </div>
                </div>
                <pre class="directive-content-code">${escapeHtml(directivePrompt)}</pre>
              </div>` : ''}
          </div>
        </div>
      `;

      // Listeners for directive box inside rowGpt
      const copyBtn = rowGpt.querySelector('.btn-copy-dir');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(directivePrompt || '');
          showToast('Đã sao chép prompt chỉ đạo vào bộ nhớ tạm!');
        });
      }

      const dispatchBtn = rowGpt.querySelector('.btn-dispatch-dir');
      if (dispatchBtn) {
        dispatchBtn.addEventListener('click', async () => {
          const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession || 'auto';
          navigator.clipboard.writeText(directivePrompt);

          const dispRes = await apiPost('/api/antigravity/dispatch', {
            sessionId: agySessionId,
            prompt: directivePrompt,
            projectId: state.selectedProject
          });

          if (dispRes && dispRes.dispatched) {
            showToast(`⚡ ${dispRes.message || 'Đã nạp chỉ đạo vào khung chat Antigravity IDE!'}`, 'success');
          } else {
            showToast(`⚡ ${dispRes?.message || 'Đã gửi prompt sang Antigravity!'}`, 'info');
          }
          startObservingAntigravity();
        });
      }

      container.appendChild(rowGpt);
    } else if (workerContent && workerContent.trim()) {
      // Worker reported but ChatGPT has not audited yet: show action prompt
      const rowAuditPrompt = document.createElement('div');
      rowAuditPrompt.className = 'chat-bubble-row row-chatgpt exchange-turn';
      rowAuditPrompt.innerHTML = `
        <div class="chat-bubble bubble-chatgpt" style="background: rgba(30, 41, 59, 0.7); border: 1px dashed rgba(99, 102, 241, 0.45); padding: 0.9rem 1.1rem;">
          <div class="bubble-header" style="margin-bottom: 0.5rem;">
            <div class="bubble-header-left">
              <span class="verdict-pill verdict-badge-amber">⏳ Chờ Thẩm Định</span>
              <span class="bubble-time">${timeStr}</span>
            </div>
            <div class="bubble-sender-group">
              <span class="bubble-role role-architect">Auditor</span>
              <span class="bubble-name">ChatGPT Web</span>
              <span class="bubble-avatar avatar-chatgpt">🧠</span>
            </div>
          </div>
          <div class="bubble-body">
            <p style="color:#cbd5e1; font-size:0.875rem; line-height:1.5; margin:0 0 0.75rem 0;">
              Antigravity Worker đã tải xong báo cáo nghiệm thu. Bấm nút bên dưới để gửi sang <strong>ChatGPT Web thẩm định độc lập & ra chỉ đạo tiếp theo</strong>.
            </p>
            <button class="btn btn-primary btn-sm btn-audit-stream-btn" style="display:inline-flex; align-items:center; gap:6px; font-weight:600;">
              <span>🧠 Bắn Báo Cáo Sang ChatGPT Web Audit Ngay</span>
            </button>
          </div>
        </div>
      `;
      rowAuditPrompt.querySelector('.btn-audit-stream-btn').addEventListener('click', () => {
        triggerAuditAndDirect();
      });
      container.appendChild(rowAuditPrompt);
    }
  });

  // Track latest directive
  const latestItem = history[0];
  if (latestItem) {
    const dir = latestItem.chatgptMessage?.directivePrompt || latestItem.chatgptAudit?.nextDirectivePrompt;
    if (dir) state.lastDirectivePrompt = dir;

    const loopStatus = document.getElementById('disp-loop-status');
    if (loopStatus) {
      const v = latestItem.chatgptMessage?.verdict || latestItem.chatgptAudit?.verdict;
      if (v === 'ROADMAP_COMPLETE') {
        loopStatus.textContent = 'Hoàn Thành Mục Tiêu';
        loopStatus.className = 'status-badge badge-emerald';
        loopStatus.classList.remove('hidden');
      } else if (v === 'FIX') {
        loopStatus.textContent = 'Yêu Cầu Sửa Lỗi';
        loopStatus.className = 'status-badge badge-rose';
        loopStatus.classList.remove('hidden');
      } else {
        loopStatus.textContent = '';
        loopStatus.classList.add('hidden');
      }
    }
  }

  // Scroll to bottom of stream
  container.scrollTop = container.scrollHeight;
}

// -------------------------------------------------------------
// Real-time Agent Live Steps Poller (Sidebar Activity Log)
// -------------------------------------------------------------
async function pollAgentLiveSteps() {
  const container = document.getElementById('agent-live-steps-container');
  const badge = document.getElementById('badge-live-steps-count');
  if (!container) return;

  const currentSess = state.selectedAgySession;
  if (!currentSess || currentSess === 'new') {
    if (badge) badge.textContent = '0 Mốc';
    return;
  }

  const data = await apiGet(`/api/antigravity/session-steps/${currentSess}?projectId=${state.selectedProject || ''}`);
  if (!data || !data.steps || data.steps.length === 0) {
    if (badge) badge.textContent = '0 Mốc';
    return;
  }

  if (badge) badge.textContent = `${data.steps.length} Mốc`;

  const emptyState = document.getElementById('log-empty-state');
  if (emptyState) emptyState.classList.add('hidden');

  container.innerHTML = '';
  data.steps.forEach(st => {
    const timeStr = st.timestamp ? new Date(st.timestamp).toLocaleTimeString('vi-VN', { hour12: false }) : '';
    const row = document.createElement('div');
    row.className = `log-stream-row ${st.isError ? 'log-err' : ''}`;

    let tagClass = 'tag-agent';
    let tagText = 'GEMINI';
    if (st.isError) {
      tagClass = 'tag-err';
      tagText = 'LỖI';
    } else if (st.role === 'user') {
      tagClass = 'tag-user';
      tagText = 'USER';
    } else if (st.role === 'report') {
      tagClass = 'tag-report';
      tagText = 'BÁO CÁO';
    } else if (st.role === 'chatgpt') {
      tagClass = 'tag-chatgpt';
      tagText = 'CHATGPT';
    } else if (st.role === 'system') {
      tagClass = 'tag-sys';
      tagText = 'HỆ THỐNG';
    }

    row.innerHTML = `
      <div class="log-stream-line">
        <span class="log-ts">${timeStr}</span>
        <span class="log-tag ${tagClass}">${tagText}</span>
        <span class="log-msg ${st.isError ? 'text-rose' : ''}">${escapeHtml(st.summary)}</span>
      </div>
      ${st.details ? `<div class="log-detail-line">${escapeHtml(st.details)}</div>` : ''}
    `;
    container.appendChild(row);
  });

  // Auto scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// -------------------------------------------------------------
// Quản Lý Phiên Làm Việc (Work Sessions Tab)
// -------------------------------------------------------------
async function loadWorkSessionsTab() {
  const container = document.getElementById('sessions-list-container');
  if (!container) return;

  container.innerHTML = '<div class="text-muted" style="padding:1.5rem; text-align:center;">Đang tải danh sách các phiên làm việc...</div>';
  
  const res = await apiGet('/api/antigravity/conversations');
  if (!res || !res.conversations || res.conversations.length === 0) {
    container.innerHTML = `
      <div class="stream-empty-state" style="padding:2rem;">
        <span class="empty-dot"></span>
        <span class="empty-hint">Chưa có phiên làm việc nào được ghi nhận. Bấm "+ Tạo Phiên Chat Mới" để bắt đầu phiên đầu tiên.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  res.conversations.forEach(s => {
    const isCurrent = s.id === state.selectedAgySession;
    const card = document.createElement('div');
    card.className = `session-row-card ${isCurrent ? 'active-session' : ''}`;
    
    let statusClass = 'badge-cyan';
    let statusLabel = 'Đã Lưu';
    if (s.status === 'running') {
      statusClass = 'badge-amber';
      statusLabel = 'Đang Chạy';
    } else if (s.status === 'current') {
      statusClass = 'badge-emerald';
      statusLabel = 'Hiện Tại';
    }

    card.innerHTML = `
      <div class="session-row-info">
        <div class="session-icon-col">
          <span class="bubble-avatar ${s.status === 'running' ? 'avatar-agent' : 'avatar-chatgpt'}" style="width:34px; height:34px; font-size:1rem;">
            ${s.status === 'running' ? '⚡' : '💬'}
          </span>
        </div>
        <div class="session-title-col">
          <div class="session-row-title">${escapeHtml(s.title || 'Phiên Chat Antigravity')}</div>
          <div class="session-row-meta">
            <span class="meta-tag project-tag" title="Thư mục làm việc: ${escapeHtml(s.projectPath || '')}">📁 ${escapeHtml(s.workspace || s.projectId || 'Tự động')}</span>
            <span class="meta-tag time-tag">🕒 ${escapeHtml(s.relativeTime || '')}</span>
            <span class="meta-tag id-tag">ID: <code>${escapeHtml(s.id.slice(0, 8))}...</code></span>
            <span class="badge ${statusClass}">${statusLabel}</span>
          </div>
        </div>
      </div>
      <div class="session-row-actions">
        <button class="btn btn-secondary btn-sm btn-preview-session-report" data-id="${s.id}" title="Xem trước nội dung báo cáo & tài liệu bàn giao của phiên này">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>Báo Cáo</span>
        </button>
        <button class="btn btn-primary btn-sm btn-enter-session" data-id="${s.id}" data-title="${escapeHtml(s.title)}" data-ws="${escapeHtml(s.workspace || '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
          <span>Vào Phiên</span>
        </button>
        <button class="btn btn-secondary btn-sm btn-delete-session btn-danger-subtle" data-id="${s.id}" title="Xoá lịch sử phiên này">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span>Xoá</span>
        </button>
      </div>
    `;

    // Click "Báo Cáo"
    card.querySelector('.btn-preview-session-report').addEventListener('click', (e) => {
      e.stopPropagation();
      openReportPreviewModal(s.id);
    });

    // Click "Vào Phiên"
    card.querySelector('.btn-enter-session').addEventListener('click', () => {
      enterWorkSession(s);
    });

    // Click "Xoá"
    card.querySelector('.btn-delete-session').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Bạn có chắc chắn muốn xoá phiên làm việc "${s.title}" (${s.id.slice(0,8)}) khỏi danh sách?`)) return;
      await apiDelete(`/api/antigravity/sessions/${s.id}?projectId=${state.selectedProject || ''}`);
      card.remove();
      showToast(`Đã xoá phiên: ${s.title}!`, 'success');
      loadAntigravitySessions(state.selectedProject);
    });

    container.appendChild(card);
  });
}

async function openReportPreviewModal(sessionId) {
  const modal = document.getElementById('report-preview-modal');
  const titleEl = document.getElementById('report-preview-modal-title');
  const metaEl = document.getElementById('report-preview-modal-meta');
  const contentEl = document.getElementById('report-preview-modal-content');
  if (!modal) return;

  const sess = (state.conversations || []).find(c => c.id === sessionId);
  const title = sess ? sess.title : (document.getElementById('disp-active-session')?.textContent || sessionId);

  if (titleEl) titleEl.textContent = `Báo Cáo Nghiệm Thu: ${title}`;
  if (metaEl) metaEl.textContent = `Đang tải báo cáo từ Antigravity transcript...`;
  if (contentEl) contentEl.innerHTML = '<div class="text-muted" style="text-align:center; padding:2rem;">⏳ Đang trích xuất Báo Cáo Cuối & Handoff từ Antigravity...</div>';
  modal.classList.add('active');
  modal.classList.remove('hidden');

  const res = await apiGet(`/api/antigravity/latest-report/${sessionId}`);
  if (!res || !res.report || !res.report.reportText) {
    if (contentEl) {
      contentEl.innerHTML = `
        <div class="stream-empty-state" style="padding: 2.5rem 1.5rem; text-align:center;">
          <span class="empty-dot" style="background:#fbbf24; box-shadow:0 0 12px #fbbf24;"></span>
          <h4 style="color:#e2e8f0; font-size:1.05rem; margin-bottom:0.4rem; font-weight:700;">Chưa có Báo Cáo Cuối</h4>
          <p class="empty-hint" style="max-width:560px; margin:0 auto; line-height:1.5;">
            Phiên làm việc này chưa có nội dung báo cáo hoàn thành hoặc đang trong quá trình thực thi trên Antigravity IDE.
          </p>
        </div>
      `;
    }
    if (metaEl) metaEl.textContent = `Phiên: ${sessionId}`;
    return;
  }

  const timeStr = res.report.timestamp ? new Date(res.report.timestamp).toLocaleString('vi-VN') : '';
  const wsText = sess?.workspace ? ` • Dự án: ${sess.workspace}` : '';

  if (metaEl) metaEl.textContent = `Phiên: ${sessionId}${wsText} • Cập nhật: ${timeStr} • ${res.report.totalSteps || 0} Bước`;
  if (contentEl) contentEl.innerHTML = formatChatMarkdown(res.report.reportText);

  state.currentPreviewReportText = res.report.reportText;
}
window.openReportPreviewModal = openReportPreviewModal;

function enterWorkSession(session) {
  onAgySessionChanged(session.id, true);

  // Switch to Observer tab
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === 'observer'));
  state.activeTab = 'observer';
  switchMainView('observer');

  showToast(`Đã chuyển vào phiên: ${session.title}`, 'success');
}

// -------------------------------------------------------------
// New Session Creation & Dynamic Title Synchronizer
// -------------------------------------------------------------
function handleNewSessionSelected() {
  state.selectedAgySession = 'new';
  state.lastKnownStepCount = 0;
  
  const agySel = document.getElementById('global-antigravity-session-select');
  if (agySel) agySel.value = 'new';

  const dispSess = document.getElementById('disp-active-session');
  if (dispSess) dispSess.textContent = '✨ Phiên Chat Mới (Chờ nhận lệnh...)';

  // Clear chat exchange container with clear empty card
  const container = document.getElementById('exchange-stream-container');
  if (container) {
    container.innerHTML = `
      <div class="stream-empty-state" id="stream-empty-state" style="padding: 2.5rem 1.5rem; text-align:center;">
        <span class="empty-dot" style="background:#a855f7; box-shadow:0 0 12px #a855f7;"></span>
        <h4 style="color:#e2e8f0; font-size:1.05rem; margin-bottom:0.4rem; font-weight:700;">✨ Phiên Chat Mới Sẵn Sàng</h4>
        <p class="empty-hint" style="max-width:560px; margin:0 auto; line-height:1.5;">
          Gõ yêu cầu / chỉ đạo vào khung chat bên dưới để gửi cho <strong>Kiến Trúc Sư ChatGPT Web</strong>. 
          ChatGPT sẽ trực tiếp đọc cấu trúc dự án & tài liệu kỹ thuật trên máy local để giao việc cho Worker Gemini trong Antigravity IDE. 
          Tên phiên chat sẽ được <strong>tự động đồng bộ</strong> khi Antigravity tiếp nhận lệnh!
        </p>
      </div>
    `;
  }

  // Clear live steps
  const stepsContainer = document.getElementById('agent-live-steps-container');
  if (stepsContainer) {
    stepsContainer.innerHTML = `
      <div class="log-empty-state" id="log-empty-state">
        <span>✨ Phiên mới sẵn sàng. Chờ bước thi công từ Agent...</span>
      </div>
    `;
  }
  const badgeSteps = document.getElementById('badge-live-steps-count');
  if (badgeSteps) badgeSteps.textContent = '0 Bước';

  // Stop any running observer
  stopObservingAntigravity();
  showToast('✨ Đã mở phiên chat mới. Hãy gửi lệnh đầu tiên!', 'success');
}

let sessionNameSyncInterval = null;

function startSessionNameSyncPoller(startTime = Date.now()) {
  if (sessionNameSyncInterval) clearInterval(sessionNameSyncInterval);
  let pollAttempts = 0;
  const maxAttempts = 35; // 35 * 2.5s = ~88 seconds

  sessionNameSyncInterval = setInterval(async () => {
    pollAttempts++;
    if (pollAttempts > maxAttempts || (state.selectedAgySession !== 'new' && !state.selectedAgySession)) {
      clearInterval(sessionNameSyncInterval);
      sessionNameSyncInterval = null;
      return;
    }

    try {
      const res = await apiGet('/api/antigravity/conversations');
      if (!res || !res.conversations || res.conversations.length === 0) return;

      // Find the newest running or current conversation
      const runningOrCurrent = res.conversations.find(c => c.status === 'running' || c.status === 'current') || res.conversations[0];

      if (runningOrCurrent && runningOrCurrent.id && runningOrCurrent.id !== 'eb04834e-f388-4dd3-afd7-4001e7fa3da5') {
        const title = runningOrCurrent.title;
        if (title && !title.includes('(Chờ nhận lệnh)') && title !== 'Phiên Chat Mới') {
          clearInterval(sessionNameSyncInterval);
          sessionNameSyncInterval = null;

          state.selectedAgySession = runningOrCurrent.id;

          // Reload dropdown options and select this new session
          await loadAntigravitySessions(state.selectedProject);
          const agySel = document.getElementById('global-antigravity-session-select');
          if (agySel) agySel.value = runningOrCurrent.id;

          const dispSess = document.getElementById('disp-active-session');
          if (dispSess) dispSess.textContent = title;

          showToast(`✨ Đã đồng bộ tên phiên chat: "${title}"!`, 'success');
          pollAgentLiveSteps();
        }
      }
    } catch (e) {}
  }, 2500);
}
async function loadSessions() {
  const query = new URLSearchParams();
  if (state.filters.role !== 'all') query.set('role', state.filters.role);
  if (state.filters.status !== 'all') query.set('status', state.filters.status);
  if (state.filters.project !== 'all') query.set('project', state.filters.project);
  if (state.filters.q) query.set('q', state.filters.q);

  const data = await apiGet(`/api/sessions?${query.toString()}`);
  if (!data || !data.sessions) return;
  state.sessions = data.sessions;

  // Update counters
  const total = state.sessions.length;
  const orchCount = state.sessions.filter(s => s.role === 'orchestrator').length;
  const workerCount = state.sessions.filter(s => s.role === 'worker').length;

  const elTotal = document.getElementById('stat-total-sessions');
  if (elTotal) elTotal.textContent = total;
  const elOrch = document.getElementById('stat-orch-sessions');
  if (elOrch) elOrch.textContent = orchCount;
  const elWorker = document.getElementById('stat-worker-sessions');
  if (elWorker) elWorker.textContent = workerCount;

  const bTotal = document.getElementById('badge-total-sessions');
  if (bTotal) bTotal.textContent = total;
  const bOrch = document.getElementById('badge-orch-count');
  if (bOrch) bOrch.textContent = orchCount;
  const bWorker = document.getElementById('badge-worker-count');
  if (bWorker) bWorker.textContent = workerCount;

  // Render Table Rows if element exists
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;
  if (state.sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">Không tìm thấy session nào phù hợp với bộ lọc.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  state.sessions.forEach(s => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';

    // Role badge
    const isOrch = s.role === 'orchestrator';
    const roleBadge = isOrch 
      ? `<span class="badge badge-purple">Orchestrator (${s.harness})</span>` 
      : `<span class="badge badge-emerald">Worker (${s.harness})</span>`;

    // Status badge
    let statusClass = 'badge-cyan';
    if (s.isTerminated || s.status === 'terminated' || s.activityState === 'exited') statusClass = 'badge-rose';
    else if (s.activityState === 'active' || s.status === 'working') statusClass = 'badge-amber';
    else if (s.activityState === 'idle' || s.status === 'idle') statusClass = 'badge-cyan';

    const timeStr = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '-';

    tr.innerHTML = `
      <td>
        <div class="session-name-cell">
          <span class="session-name">${escapeHtml(s.displayName || s.id)}</span>
          <span class="session-id">${escapeHtml(s.id)}</span>
        </div>
      </td>
      <td>${roleBadge}</td>
      <td><span class="badge">${escapeHtml(s.projectId)}</span></td>
      <td><span class="badge ${statusClass}">${escapeHtml(s.activityState || s.status)}</span></td>
      <td>
        <div style="font-size: 0.78rem;">
          <div><code>${escapeHtml(s.model || 'default')}</code></div>
          ${s.branch ? `<div style="color: var(--text-muted); font-size: 0.72rem;">${escapeHtml(s.branch)}</div>` : ''}
        </div>
      </td>
      <td style="font-size: 0.75rem; color: var(--text-muted);">${timeStr}</td>
      <td>
        <div style="display:flex; gap: 0.35rem;">
          <button class="btn btn-secondary btn-xs btn-inspect-session" data-id="${s.id}">
            ${isOrch ? 'Trích Plan' : 'Xem Files & Test'}
          </button>
          <button class="btn btn-secondary btn-xs btn-send-session" data-id="${s.id}" title="Nhắn tin / Steer">
            Gửi Lệnh
          </button>
        </div>
      </td>
    `;

    // Click row opens drawer
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openSessionDrawer(s);
    });

    tr.querySelector('.btn-inspect-session').addEventListener('click', () => {
      openSessionDrawer(s, isOrch ? 'plan' : 'artifacts');
    });

    tr.querySelector('.btn-send-session').addEventListener('click', () => {
      openSendModal(s);
    });

    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------
// Slide-over Drawer & Extraction
// -------------------------------------------------------------
async function openSessionDrawer(session, targetTab = 'overview') {
  state.activeSession = session;
  const drawer = document.getElementById('session-drawer');
  const overlay = document.getElementById('drawer-overlay');

  document.getElementById('drawer-title').textContent = `${session.displayName} (${session.id})`;
  const roleBadge = document.getElementById('drawer-role-badge');
  const isOrch = session.role === 'orchestrator';

  roleBadge.textContent = isOrch ? 'Orchestrator (ChatGPT Web)' : 'Worker (Antigravity)';
  roleBadge.className = isOrch ? 'badge badge-purple' : 'badge badge-emerald';

  // Toggle Tab visibility based on role
  document.getElementById('dtab-plan-btn').style.display = isOrch ? 'block' : 'none';
  document.getElementById('dtab-artifacts-btn').style.display = !isOrch ? 'block' : 'none';

  // Render Metadata
  const metaList = document.getElementById('drawer-meta-list');
  metaList.innerHTML = `
    <div style="display:flex; flex-direction:column; gap: 0.4rem; font-size: 0.82rem; background: rgba(0,0,0,0.2); padding: 0.75rem; border-radius: var(--radius-md);">
      <div><strong>Dự án:</strong> ${escapeHtml(session.projectId)}</div>
      <div><strong>Harness:</strong> <code>${escapeHtml(session.harness)}</code></div>
      <div><strong>Trạng thái:</strong> <span class="badge badge-cyan">${escapeHtml(session.activityState)}</span></div>
      <div><strong>Model:</strong> <code>${escapeHtml(session.model || 'chatgpt-web/medium')}</code></div>
      ${session.branch ? `<div><strong>Nhánh Git:</strong> <code>${escapeHtml(session.branch)}</code></div>` : ''}
      ${session.workspacePath ? `<div><strong>Worktree:</strong> <code style="word-break: break-all;">${escapeHtml(session.workspacePath)}</code></div>` : ''}
      ${session.prompt ? `<div style="margin-top:0.4rem;"><strong>Prompt ban đầu:</strong><pre class="code-preview-box" style="margin-top:0.2rem; max-height:100px;">${escapeHtml(session.prompt)}</pre></div>` : ''}
    </div>
  `;

  // Switch to target drawer tab
  switchDrawerTab(targetTab);

  drawer.classList.add('active');
  overlay.classList.add('active');

  // Trigger role-specific extractions
  if (isOrch) {
    loadOrchestratorPlan(session.id);
  } else {
    loadWorkerArtifacts(session.id);
  }
}

function switchDrawerTab(tabId) {
  document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dtab === tabId);
  });
  document.querySelectorAll('.dtab-content').forEach(pane => {
    pane.classList.toggle('active', pane.id === `dtab-${tabId}`);
  });
}

function closeSessionDrawer() {
  document.getElementById('session-drawer').classList.remove('active');
  document.getElementById('drawer-overlay').classList.remove('active');
  state.activeSession = null;
}

// Orchestrator Plan Extraction
async function loadOrchestratorPlan(sessionId) {
  const planPre = document.getElementById('extracted-plan-text');
  const promptPre = document.getElementById('extracted-worker-prompt');

  planPre.textContent = 'Đang trích xuất kế hoạch từ log ChatGPT Web...';
  promptPre.textContent = 'Đang trích xuất prompt cho Worker...';

  const data = await apiGet(`/api/extract/plan/${sessionId}`);
  if (!data || data.error) {
    planPre.textContent = `Không tìm thấy kế hoạch hoặc session chưa sinh output: ${data ? data.error : 'Lỗi kết nối'}`;
    promptPre.textContent = 'Chưa có prompt.';
    state.extractedData = null;
    return;
  }

  state.extractedData = data;
  planPre.textContent = data.extractedPlan || data.lastAssistantResponse || 'Chưa có nội dung.';
  promptPre.textContent = data.workerPromptTemplate || 'Chưa có prompt.';
}

// Worker Worktree Artifacts & Tests
async function loadWorkerArtifacts(sessionId) {
  const pathLabel = document.getElementById('worktree-path-val');
  const filesUl = document.getElementById('worktree-files-ul');
  const preview = document.getElementById('file-content-view');
  const filenameLabel = document.getElementById('preview-filename');

  pathLabel.textContent = 'Đang đọc...';
  filesUl.innerHTML = '<li class="file-item loading">Đang nạp danh sách file...</li>';
  preview.textContent = '// Chọn file để xem code';
  filenameLabel.textContent = 'Chưa chọn file';

  const data = await apiGet(`/api/extract/worktree/${sessionId}`);
  if (!data || data.error) {
    pathLabel.textContent = 'Không tìm thấy worktree';
    filesUl.innerHTML = `<li class="file-item" style="color:var(--accent-rose)">${data ? data.error : 'Lỗi kết nối'}</li>`;
    return;
  }

  pathLabel.textContent = data.worktreePath;
  filesUl.innerHTML = '';

  if (data.files.length === 0) {
    filesUl.innerHTML = '<li class="file-item">Thư mục trống.</li>';
    return;
  }

  data.files.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = `file-item ${idx === 0 ? 'active' : ''}`;
    li.textContent = f.path;
    li.title = `${f.size} bytes - ${new Date(f.mtime).toLocaleString()}`;
    li.addEventListener('click', () => {
      filesUl.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
      li.classList.add('active');
      loadFileContent(sessionId, f.path);
    });
    filesUl.appendChild(li);
  });

  // Auto load first file
  if (data.files.length > 0) {
    loadFileContent(sessionId, data.files[0].path);
  }
}

async function loadFileContent(sessionId, filePath) {
  const preview = document.getElementById('file-content-view');
  const filenameLabel = document.getElementById('preview-filename');
  preview.textContent = 'Đang tải file...';
  filenameLabel.textContent = filePath;

  const data = await apiGet(`/api/extract/worktree/${sessionId}?file=${encodeURIComponent(filePath)}`);
  if (!data || data.error) {
    preview.textContent = `Không đọc được file: ${data ? data.error : 'Lỗi kết nối'}`;
    return;
  }
  preview.textContent = data.content;
}

// -------------------------------------------------------------
// Modals & Action Flows
// -------------------------------------------------------------
function openSpawnModal(defaultRole = 'orchestrator', prefilledPrompt = '', prefilledName = '') {
  const modal = document.getElementById('spawn-modal');
  modal.classList.add('active');

  // Set Role
  const roleRadios = document.querySelectorAll('input[name="spawn-role"]');
  roleRadios.forEach(r => {
    r.checked = (r.value === defaultRole);
  });
  updateRoleCardStyles();

  if (prefilledName) {
    document.getElementById('spawn-name').value = prefilledName;
  } else {
    document.getElementById('spawn-name').value = defaultRole === 'orchestrator' ? 'orch-plan' : 'worker-task';
  }

  if (prefilledPrompt) {
    document.getElementById('spawn-prompt').value = prefilledPrompt;
  } else {
    document.getElementById('spawn-prompt').value = '';
  }
}

function closeSpawnModal() {
  document.getElementById('spawn-modal').classList.remove('active');
}

function updateRoleCardStyles() {
  const val = document.querySelector('input[name="spawn-role"]:checked').value;
  document.getElementById('role-opt-orch').classList.toggle('selected', val === 'orchestrator');
  document.getElementById('role-opt-worker').classList.toggle('selected', val === 'worker');
}

function openSendModal(session) {
  const modal = document.getElementById('send-modal');
  modal.classList.add('active');
  document.getElementById('send-session-id').value = session.id;
  document.getElementById('send-session-display').value = `${session.displayName} (${session.id})`;
  document.getElementById('send-message-text').value = '';
}

function closeSendModal() {
  document.getElementById('send-modal').classList.remove('active');
}

// -------------------------------------------------------------
// Safe Event Listener Helper
function safeOn(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

// Event Listeners Setup
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Set observer view active by default with compact layout
  switchMainView('observer');

  // Immediately load initial data
  loadAntigravitySessions().catch(e => console.error('loadAntigravitySessions error:', e));
  loadProjects().catch(e => console.error('loadProjects error:', e));
  loadModelCatalogs().catch(e => console.error('loadModelCatalogs error:', e));
  loadSessions().catch(e => console.error('loadSessions error:', e));
  loadStatus().catch(e => console.error('loadStatus error:', e));

  // Auto-polling every 2.5 seconds
  setInterval(() => {
    loadSessions();
    loadStatus();
    if (state.activeTab === 'observer') {
      pollAgentLiveSteps();
    }
  }, 2500);

  // Switch Active Main Content View
  function switchMainView(tabName) {
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.remove('active');
    });
    const targetView = document.getElementById(`view-${tabName}`);
    if (targetView) {
      targetView.classList.add('active');
    }
  }

  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const tab = item.dataset.tab;
      state.activeTab = tab;

      if (tab === 'settings') {
        switchMainView('settings');
        loadChatGPTConfigAndCodexModels();
      } else if (tab === 'sessions') {
        switchMainView('sessions');
        loadWorkSessionsTab();
      } else {
        switchMainView(tab);
      }
      loadSessions();
    });
  });

  // Buttons inside Quản Lý Phiên Làm Việc view
  const btnCreateSessionTab = document.getElementById('btn-create-session-tab');
  if (btnCreateSessionTab) {
    btnCreateSessionTab.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === 'observer'));
      state.activeTab = 'observer';
      switchMainView('observer');
      handleNewSessionSelected();
    });
  }

  const btnRefreshSessionsTab = document.getElementById('btn-refresh-sessions-tab');
  if (btnRefreshSessionsTab) {
    btnRefreshSessionsTab.addEventListener('click', () => {
      loadWorkSessionsTab();
      showToast('Đã làm mới danh sách phiên làm việc!');
    });
  }

  function switchMainView(viewId) {
    document.querySelectorAll('.tab-view').forEach(v => {
      v.classList.toggle('active', v.id === `view-${viewId}`);
    });
    const statsGrid = document.querySelector('.stats-grid');
    if (statsGrid) {
      statsGrid.style.display = (viewId === 'observer' || viewId === 'settings' || viewId === 'sessions') ? 'none' : 'grid';
    }
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      mainContent.style.padding = (viewId === 'observer') ? '0.4rem 0.5rem' : '1.25rem 1.75rem';
      mainContent.style.gap = (viewId === 'observer') ? '0' : '1.25rem';
      mainContent.style.overflowY = (viewId === 'observer') ? 'hidden' : 'auto';
    }
  }

  function updateRolePillsUI() {
    document.querySelectorAll('#filter-role-pills .pill-opt').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === state.filters.role);
    });
  }

  // Filter Role Pills
  document.querySelectorAll('#filter-role-pills .pill-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filter-role-pills .pill-opt').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      state.filters.role = btn.dataset.value;
      loadSessions();
    });
  });

  // Filter Status Pills
  document.querySelectorAll('#filter-status-pills .pill-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filter-status-pills .pill-opt').forEach(el => el.classList.remove('active'));
      btn.classList.add('active');
      state.filters.status = btn.dataset.value;
      loadSessions();
    });
  });

  // Filter Project
  safeOn('filter-project-select', 'change', (e) => {
    state.filters.project = e.target.value;
    loadSessions();
  });

  // Search Input
  let searchTimeout = null;
  safeOn('filter-search-input', 'input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      loadSessions();
    }, 250);
  });

  // Direct 1-Click Project Folder Opening (Windows Native Folder Picker)
  safeOn('btn-open-project-folder', 'click', openNativeFolderPickerAndAdd);
  safeOn('btn-add-project-modal', 'click', openNativeFolderPickerAndAdd);

  // Refresh Button
  safeOn('btn-refresh', 'click', async () => {
    await Promise.all([
      loadStatus(),
      loadProjects(),
      loadSessions(),
      state.selectedProject ? loadAntigravitySessions(state.selectedProject) : Promise.resolve(),
      state.selectedProject ? loadTechnicalContext(state.selectedProject) : Promise.resolve(),
      state.selectedProject ? loadExchangeStream(state.selectedProject) : Promise.resolve()
    ]);
    showToast('Dữ liệu đã được làm mới!');
  });

  // Drawer Controls
  safeOn('drawer-close-btn', 'click', closeSessionDrawer);
  safeOn('drawer-overlay', 'click', closeSessionDrawer);
  document.querySelectorAll('.drawer-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchDrawerTab(btn.dataset.dtab));
  });

  // Copy Plan & Worker Prompt
  safeOn('btn-copy-plan', 'click', () => {
    const text = document.getElementById('extracted-plan-text').textContent;
    navigator.clipboard.writeText(text);
    showToast('Đã sao chép kế hoạch!');
  });

  safeOn('btn-copy-worker-prompt', 'click', () => {
    const text = document.getElementById('extracted-worker-prompt').textContent;
    navigator.clipboard.writeText(text);
    showToast('Đã sao chép Worker Prompt!');
  });

  safeOn('btn-copy-code', 'click', () => {
    const text = document.getElementById('file-content-view').textContent;
    navigator.clipboard.writeText(text);
    showToast('Đã sao chép mã nguồn!');
  });

  // 1-Click Dispatch to Antigravity Worker!
  safeOn('btn-dispatch-to-agy', 'click', () => {
    const prompt = document.getElementById('extracted-worker-prompt').textContent;
    closeSessionDrawer();
    openSpawnModal('worker', prompt, 'agy-worker-run');
  });

  // Run Test in Worker Worktree
  safeOn('btn-run-worktree-test', 'click', async () => {
    if (!state.activeSession) return;
    const testBox = document.getElementById('test-result-box');
    const badge = document.getElementById('test-status-badge');
    const out = document.getElementById('test-output-text');

    testBox.classList.remove('hidden');
    badge.className = 'badge badge-amber';
    badge.textContent = 'Đang chạy test...';
    out.textContent = 'Executing node test.js in worktree...';

    const res = await apiPost(`/api/extract/worktree/${state.activeSession.id}/test`, {
      command: 'node test.js'
    });

    if (res.passed) {
      badge.className = 'badge badge-emerald';
      badge.textContent = 'Passed (Thành công)';
      out.textContent = res.stdout || 'Tests passed without output';
      showToast('Kiểm thử thành công!', 'success');
    } else {
      badge.className = 'badge badge-rose';
      badge.textContent = `Failed (Exit code ${res.exitCode})`;
      out.textContent = (res.stderr || res.stdout || res.error || 'Test failed');
      showToast('Kiểm thử thất bại!', 'error');
    }
  });

  // Drawer Quick Action: Send / Kill
  safeOn('drawer-send-btn', 'click', () => {
    if (state.activeSession) openSendModal(state.activeSession);
  });

  safeOn('drawer-kill-btn', 'click', async () => {
    if (!state.activeSession) return;
    if (!confirm(`Bạn có chắc muốn dừng session ${state.activeSession.id}?`)) return;
    const res = await apiPost(`/api/sessions/${state.activeSession.id}/kill`, {});
    if (res.error) {
      showToast(`Lỗi: ${res.error}`, 'error');
    } else {
      showToast(`Đã dừng session ${state.activeSession.id}!`, 'success');
      closeSessionDrawer();
      await loadSessions();
    }
  });

  // Modal: Spawn
  safeOn('btn-spawn-modal', 'click', () => openSpawnModal());
  safeOn('spawn-modal-close', 'click', closeSpawnModal);
  safeOn('spawn-modal-cancel', 'click', closeSpawnModal);

  document.querySelectorAll('input[name="spawn-role"]').forEach(r => {
    r.addEventListener('change', updateRoleCardStyles);
  });

  safeOn('spawn-form', 'submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('spawn-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Đang khởi tạo...';

    const project = document.getElementById('spawn-project').value;
    const kind = document.querySelector('input[name="spawn-role"]:checked').value;
    const name = document.getElementById('spawn-name').value.trim();
    const prompt = document.getElementById('spawn-prompt').value.trim();

    const res = await apiPost('/api/sessions/spawn', { project, kind, name, prompt });
    if (res.error) {
      showToast(`Lỗi khởi tạo: ${res.error}`, 'error');
    } else {
      showToast(`Đã khởi tạo session ${res.sessionId || name}!`, 'success');
      closeSpawnModal();
      await loadSessions();
    }
    btn.disabled = false;
    btn.textContent = 'Bắt Đầu Session';
  });

  // Modal: Send
  safeOn('send-modal-close', 'click', closeSendModal);
  safeOn('send-modal-cancel', 'click', closeSendModal);
  safeOn('send-form', 'submit', async (e) => {
    e.preventDefault();
    const sessionId = document.getElementById('send-session-id').value;
    const message = document.getElementById('send-message-text').value.trim();

    const res = await apiPost(`/api/sessions/${sessionId}/send`, { message });
    if (res.error) {
      showToast(`Lỗi gửi lệnh: ${res.error}`, 'error');
    } else {
      showToast('Đã gửi lệnh điều phối thành công!', 'success');
      closeSendModal();
      await loadSessions();
    }
  });

  // -------------------------------------------------------------
  // Model Catalogs & Live Testing
  // -------------------------------------------------------------
  async function loadModelCatalogs() {
    const data = await apiGet('/api/models');
    if (!data) return;

    const chatgptSelect = document.getElementById('select-model-chatgpt');
    if (chatgptSelect && data.chatgpt && data.chatgpt.models) {
      chatgptSelect.innerHTML = '';
      data.chatgpt.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === data.chatgpt.defaultModel) opt.selected = true;
        chatgptSelect.appendChild(opt);
      });
    }

    const agySelect = document.getElementById('select-model-antigravity');
    if (agySelect && data.antigravity && data.antigravity.models) {
      agySelect.innerHTML = '';
      data.antigravity.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === data.antigravity.defaultModel) opt.selected = true;
        agySelect.appendChild(opt);
      });
    }
  }

  // Test ChatGPT Model
  safeOn('btn-test-chatgpt', 'click', async () => {
    const btn = document.getElementById('btn-test-chatgpt');
    const badge = document.getElementById('badge-test-chatgpt');
    const model = document.getElementById('select-model-chatgpt').value;

    btn.disabled = true;
    badge.className = 'latency-badge badge-amber';
    badge.textContent = 'Testing...';
    badge.classList.remove('hidden');

    const res = await apiPost('/api/models/test', { provider: 'chatgpt', model });
    btn.disabled = false;

    if (res && res.success) {
      badge.className = 'latency-badge badge-emerald';
      badge.textContent = `${res.durationMs}ms - Sẵn sàng`;
      showToast(`ChatGPT Web (${model}) phản hồi tốt (${res.durationMs}ms)!`, 'success');
    } else {
      badge.className = 'latency-badge badge-rose';
      badge.textContent = 'Lỗi / Chặn';
      showToast(`ChatGPT Web (${model}) lỗi: ${res.error || 'Failed'}`, 'error');
    }
  });

  // Test Antigravity Model
  safeOn('btn-test-antigravity', 'click', async () => {
    const btn = document.getElementById('btn-test-antigravity');
    const badge = document.getElementById('badge-test-antigravity');
    const model = document.getElementById('select-model-antigravity').value;

    btn.disabled = true;
    badge.className = 'latency-badge badge-amber';
    badge.textContent = 'Testing...';
    badge.classList.remove('hidden');

    const res = await apiPost('/api/models/test', { provider: 'antigravity', model });
    btn.disabled = false;

    if (res && res.success) {
      badge.className = 'latency-badge badge-emerald';
      badge.textContent = `${res.durationMs}ms - Sẵn sàng`;
      showToast(`Antigravity (${model}) phản hồi tốt (${res.durationMs}ms)!`, 'success');
    } else {
      badge.className = 'latency-badge badge-rose';
      badge.textContent = 'Lỗi';
      showToast(`Antigravity (${model}) lỗi: ${res.error || 'Failed'}`, 'error');
    }
  });

  // -------------------------------------------------------------
  // Closed-Loop Workflow Runner (Human -> ChatGPT -> Antigravity -> Audit Gate)
  // -------------------------------------------------------------
  const workflowState = {
    project: null,
    goal: '',
    workOrder: null,
    workerSessionId: null,
    workerReport: null,
    auditResult: null
  };

    function resetWorkflow() {
    workflowState.workOrder = null;
    workflowState.workerSessionId = null;
    workflowState.workerReport = null;
    workflowState.auditResult = null;

    const s1 = document.getElementById('stage-1-badge');
    if (s1) { s1.className = 'stage-status-badge badge badge-cyan'; s1.textContent = 'Sẵn Sàng'; }

    const s2 = document.getElementById('stage-2');
    if (s2) s2.classList.add('disabled');
    const s2b = document.getElementById('stage-2-badge');
    if (s2b) { s2b.className = 'stage-status-badge badge badge-purple'; s2b.textContent = 'Chờ Kích Hoạt'; }
    const wId = document.getElementById('wo-id');
    if (wId) wId.textContent = 'WO-001';
    const wTitle = document.getElementById('wo-title');
    if (wTitle) wTitle.textContent = 'Tên WorkOrder';
    const wObj = document.getElementById('wo-objective');
    if (wObj) wObj.textContent = '-';
    const wCrit = document.getElementById('wo-criteria');
    if (wCrit) wCrit.innerHTML = '';
    const wFiles = document.getElementById('wo-files');
    if (wFiles) wFiles.textContent = '-';
    const wTest = document.getElementById('wo-test-cmd');
    if (wTest) wTest.textContent = 'node test.js';
    const btnDisp = document.getElementById('btn-dispatch-workorder-to-worker');
    if (btnDisp) btnDisp.disabled = true;

    const s3 = document.getElementById('stage-3');
    if (s3) s3.classList.add('disabled');
    const s3b = document.getElementById('stage-3-badge');
    if (s3b) { s3b.className = 'stage-status-badge badge badge-emerald'; s3b.textContent = 'Chờ Nhận Lệnh'; }
    const wrSess = document.getElementById('wr-session-id');
    if (wrSess) wrSess.textContent = '-';
    const wrFiles = document.getElementById('wr-files-modified');
    if (wrFiles) wrFiles.textContent = '-';
    const wrTest = document.getElementById('wr-test-badge');
    if (wrTest) { wrTest.textContent = '-'; wrTest.className = 'badge'; }
    const wrOut = document.getElementById('wr-test-output');
    if (wrOut) wrOut.textContent = 'Chưa có kết quả chạy test...';
    const btnSub = document.getElementById('btn-submit-to-review-gate');
    if (btnSub) btnSub.disabled = true;

    const s4 = document.getElementById('stage-4');
    if (s4) s4.classList.add('disabled');
    const s4b = document.getElementById('stage-4-badge');
    if (s4b) { s4b.className = 'stage-status-badge badge'; s4b.textContent = 'Chờ Đánh Giá'; }
    const vVal = document.getElementById('verdict-val');
    if (vVal) vVal.textContent = 'CHỜ DUYỆT';
    const vSum = document.getElementById('verdict-summary');
    if (vSum) vSum.textContent = 'Chưa có đánh giá.';
    const vCrit = document.getElementById('verdict-critique');
    if (vCrit) vCrit.innerHTML = '';
    const vFix = document.getElementById('verdict-fix-box');
    if (vFix) vFix.classList.add('hidden');
    const bFix = document.getElementById('btn-action-fix');
    if (bFix) bFix.classList.add('hidden');
    const bPass = document.getElementById('btn-action-pass');
    if (bPass) bPass.classList.add('hidden');
    const celeb = document.getElementById('complete-celebration');
    if (celeb) celeb.classList.add('hidden');
    const banner = document.getElementById('verdict-banner');
    if (banner) banner.className = 'verdict-banner';
  }

  safeOn('btn-reset-workflow', 'click', () => {
    resetWorkflow();
    showToast('Đã đặt lại quy trình khép kín.');
  });

  // Stage 1: Trigger ChatGPT Web to create WorkOrder
  safeOn('btn-start-orchestrator-plan', 'click', async () => {
    const btn = document.getElementById('btn-start-orchestrator-plan');
    const project = document.getElementById('workflow-project-select').value;
    const goal = document.getElementById('workflow-goal-input').value.trim();
    const model = document.getElementById('select-model-chatgpt')?.value || 'chatgpt-web/high';

    if (!project) {
      showToast('Vui lòng chọn repository dự án trước!', 'error');
      return;
    }
    if (!goal) {
      showToast('Vui lòng nhập mục tiêu dự án (Project Goal)!', 'error');
      return;
    }

    workflowState.project = project;
    workflowState.goal = goal;

    btn.disabled = true;
    btn.innerHTML = '<span>Đang yêu cầu ChatGPT Web lập WorkOrder...</span>';

    const res = await apiPost('/api/orchestrator/create-workorder', { goal, model, projectId: project });
    btn.disabled = false;
    btn.textContent = '1. Kích Hoạt ChatGPT Web (Orchestrator Plan)';

    if (!res || !res.workOrder) {
      showToast('Lỗi tạo WorkOrder: ' + (res && res.error ? res.error : 'Unknown'), 'error');
      return;
    }

    const wo = res.workOrder;
    workflowState.workOrder = wo;

    // Render Stage 2
    document.getElementById('wo-id').textContent = wo.workOrderId || 'WO-001';
    document.getElementById('wo-title').textContent = wo.title || 'WorkOrder Title';
    document.getElementById('wo-objective').textContent = wo.objective || goal;
    document.getElementById('wo-criteria').innerHTML = (wo.acceptanceCriteria || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');
    document.getElementById('wo-files').textContent = (wo.filesScope || []).join(', ');
    document.getElementById('wo-test-cmd').textContent = wo.testCommand || 'node test.js';

    const stage2 = document.getElementById('stage-2');
    stage2.classList.remove('disabled');
    document.getElementById('stage-2-badge').textContent = 'Đã Tạo WorkOrder';
    document.getElementById('stage-2-badge').className = 'stage-status-badge badge badge-emerald';
    document.getElementById('btn-dispatch-workorder-to-worker').disabled = false;

    document.getElementById('stage-1-badge').textContent = 'Đã Phân Rã';
    document.getElementById('stage-1-badge').className = 'stage-status-badge badge badge-emerald';

    showToast(`ChatGPT Web đã ban hành ${wo.workOrderId}!`, 'success');
    stage2.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Stage 2: Dispatch WorkOrder to Antigravity Worker
  safeOn('btn-dispatch-workorder-to-worker', 'click', async () => {
    if (!workflowState.workOrder) return;
    const btn = document.getElementById('btn-dispatch-workorder-to-worker');
    const wo = workflowState.workOrder;
    const model = document.getElementById('select-model-antigravity')?.value || 'gemini-3.8-flash-high';
    const stage3 = document.getElementById('stage-3');

    btn.disabled = true;
    btn.innerHTML = '<span>Đang khởi tạo Antigravity Worker...</span>';

    // 1. Spawn Worker Session
    const spawnRes = await apiPost('/api/sessions/spawn', {
      project: workflowState.project,
      kind: 'worker',
      name: `wo-${(wo.workOrderId || 'wo-001').toLowerCase()}`,
      prompt: wo.workerPrompt || wo.objective,
      harness: 'agy',
      model
    });

    if (spawnRes.error || !spawnRes.sessionId) {
      btn.disabled = false;
      btn.textContent = '2. Giao WorkOrder Cho Antigravity Worker';
      showToast('Lỗi khởi tạo Worker: ' + (spawnRes.error || 'Unknown'), 'error');
      return;
    }

    const sessionId = spawnRes.sessionId;
    workflowState.workerSessionId = sessionId;

    stage3.classList.remove('disabled');
    document.getElementById('stage-3-badge').textContent = 'Đang Thi Công...';
    document.getElementById('stage-3-badge').className = 'stage-status-badge badge badge-amber';
    document.getElementById('wr-session-id').textContent = `${sessionId} (${model})`;
    document.getElementById('wr-test-badge').textContent = 'Đang thực thi...';
    document.getElementById('wr-test-badge').className = 'badge badge-amber';
    document.getElementById('wr-test-output').textContent = 'Antigravity đang code và kiểm tra trong Worktree cô lập...';

    stage3.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`Antigravity Worker (${sessionId}) đã nhận lệnh!`, 'success');

    btn.innerHTML = `<span>Worker đang thực hiện (${sessionId})...</span>`;

    // 2. Poll session activity until idle, exited, or timeout (up to 60s)
    const startTime = Date.now();
    const maxWaitMs = 60000;
    const pollIntervalMs = 2000;

    const pollWorker = async () => {
      let isDone = false;
      try {
        const sessData = await apiGet(`/api/sessions?project=${workflowState.project}`);
        if (sessData && sessData.sessions) {
          const s = sessData.sessions.find(x => x.id === sessionId);
          if (s) {
            if (s.activityState === 'idle' || s.activityState === 'exited' || s.isTerminated) {
              isDone = true;
            }
          }
        }
      } catch (e) {}

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      document.getElementById('wr-test-output').textContent = `Antigravity đang code và kiểm tra trong Worktree cô lập (${elapsed}s)...`;

      if (isDone || (Date.now() - startTime) >= maxWaitMs) {
        const testCmd = wo.testCommand || 'node test.js';
        const testRes = await apiPost(`/api/extract/worktree/${sessionId}/test`, { command: testCmd });
        const wtInfo = await apiGet(`/api/extract/worktree/${sessionId}`);

        const filesMod = (wtInfo && wtInfo.files) ? wtInfo.files.map(f => f.name) : (wo.filesScope || ['index.js']);
        const passed = testRes && !!testRes.passed;
        const testOutput = (testRes ? (testRes.stdout || testRes.stderr || (passed ? 'Tests passed successfully' : 'Test failed')) : 'No output');

        workflowState.workerReport = {
          workOrderId: wo.workOrderId,
          filesModified: filesMod,
          testCommand: testCmd,
          testPassed: passed,
          testOutput: testOutput,
          gitDiff: (wtInfo && wtInfo.diff) ? wtInfo.diff : ''
        };

        // Update Stage 3 UI
        document.getElementById('wr-files-modified').textContent = filesMod.join(', ') || 'None';
        document.getElementById('wr-test-badge').textContent = passed ? 'Passed (Thành công)' : `Failed (Exit ${testRes ? testRes.exitCode : 1})`;
        document.getElementById('wr-test-badge').className = passed ? 'badge badge-emerald' : 'badge badge-rose';
        document.getElementById('wr-test-output').textContent = testOutput;

        document.getElementById('stage-3-badge').textContent = 'Đã Hoàn Tất Thi Công';
        document.getElementById('stage-3-badge').className = 'stage-status-badge badge badge-emerald';
        document.getElementById('btn-submit-to-review-gate').disabled = false;

        btn.disabled = false;
        btn.textContent = '2. Giao WorkOrder Cho Antigravity Worker';

        showToast(`Worker thi công xong! Test: ${passed ? 'PASSED' : 'FAILED'}`, passed ? 'success' : 'error');
        await loadSessions();
      } else {
        setTimeout(pollWorker, pollIntervalMs);
      }
    };

    setTimeout(pollWorker, 3000);
  });

  // Stage 3: Submit to ChatGPT Web Review Gate
  safeOn('btn-submit-to-review-gate', 'click', async () => {
    if (!workflowState.workOrder || !workflowState.workerReport) return;
    const btn = document.getElementById('btn-submit-to-review-gate');
    const stage4 = document.getElementById('stage-4');
    const gptModel = document.getElementById('select-model-chatgpt')?.value || 'chatgpt-web/high';

    btn.disabled = true;
    btn.innerHTML = '<span>ChatGPT Web đang thẩm định chứng cứ...</span>';

    const auditRes = await apiPost('/api/orchestrator/audit', {
      workOrder: workflowState.workOrder,
      workerReport: workflowState.workerReport,
      model: gptModel
    });

    btn.disabled = false;
    btn.textContent = '3. Gửi WorkerReport Sang Review Gate';

    if (!auditRes || !auditRes.auditResult) {
      showToast('Lỗi thẩm định: ' + (auditRes && auditRes.error ? auditRes.error : 'Unknown'), 'error');
      return;
    }

    const audit = auditRes.auditResult;
    workflowState.auditResult = audit;

    stage4.classList.remove('disabled');
    document.getElementById('stage-4-badge').textContent = `Phán Quyết: ${audit.verdict}`;
    document.getElementById('stage-4-badge').className = `stage-status-badge badge ${audit.verdict === 'FIX' ? 'badge-rose' : (audit.verdict === 'PASS' ? 'badge-emerald' : 'badge-cyan')}`;

    const banner = document.getElementById('verdict-banner');
    banner.className = `verdict-banner verdict-${audit.verdict.toLowerCase()}`;

    document.getElementById('verdict-val').textContent = audit.verdict;
    document.getElementById('verdict-summary').textContent = audit.summary || 'Không có tóm tắt.';
    document.getElementById('verdict-critique').innerHTML = (audit.critique || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');

    const fixBox = document.getElementById('verdict-fix-box');
    const btnFix = document.getElementById('btn-action-fix');
    const btnPass = document.getElementById('btn-action-pass');
    const celebration = document.getElementById('complete-celebration');

    if (audit.verdict === 'FIX') {
      fixBox.classList.remove('hidden');
      document.getElementById('verdict-fix-text').textContent = audit.fixInstructions || 'Vui lòng kiểm tra lỗi code và thử lại.';
      btnFix.classList.remove('hidden');
      btnPass.classList.add('hidden');
      celebration.classList.add('hidden');
      showToast('Review Gate yêu cầu FIX lỗi!', 'error');
    } else if (audit.verdict === 'PASS') {
      fixBox.classList.add('hidden');
      btnFix.classList.add('hidden');
      btnPass.classList.remove('hidden');
      celebration.classList.add('hidden');
      showToast('Review Gate thông qua: PASS!', 'success');
    } else if (audit.verdict === 'COMPLETE') {
      fixBox.classList.add('hidden');
      btnFix.classList.add('hidden');
      btnPass.classList.add('hidden');
      celebration.classList.remove('hidden');
      showToast('Review Gate nghiệm thu: COMPLETE! Dự án hoàn tất!', 'success');
    }

    stage4.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Action FIX: Loop back to Worker
  safeOn('btn-action-fix', 'click', () => {
    if (!workflowState.workOrder || !workflowState.auditResult) return;
    const fixNotes = workflowState.auditResult.fixInstructions || 'Resolve all failing tests and verify implementation';
    const basePrompt = workflowState.workOrder.workerPrompt || workflowState.workOrder.objective || 'Implement the requested feature and verify with unit tests';
    workflowState.workOrder.workerPrompt = `FIX INSTRUCTIONS FROM ORCHESTRATOR REVIEW:\n${fixNotes}\n\nORIGINAL SPEC:\n${basePrompt}`;
    showToast('Đã nạp chỉ dẫn sửa lỗi vào Worker. Đang khởi động lại...');
    document.getElementById('btn-dispatch-workorder-to-worker').click();
  });

  // Action PASS: Next WorkOrder
  safeOn('btn-action-pass', 'click', () => {
    if (workflowState.auditResult && workflowState.auditResult.nextWorkOrder) {
      workflowState.workOrder = workflowState.auditResult.nextWorkOrder;
      const wo = workflowState.workOrder;
      document.getElementById('wo-id').textContent = wo.workOrderId || 'WO-NEXT';
      document.getElementById('wo-title').textContent = wo.title || 'Next WorkOrder';
      document.getElementById('wo-objective').textContent = wo.objective || '-';
      document.getElementById('wo-criteria').innerHTML = (wo.acceptanceCriteria || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');
      document.getElementById('wo-files').textContent = (wo.filesScope || []).join(', ');
      document.getElementById('wo-test-cmd').textContent = wo.testCommand || 'node test.js';
      showToast(`Đã nạp ${wo.workOrderId}! Đang giao cho Worker...`);
      document.getElementById('btn-dispatch-workorder-to-worker').click();
    } else {
      showToast('Không có WorkOrder tiếp theo. Đánh dấu hoàn tất.', 'info');
    }
  });

  // -------------------------------------------------------------
  // Observer & Orchestrator Event Listeners
  // -------------------------------------------------------------
  const globalAgySelect = document.getElementById('global-antigravity-session-select');
  if (globalAgySelect) {
    globalAgySelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'new') {
        handleNewSessionSelected();
      } else {
        onAgySessionChanged(val, true);
      }
    });
  }

  const btnOpenFolder = document.getElementById('btn-open-session-folder');
  if (btnOpenFolder) {
    btnOpenFolder.addEventListener('click', async () => {
      const sess = (state.conversations || []).find(c => c.id === state.selectedAgySession);
      const targetPath = sess?.projectPath || state.selectedProjectPath;
      if (!targetPath) {
        showToast('Chưa xác định được đường dẫn thư mục dự án cho phiên này.', 'info');
        return;
      }
      const res = await apiPost('/api/projects/open-folder', { folderPath: targetPath });
      if (res && res.success) {
        showToast(`📂 Đã mở thư mục: ${targetPath}`, 'success');
      } else {
        showToast('Không thể mở thư mục: ' + (res?.error || ''), 'error');
      }
    });
  }

  document.querySelectorAll('input[name="report-mode"]').forEach(r => {
    r.addEventListener('change', (e) => {
      const manualBox = document.getElementById('manual-report-box');
      if (manualBox) {
        manualBox.classList.toggle('hidden', e.target.value !== 'manual');
      }
    });
  });

  const btnClosePreview = document.getElementById('btn-close-file-preview');
  if (btnClosePreview) {
    btnClosePreview.addEventListener('click', () => {
      document.getElementById('tech-file-preview-box').classList.add('hidden');
    });
  }

  const btnRefreshExchange = document.getElementById('btn-refresh-exchange');
  if (btnRefreshExchange) {
    btnRefreshExchange.addEventListener('click', async () => {
      if (state.selectedProject) {
        await loadExchangeStream(state.selectedProject);
        showToast('Đã làm mới khung trao đổi!');
      }
    });
  }

  async function handleClearExchange() {
    const projectId = state.selectedProject;
    if (projectId) {
      await apiDelete(`/api/orchestrator/exchange-stream/${projectId}`);
    }
    const container = document.getElementById('exchange-stream-container');
    const emptyState = document.getElementById('stream-empty-state');
    if (container) {
      container.querySelectorAll('.chat-bubble-row, .chat-turn-divider, .exchange-turn').forEach(el => el.remove());
    }
    if (emptyState) emptyState.classList.remove('hidden');
    state.activeExchangeHistory = [];
    state.lastDirectivePrompt = null;
    const btnDisp = document.getElementById('btn-dispatch-prompt-to-agy');
    if (btnDisp) btnDisp.disabled = true;
    const statusText = document.getElementById('chat-status-text');
    if (statusText) statusText.textContent = 'Đã xóa nội dung chat trên giao diện. Sẵn sàng cho phiên mới.';
    showToast('Đã xóa nội dung chat trên giao diện (lịch sử file gốc Antigravity vẫn được giữ nguyên)!');
  }

  const btnClearChatStream = document.getElementById('btn-clear-chat-stream');
  if (btnClearChatStream) {
    btnClearChatStream.addEventListener('click', handleClearExchange);
  }

  async function startObservingAntigravity(dispatchedDirective = '', initialBaselineSteps = null) {
    const projectId = state.selectedProject;
    const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession || 'auto';
    if (!projectId) {
      showToast('Vui lòng chọn một dự án trước!', 'error');
      return;
    }

    if (state.observerInterval) clearInterval(state.observerInterval);
    state.isObserving = true;

    const statusText = document.getElementById('chat-status-text');
    const loopStatus = document.getElementById('disp-loop-status');
    const verifyBanner = document.getElementById('dispatch-verify-banner');
    const verifyMsg = document.getElementById('verify-banner-msg');

    if (dispatchedDirective) {
      state.lastDispatchedPrompt = dispatchedDirective;
    }

    let baselineStepCount = initialBaselineSteps;
    if (baselineStepCount === null || baselineStepCount === undefined) {
      if (state.lastKnownStepCount !== null && state.lastKnownStepCount !== undefined && state.lastKnownStepCount > 0) {
        baselineStepCount = state.lastKnownStepCount;
      } else {
        // Probe current steps from server so we never false-positive on old steps
        const probe = await apiGet(`/api/antigravity/session-state/${agySessionId}?projectId=${projectId}`);
        baselineStepCount = probe?.totalSteps || 0;
        state.lastKnownStepCount = baselineStepCount;
        if (probe?.sessionId) {
          state.selectedAgySession = probe.sessionId;
        }
      }
    } else {
      state.lastKnownStepCount = baselineStepCount;
    }

    let pollTicks = 0;
    let retryAttempts = 0;
    const maxTicksBeforeRetry = 8; // ~20 seconds

    if (statusText) statusText.textContent = '🟢 Vòng lặp tự động: Đã nạp chỉ đạo vào Antigravity IDE. Đang quan sát Agent làm việc...';
    if (loopStatus) {
      loopStatus.textContent = 'Đang Quan Sát IDE';
      loopStatus.className = 'status-badge badge-cyan';
    }

    state.observerInterval = setInterval(async () => {
      if (!state.isObserving) return;
      try {
        const s = await apiGet(`/api/antigravity/session-state/${agySessionId}?since=${baselineStepCount}&projectId=${projectId}`);
        if (!s || !s.success) return;

        pollTicks++;

        // 1. Check if agent has started working
        const hasStarted = s.totalSteps > baselineStepCount || s.isWorking;

        if (hasStarted) {
          // Ingestion verified! Hide alert banner
          if (verifyBanner) verifyBanner.classList.add('hidden');

          if (s.isWorking) {
            if (statusText) statusText.textContent = `🔨 Antigravity Agent đang thi công sửa code trên IDE... (Bước ${s.totalSteps})`;
            if (loopStatus) {
              loopStatus.textContent = 'Agent Đang Sửa Code';
              loopStatus.className = 'status-badge badge-amber pulse-glow';
            }
          } else if (s.isFinished && s.totalSteps > baselineStepCount) {
            // Antigravity has completed its turn on IDE!
            clearInterval(state.observerInterval);
            state.isObserving = false;
            state.lastKnownStepCount = s.totalSteps;

            if (statusText) statusText.textContent = '✅ Antigravity đã hoàn thành trên IDE! Đang gửi báo cáo sang ChatGPT Web audit...';
            if (loopStatus) {
              loopStatus.textContent = 'Thẩm Định Báo Cáo';
              loopStatus.className = 'status-badge badge-cyan';
            }
            showToast('✅ Antigravity đã sửa code xong! Tự động gửi báo cáo sang ChatGPT Web audit...', 'success');

            // Optimistic UI: Immediately render Gemini Report Bubble
            const container = document.getElementById('exchange-stream-container');
            const emptyState = document.getElementById('stream-empty-state');
            if (emptyState) emptyState.classList.add('hidden');

            const reportText = s.report || 'Antigravity Worker báo cáo hoàn thành nhiệm vụ theo yêu cầu.';
            const timeStr = new Date().toLocaleTimeString();

            if (container) {
              const rowAgent = document.createElement('div');
              rowAgent.className = 'chat-bubble-row row-agent exchange-turn';
              rowAgent.innerHTML = `
                <div class="chat-bubble bubble-agent">
                  <div class="bubble-header">
                    <div class="bubble-sender-group">
                      <span class="bubble-avatar avatar-agent">⚡</span>
                      <span class="bubble-name">Antigravity Agent</span>
                      <span class="bubble-role role-worker">Worker</span>
                    </div>
                    <span class="bubble-time">${timeStr}</span>
                  </div>
                  <div class="bubble-body">
                    <div class="chat-markdown-content">
                      ${formatChatMarkdown(reportText)}
                    </div>
                  </div>
                </div>
              `;
              container.appendChild(rowAgent);

              // Optimistic UI: Immediately render ChatGPT Thinking Bubble
              const thinkingRow = document.createElement('div');
              thinkingRow.className = 'chat-bubble-row row-chatgpt exchange-turn';
              thinkingRow.id = 'chatgpt-active-thinking-bubble';
              thinkingRow.innerHTML = `
                <div class="chat-bubble bubble-chatgpt bubble-thinking">
                  <div class="bubble-header">
                    <div class="bubble-header-left">
                      <span class="bubble-time">Đang audit...</span>
                    </div>
                    <div class="bubble-sender-group">
                      <span class="bubble-role role-architect">Architect</span>
                      <span class="bubble-name">ChatGPT Web</span>
                      <span class="bubble-avatar avatar-chatgpt">🧠</span>
                    </div>
                  </div>
                  <div class="bubble-body">
                    <div style="display:flex; align-items:center; gap:0.5rem; color:#c084fc; font-size:0.82rem; padding: 0.3rem 0;">
                      <div class="thinking-dots"><span></span><span></span><span></span></div>
                      <span>Đang thẩm định Báo Cáo Cuối & Handoff từ Worker để ra chỉ đạo tiếp theo...</span>
                    </div>
                  </div>
                </div>
              `;
              container.appendChild(thinkingRow);
              container.scrollTop = container.scrollHeight;
            }

            // Automatically trigger audit with latest worker report after 1.2s
            setTimeout(async () => {
              await triggerAuditAndDirect('');
            }, 1200);
          }
        } else {
          // Agent has not registered new steps yet (totalSteps <= baseline and not working)
          // NEVER blindly auto-dispatch duplicates to avoid phantom multi-turns in Antigravity.
          if (pollTicks >= maxTicksBeforeRetry) {
            if (verifyBanner) {
              verifyBanner.classList.remove('hidden');
              if (verifyMsg) verifyMsg.textContent = `⏳ Đang đợi Agent trên IDE xử lý... (Bước hiện tại: ${s.totalSteps}). Nếu IDE chưa nhận, hãy bấm [Thử Nạp Lại].`;
            }
            if (statusText) statusText.textContent = '⏳ Đang đợi Agent xử lý trên IDE... Bấm [Thử Nạp Lại] nếu cần.';
          }
        }
      } catch (err) {}
    }, 2500);
  }

  function stopObservingAntigravity() {
    if (state.observerInterval) clearInterval(state.observerInterval);
    state.isObserving = false;
    const statusText = document.getElementById('chat-status-text');
    if (statusText) statusText.textContent = 'Đã dừng quan sát Antigravity IDE.';
    const verifyBanner = document.getElementById('dispatch-verify-banner');
    if (verifyBanner) verifyBanner.classList.add('hidden');
  }

  function startClosedLoop() {
    state.isClosedLoopRunning = true;
    const txtBtn = document.getElementById('txt-loop-btn');
    const btnStop = document.getElementById('btn-stop-loop');
    const loopStatus = document.getElementById('disp-loop-status');
    if (txtBtn) txtBtn.textContent = '⚡ Vòng Lặp Đang Chạy...';
    if (btnStop) btnStop.classList.remove('hidden');
    if (loopStatus) {
      loopStatus.textContent = 'Vòng Lặp Hoạt Động';
      loopStatus.className = 'status-badge badge-emerald pulse-glow';
    }
    showToast('🚀 Đã kích hoạt Vòng Lặp Tự Động Khép Kín (Closed-Loop)!', 'success');
    triggerAuditAndDirect('');
  }

  function stopClosedLoop() {
    state.isClosedLoopRunning = false;
    stopObservingAntigravity();
    const txtBtn = document.getElementById('txt-loop-btn');
    const btnStop = document.getElementById('btn-stop-loop');
    const loopStatus = document.getElementById('disp-loop-status');
    if (txtBtn) txtBtn.textContent = '⚡ Bắt Đầu Vòng Lặp Tự Động';
    if (btnStop) btnStop.classList.add('hidden');
    if (loopStatus) {
      loopStatus.textContent = '';
      loopStatus.classList.add('hidden');
    }
  }

  // Fast Action: Bắn Báo Cáo Cuối (Worker Report & Handoff) sang ChatGPT Web
  async function triggerAuditAndDirect(userPromptText = '') {
    const projectId = state.selectedProject;
    if (!projectId) {
      showToast('Vui lòng chọn một dự án trước!', 'error');
      return;
    }

    state.isClosedLoopRunning = true;
    const txtBtn = document.getElementById('txt-loop-btn');
    const btnStop = document.getElementById('btn-stop-loop');
    const loopStatus = document.getElementById('disp-loop-status');
    if (txtBtn) txtBtn.textContent = '⚡ Vòng Lặp Đang Chạy...';
    if (btnStop) btnStop.classList.remove('hidden');
    if (loopStatus) {
      loopStatus.textContent = 'Vòng Lặp Hoạt Động';
      loopStatus.className = 'status-badge badge-emerald pulse-glow';
    }

    const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession || 'auto';
    const chatgptModel = document.getElementById('select-model-chatgpt')?.value || 'chatgpt-web/high';
    const statusText = document.getElementById('chat-status-text');
    const btnSend = document.getElementById('btn-chat-send');
    const btnQuick = document.getElementById('btn-quick-fire-report');

    if (btnSend) btnSend.disabled = true;
    if (btnQuick) btnQuick.disabled = true;
    if (statusText) statusText.textContent = '🧠 ChatGPT Web đang thẩm định Báo Cáo Cuối & Handoff...';

    showToast('Đang gửi Báo Cáo Cuối sang ChatGPT Web audit...', 'info');

    try {
      const res = await apiPost('/api/orchestrator/audit-and-direct', {
        projectId,
        antigravitySessionId: agySessionId,
        userPrompt: userPromptText,
        model: chatgptModel,
        mode: 'auto'
      });

      // Remove active thinking bubble before rendering or reloading
      const thinkEl = document.getElementById('chatgpt-active-thinking-bubble');
      if (thinkEl) thinkEl.remove();

      if (res && res.error) {
        showToast(`Lỗi thẩm định: ${res.error}`, 'error');
        if (statusText) statusText.textContent = `Lỗi: ${res.error}`;
        stopClosedLoop();
      } else {
        showToast('ChatGPT Web đã thẩm định xong và đưa ra chỉ đạo tiếp theo!', 'success');
        await loadExchangeStream(projectId);

        const directive = res.item?.chatgptMessage?.directivePrompt || res.item?.chatgptAudit?.nextDirectivePrompt;
        const verdict = res.item?.chatgptMessage?.verdict || res.item?.chatgptAudit?.verdict;

        // Check if ChatGPT Web requests to stop
        const isStopCondition = verdict === 'ROADMAP_COMPLETE' ||
          (directive && (directive.toLowerCase().includes('dừng vòng lặp') || directive.toLowerCase().includes('hoàn thành toàn bộ') || directive.toLowerCase().includes('roadmap_complete')));

        if (isStopCondition) {
          showToast('🎉 ChatGPT Web xác nhận hoàn tất toàn bộ yêu cầu! Vòng lặp dừng.', 'success');
          if (statusText) statusText.textContent = '🎉 ChatGPT Web đã xác nhận hoàn thành toàn bộ roadmap! Vòng lặp tự động kết thúc.';
          stopClosedLoop();
          return;
        }

        if (directive) {
          state.lastDispatchedPrompt = directive;
          navigator.clipboard.writeText(directive);

          const target = res.item?.dispatchTarget || 'Antigravity IDE';
          showToast(`🚀 Đã tự động đẩy chỉ đạo vào ${target}!`, 'success');
          if (statusText) statusText.textContent = `🚀 Đã nạp chỉ đạo vào ${target}. Đang xác thực Agent bắt đầu thi công...`;

          if (res.targetSessionId) {
            state.selectedAgySession = res.targetSessionId;
            const agySel = document.getElementById('global-antigravity-session-select');
            if (agySel) agySel.value = res.targetSessionId;
          }

          // Keep loop running by observing Antigravity with watchdog
          startObservingAntigravity(directive, res.baselineStepCount);
        }
      }
    } catch (err) {
      const thinkEl = document.getElementById('chatgpt-active-thinking-bubble');
      if (thinkEl) thinkEl.remove();
      showToast(`Lỗi kết nối: ${err.message}`, 'error');
      if (statusText) statusText.textContent = 'Lỗi kết nối tới máy chủ.';
      stopClosedLoop();
    } finally {
      if (btnSend) btnSend.disabled = false;
      if (btnQuick) btnQuick.disabled = false;
    }
  }

  // Quick Action Button: Bắt đầu / Chạy Vòng Lặp Tự Động
  const btnQuickFire = document.getElementById('btn-quick-fire-report');
  if (btnQuickFire) {
    btnQuickFire.addEventListener('click', () => {
      if (state.isClosedLoopRunning) {
        stopClosedLoop();
        showToast('🛑 Đã dừng vòng lặp tự động.', 'info');
      } else {
        startClosedLoop();
      }
    });
  }

  // Quick Action Button: Dừng Vòng Lặp Tự Động
  const btnStopLoop = document.getElementById('btn-stop-loop');
  if (btnStopLoop) {
    btnStopLoop.addEventListener('click', () => {
      stopClosedLoop();
      showToast('🛑 Đã dừng vòng lặp tự động.', 'info');
    });
  }

  // Watchdog Action Buttons: Thử nạp lại, Copy prompt, Dismiss
  const btnVerifyRetry = document.getElementById('btn-verify-retry');
  if (btnVerifyRetry) {
    btnVerifyRetry.addEventListener('click', async () => {
      const projectId = state.selectedProject;
      const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession || 'auto';
      if (!state.lastDispatchedPrompt) return;
      showToast('🔄 Đang gửi lại prompt vào Antigravity IDE...', 'info');
      await apiPost('/api/antigravity/dispatch', {
        sessionId: agySessionId,
        prompt: state.lastDispatchedPrompt,
        projectId
      });
      showToast('⚡ Đã gửi lại prompt!', 'success');
      startObservingAntigravity(state.lastDispatchedPrompt);
    });
  }

  const btnVerifyCopy = document.getElementById('btn-verify-copy');
  if (btnVerifyCopy) {
    btnVerifyCopy.addEventListener('click', () => {
      if (state.lastDispatchedPrompt) {
        navigator.clipboard.writeText(state.lastDispatchedPrompt);
        showToast('📋 Đã copy prompt vào clipboard!', 'success');
      }
    });
  }

  const btnVerifyDismiss = document.getElementById('btn-verify-dismiss');
  if (btnVerifyDismiss) {
    btnVerifyDismiss.addEventListener('click', () => {
      const b = document.getElementById('dispatch-verify-banner');
      if (b) b.classList.add('hidden');
    });
  }

  // Quick Action Button: Xem trước Báo Cáo Cuối & Handoff
  const btnQuickPreview = document.getElementById('btn-quick-preview-report');
  if (btnQuickPreview) {
    btnQuickPreview.addEventListener('click', async () => {
      const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession;
      if (!agySessionId || agySessionId === 'new') {
        showToast('Vui lòng chọn một phiên làm việc có dữ liệu trước.', 'info');
        return;
      }
      openReportPreviewModal(agySessionId);
    });
  }

  // Report Modal Close & Copy Event Handlers
  const btnCloseRep = document.getElementById('btn-close-report-modal');
  const btnDismissRep = document.getElementById('btn-dismiss-report-modal');
  const modalRep = document.getElementById('report-preview-modal');
  const btnCopyRep = document.getElementById('btn-copy-report-text');

  const closeModalRep = () => {
    if (modalRep) {
      modalRep.classList.remove('active');
      modalRep.classList.add('hidden');
    }
  };
  if (btnCloseRep) btnCloseRep.addEventListener('click', closeModalRep);
  if (btnDismissRep) btnDismissRep.addEventListener('click', closeModalRep);
  if (modalRep) {
    modalRep.addEventListener('click', (e) => {
      if (e.target === modalRep) closeModalRep();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalRep && modalRep.classList.contains('active')) {
      closeModalRep();
    }
  });
  if (btnCopyRep) {
    btnCopyRep.addEventListener('click', () => {
      if (state.currentPreviewReportText) {
        navigator.clipboard.writeText(state.currentPreviewReportText);
        showToast('📋 Đã copy toàn bộ nội dung báo cáo vào clipboard!', 'success');
      }
    });
  }

  // Toggle Live Observer button
  const btnToggleObs = document.getElementById('btn-toggle-observe');
  if (btnToggleObs) {
    btnToggleObs.addEventListener('click', () => {
      if (state.isObserving) {
        stopObservingAntigravity();
      } else {
        startObservingAntigravity();
        showToast('👀 Đã kích hoạt chế độ tự động quan sát IDE!', 'info');
      }
    });
  }

  // Chat Textarea & Send Button
  const chatTextarea = document.getElementById('chat-input-textarea');
  const btnChatSend = document.getElementById('btn-chat-send');

  async function handleSendChatMessage() {
    const text = chatTextarea ? chatTextarea.value.trim() : '';
    if (!text) return;
    if (chatTextarea) chatTextarea.value = '';

    const projectId = state.selectedProject;
    if (!projectId) {
      showToast('Vui lòng chọn một dự án trước!', 'error');
      return;
    }

    const container = document.getElementById('exchange-stream-container');
    const emptyState = document.getElementById('stream-empty-state');
    if (emptyState) emptyState.classList.add('hidden');

    const timeStr = new Date().toLocaleTimeString();

    // 1. Optimistic UI: Immediately render User Message Bubble
    const userRow = document.createElement('div');
    userRow.className = 'chat-bubble-row row-user exchange-turn';
    userRow.innerHTML = `
      <div class="chat-bubble bubble-user">
        <div class="bubble-header">
          <div class="bubble-sender-group">
            <span class="bubble-avatar avatar-user">👤</span>
            <span class="bubble-name">Chỉ Đạo Từ User</span>
            <span class="bubble-role role-user">User Direct</span>
          </div>
          <span class="bubble-time">${timeStr}</span>
        </div>
        <div class="bubble-body">
          <div class="chat-markdown-content">${formatChatMarkdown(text)}</div>
        </div>
      </div>
    `;
    if (container) {
      container.appendChild(userRow);
    }

    // 2. Optimistic UI: Immediately render ChatGPT Thinking Bubble
    const thinkingRow = document.createElement('div');
    thinkingRow.className = 'chat-bubble-row row-chatgpt exchange-turn';
    thinkingRow.id = 'chatgpt-active-thinking-bubble';
    thinkingRow.innerHTML = `
      <div class="chat-bubble bubble-chatgpt bubble-thinking">
        <div class="bubble-header">
          <div class="bubble-header-left">
            <span class="bubble-time">Đang xử lý...</span>
          </div>
          <div class="bubble-sender-group">
            <span class="bubble-role role-architect">Architect</span>
            <span class="bubble-name">ChatGPT Web</span>
            <span class="bubble-avatar avatar-chatgpt">🧠</span>
          </div>
        </div>
        <div class="bubble-body">
          <div style="display:flex; align-items:center; gap:0.5rem; color:#c084fc; font-size:0.82rem; padding: 0.3rem 0;">
            <div class="thinking-dots"><span></span><span></span><span></span></div>
            <span>Đang đọc cấu trúc dự án & file kỹ thuật local trên đĩa, suy luận chỉ đạo cho Antigravity...</span>
          </div>
        </div>
      </div>
    `;
    if (container) {
      container.appendChild(thinkingRow);
      container.scrollTop = container.scrollHeight;
    }

    const agySessionId = document.getElementById('global-antigravity-session-select')?.value || state.selectedAgySession || 'auto';
    const chatgptModel = document.getElementById('select-codex-imported-models')?.value || document.getElementById('select-model-chatgpt')?.value || 'chatgpt-web/high';
    const statusText = document.getElementById('chat-status-text');
    const btnSend = document.getElementById('btn-chat-send');
    if (btnSend) btnSend.disabled = true;
    if (statusText) statusText.textContent = '🧠 ChatGPT Web đang thẩm định file local & lên kế hoạch chỉ đạo...';

    // If starting from a new session, launch dynamic name synchronizer
    const isNew = agySessionId === 'new' || state.selectedAgySession === 'new';
    if (isNew) {
      startSessionNameSyncPoller();
    }

    try {
      const res = await apiPost('/api/orchestrator/user-directive', {
        projectId,
        antigravitySessionId: agySessionId,
        userPrompt: text,
        model: chatgptModel
      });

      // Remove thinking bubble
      const thinkEl = document.getElementById('chatgpt-active-thinking-bubble');
      if (thinkEl) thinkEl.remove();

      if (res && res.error) {
        showToast(`Lỗi ChatGPT: ${res.error}`, 'error');
        if (statusText) statusText.textContent = `Lỗi: ${res.error}`;
      } else {
        showToast('✓ ChatGPT Web đã chỉ đạo và nạp lệnh vào Antigravity IDE!', 'success');
        
        // Append ChatGPT response bubble
        const item = res.item || {};
        const gptMsg = item.chatgptMessage || {};
        const gptContent = gptMsg.content || '';
        const directivePrompt = gptMsg.directivePrompt || '';
        const verdict = gptMsg.verdict || 'CONTINUE_PHASE';

        let verdictClass = 'verdict-badge-blue';
        let verdictLabel = 'Đã Chỉ Đạo';
        if (verdict === 'ROADMAP_COMPLETE') {
          verdictClass = 'verdict-badge-green';
          verdictLabel = '🎉 Hoàn Thành';
        } else if (verdict === 'NEXT_PHASE') {
          verdictClass = 'verdict-badge-green';
          verdictLabel = '✅ Chuyển Phase';
        } else if (verdict === 'FIX') {
          verdictClass = 'verdict-badge-red';
          verdictLabel = '⚠️ Sửa Lỗi';
        }

        const gptRow = document.createElement('div');
        gptRow.className = 'chat-bubble-row row-chatgpt exchange-turn';
        gptRow.innerHTML = `
          <div class="chat-bubble bubble-chatgpt">
            <div class="bubble-header">
              <div class="bubble-header-left">
                <span class="verdict-pill ${verdictClass}">${escapeHtml(verdictLabel)}</span>
                <span class="bubble-time">${new Date().toLocaleTimeString()}</span>
              </div>
              <div class="bubble-sender-group">
                <span class="bubble-role role-architect">Auditor</span>
                <span class="bubble-name">ChatGPT Web</span>
                <span class="bubble-avatar avatar-chatgpt">🧠</span>
              </div>
            </div>
            <div class="bubble-body">
              <div class="chat-markdown-content">
                ${formatChatMarkdown(gptContent)}
              </div>
              ${directivePrompt ? `
                <div class="bubble-directive-box">
                  <div class="directive-box-header">
                    <div class="directive-box-title">
                      <span class="directive-icon">🎯</span>
                      <strong>Chỉ Đạo Tiếp Theo:</strong>
                    </div>
                    <div class="directive-box-actions">
                      <button class="btn btn-secondary btn-xs btn-copy-dir" title="Sao chép prompt">📋 Copy</button>
                      <button class="btn btn-success btn-xs btn-dispatch-dir" title="Nạp trực tiếp vào khung chat Antigravity IDE">⚡ Nạp Vào IDE</button>
                    </div>
                  </div>
                  <pre class="directive-content-code">${escapeHtml(directivePrompt)}</pre>
                </div>` : ''}
            </div>
          </div>
        `;

        // Wire buttons inside gptRow
        const copyBtn = gptRow.querySelector('.btn-copy-dir');
        if (copyBtn) {
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(directivePrompt);
            showToast('Đã sao chép prompt chỉ đạo!');
          });
        }
        const dispatchBtn = gptRow.querySelector('.btn-dispatch-dir');
        if (dispatchBtn) {
          dispatchBtn.addEventListener('click', async () => {
            await apiPost('/api/antigravity/dispatch', {
              sessionId: state.selectedAgySession || 'auto',
              prompt: directivePrompt,
              projectId: state.selectedProject
            });
            showToast('⚡ Đã nạp lại chỉ đạo vào IDE!', 'success');
            startObservingAntigravity(directivePrompt);
          });
        }

        if (container) {
          container.appendChild(gptRow);
          container.scrollTop = container.scrollHeight;
        }

        if (res.targetSessionId && state.selectedAgySession === 'new') {
          state.selectedAgySession = res.targetSessionId;
        }

        if (directivePrompt) {
          state.lastDispatchedPrompt = directivePrompt;
          startObservingAntigravity(directivePrompt, res.baselineStepCount);
        }
        pollAgentLiveSteps();
      }
    } catch (err) {
      const thinkEl = document.getElementById('chatgpt-active-thinking-bubble');
      if (thinkEl) thinkEl.remove();
      showToast(`Lỗi kết nối: ${err.message}`, 'error');
    } finally {
      if (btnSend) btnSend.disabled = false;
    }
  }

  if (btnChatSend) {
    btnChatSend.addEventListener('click', handleSendChatMessage);
  }

  if (chatTextarea) {
    chatTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendChatMessage();
      }
    });
  }

  // -------------------------------------------------------------
  // Settings Tab & ChatGPT / Codex Configuration
  // -------------------------------------------------------------
  async function loadChatGPTConfigAndCodexModels() {
    const badgeStatus = document.getElementById('badge-chatgpt-status');
    const cfgAccount = document.getElementById('cfg-account-status');
    const cfgRoute = document.getElementById('cfg-route-status');
    const cfgProxy = document.getElementById('cfg-proxy-status');
    const cfgVerify = document.getElementById('cfg-verify-status');
    const modelSelect = document.getElementById('select-codex-imported-models');
    const badgeModelStatus = document.getElementById('badge-codex-model-status');
    const doctorOutput = document.getElementById('doctor-output');

    const data = await apiGet('/api/chatgpt/status');
    if (!data) return;

    if (badgeStatus) {
      if (data.verified) {
        badgeStatus.className = 'badge badge-emerald';
        badgeStatus.textContent = '🟢 ĐÃ KẾT NỐI & VERIFIED';
      } else if (data.authenticated) {
        badgeStatus.className = 'badge badge-cyan';
        badgeStatus.textContent = '🟡 ĐÃ ĐĂNG NHẬP (Chờ Verify)';
      } else {
        badgeStatus.className = 'badge';
        badgeStatus.textContent = '⚪ Chưa Đăng Nhập';
      }
    }

    if (cfgAccount) cfgAccount.textContent = data.accountType || (data.authenticated ? 'Đang Đăng Nhập' : 'Chưa Đăng Nhập');
    if (cfgRoute) cfgRoute.textContent = data.codexRouteInstalled ? 'Đã Kết Nối (127.0.0.1:17841)' : 'Chưa Cài Đặt Route';
    if (cfgProxy) cfgProxy.textContent = data.status === 'ready' ? 'Online (Port 17841)' : 'Offline';
    if (cfgVerify) {
      cfgVerify.textContent = data.verified ? '✓ Xác Thực Thành Công' : 'Chưa Xác Thực';
      cfgVerify.className = data.verified ? 'meta-value text-emerald' : 'meta-value text-amber';
    }

    if (modelSelect && data.models) {
      modelSelect.innerHTML = '';
      data.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.active || m.id === 'chatgpt-web/high') opt.selected = true;
        modelSelect.appendChild(opt);
      });
    }

    if (badgeModelStatus) {
      badgeModelStatus.textContent = data.verified ? '✓ Verified (Codex Ready)' : 'Chưa Sẵn Sàng';
      badgeModelStatus.className = data.verified ? 'badge badge-cyan' : 'badge';
    }

    if (doctorOutput && data.doctorReport) {
      doctorOutput.textContent = data.doctorReport;
      const docBadge = document.getElementById('doctor-badge');
      if (docBadge) {
        const isReady = data.verified || data.doctorReport.includes('Doctor result: ready');
        docBadge.textContent = isReady ? 'Ready' : 'Issues';
        docBadge.className = isReady ? 'badge badge-emerald' : 'badge badge-rose';
      }
    }
  }

  const btnChatGptLogin = document.getElementById('btn-chatgpt-login');
  if (btnChatGptLogin) {
    btnChatGptLogin.addEventListener('click', async () => {
      showToast('Đang khởi động cửa sổ đăng nhập ChatGPT Web...', 'info');
      const res = await apiPost('/api/chatgpt/login', {});
      if (res.verified) {
        showToast('✓ Đã đăng nhập và verify Codex thành công!', 'success');
      } else {
        showToast(res.message || 'Vui lòng hoàn tất đăng nhập trên trình duyệt.', 'info');
      }
      await loadChatGPTConfigAndCodexModels();
    });
  }

  const btnChatGptLogout = document.getElementById('btn-chatgpt-logout');
  if (btnChatGptLogout) {
    btnChatGptLogout.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc muốn thoát tài khoản ChatGPT Web để đăng nhập tài khoản khác?')) return;
      const res = await apiPost('/api/chatgpt/logout', {});
      showToast(res.message || 'Đã thoát tài khoản.', 'success');
      await loadChatGPTConfigAndCodexModels();
    });
  }

  const btnSyncCodex = document.getElementById('btn-sync-codex');
  if (btnSyncCodex) {
    btnSyncCodex.addEventListener('click', async () => {
      showToast('Đang kiểm tra kết nối và verify Codex...', 'info');
      const res = await apiPost('/api/chatgpt/verify', {});
      if (res.verified) {
        showToast(`✓ Codex verify thành công (${res.durationMs}ms)! Model đã import.`, 'success');
      } else {
        showToast(`⚠️ Không thể kết nối Codex: ${res.error}`, 'error');
      }
      await loadChatGPTConfigAndCodexModels();
    });
  }

  const btnVerifyModel = document.getElementById('btn-verify-model');
  if (btnVerifyModel) {
    btnVerifyModel.addEventListener('click', async () => {
      const selModel = document.getElementById('select-codex-imported-models')?.value || 'chatgpt-web/high';
      showToast(`Đang kiểm tra model ${selModel}...`, 'info');
      const res = await apiPost('/api/models/test', { provider: 'chatgpt', model: selModel });
      if (res.success) {
        showToast(`✓ Model ${selModel} phản hồi tốt (${res.durationMs}ms)!`, 'success');
      } else {
        showToast(`⚠️ Lỗi kiểm tra model: ${res.error}`, 'error');
      }
      await loadChatGPTConfigAndCodexModels();
    });
  }

  // Initial load of ChatGPT & Codex models config
  loadChatGPTConfigAndCodexModels();

// (Initial data loads moved to top of DOMContentLoaded)
});

// Helper Escape HTML
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

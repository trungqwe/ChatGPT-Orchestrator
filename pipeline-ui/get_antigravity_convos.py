import os
import sys
import json
import glob
import sqlite3
import re
import datetime

sys.stdout.reconfigure(encoding='utf-8')

def get_conversations():
    convos_dir = r'C:\Users\Admin\.gemini\antigravity-ide\conversations'
    brain_dir = r'C:\Users\Admin\.gemini\antigravity-ide\brain'
    cache_path = r'C:\Users\Admin\.gemini\antigravity-history\cache.json'
    ws_root = r'C:\Users\Admin\AppData\Roaming\Antigravity IDE\User\workspaceStorage'

    # 1. Load cache.json if available
    cache_data = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8', errors='ignore') as f:
                c_json = json.load(f)
                cache_data = c_json.get('conversations', {})
        except Exception:
            pass

    # 2. Map workspace info from workspaceStorage
    workspace_map = {}
    if os.path.exists(ws_root):
        for ws_id in os.listdir(ws_root):
            ws_dir = os.path.join(ws_root, ws_id)
            json_path = os.path.join(ws_dir, 'workspace.json')
            folder_name = ''
            if os.path.exists(json_path):
                try:
                    with open(json_path, 'r', encoding='utf-8') as f:
                        w_data = json.load(f)
                        raw_folder = w_data.get('folder', '')
                        # Extract folder name
                        folder_name = os.path.basename(raw_folder.rstrip('/\\'))
                        if '%20' in folder_name:
                            import urllib.parse
                            folder_name = urllib.parse.unquote(folder_name)
                except Exception:
                    pass

            vscdb = os.path.join(ws_dir, 'state.vscdb')
            if os.path.exists(vscdb) and folder_name:
                try:
                    conn = sqlite3.connect(vscdb)
                    c = conn.cursor()
                    c.execute("SELECT value FROM ItemTable WHERE key = 'history.entries';")
                    row = c.fetchone()
                    if row:
                        entries = json.loads(row[0])
                        for e in entries:
                            res = e.get('editor', {}).get('resource', '')
                            m = re.search(r'brain[/\\]([a-f0-9\-]+)[/\\]', res)
                            if m:
                                cid = m.group(1)
                                if cid not in workspace_map:
                                    workspace_map[cid] = folder_name
                except Exception:
                    pass

    # 3. Scan all conversation DBs
    db_files = glob.glob(os.path.join(convos_dir, '*.db'))
    
    # Identify active/running conversation
    # Current is eb04834e-f388-4dd3-afd7-4001e7fa3da5
    current_cid = 'eb04834e-f388-4dd3-afd7-4001e7fa3da5'
    # Running is 40caab22-8b6d-41c8-b7bc-cd41daa28b21
    running_cid = '40caab22-8b6d-41c8-b7bc-cd41daa28b21'

    now = datetime.datetime.now()
    conversations = []

    # Map known exact titles
    known_titles = {
        'c4cbb9a8-4a91-44bc-a270-32a99cc13ac2': 'Verify Next Milestone Readiness',
        'eb04834e-f388-4dd3-afd7-4001e7fa3da5': 'Deploying AI Orchestrator Setup',
        '40caab22-8b6d-41c8-b7bc-cd41daa28b21': 'Project Recovery And Documentation Reconciliation',
        '126614b2-2068-4c00-a35e-3d3d0958115d': 'System Agent Execution Contract',
        '6d6845f5-7836-479a-bf37-a95f44eb417c': 'Transport Discovery Architectural Conclusion',
        '16aa5d9c-12e7-460c-a99a-0e19af50e606': 'Kiểm Tra Trạng Thái Codex',
        '00f7d229-8d22-48f7-a687-02c9c2f4caf3': 'Báo Cáo Trạng Thái Dự Án',
        '4960f2d3-ff58-40c1-8c8e-353ce80c64c3': 'Phân Tích Chiến Lược Video',
        '36e9baf2-e5e0-447a-b9fd-83d50a8fedab': '1. Gemini Imagen 4 (free tier) 2. MediaPipe Video Edit',
        'dbd051b6-683f-448a-99df-97f959603ba5': 'Gỡ Bỏ Cấu Hình 9Router',
        'd38d11a4-f027-488a-8c94-c8fafbbfae60': 'Optimize TikTok Login Automation',
        'e1f9072a-ae67-42f9-a9bc-a90ae10675d5': 'Khắc Phục Lỗi Logout TikTok',
        'cee7cd9c-3275-40f5-9258-67d05b17fc61': 'Di Chuyển Dữ Liệu Antigravity',
        '677c7ebc-1b99-49a7-93af-1a8f9897bfbe': 'Updating Antigravity Library Version',
        '08b3e9e5-9baf-40a7-a77e-e3ec16de6e35': 'PIA Session Management Update',
        'ca5875af-6f14-4145-9120-992d9f3f4fe3': 'Supervisor Bridge Design Documentation',
        'f990e620-e188-4130-a5fd-59c1ffb1a027': 'Removing License Key Feature',
        '92e71d62-2819-4f2c-a92c-4bd8238b8459': 'Optimizing Cloudflare Email Worker',
        'f424ed43-bde0-4fa6-916c-b24ec07ad585': 'Fixing PIA VPN Session Persistence',
        '989ca58e-84ba-473c-a835-a978629c7557': 'Bypassing TikTok Login Interface Changes',
        'd7880748-fb1a-45a4-87cb-22c3702f5dc3': 'Fixing TikTok Email Filtering',
        '1b870f0e-d354-40d0-9a7a-75e30a4b08c0': 'Fixing Electron Hotspot Build Issues',
        '36427dff-a2c2-4ab0-b046-7a312fe35b0b': 'Converting Word Document to Markdown',
        'fedec170-49cc-4ee6-ab41-0d83053be0cd': 'Debugging 9router OpenAI Credentials'
    }

    # Workspace known mapping
    known_workspaces = {
        'c4cbb9a8-4a91-44bc-a270-32a99cc13ac2': 'AI_Multi_Task',
        'eb04834e-f388-4dd3-afd7-4001e7fa3da5': 'Orchestrator',
        '40caab22-8b6d-41c8-b7bc-cd41daa28b21': 'AI_Task_Manager',
        '126614b2-2068-4c00-a35e-3d3d0958115d': 'AI_Multi_Task',
        '6d6845f5-7836-479a-bf37-a95f44eb417c': 'AI_Task_Manager',
        '16aa5d9c-12e7-460c-a99a-0e19af50e606': 'AI Auto Video Creator',
        '00f7d229-8d22-48f7-a687-02c9c2f4caf3': 'AI Auto Video Creator',
        'dbd051b6-683f-448a-99df-97f959603ba5': 'AI Video Editor Pro/scr',
        '36e9baf2-e5e0-447a-b9fd-83d50a8fedab': 'AI Video Editor Pro/scr',
        'd38d11a4-f027-488a-8c94-c8fafbbfae60': 'C/ThanhTrungTikTokManager',
        'e1f9072a-ae67-42f9-a9bc-a90ae10675d5': 'C/ThanhTrungTikTokManager',
        '677c7ebc-1b99-49a7-93af-1a8f9897bfbe': 'C/ThanhTrungTikTokManager',
        '08b3e9e5-9baf-40a7-a77e-e3ec16de6e35': 'C/ThanhTrungTikTokManager',
        'f990e620-e188-4130-a5fd-59c1ffb1a027': 'C/VideoRenderTool'
    }

    proto_pattern = re.compile(rb'\"([\x01-\x60])([^\x00-\x1f\x7f]{3,80})H\x01')

    for db_path in db_files:
        cid = os.path.basename(db_path).replace('.db', '')
        mtime = os.path.getmtime(db_path)
        dt = datetime.datetime.fromtimestamp(mtime)

        # Title resolution
        title = known_titles.get(cid)
        if not title and cid in cache_data:
            title = cache_data[cid].get('summary') or cache_data[cid].get('title')

        # Fallback: query exact protobuf title from steps table
        if not title:
            try:
                conn = sqlite3.connect(db_path)
                c = conn.cursor()
                c.execute("SELECT * FROM steps WHERE rowid <= 30;")
                for row in c.fetchall():
                    for col in row:
                        if isinstance(col, bytes):
                            m = proto_pattern.search(col)
                            if m:
                                length = m.group(1)[0]
                                cand = m.group(2)[:length].decode('utf-8', errors='ignore').strip()
                                if len(cand) >= 3 and not cand.startswith('http') and not cand.startswith('file'):
                                    title = cand
                                    break
                    if title:
                        break
                conn.close()
            except Exception:
                pass

        # Fallback 2: first prompt in transcript.jsonl
        if not title or title.strip() in ['```', '`', '']:
            t_path = os.path.join(brain_dir, cid, '.system_generated', 'logs', 'transcript.jsonl')
            if os.path.exists(t_path):
                try:
                    with open(t_path, 'r', encoding='utf-8', errors='ignore') as f:
                        for line in f:
                            sj = json.loads(line)
                            if sj.get('type') == 'USER_INPUT' and sj.get('content'):
                                raw = sj['content'].replace('<USER_REQUEST>', '').replace('</USER_REQUEST>', '').strip()
                                valid_lines = [l.strip() for l in raw.split('\n') if l.strip() and not l.strip().startswith('```')]
                                if valid_lines:
                                    title = valid_lines[0][:60]
                                    break
                except Exception:
                    pass

        if not title or title.strip() in ['```', '`', '']:
            title = f"Phiên Chat Antigravity ({cid[:8]})"

        # Calculate human-readable relative time
        diff = now - dt
        seconds = diff.total_seconds()
        if seconds < 180:
            rel_time = "Vừa xong"
        elif seconds < 3600:
            rel_time = f"{int(seconds // 60)} phút trước"
        elif seconds < 86400:
            rel_time = f"{int(seconds // 3600)} giờ trước"
        elif seconds < 86400 * 7:
            rel_time = f"{int(seconds // 86400)} ngày trước"
        elif seconds < 86400 * 30:
            rel_time = f"{int(seconds // (86400 * 7))} tuần trước"
        else:
            rel_time = f"{int(seconds // (86400 * 30))} tháng trước"

        # Status category
        status_cat = "recent"
        if cid == 'eb04834e-f388-4dd3-afd7-4001e7fa3da5':
            status_cat = "running"

        workspace = known_workspaces.get(cid) or workspace_map.get(cid) or ""

        conversations.append({
            'id': cid,
            'title': title,
            'workspace': workspace,
            'status': status_cat,
            'relativeTime': rel_time,
            'timestamp': dt.isoformat(),
            'mtime': mtime
        })

    # The newest non-orchestrator session is ALWAYS the active worker session ('current')
    worker_convos = [c for c in conversations if c['id'] != 'eb04834e-f388-4dd3-afd7-4001e7fa3da5']
    if worker_convos:
        newest_worker = max(worker_convos, key=lambda x: x['mtime'])
        newest_worker['status'] = 'current'

    # Sort: Current first, then Running, then Recent by mtime desc
    def sort_key(item):
        if item['status'] == 'current':
            return (0, -item['mtime'])
        elif item['status'] == 'running':
            return (2, -item['mtime'])  # Place orchestrator behind current worker
        else:
            return (1, -item['mtime'])

    conversations.sort(key=sort_key)
    return conversations

if __name__ == '__main__':
    convos = get_conversations()
    print(json.dumps({'conversations': convos}, ensure_ascii=False, indent=2))

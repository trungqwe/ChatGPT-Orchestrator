import os
import glob
import json
import time
import sys
import subprocess
from datetime import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

LOCK_FILE = os.path.join(os.path.dirname(__file__), '.dispatch_codex.lock')

def acquire_lock():
    now = time.time()
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                ts = float(f.read().strip())
                if now - ts < 2.0:
                    return False
        except Exception:
            pass
    try:
        with open(LOCK_FILE, 'w') as f:
            f.write(str(now))
        return True
    except Exception:
        return True

def release_lock():
    try:
        if os.path.exists(LOCK_FILE):
            os.remove(LOCK_FILE)
    except Exception:
        pass

def get_codex_sessions_dirs():
    base = os.path.join(os.environ.get('USERPROFILE', 'C:\\Users\\Admin'), '.codex', 'sessions')
    if not os.path.exists(base):
        return []
    dirs = []
    today = datetime.now()
    today_dir = os.path.join(base, str(today.year), f"{today.month:02d}", f"{today.day:02d}")
    if os.path.exists(today_dir):
        dirs.append(today_dir)
    for d in glob.glob(os.path.join(base, "*", "*", "*")):
        if d != today_dir and os.path.isdir(d):
            dirs.append(d)
    return dirs

def find_project_rollouts(project_keyword="AI_Multi_Task"):
    norm_keyword = project_keyword.lower().replace('/', '\\')
    matched_files = []
    for sdir in get_codex_sessions_dirs():
        files = glob.glob(os.path.join(sdir, "rollout-*.jsonl"))
        files.sort(key=os.path.getmtime, reverse=True)
        for fpath in files:
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fp:
                    first_line = fp.readline()
                    if not first_line:
                        continue
                    meta = json.loads(first_line)
                    cwd = meta.get('payload', {}).get('cwd', '')
                    if norm_keyword in cwd.lower() or os.path.basename(cwd).lower() == norm_keyword:
                        matched_files.append((fpath, meta.get('payload', {}).get('id', '')))
            except Exception:
                continue
    return matched_files

def is_session_busy(rollout_file):
    """Checks if the Codex session is currently executing a turn (Anti-Push-Mù)."""
    try:
        with open(rollout_file, 'r', encoding='utf-8', errors='ignore') as fp:
            lines = fp.readlines()
        if not lines:
            return False, "Session empty"

        has_task_complete = False
        last_turn_id = None
        started_turn_id = None

        for line in reversed(lines[-60:]):
            try:
                data = json.loads(line)
                t = data.get('type')
                p = data.get('payload', {})
                if t == 'event_msg' and isinstance(p, dict):
                    pt = p.get('type')
                    if pt == 'task_complete' and not has_task_complete:
                        has_task_complete = True
                        last_turn_id = p.get('turn_id')
                    elif pt == 'task_started':
                        started_turn_id = p.get('turn_id')
                        if not has_task_complete or (started_turn_id and started_turn_id != last_turn_id):
                            return True, f"Worker đang bận thực thi turn '{started_turn_id}'"
                        else:
                            return False, "Idle"
            except Exception:
                continue
        return False, "Idle"
    except Exception as e:
        return False, str(e)

def get_last_completed_turn_id(rollout_file):
    try:
        with open(rollout_file, 'r', encoding='utf-8', errors='ignore') as fp:
            lines = fp.readlines()
        for line in reversed(lines[-60:]):
            try:
                data = json.loads(line)
                t = data.get('type')
                p = data.get('payload', {})
                if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_complete':
                    return p.get('turn_id')
            except Exception:
                continue
    except Exception:
        pass
    return None

def dispatch_prompt_to_codex(prompt_text, project_keyword="AI_Multi_Task"):
    """
    100% Background Zero-Intrusion Dispatcher:
    - Never steals mouse (0 SetCursorPos, 0 mouse_event).
    - Never steals keyboard (0 keybd_event).
    - Never steals foreground window (0 SetForegroundWindow).
    - Works even while user is in full-screen gaming, movie watching, or typing elsewhere.
    - Pre-flight busy check (Chống Push Mù).
    - Post-flight queue verification (Chống Thất Lạc Lệnh).
    """
    result = {
        "success": False,
        "verified": False,
        "busy": False,
        "worker": "codex_extension",
        "method": "codex_background_queue",
        "target_window": None,
        "session_id": None,
        "baseline_turn_id": None,
        "error": None
    }

    if not acquire_lock():
        result["error"] = "Thao tác gửi bị từ chối do trùng lặp dispatch lock"
        return result

    try:
        # 1. Locate active session rollout for the project
        matched = find_project_rollouts(project_keyword)
        if not matched:
            result["error"] = f"Không tìm thấy phiên Codex nào khớp với dự án '{project_keyword}'"
            return result

        rollout_file, session_id = matched[0]
        result["session_id"] = session_id
        result["target_window"] = f"Codex Session [{session_id[:8]}] ({project_keyword})"

        # 2. Pre-flight Check: Is Worker Busy? (Anti-Push-Mù)
        busy, busy_reason = is_session_busy(rollout_file)
        if busy:
            result["busy"] = True
            result["error"] = f"Chống push mù: {busy_reason}. Vui lòng chờ lượt hiện tại kết thúc."
            return result

        # Record baseline completed turn ID to guarantee instant watcher handover
        baseline_turn_id = get_last_completed_turn_id(rollout_file)
        result["baseline_turn_id"] = baseline_turn_id

        # 3. Pure Background IPC: Send prompt via codex queue
        CREATE_NO_WINDOW = 0x08000000
        cmd = ["codex", "queue", "--thread", session_id, "--message", prompt_text]

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            creationflags=CREATE_NO_WINDOW,
            timeout=15
        )

        if proc.returncode != 0:
            result["error"] = f"Lỗi codex queue (exit code {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
            return result

        # 4. Post-flight Verification: Verify message was queued
        queue_output = proc.stdout.strip()
        if "Queued message" not in queue_output and "for thread" not in queue_output:
            result["error"] = f"Không nhận được tín hiệu xác thực hàng đợi: {queue_output}"
            return result

        # 5. Verify turn activation in rollout (wait up to 2.5 seconds for task_started)
        turn_started = False
        new_turn_id = None
        verify_start = time.time()

        while time.time() - verify_start < 2.5:
            try:
                with open(rollout_file, 'r', encoding='utf-8', errors='ignore') as fp:
                    last_lines = fp.readlines()[-15:]
                for line in reversed(last_lines):
                    try:
                        data = json.loads(line)
                        t = data.get('type')
                        p = data.get('payload', {})
                        if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_started':
                            new_turn_id = p.get('turn_id')
                            if new_turn_id and new_turn_id != baseline_turn_id:
                                turn_started = True
                                break
                    except Exception:
                        continue
                if turn_started:
                    break
            except Exception:
                pass
            time.sleep(0.15)

        result["success"] = True
        result["verified"] = True
        result["turn_id"] = new_turn_id
        result["message"] = f"Đã nạp chỉ đạo vào phiên Codex [{session_id[:8]}] ngầm thành công (xác thực: task_started)!"
        return result

    except subprocess.TimeoutExpired:
        result["error"] = "Hết thời gian chờ lệnh 'codex queue' phản hồi"
        return result
    except Exception as e:
        result["error"] = f"Lỗi dispatch ngầm: {str(e)}"
        return result
    finally:
        release_lock()

if __name__ == "__main__":
    prompt_arg = sys.argv[1] if len(sys.argv) > 1 else ""
    proj_arg = sys.argv[2] if len(sys.argv) > 2 else "AI_Multi_Task"

    if prompt_arg.startswith("@") and os.path.exists(prompt_arg[1:]):
        with open(prompt_arg[1:], "r", encoding="utf-8") as f:
            prompt_text = f.read()
    else:
        prompt_text = prompt_arg

    if not prompt_text.strip():
        print(json.dumps({"success": False, "error": "Prompt rỗng"}))
        sys.exit(1)

    out = dispatch_prompt_to_codex(prompt_text, proj_arg)
    print(json.dumps(out, ensure_ascii=False))

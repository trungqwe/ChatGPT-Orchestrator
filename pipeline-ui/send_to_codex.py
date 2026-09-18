import os
import glob
import json
import time
import sys
import subprocess
import uuid
import re
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
    # Section 12: dispatch_id and client_user_message_id are Orchestrator-owned
    # local diagnostics only, NOT proof of Codex queue->turn correlation.
    dispatch_id = str(uuid.uuid4())
    client_user_message_id = f"orchestrator:{dispatch_id}"

    result = {
        "success": False,
        "queued": False,
        "verified": False,
        "turn_started": False,
        "turn_id": None,
        "dispatch_id": dispatch_id,
        "client_user_message_id": client_user_message_id,
        "queued_submission_id": None,
        "correlation_method": "unavailable",
        "observed_post_dispatch_turn_id": None,
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

        # Record baseline line count before dispatch to ensure post-dispatch diagnostic observation
        baseline_line_count = 0
        try:
            with open(rollout_file, 'r', encoding='utf-8', errors='ignore') as fp:
                baseline_line_count = sum(1 for _ in fp)
        except Exception:
            baseline_line_count = 0

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
            result["queued"] = False
            result["success"] = False
            result["verified"] = False
            result["turn_started"] = False
            result["turn_id"] = None
            result["correlation_method"] = "unavailable"
            result["error"] = f"Lỗi codex queue (exit code {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}"
            return result

        # 4. Post-flight Verification: Inspect transport output
        # Active legacy adapter: codex_cli_queue (supports_exact_turn_correlation = False)
        # CRITICAL (B-03): Generic JSON stdout must NEVER manufacture exact_transport authority.
        queue_output = proc.stdout.strip()
        parsed_transport_json = None

        for line in queue_output.splitlines():
            line_str = line.strip()
            if line_str.startswith("{") and line_str.endswith("}"):
                try:
                    parsed_transport_json = json.loads(line_str)
                    break
                except Exception:
                    continue

        exact_sub_id = None

        if parsed_transport_json and isinstance(parsed_transport_json, dict):
            # Generic JSON stdout must not manufacture exact_transport authority (B-03 / L-NT-029).
            # If queued is explicitly false, fail closed immediately (L-NT-030).
            is_queued = parsed_transport_json.get("queued", True)
            if not is_queued:
                result["queued"] = False
                result["success"] = False
                result["verified"] = False
                result["turn_started"] = False
                result["turn_id"] = None
                result["correlation_method"] = "unavailable"
                result["error"] = "Hàng đợi từ chối lệnh (queued=false trong JSON stdout)"
                return result

            result["queued"] = True
            exact_sub_id = parsed_transport_json.get("queued_submission_id") or parsed_transport_json.get("submission_id") or parsed_transport_json.get("id")
            if parsed_transport_json.get("client_user_message_id"):
                result["client_user_message_id"] = parsed_transport_json.get("client_user_message_id")
        else:
            if "Queued message" in queue_output or "for thread" in queue_output:
                result["queued"] = True
                m = re.search(r"Queued message\s+([^\s]+)\s+for thread", queue_output)
                if m:
                    exact_sub_id = m.group(1)
            else:
                result["queued"] = False
                result["success"] = False
                result["verified"] = False
                result["turn_started"] = False
                result["turn_id"] = None
                result["correlation_method"] = "unavailable"
                result["error"] = f"Không nhận được tín hiệu xác thực hàng đợi: {queue_output}"
                return result

        if exact_sub_id:
            result["queued_submission_id"] = str(exact_sub_id)

        # 5. Diagnostic observation: observe whether a new task_started appeared in rollout
        # CRITICAL (B-01 / Section 15): Heuristic observation of rollout lines is strictly DIAGNOSTIC.
        # It NEVER authorizes verified=true or turn_started=true.
        observed_post_dispatch_turn_id = None
        verify_start = time.time()
        while time.time() - verify_start < 1.0:
            try:
                with open(rollout_file, 'r', encoding='utf-8', errors='ignore') as fp:
                    all_lines = fp.readlines()
                new_lines = all_lines[baseline_line_count:] if len(all_lines) >= baseline_line_count else all_lines
                for line in reversed(new_lines):
                    try:
                        data = json.loads(line)
                        t = data.get('type')
                        p = data.get('payload', {})
                        if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_started':
                            observed_tid = p.get('turn_id')
                            if observed_tid and observed_tid != baseline_turn_id:
                                observed_post_dispatch_turn_id = observed_tid
                                break
                    except Exception:
                        continue
                if observed_post_dispatch_turn_id:
                    break
            except Exception:
                pass
            time.sleep(0.1)

        result["observed_post_dispatch_turn_id"] = observed_post_dispatch_turn_id

        # 6. Active Legacy Transport Contract: codex_cli_queue
        # supports_exact_turn_correlation = False.
        # Queue acceptance is confirmed, but exact resulting turn cannot be proven via CLI (fail-closed).
        # verified=false, turn_started=false, turn_id=null, correlation_method='unavailable'.
        result["success"] = True
        result["queued"] = True
        result["verified"] = False
        result["turn_started"] = False
        result["turn_id"] = None
        result["correlation_method"] = "unavailable"
        result["message"] = f"Lệnh đã nạp vào hàng đợi Codex [{session_id[:8]}] nhưng transport cục bộ không hỗ trợ exact turn correlation (fail-closed)"

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

import os
import glob
import json
import time
import sys
from datetime import datetime

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

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

def extract_latest_codex_report(project_keyword="AI_Multi_Task"):
    files = find_project_rollouts(project_keyword)
    if not files:
        return {
            "success": False,
            "error": f"Không tìm thấy file rollout nào cho dự án '{project_keyword}'"
        }

    latest_file, session_id = files[0]
    last_message = ""
    duration_ms = 0
    turn_id = ""

    try:
        with open(latest_file, 'r', encoding='utf-8', errors='ignore') as fp:
            for line in fp:
                try:
                    data = json.loads(line)
                    t = data.get('type')
                    p = data.get('payload', {})
                    if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_complete':
                        last_message = p.get('last_agent_message', '')
                        duration_ms = p.get('duration_ms', 0)
                        turn_id = p.get('turn_id', '')
                    elif t == 'response_item' and isinstance(p, dict) and p.get('type') == 'message' and p.get('role') == 'assistant':
                        content = p.get('content', [])
                        txt = ""
                        for c in content:
                            if isinstance(c, dict):
                                txt += c.get('text', '')
                        if txt.strip():
                            last_message = txt.strip()
                except Exception:
                    continue

        return {
            "success": bool(last_message),
            "session_file": latest_file,
            "session_id": session_id,
            "turn_id": turn_id,
            "duration_ms": duration_ms,
            "report_text": last_message,
            "error": None if last_message else "Chưa có phản hồi nào từ agent trong rollout"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def watch_codex_turn(project_keyword="AI_Multi_Task", timeout_secs=180, baseline_turn_id=None, target_turn_id=None, poll_interval=0.5):
    """
    Instant-Responsive Watcher (Chống Chờ Chết):
    - Polls every 500ms.
    - If target_turn_id is specified: waits for task_complete of that exact turn.
    - If baseline_turn_id is specified: waits for task_complete with turn_id != baseline_turn_id.
    - Returns in < 1 second once Codex finishes.
    - Never waits to timeout if turn is already completed.
    """
    start_time = time.time()
    files = find_project_rollouts(project_keyword)
    if not files:
        return {"success": False, "error": f"Không tìm thấy phiên Codex nào cho '{project_keyword}'"}

    target_file, session_id = files[0]

    # If neither target nor baseline is specified, detect latest completed turn at start
    if not target_turn_id and not baseline_turn_id:
        try:
            with open(target_file, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()
            for line in reversed(lines[-60:]):
                try:
                    data = json.loads(line)
                    t = data.get('type')
                    p = data.get('payload', {})
                    if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_complete':
                        baseline_turn_id = p.get('turn_id')
                        break
                except Exception:
                    continue
        except Exception:
            pass

    # Check if target turn (or a new completed turn) is ALREADY present
    try:
        with open(target_file, 'r', encoding='utf-8', errors='ignore') as fp:
            recent_lines = fp.readlines()[-30:]
        
        for line in reversed(recent_lines):
            try:
                data = json.loads(line)
                t = data.get('type')
                p = data.get('payload', {})
                if t == 'event_msg' and isinstance(p, dict) and p.get('type') == 'task_complete':
                    current_turn_id = p.get('turn_id')
                    is_match = False
                    if target_turn_id and current_turn_id == target_turn_id:
                        is_match = True
                    elif not target_turn_id and baseline_turn_id and current_turn_id != baseline_turn_id:
                        is_match = True

                    if is_match:
                        return {
                            "success": True,
                            "verified": True,
                            "session_file": target_file,
                            "session_id": session_id,
                            "turn_id": current_turn_id,
                            "duration_ms": p.get('duration_ms', 0),
                            "report_text": p.get('last_agent_message', ''),
                            "elapsed_secs": round(time.time() - start_time, 2),
                            "instant": True,
                            "error": None
                        }
            except Exception:
                continue
    except Exception:
        pass

    # Active polling loop (500ms interval)
    while time.time() - start_time < timeout_secs:
        time.sleep(poll_interval)

        current_files = find_project_rollouts(project_keyword)
        if current_files:
            target_file, session_id = current_files[0]

        try:
            with open(target_file, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()

            for line in reversed(lines[-40:]):
                try:
                    data = json.loads(line)
                    t = data.get('type')
                    p = data.get('payload', {})
                    if t == 'event_msg' and isinstance(p, dict):
                        pt = p.get('type')
                        if pt == 'task_complete':
                            tid = p.get('turn_id', '')
                            is_match = False
                            if target_turn_id and tid == target_turn_id:
                                is_match = True
                            elif not target_turn_id and (not baseline_turn_id or tid != baseline_turn_id):
                                is_match = True

                            if is_match:
                                last_msg = p.get('last_agent_message', '')
                                return {
                                    "success": True,
                                    "verified": True,
                                    "session_file": target_file,
                                    "session_id": session_id,
                                    "turn_id": tid,
                                    "duration_ms": p.get('duration_ms', 0),
                                    "report_text": last_msg,
                                    "elapsed_secs": round(time.time() - start_time, 2),
                                    "error": None
                                }
                        elif pt == 'error':
                            return {
                                "success": False,
                                "verified": True,
                                "error": p.get('message') or 'Codex runtime error'
                            }
                except Exception:
                    continue
        except Exception:
            pass

    # Timeout reached: fallback to latest report if available
    fallback = extract_latest_codex_report(project_keyword)
    if fallback.get("success"):
        fallback["timeout_warning"] = True
        fallback["elapsed_secs"] = round(time.time() - start_time, 2)
        return fallback

    return {
        "success": False,
        "error": f"Hết thời gian chờ ({timeout_secs}s) sự kiện 'task_complete' từ Codex"
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="AI_Multi_Task")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--baseline-turn", default=None)
    parser.add_argument("--target-turn", default=None)
    parser.add_argument("--latest", action="store_true")
    args = parser.parse_args()

    if args.latest:
        res = extract_latest_codex_report(args.project)
    else:
        res = watch_codex_turn(args.project, args.timeout, args.baseline_turn, args.target_turn)
    print(json.dumps(res, ensure_ascii=False))

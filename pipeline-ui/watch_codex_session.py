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
    # Check today and recent days
    today_dir = os.path.join(base, str(today.year), f"{today.month:02d}", f"{today.day:02d}")
    if os.path.exists(today_dir):
        dirs.append(today_dir)
    # Also find all day dirs in reverse chronological order
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
            "error": f"No Codex rollout files found for project '{project_keyword}'"
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
                    if t == 'event_msg' and p.get('type') == 'task_complete':
                        last_message = p.get('last_agent_message', '')
                        duration_ms = p.get('duration_ms', 0)
                        turn_id = p.get('turn_id', '')
                    elif t == 'response_item' and p.get('type') == 'message' and p.get('role') == 'assistant':
                        # Fallback if task_complete hasn't fired yet but message exists
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
            "error": None if last_message else "No assistant message found in rollout"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def watch_codex_turn(project_keyword="AI_Multi_Task", timeout_secs=180, poll_interval=1.5):
    start_time = time.time()
    files = find_project_rollouts(project_keyword)
    
    target_file = None
    initial_line_count = 0
    
    if files:
        target_file, _ = files[0]
        try:
            with open(target_file, 'r', encoding='utf-8', errors='ignore') as fp:
                initial_line_count = sum(1 for _ in fp)
        except Exception:
            initial_line_count = 0

    while time.time() - start_time < timeout_secs:
        time.sleep(poll_interval)
        
        current_files = find_project_rollouts(project_keyword)
        if not current_files:
            continue
            
        current_file, session_id = current_files[0]
        
        # Check if a new rollout file was created
        if target_file and current_file != target_file:
            target_file = current_file
            initial_line_count = 0
        elif not target_file:
            target_file = current_file

        try:
            with open(target_file, 'r', encoding='utf-8', errors='ignore') as fp:
                lines = fp.readlines()
                
            # Search from initial_line_count onwards for task_complete
            for line in lines[max(0, initial_line_count - 1):]:
                try:
                    data = json.loads(line)
                    t = data.get('type')
                    p = data.get('payload', {})
                    if t == 'event_msg' and p.get('type') == 'task_complete':
                        last_msg = p.get('last_agent_message', '')
                        if last_msg:
                            return {
                                "success": True,
                                "session_file": target_file,
                                "session_id": session_id,
                                "turn_id": p.get('turn_id', ''),
                                "duration_ms": p.get('duration_ms', 0),
                                "report_text": last_msg,
                                "elapsed_secs": round(time.time() - start_time, 2),
                                "error": None
                            }
                except Exception:
                    continue
        except Exception:
            pass

    # If timeout reached, try to return whatever latest message is available
    fallback = extract_latest_codex_report(project_keyword)
    if fallback.get("success"):
        fallback["timeout_warning"] = True
        return fallback

    return {
        "success": False,
        "error": f"Timed out after {timeout_secs}s waiting for Codex task_complete"
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="AI_Multi_Task")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--latest", action="store_true")
    args = parser.parse_args()

    if args.latest:
        res = extract_latest_codex_report(args.project)
    else:
        res = watch_codex_turn(args.project, args.timeout)
    print(json.dumps(res, ensure_ascii=False))

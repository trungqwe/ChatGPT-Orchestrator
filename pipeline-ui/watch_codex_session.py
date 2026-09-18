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

def find_session_rollout_by_id(session_id):
    """Locate rollout file specifically for the given session_id."""
    if not session_id:
        return None
    for sdir in get_codex_sessions_dirs():
        files = glob.glob(os.path.join(sdir, f"rollout-*{session_id}*.jsonl"))
        for fpath in files:
            return fpath
        all_files = glob.glob(os.path.join(sdir, "rollout-*.jsonl"))
        all_files.sort(key=os.path.getmtime, reverse=True)
        for fpath in all_files:
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as fp:
                    first_line = fp.readline()
                    if not first_line:
                        continue
                    meta = json.loads(first_line)
                    if meta.get('payload', {}).get('id') == session_id:
                        return fpath
            except Exception:
                continue
    return None

def extract_latest_report_from_rollout_file(file_path, session_id=None):
    """Extract latest report strictly from a specific rollout file (B-05 session-bound helper)."""
    if not file_path or not os.path.exists(file_path):
        return {
            "success": False,
            "error": f"File rollout không tồn tại: {file_path}"
        }

    detected_session_id = session_id
    last_message = ""
    duration_ms = 0
    turn_id = ""

    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as fp:
            for line in fp:
                try:
                    data = json.loads(line)
                    t = data.get('type')
                    p = data.get('payload', {})
                    if not detected_session_id and isinstance(p, dict) and p.get('id'):
                        detected_session_id = p.get('id')
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

        is_valid = isinstance(last_message, str) and bool(last_message.strip())
        return {
            "success": is_valid,
            "session_file": file_path,
            "session_id": detected_session_id,
            "turn_id": turn_id,
            "duration_ms": duration_ms,
            "report_text": last_message if is_valid else None,
            "error": None if is_valid else "Chưa có phản hồi hợp lệ từ agent trong rollout"
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def extract_latest_codex_report(project_keyword="AI_Multi_Task"):
    files = find_project_rollouts(project_keyword)
    if not files:
        return {
            "success": False,
            "error": f"Không tìm thấy file rollout nào cho dự án '{project_keyword}'"
        }

    latest_file, session_id = files[0]
    return extract_latest_report_from_rollout_file(latest_file, session_id)


def watch_codex_turn(project_keyword="AI_Multi_Task", timeout_secs=180, baseline_turn_id=None, target_turn_id=None, session_id=None, poll_interval=0.5):
    """
    Instant-Responsive Watcher (Chống Chờ Chết):
    - Polls every 500ms.
    - If session_id is specified: binds strictly to that session file.
    - If target_turn_id is specified: waits for task_complete of that exact turn.
    - If baseline_turn_id is specified: waits for task_complete with turn_id != baseline_turn_id.
    - Returns in < 1 second once Codex finishes.
    - Never waits to timeout if turn is already completed.
    - Fails closed on empty/whitespace report body.
    """
    start_time = time.time()
    target_file = None

    if session_id:
        target_file = find_session_rollout_by_id(session_id)
        if not target_file:
            return {
                "success": False,
                "verified": False,
                "session_id": session_id,
                "target_turn_id": target_turn_id,
                "turn_id": None,
                "report_text": None,
                "error": f"Không tìm thấy phiên Codex với session_id '{session_id}'"
            }
    else:
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
                        last_msg = p.get('last_agent_message')
                        is_valid_report = isinstance(last_msg, str) and bool(last_msg.strip())
                        if not is_valid_report:
                            return {
                                "success": False,
                                "verified": False,
                                "turn_completed": True,
                                "report_available": False,
                                "target_turn_id": target_turn_id or current_turn_id,
                                "turn_id": current_turn_id,
                                "session_file": target_file,
                                "session_id": session_id,
                                "duration_ms": p.get('duration_ms', 0),
                                "report_text": None,
                                "elapsed_secs": round(time.time() - start_time, 2),
                                "instant": True,
                                "error": "Target Codex turn completed without a non-empty worker report"
                            }

                        return {
                            "success": True,
                            "verified": True,
                            "turn_completed": True,
                            "report_available": True,
                            "target_turn_id": target_turn_id or current_turn_id,
                            "turn_id": current_turn_id,
                            "session_file": target_file,
                            "session_id": session_id,
                            "duration_ms": p.get('duration_ms', 0),
                            "report_text": last_msg,
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

        # If not bound to a specific session_id, track latest project rollout
        if not session_id:
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
                                last_msg = p.get('last_agent_message')
                                is_valid_report = isinstance(last_msg, str) and bool(last_msg.strip())
                                if not is_valid_report:
                                    return {
                                        "success": False,
                                        "verified": False,
                                        "turn_completed": True,
                                        "report_available": False,
                                        "target_turn_id": target_turn_id or tid,
                                        "turn_id": tid,
                                        "session_file": target_file,
                                        "session_id": session_id,
                                        "duration_ms": p.get('duration_ms', 0),
                                        "report_text": None,
                                        "elapsed_secs": round(time.time() - start_time, 2),
                                        "instant": False,
                                        "error": "Target Codex turn completed without a non-empty worker report"
                                    }

                                return {
                                    "success": True,
                                    "verified": True,
                                    "turn_completed": True,
                                    "report_available": True,
                                    "target_turn_id": target_turn_id or tid,
                                    "turn_id": tid,
                                    "session_file": target_file,
                                    "session_id": session_id,
                                    "duration_ms": p.get('duration_ms', 0),
                                    "report_text": last_msg,
                                    "elapsed_secs": round(time.time() - start_time, 2),
                                    "instant": False,
                                    "error": None
                                }
                        elif pt == 'error':
                            err_tid = p.get('turn_id')
                            if target_turn_id:
                                if err_tid == target_turn_id:
                                    # Matching error (Section 18 / L-NT-032): exact target failure provenance
                                    return {
                                        "success": False,
                                        "verified": False,
                                        "turn_failed": True,
                                        "turn_id": target_turn_id,
                                        "target_turn_id": target_turn_id,
                                        "session_file": target_file,
                                        "session_id": session_id,
                                        "report_text": None,
                                        "error": p.get('message') or f"Codex runtime error in target turn '{target_turn_id}'"
                                    }
                                elif not err_tid:
                                    # Error without turn_id (Section 19 / L-NT-033): unknown scope, do NOT claim target turn failed
                                    return {
                                        "success": False,
                                        "verified": False,
                                        "turn_failed": False,
                                        "watch_failed": True,
                                        "error_scope": "session_or_unknown",
                                        "target_turn_id": target_turn_id,
                                        "turn_id": None,
                                        "session_file": target_file,
                                        "session_id": session_id,
                                        "report_text": None,
                                        "error": p.get('message') or "Codex runtime error without turn ID (session-level or unknown provenance)"
                                    }
                                else:
                                    # Wrong-turn error (Section 17 / L-NT-031): err_tid != target_turn_id
                                    # Ignore unrelated turn error and continue watching for target_turn_id!
                                    continue
                            else:
                                if baseline_turn_id and err_tid == baseline_turn_id:
                                    continue
                                if not err_tid:
                                    return {
                                        "success": False,
                                        "verified": False,
                                        "turn_failed": False,
                                        "watch_failed": True,
                                        "error_scope": "session_or_unknown",
                                        "target_turn_id": None,
                                        "turn_id": None,
                                        "session_file": target_file,
                                        "session_id": session_id,
                                        "report_text": None,
                                        "error": p.get('message') or "Codex runtime error without turn ID"
                                    }
                                return {
                                    "success": False,
                                    "verified": False,
                                    "turn_failed": True,
                                    "turn_id": err_tid,
                                    "target_turn_id": None,
                                    "session_file": target_file,
                                    "session_id": session_id,
                                    "report_text": None,
                                    "error": p.get('message') or 'Codex runtime error'
                                }
                except Exception:
                    continue
        except Exception:
            pass

    # Timeout reached: DO NOT return stale report as success (Fix F-03 / NT-003)
    # B-05 / Section 23-26: When session_id is specified, diagnostic MUST remain strictly session-bound.
    if target_file and os.path.exists(target_file):
        diag = extract_latest_report_from_rollout_file(target_file, session_id)
    else:
        diag = extract_latest_codex_report(project_keyword)

    diag_report = None
    if diag.get("success"):
        diag_report = {
            "turn_id": diag.get("turn_id"),
            "report_text": diag.get("report_text"),
            "session_id": diag.get("session_id")
        }

    return {
        "success": False,
        "verified": False,
        "target_turn_id": target_turn_id,
        "turn_id": None,
        "timed_out": True,
        "report_text": None,
        "error": f"Hết thời gian chờ ({timeout_secs}s) sự kiện 'task_complete' cho turn '{target_turn_id or 'unknown'}'",
        "elapsed_secs": round(time.time() - start_time, 2),
        "diagnostic_latest_report": diag_report
    }

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="AI_Multi_Task")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--baseline-turn", default=None)
    parser.add_argument("--target-turn", default=None)
    parser.add_argument("--session-id", default=None)
    parser.add_argument("--latest", action="store_true")
    args = parser.parse_args()

    if args.latest:
        res = extract_latest_codex_report(args.project)
    else:
        res = watch_codex_turn(args.project, args.timeout, args.baseline_turn, args.target_turn, args.session_id)
    print(json.dumps(res, ensure_ascii=False))

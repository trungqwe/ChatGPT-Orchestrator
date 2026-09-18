import sys
import json
import os
import subprocess
import time
import re

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

def normalize_project_keyword(project_keyword):
    """
    Deterministic normalization for project keywords:
    - Input: string (e.g. 'AI_Multi_Task', 'Hello World', 'ABC!@#XYZ', 'foo-bar')
    - Lowercase
    - Replace any character not in [a-z0-9_-] with '_'
    - Fallback for empty or invalid input: 'ai_multi_task'
    """
    if not project_keyword or not isinstance(project_keyword, str) or not project_keyword.strip():
        return "ai_multi_task"
    cleaned = re.sub(r'[^a-z0-9_-]', '_', project_keyword.lower().strip())
    return cleaned if cleaned else "ai_multi_task"

LOCK_FILE = os.path.join(os.path.dirname(__file__), '.dispatch.lock')

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

def dispatch_prompt_to_antigravity_bg(prompt_text, project_keyword="AI_Multi_Task"):
    """
    100% Background Zero-Intrusion Dispatcher for Antigravity (Gemini):
    - Uses AO CLI daemon background IPC (ao send --session <target_session> --message <prompt>).
    - NEVER touches mouse position or clicks.
    - NEVER steals window focus or simulates keyboard.
    - Runs seamlessly while user is in full-screen gaming, movie watching, or browsing.
    """
    result = {
        "success": False,
        "verified": False,
        "worker": "antigravity",
        "method": "ao_background_send",
        "target_session": None,
        "error": None
    }

    if not acquire_lock():
        result["error"] = "Thao tác gửi bị từ chối do dispatch lock trùng lặp"
        return result

    try:
        # Determine target session (default: ai_multi_task-1)
        clean_proj = normalize_project_keyword(project_keyword)
        target_session = f"{clean_proj}-1"

        CREATE_NO_WINDOW = 0x08000000
        cmd = ["ao.exe", "send", "--session", target_session, "--message", prompt_text]

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            creationflags=CREATE_NO_WINDOW,
            timeout=15
        )

        if proc.returncode == 0:
            result["success"] = True
            result["verified"] = True
            result["target_session"] = target_session
            result["message"] = f"Đã gửi chỉ đạo vào Antigravity Worker ({target_session}) ngầm thành công!"
            return result
        else:
            result["error"] = proc.stderr.strip() or proc.stdout.strip() or "Lỗi ao send"
            return result

    except Exception as e:
        result["error"] = str(e)
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

    out = dispatch_prompt_to_antigravity_bg(prompt_text, proj_arg)
    print(json.dumps(out, ensure_ascii=False))

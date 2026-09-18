import ctypes
from ctypes import wintypes
import time
import win32clipboard
import sys
import json
import os

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
DESKTOP_ALL = 0x01FF

LOCK_FILE = os.path.join(os.path.dirname(__file__), '.dispatch_codex.lock')

def acquire_lock():
    now = time.time()
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                ts = float(f.read().strip())
                if now - ts < 2.5:
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

def dispatch_prompt_to_codex(prompt_text, project_keyword="AI_Multi_Task"):
    result = {
        "success": False,
        "target_window": None,
        "worker": "codex_extension",
        "error": None
    }

    if not acquire_lock():
        result["error"] = "Duplicate dispatch rejected by lock"
        return result

    try:
        # 1. Switch thread desktop to Default interactive desktop
        try:
            hdesk = user32.OpenDesktopW("Default", 0, False, DESKTOP_ALL)
            if hdesk:
                user32.SetThreadDesktop(hdesk)
        except Exception as e:
            result["error"] = f"Desktop switch failed: {e}"
            return result

        # 2. Find Antigravity IDE target window
        WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        target_hwnds = []

        def enum_cb(hwnd, lparam):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if "Antigravity IDE" in title:
                        if "Orchestrator - Antigravity IDE" in title:
                            return True
                        if project_keyword and project_keyword.lower() in title.lower():
                            target_hwnds.insert(0, (hwnd, title))
                        else:
                            target_hwnds.append((hwnd, title))
            return True

        user32.EnumWindows(WNDENUMPROC(enum_cb), 0)

        if not target_hwnds:
            result["error"] = f"No Antigravity IDE worker window found matching '{project_keyword}'"
            return result

        target_hwnd, target_title = target_hwnds[0]
        result["target_window"] = target_title

        # 3. Copy prompt to clipboard
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(prompt_text, win32clipboard.CF_UNICODETEXT)
            win32clipboard.CloseClipboard()
        except Exception as e:
            result["error"] = f"Clipboard copy failed: {e}"
            return result

        # 4. Save current foreground window and cursor
        prev_fore_hwnd = user32.GetForegroundWindow()
        orig_cursor = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(orig_cursor))

        # 5. Bring target IDE window to front
        try:
            if user32.IsIconic(target_hwnd):
                user32.ShowWindow(target_hwnd, 9)

            curr_thread = kernel32.GetCurrentThreadId()
            target_thread = user32.GetWindowThreadProcessId(target_hwnd, None)
            fore_thread = user32.GetWindowThreadProcessId(prev_fore_hwnd, None) if prev_fore_hwnd else 0

            user32.AttachThreadInput(curr_thread, target_thread, True)
            if fore_thread:
                user32.AttachThreadInput(fore_thread, target_thread, True)

            # Unlock foreground lock via simulated Alt tap
            user32.keybd_event(0x12, 0, 0, 0)
            user32.keybd_event(0x12, 0, 0x0002, 0)

            user32.SetForegroundWindow(target_hwnd)
            user32.BringWindowToTop(target_hwnd)

            if fore_thread:
                user32.AttachThreadInput(fore_thread, target_thread, False)
            user32.AttachThreadInput(curr_thread, target_thread, False)
        except Exception:
            user32.SetForegroundWindow(target_hwnd)

        time.sleep(0.2)

        # 6. Locate Codex Sidebar and Input using UIAutomation
        import comtypes
        import comtypes.client
        mod = comtypes.client.GetModule("UIAutomationCore.dll")
        uia = comtypes.client.CreateObject("{ff48dba4-60ef-4201-aa87-54103eef594e}", interface=mod.IUIAutomation)
        elem = uia.ElementFromHandle(target_hwnd)

        true_cond = uia.CreateTrueCondition()
        all_descendants = elem.FindAll(mod.TreeScope_Descendants, true_cond)
        
        codex_open_btn = None
        input_elem = None
        send_btn_elem = None

        for i in range(all_descendants.Length):
            el = all_descendants.GetElement(i)
            name = el.CurrentName or ""
            cls_name = el.CurrentClassName or ""
            ctl = el.CurrentControlType

            if name == "Open Codex Sidebar" or (name == "Codex" and ctl == 50019):
                codex_open_btn = el

            if "prosemirror" in cls_name.lower() or "thay đổi tiếp theo" in name.lower() or "ask anything" in name.lower():
                r = el.CurrentBoundingRectangle
                if r.right > r.left and r.bottom > r.top:
                    input_elem = el

            if (name == "Gửi" or name == "Send") and ctl == 50000:
                r = el.CurrentBoundingRectangle
                if r.right > r.left and r.bottom > r.top:
                    send_btn_elem = el

        # If Codex input is not found and sidebar button exists, click to open
        if not input_elem and codex_open_btn:
            try:
                inv_pat_unk = codex_open_btn.GetCurrentPattern(mod.UIA_InvokePatternId)
                inv_pat = inv_pat_unk.QueryInterface(mod.IUIAutomationInvokePattern)
                inv_pat.Invoke()
                time.sleep(0.5)
            except Exception:
                br = codex_open_btn.CurrentBoundingRectangle
                user32.SetCursorPos((br.left + br.right) // 2, (br.top + br.bottom) // 2)
                time.sleep(0.04)
                user32.mouse_event(0x0002, 0, 0, 0, 0)
                time.sleep(0.04)
                user32.mouse_event(0x0004, 0, 0, 0, 0)
                time.sleep(0.5)

            all_descendants = elem.FindAll(mod.TreeScope_Descendants, true_cond)
            for i in range(all_descendants.Length):
                el = all_descendants.GetElement(i)
                cls_name = el.CurrentClassName or ""
                name = el.CurrentName or ""
                if "prosemirror" in cls_name.lower() or "thay đổi tiếp theo" in name.lower() or "ask anything" in name.lower():
                    r = el.CurrentBoundingRectangle
                    if r.right > r.left and r.bottom > r.top:
                        input_elem = el
                        break

        # 7. Focus and click into input element
        if input_elem:
            try:
                input_elem.SetFocus()
            except Exception:
                pass
            r = input_elem.CurrentBoundingRectangle
            cx = (r.left + r.right) // 2
            cy = (r.top + r.bottom) // 2
            user32.SetCursorPos(cx, cy)
            time.sleep(0.05)
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            time.sleep(0.05)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.1)
        else:
            w_rect = wintypes.RECT()
            user32.GetWindowRect(target_hwnd, ctypes.byref(w_rect))
            cx = w_rect.right - 220
            cy = w_rect.bottom - 100
            user32.SetCursorPos(cx, cy)
            time.sleep(0.05)
            user32.mouse_event(0x0002, 0, 0, 0, 0)
            time.sleep(0.05)
            user32.mouse_event(0x0004, 0, 0, 0, 0)
            time.sleep(0.1)

        # 8. Paste prompt via Ctrl+V
        VK_CONTROL = 0x11
        VK_V = 0x56
        VK_RETURN = 0x0D
        KEYEVENTF_KEYUP = 0x0002

        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        time.sleep(0.04)
        user32.keybd_event(VK_V, 0, 0, 0)
        time.sleep(0.04)
        user32.keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.04)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.25)

        # 9. Submit prompt
        invoked = False
        if send_btn_elem:
            try:
                inv_pat_unk = send_btn_elem.GetCurrentPattern(mod.UIA_InvokePatternId)
                inv_pat = inv_pat_unk.QueryInterface(mod.IUIAutomationInvokePattern)
                inv_pat.Invoke()
                invoked = True
            except Exception:
                br = send_btn_elem.CurrentBoundingRectangle
                user32.SetCursorPos((br.left + br.right) // 2, (br.top + br.bottom) // 2)
                time.sleep(0.04)
                user32.mouse_event(0x0002, 0, 0, 0, 0)
                time.sleep(0.04)
                user32.mouse_event(0x0004, 0, 0, 0, 0)
                invoked = True

        if not invoked:
            # Try Ctrl+Enter for multiline markdown / code block inputs
            user32.keybd_event(VK_CONTROL, 0, 0, 0)
            time.sleep(0.04)
            user32.keybd_event(VK_RETURN, 0, 0, 0)
            time.sleep(0.04)
            user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
            time.sleep(0.04)
            user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
            time.sleep(0.08)
            # Also send standard Enter
            user32.keybd_event(VK_RETURN, 0, 0, 0)
            time.sleep(0.04)
            user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)

        time.sleep(0.3)

        # 10. Restore cursor position and previous foreground window
        try:
            user32.SetCursorPos(orig_cursor.x, orig_cursor.y)
        except Exception:
            pass

        if prev_fore_hwnd and prev_fore_hwnd != target_hwnd:
            try:
                user32.keybd_event(0x12, 0, 0, 0)
                user32.keybd_event(0x12, 0, 0x0002, 0)
                user32.SetForegroundWindow(prev_fore_hwnd)
            except Exception:
                pass

        result["success"] = True
        return result

    except Exception as e:
        result["error"] = str(e)
        return result

    finally:
        time.sleep(1.0)
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
        print(json.dumps({"success": False, "error": "Empty prompt provided"}))
        sys.exit(1)

    out = dispatch_prompt_to_codex(prompt_text, proj_arg)
    print(json.dumps(out))

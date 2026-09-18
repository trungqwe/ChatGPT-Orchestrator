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

LOCK_FILE = os.path.join(os.path.dirname(__file__), '.dispatch.lock')

def acquire_lock():
    now = time.time()
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                ts = float(f.read().strip())
                if now - ts < 2.5:
                    # Locked, reject duplicate call
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

def dispatch_prompt_to_ide(prompt_text, project_keyword="AI_Multi_Task"):
    result = {
        "success": False,
        "target_window": None,
        "error": None
    }

    if not acquire_lock():
        result["error"] = "Duplicate dispatch rejected by lock"
        return result

    try:
        # 1. Switch thread desktop to Default (the interactive user desktop)
        try:
            hdesk = user32.OpenDesktopW("Default", 0, False, DESKTOP_ALL)
            if hdesk:
                user32.SetThreadDesktop(hdesk)
        except Exception as e:
            result["error"] = f"Desktop switch failed: {e}"
            return result

        # 2. Find Antigravity IDE window
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
                        # Strictly exclude the Orchestrator Assistant window (our current IDE conversation)
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

        # 4. Save current foreground window and cursor position to restore immediately after
        prev_fore_hwnd = user32.GetForegroundWindow()
        orig_cursor = wintypes.POINT()
        user32.GetCursorPos(ctypes.byref(orig_cursor))

        # 5. Bring Antigravity IDE window to front GENTLY without touching size or position!
        # If minimized, restore it so keystrokes can be processed. Otherwise preserve exact coordinates.
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

        time.sleep(0.15)

        # Key definitions
        VK_CONTROL = 0x11
        VK_L = 0x4C
        VK_V = 0x56
        VK_RETURN = 0x0D
        KEYEVENTF_KEYUP = 0x0002

        def key_down(vk): user32.keybd_event(vk, 0, 0, 0)
        def key_up(vk): user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

        def press_2(vk1, vk2):
            key_down(vk1)
            time.sleep(0.04)
            key_down(vk2)
            time.sleep(0.04)
            key_up(vk2)
            time.sleep(0.04)
            key_up(vk1)

        def tap_key(vk):
            key_down(vk)
            time.sleep(0.04)
            key_up(vk)

        # 6. Locate Message input using UIAutomation to avoid pasting into code editor
        input_clicked = False
        btn_target = None
        try:
            import comtypes
            import comtypes.client
            mod = comtypes.client.GetModule("UIAutomationCore.dll")
            uia = comtypes.client.CreateObject("{ff48dba4-60ef-4201-aa87-54103eef594e}", interface=mod.IUIAutomation)
            elem = uia.ElementFromHandle(target_hwnd)
            cond = uia.CreatePropertyCondition(mod.UIA_NamePropertyId, "Message input")
            input_elem = elem.FindFirst(mod.TreeScope_Descendants, cond)
            if input_elem:
                try:
                    input_elem.SetFocus()
                    time.sleep(0.05)
                except Exception:
                    pass
                r = input_elem.CurrentBoundingRectangle
                cx = (r.left + r.right) // 2
                cy = (r.top + r.bottom) // 2
                user32.SetCursorPos(cx, cy)
                time.sleep(0.04)
                user32.mouse_event(0x0002, 0, 0, 0, 0) # LEFTDOWN
                time.sleep(0.04)
                user32.mouse_event(0x0004, 0, 0, 0, 0) # LEFTUP
                time.sleep(0.08)
                input_clicked = True

            btn_cond = uia.CreatePropertyCondition(mod.UIA_NamePropertyId, "Send message")
            btn_elem = elem.FindFirst(mod.TreeScope_Descendants, btn_cond)
            if btn_elem:
                br = btn_elem.CurrentBoundingRectangle
                btn_target = ((br.left + br.right) // 2, (br.top + br.bottom) // 2)
        except Exception:
            pass

        if not input_clicked:
            # Fallback to Ctrl+L (toggleChatFocus / openChatView)
            press_2(VK_CONTROL, VK_L)
            time.sleep(0.2)

        # 7. Paste prompt via Ctrl+V
        press_2(VK_CONTROL, VK_V)
        time.sleep(0.2)

        # 8. Submit via Send message button or Enter
        invoked = False
        if btn_elem:
            try:
                inv_pat_unk = btn_elem.GetCurrentPattern(mod.UIA_InvokePatternId)
                inv_pat = inv_pat_unk.QueryInterface(mod.IUIAutomationInvokePattern)
                inv_pat.Invoke()
                invoked = True
                time.sleep(0.2)
            except Exception:
                pass

        if not invoked:
            if btn_target:
                user32.SetCursorPos(btn_target[0], btn_target[1])
                time.sleep(0.04)
                user32.mouse_event(0x0002, 0, 0, 0, 0)
                time.sleep(0.04)
                user32.mouse_event(0x0004, 0, 0, 0, 0)
                time.sleep(0.3)
            else:
                tap_key(VK_RETURN)
                time.sleep(0.45)

        # 9. Restore original cursor position and user's previous foreground window
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

    finally:
        # Keep lock for 1.5s to prevent immediate double invocation
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

    out = dispatch_prompt_to_ide(prompt_text, proj_arg)
    print(json.dumps(out))

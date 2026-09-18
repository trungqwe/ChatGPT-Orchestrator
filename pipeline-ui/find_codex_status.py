import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
target = 'Kiểm Tra Trạng Thái Codex'.encode('utf-8')
search_roots = [
    r'C:\Users\Admin\.gemini',
    r'C:\Users\Admin\AppData\Roaming\Antigravity IDE',
    r'C:\Users\Admin\AppData\Local'
]

for base in search_roots:
    for root, dirs, files in os.walk(base):
        if 'node_modules' in root:
            continue
        for f in files:
            p = os.path.join(root, f)
            try:
                if os.path.getsize(p) < 100 * 1024 * 1024:
                    with open(p, 'rb') as fp:
                        if target in fp.read():
                            print('FOUND IN:', p)
            except Exception:
                pass

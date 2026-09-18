import sqlite3
import glob
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

convos_dir = r'C:\Users\Admin\.gemini\antigravity-ide\conversations'
db_files = glob.glob(os.path.join(convos_dir, '*.db'))

print(f"Total DBs: {len(db_files)}")

for db_path in db_files:
    cid = os.path.basename(db_path).replace('.db', '')
    try:
        conn = sqlite3.connect(db_path)
        c = conn.cursor()
        c.execute("SELECT * FROM steps WHERE rowid = 5;")
        row = c.fetchone()
        if row:
            # Let's inspect text/strings in row
            text_blobs = []
            for col in row:
                if isinstance(col, bytes):
                    # extract readable utf-8 strings
                    # Find printable ascii / utf8 chunks of length > 5
                    matches = re.findall(r'[\x20-\x7E\u00A0-\uFFFF]{5,}', col.decode('utf-8', errors='ignore'))
                    for m in matches:
                        # filter out protobuf noise
                        if not m.startswith('call_') and not m.startswith('http') and len(m) < 100:
                            text_blobs.append(m)
            print(f"[{cid}]")
            for t in text_blobs[:5]:
                print(f"   -> {t}")
    except Exception as e:
        pass

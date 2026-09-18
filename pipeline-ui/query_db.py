import sys
import json
import sqlite3

def main():
    if len(sys.argv) < 3:
        print(json.dumps([]))
        return
    db_path = sys.argv[1]
    query = sys.argv[2]
    params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []
    
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(query, params)
        rows = [dict(r) for r in cur.fetchall()]
        print(json.dumps(rows))
    except Exception as e:
        print(json.dumps([]), file=sys.stderr)
        print(json.dumps([]))

if __name__ == '__main__':
    main()

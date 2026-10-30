"""credential.secret_enc 재암호화(구 Fernet 포함 → kms 또는 fernet). 키 값은 출력하지 않는다.

사용: python scripts/rekey_credentials.py --db data/gateway.db --to kms [--dry-run]
- --to kms   : v2:kms: 가 아닌 행을 KMS 봉투 암호화로 변환
- --to fernet: 모든 행을 현재 Fernet 키(VAULT_KEY 또는 data/.vault_key)로 다시 암호화(구 기본 키 탈출용)
- WIF 크레덴셜(secret_enc NULL)은 건너뛴다. 갱신은 한 트랜잭션(실패가 하나라도 있으면 전체 롤백).
"""
import argparse
import json
import os
import sqlite3
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--db", required=True)
ap.add_argument("--to", required=True, choices=("kms", "fernet"))
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()

os.environ["KEY_BACKEND"] = a.to
os.environ["DB_PATH"] = a.db  # fernet 키 파일 위치(.vault_key)를 대상 DB 폴더로
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from app import vault  # noqa: E402

c = sqlite3.connect(a.db, isolation_level=None)
rows = c.execute("SELECT id, secret_enc FROM credential WHERE secret_enc IS NOT NULL").fetchall()
done, failed, updates = 0, 0, []
for cid, enc in rows:
    if a.to == "kms" and enc.startswith("v2:kms:"):
        continue
    try:
        new = vault.encrypt(vault.decrypt(enc))
        assert vault.decrypt(new) == vault.decrypt(enc)
        updates.append((new, cid))
        done += 1
    except Exception as e:  # 값은 출력하지 않는다(종류만)
        failed += 1
        print(f"id={cid} 실패: {type(e).__name__}", file=sys.stderr)

if not a.dry_run and updates and not failed:
    c.execute("BEGIN IMMEDIATE")
    try:
        c.executemany("UPDATE credential SET secret_enc=? WHERE id=?", updates)
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
print(json.dumps({"총": len(rows), "변환": done, "실패": failed, "dry_run": a.dry_run,
                  "적용": bool(not a.dry_run and updates and not failed)}, ensure_ascii=False))
sys.exit(1 if failed else 0)

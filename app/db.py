"""SQLite 스키마와 연결. 수정 금지(오케스트레이터만). 컬럼 추가가 필요하면 보고."""
import os
import sqlite3

from app.contract import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allowed_cidr (
  id INTEGER PRIMARY KEY AUTOINCREMENT, cidr TEXT NOT NULL, label TEXT NOT NULL); -- INTERNAL|VPN
CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE');
CREATE TABLE IF NOT EXISTS gateway_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, token_masked TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL);      -- ACTIVE|REVOKED
CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL,          -- 'mock'
  auth_mode TEXT NOT NULL,                                               -- API_KEY|WIF
  role TEXT NOT NULL,                                                    -- PRIMARY|STANDBY
  status TEXT NOT NULL DEFAULT 'ACTIVE',                                 -- ACTIVE|REVOKED
  secret_enc TEXT,                                                       -- API_KEY: vault 암호문, WIF: NULL
  masked TEXT NOT NULL,
  audience TEXT,                                                         -- WIF 전용
  provider_ref TEXT NOT NULL,   -- Mock 사용량/폐기 식별자: API_KEY='sha256:'||hex(키)(구 DB는 원문), WIF='wif:'||audience
  replaced_by_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER, credential_id INTEGER NOT NULL,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_krw REAL NOT NULL,
  status_code INTEGER, at REAL NOT NULL);                                -- at = epoch 초
CREATE TABLE IF NOT EXISTS provider_usage (          -- 누적값 스냅샷
  id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id INTEGER NOT NULL,
  cost_krw REAL NOT NULL, tokens INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0, at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_usage_cred ON usage_log(credential_id, at);
CREATE INDEX IF NOT EXISTS ix_pu_cred ON provider_usage(credential_id, at);
CREATE TABLE IF NOT EXISTS access_denied_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_ip TEXT, reason TEXT,     -- ip_not_allowed|invalid_token|service_suspended
  token_masked TEXT, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS incident (
  id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id INTEGER,           -- HONEYKEY 사고는 NULL
  trigger_type TEXT NOT NULL DEFAULT 'RECONCILIATION',                   -- RECONCILIATION|HONEYKEY
  status TEXT NOT NULL,                                                  -- OPEN|ROTATED|RESOLVED
  detected_at REAL NOT NULL, blocked_at REAL, resolved_at REAL,
  loss_krw REAL, limit_krw REAL, loss_calls INTEGER, limit_calls INTEGER, new_credential_id INTEGER,
  timeline TEXT NOT NULL DEFAULT '[]');                                  -- JSON [{at,step,detail,ok}]
CREATE TABLE IF NOT EXISTS honeykey (
  id INTEGER PRIMARY KEY AUTOINCREMENT, value_hash TEXT NOT NULL UNIQUE, masked TEXT NOT NULL,
  planted_at TEXT NOT NULL, created_at TEXT NOT NULL);                   -- planted_at: 심은 위치 설명
CREATE TABLE IF NOT EXISTS honeykey_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, honeykey_id INTEGER NOT NULL,
  source_ip TEXT, path TEXT, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,
  kind TEXT NOT NULL,   -- SUSPECT|WARNING|BLOCKED|RECOVERED|ATTACK_STARTED|ATTACK_STOPPED|ACCESS_DENIED|HONEYKEY
  message TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS trusted_identity (   -- 사용자 측 WIF 신뢰 규칙(issuer + sub 글롭 → service)
  id INTEGER PRIMARY KEY AUTOINCREMENT, issuer TEXT NOT NULL, subject_pattern TEXT NOT NULL,
  audience TEXT, service_id INTEGER NOT NULL, jwks_uri TEXT, created_at TEXT NOT NULL);
"""


def get_conn() -> sqlite3.Connection:
    """호출마다 새 연결. 쓰기 후 commit은 호출자 책임."""
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db() -> None:
    with get_conn() as c:
        cols = [r[1] for r in c.execute("PRAGMA table_info(incident)")]
        if cols and "limit_calls" not in cols:  # 구 스키마 DB: 데모 데이터이므로 전부 버리고 재생성
            for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
                c.execute(f"DROP TABLE {t}")
        c.executescript(SCHEMA)
        c.execute("INSERT OR IGNORE INTO setting(key,value) VALUES('loss_limit_krw','100000')")
        c.execute("INSERT OR IGNORE INTO setting(key,value) VALUES('unauthorized_call_limit','100')")
    # 키 암호문·해시가 든 DB는 소유자만(폴더 700, 파일 600). 폴더가 cwd면 건드리지 않음. Windows 등 실패는 무시.
    d = os.path.dirname(DB_PATH)
    for p, mode in ([(d, 0o700)] if d else []) + [(DB_PATH + s, 0o600) for s in ("", "-wal", "-shm")]:
        try:
            os.chmod(p, mode)
        except OSError:
            pass

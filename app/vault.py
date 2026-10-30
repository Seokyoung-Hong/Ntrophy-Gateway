"""공급자 API 키 암호화 저장. 시그니처 고정: encrypt(plain) -> str, decrypt(enc) -> str.

KEY_BACKEND=kms    : AWS KMS 봉투 암호화(app/kms.py, 저장 형식 v2:kms:...)
KEY_BACKEND=fernet : (기본) Fernet. 키 = VAULT_KEY(sha256 유도) 또는 data/.vault_key(없으면 무작위 생성)
복호화는 접두사로 판별한다. Fernet 암호문(gAAAA...)은 현재 키 → VAULT_KEY_LEGACY(구 기본 키) 순으로 시도해
기존 DB를 그대로 읽는다. 평문·키 값은 로그·예외 메시지에 넣지 않는다.
"""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.contract import DB_PATH, PUBLIC_MODE

BACKEND = os.getenv("KEY_BACKEND", "fernet").strip().lower()
if BACKEND not in ("kms", "fernet"):
    raise RuntimeError("KEY_BACKEND는 kms 또는 fernet이어야 합니다")
if PUBLIC_MODE and BACKEND == "fernet" and not os.getenv("VAULT_KEY"):
    raise RuntimeError("공개 모드(PUBLIC_MODE=1)에서는 VAULT_KEY 또는 KEY_BACKEND=kms가 필요합니다(기동 거부)")

KEY_FILE = os.path.join(os.path.dirname(DB_PATH) or ".", ".vault_key")


class VaultError(Exception):
    """원인 종류만 담는다(값 없음)."""


def _fernet(secret: bytes) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret).digest()))


def _local_key() -> bytes:
    """data/.vault_key: 없으면 무작위 32바이트를 만들어 저장(600)하고 재사용."""
    try:
        with open(KEY_FILE, "rb") as f:
            return f.read()
    except FileNotFoundError:
        os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
        key = os.urandom(32)
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        return key


_mf = None


def _fernets() -> MultiFernet:
    """[현재 키, 구 기본 키]. kms 모드에서는 키 파일을 새로 만들지 않는다(있으면 읽어 기존 fernet 행을 복호화)."""
    global _mf
    if _mf is None:
        cur = os.getenv("VAULT_KEY")
        keys = [cur.encode()] if cur else ([] if BACKEND == "kms" and not os.path.exists(KEY_FILE) else [_local_key()])
        keys.append(os.getenv("VAULT_KEY_LEGACY", "november-demo-vault").encode())
        _mf = MultiFernet([_fernet(k) for k in keys])
    return _mf


if BACKEND == "fernet":
    _fernets()  # 기동 시 키 준비(파일 생성 오류를 첫 요청이 아니라 기동 때 드러낸다)


def encrypt(plain: str) -> str:
    if BACKEND == "kms":
        from app import kms  # boto3 지연 import
        return kms.encrypt(plain)
    return _fernets().encrypt(plain.encode()).decode()


def decrypt(enc: str) -> str:
    if enc.startswith("v2:kms:"):
        from app import kms
        return kms.decrypt(enc)
    try:
        return _fernets().decrypt(enc.encode()).decode()
    except InvalidToken:
        raise VaultError("Fernet 복호화 실패: 일치하는 키 없음 또는 변조") from None

"""AWS KMS 봉투 암호화: DEK(AES-256-GCM)로 평문을 암호화하고, DEK는 KMS의 KEK로 감싼다.

저장 형식: v2:kms:<key_version>:<kek_id 해시 8자>:<wrapped_dek>:<nonce>:<ciphertext> (값은 URL-safe base64)
평문·DEK·키 값은 로그·예외 메시지에 넣지 않는다. boto3는 이 모듈을 import할 때만 필요하다.
"""
import base64
import hashlib
import json
import os
import threading
import time

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "v2:kms:"
KEY_VERSION = "1"  # 저장 형식 버전(KEK 교체는 KMS가 내부에서 처리하므로 형식이 바뀔 때만 올린다)
DEFAULT_CONTEXT = {"app": "november", "purpose": "provider-api-key"}
KEY_ID = os.getenv("KMS_KEY_ID", "alias/november-gateway-kek")
DEK_TTL_S = 600


class KMSError(Exception):
    """원인 종류만 담는다(값 없음)."""


_client = None
_cache: dict[str, tuple[float, bytes]] = {}  # sha256(wrapped_dek+context) -> (만료 시각, DEK). 프로세스 메모리만.
_lock = threading.Lock()


def _kms():
    global _client
    if _client is None:
        # AWS_ENDPOINT_URL_KMS(테스트용 moto 등)는 boto3가 환경변수에서 직접 읽는다
        _client = boto3.client("kms", region_name=os.getenv("AWS_REGION", "ap-northeast-2"),
                               config=Config(retries={"max_attempts": 3}, connect_timeout=3, read_timeout=5))
    return _client


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s.encode())


def _aad(ctx: dict) -> bytes:
    return json.dumps(ctx, sort_keys=True, separators=(",", ":")).encode()


def _call(op: str, **kw) -> dict:
    try:
        return getattr(_kms(), op)(**kw)
    except ClientError as e:
        raise KMSError(f"KMS {op} 실패: {e.response.get('Error', {}).get('Code', 'ClientError')}") from None
    except BotoCoreError as e:
        raise KMSError(f"KMS {op} 실패: {type(e).__name__}") from None


def encrypt(plain: str, context: dict | None = None) -> str:
    ctx = context or DEFAULT_CONTEXT
    r = _call("generate_data_key", KeyId=KEY_ID, KeySpec="AES_256", EncryptionContext=ctx)
    nonce = os.urandom(12)
    ct = AESGCM(r["Plaintext"]).encrypt(nonce, plain.encode(), _aad(ctx))
    kek = hashlib.sha256(r["KeyId"].encode()).hexdigest()[:8]
    return ":".join([PREFIX[:-1], KEY_VERSION, kek, _b64(r["CiphertextBlob"]), _b64(nonce), _b64(ct)])


def _dek(wrapped: bytes, ctx: dict) -> bytes:
    k = hashlib.sha256(wrapped + _aad(ctx)).hexdigest()
    now = time.monotonic()
    with _lock:
        hit = _cache.get(k)
        if hit and hit[0] > now:
            return hit[1]
    dek = _call("decrypt", CiphertextBlob=wrapped, EncryptionContext=ctx)["Plaintext"]
    with _lock:
        for old in [x for x, (exp, _) in _cache.items() if exp <= now]:  # 만료분 정리
            del _cache[old]
        _cache[k] = (now + DEK_TTL_S, dek)
    return dek


def decrypt(enc: str, context: dict | None = None) -> str:
    ctx = context or DEFAULT_CONTEXT
    try:
        _, _, ver, _kek, wrapped, nonce, ct = enc.split(":")
        if ver != KEY_VERSION:
            raise ValueError
        wrapped, nonce, ct = _unb64(wrapped), _unb64(nonce), _unb64(ct)
    except ValueError:
        raise KMSError("암호문 형식 오류") from None
    try:
        return AESGCM(_dek(wrapped, ctx)).decrypt(nonce, ct, _aad(ctx)).decode()
    except InvalidTag:
        raise KMSError("복호화 실패: 무결성 검증 실패(변조 또는 컨텍스트 불일치)") from None

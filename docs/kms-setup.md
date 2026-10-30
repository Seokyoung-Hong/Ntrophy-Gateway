# AWS KMS 봉투 암호화 설정

공급자 API 키(`credential.secret_enc`)를 AWS KMS 봉투 암호화로 보관하는 절차다. 설계 배경은 `docs/key-security-design.md`.

## 1. 동작 요약
- `app/vault.py`가 백엔드를 고른다(`KEY_BACKEND=kms|fernet`, 기본 `fernet`). 호출부 시그니처(`encrypt(plain)`, `decrypt(enc)`)는 그대로다.
- **kms**: 키마다 `GenerateDataKey(AES_256)`로 DEK를 받아 **AES-256-GCM**(12바이트 nonce, AAD=암호화 컨텍스트)으로 암호화하고, KMS가 감싼 DEK를 함께 저장한다.
  - 저장 형식: `v2:kms:<형식 버전>:<KEK 해시 8자>:<wrapped_dek>:<nonce>:<ciphertext>` (URL-safe base64)
  - 암호화 컨텍스트: `{"app":"november","purpose":"provider-api-key"}` (KMS와 AES-GCM 양쪽에 바인딩)
  - 복호화한 DEK는 프로세스 메모리에만 600초 캐시(디스크·로그 없음). 평문·DEK는 로그·예외 메시지에 넣지 않는다.
- **fernet**(로컬 개발): `VAULT_KEY`가 있으면 그 값, 없으면 `DB_PATH` 폴더의 `.vault_key`(무작위 32바이트, 자동 생성)를 쓴다. **공개 모드(`PUBLIC_MODE=1`)에서 `VAULT_KEY` 없이 fernet이면 기동 거부.**
- 복호화는 접두사로 판별: `v2:kms:` → KMS, `gAAAA` → Fernet(현재 키 → `VAULT_KEY_LEGACY`, 기본 `november-demo-vault` 순). 그래서 기존 DB가 그대로 읽힌다.

## 2. 환경변수
| 이름 | 기본값 | 설명 |
|---|---|---|
| `KEY_BACKEND` | `fernet` | `kms`로 바꾸면 새 암호문은 KMS 봉투 암호화 |
| `KMS_KEY_ID` | `alias/november-gateway-kek` | KEK 별칭 또는 ARN |
| `AWS_REGION` | `ap-northeast-2` | KMS 리전 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | - | IAM 사용자 `november-gateway-kms` 키(EC2라면 인스턴스 역할 권장, 그때는 생략) |
| `VAULT_KEY` | - | fernet 현재 키(공개 모드 fernet이면 필수) |
| `VAULT_KEY_LEGACY` | `november-demo-vault` | 구 암호문 읽기 전용 키. 재암호화 후 무작위 값으로 바꿔 무력화 |
| `AWS_ENDPOINT_URL_KMS` | - | 테스트용(moto 등). 운영에서는 설정하지 않음 |

## 3. 준비(사용자가 AWS 로그인 후)
```powershell
aws login --profile default            # 세션 만료 시
.\scripts\kms_setup.ps1 -AwsProfile default -Region ap-northeast-2 -EnvFile .env.server -WhatIf   # 미리 보기
.\scripts\kms_setup.ps1 -AwsProfile default -Region ap-northeast-2 -EnvFile .env.server           # 단계마다 확인
```
스크립트가 하는 일: 계정·리전·프로필 출력 → CMK 생성(`NovemberGateway KEK`)+별칭 → 연 1회 자동 교체 → IAM 사용자 `november-gateway-kms`+인라인 정책 → 액세스 키를 **화면 출력 없이** `--query ... --output text`를 임시 파일로 받아 `.env.server`에 추가(임시 파일 삭제). `.env.server`는 서버로 옮긴 뒤 `chmod 600`, 로컬 사본은 지운다(저장소에 커밋 금지).

### 최소 권한 IAM 정책
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "NovemberEnvelope",
    "Effect": "Allow",
    "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
    "Resource": "arn:aws:kms:ap-northeast-2:<계정>:key/<키 ID>",
    "Condition": {"StringEquals": {
      "kms:EncryptionContext:app": "november",
      "kms:EncryptionContext:purpose": "provider-api-key"}}
  }]
}
```
키 삭제·정책 변경 권한은 주지 않는다(관리자 계정만).

## 4. 서버 반영
1. `requirements.txt`의 `boto3` 설치(`deploy_test_server.sh`가 `pip install -r`로 처리).
2. `.env.server`에 `KEY_BACKEND=kms`, `KMS_KEY_ID`, `AWS_REGION`, AWS 자격 추가(3절 스크립트).
3. 기존 암호문 재암호화(서비스 중지 후, DB 백업 먼저):
   ```bash
   cp data/gateway.db data/gateway.db.bak
   set -a; . ./.env.server; set +a
   venv/bin/python scripts/rekey_credentials.py --db data/gateway.db --to kms --dry-run
   venv/bin/python scripts/rekey_credentials.py --db data/gateway.db --to kms
   ```
   출력은 `{"총","변환","실패"}` 숫자만. 실패가 1건이라도 있으면 전체 롤백된다.
4. 서비스 재시작 → `/demo/reset`·사용자 호출로 확인.
5. 확인 후 `VAULT_KEY_LEGACY`를 무작위 값으로 설정해 구 기본 키를 무력화.

## 5. 롤백
- 코드만 되돌릴 때: `KEY_BACKEND=fernet`으로 바꾸면 새 암호문은 Fernet, 기존 `v2:kms:` 암호문은 KMS 자격이 남아 있는 한 계속 읽힌다.
- 완전 복귀: `VAULT_KEY`를 설정한 뒤 `rekey_credentials.py --db ... --to fernet`으로 Fernet으로 되돌리고 KMS 자격을 제거한다. 또는 백업(`gateway.db.bak`) 복원.
- KMS 키는 바로 지우지 않는다(`schedule-key-deletion` 최소 7일 대기). 삭제되면 `v2:kms:` 암호문은 영구히 복구 불가.

## 6. 비용
- 고객 관리형 키 1개 **월 약 $1**(자동 교체로 늘어난 이전 버전 일부도 과금될 수 있음).
- API 호출 1만 건당 약 $0.03. DEK 캐시(600초)로 호출 수가 적어 데모·소규모 운영에서는 사실상 키 비용만 든다.

## 7. 한계
- Windows에서는 `.vault_key` 권한 600이 적용되지 않는다(Linux 서버에서는 600).
- KEK 교체는 KMS 내부에서 처리되므로 저장된 wrapped DEK는 그대로 복호화된다. 형식 버전(`1`)은 저장 형식이 바뀔 때만 올린다.

## 8. 운영 반영 기록(2026-10-31)
- 대상: 실서버(Proxmox CT 1003, https://sio2.kr), 배포 커밋 `d1ed50d`.
- AWS(리전 ap-northeast-2): KMS 대칭 키 `alias/november-gateway-kek`(설명 `NovemberGateway KEK`, 연 1회 자동 교체), IAM 사용자 `november-gateway-kms`(콘솔 로그인 없음).
- 인라인 정책 `NovemberGatewayKmsEnvelope`: 위 키 하나에만 `kms:GenerateDataKey`·`kms:Decrypt`, 조건 `aws:RequestedRegion=ap-northeast-2` + 암호화 컨텍스트(`app=november`, `purpose=provider-api-key`). 컨텍스트 없는 호출은 거부됨을 확인.
- 서버 `.env.server`(600)에 `VAULT_KEY`(무작위)·`KMS_KEY_ID`·`AWS_REGION`·IAM 사용자 액세스 키·`KEY_BACKEND=kms` 추가. 루트 자격 없음 확인.
- `rekey_credentials.py --to kms`: 총 2, 변환 2, 실패 0. 이후 `/demo/reset`으로 만든 행도 `v2:kms:`.
- 롤백: `.env.server`에서 `KEY_BACKEND` 제거 → `rekey_credentials.py --to fernet` → `systemctl restart november-gateway`. 또는 `/opt/november`의 `*.bak-prekms-*`(DB·환경)와 `src-*.tgz` 복원.
- 남은 일: `VAULT_KEY_LEGACY`를 무작위 값으로 설정해 구 기본 키 무력화(4절 5).

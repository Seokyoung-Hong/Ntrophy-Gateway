#!/usr/bin/env bash
# 테스트 서버를 집 Proxmox CT에 배포(멱등). 사용: scripts/deploy_test_server.sh <VMID>
# origin/main만 배포(미커밋 변경 제외). 접속은 pct-ssh 별칭 ssh ct<VMID>. 실제 AI 키는 넣지 않는다(Mock 가짜 응답).
set -euo pipefail
VMID=${1:?usage: $0 <VMID>}
H=ct$VMID
REPO=$(cd "$(dirname "$0")/.." && pwd)

git -C "$REPO" fetch origin
echo "deploy origin/main $(git -C "$REPO" rev-parse --short origin/main) -> $H"
git -C "$REPO" archive origin/main | ssh "$H" 'rm -rf /opt/november/src.new && mkdir -p /opt/november/src.new && tar -x -C /opt/november/src.new && rm -rf /opt/november/src && mv /opt/november/src.new /opt/november/src'

ssh "$H" 'bash -s' <<'EOF'
set -euo pipefail
N=/opt/november
mkdir -p $N/data
chmod 700 $N/data  # DB(키 암호문)·live_key.json은 소유자만
[ -x $N/venv/bin/python ] || python3 -m venv $N/venv
$N/venv/bin/pip install -q -r $N/src/requirements.txt
if [ ! -f $N/.env.server ]; then  # 있으면 보존(수동 추가 값 유지)
  umask 077
  cat > $N/.env.server <<ENV
PUBLIC_MODE=1
DEMO_MODE=1
ADMIN_KEY=admin
TRUSTED_PROXIES=172.30.1.101
MOCK_BASE_URL=http://127.0.0.1:9000
DB_PATH=$N/data/gateway.db
VLLM_BASE_URL=https://vllm.dorm.sio2.kr
ENV
fi
chmod 600 $N/.env.server
unit() {  # name module port
  cat > /etc/systemd/system/$1.service <<UNIT
[Unit]
Description=$1
After=network-online.target
[Service]
WorkingDirectory=$N/src
EnvironmentFile=$N/.env.server
ExecStart=$N/venv/bin/python -m uvicorn $2 --host 0.0.0.0 --port $3
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
}
unit november-mock app.mock_provider.main:app 9000
unit november-gateway app.main:app 8000
systemctl daemon-reload
systemctl enable -q november-mock november-gateway
systemctl restart november-mock november-gateway
for u in http://localhost:8000/test http://localhost:9000/live/config; do
  for i in $(seq 30); do curl -fs -o /dev/null "$u" && break; sleep 1; done
  echo "$(curl -sS -o /dev/null -w '%{http_code}' "$u") $u"
done
chmod 600 $N/data/gateway.db* 2>/dev/null || true  # 기동 후 생긴 db·-wal·-shm 포함
EOF

# 테스트 서버(공개 모드): origin/main을 C:\Users\tjrdu\novemberdeploy\src에 풀고 Gateway 8800 + Mock 9800을 숨김 실행.
# 바인드 = 이 PC의 Tailscale IP만. 실제 AI 키(.env)는 복사하지 않는다(Mock 가짜 응답). 종료: scripts\stop_test_server.ps1
$ErrorActionPreference = "Stop"
$Repo = Split-Path $PSScriptRoot -Parent
$Py = Join-Path $Repo ".venv\Scripts\python.exe"
$Deploy = "C:\Users\tjrdu\novemberdeploy"
$Src, $Data, $Logs = "$Deploy\src", "$Deploy\data", "$Deploy\logs"

$ts = if ($env:BIND_IP) { $env:BIND_IP } else { (tailscale ip -4 2>$null | Select-Object -First 1) }  # BIND_IP로 LAN IP 지정 가능
if (-not $ts) { throw "Tailscale IP 없음(tailscale ip -4). 중단." }
$ts = $ts.Trim()

& (Join-Path $PSScriptRoot "stop_test_server.ps1")  # 이전 실행 정리
New-Item -ItemType Directory -Force $Deploy, $Data, $Logs | Out-Null

git -C $Repo fetch origin
if ($LASTEXITCODE) { throw "git fetch 실패" }
$zip = "$Deploy\src.zip"
git -C $Repo archive --format=zip -o $zip origin/main
if ($LASTEXITCODE) { throw "git archive 실패" }
if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }  # 코드만 교체. DB(data\)는 src 밖이라 보존
Expand-Archive $zip $Src
Remove-Item $zip

$keyFile = "$Deploy\admin_key.txt"
"admin" | Set-Content -NoNewline -Encoding ascii $keyFile  # 데모 고정값(추측 가능, 접근 제한은 NPM에서)

$env:PUBLIC_MODE = "1"; $env:DEMO_MODE = "1"
$env:ADMIN_KEY = "admin"
$env:TRUSTED_PROXIES = "100.69.18.101"  # NPM
$env:MOCK_BASE_URL = "http://${ts}:9800"
if (-not $env:VLLM_BASE_URL) { $env:VLLM_BASE_URL = "https://vllm.dorm.sio2.kr" }  # 숙소 NPM이 서비스하는 vLLM 게이트웨이. 다른 주소면 VLLM_BASE_URL을 미리 설정
$env:DB_PATH = "$Data\gateway.db"
foreach ($k in "UPSTREAM_API_KEY", "OPENROUTER_MANAGEMENT_KEY", "OPENAI_ADMIN_KEY") { Remove-Item "env:$k" -ErrorAction SilentlyContinue }

$pids = foreach ($s in @(@("mock", "app.mock_provider.main:app", 9800), @("gateway", "app.main:app", 8800))) {
    (Start-Process $Py "-m uvicorn $($s[1]) --host $ts --port $($s[2])" -WorkingDirectory $Src -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput "$Logs\$($s[0]).out.log" -RedirectStandardError "$Logs\$($s[0]).err.log").Id
}
$pids -join "," | Set-Content "$Deploy\pids.txt"

foreach ($u in "http://${ts}:8800/test", "http://${ts}:9800/live/config") {
    $ok = $false
    foreach ($i in 1..20) {
        try { if ((Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok = $true; break } } catch { }
        Start-Sleep 1
    }
    if (-not $ok) { & (Join-Path $PSScriptRoot "stop_test_server.ps1"); throw "헬스 확인 실패: $u (로그 $Logs)" }
    Write-Host "OK 200 $u"
}
Write-Host "Gateway http://${ts}:8800  Mock http://${ts}:9800  관리자 키: admin  로그: $Logs"

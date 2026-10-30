# run_test_server.ps1이 띄운 서버 종료(PID 파일 기준, venv 런처의 자식 python까지 /T로 종료)
$f = "C:\Users\tjrdu\novemberdeploy\pids.txt"
if (-not (Test-Path $f)) { Write-Host "실행 중인 테스트 서버 없음"; return }
foreach ($p in (Get-Content -Raw $f).Trim() -split ",") {
    if ($p) { taskkill /PID $p /T /F 2>$null | Out-Null }
}
Remove-Item $f
Write-Host "테스트 서버 종료"

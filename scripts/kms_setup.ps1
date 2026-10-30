<#
.SYNOPSIS
  NovemberGateway용 AWS KMS KEK + 최소 권한 IAM 사용자를 만든다(docs/kms-setup.md 참조).
.DESCRIPTION
  aws login(또는 SSO) 후 실행. 각 단계는 -Confirm 스타일 중단점(ShouldProcess)으로 확인한다.
  액세스 키는 터미널에 출력하지 않고 -EnvFile(.env.server)에 직접 추가한다. 미리 보기: -WhatIf
.EXAMPLE
  .\scripts\kms_setup.ps1 -AwsProfile default -Region ap-northeast-2 -EnvFile .env.server
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$AwsProfile = 'default',
    [string]$Region = 'ap-northeast-2',
    [string]$EnvFile = '.env.server',
    [string]$Alias = 'alias/november-gateway-kek',
    [string]$UserName = 'november-gateway-kms'
)
$ErrorActionPreference = 'Stop'
$common = @('--profile', $AwsProfile, '--region', $Region)

$acct = aws sts get-caller-identity @common --query Account --output text
if ($LASTEXITCODE -ne 0) { throw 'AWS 세션 없음: aws login --profile ' + $AwsProfile }
Write-Host "계정 $acct / 리전 $Region / 프로필 $AwsProfile / 환경파일 $EnvFile"

# 1) CMK + 별칭 (이미 있으면 재사용)
$keyId = aws kms describe-key @common --key-id $Alias --query KeyMetadata.KeyId --output text 2>$null
if ($LASTEXITCODE -ne 0 -or -not $keyId) {
    if ($PSCmdlet.ShouldProcess("$acct/$Region", 'KMS 키 생성(NovemberGateway KEK) + 별칭 ' + $Alias)) {
        $keyId = aws kms create-key @common --description 'NovemberGateway KEK' --key-usage ENCRYPT_DECRYPT `
            --key-spec SYMMETRIC_DEFAULT --query KeyMetadata.KeyId --output text
        aws kms create-alias @common --alias-name $Alias --target-key-id $keyId
    } else { return }
}
$keyArn = "arn:aws:kms:${Region}:${acct}:key/$keyId"
Write-Host "KEK: $keyArn"

# 2) 연 1회 자동 교체
if ($PSCmdlet.ShouldProcess($keyArn, '자동 키 교체(enable-key-rotation) 켜기')) {
    aws kms enable-key-rotation @common --key-id $keyId
}

# 3) 최소 권한 정책 + IAM 사용자 (GenerateDataKey·Decrypt만, 암호화 컨텍스트 app=november 필수)
$policy = @{
    Version   = '2012-10-17'
    Statement = @(@{
            Sid       = 'NovemberEnvelope'
            Effect    = 'Allow'
            Action    = @('kms:GenerateDataKey', 'kms:Decrypt')
            Resource  = $keyArn
            Condition = @{ StringEquals = @{ 'kms:EncryptionContext:app' = 'november'; 'kms:EncryptionContext:purpose' = 'provider-api-key' } }
        })
} | ConvertTo-Json -Depth 6
$policyFile = New-TemporaryFile
Set-Content -Path $policyFile -Value $policy -Encoding ascii
if ($PSCmdlet.ShouldProcess("$acct", "IAM 사용자 $UserName 생성 + 인라인 정책 november-kms-envelope 부여")) {
    aws iam get-user @common --user-name $UserName *> $null
    if ($LASTEXITCODE -ne 0) { aws iam create-user @common --user-name $UserName | Out-Null }
    aws iam put-user-policy @common --user-name $UserName --policy-name november-kms-envelope --policy-document "file://$policyFile"
}
Remove-Item $policyFile

# 4) 액세스 키 → 환경파일에 직접 기록(터미널 출력 없음)
if ($PSCmdlet.ShouldProcess($EnvFile, "$UserName 액세스 키 발급 후 환경파일에 추가(값은 화면에 출력하지 않음)")) {
    $tmp = New-TemporaryFile
    aws iam create-access-key @common --user-name $UserName `
        --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text > $tmp
    $id, $secret = (Get-Content $tmp -Raw).Trim() -split '\s+'
    Remove-Item $tmp
    Add-Content -Path $EnvFile -Value @(
        'KEY_BACKEND=kms', "KMS_KEY_ID=$Alias", "AWS_REGION=$Region",
        "AWS_ACCESS_KEY_ID=$id", "AWS_SECRET_ACCESS_KEY=$secret")
    Remove-Variable id, secret
    Write-Host "환경파일 $EnvFile 에 KEY_BACKEND/KMS_KEY_ID/AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY 추가 완료(서버로 옮긴 뒤 chmod 600, 로컬 사본 삭제)"
}

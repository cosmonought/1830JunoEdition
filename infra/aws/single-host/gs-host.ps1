# infra/aws/single-host/gs-host.ps1 -- COST-1: the OPERATOR's side of the single host, for the Windows workflow (the bash
# twin is gs-host.sh). Runs ONE fixed host command through SSM Run Command (AWS-RunShellScript, public SSM endpoints,
# free on EC2) and prints its output. No SSH. Every argument is validated HERE; the remote command is built only from
# fixed templates. Needs AWS CLI v2 (aws.exe -- a CLI v1 aws.cmd is refused, as elsewhere in infra/aws) and operator
# credentials allowed ssm:SendCommand (AWS-RunShellScript) on the instance and ssm:GetCommandInvocation.
#
#   .\gs-host.ps1 -Command status   -InstanceId i-...
#   .\gs-host.ps1 -Command deploy   -InstanceId i-... -Digest sha256:<64 hex> -BuildId <id> [-Measure]
#   .\gs-host.ps1 -Command rollback -InstanceId i-...
#   .\gs-host.ps1 -Command stop     -InstanceId i-... [-UntilDeploy]
#   .\gs-host.ps1 -Command measure-report -InstanceId i-... [-Days 14]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'deploy', 'rollback', 'stop', 'measure-report')][string]$Command,
  [Parameter(Mandatory = $true)][ValidatePattern('^i-[0-9a-f]{8,17}$')][string]$InstanceId,
  [ValidatePattern('^[a-z]{2}(-[a-z]+)+-[0-9]$')][string]$Region = 'us-east-1',
  [ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$Digest,
  [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$BuildId,
  [switch]$Measure,
  [switch]$UntilDeploy,
  [ValidateRange(1, 365)][int]$Days = 14
)
$ErrorActionPreference = 'Stop'
$aws = Get-Command aws.exe -ErrorAction SilentlyContinue
if (-not $aws) { throw 'gs-host: REFUSED: AWS CLI v2 (aws.exe) is required.' }

switch ($Command) {
  'status' { $remote = '/opt/gs/bin/gs-health' }
  'deploy' {
    if (-not $Digest -or -not $BuildId) { throw 'gs-host: REFUSED: deploy needs -Digest sha256:<64 hex> and -BuildId.' }
    $remote = "/opt/gs/bin/gs-deploy $Digest $BuildId" + $(if ($Measure) { ' --measure' } else { '' })
  }
  'rollback' { $remote = '/opt/gs/bin/gs-rollback' }
  'stop' { $remote = '/opt/gs/bin/gs-stop' + $(if ($UntilDeploy) { ' --until-deploy' } else { '' }) }
  'measure-report' { $remote = "/opt/gs/bin/gs-measure-report $Days" }
}

$params = New-TemporaryFile
try {
  @{ commands = @($remote); executionTimeout = @('900') } | ConvertTo-Json -Compress | Set-Content -Path $params -Encoding ascii
  $id = & aws.exe ssm send-command --region $Region --instance-ids $InstanceId --document-name AWS-RunShellScript `
    --comment "gs-host $Command" --parameters "file://$($params.FullName)" --timeout-seconds 600 --query Command.CommandId --output text
  if ($LASTEXITCODE -ne 0) { throw 'gs-host: REFUSED: send-command failed.' }
  Write-Host "gs-host: $Command on $InstanceId (command $id)"
  do {
    Start-Sleep -Seconds 5
    $status = & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query Status --output text 2>$null
    if ($LASTEXITCODE -ne 0) { $status = 'Pending' }
  } while ($status -in @('Pending', 'InProgress', 'Delayed'))
  & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query StandardOutputContent --output text
  $err = & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query StandardErrorContent --output text
  if ($err -and $err -ne 'None') { Write-Warning $err }
  if ($status -ne 'Success') { throw "gs-host: REFUSED: the host command ended $status." }
}
finally {
  Remove-Item -Path $params -ErrorAction SilentlyContinue
}

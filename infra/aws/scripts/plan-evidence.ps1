# LIVE-6 L6-6: capture ONE stack's real `terraform plan` for the staging certification (Windows PowerShell) -- NEVER an
# apply. See plan-evidence.sh for the files written and how they are judged.
#   .\infra\aws\scripts\plan-evidence.ps1 -Stack app -Out .\evidence -Run l6cert-0930a -PlanArgs @("-var-file=staging.tfvars")
param(
  [Parameter(Mandatory = $true)][ValidateSet("ledger", "app")][string]$Stack,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Run,
  [string[]]$PlanArgs = @()
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
foreach ($option in $PlanArgs) { if (@("-auto-approve", "-destroy", "apply", "destroy") -contains $option) { throw "refused: $option (this script only plans)" } }
$dir = Resolve-Path (Join-Path $PSScriptRoot "..\stacks\$Stack")
$target = Join-Path $Out "terraform\$Stack"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("gs-plan-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $version = & terraform "-chdir=$dir" version -json
  if ($LASTEXITCODE -ne 0) { throw "terraform version failed" }
  Set-Content -Path (Join-Path $target "version.json") -Value ($version -join "`n") -Encoding utf8
  $planFile = Join-Path $work "stack.tfplan"
  & terraform "-chdir=$dir" plan -input=false -detailed-exitcode "-out=$planFile" @PlanArgs
  $code = $LASTEXITCODE
  Set-Content -Path (Join-Path $target "plan-exitcode.txt") -Value "$code" -Encoding ascii
  if ((Test-Path $planFile) -and $code -ne 1) {
    $json = & terraform "-chdir=$dir" show -json $planFile
    if ($LASTEXITCODE -ne 0) { throw "terraform show failed" }
    Set-Content -Path (Join-Path $target "plan.json") -Value ($json -join "`n") -Encoding utf8
  } else {
    Set-Content -Path (Join-Path $target "plan.json") -Value "{}" -Encoding utf8
  }
  Copy-Item -Path (Join-Path $dir ".terraform.lock.hcl") -Destination (Join-Path $target "lock.hcl")
  Set-Content -Path (Join-Path $target "run.json") -Value ('{"format":"18COSMOS/L6-6-PLAN/v1","run_id":"' + $Run + '","stack":"' + $Stack + '","captured_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") + '"}') -Encoding utf8
  Write-Output "plan evidence for $Stack written to $target (exit $code; nothing applied)"
} finally {
  Remove-Item -Recurse -Force $work
}

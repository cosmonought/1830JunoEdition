# LIVE-6 L6-6: capture ONE stack's real `terraform plan` for the staging certification (Windows PowerShell) -- NEVER an
# apply. See plan-evidence.sh for the files written and how they are judged. COST-2B: also -Stack single-host, and
# -KeepPlan for a migration step (the binary plan kept as stack.tfplan + stack.tfplan.sha256, to be applied exactly
# after `awsDeploy migration-guard` PASSES; see infra/aws/SINGLE_HOST_MIGRATION.md).
#   .\infra\aws\scripts\plan-evidence.ps1 -Stack app -Out .\evidence -Run l6cert-0930a -PlanArgs @("-var-file=staging.tfvars")
#   .\infra\aws\scripts\plan-evidence.ps1 -Stack app -Out .\migration -Run cost2-cutover -KeepPlan -PlanArgs @("-var-file=staging.tfvars", "-target=module.app.aws_cloudfront_distribution.site[0]")
param(
  [Parameter(Mandatory = $true)][ValidateSet("ledger", "app", "single-host")][string]$Stack,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Run,
  [switch]$KeepPlan,
  [string[]]$PlanArgs = @()
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
foreach ($option in $PlanArgs) { if (@("-auto-approve", "-destroy", "apply", "destroy") -contains $option) { throw "refused: $option (this script only plans)" } }
# RECON-1A: the -target options this plan was made with, recorded in run.json ("targets"; [] = untargeted) -- a gate
# that judges a TARGETED plan (migration-guard app-read-authorize) requires exactly its own.
$targets = @()
for ($i = 0; $i -lt $PlanArgs.Count; $i++) {
  $option = $PlanArgs[$i]
  if ($option -match '^--?target=(.*)$') { $targets += $Matches[1] }
  elseif ($option -eq "-target" -or $option -eq "--target") { if ($i + 1 -lt $PlanArgs.Count) { $i++; $targets += $PlanArgs[$i] } }
}
$targetsJson = ($targets | ForEach-Object { '"' + $_.Replace('\', '\\').Replace('"', '\"') + '"' }) -join ","
$dir = Resolve-Path (Join-Path $PSScriptRoot "..\stacks\$Stack")
$target = Join-Path $Out "terraform\$Stack"
New-Item -ItemType Directory -Force -Path $target | Out-Null
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("gs-plan-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
# A previous capture's saved plan never survives into this one (the guard would otherwise bind a stale binary plan).
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $target "stack.tfplan"), (Join-Path $target "stack.tfplan.sha256")
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
    if ($KeepPlan) {
      Copy-Item -Path $planFile -Destination (Join-Path $target "stack.tfplan")
      # Both hashes in one file (sha256sum's format): the binary plan to apply AND the plan.json shown from it.
      $lines = foreach ($name in @("stack.tfplan", "plan.json")) { (Get-FileHash -Algorithm SHA256 -Path (Join-Path $target $name)).Hash.ToLowerInvariant() + "  " + $name }
      [System.IO.File]::WriteAllText((Join-Path $target "stack.tfplan.sha256"), (($lines -join "`n") + "`n"))
    }
  } else {
    Set-Content -Path (Join-Path $target "plan.json") -Value "{}" -Encoding utf8
  }
  Copy-Item -Path (Join-Path $dir ".terraform.lock.hcl") -Destination (Join-Path $target "lock.hcl")
  # COST-2B: the checkout this plan was made from; infra/aws must be clean (no modified, untracked or override file).
  $repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
  $commit = (& git -C $repo rev-parse HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $commit) { $commit = "" }
  $clean = "false"
  if ($commit) {
    & git -C $repo diff --quiet HEAD -- infra/aws 2>$null
    $diffClean = ($LASTEXITCODE -eq 0)
    $untracked = (& git -C $repo ls-files --others --exclude-standard -- infra/aws)
    $overrides = Get-ChildItem -Path (Join-Path $repo "infra\aws") -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\\.terraform\\' -and ($_.Name -in @("override.tf", "override.tf.json") -or $_.Name -like "*_override.tf" -or $_.Name -like "*_override.tf.json") }
    if ($diffClean -and -not $untracked -and -not $overrides) { $clean = "true" }
  }
  Set-Content -Path (Join-Path $target "run.json") -Value ('{"format":"18COSMOS/L6-6-PLAN/v1","run_id":"' + $Run + '","stack":"' + $Stack + '","captured_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") + '","commit":"' + $commit + '","infra_aws_clean":' + $clean + ',"targets":[' + $targetsJson + ']}') -Encoding utf8
  $kept = if ($KeepPlan) { "; the saved plan kept as stack.tfplan" } else { "" }
  Write-Output "plan evidence for $Stack written to $target (exit $code; nothing applied$kept)"
} finally {
  Remove-Item -Recurse -Force $work
}

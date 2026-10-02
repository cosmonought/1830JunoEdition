# infra/aws/single-host/build-image.ps1 -- COST-1: the Windows twin of build-image.sh. Builds the game-server image for
# the single host (default linux/arm64, through Docker Desktop's buildx; the build stage runs natively, the runtime stage
# only copies files) and pushes it to the EXISTING ECR repository. Prints the DIGEST that gs-host.ps1 -Command deploy takes.
#   .\build-image.ps1 -Repository <account>.dkr.ecr.<region>.amazonaws.com/gs-<env>-server -BuildId <id> [-Platform linux/arm64]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+$')][string]$Repository,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$BuildId,
  [ValidateSet('linux/arm64', 'linux/amd64')][string]$Platform = 'linux/arm64'
)
$ErrorActionPreference = 'Stop'
$root = (& git rev-parse --show-toplevel).Trim()
Set-Location $root
if ((& git status --porcelain)) { throw 'build-image: REFUSED: the checkout has uncommitted changes (an image is built from a commit).' }
$revision = (& git rev-parse HEAD).Trim()
$meta = New-TemporaryFile
try {
  & docker buildx build --platform $Platform -f infra/docker/game-server.Dockerfile --label "org.opencontainers.image.revision=$revision" -t "${Repository}:${BuildId}" --provenance=false --push --metadata-file $meta.FullName .
  if ($LASTEXITCODE -ne 0) { throw 'build-image: REFUSED: the build or push failed.' }
  # The digest of what was PUSHED under the tag (buildx's own record), never a child or layer digest.
  $digest = (Get-Content -Raw -Path $meta.FullName | ConvertFrom-Json).'containerimage.digest'
  if ($digest -notmatch '^sha256:[0-9a-f]{64}$') { throw 'build-image: REFUSED: could not read the pushed digest.' }
  Write-Host "build-image: $Platform $BuildId -> $digest"
}
finally {
  Remove-Item -Path $meta -ErrorAction SilentlyContinue
}

# start-playtest.ps1 -- bring up the ngrok playtest in one command: tunnel, game server, proxy.
#
# Run it like this (works whether or not script execution is enabled):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Bradshaw\Documents\GitHub\1830Juno\start-playtest.ps1"
#
#   -SkipBuild   nothing changed since the last run; do not rebuild frontend or server
#   -Dev         dev-server mode: proxy --dev plus a fourth window running `npm start`.
#                Hot reload, but tens of megabytes per load against a 1 GB month -- see PLAYTEST_NGROK.md.
#   -NgrokHost   use a different tunnel host; rewrites frontend\.env.local and forces a rebuild
#
# This is PLAYTEST_NGROK.md turned into a script. That file is still the explanation; this is the typing.
#
# ASCII ONLY IN THIS FILE, on purpose -- the same reason as frontend\test-summary.ps1. Windows PowerShell
# 5.1 reads a .ps1 without a byte-order mark as the system code page, so a non-ASCII character in a comment
# or a string becomes garbage before the parser sees it.

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$Dev,
  [string]$NgrokHost
)

$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- helpers

function Say    { param([string]$m) Write-Host $m }
function Step   { param([string]$m) Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ok     { param([string]$m) Write-Host "   ok   $m" -ForegroundColor Green }
function Warn   { param([string]$m) Write-Host "   note $m" -ForegroundColor Yellow }
function Die    { param([string]$m) Write-Host ""; Write-Host "STOPPED: $m" -ForegroundColor Red; Write-Host ""; exit 1 }

function Test-PortListening {
  param([int]$Port)
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }
  catch { return $false }
}

function Wait-ForPort {
  param([int]$Port, [int]$Seconds = 30)
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-PortListening -Port $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# Each window gets its own throwaway .ps1 rather than a -Command string: quoting a command line through
# Start-Process is where this sort of script usually goes wrong, and a file has none of that.
function Start-Window {
  param([string]$Title, [string]$WorkDir, [string[]]$Body)
  $tmp = Join-Path $env:TEMP ("playtest-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + ".ps1")
  $lines = @(
    "`$Host.UI.RawUI.WindowTitle = '$Title'",
    "Set-Location '$WorkDir'",
    "Write-Host '---- $Title ----' -ForegroundColor Cyan",
    "Write-Host ''"
  ) + $Body
  Set-Content -Path $tmp -Value $lines -Encoding ascii
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $tmp | Out-Null
}

function Invoke-Build {
  param([string]$What, [string]$WorkDir)
  Step "Building $What -- two to four minutes for the frontend, and warnings are normal"
  Push-Location $WorkDir
  & npm.cmd run build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Die "$What build failed (exit $code). Nothing was started." }
  Ok "$What build clean"
}

# ---------------------------------------------------------------- paths

$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$frontend = Join-Path $root 'frontend'
$server   = Join-Path $root 'server'
$envFile  = Join-Path $frontend '.env.local'
$proxyJs  = Join-Path $server 'playtest-proxy.js'
$startJs  = Join-Path $server 'dist\server\src\start.js'

Write-Host ""
Write-Host "1830 Juno -- playtest bring-up" -ForegroundColor White
Write-Host "repo: $root"

if (-not (Test-Path $frontend)) { Die "no frontend\ under $root -- is this the repo root?" }
if (-not (Test-Path $proxyJs))  { Die "no server\playtest-proxy.js under $root -- is this the repo root?" }

# ---------------------------------------------------------------- 1. .env.local

Step "Reading frontend\.env.local"
if (-not (Test-Path $envFile)) { Die "frontend\.env.local does not exist. See PLAYTEST_NGROK.md." }

if ($NgrokHost) {
  $NgrokHost = $NgrokHost -replace '^https?://', '' -replace '/.*$', ''
  (Get-Content $envFile) -replace '^REACT_APP_GAME_SERVER_URL=.*', "REACT_APP_GAME_SERVER_URL=wss://$NgrokHost/gs" | Set-Content $envFile -Encoding ascii
  Ok "rewrote REACT_APP_GAME_SERVER_URL for $NgrokHost"
  if ($SkipBuild) { Warn "-SkipBuild ignored: REACT_APP_* is substituted at build time, so the host change needs a build" }
  $SkipBuild = $false
}

$envLines = Get-Content $envFile
$urlLine   = $envLines | Where-Object { $_ -match '^REACT_APP_GAME_SERVER_URL=' } | Select-Object -First 1
$buildLine = $envLines | Where-Object { $_ -match '^REACT_APP_BUILD_ID=' }        | Select-Object -First 1

if (-not $urlLine) { Die "no REACT_APP_GAME_SERVER_URL line in .env.local" }
$m = [regex]::Match($urlLine, '^REACT_APP_GAME_SERVER_URL=wss://([^/]+)/gs\s*$')
if (-not $m.Success) {
  Die "REACT_APP_GAME_SERVER_URL is not of the form wss://<host>/gs -- it reads: $urlLine`n         wss (not ws) and the trailing /gs both matter; a https page cannot open a ws:// socket."
}
$tunnelHost = $m.Groups[1].Value

$buildId = 'dev'
if ($buildLine) { $buildId = ($buildLine -split '=', 2)[1].Trim() }
if (-not $buildId) { $buildId = 'dev' }

Ok "tunnel host  $tunnelHost"
Ok "build id     $buildId  (the server is started with --build $buildId; they are compared exactly)"

# ---------------------------------------------------------------- 2. ngrok

Step "Checking ngrok"
$ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrokCmd) {
  Die "ngrok is not on PATH. Run: winget install ngrok.ngrok`n         Then CLOSE this window and open a new one -- PATH is read when a window opens."
}
$ngrokVersion = (& ngrok version 2>&1 | Out-String).Trim()
Ok $ngrokVersion

# --url landed in ngrok 3.5; older 3.x call the same thing --domain.
$hostFlag = '--domain'
$vm = [regex]::Match($ngrokVersion, '(\d+)\.(\d+)\.(\d+)')
if ($vm.Success) {
  $maj = [int]$vm.Groups[1].Value; $min = [int]$vm.Groups[2].Value
  if ($maj -gt 3 -or ($maj -eq 3 -and $min -ge 5)) { $hostFlag = '--url' }
}

# ---------------------------------------------------------------- 3. ports

Step "Checking ports"
if (Test-PortListening -Port 8917) { Die "something is already listening on 8917 (the game server). Ctrl+C the old window first." }
if (Test-PortListening -Port 8918) { Die "something is already listening on 8918 (the proxy). Ctrl+C the old window first." }
Ok "8917 and 8918 are free"

$tunnelAlreadyUp = Test-PortListening -Port 4040
if ($tunnelAlreadyUp) { Warn "an ngrok agent is already running (4040 is listening) -- reusing it rather than opening a second tunnel" }

# ---------------------------------------------------------------- 4. builds

if ($Dev) {
  Warn "-Dev: serving the CRA dev server through the tunnel. Hot reload, but tens of megabytes per load."
  if (-not $SkipBuild) { Invoke-Build -What 'server' -WorkDir $server }
} elseif ($SkipBuild) {
  Warn "-SkipBuild: no rebuild. If a fix is missing from the game, this is the first thing to suspect."
  if (-not (Test-Path (Join-Path $frontend 'build\index.html'))) { Die "-SkipBuild, but there is no frontend\build. Run without -SkipBuild." }
  if (-not (Test-Path $startJs)) { Die "-SkipBuild, but there is no server\dist. Run without -SkipBuild." }
} else {
  Invoke-Build -What 'frontend' -WorkDir $frontend
  Invoke-Build -What 'server'   -WorkDir $server
}

if (-not (Test-Path $startJs)) { Die "server\dist\server\src\start.js is missing even after a build." }

# ---------------------------------------------------------------- 5. window 1: the tunnel

if (-not $tunnelAlreadyUp) {
  Step "Window 1 -- the tunnel"
  Start-Window -Title '1830 playtest: tunnel' -WorkDir $root -Body @(
    "ngrok http $hostFlag $tunnelHost 8918"
  )
  Say "   waiting for the agent..."
  if (-not (Wait-ForPort -Port 4040 -Seconds 30)) {
    Warn "the ngrok agent did not come up within 30s -- read window 1 before going further"
  }
}

# The agent's own API is the honest answer about what the tunnel is actually forwarding.
$publicUrl = $null
for ($i = 0; $i -lt 15; $i++) {
  try {
    $api = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
    $t = $api.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1
    if ($t) { $publicUrl = $t.public_url; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if ($publicUrl) {
  Ok "forwarding $publicUrl"
  if ($publicUrl -ne "https://$tunnelHost") {
    Warn "that is NOT the host compiled into this build (wss://$tunnelHost/gs)."
    Warn "re-run as:  -NgrokHost '$($publicUrl -replace '^https://','')'"
  }
} else {
  Warn "could not read the tunnel URL from the agent's API -- read the Forwarding line in window 1 yourself"
}

# ---------------------------------------------------------------- 6. window 2: the game server

Step "Window 2 -- the game server"
Start-Window -Title '1830 playtest: game server' -WorkDir $server -Body @(
  "Write-Host 'Keep this window visible: it prints a line for every action it does not apply.' -ForegroundColor Yellow",
  "Write-Host 'Check the compiled stamp below -- older than a fix you just made means it was not rebuilt.' -ForegroundColor Yellow",
  "Write-Host ''",
  "node dist/server/src/start.js --insecure-local-identity --build $buildId"
)
if (Wait-ForPort -Port 8917 -Seconds 30) { Ok "listening on 8917" } else { Die "the game server never reached 8917 -- read window 2." }

# ---------------------------------------------------------------- 7. dev-server window, if asked

if ($Dev) {
  Step "Window 4 -- the CRA dev server"
  Start-Window -Title '1830 playtest: dev server' -WorkDir $frontend -Body @("npm.cmd start")
  Say "   waiting for :3000..."
  if (-not (Wait-ForPort -Port 3000 -Seconds 120)) { Warn "the dev server is not on 3000 yet -- the proxy will answer once it is" }
}

# ---------------------------------------------------------------- 8. window 3: the proxy

Step "Window 3 -- the proxy"
$proxyArgs = ''
if ($Dev) { $proxyArgs = ' --dev' }
Start-Window -Title '1830 playtest: proxy' -WorkDir $server -Body @("node playtest-proxy.js$proxyArgs")
if (Wait-ForPort -Port 8918 -Seconds 30) { Ok "listening on 8918" } else { Die "the proxy never reached 8918 -- read window 3." }

# ---------------------------------------------------------------- 9. prove it

Step "Proving it end to end"
Say "   GET https://$tunnelHost/gs  -- tunnel, proxy and game server, in one line"
$answer = $null
for ($i = 0; $i -lt 6; $i++) {
  try {
    $answer = Invoke-RestMethod -Uri "https://$tunnelHost/gs" -Headers @{ 'ngrok-skip-browser-warning' = '1' } -TimeoutSec 15
    break
  } catch {
    Start-Sleep -Seconds 3
  }
}

Write-Host ""
if ("$answer".Trim() -eq '1830 game server') {
  Ok "answered '1830 game server' -- all three are up"
} elseif ($answer) {
  Warn "answered something unexpected: $answer"
} else {
  Warn "no answer. Do not open a browser yet -- it will not tell you which of the three is at fault."
  Warn "Window 1 errors = the tunnel. 'nothing answered on 127.0.0.1:8917' in window 3 = the server."
}

# ---------------------------------------------------------------- 10. what is left to do

Write-Host ""
Write-Host "======================================================================"
Write-Host "  Send players:  https://$tunnelHost"                                   -ForegroundColor White
Write-Host ""
Write-Host "  - ngrok shows a warning page first. Click Visit Site. Once per browser."
Write-Host "  - ONE TAB EACH. A duplicated tab copies sessionStorage and becomes the same player (#528)."
Write-Host "  - Use the ngrok URL yourself too, not localhost. One origin for everybody."
Write-Host "  - Window 2 prints one [INSECURE] line per player, all with different ids."
Write-Host "    No line for someone means their browser never reached the server."
Write-Host ""
Write-Host "  The only test that is really from outside: open that URL on your phone with wifi off."
Write-Host ""
Write-Host "  Frontend change: npm run build in frontend\, players hard-reload (Ctrl+Shift+R)."
Write-Host "  Server change:   Ctrl+C window 2, then re-run this script with -SkipBuild after npm run build."
Write-Host "  Stopping:        Ctrl+C in each of the three windows. Do not leave the tunnel up overnight."
Write-Host "======================================================================"
Write-Host ""

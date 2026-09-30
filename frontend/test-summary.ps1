# test-summary.ps1 -- run the whole suite, then print ONLY:
#   each failing test's name with the first lines of its failure, then the totals.
#
# Run it like this (works whether or not script execution is enabled):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\test-summary.ps1"
#
# Add -Lines 20 at the end for more of each failure.
# Add -NoColor to get plain strings on the pipeline instead, so `> summary.txt` captures them.
# The full run is always saved to test-output.txt next to this script, so nothing is lost by trimming.
#
# COLOUR: the failing test names are red, Jest's expected/received diff keeps its usual red/green, stack
# lines are dimmed, and the totals go red or green on the word "failed". The point is that the eye lands on
# the failure rather than on a wall of uniform text -- which is also why the run is captured to a file and
# re-read rather than piped straight to the console: PowerShell paints EVERY stderr line red, so a raw
# `npm test` makes the whole run look like an error and the real failures do not stand out at all.
#
# ASCII ONLY IN THIS FILE, on purpose. Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as the
# system code page, so a Unicode bullet in a comment or a pattern becomes garbage before the parser sees it.
# The bullet Jest prints is matched below by its code point instead.

#
# EXIT STATUS (R12-W1). The script exits with npm's own status: 0 only when the full suite passed, nonzero
# otherwise. It used to fall off the end and exit 0 whatever Jest said, so an owner gate that trusted the exit
# code printed "PASS: Frontend full test summary" above "Test Suites: 6 failed". The native status is captured
# on the line after the run, before any formatting can overwrite it, and is cross-checked against the totals
# Jest printed: a run that reports a failure, or prints no totals at all, or never ran, is never a 0.
#
# Add -Jest <args> to pass extra arguments to Jest (a path pattern, say) for a quick partial run.

param([int]$Lines = 12, [switch]$NoColor, [string[]]$Jest = @())

# Native stderr is redirected into the capture below on purpose; a caller's 'Stop' preference would turn the
# first stderr line into a terminating error and lose the run.
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# One writer for everything below, so -NoColor is honoured in exactly one place. With -NoColor the text goes
# to the pipeline as plain strings, which is what makes redirecting to a file work; Write-Host never does.
function W {
  param([string]$Text = '', [string]$Color = 'Gray')
  if ($NoColor) { Write-Output $Text } else { Write-Host $Text -ForegroundColor $Color }
}

# Which colour a line inside a failure block deserves. Jest's own diff convention is kept rather than
# inverted: jest-diff paints EXPECTED green and RECEIVED red, so the red line is the value that is actually
# wrong. "-" is the expected side, "+" is the received side.
function Get-FailureColor {
  param([string]$Text)
  if ($Text -match '^\s*at\s')                    { return 'DarkGray' }   # stack frames
  if ($Text -match '^\s*\d+\s*\|')                { return 'DarkGray' }   # Jest's source excerpt gutter
  if ($Text -match '^\s*-')                       { return 'Green' }      # expected
  if ($Text -match '^\s*\+')                      { return 'Red' }        # received -- the wrong value
  if ($Text -match '^\s*Expected')                { return 'Green' }
  if ($Text -match '^\s*Received')                { return 'Red' }
  if ($Text -match '^\s*expect\(')                { return 'White' }      # the assertion itself
  return 'Gray'
}

# "$_" turns Jest's stderr lines back into plain strings; without it PowerShell paints them red and wraps
# each one in "System.Management.Automation.RemoteException". --silent drops the tests' own console.log
# output, which otherwise buries the failures under debugging prints.
#
# $LASTEXITCODE is the GLOBAL automatic variable, read and cleared as $global: so that a script-scope variable can
# never shadow it, and cleared first so that an npm that never started cannot inherit an earlier command's 0.
$global:LASTEXITCODE = $null
npm test -- --watchAll=false --silent @Jest 2>&1 | ForEach-Object { "$_" } | Out-File -Encoding utf8 test-output.txt
$npmExit = $global:LASTEXITCODE

$all = Get-Content test-output.txt

# Jest repeats every failure under this heading at the end of the run. That block is grouped and complete,
# so it is the one worth reading.
$summary = $all | Select-String -SimpleMatch "Summary of all failing tests" | Select-Object -First 1

# Each failure header starts with a bullet. Jest emits U+25CF; a console with the wrong code page shows it
# as the three characters U+0393 U+00F9 U+00C5. Match either, by code point, so this file stays ASCII.
$bullet = '^\s*(\u25CF|\u0393\u00F9\u00C5) '

# Each failure is printed from its bullet down to whichever comes first: -Lines lines, the NEXT failure's
# bullet, or the run's totals. Select-String -Context cannot be told to stop early, so with a generous
# -Lines it prints the next failure as the tail of the previous one and then again under its own heading,
# and swallows the totals into the last block. The indices are walked by hand here for that reason.
if ($summary) {
  $tail = $all[($summary.LineNumber - 1)..($all.Count - 1)]

  $stop = $tail.Count
  for ($i = 0; $i -lt $tail.Count; $i++) {
    if ($tail[$i] -match '^(Tests|Test Suites):') { $stop = $i; break }
  }

  $heads = @()
  for ($i = 0; $i -lt $stop; $i++) {
    if ($tail[$i] -match $bullet) { $heads += $i }
  }

  if ($heads.Count -eq 0) {
    W ''
    W 'Jest printed a failure summary but no failing test names -- read test-output.txt.' 'Yellow'
  } else {
    for ($h = 0; $h -lt $heads.Count; $h++) {
      $start = $heads[$h]
      $limit = $start + $Lines
      if ($h + 1 -lt $heads.Count) { if (($heads[$h + 1] - 1) -lt $limit) { $limit = $heads[$h + 1] - 1 } }
      if (($stop - 1) -lt $limit) { $limit = $stop - 1 }
      W ''
      W '----------------------------------------------------------------------' 'DarkGray'
      W $tail[$start] 'Red'
      for ($i = $start + 1; $i -le $limit; $i++) { W $tail[$i] (Get-FailureColor $tail[$i]) }
    }
  }
} elseif (@($all | Select-String -Pattern '^(Tests|Test Suites):.*\bfailed\b').Count -gt 0) {
  # Jest prints the grouped summary only for a run of more than one suite; a single failing suite prints its
  # failure inline, so "No failing tests" here would contradict the totals below.
  W ''
  W 'Jest printed no failure summary (it does so only for a multi-suite run) -- the failures are in test-output.txt.' 'Yellow'
} elseif (@($all | Select-String -Pattern '^(Tests|Test Suites):').Count -eq 0) {
  W ''
  W 'Jest printed no totals -- read test-output.txt.' 'Yellow'
} else {
  W ''
  W 'No failing tests.' 'Green'
}

W ''
W '======================================================================' 'DarkGray'
$totals = @($all | Select-String -Pattern "^(Tests|Test Suites):")
$totals | ForEach-Object {
  if ($_.Line -match 'failed') { W $_.Line 'Red' } else { W $_.Line 'Green' }
}
W ''
W "Full run: $here\test-output.txt" 'DarkGray'

# The verdict. npm's status decides; the totals can only turn a 0 into a failure, never the other way round.
$failedTotals = @($totals | Where-Object { $_.Line -match '\bfailed\b' })
if ($null -eq $npmExit) {
  $code = 1
  $why = 'npm test did not run (no exit status) -- read test-output.txt'
} elseif ($npmExit -ne 0) {
  $code = [int]$npmExit
  $why = "npm test exited $npmExit"
} elseif ($failedTotals.Count -gt 0) {
  $code = 1
  $why = 'npm test exited 0 but Jest reported failures'
} elseif ($totals.Count -eq 0) {
  $code = 1
  $why = 'npm test exited 0 but printed no Jest totals -- read test-output.txt'
} else {
  $code = 0
  $why = 'npm test exited 0'
}
W ''
if ($code -eq 0) { W "RESULT: PASS ($why)" 'Green' } else { W "RESULT: FAIL ($why); exit $code" 'Red' }
exit $code

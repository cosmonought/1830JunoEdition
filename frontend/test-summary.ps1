# test-summary.ps1 -- run the whole suite, then print ONLY:
#   each failing test's name with the first lines of its failure, then the totals.
#
# Run it like this (works whether or not script execution is enabled):
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Bradshaw\Documents\GitHub\1830Juno\frontend\test-summary.ps1"
#
# Add -Lines 20 at the end for more of each failure.
# The full run is always saved to test-output.txt next to this script, so nothing is lost by trimming.
#
# ASCII ONLY IN THIS FILE, on purpose. Windows PowerShell 5.1 reads a .ps1 without a byte-order mark as the
# system code page, so a Unicode bullet in a comment or a pattern becomes garbage before the parser sees it.
# The bullet Jest prints is matched below by its code point instead.

param([int]$Lines = 12)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# "$_" turns Jest's stderr lines back into plain strings; without it PowerShell paints them red and wraps
# each one in "System.Management.Automation.RemoteException". --silent drops the tests' own console.log
# output, which otherwise buries the failures under debugging prints.
npm test -- --watchAll=false --silent 2>&1 | ForEach-Object { "$_" } | Out-File -Encoding utf8 test-output.txt

$all = Get-Content test-output.txt

# Jest repeats every failure under this heading at the end of the run. That block is grouped and complete,
# so it is the one worth reading.
$summary = $all | Select-String -SimpleMatch "Summary of all failing tests" | Select-Object -First 1

# Each failure header starts with a bullet. Jest emits U+25CF; a console with the wrong code page shows it
# as the three characters U+0393 U+00F9 U+00C5. Match either, by code point, so this file stays ASCII.
$bullet = '^\s*(\u25CF|\u0393\u00F9\u00C5) '

if ($summary) {
  $tail = $all[($summary.LineNumber - 1)..($all.Count - 1)]
  $hits = $tail | Select-String -Pattern $bullet -Context 0, $Lines
  foreach ($hit in $hits) {
    ""
    "----------------------------------------------------------------------"
    $hit.Line
    $hit.Context.PostContext
  }
} else {
  ""
  "No failing tests."
}

""
"======================================================================"
$all | Select-String -Pattern "^(Tests|Test Suites):" | ForEach-Object { $_.Line }

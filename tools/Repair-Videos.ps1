<#
.SYNOPSIS
    Repair and diagnose videos produced by the Miteruno HLS pipeline.

.DESCRIPTION
    Does two separate things, because there are two separate problems:

    1. CONTAINER REPAIR (fixable)
       Output from the in-browser pipeline is fragmented MP4: empty sample
       tables, no sidx/mfra index. Players scan the whole file before playback,
       seeking misbehaves, and transcoders (Plex on mobile/TV) often refuse it.
       `ffmpeg -c copy -movflags +faststart` rebuilds a real index without
       re-encoding. Fast and lossless.

    2. DATA DAMAGE (NOT fixable)
       When a segment failed all its retries, the downloader skipped it and
       carried on, leaving a hole. Playback stalls at that point. No remux can
       recover bytes that were never downloaded - the file must be re-downloaded.

    Use -Scan to tell these apart before spending time on repairs.

.PARAMETER Path
    Directory to process. Defaults to the current directory.

.PARAMETER OutputDir
    Where repaired copies go. Defaults to <Path>\repaired. Ignored with -InPlace.

.PARAMETER InPlace
    Replace originals. Stages to a temp file and swaps only after verification.

.PARAMETER Recurse
    Include subdirectories.

.PARAMETER Scan
    Full decode pass per file to detect missing/corrupt data. Slower (reads
    every byte) but this is what identifies files that must be re-downloaded.

.PARAMETER DryRun
    Report what would happen; change nothing.

.PARAMETER Force
    Overwrite existing outputs instead of skipping them.

.EXAMPLE
    .\Repair-Videos.ps1 "C:\Users\austi\Videos\TV\Rick and Morty\Season 4" -Scan
    Diagnose only - find out which files are damaged before repairing anything.

.EXAMPLE
    .\Repair-Videos.ps1 "C:\Users\austi\Videos" -Recurse
    Repair everything into .\repaired, leaving originals untouched.

.EXAMPLE
    .\Repair-Videos.ps1 "C:\Users\austi\Videos" -InPlace -Recurse
    Repair in place.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Path = ".",

    [string]$OutputDir,

    [switch]$InPlace,
    [switch]$Recurse,
    [switch]$Scan,
    [switch]$DryRun,
    [switch]$Force
)

# Deliberately NOT "Stop": ffmpeg and ffprobe write normal diagnostics to
# stderr, which PowerShell surfaces as error records. With Stop, the first
# such line would abort the whole run. Failures are checked explicitly via
# $LASTEXITCODE instead.
$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------- preflight

function Find-Tool {
    param([string]$Name)

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # winget installs often land here without touching PATH
    $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet"
    if (Test-Path $wingetRoot) {
        $found = Get-ChildItem -Path $wingetRoot -Recurse -Filter "$Name.exe" `
                    -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

$ffmpeg  = Find-Tool "ffmpeg"
$ffprobe = Find-Tool "ffprobe"

if (-not $ffmpeg) {
    Write-Host "ffmpeg not found." -ForegroundColor Red
    Write-Host "  Install:  winget install Gyan.FFmpeg" -ForegroundColor Yellow
    Write-Host "  Then open a NEW PowerShell window (PATH changes need a fresh session)." -ForegroundColor Yellow
    exit 1
}
if (-not $ffprobe) {
    Write-Host "ffprobe not found (ships with ffmpeg) - duration checks disabled." -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    Write-Host "Not a directory: $Path" -ForegroundColor Red
    exit 1
}

$Path = (Resolve-Path -LiteralPath $Path).Path
if (-not $OutputDir) { $OutputDir = Join-Path $Path "repaired" }

# ------------------------------------------------------------------ helpers

function Get-Duration {
    param([string]$File)
    if (-not $ffprobe) { return $null }
    try {
        $raw = & $ffprobe -v error -show_entries format=duration `
                          -of default=noprint_wrappers=1:nokey=1 $File 2>$null
        # ffprobe may emit more than one line; take the first parsable number
        $line = @($raw) | Where-Object { $_ -match '^\s*[\d.]+\s*$' } | Select-Object -First 1
        if ($line) { return [double]$line.Trim() }
    } catch { }
    return $null
}

function Test-DecodeErrors {
    <#
        Full decode pass writing nothing. Any output means the stream itself is
        damaged - i.e. segments are missing. A remux cannot fix this.
    #>
    param([string]$File)
    $errOut = & $ffmpeg -v error -i $File -f null - 2>&1 | Out-String
    return $errOut.Trim()
}

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N0} MB" -f ($Bytes / 1MB) }
    return "{0:N0} KB" -f ($Bytes / 1KB)
}

function Format-Duration {
    param([double]$Seconds)
    if (-not $Seconds) { return "?" }
    $ts = [TimeSpan]::FromSeconds($Seconds)
    if ($ts.Hours -gt 0) { return "{0}h {1}m" -f $ts.Hours, $ts.Minutes }
    return "{0}m {1}s" -f $ts.Minutes, $ts.Seconds
}

# ------------------------------------------------------------- file listing

$extensions = @(".mp4", ".m4v", ".mov", ".mkv", ".ts", ".webm")

$files = Get-ChildItem -LiteralPath $Path -File -Recurse:$Recurse |
    Where-Object { $extensions -contains $_.Extension.ToLower() } |
    Where-Object { $_.DirectoryName -notmatch '\\repaired$' } |
    Sort-Object FullName

if ($files.Count -eq 0) {
    Write-Host "No video files found in $Path"
    exit 0
}

Write-Host ""
Write-Host "Found $($files.Count) file(s) in $Path"
if ($InPlace) {
    Write-Host "Mode: IN-PLACE (originals replaced after verification)" -ForegroundColor Yellow
} else {
    Write-Host "Mode: copy to $OutputDir"
}
if ($Scan)   { Write-Host "Scanning for data damage (full decode pass - slow)" -ForegroundColor Cyan }
if ($DryRun) { Write-Host "DRY RUN - nothing will be written" -ForegroundColor Cyan }
Write-Host ""

if (-not $InPlace -and -not $DryRun) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

# ---------------------------------------------------------------------- work

$results = @()

foreach ($file in $files) {
    $name = $file.Name
    Write-Host ("  {0,-55}" -f $name) -NoNewline

    $srcDuration = Get-Duration $file.FullName
    $damage = $null

    if ($Scan) {
        $damage = Test-DecodeErrors $file.FullName
    }

    # Damaged files are beyond repair - report and move on
    if ($damage) {
        $firstError = ($damage -split "`n" | Select-Object -First 1).Trim()
        Write-Host "DAMAGED" -ForegroundColor Red
        Write-Host "      $firstError" -ForegroundColor DarkGray
        Write-Host "      Missing segments - re-download this one." -ForegroundColor DarkGray
        $results += [pscustomobject]@{
            Name = $name; Status = "Damaged"; Duration = Format-Duration $srcDuration
            Detail = $firstError
        }
        continue
    }

    # Keep the extension when the container can already hold an MP4 index
    $outExt = if (@(".mp4", ".m4v", ".mov") -contains $file.Extension.ToLower()) {
        $file.Extension
    } else { ".mp4" }

    $destDir  = if ($InPlace) { $file.DirectoryName } else { $OutputDir }
    $destPath = Join-Path $destDir ($file.BaseName + $outExt)

    if (-not $InPlace -and -not $Force -and (Test-Path -LiteralPath $destPath)) {
        Write-Host "skipped (exists)" -ForegroundColor DarkGray
        $results += [pscustomobject]@{
            Name = $name; Status = "Skipped"; Duration = Format-Duration $srcDuration; Detail = ""
        }
        continue
    }

    if ($DryRun) {
        Write-Host "would repair -> $destPath" -ForegroundColor Cyan
        $results += [pscustomobject]@{
            Name = $name; Status = "Would repair"; Duration = Format-Duration $srcDuration; Detail = ""
        }
        continue
    }

    # ffmpeg cannot read and write the same path - always stage to a temp file
    $tmpPath = Join-Path $destDir ($file.BaseName + ".remux.tmp" + $outExt)

    & $ffmpeg -nostdin -v error -y -i $file.FullName `
              -c copy -movflags +faststart $tmpPath 2>$null
    $exitCode = $LASTEXITCODE

    if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $tmpPath)) {
        if (Test-Path -LiteralPath $tmpPath) { Remove-Item -LiteralPath $tmpPath -Force }
        Write-Host "FAILED (ffmpeg error)" -ForegroundColor Red
        $results += [pscustomobject]@{
            Name = $name; Status = "Failed"; Duration = Format-Duration $srcDuration
            Detail = "ffmpeg exit $exitCode"
        }
        continue
    }

    # Verify by DURATION, not size: a lossless remux can legitimately shrink a
    # file a lot (MPEG-TS carries heavy packet overhead), so comparing sizes
    # produces false failures.
    $outDuration = Get-Duration $tmpPath
    $durationOk = $true
    if ($srcDuration -and $outDuration) {
        $durationOk = ($outDuration -gt $srcDuration * 0.99) -and
                      ($outDuration -lt $srcDuration * 1.01)
    }

    if (-not $durationOk) {
        Remove-Item -LiteralPath $tmpPath -Force
        Write-Host "FAILED (duration mismatch)" -ForegroundColor Red
        $results += [pscustomobject]@{
            Name = $name; Status = "Failed"; Duration = Format-Duration $srcDuration
            Detail = "in $(Format-Duration $srcDuration) -> out $(Format-Duration $outDuration)"
        }
        continue
    }

    Move-Item -LiteralPath $tmpPath -Destination $destPath -Force
    if ($InPlace -and $file.FullName -ne $destPath) {
        Remove-Item -LiteralPath $file.FullName -Force   # container changed
    }

    $size = (Get-Item -LiteralPath $destPath).Length
    Write-Host ("OK  {0}" -f (Format-Size $size)) -ForegroundColor Green
    $results += [pscustomobject]@{
        Name = $name; Status = "Repaired"; Duration = Format-Duration $srcDuration
        Detail = Format-Size $size
    }
}

# ------------------------------------------------------------------ summary

# Scriptblock form rather than simplified syntax, for widest version support
$repaired = @($results | Where-Object { $_.Status -eq "Repaired" -or $_.Status -eq "Would repair" }).Count
$damaged  = @($results | Where-Object { $_.Status -eq "Damaged" }).Count
$failed   = @($results | Where-Object { $_.Status -eq "Failed" }).Count
$skipped  = @($results | Where-Object { $_.Status -eq "Skipped" }).Count

Write-Host ""
Write-Host "-------------------------------------------------"
Write-Host ("  repaired: {0}" -f $repaired) -ForegroundColor Green
if ($damaged -gt 0) { Write-Host ("  damaged:  {0}  (re-download required)" -f $damaged) -ForegroundColor Red }
if ($failed  -gt 0) { Write-Host ("  failed:   {0}" -f $failed) -ForegroundColor Red }
if ($skipped -gt 0) { Write-Host ("  skipped:  {0}" -f $skipped) -ForegroundColor DarkGray }
Write-Host "-------------------------------------------------"

if ($damaged -gt 0) {
    Write-Host ""
    Write-Host "Files with missing data (a remux cannot fix these):" -ForegroundColor Yellow
    $results | Where-Object { $_.Status -eq "Damaged" } | ForEach-Object {
        Write-Host "  - $($_.Name)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "These stall during playback at the point data goes missing." -ForegroundColor DarkGray
    Write-Host "Re-download them; if segments keep failing, the source server is" -ForegroundColor DarkGray
    Write-Host "likely rate-limiting - retry later or use the External downloader." -ForegroundColor DarkGray
}

if (-not $Scan -and $damaged -eq 0) {
    Write-Host ""
    Write-Host "Tip: re-run with -Scan to detect files with missing data." -ForegroundColor DarkGray
}

Write-Host ""

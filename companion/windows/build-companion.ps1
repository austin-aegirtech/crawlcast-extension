param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ChromeExtensionId,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^$|^[a-p]{32}$')]
    [string]$EdgeExtensionId = '',

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$FfmpegBinDirectory,

    [string]$Version = '0.3.0'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$projectRoot = Resolve-Path (Join-Path $here '..\..')
$hostSource = Join-Path $projectRoot 'native-host\crawlcast_host.py'
$staging = Join-Path $here 'staging'
$dist = Join-Path $here 'dist'

$ffmpeg = Join-Path $FfmpegBinDirectory 'ffmpeg.exe'
$ffprobe = Join-Path $FfmpegBinDirectory 'ffprobe.exe'
foreach ($required in @($hostSource, $ffmpeg, $ffprobe)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file not found: $required"
    }
}

$python = Get-Command py -ErrorAction SilentlyContinue
if (-not $python) {
    throw 'Python launcher "py" was not found. Install Python 3 first.'
}

$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
if (-not $iscc) {
    $defaultIscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    if (Test-Path -LiteralPath $defaultIscc) {
        $iscc = Get-Item $defaultIscc
    } else {
        throw 'ISCC.exe was not found. Install Inno Setup 6 first.'
    }
}

& py -3 -m PyInstaller --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller is missing. Run: py -3 -m pip install pyinstaller'
}

Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $staging 'bin') -Force | Out-Null
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$pyiWork = Join-Path $here '.pyinstaller'
& py -3 -m PyInstaller --noconfirm --clean --onefile --console `
    --name crawlcast_host `
    --distpath $staging `
    --workpath (Join-Path $pyiWork 'build') `
    --specpath $pyiWork `
    $hostSource
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }

Copy-Item -LiteralPath $ffmpeg -Destination (Join-Path $staging 'bin\ffmpeg.exe')
Copy-Item -LiteralPath $ffprobe -Destination (Join-Path $staging 'bin\ffprobe.exe')

$origins = @("chrome-extension://$ChromeExtensionId/")
if ($EdgeExtensionId -and $EdgeExtensionId -ne $ChromeExtensionId) {
    $origins += "chrome-extension://$EdgeExtensionId/"
}

$manifest = [ordered]@{
    name = 'com.crawlcast.downloader'
    description = 'Crawlcast Companion native media processor'
    path = '.\crawlcast_host.exe'
    type = 'stdio'
    allowed_origins = $origins
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content `
    -LiteralPath (Join-Path $staging 'com.crawlcast.downloader.json') `
    -Encoding utf8

@'
Crawlcast Companion includes FFmpeg and FFprobe.
Before distribution, include the license and source-offer notices required by
the exact FFmpeg build you selected. Do not distribute this staging directory
until those obligations have been reviewed and satisfied.
'@ | Set-Content -LiteralPath (Join-Path $staging 'THIRD-PARTY-NOTICES.txt') -Encoding utf8

& $iscc.Source `
    "/DChromeExtensionId=$ChromeExtensionId" `
    "/DEdgeExtensionId=$EdgeExtensionId" `
    "/DCompanionVersion=$Version" `
    (Join-Path $here 'CrawlcastCompanion.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

$installer = Join-Path $dist "Crawlcast-Companion-$Version-Windows-x64.exe"
Write-Host "Built: $installer"

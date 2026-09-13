param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.crawlcast.downloader'
$ManifestPath = Join-Path $PSScriptRoot "$HostName.json"
$LauncherPath = Join-Path $PSScriptRoot 'crawlcast_host.bat'
$HostScriptPath = Join-Path $PSScriptRoot 'crawlcast_host.py'
$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

foreach ($requiredPath in @($ManifestPath, $LauncherPath, $HostScriptPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required native-host file not found: $requiredPath"
    }
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$manifest.name = $HostName
$manifest.path = './crawlcast_host.bat'
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8

New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

Write-Host "Registered native host: $HostName"
Write-Host "Manifest: $ManifestPath"
Write-Host "Allowed extension: $ExtensionId"
Write-Host 'Restart Chrome completely before testing remux.'

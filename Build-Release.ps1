<#
  Builds Squall for Windows and zips it for a GitHub Release.

    ./Build-Release.ps1 -Version 1.4.0

  Output in dist/:
    Squall-win-x64.zip          Squall.exe (self-contained), SquallSwap.exe (the updater) and web/
    Squall-win-x64.zip.sha256   its SHA-256, which Squall checks before it installs an update

  Never in the zip: team.json, state.json, window.json and workspace/ (Storm's own team and data). The updater also
  keeps those files if a zip ever had them.

  Squall.exe is built from host/Squall.csproj (the C# WebView2 host). If that project isn't in the repo yet, this stops
  and says so, because a release without Squall.exe would be useless.
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Out = 'dist',
    [string]$HostProject = 'host/Squall.csproj',
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
Set-Location $root

$v = $Version.Trim().TrimStart('v', 'V')
if ($v -notmatch '^\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?$') { throw "'$Version' isn't a version like 1.4.0 or 1.5.0-beta.1" }
# .NET's file version can't hold "-beta.1": use the numbers only there, and the whole thing as the version Squall reads
$numeric = ($v -split '-')[0]
if ($numeric.Split('.').Count -eq 2) { $numeric += '.0' }

$hostPath = Join-Path $root $HostProject
if (-not (Test-Path $hostPath)) {
    throw "Can't build a release yet: $HostProject isn't in the repo. Push Squall's C# host (the project that builds Squall.exe, with Mobile.cs) into the host/ folder first. See docs/desktop-link.md."
}

$outDir = Join-Path $root $Out
$app = Join-Path $outDir 'Squall'
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $app | Out-Null

$common = @('-c', 'Release', '-r', $Runtime, '--self-contained', 'true', "-p:Version=$numeric", "-p:InformationalVersion=$v", '-p:IncludeSourceRevisionInInformationalVersion=false')

Write-Host "Building Squall.exe $v"
dotnet publish $hostPath @common -o $app
if ($LASTEXITCODE -ne 0) { throw "Building Squall.exe failed." }

Write-Host "Building SquallSwap.exe $v"
dotnet publish (Join-Path $root 'src/SquallSwap/SquallSwap.csproj') @common -p:PublishSingleFile=true -p:PublishTrimmed=true -p:EnableCompressionInSingleFile=true -o (Join-Path $outDir 'swap')
if ($LASTEXITCODE -ne 0) { throw "Building SquallSwap.exe failed." }
Copy-Item (Join-Path $outDir 'swap/SquallSwap.exe') $app -Force
Remove-Item (Join-Path $outDir 'swap') -Recurse -Force

# the window: web/ next to Squall.exe, without backups or private files
$web = Join-Path $app 'web'
New-Item -ItemType Directory -Path $web -Force | Out-Null
Get-ChildItem (Join-Path $root 'web') -File | Where-Object {
    $_.Name -notmatch '\.(bak|log)' -and $_.Name -notmatch '\.(broken|pre)-' -and $_.Name -ne 'farside-demo.json'
} | Copy-Item -Destination $web -Force

foreach ($must in @('Squall.exe', 'SquallSwap.exe', 'web/index.html', 'web/app.js', 'web/link.js', 'web/uno.js', 'web/gif.js')) {
    if (-not (Test-Path (Join-Path $app $must))) { throw "The release is missing $must." }
}
foreach ($never in @('team.json', 'state.json', 'window.json', 'workspace')) {
    $p = Join-Path $app $never
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "Left $never out of the zip (it's Storm's own)." }
}
Get-ChildItem $app -Recurse -Include '*.pdb' | Remove-Item -Force

$zip = Join-Path $outDir 'Squall-win-x64.zip'
Compress-Archive -Path (Join-Path $app '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$zip.sha256" -Value "$hash  Squall-win-x64.zip" -NoNewline -Encoding ascii

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Done: $zip ($mb MB), SHA-256 $hash"

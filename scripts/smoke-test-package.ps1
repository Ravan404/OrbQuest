<#
  Checks the Windows packages build_windows_exe.bat made in release\:
  installs OrbQuest-Setup-<version>.exe silently into a temporary folder,
  starts the installed app with a throw-away library, waits until its server
  answers (and refuses an API call without the window's session), does the
  same for the portable exe, then uninstalls. Used by CI and the Release
  workflow; also runs locally:
      powershell -ExecutionPolicy Bypass -File scripts\smoke-test-package.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$release = Join-Path $root 'release'
$setup = Join-Path $release "OrbQuest-Setup-$version.exe"
$portable = Join-Path $release "OrbQuest-$version.exe"
foreach ($file in @($setup, $portable, (Join-Path $release 'SHA256SUMS.txt'))) {
  if (-not (Test-Path $file)) { throw "Missing $file. Run build_windows_exe.bat first." }
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("orbquest-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null

# The checksums list both files and matches them.
foreach ($line in Get-Content (Join-Path $release 'SHA256SUMS.txt')) {
  $hash, $name = $line -split '\s+', 2
  $actual = (Get-FileHash (Join-Path $release $name) -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash.ToLower()) { throw "SHA256SUMS.txt is wrong for $name" }
}

function Test-Start([string] $exe, [string] $label) {
  $data = Join-Path $work "data-$label"
  New-Item -ItemType Directory -Force $data | Out-Null
  $previous = $env:LOCALAPPDATA
  $env:LOCALAPPDATA = $data
  $env:DQR_UPDATE_CHECK = '0'
  try {
    $process = Start-Process $exe -PassThru
    $log = Join-Path $data 'OrbQuest\backend.log'
    $port = $null
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline -and -not $port) {
      Start-Sleep -Milliseconds 500
      $text = if (Test-Path $log) { Get-Content $log -Raw } else { $null }
      if ($text) {
        $match = [regex]::Match($text, 'Server running at http://127\.0\.0\.1:(\d+)')
        if ($match.Success) { $port = $match.Groups[1].Value }
      }
    }
    if (-not $port) { throw "$label did not start its server. Log: $(if (Test-Path $log) { Get-Content $log -Raw })" }
    try {
      $null = Invoke-WebRequest "http://127.0.0.1:$port/api/profile" -UseBasicParsing
      $status = 200
    } catch {
      $status = [int]$_.Exception.Response.StatusCode
    }
    if ($status -ne 401) { throw "$label answered an API call without the window's session (HTTP $status)." }
    if (-not (Test-Path (Join-Path $data 'OrbQuest\Games'))) { throw "$label did not create its library folder." }
    Write-Host "$label starts, its server is up on port $port and refuses calls without the session."
  } finally {
    Get-Process OrbQuest* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*OrbQuest*" -or $_.Path -like '*_MEI*' } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    $env:LOCALAPPDATA = $previous
    Start-Sleep -Seconds 2
  }
}

try {
  $app = Join-Path $work 'app'
  $install = Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=$app", '/TASKS=' -PassThru -Wait
  if ($install.ExitCode -ne 0) { throw "The installer failed with exit code $($install.ExitCode)." }
  if (-not (Test-Path (Join-Path $app 'OrbQuest.exe'))) { throw 'The installer did not install OrbQuest.exe.' }
  Write-Host "OrbQuest-Setup-$version.exe installs."

  Test-Start (Join-Path $app 'OrbQuest.exe') 'Installed OrbQuest'
  Test-Start $portable "OrbQuest-$version.exe"

  $uninstall = Start-Process (Join-Path $app 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -PassThru -Wait
  Start-Sleep -Seconds 3
  if ($uninstall.ExitCode -ne 0 -or (Test-Path (Join-Path $app 'OrbQuest.exe'))) { throw 'The uninstaller did not remove OrbQuest.' }
  Write-Host 'The uninstaller removes it.'
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

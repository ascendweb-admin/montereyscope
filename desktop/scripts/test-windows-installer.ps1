# Run only on an ephemeral Windows runner or a dedicated disposable account.
# Exercises two distinct versions; does not use the owner's library/credentials.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PreviousInstaller,
  [Parameter(Mandatory=$true)][string]$Installer,
  [Parameter(Mandatory=$true)][string]$PreviousVersion,
  [Parameter(Mandatory=$true)][string]$Version,
  [switch]$DisposableAccount
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This check requires native Windows.' }
if ($env:GITHUB_ACTIONS -ne 'true' -and !$DisposableAccount) {
  throw 'Use a disposable Windows account and pass -DisposableAccount, or run on GitHub Actions.'
}
if ($PreviousVersion -eq $Version) { throw 'Upgrade testing requires two distinct versions.' }
$PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstaller).Path
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$dataRoot = Join-Path $env:LOCALAPPDATA 'scope'
$startLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'scope.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'scope.lnk'
$registryRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$installed = @()
if (Test-Path $registryRoot) {
  $installed = @(Get-ChildItem $registryRoot | Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'scope' })
}
if ((Test-Path $dataRoot) -or (Test-Path $startLink) -or (Test-Path $desktopLink) -or $installed.Count -ne 0) {
  throw 'Refusing to touch an existing Scope installation/profile. Use a fresh disposable account.'
}
$root = Join-Path $env:TEMP ('scope installer Ana P' + [char]0x00e9 + 'rez ' + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $root 'scope'
$exe = Join-Path $installDir 'scope.exe'
$log = Join-Path $dataRoot 'logs\desktop.log'
$report = Join-Path $dataRoot 'data\ai-jobs\installer-fixture\report.html'
$evidence = Join-Path $PSScriptRoot '..\dist\windows-lifecycle'
New-Item -ItemType Directory -Force $root, $evidence | Out-Null
$savedEnvironment = @{}
foreach ($entry in Get-ChildItem Env:) { $savedEnvironment[$entry.Name] = $entry.Value }
$checks = [System.Collections.Generic.List[string]]::new()

function Assert-Check([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
  $checks.Add($Message)
  Write-Host "ok - $Message"
}
function Wait-Until([scriptblock]$Condition, [string]$Message, [int]$Seconds = 90) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out: $Message"
}
function Log-Contains([string]$Text) {
  return (Test-Path $log) -and ([IO.File]::ReadAllText($log).Contains($Text))
}
function Wait-AppExit {
  Wait-Until { @(Get-Process -Name scope -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -eq 0 } 'app and backend shutdown'
}
function Install-App([string]$File) {
  # NSIS requires /D= last, with the path unquoted, even with spaces.
  $process = Start-Process -FilePath $File -ArgumentList "/S /currentuser /D=$installDir" -PassThru
  if (!$process.WaitForExit(120000)) { $process.Kill(); throw 'Installer timed out' }
  Assert-Check ($process.ExitCode -eq 0) 'installer exited successfully'
  Assert-Check (Test-Path $exe) 'selected installation directory contains scope.exe'
  Assert-Check (Test-Path $startLink) 'per-user Start menu shortcut exists'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startLink)
  Assert-Check ($shortcut.TargetPath -eq $exe) 'Start shortcut targets the selected installation directory'
}
function Smoke-Installed([string]$Label, [string]$ExpectedVersion, [bool]$Reopened) {
  if (Test-Path $log) { Remove-Item -LiteralPath $log }
  # Start the actual installed shortcut, preserving the installer-created argv.
  Start-Process -FilePath $startLink
  Wait-Until { Log-Contains 'SCOPE_DESKTOP_SMOKE_WAITING_FOR_SECOND_INSTANCE' } 'first Start launch ready'
  Start-Process -FilePath $startLink
  Wait-Until { Log-Contains 'SCOPE_DESKTOP_SMOKE_OK' } 'second Start launch and packaged checks'
  Wait-AppExit
  Assert-Check (Log-Contains 'SCOPE_DESKTOP_SMOKE_SECOND_INSTANCE_OK') "$Label delivered the second launch to the original instance"
  Assert-Check (Log-Contains "Smoke app version: $ExpectedVersion`n") "$Label runs the expected version $ExpectedVersion"
  Assert-Check ((Log-Contains 'SCOPE_DESKTOP_SMOKE_REOPENED') -eq $Reopened) "$Label database reopen state is correct"
  Copy-Item -LiteralPath $log -Destination (Join-Path $evidence "$Label.log")
}
function Uninstall-App {
  Wait-AppExit
  $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Expected exactly one installed uninstaller' }
  # _?= runs in place: wait for the actual uninstaller, not its temporary launcher.
  $process = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList "/S /currentuser _?=$installDir" -PassThru
  if (!$process.WaitForExit(120000)) { $process.Kill(); throw 'Uninstaller timed out' }
  Assert-Check ($process.ExitCode -eq 0) 'uninstaller exited successfully'
  Assert-Check (!(Test-Path $exe)) 'uninstall removed the application'
  Assert-Check (!(Test-Path $startLink)) 'uninstall removed the Start shortcut'
  Assert-Check (!(Test-Path $desktopLink)) 'uninstall removed the desktop shortcut'
  Assert-Check (Test-Path (Join-Path $dataRoot 'data\localtube.db')) 'uninstall retained the database'
  Assert-Check ((Get-Content -LiteralPath $report -Raw) -eq 'installer retention fixture') 'uninstall retained reports'
}

$passed = $false
try {
  # The installed app uses its real default LOCALAPPDATA data path. Only tools
  # and credentials are isolated; no developer runtimes are available via PATH.
  foreach ($entry in @(Get-ChildItem Env:)) {
    if ($entry.Name -match '^(SCOPE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_|XDG_|ELECTRON_|NODE_|CSC_|WIN_CSC_)') {
      Remove-Item "Env:$($entry.Name)"
    }
  }
  $env:HOME = Join-Path $root 'home'
  $env:USERPROFILE = $env:HOME
  $env:CODEX_HOME = Join-Path $root 'codex'
  $env:CLAUDE_CONFIG_DIR = Join-Path $root 'claude'
  $env:XDG_DATA_HOME = Join-Path $root 'xdg-data'
  $env:PATH = Join-Path $env:SystemRoot 'System32'
  $env:SCOPE_DESKTOP_SMOKE = '1'
  $env:SCOPE_DESKTOP_SMOKE_MINIMAL_PATH = '1'
  $env:SCOPE_DESKTOP_SMOKE_SECOND_INSTANCE = '1'
  Install-App $PreviousInstaller
  Smoke-Installed 'installed-baseline' $PreviousVersion $false
  New-Item -ItemType Directory -Force (Split-Path $report) | Out-Null
  [IO.File]::WriteAllText($report, 'installer retention fixture')
  Assert-Check (Test-Path $desktopLink) 'fresh install creates the optional desktop shortcut'
  Remove-Item -LiteralPath $desktopLink
  Install-App $Installer
  Assert-Check (!(Test-Path $desktopLink)) 'upgrade preserves the deleted desktop shortcut preference'
  Assert-Check ((Get-Content -LiteralPath $report -Raw) -eq 'installer retention fixture') 'upgrade retained reports'
  Smoke-Installed 'upgraded' $Version $true
  Copy-Item -LiteralPath (Join-Path $dataRoot 'data') -Destination (Join-Path $root 'backup') -Recurse
  Uninstall-App
  Install-App $Installer
  Smoke-Installed 'reinstalled' $Version $true
  # Restore a closed-app backup and prove the copied SQLite data can reopen.
  Remove-Item -LiteralPath (Join-Path $dataRoot 'data') -Recurse
  Copy-Item -LiteralPath (Join-Path $root 'backup') -Destination (Join-Path $dataRoot 'data') -Recurse
  Smoke-Installed 'restored-backup' $Version $true
  Uninstall-App
  $passed = $true
} finally {
  if (Test-Path $log) { Copy-Item -LiteralPath $log -Destination (Join-Path $evidence 'last-desktop.log') -Force }
  @{ passed = $passed; previousVersion = $PreviousVersion; version = $Version; checks = @($checks.ToArray());
     os = [Environment]::OSVersion.VersionString; installDirectory = $installDir;
     limitation = 'Silent per-user checks; standard-user UAC UX, SmartScreen, real accounts and browser download require manual validation.'
  } | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $evidence 'results.json')
  foreach ($entry in @(Get-ChildItem Env:)) { Remove-Item "Env:$($entry.Name)" }
  foreach ($name in $savedEnvironment.Keys) { Set-Item "Env:$name" $savedEnvironment[$name] }
  if ($passed) {
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    Remove-Item -LiteralPath $root -Recurse -Force
  } else {
    Write-Host "Failure evidence retained at $evidence; disposable install/profile at $root and $dataRoot"
  }
}

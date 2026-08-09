$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$runScript = Join-Path $projectRoot 'run.ps1'
$desktopLaunchScript = Join-Path $projectRoot 'start-opencode-desktop.ps1'
$openCodeExe = Join-Path $env:LOCALAPPDATA 'Programs\@opencode-aidesktop\OpenCode.exe'
$taskName = 'OpenCode mTLS Sidecar'
$shortcutName = 'OpenCode GB10.lnk'

foreach ($requiredPath in @($runScript, $desktopLaunchScript, $openCodeExe)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required file is missing: $requiredPath"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env.local') -PathType Leaf)) {
  throw 'Missing .env.local. Configure it locally before installing Windows integration.'
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
  throw "Scheduled task already exists: $taskName. It was not overwritten."
}

$powerShellExe = Join-Path $PSHOME 'powershell.exe'
$quotedRunScript = '"' + $runScript + '"'
$taskAction = New-ScheduledTaskAction `
  -Execute $powerShellExe `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedRunScript" `
  -WorkingDirectory $projectRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskTrigger.Delay = 'PT5S'
$taskPrincipal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $taskName `
  -Description 'Starts the loopback-only OpenCode GB10 mTLS sidecar after user logon.' `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -Principal $taskPrincipal `
  -Settings $taskSettings | Out-Null

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath $shortcutName
if (Test-Path -LiteralPath $shortcutPath) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  throw "Desktop shortcut already exists: $shortcutPath. The newly created task was rolled back."
}

$quotedDesktopScript = '"' + $desktopLaunchScript + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellExe
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedDesktopScript"
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$openCodeExe,0"
$shortcut.Description = 'Start OpenCode Desktop with the local GB10 mTLS sidecar'
$shortcut.Save()

Start-ScheduledTask -TaskName $taskName

Write-Output "Scheduled task installed: $taskName"
Write-Output "Desktop shortcut installed: $shortcutPath"

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$runScript = Join-Path $projectRoot 'run-control-panel.ps1'
$desktopLaunchScript = Join-Path $projectRoot 'start-opencode-desktop.ps1'
$controlPanelLaunchScript = Join-Path $projectRoot 'open-control-panel.ps1'
$openCodeExe = Join-Path $env:LOCALAPPDATA 'Programs\@opencode-aidesktop\OpenCode.exe'
$taskName = 'OpenCode mTLS Sidecar'
$shortcutName = 'OpenCode mTLS Sidecar.lnk'
$controlPanelShortcutName = 'OpenCode mTLS Sidecar Control Panel.lnk'

foreach ($requiredPath in @($runScript, $desktopLaunchScript, $controlPanelLaunchScript, $openCodeExe)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required file is missing: $requiredPath"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env.local') -PathType Leaf)) {
  throw 'Missing .env.local. Configure it locally before installing Windows integration.'
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
  -Description 'Starts the loopback-only OpenCode mTLS Sidecar Control Panel after user logon.' `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -Principal $taskPrincipal `
  -Settings $taskSettings `
  -Force | Out-Null

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath $shortcutName
$quotedDesktopScript = '"' + $desktopLaunchScript + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellExe
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedDesktopScript"
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$openCodeExe,0"
$shortcut.Description = 'Start OpenCode Desktop with the local OpenCode mTLS Sidecar'
$shortcut.Save()

$controlPanelShortcutPath = Join-Path $desktopPath $controlPanelShortcutName
$quotedControlPanelScript = '"' + $controlPanelLaunchScript + '"'
$controlShortcut = $shell.CreateShortcut($controlPanelShortcutPath)
$controlShortcut.TargetPath = $powerShellExe
$controlShortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedControlPanelScript"
$controlShortcut.WorkingDirectory = $projectRoot
$controlShortcut.IconLocation = "$openCodeExe,0"
$controlShortcut.Description = 'Open the local OpenCode mTLS Sidecar Control Panel'
$controlShortcut.Save()

Start-ScheduledTask -TaskName $taskName

Write-Output "Scheduled task installed: $taskName"
Write-Output "Desktop shortcut installed: $shortcutPath"
Write-Output "Control Panel shortcut installed: $controlPanelShortcutPath"


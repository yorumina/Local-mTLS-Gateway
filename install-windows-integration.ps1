$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$runScript = Join-Path $projectRoot 'run-control-panel.ps1'
$controlPanelLaunchScript = Join-Path $projectRoot 'open-control-panel.ps1'
$taskName = 'Local mTLS Gateway'
$legacyTaskName = 'OpenCode mTLS Sidecar'
$shortcutName = 'Local mTLS Gateway.lnk'
$legacyShortcutNames = @('OpenCode GB10.lnk', 'Yorumina Sidecar Control.lnk', 'OpenCode mTLS Sidecar.lnk', 'OpenCode mTLS Sidecar Control Panel.lnk')

foreach ($requiredPath in @($runScript, $controlPanelLaunchScript)) {
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
  -Description 'Starts the loopback-only mTLS Control Panel and managed multi-service sidecar after user logon.' `
  -Action $taskAction `
  -Trigger $taskTrigger `
  -Principal $taskPrincipal `
  -Settings $taskSettings `
  -Force | Out-Null

$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath $shortcutName
$quotedControlPanelScript = '"' + $controlPanelLaunchScript + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellExe
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedControlPanelScript"
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "$powerShellExe,0"
$shortcut.Description = 'Start or open the local mTLS gateway control panel'
$shortcut.Save()

foreach ($legacyShortcutName in $legacyShortcutNames) {
  $legacyShortcutPath = Join-Path $desktopPath $legacyShortcutName
  if (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $legacyShortcutPath -Force
  }
}

if ($legacyTaskName -ne $taskName -and (Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue)) {
  Stop-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
}

Start-ScheduledTask -TaskName $taskName

Write-Output "Scheduled task installed: $taskName"
Write-Output "Desktop shortcut installed: $shortcutPath"

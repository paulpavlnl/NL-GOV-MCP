# Werkt de lokale MCP-servers (NL-GOV-MCP en verwijzingscontrole) automatisch bij via scripts\update-local.mjs.
# Draait alleen als de Claude-app dicht is; anders slaat hij deze beurt over.
#   Eenmalig installeren als geplande taak (dagelijks 04:00, ingehaald als de pc uit stond):
#     powershell -ExecutionPolicy Bypass -File scripts\auto-update-mcp.ps1 -Installeer
#   Log: %USERPROFILE%\mcp-lokaal\auto-update.log
param([switch]$Installeer)

$repo  = Split-Path $PSScriptRoot
$basis = Join-Path $env:USERPROFILE 'mcp-lokaal'
$log   = Join-Path $basis 'auto-update.log'
$taak  = 'MCP lokaal bijwerken'

if ($Installeer) {
    $actie = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $trigger = New-ScheduledTaskTrigger -Daily -At 04:00
    $inst = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName $taak -Action $actie -Trigger $trigger -Settings $inst `
        -Description 'Werkt NL-GOV-MCP en verwijzingscontrole bij als Claude dicht is.' -Force | Out-Null
    "Geplande taak '$taak' geinstalleerd op $env:COMPUTERNAME (dagelijks 04:00)."
    return
}

New-Item -ItemType Directory -Force -Path $basis | Out-Null
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $m" -Encoding utf8 }

# Log klein houden: laatste 500 regels.
if ((Test-Path $log) -and (Get-Item $log).Length -gt 200KB) {
    $k = Get-Content $log -Tail 500; Set-Content $log $k -Encoding utf8
}

if (-not (Test-Path (Join-Path $repo 'scripts\update-local.mjs'))) {
    Log "Overgeslagen: $repo\scripts\update-local.mjs niet gevonden."; return
}
if (Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\WindowsApps\Claude_*' -or $_.Path -like '*\AnthropicClaude\*' }) {
    Log 'Overgeslagen: Claude is open.'; return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
Log "Start bijwerken op $env:COMPUTERNAME."
$uit = & $node (Join-Path $repo 'scripts\update-local.mjs') 2>&1 | Where-Object { $_ -notmatch 'DEP0190|trace-deprecation' }
$uit | ForEach-Object { Log "   $_" }
Log "Klaar (exit $LASTEXITCODE)."

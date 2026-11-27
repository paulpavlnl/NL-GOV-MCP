# Komt als C:\mcp\install\funnel-bewaking.ps1 (geplande taak, SYSTEM, elke 2 minuten).
# Draait de waakhond uit de repo; ontbreekt die, dan de oude bewaking (funnel-bewaking.oud.ps1).
$nieuw = 'C:\mcp\repos\nlgov\woonkamer\bewaking.mjs'
if (Test-Path $nieuw) {
  & 'C:\Program Files\nodejs\node.exe' $nieuw
  exit 0
}
& (Join-Path $PSScriptRoot 'funnel-bewaking.oud.ps1')

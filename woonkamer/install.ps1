<#
  Zet alle MCP-servers op deze Windows-pc als Windows-diensten die bij het opstarten meteen starten,
  maakt ze publiek via Tailscale Funnel en werkt ze elk uur bij vanaf GitHub. Opnieuw draaien kan altijd.

  Uitvoeren als administrator:
    powershell -ExecutionPolicy Bypass -File C:\mcp\repos\nlgov\woonkamer\install.ps1

  Geheimen: C:\mcp\secrets\<naam>.json (komen van Render; zie README.md). Ontbreken ze, dan stopt het
  script en zegt welke.
#>
param([switch]$ZonderFunnel)
# Continue: Windows PowerShell 5.1 maakt van elke stderr-regel van git/tailscale anders een afbreekfout.
$ErrorActionPreference = 'Continue'
$Root = 'C:\mcp'
$Hier = $PSScriptRoot
$env:MCP_ROOT = $Root

function Stap($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ververs-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Start dit script als administrator.'
}

Stap 'Mappen'
foreach ($d in 'repos', 'secrets', 'data', 'logs') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }
# Alleen administrators en SYSTEM mogen de geheimen lezen.
icacls (Join-Path $Root 'secrets') /inheritance:r /grant:r 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' | Out-Null

Stap 'Programma''s (winget)'
$pakketten = @(
  @{ id = 'Git.Git'; cmd = 'git' },
  @{ id = 'OpenJS.NodeJS.LTS'; cmd = 'node' },
  @{ id = 'Python.Python.3.12'; cmd = 'python' },
  @{ id = 'NSSM.NSSM'; cmd = 'nssm' }
)
foreach ($p in $pakketten) {
  Ververs-Path
  $gevonden = Get-Command $p.cmd -ErrorAction SilentlyContinue
  if ($p.cmd -eq 'python' -and $gevonden -and $gevonden.Source -like '*WindowsApps*') { $gevonden = $null }
  if ($gevonden) { Write-Host "  $($p.cmd): aanwezig"; continue }
  Write-Host "  $($p.id) installeren..."
  winget install -e --id $p.id --scope machine --silent --accept-package-agreements --accept-source-agreements | Out-Null
  if ($LASTEXITCODE -ne 0) { winget install -e --id $p.id --silent --accept-package-agreements --accept-source-agreements | Out-Null }
}
Ververs-Path
$node = (Get-Command node).Source
$nodeVersie = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeVersie -lt 22) {
  winget upgrade -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Ververs-Path; $node = (Get-Command node).Source
}
$nssm = (Get-Command nssm).Source

Stap 'Git voor de diensten (SYSTEM)'
git config --system --replace-all safe.directory '*'
# Het GitHub-token dat deze gebruiker al heeft, ook voor SYSTEM (de uurlijkse update), zonder iets in te typen.
$credFile = Join-Path $Root 'secrets\git-credentials'
$env:GCM_INTERACTIVE = 'never'
$antwoord = "protocol=https`nhost=github.com`n`n" | git credential fill
$gebruiker = ($antwoord | Where-Object { $_ -like 'username=*' }) -replace '^username=', ''
$token = ($antwoord | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if ($token) {
  Set-Content -Path $credFile -Value "https://$([uri]::EscapeDataString($gebruiker)):$([uri]::EscapeDataString($token))@github.com" -Encoding ascii -NoNewline
  Write-Host '  GitHub-toegang overgenomen.'
} elseif (-not (Test-Path $credFile)) {
  Write-Warning 'Geen opgeslagen GitHub-login gevonden; private repos clonen kan mislukken.'
}
$helper = 'store --file=' + ($credFile -replace '\\', '/')

Stap 'Tailscale'
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) { throw 'Tailscale ontbreekt op deze pc.' }
& $ts set --unattended=true
$self = (& $ts status --json | ConvertFrom-Json).Self
$tsHost = $self.DNSName.TrimEnd('.')
if (-not $tsHost) { throw 'Tailscale is niet aangemeld.' }
Set-Content -Path (Join-Path $Root 'secrets\config.json') -Value (@{ host = $tsHost } | ConvertTo-Json) -Encoding utf8
Write-Host "  Adres: https://$tsHost"

Stap 'Geheimen'
$services = (Get-Content (Join-Path $Hier 'services.json') -Raw | ConvertFrom-Json)
$lokaal = Join-Path $Root 'secrets\services.local.json'
if (Test-Path $lokaal) { $services += (Get-Content $lokaal -Raw | ConvertFrom-Json) }
if (Test-Path (Join-Path $Root 'secrets\render-api-key.txt')) { & $node (Join-Path $Hier 'woonkamer.mjs') render-env }
$ontbreekt = @($services | Where-Object { $_.renderId -and -not (Test-Path (Join-Path $Root "secrets\$($_.name).json")) } | ForEach-Object { $_.name })
if ($ontbreekt.Count) { throw "Geheimen ontbreken voor: $($ontbreekt -join ', '). Zie README.md, stap 'Geheimen'." }

Stap 'Clonen en bouwen'
& $node (Join-Path $Hier 'woonkamer.mjs') setup
if ($LASTEXITCODE -ne 0) { throw 'Clonen of bouwen mislukt; zie hierboven.' }
foreach ($s in $services) {
  $dir = Join-Path $Root "repos\$($s.name)"
  if ($s.repo -and (Test-Path (Join-Path $dir '.git'))) { git -C $dir config credential.helper $helper }
}

Stap 'Windows-diensten (NSSM)'
function Zet-Dienst($naam, $argumenten, $beschrijving) {
  $bestaat = $null -ne (Get-Service $naam -ErrorAction SilentlyContinue)
  if (-not $bestaat) { & $nssm install $naam $node | Out-Null }
  & $nssm set $naam Application $node | Out-Null
  & $nssm set $naam AppParameters $argumenten | Out-Null
  & $nssm set $naam AppDirectory $Hier | Out-Null
  & $nssm set $naam AppEnvironmentExtra "MCP_ROOT=$Root" | Out-Null
  & $nssm set $naam Description $beschrijving | Out-Null
  & $nssm set $naam Start SERVICE_AUTO_START | Out-Null
  & $nssm set $naam AppExit Default Restart | Out-Null
  & $nssm set $naam AppRestartDelay 10000 | Out-Null
  & $nssm set $naam AppStdout (Join-Path $Root "logs\$naam.log") | Out-Null
  & $nssm set $naam AppStderr (Join-Path $Root "logs\$naam.log") | Out-Null
  & $nssm set $naam AppRotateFiles 1 | Out-Null
  & $nssm set $naam AppRotateOnline 1 | Out-Null
  & $nssm set $naam AppRotateBytes 5000000 | Out-Null
  & $nssm restart $naam | Out-Null
  Write-Host "  $naam"
}
$script = Join-Path $Hier 'woonkamer.mjs'
foreach ($s in $services) { Zet-Dienst "mcp-$($s.name)" "`"$script`" run $($s.name)" "MCP-server $($s.titel) (woonkamer)" }
Zet-Dienst 'mcp-proxy' "`"$(Join-Path $Hier 'proxy.mjs')`"" 'Ingang voor de MCP-servers achter Tailscale Funnel (woonkamer)'

Stap 'Tailscale Funnel (publiek https)'
if (-not $ZonderFunnel) {
  & $ts funnel --bg --https=443 http://127.0.0.1:8080
  foreach ($s in $services | Where-Object { $_.funnel }) { & $ts funnel --bg "--https=$($s.funnel)" "http://127.0.0.1:$($s.port)" }
  & $ts funnel status
}

Stap 'Energie: nooit slapen op netstroom'
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Stap 'Elk uur bijwerken vanaf GitHub'
$actie = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c set GCM_INTERACTIVE=never&& set MCP_ROOT=$Root&& `"$node`" `"$script`" update >> `"$Root\logs\update.log`" 2>&1"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(7) -RepetitionInterval (New-TimeSpan -Hours 1)
$instel = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 50) -MultipleInstances IgnoreNew
$wie = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'MCP woonkamer update' -Action $actie -Trigger $trigger -Settings $instel -Principal $wie -Force | Out-Null
Write-Host '  Taak "MCP woonkamer update" staat elk uur.'

Stap 'Controle'
Start-Sleep -Seconds 20
& $node $script status
Write-Host "`nConnector-URL's staan ook in $Root\secrets\urls.txt" -ForegroundColor Green

# Woonkamer: alle MCP-servers op de eigen pc

Alle MCP-servers die op Render draaiden, plus WhatsApp en OneNote van de Surface Book, draaien op de
woonkamer-pc (Windows, altijd aan). Claude.ai bereikt ze via Tailscale Funnel op één vast https-adres:

| Server | Connector-URL (`<host>` = `<pc>.<tailnet>.ts.net`) |
| --- | --- |
| NL-GOV-MCP (Overheidsdata), deelbaar | `https://<host>/nlgov/mcp` |
| Workflowy | `https://<host>/workflowy/mcp?key=<CONNECTOR_TOKEN>` |
| DDS-mail | `https://<host>/mail/mcp?key=<MCP_AUTH_TOKEN>` |
| Studie-literatuur | `https://<host>/studie/mcp/<MCP_PATH_SECRET>` |
| Verwijzingscontrole en LiDO | `https://<host>/verwijzing/mcp/<MCP_PATH_SECRET>` |
| e-Boekhouden | `https://<host>/eboekhouden/mcp/<MCP_AUTH_TOKEN>` (claude.ai bereikt alleen poort 443; :10000 blijft ook werken) |
| Chromebook-tijd (ManicTime Web source) | `https://<host>/chromebook/ws/<SECRET>/timeline` |
| Chromebook-tijd (connector: `chromebook_tijdlijn`, `chromebook_status`) | `https://<host>/chromebook/mcp/<sleutel>`; de sleutel maakt de dienst zelf aan in `C:\mcp\data\chromebook-mcp-sleutel.txt` (`MCP_KEY_FILE`) |
| WhatsApp, OneNote | `https://<host>/whatsapp/...`, `https://<host>/onenote/...` (via `secrets/services.local.json`) |

De ingevulde URL's staan na de installatie in `C:\mcp\secrets\urls.txt` (`node woonkamer.mjs status`).

## Hoe het werkt

- `services.json`: per server de repo, poort, route, installeer-, bouw- en startopdracht.
- `woonkamer.mjs run <naam>`: zo start Windows (NSSM) elke server, met zijn geheimen uit
  `C:\mcp\secrets\<naam>.json`. Elke server is een Windows-dienst `mcp-<naam>` met automatisch starten en
  herstart na een crash; ze draaien zonder dat iemand ingelogd is.
- `proxy.mjs` (dienst `mcp-proxy`, 127.0.0.1:8080): Funnel-poort 443 komt hier binnen en gaat per pad naar de
  juiste server, met het pad zonder voorvoegsel.
- `sessieherstel.mjs` (in de proxy, sinds 20-11-2026): per route één warme MCP-sessie bij de server. `initialize`
  wordt meteen uit het bewaarde antwoord beantwoord en verzoeken zonder geldige sessie (geen sessie-id, of een id
  van vóór een herstart) gaan via de warme sessie in plaats van 400/404. Reden: geplande cloudsessies verbinden
  met alle connectors tegelijk en misten de connectors die eerst nog een sessie moesten opbouwen. De warme
  sessies staan in `C:\mcp\secrets\proxy-warm.json` en komen na een herstart vanzelf terug; `http://127.0.0.1:8080/`
  toont ze per route. Log (`C:\mcp\logs\mcp-proxy.log`): per verzoek `rpc` en `herstel`. Uit: `PROXY_SESSIEHERSTEL=0`.
- Taak "MCP woonkamer update" (SYSTEM, elk uur): nieuwe commits ophalen, installeren/bouwen, dienst herstarten;
  lukt bouwen niet, dan terug naar de vorige versie. Log: `C:\mcp\logs\update.log`.
- Tailscale draait unattended, dus ook na een herstart zonder aanmelding.

## Waakhond (`bewaking.mjs`)

Geplande taak (SYSTEM, elke 2 minuten) start `C:\mcp\install\funnel-bewaking.ps1`, een doorverwijzing
(`bewaking-taak.ps1`) naar `bewaking.mjs` in deze map; ontbreekt die, dan draait de oude bewaking
(`funnel-bewaking.oud.ps1`). Een wijziging hier is dus actief zodra de repo bijgewerkt is.

1. **Diensten:** elke route moet via de proxy lokaal antwoorden (HTTP < 500). Twee rondes achter elkaar niet:
   `Restart-Service` van die dienst (hoogstens eens per 10 minuten). Antwoordt geen enkele route: de proxy.
   NSSM herstart een dienst die stopt al zelf; dit vangt een dienst die draait maar hangt.
2. **Funnel en Tailscale:** relays van buitenaf en `tailscale status`. Gaat het mis, dan per actieve adapter
   met standaardroute een test naar controlplane.tailscale.com. Werkt de ene adapter wel en de andere niet:
   die adapter herstarten (hoogstens eens per 15 minuten), daarna Tailscale (hoogstens eens per 5 minuten;
   zonder werkende adapter eens per 15). Aanleiding: 26/27-11-2026 hing de USB-adapter en raakte Tailscale uitgelogd.
3. **Alarm:** duurt een storing 15 minuten of langer, dan één melding via de projecttaak
   (`C:\mcp\data\claude-taken\taak.json`, zelfde route als het voorfilter), na 6 uur opnieuw; na herstel "opgelost".

Log: `C:\mcp\logs\funnel-bewaking.log`; stand: `C:\mcp\data\bewaking\status.json`. Proberen zonder iets te doen:
`node bewaking.mjs --droog` (testen met `MCP_ROOT`, `WOONKAMER_HOST`, `WOONKAMER_PROXY`). Uit (alleen meten):
bestand `C:\mcp\data\bewaking\uit`. Terug naar de oude bewaking: `funnel-bewaking.oud.ps1` terugkopiëren naar
`funnel-bewaking.ps1` in `C:\mcp\install`.

## Installeren (door Claude Code op de woonkamer-pc)

1. `git clone https://github.com/paulpavlnl/NL-GOV-MCP C:\mcp\repos\nlgov`
2. Geheimen: per service in `services.json` (veld `renderId`) de environment variables uit Render als JSON
   (`{"SLEUTEL": "waarde"}`) in `C:\mcp\secrets\<naam>.json`. Snelst: een Render-API-sleutel in
   `C:\mcp\secrets\render-api-key.txt`; het script haalt dan alles zelf op (`node woonkamer.mjs render-env`).
3. Als administrator: `powershell -ExecutionPolicy Bypass -File C:\mcp\repos\nlgov\woonkamer\install.ps1`
4. Meldt Funnel dat het nog aangezet moet worden: de getoonde link openen en goedkeuren, script opnieuw draaien.

## Een server toevoegen die niet op GitHub staat

Code in `C:\mcp\repos\<naam>`, geheimen in `C:\mcp\secrets\<naam>.json`, en een item in
`C:\mcp\secrets\services.local.json` in dezelfde vorm als `services.json`, zonder `repo` en `renderId`, met een
vrije poort (3110 en hoger) en een `route`. Daarna `install.ps1` opnieuw draaien.

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
| Chromebook-tijd (ManicTime, geen connector) | `https://<host>/chromebook/ws/<SECRET>/timeline` |
| WhatsApp, OneNote | `https://<host>/whatsapp/...`, `https://<host>/onenote/...` (via `secrets/services.local.json`) |

De ingevulde URL's staan na de installatie in `C:\mcp\secrets\urls.txt` (`node woonkamer.mjs status`).

## Hoe het werkt

- `services.json`: per server de repo, poort, route, installeer-, bouw- en startopdracht.
- `woonkamer.mjs run <naam>`: zo start Windows (NSSM) elke server, met zijn geheimen uit
  `C:\mcp\secrets\<naam>.json`. Elke server is een Windows-dienst `mcp-<naam>` met automatisch starten en
  herstart na een crash; ze draaien zonder dat iemand ingelogd is.
- `proxy.mjs` (dienst `mcp-proxy`, 127.0.0.1:8080): Funnel-poort 443 komt hier binnen en gaat per pad naar de
  juiste server, met het pad zonder voorvoegsel.
- Taak "MCP woonkamer update" (SYSTEM, elk uur): nieuwe commits ophalen, installeren/bouwen, dienst herstarten;
  lukt bouwen niet, dan terug naar de vorige versie. Log: `C:\mcp\logs\update.log`.
- Tailscale draait unattended, dus ook na een herstart zonder aanmelding.

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

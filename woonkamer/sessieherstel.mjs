/**
 * Sessieherstel voor MCP-verzoeken (Streamable HTTP) in de woonkamer-proxy.
 *
 * Waarom (20-11-2026): een geplande cloudsessie verbindt bij de start in één keer met alle connectors en
 * wacht daar maar enkele seconden op. Ze begint met een verzoek zonder sessie (server: 400) of met een
 * sessie-id van vóór een herstart of van langer dan een half uur geleden (server: 404), en moet dan nog
 * initialize doen, wat bij de gateways een kindproces start (2 tot 10 s). Wie te laat is, ontbreekt de
 * hele sessie. Daarom houdt de proxy per route één warme sessie bij de server aan en beantwoordt daarmee:
 *   - initialize: meteen, uit het bewaarde antwoord, zonder sessie-id (de client werkt dan sessieloos);
 *   - elk ander verzoek zonder sessie of met een onbekende sessie: via de warme sessie, in plaats van 400/404.
 * Verzoeken met een nog geldige eigen sessie gaan ongewijzigd door.
 * Omdat meer clients de warme sessie delen, krijgt elk verzoek onderweg een eigen id (terug hersteld in het antwoord).
 * Uit: omgevingsvariabele PROXY_SESSIEHERSTEL=0.
 */
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AAN = process.env.PROXY_SESSIEHERSTEL !== "0";
const STANDAARD_VERSIE = "2025-06-18";
const WARM_MS = 2 * 60 * 1000; // ping; korter dan de 30 minuten waarna een gateway een stille sessie sluit
const VERGEET_MS = 48 * 60 * 60 * 1000;
const MAX_BODY = 96 * 1024 * 1024;

const gedeeld = new Map(); // sleutel -> { port, pad, headers, sid, versie, resultaten: Map(versie -> result), gebruikt, bezig }
const verlopen = new Set(); // sessie-ids waarvan de server 404 gaf
let teller = 0;
// Eigen verbindingen zonder keep-alive: een hergebruikte, door de server al gesloten verbinding gaf ECONNRESET.
const agent = new http.Agent({ keepAlive: false });
// Welke warme sessies er waren (route, pad, koppen), zodat ze na een herstart van de proxy of de pc meteen weer warm zijn.
// Staat in de afgeschermde geheimenmap, want pad en koppen kunnen een sleutel bevatten.
const WARM_BESTAND = join(process.env.MCP_ROOT || "C:\mcp", "secrets", "proxy-warm.json");

function bewaar() {
  try {
    const lijst = [...gedeeld].filter(([, e]) => e.resultaten.size).map(([sleutel, e]) => ({ sleutel, route: e.route, port: e.port, pad: e.pad, headers: e.headers, versies: [...e.resultaten.keys()], gebruikt: e.gebruikt }));
    writeFileSync(WARM_BESTAND, JSON.stringify(lijst));
  } catch { /* zonder bestand werkt alles, alleen de eerste start is dan koud */ }
}

/** Leest de body van een verzoek als Buffer (alleen JSON, tot MAX_BODY); anders undefined en de stroom blijft onaangeroerd. */
export function leesBody(req) {
  const soort = String(req.headers["content-type"] || "");
  const lengte = Number(req.headers["content-length"] || 0);
  if (!AAN || req.method !== "POST" || !soort.includes("application/json") || lengte > MAX_BODY) return Promise.resolve(undefined);
  return new Promise((klaar, fout) => {
    const delen = [];
    let n = 0;
    req.on("data", (d) => { n += d.length; if (n <= MAX_BODY) delen.push(d); });
    req.on("end", () => klaar(Buffer.concat(delen)));
    req.on("error", fout);
  });
}

function bericht(body) {
  try {
    const m = JSON.parse(body.toString("utf8"));
    return m && !Array.isArray(m) && m.jsonrpc === "2.0" && typeof m.method === "string" ? m : undefined;
  } catch { return undefined; }
}

function kopHeaders(bron, extra = {}) {
  const h = { ...bron };
  for (const k of ["content-length", "mcp-session-id", "transfer-encoding", "connection"]) delete h[k];
  return { ...h, ...extra };
}

/** Opent een verzoek naar de server; geeft het antwoord (IncomingMessage) zodra de kop binnen is. */
function open(port, pad, method, headers, body, timeoutMs = 0) {
  return new Promise((klaar, fout) => {
    const uit = http.request({ agent, host: "127.0.0.1", port, method, path: pad, headers: body ? { ...headers, "content-length": body.length } : headers }, klaar);
    uit.on("error", fout);
    if (timeoutMs) uit.setTimeout(timeoutMs, () => uit.destroy(new Error("time-out")));
    uit.end(body);
  });
}

async function tekst(antwoord) {
  const delen = [];
  for await (const d of antwoord) delen.push(d);
  return Buffer.concat(delen).toString("utf8");
}

/** Haalt uit een JSON- of SSE-antwoord het JSON-RPC-bericht met dit id. */
function zoekAntwoord(soort, inhoud, id) {
  const kandidaten = String(soort || "").includes("text/event-stream")
    ? inhoud.split(/\r?\n/).filter((r) => r.startsWith("data:")).map((r) => r.slice(5).trim())
    : [inhoud];
  for (const k of kandidaten) {
    try { const m = JSON.parse(k); if (m && m.id === id) return m; } catch { /* volgende */ }
  }
  return undefined;
}

async function rpc(e, method, params, sid, timeoutMs) {
  const id = `wk-${++teller}`;
  const body = Buffer.from(JSON.stringify(params === null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", id, method, params }));
  const headers = kopHeaders(e.headers, { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) });
  const antwoord = await open(e.port, e.pad, "POST", headers, body, timeoutMs);
  const inhoud = await tekst(antwoord);
  return { status: antwoord.statusCode, sid: antwoord.headers["mcp-session-id"], m: params === null ? undefined : zoekAntwoord(antwoord.headers["content-type"], inhoud, id) };
}

/** De warme sessie voor deze sleutel; maakt haar (opnieuw) aan als ze ontbreekt, `vers` is of de versie nog niet bekend is. */
function haal(sleutel, basis, versie, vers = false, eisVersie = true) {
  let e = gedeeld.get(sleutel);
  if (e && !vers && !e.bezig && (eisVersie ? e.resultaten.has(versie) : e.resultaten.size > 0)) { e.gebruikt = Date.now(); return Promise.resolve(e); }
  if (e?.bezig) return e.bezig.then(() => haal(sleutel, basis, versie, false, eisVersie), () => haal(sleutel, basis, versie, false, eisVersie));
  if (!e) { e = { ...basis, resultaten: new Map(), gebruikt: Date.now() }; gedeeld.set(sleutel, e); }
  e.bezig = (async () => {
    const nieuw = !e.resultaten.has(versie);
    try {
      const r = await rpc(e, "initialize", { protocolVersion: versie, capabilities: {}, clientInfo: { name: "woonkamer-proxy", version: "1" } }, undefined, 60_000);
      if (r.status !== 200 || !r.m?.result) throw new Error(`initialize gaf ${r.status}`);
      e.sid = r.sid; e.versie = versie; e.resultaten.set(versie, r.m.result); e.gebruikt = Date.now();
      await rpc(e, "notifications/initialized", null, e.sid, 30_000).catch(() => {});
      if (nieuw) bewaar();
      return e;
    } catch (fout) {
      if (!e.resultaten.size) gedeeld.delete(sleutel);
      throw fout;
    } finally { e.bezig = undefined; }
  })();
  return e.bezig;
}

/** Zet in een SSE-stroom of JSON-antwoord het eigen id terug naar het id van de client. */
function herstelId(antwoord, res, eigen, oorspronkelijk) {
  const terug = (regel) => {
    try { const m = JSON.parse(regel); if (m && m.id === eigen) { m.id = oorspronkelijk; return JSON.stringify(m); } } catch { /* laten staan */ }
    return regel;
  };
  if (String(antwoord.headers["content-type"] || "").includes("text/event-stream")) {
    let rest = "";
    antwoord.setEncoding("utf8");
    antwoord.on("data", (d) => {
      rest += d;
      const regels = rest.split("\n");
      rest = regels.pop();
      if (regels.length) res.write(regels.map((r) => (r.startsWith("data:") ? `data: ${terug(r.slice(5).trim())}${r.endsWith("\r") ? "\r" : ""}` : r)).join("\n") + "\n");
    });
    antwoord.on("end", () => res.end(rest));
  } else {
    tekst(antwoord).then((inhoud) => res.end(terug(inhoud)), () => res.end());
  }
}

function stuurDoor(antwoord, res, eigen, oorspronkelijk) {
  const h = { ...antwoord.headers };
  delete h["mcp-session-id"]; delete h["content-length"]; delete h["transfer-encoding"];
  res.writeHead(antwoord.statusCode || 502, h);
  res.flushHeaders();
  if (eigen === undefined) antwoord.pipe(res); else herstelId(antwoord, res, eigen, oorspronkelijk);
}

/**
 * Behandelt een MCP-verzoek. Geeft { rpc, herstel } terug voor het log; `afgehandeld: false` betekent:
 * de proxy stuurt het verzoek zelf gewoon door (met de al gelezen body).
 */
export async function behandel(req, res, s, pad, body) {
  const sidClient = req.headers["mcp-session-id"];
  const sleutel = `${s.route}|${pad}|${req.headers.authorization || ""}`;
  // GET zonder sessie op een pad met een warme sessie: de client vraagt de losse SSE-stroom; die bieden we sessieloos niet aan.
  if (AAN && req.method === "GET" && !sidClient && String(req.headers.accept || "").includes("text/event-stream") && gedeeld.has(sleutel)) {
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Geen SSE-stroom zonder sessie" }, id: null }));
    return { afgehandeld: true, herstel: "geen-sse" };
  }
  const m = body && bericht(body);
  if (!m) return { afgehandeld: false };
  // server/discover (nieuwere, sessieloze MCP-versie): de servers kennen het niet en zeggen meteen 400; de client valt dan terug op initialize.
  if (m.method === "server/discover") return { afgehandeld: false, rpc: m.method };
  const basis = { route: s.route, port: s.port, pad, headers: kopHeaders(req.headers) };
  try {
    if (m.method === "initialize") {
      const versie = m.params?.protocolVersion || STANDAARD_VERSIE;
      const e = await haal(sleutel, basis, versie);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: e.resultaten.get(versie) }));
      return { afgehandeld: true, rpc: m.method, herstel: "init" };
    }
    if (sidClient && !verlopen.has(sidClient)) {
      const antwoord = await open(s.port, pad, "POST", { ...req.headers }, body);
      if (antwoord.statusCode !== 404) {
        res.writeHead(antwoord.statusCode || 502, antwoord.headers);
        res.flushHeaders();
        antwoord.pipe(res);
        return { afgehandeld: true, rpc: m.method };
      }
      antwoord.resume();
      if (verlopen.size > 5000) verlopen.clear();
      verlopen.add(sidClient);
    }
    const versie = req.headers["mcp-protocol-version"] || gedeeld.get(sleutel)?.versie || STANDAARD_VERSIE;
    for (const vers of [false, true]) {
      const e = await haal(sleutel, basis, versie, vers, false);
      const eigen = e.sid && m.id !== undefined ? `wk-${++teller}` : undefined;
      const uitBody = eigen === undefined ? body : Buffer.from(JSON.stringify({ ...m, id: eigen }));
      const antwoord = await open(s.port, pad, "POST", kopHeaders(req.headers, e.sid ? { "mcp-session-id": e.sid } : {}), uitBody);
      if (!vers && e.sid && antwoord.statusCode === 404) { antwoord.resume(); continue; }
      stuurDoor(antwoord, res, eigen, m.id);
      return { afgehandeld: true, rpc: m.method, herstel: vers ? "vers" : "gedeeld" };
    }
  } catch (fout) {
    if (res.headersSent) { res.end(); return { afgehandeld: true, rpc: m.method, herstel: `fout: ${fout.message}` }; }
    return { afgehandeld: false, rpc: m.method, herstel: `fout: ${fout.message}` };
  }
  return { afgehandeld: false, rpc: m.method };
}

/** Houdt de warme sessies wakker en maakt ze opnieuw aan na een herstart van de server. */
export function houdWarm() {
  if (!AAN) return;
  let bekend = [];
  try { bekend = JSON.parse(readFileSync(WARM_BESTAND, "utf8")); } catch { /* eerste keer */ }
  const opwarmen = async (poging) => {
    let mis = 0;
    for (const b of bekend) {
      if (Date.now() - b.gebruikt > VERGEET_MS) continue;
      for (const versie of b.versies) {
        try { await haal(b.sleutel, { route: b.route, port: b.port, pad: b.pad, headers: b.headers }, versie); } catch { mis += 1; }
      }
    }
    if (mis && poging < 20) setTimeout(() => opwarmen(poging + 1), 30_000).unref();
  };
  if (bekend.length) setTimeout(() => opwarmen(0), 3_000).unref();
  setInterval(async () => {
    for (const [sleutel, e] of gedeeld) {
      if (Date.now() - e.gebruikt > VERGEET_MS) { gedeeld.delete(sleutel); continue; }
      if (e.bezig || !e.sid) continue;
      try {
        const r = await rpc(e, "ping", {}, e.sid, 30_000);
        if (r.status !== 200) await haal(sleutel, e, e.versie, true);
      } catch { /* server is weg; de volgende ronde of het volgende verzoek probeert opnieuw */ }
    }
  }, WARM_MS).unref();
}

export const stand = () => [...gedeeld.values()].map((e) => ({ route: e.route, sessie: Boolean(e.sid), versies: [...e.resultaten.keys()] }));

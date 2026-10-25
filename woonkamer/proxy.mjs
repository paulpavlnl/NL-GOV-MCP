#!/usr/bin/env node
/**
 * Eén ingang voor de servers die een eigen pad krijgen: Tailscale Funnel (poort 443) stuurt alles naar
 * 127.0.0.1:8080, en dit script stuurt /nlgov/... door naar NL-GOV-MCP als /..., /workflowy/... naar
 * Workflowy, enzovoort (services.json, veld route). Streams (SSE) gaan ongebufferd door.
 * OAuth-ontdekking volgens RFC 9728/8414 (/.well-known/<soort>/<route>/...) gaat naar de juiste server.
 */
import http from "node:http";
import { fileURLToPath } from "node:url";
import { services } from "./woonkamer.mjs";

const PORT = Number(process.env.PROXY_PORT || 8080);
const routes = services.filter((s) => s.route);

/** Welke server en welk pad daar: { s, pad } of undefined. */
export function kiesRoute(url) {
  const wk = url.match(/^\/\.well-known\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (wk && wk[2]) {
    const s = routes.find((r) => wk[2] === r.route || wk[2].startsWith(`${r.route}/`));
    if (s) return { s, pad: `/.well-known/${wk[1]}${wk[2].slice(s.route.length)}${wk[3] || ""}` };
  }
  const s = routes.find((r) => url === r.route || url.startsWith(`${r.route}/`) || url.startsWith(`${r.route}?`));
  if (!s) return undefined;
  const rest = url.slice(s.route.length);
  return { s, pad: rest.startsWith("/") ? rest : `/${rest}` };
}

const server = http.createServer((req, res) => {
  const keuze = kiesRoute(req.url || "/");
  if (!keuze) {
    res.writeHead(req.url === "/" ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(req.url === "/" ? { woonkamer: "ok", routes: routes.map((r) => r.route) } : { error: "onbekende route" }));
  }
  const headers = { ...req.headers, "x-forwarded-prefix": keuze.s.route, "x-forwarded-proto": "https" };
  const uit = http.request({ host: "127.0.0.1", port: keuze.s.port, method: req.method, path: keuze.pad, headers }, (antwoord) => {
    res.writeHead(antwoord.statusCode || 502, antwoord.headers);
    res.flushHeaders();
    antwoord.pipe(res);
  });
  uit.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `${keuze.s.name} antwoordt niet (${e.code})` }));
  });
  req.on("aborted", () => uit.destroy());
  res.on("close", () => uit.destroy());
  req.pipe(uit);
});
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, "127.0.0.1", () => console.log(`woonkamer-proxy op 127.0.0.1:${PORT}: ${routes.map((r) => r.route).join(" ")}`));
}

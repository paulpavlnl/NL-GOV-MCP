// FORK (docs/FORK.md): eenmalig inloggen bij Gehoord.de via OAuth (dynamische registratie + PKCE).
// Start een luisteraar op 127.0.0.1:53682, print de autorisatie-URL en wacht op de terugkeer.
// Schrijft client en tokens naar gehoord-oauth.json naast bronsleutels.env (niet in git).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "gehoord-oauth.json");
const BASE = "https://gehoord.de";
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "transcripts:read";
const RESOURCE = `${BASE}/api/mcp`;

const b64 = (b) => b.toString("base64url");
const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();

let client;
const bestaand = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
if (bestaand.client_id) client = { client_id: bestaand.client_id, client_secret: bestaand.client_secret };
else {
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "NL-GOV-MCP (paulpavlnl)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE }),
  });
  if (!r.ok) throw new Error(`registratie ${r.status}: ${await r.text()}`);
  const j = await r.json();
  client = { client_id: j.client_id, client_secret: j.client_secret };
}

const verifier = b64(crypto.randomBytes(32));
const challenge = b64(crypto.createHash("sha256").update(verifier).digest());
const state = b64(crypto.randomBytes(16));
const url = new URL(meta.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE })) url.searchParams.set(k, v);
fs.writeFileSync(path.join(ROOT, "gehoord-autorisatie-url.txt"), url.toString());
console.log("AUTORISATIE_URL " + url.toString());

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (u.searchParams.get("state") !== state) { res.writeHead(400).end("state klopt niet"); return; }
  const code = u.searchParams.get("code");
  if (!code) { res.writeHead(400).end("geen code: " + (u.searchParams.get("error") ?? "")); console.log("FOUT " + u.searchParams.get("error")); server.close(); return; }
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: RESOURCE });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  const t = await fetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const tj = await t.json();
  if (!t.ok) { res.writeHead(500).end("token mislukt"); console.log("FOUT token " + t.status + " " + JSON.stringify(tj)); server.close(); return; }
  fs.writeFileSync(OUT, JSON.stringify({ ...client, token_endpoint: meta.token_endpoint, resource: RESOURCE, access_token: tj.access_token, refresh_token: tj.refresh_token, expires_at: Date.now() + (tj.expires_in ?? 3600) * 1000, scope: tj.scope }, null, 2));
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Gehoord.de gekoppeld aan NL-GOV-MCP. Dit venster mag dicht.");
  console.log("OK tokens opgeslagen, verloopt over " + (tj.expires_in ?? "?") + " s, refresh_token: " + Boolean(tj.refresh_token));
  server.close();
});
server.listen(PORT, "127.0.0.1");
setTimeout(() => { console.log("TIME-OUT"); process.exit(1); }, 15 * 60 * 1000).unref();

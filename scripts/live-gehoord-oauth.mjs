// Live: de drie gehoord-tools via de gebouwde server (stdio), zonder GEHOORD_KEY, met gehoord-oauth.json.
import { spawn } from "node:child_process";
const env = { ...process.env, LOG_LEVEL: "silent" };
delete env.GEHOORD_KEY;
const p = spawn(process.execPath, ["dist/src/index.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const wacht = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const r = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!r.trim()) continue;
    const m = JSON.parse(r);
    wacht.get(m.id)?.(m); wacht.delete(m.id);
  }
});
let id = 0;
const vraag = (method, params) => new Promise((res) => { const n = ++id; wacht.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await vraag("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const toon = async (name, args) => {
  const m = await vraag("tools/call", { name, arguments: args });
  const s = m.result?.structuredContent ?? JSON.parse(m.result?.content?.[0]?.text ?? "{}");
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  console.log("summary:", s.summary ?? s.error, s.message ?? "");
  for (const r of (s.records ?? []).slice(0, 2)) console.log(" -", r.title, "|", r.canonical_url, "|", (r.snippet ?? "").slice(0, 120).replace(/\n/g, " "));
  console.log("note:", (s.access_note ?? "").slice(0, 200));
  return s;
};
const l = await toon("gehoord_debatten_list", { top: 3 });
await toon("gehoord_debatten_search", { query: "stikstof", top: 2 });
const deb = l.records?.find((r) => r.data?.debat_id)?.data?.debat_id;
await toon("gehoord_debatten_list", { status: "ended", top: 1 }).then(async (e) => {
  const d = e.records?.[0]?.data?.debat_id ?? deb;
  if (d) await toon("gehoord_debat_get", { debate_id: d });
});
await toon("nl_gov_ask", { question: "Wat wordt er vandaag in de Tweede Kamer gezegd over stikstof?" });
p.kill();
process.exit(0);

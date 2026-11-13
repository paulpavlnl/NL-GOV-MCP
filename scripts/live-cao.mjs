// Live: cao_zoeken, cao_tekst en cao_avv via de gebouwde server (stdio).
// Gebruik: node scripts/live-cao.mjs [zoekterm] [artikel] [tekstzoekterm]
import { spawn } from "node:child_process";
const zoekterm = process.argv[2] ?? "metalektro";
const p = spawn(process.execPath, ["dist/src/index.js"], { env: { ...process.env, LOG_LEVEL: "silent" }, stdio: ["pipe", "pipe", "ignore"] });
let buf = "";
const wacht = new Map();
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const r = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!r.trim().startsWith("{")) continue;
    const m = JSON.parse(r);
    wacht.get(m.id)?.(m); wacht.delete(m.id);
  }
});
let n = 0;
const vraag = (method, params) => new Promise((res) => { const k = ++n; wacht.set(k, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n"); });
const roep = async (name, args) => {
  const m = await vraag("tools/call", { name, arguments: args });
  const s = m.result?.structuredContent ?? JSON.parse(m.result?.content?.[0]?.text ?? "{}");
  console.log(`\n=== ${name} ${JSON.stringify(args)}\n${s.summary ?? `${s.error}: ${s.message}`}`);
  return s;
};
await vraag("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const z = await roep("cao_zoeken", { zoekterm, zonder_wijzigingen: true, top: 5 });
for (const r of z.records ?? []) console.log(" -", r.data.id, "|", r.title);
const id = z.records?.find((r) => r.data.type === "Regulier")?.data.id ?? z.records?.[0]?.data.id;
if (id) {
  const t = await roep("cao_tekst", { id });
  console.log(JSON.stringify(t.records?.[0]?.data).slice(0, 500));
  const a = await roep("cao_tekst", { id, artikel: process.argv[3] ?? "1" });
  for (const r of (a.records ?? []).slice(1, 3)) console.log(" p.", r.data.pagina, "|", r.data.tekst.slice(0, 300).replace(/\n/g, " / "));
  const w = await roep("cao_tekst", { id, zoekterm: process.argv[4] ?? "vakantie" });
  for (const r of (w.records ?? []).slice(1, 3)) console.log(" p.", r.data.pagina, "|", r.data.tekst.slice(0, 200).replace(/\n/g, " / "));
  const v = await roep("cao_avv", { id, top: 5 });
  for (const r of v.records ?? []) console.log(" -", r.date, r.data.soort, "|", r.title.slice(0, 160), "|", r.canonical_url);
}
p.kill();
process.exit(0);

// Live: rechter_profiel via de gebouwde server (stdio). Gebruik: node scripts/live-rechterprofiel.mjs "<naam>" [id]
import { spawn } from "node:child_process";
const naam = process.argv[2] ?? "Sleeswijk Visser";
const id = process.argv[3];
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
await vraag("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const m = await vraag("tools/call", { name: "rechter_profiel", arguments: id ? { id } : { naam } });
const s = m.result?.structuredContent ?? JSON.parse(m.result?.content?.[0]?.text ?? "{}");
console.log(s.summary ?? `${s.error}: ${s.message}`);
for (const r of (s.records ?? []).slice(0, 30)) console.log(" -", r.title, "|", r.data?.status ?? r.data?.id ?? "", "|", r.data?.rol ?? "", "|", r.data?.binnen_loopbaan ?? "");
const kop = s.records?.[0]?.data;
if (kop?.huidige_functies) console.log(JSON.stringify({ huidig: kop.huidige_functies, eerder: kop.eerdere_functies?.length, neven: kop.nevenbetrekkingen, geen: kop.vervult_geen_nevenbetrekkingen, term: kop.zoekterm_uitspraken }));
p.kill();
process.exit(0);

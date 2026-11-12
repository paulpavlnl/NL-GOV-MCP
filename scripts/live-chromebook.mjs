// Live: chromebook_status en chromebook_tijdlijn via de gebouwde server (stdio).
// Gebruik: node scripts/live-chromebook.mjs [van] [tot]
import { spawn } from "node:child_process";
const van = process.argv[2] ?? "2026-11-12T15:50:00";
const tot = process.argv[3] ?? "2026-11-12T17:20:00";
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
let id = 0;
const vraag = (method, params) => new Promise((res) => { const n = ++id; wacht.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
await vraag("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
for (const [name, args] of [["chromebook_status", {}], ["chromebook_tijdlijn", { van, tot }]]) {
  const m = await vraag("tools/call", { name, arguments: args });
  const s = m.result?.structuredContent ?? JSON.parse(m.result?.content?.[0]?.text ?? "{}");
  console.log(`\n=== ${name}`, s.summary ?? `${s.error}: ${s.message}`);
  for (const r of (s.records ?? []).slice(0, 40)) console.log(" ", r.title.slice(0, 110));
}
p.kill();
process.exit(0);

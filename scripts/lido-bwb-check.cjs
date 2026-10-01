// Handmatige live-check: wetten_bwb_search en lido_relations_by_identifier via stdio tegen de gebouwde server.
// Gebruik: node scripts/lido-bwb-check.cjs
const { spawn } = require('child_process');
const path = require('path');

const calls = [
  ['wetten_bwb_search', { query: 'jeugdwet', top: 5 }],
  ['wetten_bwb_search', { query: 'participatiewet', top: 3 }],
  ['lido_relations_by_identifier', { identifier: 'BWBR0040635' }],
  ['lido_relations_by_identifier', { identifier: 'BWBR0005537 artikel 1:7' }],
  ['lido_relations_by_identifier', { identifier: 'https://linkeddata.overheid.nl/front/portal/linktool-bwb-verfijnen?ext-id=http%3A%2F%2Fwetten.overheid.nl%2Fid%2FBWBR0005537%2F2026-08-15%2F0%2FHoofdstuk1%2FTiteldeel1.2%2FArtikel1%3A7&geldigheidsdatum=2026-08-15&zichtdatum=2026-08-15' }],
  ['lido_relations_by_identifier', { identifier: 'ECLI:NL:RBZWB:2026:8174' }],
  ['lido_relations_by_identifier', { identifier: 'BWBR0002656 artikel 1:247' }],
  ['bwb_artikel_tekst', { bwbId: 'BWBR0005537', artikel: '3:4' }],
  ['bwb_artikel_tekst', { bwbId: 'BWBR0005290', artikel: '7:658' }],
];

const p = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'src', 'index.js')], { env: { ...process.env, MCP_TRANSPORT: 'stdio', LOG_LEVEL: 'warn' }, windowsHide: true });
let buf = '';
const pending = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); pending.get(m.id)?.(m); } catch {}
  }
});
p.stderr.on('data', () => {});
const call = (id, method, params) => new Promise((res) => { pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

(async () => {
  await call(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  let id = 1;
  for (const [name, args] of calls) {
    const t = Date.now();
    const r = await call(id++, 'tools/call', { name, arguments: args });
    const o = JSON.parse(r.result.content[0].text);
    const label = `${name} ${JSON.stringify(args).slice(0, 70)}`;
    if (name === 'bwb_artikel_tekst') {
      const a = o.records?.[0]?.data;
      console.log(`${label}\n   ${Date.now() - t} ms: ${a ? `${a.titel_regeling} ${a.kop} (label ${a.label_id}, inwerking ${a.inwerking}) ${a.tekst.slice(0, 60)}` : `niet gevonden: ${o.summary}`}`);
    } else if (name === 'wetten_bwb_search') {
      console.log(`${label}\n   ${Date.now() - t} ms: ${o.records.map((x) => `${x.data.identifier} [${x.data.type}] ${x.data.title}`).join(' | ')}`);
    } else {
      const d = o.records?.[0]?.data ?? {};
      const ids = d.discoveredIdentifiers ?? d.discovered_identifiers ?? {};
      console.log(`${label}\n   ${Date.now() - t} ms: gemeld ${d.reportedOutgoingRelations ?? '?'} uit / ${d.reportedIncomingRelations ?? '?'} in, gelezen ${d.relationsExtracted} relaties, ${d.relationPagesFetched} lijstpagina's, ECLI's ${ids.eclis?.length ?? 0}, BWBR's ${ids.bwbrs?.length ?? 0}, gedeeltelijk=${d.partialResult}, stop=${d.stopReason}${d.viewer_note ? `\n   noot: ${d.viewer_note}` : ''}${o.error ? `\n   FOUT: ${JSON.stringify(o.error).slice(0, 200)}` : ''}`);
    }
  }
  p.kill();
})();

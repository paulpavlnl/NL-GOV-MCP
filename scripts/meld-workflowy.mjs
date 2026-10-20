#!/usr/bin/env node
/**
 * Een melding in de Workflowy-Inbox (de dagronde leest die): een afvinkbare taak met de details in de notitie.
 * Gebruikt door de nachtelijke update (scripts/nachtelijke-update.mjs) en de GitHub-workflow Upstream sync.
 * Sleutel: WORKFLOWY_API_KEY (omgeving, of bronsleutels.env in de privé-repo naast deze map). Geen
 * afhankelijkheden, zodat het ook werkt als node_modules of dist stuk is.
 *
 *   node scripts/meld-workflowy.mjs "titel" "notitie"
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hier = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** WORKFLOWY_API_KEY uit de omgeving of uit bronsleutels.env naast deze repo. */
export function workflowySleutel(env = process.env) {
  if (env.WORKFLOWY_API_KEY?.trim()) return env.WORKFLOWY_API_KEY.trim();
  for (const d of ["verwijzingscontrole", "verwijzingscontrole-en-uitbreiding"]) {
    const f = join(hier, "..", d, "bronsleutels.env");
    if (!existsSync(f)) continue;
    const m = /^\s*WORKFLOWY_API_KEY\s*=\s*(\S+)/m.exec(readFileSync(f, "utf8"));
    if (m) return m[1];
  }
  return undefined;
}

const html = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Zet een taak in de Inbox. Geeft { ok, id? , fout? }; gooit nooit. */
export async function meldWorkflowy({ titel, notitie = "", parent = "inbox", sleutel = workflowySleutel(), fetchFn = fetch, timeoutMs = 20_000 }) {
  if (!sleutel) return { ok: false, fout: "geen WORKFLOWY_API_KEY" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchFn("https://workflowy.com/api/v1/nodes", {
      method: "POST", signal: ctrl.signal,
      headers: { Authorization: `Bearer ${sleutel}`, "Content-Type": "application/json" },
      body: JSON.stringify({ parent_id: parent, name: html(titel).slice(0, 400), note: String(notitie).slice(0, 8000), data: { layoutMode: "todo" } }),
    });
    const tekst = await r.text();
    if (!r.ok) return { ok: false, fout: `Workflowy HTTP ${r.status}: ${tekst.slice(0, 200)}` };
    let id; try { const j = JSON.parse(tekst); id = j?.item_id ?? j?.id; } catch { /* geen json */ }
    return { ok: true, id };
  } catch (e) { return { ok: false, fout: e instanceof Error ? e.message : String(e) }; }
  finally { clearTimeout(t); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [titel, notitie] = process.argv.slice(2);
  const r = await meldWorkflowy({ titel: titel ?? "Melding", notitie: notitie ?? "" });
  console.log(r.ok ? `Gemeld in Workflowy (${r.id ?? "ok"}).` : `Melding mislukt: ${r.fout}`);
  process.exitCode = r.ok ? 0 : 1;
}

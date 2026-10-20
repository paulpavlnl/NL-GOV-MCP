/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Guard against model mistakes when looking up legal sources.
 *
 * For bwb_artikel_tekst, wetten_bwb_tekst, wetten_bwb_search (with an artikel in the query),
 * rechtspraak_get_by_ecli and rechtspraak_uitspraak_get the result gets, next to what the tool
 * already returns:
 *  - diagnose (when the lookup gave nothing or failed): wet_onbekend (with suggesties),
 *    artikel_bestaat_niet_in_geldende_versie (with vervallen_per and the wijzigingswet, from the BWB's
 *    wetstechnische informatie), artikel_bestond_nooit, ecli_onbekend, ecli_zonder_tekst or toolfout.
 *    "We do not have the source" (toolfout) versus "what was asked does not exist" is the point.
 *  - geldigheid on the peildatum: geldend, vervallen (datum), gewijzigd_sinds_peildatum (datum) or
 *    nog_niet_in_werking.
 *  - bekende_valkuil: a provision often cited while repealed or renumbered (data/bekende-valkuilen.json,
 *    the same file as in the verwijzingscontroleur), with opvolger and overgangsrecht.
 * Every call is counted and every deviating outcome logged (src/fork/foutlog.ts).
 *
 * Installed with one line in src/server.ts (FORK) before registerTools: it wraps server.registerTool,
 * so the tools in src/tools.ts stay as they are.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { getText } from "../utils/http.js";
import { BwbArtikelSource } from "../sources/bwb-artikel.js";
import { WettenBwbSource, todayAmsterdam } from "../sources/wetten-bwb.js";
import { findServerRoot } from "../load-env.js";
import { WTI_URL } from "./wetsgeschiedenis.js";
import { foutlog } from "./foutlog.js";

/* ---------- bekende valkuilen ---------- */

export interface Valkuil {
  bwb_id: string; wet: string; artikel: string; soort: string; vervallen_per?: string; uitleg: string;
  wijzigingswet?: unknown; inwerkingtreding?: unknown; opvolger?: unknown; overgangsrecht?: unknown; gecontroleerd_op?: string;
}
let valkuilen: Valkuil[] | undefined;
export function laadValkuilen(bestand?: string): Valkuil[] {
  const root = findServerRoot(dirname(fileURLToPath(import.meta.url)));
  const f = bestand ?? (root ? join(root, "data", "bekende-valkuilen.json") : "");
  try { valkuilen = f && existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).valkuilen ?? []) : []; }
  catch (e) { process.stderr.write(`[hallucinatie] bekende-valkuilen.json niet gelezen: ${(e as Error).message}\n`); valkuilen = []; }
  return valkuilen!;
}
const normArt = (a: unknown) => String(a ?? "").trim().toLowerCase().replace(/^(?:artikel|art\.?)\s*/, "").replace(/\s+/g, "").replace(/(lid|sub|onder).*$/, "");

/** A wet named by title or afkorting in the valkuilen file ("Rv"), also when the BWB cannot be reached. */
export function valkuilId(wet: unknown): string | undefined {
  const w = String(wet ?? "").trim().toLowerCase();
  if (!w) return undefined;
  return (valkuilen ?? laadValkuilen()).find((x) => [x.wet, (x as { afkorting?: string }).afkorting].some((n) => n && n.toLowerCase() === w))?.bwb_id;
}

export function zoekValkuil(bwbId: unknown, artikel: unknown) {
  const lijst = valkuilen ?? laadValkuilen();
  const id = String(bwbId ?? "").toUpperCase(), a = normArt(artikel), kort = a.includes(":") ? a.split(":").pop()! : a;
  const v = lijst.find((x) => x.bwb_id === id && [a, kort].includes(normArt(x.artikel)));
  if (!v) return undefined;
  return {
    soort: v.soort, artikel: v.artikel, wet: v.wet, ...(v.vervallen_per ? { vervallen_per: v.vervallen_per } : {}), uitleg: v.uitleg,
    wijzigingswet: v.wijzigingswet, ...(v.inwerkingtreding ? { inwerkingtreding: v.inwerkingtreding } : {}), opvolger: v.opvolger, overgangsrecht: v.overgangsrecht, gecontroleerd_op: v.gecontroleerd_op,
    let_op: "Haal dit artikel niet aan als geldend recht. Controleer of de zaak onder het overgangsrecht valt; zo niet, verwijs naar de opvolger.",
  };
}

/* ---------- WTI: did the article ever exist? ---------- */

export interface WtiVersie { datum: string; betreft: string; staatsblad: string[]; dossiers: string[] }
/** The versions of one article in the wetstechnische informatie (WTI), by its label ("Artikel 843a"), newest first. */
export function wtiVersies(wti: string, artikel: string): WtiVersie[] {
  const a = normArt(artikel), kort = a.includes(":") ? a.split(":").pop()! : a;
  const labels = new Set([a, kort].map((x) => `artikel ${x}`));
  const uit: WtiVersie[] = [];
  for (const d of wti.matchAll(/<datum waarde="([^"]+)"[^>]*\blabel="([^"]+)"[^>]*>([\s\S]*?)<\/datum>/g)) {
    if (!labels.has(d[2].trim().toLowerCase().replace(/\s+/g, " "))) continue;
    uit.push({
      datum: d[1], betreft: /<betreft>([^<]+)<\/betreft>/.exec(d[3])?.[1]?.trim() ?? "",
      staatsblad: [...new Set([...d[3].matchAll(/urlidentifier="([^"]+)"/g)].map((m) => m[1]))],
      dossiers: [...new Set([...d[3].matchAll(/<dossiernummer>([^<]+)<\/dossiernummer>/g)].map((m) => m[1].trim()))],
    });
  }
  return uit.sort((x, y) => y.datum.localeCompare(x.datum));
}
const sbUrl = (s: string) => `https://zoek.officielebekendmakingen.nl/${s}.html`;

export type Diagnose = Record<string, unknown> & { code: string; uitleg: string };

export function artikelDiagnose(a: { wet?: string; bwbId: string; artikel: string; peildatum: string; status?: string; inwerking?: string; bron?: string; versies?: WtiVersie[] | null; wtiFout?: string }): Diagnose {
  const basis = { wet: a.wet, bwb_id: a.bwbId, artikel: a.artikel, peildatum: a.peildatum };
  if (a.status === "vervallen") {
    const sb = a.bron ? String(a.bron).replace(/^Stb\.?\s*(\d{4})[-,\s]+(\d+)$/i, "stb-$1-$2") : undefined;
    return { code: "artikel_bestaat_niet_in_geldende_versie", ...basis, vervallen_per: a.inwerking, ...(sb ? { wijzigingswet: [{ vindplaats: a.bron, url: sbUrl(sb) }] } : {}),
      uitleg: `Artikel ${a.artikel} staat in de geldende tekst alleen als 'Vervallen'${a.inwerking ? ` (sinds ${a.inwerking})` : ""}. De laatste tekst: peildatum vóór die datum; de opvolger staat in de wijzigingswet.` };
  }
  const v = a.versies;
  if (v && v.length) {
    const eerste = [...v].reverse().find((x) => /nieuw/i.test(x.betreft)) ?? v[v.length - 1];
    if (eerste && eerste.datum > a.peildatum) {
      return { code: "artikel_bestaat_niet_in_geldende_versie", ...basis, nog_niet_in_werking: true, in_werking_per: eerste.datum, wijzigingswet: eerste.staatsblad.map((s) => ({ vindplaats: s, url: sbUrl(s) })), uitleg: `Artikel ${a.artikel} bestaat pas sinds ${eerste.datum}; op de peildatum ${a.peildatum} gold het nog niet.` };
    }
    const w = v.find((x) => /vervall|intrekking|ingetrokken|vernummer/i.test(x.betreft)) ?? v[0];
    return { code: "artikel_bestaat_niet_in_geldende_versie", ...basis, vervallen_per: w.datum, betreft: w.betreft, wijzigingswet: w.staatsblad.map((s) => ({ vindplaats: s, url: sbUrl(s) })),
      ...(w.dossiers.length ? { kamerstukken: w.dossiers.map((d) => `https://zoek.officielebekendmakingen.nl/dossier/${d}`) } : {}),
      uitleg: `Artikel ${a.artikel} heeft in deze regeling bestaan (vanaf ${eerste?.datum ?? "onbekend"}), maar staat niet in de versie die op ${a.peildatum} geldt; ${/vervall|intrek/i.test(w.betreft) ? "vervallen" : w.betreft || "laatst gewijzigd"} per ${w.datum}${w.staatsblad.length ? ` (${w.staatsblad.join(", ")})` : ""}. Zoek de opvolger in de wijzigingswet; wetsgeschiedenis_get geeft de Kamerstukken.`,
      versies: v.slice(0, 6) };
  }
  if (v) return { code: "artikel_bestond_nooit", ...basis, uitleg: `Artikel ${a.artikel} komt in geen enkele versie van ${a.wet ?? a.bwbId} voor (wetstechnische informatie van de BWB): waarschijnlijk een verkeerd nummer of een verkeerde wet.` };
  return { code: "artikel_bestaat_niet_in_geldende_versie", ...basis, onzeker: true, uitleg: `Artikel ${a.artikel} staat niet in de versie die op ${a.peildatum} geldt. Of het eerder bestond, kon niet worden nagegaan${a.wtiFout ? ` (wetstechnische informatie: ${a.wtiFout})` : ""}.` };
}

export function toolfout(melding: string): Diagnose {
  return { code: "toolfout", foutmelding: melding.slice(0, 500), uitleg: "De bron kon niet worden geraadpleegd (netwerk, time-out of bronserver). Dit zegt niets over het bestaan van de verwijzing: probeer het later opnieuw." };
}

export interface ArtikelStand { status?: string; inwerking?: string; bron?: string }
/** geldend | vervallen | gewijzigd_sinds_peildatum | nog_niet_in_werking. op: on the peildatum; nu: today (null = no longer there). */
export function geldigheid(op: ArtikelStand | undefined, nu: ArtikelStand | null | undefined, peildatum: string, vandaag: string): Record<string, unknown> | undefined {
  if (!op) return undefined;
  if (op.status === "nogniet") return { status: "nog_niet_in_werking", peildatum, ...(op.inwerking ? { in_werking_per: op.inwerking } : {}) };
  if (op.status === "vervallen") return { status: "vervallen", peildatum, ...(op.inwerking ? { datum: op.inwerking } : {}) };
  if (peildatum < vandaag) {
    if (nu === null) return { status: "vervallen", peildatum, toelichting: "Staat niet meer in de geldende versie." };
    if (nu?.status === "vervallen") return { status: "vervallen", peildatum, ...(nu.inwerking ? { datum: nu.inwerking } : {}), toelichting: `Gold op ${peildatum}, maar is daarna vervallen.` };
    if (nu?.inwerking && op.inwerking && nu.inwerking > op.inwerking) return { status: "gewijzigd_sinds_peildatum", peildatum, datum: nu.inwerking, ...(nu.bron ? { gewijzigd_bij: nu.bron } : {}), toelichting: `De tekst die op ${peildatum} gold, is per ${nu.inwerking} gewijzigd.` };
  }
  return { status: "geldend", peildatum, ...(op.inwerking ? { tekst_sinds: op.inwerking } : {}) };
}

/* ---------- the guard ---------- */

type ToolPayload = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; [k: string]: unknown };
type Result = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Toevoeging = { diagnose?: Diagnose; geldigheid?: Record<string, unknown>; bekende_valkuil?: ReturnType<typeof zoekValkuil>; verwijzing: string; peildatum?: string };

const TOOLFOUT_SOORTEN = new Set(["timeout", "http_error", "rate_limited", "malformed_response", "circuit_open"]);
const STATUS: Record<string, string> = { geldend: "goed", vervallen: "vervallen", "nog niet in werking": "nogniet", goed: "goed", nogniet: "nogniet" };
const isVervallenTekst = (t: unknown) => /^Artikel\s+\S+\s*\n\s*Vervallen\.?\s*$/i.test(String(t ?? "").trim());

const BESCHRIJVING = " Bij een lege of mislukte opzoeking: diagnose.code = wet_onbekend (met suggesties), artikel_bestaat_niet_in_geldende_versie (met vervallen_per en wijzigingswet), artikel_bestond_nooit (waarschijnlijk verkeerd nummer), ecli_onbekend, ecli_zonder_tekst of toolfout (de bron was niet bereikbaar: zegt niets over het bestaan).";
const BESCHRIJVING_WET = " geldigheid op de peildatum: geldend, vervallen (datum), gewijzigd_sinds_peildatum (datum) of nog_niet_in_werking. bekende_valkuil: een bepaling die vaak verkeerd wordt aangehaald (bijv. art. 843a Rv, vervallen per 1-1-2025), met opvolger en overgangsrecht.";

export function createHallucinatieAnalyse(config = loadConfig()) {
  const bwbArtikel = new BwbArtikelSource(config);
  const wettenBwb = new WettenBwbSource(config);
  const wtiCache = new Map<string, { xml: string; tot: number }>();
  async function wti(bwbId: string) {
    const c = wtiCache.get(bwbId);
    if (c && c.tot > Date.now()) return c.xml;
    const { data } = await getText(WTI_URL(bwbId), { connector: "wetten_bwb", timeoutMs: 60_000, maxResponseBytes: 80_000_000 });
    wtiCache.set(bwbId, { xml: data, tot: Date.now() + 3_600_000 });
    if (wtiCache.size > 20) wtiCache.delete(wtiCache.keys().next().value as string);
    return data;
  }
  async function nietInVersie(wet: string | undefined, bwbId: string, artikel: string, peildatum: string) {
    let versies: WtiVersie[] | null = null, wtiFout: string | undefined;
    try { versies = wtiVersies(await wti(bwbId), artikel); } catch (e) { wtiFout = (e as Error).message; }
    return artikelDiagnose({ wet, bwbId, artikel, peildatum, versies, wtiFout });
  }
  async function suggesties(wet: string) {
    try {
      const woorden = wet.split(/\s+/).filter((w) => w.length > 3);
      const out = await wettenBwb.search({ query: woorden.slice(0, 2).join(" ") || wet, maximumRecords: 5 });
      return out.items.slice(0, 5).map((x) => ({ titel: x.title, bwb_id: x.identifier }));
    } catch { return []; }
  }
  const wetOnbekend = async (wet: string | undefined, peildatum: string, uitleg?: string): Promise<Diagnose> => {
    const s = wet && !/^BWB[RV]\d+$/i.test(wet) ? await suggesties(wet) : [];
    return { code: "wet_onbekend", wet, peildatum, suggesties: s, uitleg: uitleg ?? `Geen regeling "${wet}" in het Basiswettenbestand: controleer de naam of afkorting${s.length ? `; dichtstbij: ${s.slice(0, 3).map((x) => x.titel).join("; ")}` : ""}.` };
  };
  const fout = (r: Result) => (r.error ? (TOOLFOUT_SOORTEN.has(r.error) ? toolfout(`${r.error}: ${r.message ?? ""}`) : null) : null);

  async function bwbArtikelTekst(args: Result, r: Result): Promise<Toevoeging> {
    const vandaag = todayAmsterdam(), peildatum = args.datum ?? args.peildatum ?? vandaag;
    const bwbId = String(args.bwbId ?? "").trim().toUpperCase(), artikel = String(args.artikel ?? "");
    const t: Toevoeging = { verwijzing: `${bwbId} art. ${artikel}`, peildatum, bekende_valkuil: zoekValkuil(bwbId, artikel) };
    if (r.error) { t.diagnose = /BWB-id/i.test(String(r.message)) ? { code: "wet_onbekend", bwb_id: String(args.bwbId), peildatum, suggesties: [], uitleg: `"${args.bwbId}" is geen geldig BWB-id (BWBR + 7 cijfers); zoek het id met wetten_bwb_search.` } : (fout(r) ?? toolfout(String(r.message ?? r.error))); return t; }
    const recs: Result[] = r.records ?? [];
    if (!recs.length) {
      t.diagnose = /^Geen toestand/.test(String(r.access_note ?? "")) ? { code: "wet_onbekend", bwb_id: bwbId, peildatum, uitleg: `${bwbId} heeft geen versie die op ${peildatum} geldt (onbekend id, nog niet in werking of ingetrokken).` } : await nietInVersie(undefined, bwbId, artikel, peildatum);
      if (t.diagnose.vervallen_per) t.geldigheid = { status: "vervallen", peildatum, datum: t.diagnose.vervallen_per };
      else if (t.diagnose.nog_niet_in_werking) t.geldigheid = { status: "nog_niet_in_werking", peildatum, in_werking_per: t.diagnose.in_werking_per };
      return t;
    }
    const d = recs[0].data ?? {};
    const op: ArtikelStand = { status: d.status ?? (isVervallenTekst(d.tekst) ? "vervallen" : "goed"), inwerking: d.inwerking, bron: d.bron_wijziging };
    let nu: ArtikelStand | null | undefined;
    if (peildatum < vandaag && op.status !== "vervallen") {
      try { const n = await bwbArtikel.getArtikel({ bwbId, artikel, pad: args.pad }); nu = n.items[0] ? { status: n.items[0].status ?? (isVervallenTekst(n.items[0].tekst) ? "vervallen" : "goed"), inwerking: n.items[0].inwerking, bron: n.items[0].bron_wijziging } : (/^Geen toestand/.test(n.access_note) ? undefined : null); } catch { nu = undefined; }
    }
    t.geldigheid = geldigheid(op, nu, peildatum, vandaag);
    if (op.status === "vervallen") t.diagnose = artikelDiagnose({ wet: d.titel_regeling, bwbId, artikel, peildatum, status: "vervallen", inwerking: op.inwerking, bron: op.bron });
    return t;
  }

  async function wettenTekst(args: Result, r: Result): Promise<Toevoeging | undefined> {
    const vandaag = todayAmsterdam(), peildatum = args.peildatum ?? vandaag;
    const q = r.provenance?.query_params ?? {};
    const bwbId = String(q.bwb_id ?? args.bwb_id ?? "").toUpperCase();
    const artikel = args.artikel ? String(args.artikel) : "";
    const valkuilBwb = bwbId || valkuilId(args.wet) || "";
    const t: Toevoeging = { verwijzing: `${args.wet ?? bwbId}${artikel ? ` art. ${artikel}` : ""}`, peildatum, bekende_valkuil: valkuilBwb && artikel ? zoekValkuil(valkuilBwb, artikel) : undefined };
    if (r.error) {
      // An invalid id is answered without a request (as the tool itself does): no suggestion search.
      t.diagnose = /geen BWB-id/i.test(String(r.message)) ? { code: "wet_onbekend", bwb_id: String(args.bwb_id), peildatum, suggesties: [], uitleg: `"${args.bwb_id}" is geen geldig BWB-id (BWBR + 7 cijfers); geef een titel of afkorting als wet.` } : (fout(r) ?? undefined);
      return t.diagnose || t.bekende_valkuil ? t : undefined;
    }
    const ng = q.niet_gevonden;
    if (ng === "wet" || ng === "bwb_id") { t.diagnose = await wetOnbekend(args.wet ?? bwbId, peildatum); return t; }
    if (ng === "versie") { t.diagnose = { code: artikel ? "artikel_bestaat_niet_in_geldende_versie" : "wet_onbekend", wet: args.wet, bwb_id: bwbId || undefined, artikel: artikel || undefined, peildatum, regeling_geldt_niet: true, uitleg: `De regeling bestaat, maar heeft geen versie die op ${peildatum} geldt (ingetrokken, of nog niet in werking): ${r.summary ?? ""}` }; return t; }
    if (/is geen titel of afkorting/.test(String(r.summary ?? ""))) {
      t.diagnose = { code: "wet_onbekend", wet: args.wet, peildatum, suggesties: (r.records ?? []).slice(0, 5).map((x: Result) => ({ titel: x.data?.title, bwb_id: x.data?.bwb_id })), uitleg: `"${args.wet}" is geen titel of afkorting van een regeling; de suggesties hebben die woorden in de titel.` };
      return t;
    }
    if (!artikel) return undefined;
    if (ng === "artikel") {
      t.diagnose = await nietInVersie(args.wet, bwbId, artikel, peildatum);
      if (t.diagnose.vervallen_per) t.geldigheid = { status: "vervallen", peildatum, datum: t.diagnose.vervallen_per };
      else if (t.diagnose.nog_niet_in_werking) t.geldigheid = { status: "nog_niet_in_werking", peildatum, in_werking_per: t.diagnose.in_werking_per };
      return t;
    }
    const d = (r.records ?? [])[0]?.data;
    if (!d?.artikel) return t.bekende_valkuil ? t : undefined;
    const op: ArtikelStand = { status: STATUS[String(d.status ?? "geldend")] ?? d.status, inwerking: d.in_werking_sinds, bron: d.gewijzigd_bij };
    let nu: ArtikelStand | null | undefined;
    if (peildatum < vandaag && op.status !== "vervallen") {
      try {
        const n = await wettenBwb.tekst({ bwb_id: bwbId, artikel, max_chars: 500 });
        if (n.kind === "tekst") { const a = n.selection.parts?.[0]?.artikel as { status?: string; inwerking?: string; bron?: string } | undefined; nu = n.selection.notFound ? null : a ? { status: a.status, inwerking: a.inwerking, bron: a.bron } : undefined; }
      } catch { nu = undefined; }
    }
    t.geldigheid = geldigheid(op, nu, peildatum, vandaag);
    if (op.status === "vervallen") t.diagnose = artikelDiagnose({ wet: d.regeling, bwbId, artikel, peildatum, status: "vervallen", inwerking: op.inwerking, bron: op.bron });
    return t;
  }

  /** "artikel 843a Rv", "art. 7:658 BW", "3:4 Awb" in a title search: the reference behind it. */
  async function wettenSearch(args: Result, r: Result): Promise<Toevoeging | undefined> {
    const query = String(args.query ?? "");
    const m = /^\s*(?:art(?:ikel)?\.?\s*)?(\d+[a-z]*(?::\d+[a-z]*)?)\s*(?:,?\s*(?:lid\s*\d+|\w+\s+lid))?\s+(?:van\s+(?:de|het)\s+)?(.{2,120})$/i.exec(query);
    const isArtikel = m && (/^\s*art/i.test(query) || m[1].includes(":"));
    if (r.error) {
      const f = fout(r);
      const v = isArtikel ? zoekValkuil(valkuilId(m![2].trim()) ?? m![2].trim(), m![1]) : undefined;
      return f || v ? { verwijzing: query, ...(f ? { diagnose: f } : {}), ...(v ? { bekende_valkuil: v } : {}) } : undefined;
    }
    if (isArtikel) {
      const [, artikel, wet] = m!;
      try {
        const out = await wettenBwb.tekst({ wet: wet.trim(), artikel, peildatum: args.peildatum ?? args.geldigOp, max_chars: 500 });
        const fake: Result = out.kind === "kandidaten" ? { summary: "", records: [], provenance: { query_params: {} } }
          : { records: out.selection.notFound ? [] : [{ data: { artikel, status: (out.selection.parts?.[0]?.artikel as { status?: string })?.status, in_werking_sinds: (out.selection.parts?.[0]?.artikel as { inwerking?: string })?.inwerking, gewijzigd_bij: (out.selection.parts?.[0]?.artikel as { bron?: string })?.bron, regeling: out.regeling.title } }], provenance: { query_params: { bwb_id: out.regeling.identifier, ...(out.selection.notFound ? { niet_gevonden: "artikel" } : {}) } } };
        const t = await wettenTekst({ wet: wet.trim(), artikel, peildatum: args.peildatum ?? args.geldigOp }, fake);
        return t ? { ...t, verwijzing: query } : undefined;
      } catch (e) { const v = zoekValkuil(valkuilId(wet.trim()) ?? wet.trim(), artikel); return { verwijzing: query, diagnose: toolfout((e as Error).message), ...(v ? { bekende_valkuil: v } : {}) }; }
    }
    return undefined;
  }

  function ecliGet(args: Result, r: Result): Toevoeging | undefined {
    const ecli = String(args.ecli ?? "").trim().toUpperCase();
    if (r.error) return { verwijzing: ecli, diagnose: fout(r) ?? toolfout(String(r.message ?? r.error)) };
    const recs: Result[] = r.records ?? [];
    if (!recs.length) return { verwijzing: ecli, diagnose: /HTTP 404/.test(String(r.access_note)) ? { code: "ecli_onbekend", uitleg: "rechtspraak.nl kent deze ECLI niet (bestaat niet of is niet gepubliceerd); een niet-bestaande ECLI is vaak verzonnen." } : toolfout(String(r.access_note ?? "geen antwoord")) };
    const xml = String(recs[0].data?.xml ?? "");
    if (xml && !/<(uitspraak|conclusie)\b/.test(xml)) return { verwijzing: ecli, diagnose: { code: "ecli_zonder_tekst", uitleg: "De ECLI bestaat, maar rechtspraak.nl heeft alleen metadata gepubliceerd, geen tekst." } };
    return undefined;
  }
  function uitspraakGet(args: Result, r: Result): Toevoeging | undefined {
    const ecli = String(args.ecli ?? "").trim();
    if (r.error) {
      if (r.error === "unexpected" && /ECLI/.test(String(r.message)) && !/sectie/i.test(String(r.message))) return { verwijzing: ecli, diagnose: { code: "ecli_onbekend", uitleg: `Geen geldige Nederlandse ECLI: ${r.message}` } };
      const f = fout(r); return f ? { verwijzing: ecli, diagnose: f } : undefined;
    }
    const recs: Result[] = r.records ?? [];
    if (!recs.length && /niet gevonden/.test(String(r.summary))) return { verwijzing: ecli, diagnose: { code: "ecli_onbekend", uitleg: "rechtspraak.nl kent deze ECLI niet (HTTP 404): bestaat niet of is niet gepubliceerd; een niet-bestaande ECLI is vaak verzonnen." } };
    if (recs[0]?.data?.tekst_gepubliceerd === false) return { verwijzing: ecli, diagnose: { code: "ecli_zonder_tekst", uitleg: "De ECLI bestaat, maar rechtspraak.nl heeft geen tekst gepubliceerd (alleen metadata); citaat en r.o. zijn niet te controleren." } };
    return undefined;
  }

  return {
    bwb_artikel_tekst: bwbArtikelTekst,
    wetten_bwb_tekst: wettenTekst,
    wetten_bwb_search: wettenSearch,
    rechtspraak_get_by_ecli: async (a: Result, r: Result) => ecliGet(a, r),
    rechtspraak_uitspraak_get: async (a: Result, r: Result) => uitspraakGet(a, r),
  } as Record<string, (args: Result, r: Result) => Promise<Toevoeging | undefined>>;
}

/** Apply the analysis to a tool payload: the extra fields next to the result, and one foutlog row when something is off. */
export async function verrijk(name: string, args: Result, payload: ToolPayload, analyse: ReturnType<typeof createHallucinatieAnalyse>, timeoutMs = 25_000): Promise<ToolPayload> {
  const fn = analyse[name];
  const tekst = payload?.content?.[0]?.text;
  if (!fn || typeof tekst !== "string") return payload;
  let result: Result;
  try { result = JSON.parse(tekst); } catch { return payload; }
  let t: Toevoeging | undefined;
  try {
    t = await Promise.race([fn(args, result), new Promise<undefined>((res) => { const x = setTimeout(() => res(undefined), timeoutMs); x.unref?.(); })]);
  } catch (e) { process.stderr.write(`[hallucinatie] ${name}: ${(e as Error).message}\n`); return payload; }
  if (!t) return payload;
  const extra = { ...(t.diagnose ? { diagnose: t.diagnose } : {}), ...(t.geldigheid ? { geldigheid: t.geldigheid } : {}), ...(t.bekende_valkuil ? { bekende_valkuil: t.bekende_valkuil } : {}) };
  if (!Object.keys(extra).length) return payload;
  const uitkomst = [t.diagnose ? (t.diagnose.code === "toolfout" ? "toolfout" : "niet_gevonden") : null, t.geldigheid && t.geldigheid.status !== "geldend" ? String(t.geldigheid.status) : null, t.bekende_valkuil ? "bekende_valkuil" : null].filter(Boolean) as string[];
  if (uitkomst.length) foutlog().fout({ tool: name, verwijzing: t.verwijzing, invoer: args, uitkomst, diagnose: t.diagnose?.code ?? null, peildatum: t.peildatum ?? null });
  const nieuw = { ...result, ...extra };
  return { ...payload, content: [{ type: "text", text: JSON.stringify(nieuw) }, ...payload.content.slice(1)], ...(payload.structuredContent ? { structuredContent: nieuw } : {}) };
}

/** Wrap server.registerTool: count every call, and enrich the five lookup tools. One line in src/server.ts. */
let gedeeld: ReturnType<typeof createHallucinatieAnalyse> | undefined;
export function installHallucinatieBeveiliging(server: McpServer, analyse = (gedeeld ??= createHallucinatieAnalyse())): void {
  const orig = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (name: unknown, def: unknown, handler: unknown) => {
    const n = String(name);
    const h = handler as (args: Result, extra: unknown) => Promise<ToolPayload>;
    const d = { ...(def as Result) };
    if (analyse[n]) {
      d.description = `${d.description ?? ""}${BESCHRIJVING}${n.startsWith("rechtspraak") ? "" : BESCHRIJVING_WET}`;
      if (n === "bwb_artikel_tekst") d.inputSchema = { ...d.inputSchema, peildatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Alias of datum: the day the article must be geldig (YYYY-MM-DD, default today); geldigheid compares it with today.") };
    }
    const wrapped = async (args: Result, extra: unknown) => {
      foutlog().aanroep(n);
      const a = n === "bwb_artikel_tekst" && args?.peildatum && !args?.datum ? { ...args, datum: args.peildatum } : args;
      const payload = await h(a, extra);
      return analyse[n] ? verrijk(n, a ?? {}, payload, analyse) : payload;
    };
    return orig(n, d, wrapped);
  };
}

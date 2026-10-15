/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Treaties:
 * - Verdragenbank (verdragenbank.overheid.nl, KOOP/BZ): every treaty that binds the Kingdom, with its
 *   status per part of the Kingdom, the parties (ratification, entry into force, reservations,
 *   objections), designated authorities and depositary notifications (the Netherlands is depositary of
 *   the HCCH conventions). Search: the KOOP SRU repository (c.product-area==vd, full text) or the site's
 *   own search with its filters; record: the XML in repository.overheid.nl/frbr/vd/{nr}.
 *   The consolidated Dutch text is in the BWB (BWBV…) and read with wetten_bwb_tekst.
 * - HCCH (hcch.net): the official English text of the Hague conventions, with links to the HCCH status
 *   table, central authorities and explanatory reports.
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { decodeEntities, htmlNaarTekst } from "./juridische-bronnen.js";
import { documentTekst, httpFetch, kiesFacet, passages } from "./geschilbeslechting.js";

type Fetcher = typeof httpFetch;

export const VB_BASE = "https://verdragenbank.overheid.nl";
export const VB_SRU = "https://repository.overheid.nl/sru";
export const HCCH_BASE = "https://www.hcch.net";
const VB_RECORD = (nr: string) => `https://repository.overheid.nl/frbr/vd/${nr}/1/xml-nl/${nr}.xml`;
const VB_DETAILS = (nr: string) => `${VB_BASE}/nl/Verdrag/Details/${nr}`;
const TRB_URL = (t: string) => { const m = /(\d{4})\D+(\d+)/.exec(t); return m ? `https://zoek.officielebekendmakingen.nl/trb-${m[1]}-${m[2]}.html` : undefined; };

const inline = (html: string) => decodeEntities(htmlNaarTekst(html)).replace(/\s*\n\s*/g, " ").trim();
const rec = (source: string, title: string, url: string, date: string | undefined, snippet: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: source, title, canonical_url: url, ...(date ? { date } : {}), ...(snippet ? { snippet: snippet.slice(0, 400) } : {}), data });

/** Verdragsnummer (6 cijfers) uit een nummer, een Verdragenbank-link of een repository-link. */
export function verdragsnummer(input: string): string | null {
  const s = input.trim();
  const m = /(?:Details\/|frbr\/vd\/|^)(\d{4,6})(?:[_./?#]|$)/.exec(s) ?? /^(?:verdrag(?:snummer)?\s*)?(\d{4,6})$/i.exec(s);
  return m ? m[1].padStart(6, "0") : null;
}

// ---------- Verdragenbank: zoeken ----------

/** SRU-resultaten (gzd): nummer, titel, afkorting, onderwerp, Tractatenblad. */
export function parseVerdragenSru(xml: string) {
  const totaal = Number(/<sru:numberOfRecords>(\d+)</.exec(xml)?.[1] ?? 0);
  const items = [...xml.matchAll(/<sru:record>([\s\S]*?)<\/sru:record>/g)].map(([, r]) => {
    const nr = /<dcterms:identifier[^>]*>([^<]+)</.exec(r)?.[1]?.trim() ?? "";
    return {
      verdragsnummer: nr,
      titel: decodeEntities(/<dcterms:title[^>]*>([^<]+)</.exec(r)?.[1] ?? "").trim(),
      afkorting: decodeEntities(/<dcterms:abbreviation[^>]*>([^<]+)</.exec(r)?.[1] ?? "").trim() || undefined,
      onderwerp: [...r.matchAll(/<dcterms:subject[^>]*>([^<]+)</g)].map((m) => decodeEntities(m[1]).trim()),
      tractatenblad: [...r.matchAll(/<dcterms:isPartOf[^>]*>(trb-\d{4}-\d+)</g)].map((m) => m[1]),
      url: VB_DETAILS(nr),
    };
  }).filter((i) => i.verdragsnummer);
  return { totaal, items };
}

/** Resultatenlijst van de site (zoeken en Haagse Conferentie): nummer, titel, plaats en datum. */
export function parseVerdragenLijst(html: string) {
  const sub = /h1__sub">([^<]*)</.exec(html)?.[1] ?? "";
  const totaal = Number(/van de (\d+)/.exec(sub)?.[1] ?? (/Geen resultaten/i.test(sub) ? 0 : NaN));
  const items = [...html.matchAll(/<a href="\/nl\/Verdrag\/Details\/(\d+)">([\s\S]*?)<\/a>\s*<\/h2>\s*<\/div>\s*<p>([^<]*)<\/p>/g)].map(([, nr, t, p]) => {
    const pm = /^(.*),\s*(\d{2})-(\d{2})-(\d{4})\s*$/.exec(decodeEntities(p).trim());
    return { verdragsnummer: nr, titel: inline(t), plaats: pm?.[1], datum: pm ? `${pm[4]}-${pm[3]}-${pm[2]}` : undefined, url: VB_DETAILS(nr) };
  });
  return { totaal: Number.isNaN(totaal) ? items.length : totaal, items };
}

/** Waarden van de filters (onderwerp, partij) op het zoekformulier. */
export function verdragFilters(html: string, name: "topic" | "party"): Array<{ value: string; label: string }> {
  return [...html.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "g"))].map((m) => ({ value: decodeEntities(m[1]), label: decodeEntities(m[1]) }));
}

// ---------- Verdragenbank: record ----------

const ARRAYS = new Set(["Partij", "Koninkrijksdeel", "Tractatenblad", "Voorbehoud", "BezwaarVoorbehoudPartij", "Gebiedsdeel", "BezwaarToetreding", "BezwaarDoor", "Autoriteit", "MededelingAutoriteit", "DepositaireMededeling", "Mededeling", "Notificatie", "Kamerstuk", "isPartOf", "subject", "GewaarmerktDocument", "Verdrag"]);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false, trimValues: true, isArray: (name) => ARRAYS.has(name) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;
const val = (x: X): string | undefined => (typeof x === "string" ? x.trim() || undefined : typeof x === "number" ? String(x) : x && typeof x["#text"] === "string" ? x["#text"].trim() || undefined : undefined);
const arr = (x: X): X[] => (Array.isArray(x) ? x : x == null || x === "" ? [] : [x]);
const nlDatum = (d?: string) => d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d;

export function parseVerdragXml(xml: string) {
  const root = parser.parse(xml)?.Verdragenbank;
  if (!root) return null;
  const kern = root.meta?.owmskern ?? {};
  const mantel = root.meta?.owmsmantel ?? {};
  const ipm = root.meta?.verdragipm ?? {};
  const v = root.body?.verdrag ?? {};
  const dep = v.DepositaireGegevens ?? {};
  const nr = val(kern.identifier) ?? "";
  const bwbv = val(arr(mantel.Verdragstekst?.isPartOf)[0]);
  const goedkeuring = arr(mantel.Goedkeuringswet?.isPartOf)[0];
  const partijen = arr(v.Partijen?.Partij).map((p: X) => ({
    partij: val(p.NaamPartij) ?? "",
    ondertekening: nlDatum(val(p.DatumOndertekenning)),
    ratificatie: nlDatum(val(p.DatumRatificatie)),
    type_instemming: val(p.TypeInstemming),
    voorlopige_toepassing: nlDatum(val(p.DatumVoorlopigeToepassing)),
    inwerkingtreding: nlDatum(val(p.DatumInwerkingtreding)),
    opzegging: nlDatum(val(p.DatumOpzegging)),
    buitenwerkingtreding: nlDatum(val(p.DatumBuitenwerkingtreding)),
    voorbehoud: val(p.IsVoorbehoud) === "true",
    bezwaar: val(p.IsBezwaar) === "true",
    voorbehouden: arr(p.Voorbehouden?.Voorbehoud).map((r: X) => ({
      datum: nlDatum(val(r.DatumVoorbehoud)), tekst: val(r.TekstVoorbehoud),
      bezwaren: arr(r.BezwarenVoorbehoud?.BezwaarVoorbehoudPartij).map((b: X) => ({ door: val(b.PartijBezwaarVoorbehoud), datum: nlDatum(val(b.DatumBezwaarVoorbehoud)), tekst: val(b.TekstBezwaarVoorbehoud) })),
    })),
    gebiedsdelen: arr(p.Gebiedsdelen?.Gebiedsdeel).map((g: X) => ({ gebiedsdeel: val(g.NaamGebiedsdeel), inwerkingtreding: nlDatum(val(g.DatumInwerkingtreding)), buitenwerkingtreding: nlDatum(val(g.DatumBuitenwerkingtreding)) })),
  }));
  return {
    verdragsnummer: nr,
    titel: val(kern.title) ?? "",
    afkorting: val(mantel.abbreviation),
    onderwerp: arr(mantel.subject).map(val).filter(Boolean) as string[],
    ministerie: val(kern.creator),
    gewijzigd: val(kern.modified),
    sluiting: { datum: nlDatum(val(ipm.sluitingsDatum)), plaats: val(ipm.sluitingsPlaats) },
    inwerkingtreding: nlDatum(val(ipm.inwerkingtredingDatum)),
    buitenwerkingtreding: nlDatum(val(ipm.uitwerkingtredingDatum)),
    type: val(ipm.verdragType),
    status: val(ipm.verdragStatus),
    nl_depositaris: val(ipm.isNLDepositair) === "true",
    haagse_conferentie: val(ipm.isHaagseConferentiePrivaatrecht) === "true",
    opmerking: val(v.Opmerking),
    goedkeuringswet: goedkeuring ? { vindplaats: val(goedkeuring), url: goedkeuring?.["@_resourceIdentifier"] } : undefined,
    verdragstekst: bwbv ? { bwb_id: `BWBV${bwbv}`, url: `https://wetten.overheid.nl/BWBV${bwbv}` } : undefined,
    tractatenblad: arr(mantel.Tractatenbladen?.Tractatenblad).map((t: X) => ({ vindplaats: val(t.TractatenbladText), omschrijving: val(t.Omschrijving), url: TRB_URL(val(t.TractatenbladText) ?? "") })),
    koninkrijksdelen: arr(v.Koninkrijksdelen?.Koninkrijksdeel).map((k: X) => ({ deel: val(k.NaamKoninkrijksdeel), voorlopige_toepassing: nlDatum(val(k.DatumVoorlopigeToepassing)), inwerkingtreding: nlDatum(val(k.DatumInwerkingtreding)), buitenwerkingtreding: nlDatum(val(k.DatumBuitenwerkingtreding)) })),
    partijen,
    bezwaren_toetreding: arr(dep.BezwarenToetreding?.BezwaarToetreding).map((b: X) => ({ tegen: val(b.BezwaarTegenPartij), door: arr(b.BezwaarDoor).map((d: X) => ({ partij: val(d.BezwaarDoorPartij), datum: nlDatum(val(d.DatumBezwaarToetreding)), ingetrokken: nlDatum(val(d.DatumIntrekkenBezwaarToetreding)), tekst: val(d.OpmerkingBezwaarToetreding) })) })),
    autoriteiten: arr(dep.Autoriteiten?.Autoriteit).map((a: X) => ({ partij: val(a.PartijAutoriteit), mededelingen: arr(a.MededelingAutoriteit).map((m: X) => ({ datum: nlDatum(val(m.DatumAutoriteit)), tekst: val(m.TekstAutoriteit) })) })),
    depositaire_mededelingen: arr(dep.DepositaireMededelingen?.DepositaireMededeling).map((d: X) => ({ partij: val(d.PartijDepositaireMededeling), mededelingen: arr(d.Mededeling).map((m: X) => ({ datum: nlDatum(val(m.DatumDepositaireMededeling)), tekst: val(m.TekstDepositaireMededeling) })) })),
    notificaties: arr(dep.DepositaireNotificaties?.Notificatie).map((n: X) => ({ datum: nlDatum(val(n.DatumNotificatie)), titel: val(n.TitelNotificatie), url: val(n.Bestandsnaam) ? `https://repository.overheid.nl/frbr/vd/${nr}/1/pdf/${val(n.Bestandsnaam)}` : undefined })),
  };
}

// ---------- HCCH ----------

export function parseHcchLijst(html: string) {
  const seen = new Set<string>();
  const items: Array<{ cid: number; titel: string; url: string }> = [];
  for (const [, cid, t] of html.matchAll(/href="\/en\/instruments\/conventions\/full-text\/\?cid=(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const titel = inline(t);
    if (!titel || seen.has(cid)) continue;
    seen.add(cid);
    items.push({ cid: Number(cid), titel, url: `${HCCH_BASE}/en/instruments/conventions/full-text/?cid=${cid}` });
  }
  return items;
}

/** Specialised sections (apostille, service, evidence, child-abduction …): daar staan de hoofdverdragen. */
export function parseHcchSecties(html: string): string[] {
  return [...new Set([...html.matchAll(/href="\/en\/instruments\/conventions\/specialised-sections\/([a-z0-9-]+)"/g)].map((m) => m[1]))];
}

/** Uit een sectiepagina: de naam van de sectie en de verdragen (cid) waarvan de volledige tekst wordt gelinkt. */
export function parseHcchSectie(html: string, slug: string): Array<{ cid: number; titel: string; url: string; sectie: string }> {
  const naam = decodeEntities(/<title>(?:HCCH\s*\|\s*)?([^<]+)<\/title>/i.exec(html)?.[1] ?? slug).trim();
  return [...new Set([...html.matchAll(/full-text\/\?cid=(\d+)/g)].map((m) => Number(m[1])))].map((cid) => ({
    cid, titel: `${naam} (${slug.replace(/-/g, " ")})`, sectie: `${HCCH_BASE}/en/instruments/conventions/specialised-sections/${slug}`, url: `${HCCH_BASE}/en/instruments/conventions/full-text/?cid=${cid}`,
  }));
}

export function parseHcchVerdrag(html: string, cid: number) {
  const d = documentTekst(html);
  const kop = /\n\s*(\d+):\s*([^\n]+)/.exec(`\n${d.tekst}`);
  const inwerking = /Entry into force:\s*\n?\s*([0-9IVX-]+)/i.exec(d.tekst)?.[1];
  const begin = d.tekst.search(/\n[A-Z][A-Z ,'’()-]{20,}\n/);
  const tekst = begin > 0 ? d.tekst.slice(begin).trim() : d.tekst;
  const links = [...new Set([...html.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => new URL(m[1], HCCH_BASE).toString()))];
  return {
    cid, nummer: kop ? Number(kop[1]) : undefined, titel: kop?.[2]?.trim() ?? d.titel ?? "", inwerkingtreding: inwerking, tekst,
    links: {
      volledige_tekst: `${HCCH_BASE}/en/instruments/conventions/full-text/?cid=${cid}`,
      statustabel: `${HCCH_BASE}/en/instruments/conventions/status-table/?cid=${cid}`,
      autoriteiten: `${HCCH_BASE}/en/instruments/conventions/authorities1/?cid=${cid}`,
      pdf: links,
    },
  };
}

/** Eén artikel ("Article 3") tot het volgende artikel. */
export function hcchArtikel(tekst: string, artikel: string): string | null {
  const nr = artikel.replace(/^(art(icle|ikel)?\.?\s*)/i, "").trim();
  const m = new RegExp(`(^|\\n)Article ${nr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`, "i").exec(tekst);
  if (!m) return null;
  const rest = tekst.slice(m.index + m[0].length);
  const eind = rest.search(/\nArticle \d+[a-z]?\s*\n|\n[A-Z ]{12,}\n/);
  return `Article ${nr}\n${(eind >= 0 ? rest.slice(0, eind) : rest).trim()}`;
}

// ---------- tools ----------

const NOTE = "Bron: Verdragenbank (verdragenbank.overheid.nl, Ministerie van Buitenlandse Zaken / KOOP). De geconsolideerde Nederlandse tekst staat in het BWB (BWBV…): lees die met wetten_bwb_tekst. Laat elke verwijzing die je gebruikt controleren met de verwijzingscontroleur (verify_legal_reference).";

export function registerVerdragen(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, f: Fetcher = httpFetch): void {
  const params = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  const prov = (tool: string, endpoint: string, p: Record<string, string>, n: number, total: number) => ({ tool, endpoint, query_params: p, timestamp: nowIso(), returned_results: n, total_results: total });
  let formulier: { at: number; html: string } | null = null;
  let hcchLijst: { at: number; items: Array<{ cid: number; titel: string; url: string; sectie?: string }> } | null = null;
  const haalHcchLijst = async () => {
    if (hcchLijst && Date.now() - hcchLijst.at < 24 * 3600_000) return hcchLijst.items;
    const html = (await f(`${HCCH_BASE}/en/instruments/conventions`)).text;
    const items: Array<{ cid: number; titel: string; url: string; sectie?: string }> = parseHcchLijst(html);
    const secties = await Promise.all(parseHcchSecties(html).map(async (slug) => {
      try { return parseHcchSectie((await f(`${HCCH_BASE}/en/instruments/conventions/specialised-sections/${slug}`)).text, slug); } catch { return []; }
    }));
    // De hoofdverdragen (via hun sectie) vooraan; een verdrag dat al in de lijst stond krijgt de sectie erbij.
    const voor: typeof items = [];
    for (const s of secties.flat()) {
      const al = items.find((i) => i.cid === s.cid) ?? voor.find((i) => i.cid === s.cid);
      if (al) al.sectie ??= s.sectie; else voor.push(s);
    }
    hcchLijst = { at: Date.now(), items: [...voor, ...items] };
    return hcchLijst.items;
  };
  const filterPagina = async () => {
    if (!formulier || Date.now() - formulier.at > 24 * 3600_000) formulier = { at: Date.now(), html: (await f(`${VB_BASE}/nl/Verdrag/ZoekUitgebreid`)).text };
    return formulier.html;
  };

  server.registerTool("verdragen_zoeken", {
    description: "Search the Verdragenbank (all treaties binding the Kingdom of the Netherlands, incl. Hague Conference conventions, with the Netherlands as depositary for many). Free text (zoekterm, searched in the full record via the KOOP SRU repository, e.g. 'apostille'), or the site's own filters: words in the Dutch title (titel), subject (onderwerp, e.g. 'Personen- en familierecht', 'Burgerlijk procesrecht', 'Sociale Zekerheid', 'Rechtshulp', 'Arbitrage', 'Belasting'), party (partij, e.g. 'Marokko', 'Turkije', 'Raad van Europa'), only treaties of which the Netherlands is depositary (nl_depositaris), or the list of HCCH conventions (haagse_conferentie). Returns treaty number, title, place and date; read the record with verdrag_get.",
    inputSchema: {
      zoekterm: z.string().max(200).optional(), titel: z.string().max(200).optional(), onderwerp: z.string().max(80).optional(), partij: z.string().max(80).optional(),
      nl_depositaris: z.boolean().optional(), haagse_conferentie: z.boolean().optional(),
      pagina: z.number().int().min(1).max(100).default(1), aantal: z.number().int().min(1).max(50).default(20),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      const metFilters = a.titel || a.onderwerp || a.partij || a.nl_depositaris;
      if (a.haagse_conferentie && !metFilters && !a.zoekterm) {
        const u = `${VB_BASE}/nl/Verdrag/HaagseConferentie${a.pagina > 1 ? `?page=${a.pagina}` : ""}`;
        const r = parseVerdragenLijst((await f(u)).text);
        const records = r.items.map((i) => rec("verdragenbank.overheid.nl", i.titel, i.url, i.datum, i.plaats, { ...i }));
        return toMcpToolPayload(successResponse({ summary: `Verdragenbank, Haagse Conferentie: ${records.length} verdragen (pagina ${a.pagina})`, records, provenance: prov("verdragen_zoeken", u, params(a), records.length, records.length), access_note: `${NOTE} De Haagse verdragen staan op meerdere pagina's (pagina 1–6). Voor de officiële Engelse tekst: hcch_verdrag_get.` }));
      }
      if (metFilters || !a.zoekterm) {
        const u = new URL(`${VB_BASE}/nl/Verdrag/ZoekUitgebreidResultaat`);
        if (a.titel ?? a.zoekterm) u.searchParams.set("title", (a.titel ?? a.zoekterm)!);
        for (const [veld, naam] of [["onderwerp", "topic"], ["partij", "party"]] as const) {
          const v = a[veld];
          if (!v) continue;
          const opties = verdragFilters(await filterPagina(), naam);
          const fac = kiesFacet(opties, v);
          if (!fac) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `${veld} '${v}' onbekend.`, suggestion: `Kies uit: ${opties.slice(0, 80).map((x) => x.label).join(", ")}` }));
          u.searchParams.append(naam, fac.value);
        }
        if (a.nl_depositaris) u.searchParams.set("isNLDepositary", "True");
        u.searchParams.set("count", String(a.aantal));
        if (a.pagina > 1) u.searchParams.set("page", String(a.pagina));
        const r = parseVerdragenLijst((await f(u.toString())).text);
        const records = r.items.map((i) => rec("verdragenbank.overheid.nl", i.titel, i.url, i.datum, i.plaats, { ...i }));
        return toMcpToolPayload(successResponse({ summary: `Verdragenbank: ${r.totaal} verdragen; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("verdragen_zoeken", u.toString(), params(a), records.length, r.totaal),
          access_note: `${NOTE} 'titel' zoekt in de Nederlandse titel ("Apostilleverdrag" heet "Verdrag tot afschaffing van het vereiste van legalisatie …"); zoek met 'zoekterm' in de volledige gegevens.` }));
      }
      const u = new URL(VB_SRU);
      u.searchParams.set("operation", "searchRetrieve"); u.searchParams.set("version", "2.0"); u.searchParams.set("recordSchema", "gzd");
      u.searchParams.set("query", `c.product-area==vd AND cql.textAndIndexes="${a.zoekterm!.replace(/"/g, "")}"`);
      u.searchParams.set("maximumRecords", String(a.aantal)); u.searchParams.set("startRecord", String((a.pagina - 1) * a.aantal + 1));
      const r = parseVerdragenSru((await f(u.toString())).text);
      const records = r.items.map((i) => rec("verdragenbank.overheid.nl", i.afkorting ? `${i.titel} (${i.afkorting})` : i.titel, i.url, undefined, i.onderwerp.join(", "), { ...i }));
      return toMcpToolPayload(successResponse({ summary: `Verdragenbank: ${r.totaal} verdragen voor '${a.zoekterm}'; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("verdragen_zoeken", u.toString(), params(a), records.length, r.totaal), access_note: NOTE }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Verdragenbank", VB_BASE)); }
  });

  server.registerTool("verdrag_get", {
    description: "One treaty from the Verdragenbank by treaty number ('009051') or Verdragenbank link: title, abbreviation, conclusion, entry into force and status per part of the Kingdom, Tractatenblad publications, approval act, the BWB id of the consolidated Dutch text (read it with wetten_bwb_tekst), and the parties with ratification, entry into force, denunciation and whether they made reservations. With 'partij' (e.g. 'Marokko'): that party in full — reservations with their text and objections to them, territories, objections to its accession, its designated authorities (e.g. the apostille authority) and depositary communications. With 'onderdeel' also: all designated authorities, objections to accession, depositary communications or notifications.",
    inputSchema: {
      verdrag: z.string().min(3).max(300), partij: z.string().max(80).optional(),
      onderdeel: z.array(z.enum(["autoriteiten", "bezwaren", "mededelingen", "notificaties"])).max(4).optional(),
      zoekterm: z.string().max(120).optional(),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const nr = verdragsnummer(a.verdrag);
    if (!nr) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen verdragsnummer in '${a.verdrag.slice(0, 80)}'.`, suggestion: "Zoek het nummer met verdragen_zoeken (bijv. 009051 voor het Apostilleverdrag)." }));
    const url = VB_RECORD(nr);
    try {
      const r = await f(url);
      const v = r.status === 200 ? parseVerdragXml(r.text) : null;
      if (!v) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Verdrag ${nr} niet gevonden in de Verdragenbank (HTTP ${r.status}).`, suggestion: "Controleer het nummer met verdragen_zoeken." }));
      const fold = (s?: string) => (s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const pk = a.partij ? kiesFacet(v.partijen.map((p) => ({ value: p.partij, label: p.partij })), a.partij) : null;
      if (a.partij && !pk) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `'${a.partij}' is geen partij bij verdrag ${nr}.`, suggestion: `Partijen: ${v.partijen.map((p) => p.partij).join(", ").slice(0, 1500)}` }));
      const bij = (x?: string) => !pk || fold(x) === fold(pk.value);
      const zt = a.zoekterm ? fold(a.zoekterm) : null;
      const metTerm = <T>(xs: T[]) => (zt ? xs.filter((x) => fold(JSON.stringify(x)).includes(zt)) : xs);
      const ond = new Set(a.onderdeel ?? []);
      const data: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(v).filter(([k]) => !["partijen", "bezwaren_toetreding", "autoriteiten", "depositaire_mededelingen", "notificaties"].includes(k))),
        verdragenbank: VB_DETAILS(nr), bron_xml: url,
        aantal_partijen: v.partijen.length,
        partijen: pk ? v.partijen.filter((p) => bij(p.partij)) : v.partijen.map(({ voorbehouden, gebiedsdelen, ...p }) => ({ ...p, ...(gebiedsdelen.length ? { gebiedsdelen: gebiedsdelen.length } : {}) })),
      };
      if (pk || ond.has("bezwaren")) data.bezwaren_toetreding = metTerm(v.bezwaren_toetreding.filter((b) => !pk || bij(b.tegen) || b.door.some((d) => bij(d.partij))));
      if (pk || ond.has("autoriteiten")) data.autoriteiten = metTerm(v.autoriteiten.filter((x) => bij(x.partij)));
      if (pk || ond.has("mededelingen")) data.depositaire_mededelingen = metTerm(v.depositaire_mededelingen.filter((x) => bij(x.partij)));
      if (ond.has("notificaties")) data.notificaties = metTerm(v.notificaties).slice(0, 50);
      else data.laatste_notificaties = v.notificaties.slice(-5).reverse();
      const titel = v.afkorting ? `${v.titel} (${v.afkorting})` : v.titel;
      return toMcpToolPayload(successResponse({
        summary: `${titel}: ${v.partijen.length} partijen${pk ? `; details voor ${pk.value}` : ""}`,
        records: [rec("verdragenbank.overheid.nl", titel, VB_DETAILS(nr), v.sluiting.datum, v.onderwerp.join(", "), data)],
        provenance: prov("verdrag_get", url, params({ verdrag: a.verdrag, partij: a.partij, onderdeel: a.onderdeel?.join(","), zoekterm: a.zoekterm }), 1, 1),
        access_note: `${NOTE}${v.verdragstekst ? ` Tekst: wetten_bwb_tekst met ${v.verdragstekst.bwb_id}.` : ""}${v.haagse_conferentie ? " Haags verdrag: de officiële Engelse tekst en het toelichtend rapport via hcch_verdrag_get." : ""}`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Verdragenbank", url)); }
  });

  server.registerTool("hcch_verdrag_get", {
    description: "Hague Conference on Private International Law (hcch.net). Without cid: the list of HCCH conventions and instruments with their cid (optionally filtered by zoekterm in the English title, e.g. 'child abduction', 'apostille', 'service', 'evidence', 'maintenance'). With cid: the official English text of that convention, or only one article ('artikel': '3'), with links to the HCCH status table, central authorities and the PDF's (text, explanatory report). Status, reservations and authorities as registered by the depositary (the Netherlands): verdrag_get.",
    inputSchema: { cid: z.number().int().min(1).max(999).optional(), zoekterm: z.string().max(120).optional(), artikel: z.string().max(20).optional(), max_chars: z.number().int().min(1000).max(100_000).default(30_000) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    try {
      if (!a.cid) {
        const u = `${HCCH_BASE}/en/instruments/conventions`;
        const lijst = await haalHcchLijst();
        const fold = (s: string) => s.toLowerCase();
        const items = a.zoekterm ? lijst.filter((i) => fold(a.zoekterm!).split(/\s+/).every((w) => fold(i.titel).includes(w))) : lijst;
        const records = items.map((i) => rec("hcch.net", i.titel, i.url, undefined, undefined, { ...i }));
        return toMcpToolPayload(successResponse({ summary: `HCCH: ${records.length} verdragen${a.zoekterm ? ` voor '${a.zoekterm}'` : ""}`, records, provenance: prov("hcch_verdrag_get", u, params(a), records.length, lijst.length), access_note: "Bron: hcch.net. Lees een verdrag met cid; de Nederlandse status en voorbehouden staan in de Verdragenbank (verdragen_zoeken met haagse_conferentie)." }));
      }
      const u = `${HCCH_BASE}/en/instruments/conventions/full-text/?cid=${a.cid}`;
      const v = parseHcchVerdrag((await f(u)).text, a.cid);
      if (!v.titel || v.tekst.length < 200) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen HCCH-verdrag met cid ${a.cid}.`, suggestion: "Roep hcch_verdrag_get zonder cid aan voor de lijst." }));
      let tekst = v.tekst;
      if (a.artikel) {
        const art = hcchArtikel(v.tekst, a.artikel);
        if (!art) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Article ${a.artikel} niet gevonden in ${v.titel}.`, suggestion: "Lees het hele verdrag zonder 'artikel'." }));
        tekst = art;
      } else if (a.zoekterm) tekst = passages(v.tekst, a.zoekterm).join("\n…\n");
      const out = tekst.length > a.max_chars ? `${tekst.slice(0, a.max_chars)}…` : tekst;
      return toMcpToolPayload(successResponse({
        summary: `HCCH ${v.nummer ?? ""}: ${v.titel}${a.artikel ? `, Article ${a.artikel}` : ""}`,
        records: [rec("hcch.net", v.titel, u, undefined, undefined, { ...v, tekst: out, ingekort: tekst.length > a.max_chars })],
        provenance: prov("hcch_verdrag_get", u, params(a), 1, 1),
        access_note: "Bron: hcch.net (officiële Engelse tekst; ook Frans authentiek). De Nederlandse vertaling staat in het Tractatenblad/BWB: verdrag_get geeft de vindplaats. Laat verwijzingen controleren met verify_legal_reference.",
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "HCCH", HCCH_BASE)); }
  });
}

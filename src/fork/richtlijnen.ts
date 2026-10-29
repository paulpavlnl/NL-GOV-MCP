/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. rechtspraak_richtlijnen: the norms, recommendations and
 * procedural rules the judiciary publishes on rechtspraak.nl ("Voor advocaten en juristen"): the rapport
 * alimentatienormen (tremanormen) with its half-yearly annexes, LOVF and LOVCK recommendations, the
 * landelijke procesreglementen, indicatie- en liquidatietarieven, curatele/bewind recommendations and the
 * administrative-law procedural rules. Criminal law is deliberately left out.
 * The pages are server-rendered: every document is a PDF link whose text is either the title or only the
 * validity ("geldig vanaf 1 juli 2026"), in which case the title is the paragraph or heading above the list.
 * Per series the version in force on a date is chosen; its text (PDF) can be read whole or by search term.
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { getText } from "../utils/http.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { decodeEntities } from "./juridische-bronnen.js";
import { passages } from "./geschilbeslechting.js";

const BASE = "https://www.rechtspraak.nl";
const PAD = `${BASE}/voor-advocaten-en-juristen/reglementen-procedures-en-formulieren`;
export const RICHTLIJN_PAGINAS: Record<string, { url: string; omschrijving: string }> = {
  alimentatienormen: { url: `${PAD}/civiel/familie-en-jeugdrecht/expertgroep-alimentatienormen`, omschrijving: "Rapport alimentatienormen (tremanormen), halfjaarlijkse bijlagen, behoefte- en draagkrachttabellen" },
  familie: { url: `${PAD}/civiel/familie-en-jeugdrecht`, omschrijving: "Procesreglementen familie- en jeugdrecht, LOVF-aanbevelingen, checklists verdelen/verrekenen, formulieren" },
  curatele_bewind: { url: `${PAD}/civiel/curatele-bewind-en-mentorschap`, omschrijving: "Aanbevelingen meerderjarigenbewind, curatele en mentorschap, procesreglement CBM" },
  kanton: { url: `${PAD}/kanton`, omschrijving: "Procesreglementen kanton, handleiding erfrechtprocedures kantonrechter" },
  handel: { url: `${PAD}/civiel/handelsrecht`, omschrijving: "Procesreglementen handel, LOVCK-aanbevelingen (rekenrente personenschade, Wamca, onderhandse verkoop)" },
  tarieven: { url: `${PAD}/civiel/tarieven-kosten-vergoedingen`, omschrijving: "Liquidatie- en indicatietarieven, aanbeveling kort geding" },
  procesreglementen: { url: `${PAD}/procesreglement`, omschrijving: "Alle landelijke procesreglementen (civiel, familie, bestuursrecht, insolventie, WHOA)" },
  bestuursrecht: { url: `${PAD}/bestuursrecht`, omschrijving: "Procesreglement bestuursrecht, leidraad medisch deskundigen, proceskostenformulier" },
};

const MAANDEN: Record<string, number> = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };
const tekst = (h: string) => decodeEntities(h.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/ ([,.:;])/g, "$1").trim();
const datum = (d: string | undefined, m: string | undefined, j: string) => `${j}-${String(MAANDEN[m?.toLowerCase() ?? ""] ?? 1).padStart(2, "0")}-${String(d ? Number(d) : 1).padStart(2, "0")}`;

/** The first day after a month given without a day ("juni 2026" ends on 1 July 2026). */
const naMaand = (d: string) => { const [j, m] = d.split("-").map(Number); return m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, "0")}-01`; };

/** Validity from a title: "geldig vanaf 1 juli 2026", "geldig juli 2025-juni 2026", "versie januari 2026", "per 1 februari 2026", "2019 - 2021", "tot 1 oktober 2019". */
export function geldigheid(t: string): { vanaf?: string; tot?: string } {
  const D = String.raw`(?:(\d{1,2})\s+)?(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)?\s*(\d{4})`;
  const M = "(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)";
  // "januari-juni 2026": both months in one year; the end month counts in full.
  const maanden = new RegExp(`${M}\\s*(?:-|–|t/m)\\s*${M}\\s+(\\d{4})`, "i").exec(t);
  if (maanden) return { vanaf: datum(undefined, maanden[1], maanden[3]), tot: naMaand(datum(undefined, maanden[2], maanden[3])) };
  const reeks = new RegExp(`${D}\\s*(?:-|–|t/m|tot)\\s*${D}`, "i").exec(t);
  if (reeks) { const eind = datum(reeks[4], reeks[5], reeks[6]); return { vanaf: datum(reeks[1], reeks[2], reeks[3]), tot: reeks[4] ? eind : reeks[5] ? naMaand(eind) : `${Number(reeks[6]) + 1}-01-01` }; }
  const tot = new RegExp(`\\btot\\s+${D}`, "i").exec(t);
  if (tot) return { tot: datum(tot[1], tot[2], tot[3]) };
  const een = new RegExp(D, "i").exec(t.replace(/\(pdf[^)]*\)/i, ""));
  return een ? { vanaf: datum(een[1], een[2], een[3]) } : {};
}

export interface RichtlijnDoc { titel: string; reeks: string; url: string; vanaf?: string; tot?: string; sectiejaar?: number }

/** The PDF documents on a rechtspraak.nl page, with their title (link text, or the paragraph/heading above). */
export function parseRichtlijnPagina(html: string): RichtlijnDoc[] {
  const uit: RichtlijnDoc[] = [];
  let kop = "", context = "";
  let sectiejaar: number | undefined;
  const re = /<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>((?:(?!<\/p>|<a\b)[\s\S])*?)<\/p>|<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    if (m[1]) { kop = tekst(m[2]); context = ""; const j = /\b(19|20)\d{2}\b/.exec(kop)?.[0]; if (j) sectiejaar = Number(j); else if (m[1] !== "h4") sectiejaar = undefined; continue; }
    if (m[3] !== undefined) { const t = tekst(m[3]); if (t.endsWith(":")) context = t.slice(0, -1).trim(); continue; }
    const link = tekst(m[5]).replace(/\s*-\s*U verlaat Rechtspraak\.nl$/i, "");
    const kaal = link.replace(/\s*\((?:pdf|docx?|xlsx?)[^)]*\)/gi, "").trim();
    const alleenGeldigheid = /^(?:geldig|versie|per|vanaf|tot)\b/i.test(kaal) || kaal.length < 6;
    const titel = alleenGeldigheid ? `${context || kop} (${kaal})` : kaal;
    const reeks = (alleenGeldigheid ? context || kop : kaal).replace(/,?\s*(?:geldig|versie|per|vanaf)?\s*(?:\d{1,2}\s+)?(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)?\s*\d{4}(?:\s*(?:-|–|t\/m|tot)\s*(?:\d{1,2}\s+)?(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)?\s*\d{4})?/gi, "").replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim();
    const url = new URL(m[4].replace(/&amp;/g, "&"), BASE).toString();
    if (uit.some((d) => d.url === url && d.titel === titel)) continue;
    uit.push({ titel, reeks: reeks || titel, url, ...geldigheid(kaal), ...(sectiejaar ? { sectiejaar } : {}) });
  }
  return uit;
}

/** Per series the version in force on the date: the latest start on or before it, not ended. */
export function actueel(docs: RichtlijnDoc[], peildatum: string): Set<RichtlijnDoc> {
  const uit = new Set<RichtlijnDoc>();
  // A page divided per year ("Aangepast Rapport Alimentatienormen 2026", "… 2025"): only the latest year
  // up to the date counts; the older sections are the archive, whatever their documents are called.
  const jaren = [...new Set(docs.map((d) => d.sectiejaar).filter((j): j is number => !!j))];
  const peiljaar = Number(peildatum.slice(0, 4));
  const huidigJaar = jaren.length >= 3 ? Math.max(...jaren.filter((j) => j <= peiljaar)) : undefined;
  if (huidigJaar) docs = docs.filter((d) => !d.sectiejaar || d.sectiejaar === huidigJaar);
  for (const reeks of new Set(docs.map((d) => d.reeks))) {
    const leden = docs.filter((d) => d.reeks === reeks);
    const geldig = leden.filter((d) => (!d.vanaf || d.vanaf <= peildatum) && (!d.tot || d.tot > peildatum));
    const kies = geldig.sort((a, b) => (b.vanaf ?? "").localeCompare(a.vanaf ?? ""))[0];
    if (kies) uit.add(kies);
  }
  return uit;
}

export interface Paragraaf { pos: number; nummer: string; kopje: string }

/**
 * The numbered headings of a guideline's text ("3.2.6 Bijzondere kosten", "4.6.2 Lasten die …") and its page
 * footers ("26Rapport Alimentatienormen januari 2026": the page number glued to a footer text that recurs). The
 * table of contents (a heading followed by a page number) and footnotes (a number without a dot) are left out.
 */
export function structuur(tekst: string): { paragrafen: Paragraaf[]; paginas: Array<{ pos: number; pagina: number }> } {
  const paragrafen: Paragraaf[] = [];
  const kandidaten: Array<{ pos: number; pagina: number; rest: string }> = [];
  let pos = 0;
  const regels = tekst.split("\n");
  regels.forEach((regel, i) => {
    const l = regel.trim();
    const kop = /^(\d{1,2}\.(?:\d{1,2}\.?){0,3})\s+(\p{Lu}.{1,110})$/u.exec(l);
    const hoofd = kop ? kop[1].split(".").filter(Boolean).length === 1 : false;
    // A table-of-contents line ends in its page number, also when it wrapped onto the next line.
    const inhoud = (s: string) => /\s\d{1,3}$/.test(s);
    const volgende = regels[i + 1]?.trim() ?? "";
    if (kop && !inhoud(kop[2]) && !(volgende.length < 90 && inhoud(volgende) && !/^\d/.test(volgende)) && !/[€;]/.test(kop[2]) && !(hoofd && (kop[2].length > 70 || /[.,:]$/.test(kop[2])))) {
      paragrafen.push({ pos, nummer: kop[1].replace(/\.$/, ""), kopje: kop[2].trim() });
    }
    const voet = /^(\d{1,3})(\p{L}.{5,})$/u.exec(l);
    if (voet) kandidaten.push({ pos, pagina: Number(voet[1]), rest: voet[2].replace(/\s+/g, " ") });
    pos += regel.length + 1;
  });
  // A footer is the same text after the number on at least three pages.
  const tel = new Map<string, number>();
  for (const k of kandidaten) tel.set(k.rest, (tel.get(k.rest) ?? 0) + 1);
  const paginas = kandidaten.filter((k) => (tel.get(k.rest) ?? 0) >= 3).map(({ pos: p, pagina }) => ({ pos: p, pagina }));
  return { paragrafen, paginas };
}

const vouw = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** The anchor of a position: the last numbered heading before it and the page whose footer follows it. */
export function ankerVoor(st: ReturnType<typeof structuur>, pos: number): { paragraaf?: string; kopje?: string; pagina?: number } {
  const par = st.paragrafen.filter((p) => p.pos <= pos).at(-1);
  const pagina = st.paginas.find((p) => p.pos >= pos)?.pagina;
  return { ...(par ? { paragraaf: par.nummer, kopje: par.kopje } : {}), ...(pagina ? { pagina } : {}) };
}

/** Passages with the term, each with its paragraph, page, a link to that page of the PDF and a citation. */
export function passagesMetAnker(tekst: string, term: string, doc: Pick<RichtlijnDoc, "titel" | "url">, max = 30) {
  const st = structuur(tekst);
  let vanaf = 0;
  return passages(tekst, term, max).map((p) => {
    const i = tekst.indexOf(p, vanaf);
    const pos = i >= 0 ? i : vanaf;
    vanaf = pos + 1;
    // The anchor is the line with the term (usually the second: one line of context before it). A term in a
    // heading ("4.6.2 Woonlasten …") then belongs to that heading's paragraph.
    const lijnen = p.split("\n");
    const t = vouw(term);
    const k = Math.max(0, lijnen.findIndex((l) => vouw(l).includes(t)));
    const a = ankerVoor(st, pos + lijnen.slice(0, k).reduce((n, l) => n + l.length + 1, 0));
    const citeer = `${doc.titel}${a.paragraaf ? `, par. ${a.paragraaf}${a.kopje ? ` (${a.kopje})` : ""}` : ""}${a.pagina ? `, p. ${a.pagina}` : ""}`;
    return { tekst: p, ...a, ...(a.pagina ? { link: `${doc.url}#page=${a.pagina}` } : {}), citeer };
  });
}

const woorden = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const rec = (d: RichtlijnDoc, data: Record<string, unknown>): MCPRecord => ({ source_name: "rechtspraak.nl", title: d.titel, canonical_url: d.url, ...(d.vanaf ? { date: d.vanaf } : {}), data });
const NOTE = "Richtlijnen, aanbevelingen en procesreglementen van de rechtspraak (LOVF, LOVCK&T, expertgroep alimentatienormen): geen wet, maar de rechter volgt ze in de regel; afwijken moet hij motiveren. Procesreglementen binden partijen in de procedure. Noem titel, versie (geldig vanaf) en paragraaf.";

export function registerRichtlijnen(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  server.registerTool("rechtspraak_richtlijnen", {
    description:
      "Norms, recommendations and procedural rules of the Dutch judiciary from rechtspraak.nl, with the version in force on a date: " +
      Object.entries(RICHTLIJN_PAGINAS).map(([k, v]) => `${k} (${v.omschrijving})`).join("; ") +
      ". Without lees: the documents with their validity and which one is current. With lees: the text of the best match (current version), whole or only the passages with zoekterm (e.g. 'behoeftetabel', 'draagkrachtloos inkomen', 'woonlasten', 'termijn'). No criminal law.",
    inputSchema: {
      onderwerp: z.enum(Object.keys(RICHTLIJN_PAGINAS) as [string, ...string[]]),
      zoek: z.string().max(200).optional().describe("Words in the title, e.g. 'rapport alimentatienormen', 'bijlage', 'procesreglement verzoekschrift', 'liquidatietarief'."),
      peildatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date the version must be in force (default today)."),
      alle_versies: z.boolean().default(false).describe("List old versions too."),
      lees: z.boolean().default(false).describe("Read the text of the best matching current document."),
      zoekterm: z.string().max(200).optional(), max_chars: z.number().int().min(1000).max(100_000).default(20_000),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const pagina = RICHTLIJN_PAGINAS[a.onderwerp];
    const peildatum = a.peildatum ?? new Date().toISOString().slice(0, 10);
    try {
      const { data } = await getText(pagina.url, { connector: "rechtspraak_richtlijnen", headers: { "User-Agent": "Mozilla/5.0" }, timeoutMs: 30_000 });
      let docs = parseRichtlijnPagina(data);
      if (a.zoek) { const w = woorden(a.zoek); docs = docs.filter((d) => w.every((x) => woorden(d.titel).some((y) => y.startsWith(x)))); }
      const nu = actueel(docs, peildatum);
      const prov = { tool: "rechtspraak_richtlijnen", endpoint: pagina.url, query_params: Object.fromEntries(Object.entries({ onderwerp: a.onderwerp, zoek: a.zoek, peildatum, zoekterm: a.zoekterm }).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: 0, total_results: docs.length };
      if (!docs.length) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen documenten${a.zoek ? ` met '${a.zoek}'` : ""} op ${pagina.url}.`, suggestion: "Zoek met minder woorden, of kies een ander onderwerp." }));
      if (a.lees) {
        const doc = docs.find((d) => nu.has(d)) ?? docs[0];
        const r = await fetchPdfText(doc.url, { connector: "rechtspraak_richtlijnen", timeoutMs: 60_000, retries: 1, maxChars: 1_500_000, headers: { "User-Agent": "Mozilla/5.0" } });
        if (!r.ok) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `De PDF kon niet worden gelezen: ${r.message}`, suggestion: `Open ${doc.url}.` }));
        const body = a.zoekterm ? passages(r.text, a.zoekterm, 30).join("\n…\n") : r.text;
        // FORK: per passage the paragraph (number and heading) and page, so the guideline is cited with its paragraph.
        const metAnker = a.zoekterm ? passagesMetAnker(r.text, a.zoekterm, doc) : undefined;
        const st = structuur(r.text);
        const andere = docs.filter((d) => d !== doc && d.reeks === doc.reeks).map((d) => ({ titel: d.titel, vanaf: d.vanaf, tot: d.tot, url: d.url }));
        return toMcpToolPayload(successResponse({
          summary: `${doc.titel}${nu.has(doc) ? ` (geldig op ${peildatum})` : " (let op: niet als geldig op de peildatum herkend)"}: ${r.text.length} tekens${a.zoekterm ? `, passages met '${a.zoekterm}'` : ""}`,
          records: [rec(doc, { reeks: doc.reeks, geldig_vanaf: doc.vanaf, geldig_tot: doc.tot, actueel: nu.has(doc), tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body, ingekort: body.length > a.max_chars,
            ...(metAnker ? { passages: metAnker } : { paragrafen: st.paragrafen.slice(0, 300).map((p) => ({ paragraaf: p.nummer, kopje: p.kopje, ...ankerVoor(st, p.pos) })).map(({ paragraaf, kopje, pagina }) => ({ paragraaf, kopje, ...(pagina ? { pagina } : {}) })) }),
            andere_versies: andere })],
          provenance: { ...prov, returned_results: 1 },
          access_note: `${NOTE} Gelezen: ${doc.url}. ${metAnker ? "Per passage staan paragraaf, kopje, pagina en een link naar die pagina (passages[].citeer). " : "De paragrafen met hun pagina staan in paragrafen. "}${docs.length > 1 ? `Er passen ${docs.length} documenten bij de zoekopdracht; verfijn met zoek als dit niet het bedoelde is.` : ""}`,
        }));
      }
      const lijst = a.alle_versies ? docs : docs.filter((d) => nu.has(d) || (!d.vanaf && !d.tot));
      return toMcpToolPayload(successResponse({
        summary: `${pagina.omschrijving}: ${lijst.length} document(en)${a.alle_versies ? "" : ` geldig op ${peildatum}`} (van ${docs.length})`,
        records: lijst.map((d) => rec(d, { reeks: d.reeks, geldig_vanaf: d.vanaf, geldig_tot: d.tot, actueel: nu.has(d) })),
        provenance: { ...prov, returned_results: lijst.length },
        access_note: `${NOTE} Lees een document met lees: true en zoek (titelwoorden), eventueel met zoekterm voor de passages. ${a.alle_versies ? "" : "Oude versies: alle_versies: true, of een peildatum in het verleden."}`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "rechtspraak.nl", pagina.url)); }
  });
}

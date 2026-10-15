/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Supervisory authorities:
 * - Autoriteit Persoonsgegevens (autoriteitpersoonsgegevens.nl/documenten): fines, orders, warnings, decisions on
 *   objection, policy rules, standard interpretation (normuitleg), legislative opinions (wetgevingstoetsen),
 *   investigations and guidance; the site's own search with its document types, and the text (page + PDF).
 * The site has a firewall; when it refuses a request the tool says so and points to the official alternatives.
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { decodeEntities, htmlNaarTekst } from "./juridische-bronnen.js";
import { httpFetch, passages } from "./geschilbeslechting.js";

type Fetcher = typeof httpFetch;
type PdfLezer = (url: string) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;

export const AP_BASE = "https://autoriteitpersoonsgegevens.nl";
/** Documentsoorten van de AP-site (filter document_type[n]). */
export const AP_SOORTEN: Record<string, number> = {
  boete: 37, "last onder dwangsom": 38, waarschuwing: 40, verwerkingsverbod: 373, sanctie: 32, besluit: 4, "besluit op bezwaar": 35,
  "besluit vergunning": 33, "besluit gedragscode": 34, gedragscode: 380, beleidsregels: 25, normuitleg: 31, beleidsdocument: 20,
  wetgevingstoets: 6, onderzoek: 5, "extern onderzoek": 45, rapportage: 23, klachtenrapportage: 42, datalekrapportage: 43,
  handreiking: 48, handleiding: 47, voorbeeldbrief: 51, "woo-besluit": 36, jaarverslag: 3, overeenkomst: 27, "politiek document": 29,
};
const MAANDEN: Record<string, string> = { januari: "01", februari: "02", maart: "03", april: "04", mei: "05", juni: "06", juli: "07", augustus: "08", september: "09", oktober: "10", november: "11", december: "12" };
const isoDatum = (s?: string) => { const m = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(s ?? ""); return m && MAANDEN[m[2].toLowerCase()] ? `${m[3]}-${MAANDEN[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}` : undefined; };
const inline = (html: string) => decodeEntities(htmlNaarTekst(html)).replace(/\s*\n\s*/g, " ").trim();
const geweigerd = (status: number, text: string) => status === 403 || /The requested URL was rejected|support ID is/i.test(text);

/** De documentenlijst (Drupal-view): titel, link en datum per kaart. */
export function parseApLijst(html: string) {
  const items: Array<{ titel: string; url: string; datum?: string }> = [];
  for (const m of html.matchAll(/<article class="node-publication-card"[\s\S]*?<\/article>/g)) {
    const blok = m[0];
    const href = /href="(\/documenten\/[^"#?]+)"/.exec(blok)?.[1];
    const titel = inline(/<h3[^>]*class="node-publication-card__title"[^>]*>([\s\S]*?)<\/h3>/.exec(blok)?.[1] ?? "");
    if (!href || !titel) continue;
    const datum = inline(/class="node-publication-card__submitted"[^>]*>([\s\S]*?)<\/div>/.exec(blok)?.[1] ?? "");
    items.push({ titel, url: `${AP_BASE}${href}`, ...(isoDatum(datum) ? { datum: isoDatum(datum) } : {}) });
  }
  const volgende = /<a[^>]+href="[^"]*page=(\d+)[^"]*"[^>]*rel="next"/.exec(html)?.[1];
  return { items, volgende: volgende ? Number(volgende) : undefined };
}

/** Een documentpagina: titel, datum, thema's, inleiding en de pdf. */
export function parseApDocument(html: string) {
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const titel = inline(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? "");
  const tekst = decodeEntities(htmlNaarTekst(main.replace(/<(nav|form|aside|script|style)\b[\s\S]*?<\/\1>/gi, " ")));
  const regels = tekst.split("\n").map((l) => l.trim()).filter(Boolean);
  const datum = isoDatum(regels.find((l) => /^\d{1,2}\s+[a-z]+\s+\d{4}$/i.test(l)));
  const ti = regels.findIndex((l) => /^Thema'?s:?$/i.test(l));
  const themas: string[] = [];
  if (ti >= 0) for (const l of regels.slice(ti + 1, ti + 10)) { if (l.length > 60 || /[.:]$/.test(l)) break; themas.push(l); }
  const pdf = /href="([^"]+\.pdf[^"]*)"/i.exec(main)?.[1];
  return { titel, datum, themas, tekst: regels.filter((l) => !/^(Kruimelpad|Home|Documenten|Download document|Deze pagina is bijgewerkt op)$/i.test(l)).join("\n"), ...(pdf ? { pdf: new URL(decodeEntities(pdf), AP_BASE).toString() } : {}) };
}

const rec = (title: string, url: string, date: string | undefined, snippet: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: "autoriteitpersoonsgegevens.nl", title, canonical_url: url, ...(date ? { date } : {}), ...(snippet ? { snippet: snippet.slice(0, 400) } : {}), data });
const NOTE = "Bron: Autoriteit Persoonsgegevens. Besluiten (boete, last onder dwangsom, waarschuwing) zijn besluiten van een bestuursorgaan, geen rechtspraak: kijk ook of er bezwaar of beroep is ingesteld (rechtspraak_search_ecli met de naam van de partij en 'Autoriteit Persoonsgegevens'). Beleidsregels binden de AP (art. 4:84 Awb) en staan ook in de Staatscourant; normuitleg en handreikingen tonen hoe de AP de AVG uitlegt, maar binden de rechter niet. Laat elke verwijzing controleren met verify_legal_reference.";
const WEIGERING = "De AP-site weigerde de aanvraag (firewall). Alternatieven: beleidsregels via officiele_bekendmakingen_search (Staatscourant, 'Autoriteit Persoonsgegevens'), AP-stukken via woo_zoeken (organisatie 'Autoriteit Persoonsgegevens'), en de rechtspraak over AP-besluiten via rechtspraak_search_ecli. Open de AP-site anders in een browser.";

const defaultPdf: PdfLezer = async (url) => {
  const r = await fetchPdfText(url, { connector: "ap", timeoutMs: 60_000, retries: 1, maxChars: 800_000 });
  return r.ok ? { ok: true, text: r.text } : { ok: false, message: r.message };
};

export function registerToezicht(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, f: Fetcher = httpFetch, leesPdf: PdfLezer = defaultPdf): void {
  const prov = (tool: string, endpoint: string, p: Record<string, unknown>, n: number, total: number) => ({ tool, endpoint, query_params: Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: n, total_results: total });

  server.registerTool("ap_documenten_zoeken", {
    description: `Search documents of the Autoriteit Persoonsgegevens (Dutch data protection authority, autoriteitpersoonsgegevens.nl): fines, orders subject to a penalty, warnings, processing bans, decisions on objection, codes of conduct, policy rules, normuitleg (how the AP interprets the GDPR), legislative opinions, investigations, guidance and model letters. Free text and document type (soort: ${Object.keys(AP_SOORTEN).join(", ")}). Returns title, date and link; read with ap_document_get.`,
    inputSchema: { zoekterm: z.string().max(200).optional(), soort: z.array(z.string().max(40)).max(6).optional(), pagina: z.number().int().min(1).max(100).default(1) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const u = new URL(`${AP_BASE}/documenten`);
    if (a.zoekterm) u.searchParams.set("keys", a.zoekterm);
    for (const s of a.soort ?? []) {
      const n = AP_SOORTEN[s.toLowerCase().trim()];
      if (n === undefined) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Documentsoort '${s}' onbekend.`, suggestion: `Kies uit: ${Object.keys(AP_SOORTEN).join(", ")}.` }));
      u.searchParams.set(`document_type[${n}]`, String(n));
    }
    if (a.pagina > 1) u.searchParams.set("page", String(a.pagina - 1));
    try {
      const r = await f(u.toString());
      if (geweigerd(r.status, r.text)) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `De AP-site weigerde de aanvraag (HTTP ${r.status}).`, suggestion: WEIGERING }));
      const { items, volgende } = parseApLijst(r.text);
      const records = items.map((i) => rec(i.titel, i.url, i.datum, undefined, { ...i }));
      return toMcpToolPayload(successResponse({ summary: `Autoriteit Persoonsgegevens: ${records.length} documenten (pagina ${a.pagina})${volgende !== undefined ? "; er zijn meer pagina's" : ""}`, records, provenance: prov("ap_documenten_zoeken", u.toString(), { zoekterm: a.zoekterm, soort: a.soort?.join(","), pagina: a.pagina }, records.length, records.length), access_note: NOTE }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Autoriteit Persoonsgegevens", AP_BASE)); }
  });

  server.registerTool("ap_document_get", {
    description: "One document of the Autoriteit Persoonsgegevens by its link from ap_documenten_zoeken: title, date, themes, the page text and the full text of the PDF (the decision, policy rule or report itself), or only the passages with a search term.",
    inputSchema: { url: z.string().url().max(500), zoekterm: z.string().max(150).optional(), max_chars: z.number().int().min(1000).max(100_000).default(30_000) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const u = new URL(a.url);
    if (!/^(www\.)?autoriteitpersoonsgegevens\.nl$/.test(u.hostname) || u.protocol !== "https:") return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Alleen links van autoriteitpersoonsgegevens.nl.", suggestion: "Gebruik een link uit ap_documenten_zoeken." }));
    try {
      let pdfUrl: string | undefined, d: ReturnType<typeof parseApDocument> | undefined;
      if (/\.pdf/i.test(u.pathname + u.search)) pdfUrl = a.url;
      else {
        const r = await f(a.url);
        if (geweigerd(r.status, r.text)) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `De AP-site weigerde de aanvraag (HTTP ${r.status}).`, suggestion: WEIGERING }));
        if (r.status !== 200) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `AP-document niet gevonden (HTTP ${r.status}).`, suggestion: "Zoek het opnieuw met ap_documenten_zoeken." }));
        d = parseApDocument(r.text);
        pdfUrl = d.pdf;
      }
      const pdf = pdfUrl ? await leesPdf(pdfUrl) : undefined;
      const tekst = [d?.tekst, pdf?.ok ? `— Document (pdf) —\n${pdf.text}` : undefined].filter(Boolean).join("\n\n");
      const body = a.zoekterm ? passages(tekst, a.zoekterm).join("\n…\n") : tekst;
      return toMcpToolPayload(successResponse({
        summary: `${d?.titel ?? a.url}${d?.datum ? ` (${d.datum})` : ""}: ${tekst.length} tekens${pdf && !pdf.ok ? `; pdf niet gelezen: ${pdf.message}` : ""}`,
        records: [rec(d?.titel ?? a.url, a.url, d?.datum, undefined, { ...(d ? { titel: d.titel, datum: d.datum, themas: d.themas } : {}), ...(pdfUrl ? { pdf: pdfUrl } : {}), tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body, ingekort: body.length > a.max_chars })],
        provenance: prov("ap_document_get", a.url, { url: a.url, zoekterm: a.zoekterm }, 1, 1), access_note: NOTE,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Autoriteit Persoonsgegevens", a.url)); }
  });
}

/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Woo documents (Wet open overheid) from
 * open.overheid.nl, the platform for DiWoo publications (Woo-besluiten, Woo-verzoeken,
 * beslisnota's, adviezen, convenanten, onderzoeksrapporten …) of all government bodies.
 * Registered from registerEuForkTools, so no extra hook in upstream files.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, MCPRecord } from "../types.js";
import { OverheidsorganisatiesSource } from "../sources/overheidsorganisaties.js";
import { haalWooIndex, isVeiligeUrl, volgLocatie, type LocatieResultaat } from "./woo-index.js";
import { getJson } from "../utils/http.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";

export const WOO_API = "https://open.overheid.nl/overheid/openbaarmakingen/api/v0";
const CONNECTOR = "open_overheid";
const TIMEOUT_MS = 30_000;
const FACET_MAX = 25;

export interface WooZoekArgs {
  zoektekst?: string;
  organisatie?: string[];
  documentsoort?: string;
  informatiecategorie?: string;
  thema?: string;
  van?: string;
  tot?: string;
  aantal?: number;
  start?: number;
}

interface WooHit {
  document?: { id?: string; pid?: string; titel?: string; omschrijving?: string; openbaarmakingsdatum?: string; publisher?: string; aanbieder?: string; mutatiedatumtijd?: string };
  bestandsgrootte?: string;
  aantalPaginas?: number;
  bestandsType?: string;
  highlightedText?: string;
}
type WooFacet = Array<{ naam: string; aantal: number }>;
export interface WooZoekResponse { totaal?: number; resultaten?: WooHit[]; filters?: Record<string, WooFacet> }

/** 2024-01-31 or 31-01-2024 → 31-01-2024 (the API only takes dd-mm-jjjj). */
export function wooDatum(v: string | undefined): string | undefined | null {
  if (!v?.trim()) return undefined;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  return m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[3]}` : null;
}

/** The document id the download endpoint takes: the last segment of the pid (search ids may carry a version suffix like "_1"). */
export function wooDocumentId(idOrUrl: string): string | null {
  const s = idOrUrl.trim();
  const fromUrl = /open\.overheid\.nl\/(?:[^\s?#]*\/)?documenten\/([A-Za-z0-9._-]+)/.exec(s)?.[1];
  const id = (fromUrl ?? s).replace(/_\d+$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{5,120}$/.test(id) ? id : null;
}

export function wooZoekUrl(a: WooZoekArgs): string {
  const u = new URL(`${WOO_API}/zoek`);
  if (a.zoektekst?.trim()) u.searchParams.set("zoektekst", a.zoektekst.trim());
  for (const o of a.organisatie ?? []) if (o.trim()) u.searchParams.append("organisatie", o.trim());
  if (a.documentsoort) u.searchParams.set("documentsoort", a.documentsoort);
  if (a.informatiecategorie) u.searchParams.set("informatiecategorie", a.informatiecategorie);
  if (a.thema) u.searchParams.set("thema", a.thema);
  const van = wooDatum(a.van), tot = wooDatum(a.tot);
  if (van) u.searchParams.set("publicatiedatumVan", van);
  if (tot) u.searchParams.set("publicatiedatumTot", tot);
  u.searchParams.set("aantalResultaten", String(a.aantal ?? 20));
  if (a.start) u.searchParams.set("start", String(a.start));
  return u.toString();
}

export function wooRecords(r: WooZoekResponse): MCPRecord[] {
  return (r.resultaten ?? []).map((h) => {
    const d = h.document ?? {};
    const id = wooDocumentId(d.pid ?? d.id ?? "") ?? d.id ?? "";
    return {
      source_name: "open.overheid.nl",
      title: d.titel?.trim() || id,
      date: d.openbaarmakingsdatum,
      canonical_url: d.pid ?? `https://open.overheid.nl/documenten/${id}`,
      snippet: (h.highlightedText ?? d.omschrijving ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
      data: {
        document_id: id,
        organisatie: d.publisher,
        omschrijving: d.omschrijving,
        openbaarmakingsdatum: d.openbaarmakingsdatum,
        bestandstype: h.bestandsType,
        paginas: h.aantalPaginas,
        grootte: h.bestandsgrootte,
        download_url: `${WOO_API}/documenten/${id}`,
      },
    };
  });
}

export function wooFacetten(r: WooZoekResponse): Record<string, WooFacet> {
  return Object.fromEntries(Object.entries(r.filters ?? {}).map(([k, v]) => [k, [...(v ?? [])].sort((a, b) => b.aantal - a.aantal).slice(0, FACET_MAX)]));
}

const NOTE =
  "Bron: open.overheid.nl (KOOP), het platform waarop overheidsorganisaties Woo-documenten actief openbaar maken (DiWoo-metadata: documentsoort, informatiecategorie uit art. 3.3 Woo, thema, organisatie). " +
  "Niet alle organisaties publiceren hier al: ontbreekt iets, zoek dan ook op de eigen website van het bestuursorgaan, in ori_search (gemeenteraad) of officiele_bekendmakingen_search. " +
  "Filters werken alleen met de exacte namen uit 'facetten' (hoofdletters tellen); meerdere organisaties = of/of. Resultaten staan op openbaarmakingsdatum, nieuwste eerst.";

/** open.overheid.nl spells bodies like the register, sometimes with a lower-case kind ("gemeente Dordrecht"). */
export function wooOrganisatieNamen(label: string): string[] {
  const l = label.trim();
  return [...new Set([l, l.charAt(0).toLowerCase() + l.slice(1)])];
}

export function registerWooTools(server: McpServer, deps: { config: AppConfig; TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  const organisaties = new OverheidsorganisatiesSource(deps.config);
  server.registerTool("woo_zoeken", {
    description:
      "Search Woo publications (Wet open overheid) on open.overheid.nl: Woo-besluiten and the documents released with them, beslisnota's, adviezen, convenanten, onderzoeksrapporten, beschikkingen, jaarverslagen, of ministries, provinces, municipalities, water boards and other bodies. " +
      "Full-text search plus filters on organisatie, documentsoort, informatiecategorie (e.g. 'Woo-verzoeken en -besluiten'), thema and publication date. Returns records with a download link, plus facet counts with the exact filter names. Use woo_document_get for the text of one document.",
    inputSchema: {
      zoektekst: z.string().max(300).optional().describe("Search words, e.g. 'executoriaal beslag' or 'windturbine geluid'."),
      organisatie: z.union([z.string().max(150), z.array(z.string().max(150)).max(10)]).optional().describe("Exact name as in facetten.organisatie, e.g. 'gemeente Dordrecht', 'ministerie van Financiën'. Several = any of them."),
      documentsoort: z.string().max(120).optional().describe("Exact name as in facetten.documentsoort, e.g. 'beleidsregel', 'advies'."),
      informatiecategorie: z.string().max(150).optional().describe("Exact name as in facetten.informatiecategorie, e.g. 'Woo-verzoeken en -besluiten', 'beschikkingen', 'onderzoeksrapporten'."),
      thema: z.string().max(120).optional().describe("Exact name as in facetten.thema."),
      van: z.string().max(10).optional().describe("Published on or after (2024-01-31 or 31-01-2024)."),
      tot: z.string().max(10).optional().describe("Published on or before."),
      aantal: z.union([z.literal(10), z.literal(20), z.literal(50)]).default(20),
      start: z.number().int().min(0).max(10_000).default(0).describe("Offset for paging."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (args) => {
    const organisatie = typeof args.organisatie === "string" ? [args.organisatie] : args.organisatie;
    for (const [k, v] of [["van", args.van], ["tot", args.tot]] as const) {
      if (wooDatum(v) === null) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Datum ${k} '${v}' niet begrepen.`, suggestion: "Gebruik jjjj-mm-dd of dd-mm-jjjj." }));
    }
    const url = wooZoekUrl({ ...args, organisatie });
    const params = Object.fromEntries(Object.entries({ ...args, organisatie: organisatie?.join(" | ") }).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    try {
      const { data } = await getJson<WooZoekResponse>(url, { connector: CONNECTOR, timeoutMs: TIMEOUT_MS, retries: 1, headers: { Accept: "application/json" } });
      const records = wooRecords(data);
      const totaal = data.totaal ?? records.length;
      return toMcpToolPayload(successResponse({
        summary: `${totaal} Woo-publicaties${args.zoektekst ? ` voor '${args.zoektekst}'` : ""}; ${records.length} getoond vanaf ${args.start}`,
        records,
        provenance: { tool: "woo_zoeken", endpoint: url, query_params: params, timestamp: nowIso(), returned_results: records.length, total_results: totaal },
        access_note: `${NOTE} Facetten (top ${FACET_MAX}, exacte namen voor de filters): ${JSON.stringify(wooFacetten(data))}`,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "open.overheid.nl", "https://open.overheid.nl"));
    }
  });

  server.registerTool("woo_document_get", {
    description: "Text of one Woo document (PDF converted to text): a document_id from woo_zoeken, an open.overheid.nl/documenten/… URL, or the URL of a PDF on a government body's own website as found by woo_index. Optionally only the passages around a search term.",
    inputSchema: {
      id: z.string().max(1000).describe("document_id, open.overheid.nl URL or PDF URL from woo_index."),
      zoekterm: z.string().max(120).optional().describe("Only return passages containing this term (case-insensitive)."),
      max_chars: z.number().int().min(1_000).max(100_000).default(20_000),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ id, zoekterm, max_chars }) => {
    const extern = /^https?:\/\//i.test(id.trim()) && !/open\.overheid\.nl\//i.test(id);
    if (extern && !isVeiligeUrl(id.trim())) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Geen openbaar webadres.", suggestion: "Gebruik een link uit woo_index of woo_zoeken." }));
    const docId = extern ? decodeURIComponent(new URL(id.trim()).pathname.split("/").pop() || id) : wooDocumentId(id);
    if (!docId) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen open.overheid.nl-document in '${id.slice(0, 100)}'.`, suggestion: "Gebruik document_id uit woo_zoeken of een PDF-link uit woo_index." }));
    const url = extern ? new URL(id.trim()).toString() : `${WOO_API}/documenten/${docId}`;
    const canonical = extern ? url : `https://open.overheid.nl/documenten/${docId}`;
    const prov = (n: number) => ({ tool: "woo_document_get", endpoint: url, query_params: { id, ...(zoekterm ? { zoekterm } : {}), max_chars: String(max_chars) }, timestamp: nowIso(), returned_results: n, total_results: n });
    try {
      const pdf = await fetchPdfText(url, { connector: CONNECTOR, timeoutMs: 60_000, retries: 1, maxChars: 400_000 });
      if (!pdf.ok) {
        return toMcpToolPayload(successResponse({ summary: `${docId}: geen tekst (${pdf.reason})`, records: [{ source_name: extern ? new URL(url).hostname : "open.overheid.nl", title: docId, canonical_url: canonical, data: { document_id: docId, download_url: url, fout: pdf.message } }], provenance: prov(0), access_note: `${NOTE} Het document kon niet als PDF-tekst worden gelezen (${pdf.message}); open het via de link. Gescande stukken zonder tekstlaag geven geen tekst.` }));
      }
      const passages = zoekterm ? wooPassages(pdf.text, zoekterm) : null;
      const body = passages ? passages.join("\n…\n") : pdf.text;
      const tekst = body.length > max_chars ? `${body.slice(0, max_chars)}…` : body;
      return toMcpToolPayload(successResponse({
        summary: `${docId}: ${pdf.pages} pagina's, ${pdf.total_chars} tekens${passages ? `; ${passages.length} passages met '${zoekterm}'` : ""}`,
        records: [{ source_name: extern ? new URL(url).hostname : "open.overheid.nl", title: docId, canonical_url: canonical, data: { document_id: docId, paginas: pdf.pages, tekens: pdf.total_chars, ingekort: body.length > max_chars || pdf.truncated, ...(passages ? { passages: passages.length } : {}), tekst } }],
        provenance: prov(1),
        access_note: `${NOTE} Tekst automatisch uit de PDF gehaald: lakken (art. 5.1/5.2 Woo) zijn als weggelaten tekst zichtbaar; citeer na controle in de PDF.`,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "open.overheid.nl", canonical));
    }
  });

  registerWooIndexTool(server, deps, organisaties);
}

export function registerWooIndexTool(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, organisaties: Pick<OverheidsorganisatiesSource, "search">): void {
  server.registerTool("woo_index", {
    description:
      "The Woo-index of one government body (Register van Overheidsorganisaties, organisaties.overheid.nl/woo, linked from open.overheid.nl/verwijzingen): where it publishes each Woo information category (Woo-besluiten, convenanten, onderzoeksrapporten, beschikkingen, besluitenlijsten …), plus how many of its documents are on open.overheid.nl. " +
      "With volg_links (default) the tool follows those links and lists the documents found there, filtered on zoekterm: the body's own website (list pages and their PDF attachments) and the Staatscourant/Gemeenteblad searches the index points to. " +
      "Many bodies publish most Woo documents only on their own site (UWV: hundreds of Woo-besluiten on uwv.nl, a handful on open.overheid.nl), so use this next to woo_zoeken.",
    inputSchema: {
      organisatie: z.string().min(2).max(150).describe("Name or abbreviation: 'UWV', 'gemeente Dordrecht', 'Belastingdienst', 'ministerie van Defensie', or a TOOI URI."),
      zoekterm: z.string().max(150).optional().describe("Words that must all occur in a document's title (own website) or text (bekendmakingen)."),
      informatiecategorie: z.string().max(120).optional().describe("Only locations whose category contains this ('Woo-verzoeken', 'convenant', 'onderzoeksrapport')."),
      volg_links: z.boolean().default(true),
      diepte: z.union([z.literal(1), z.literal(2)]).default(2).describe("2 = also list the attachments (PDFs) on the matching sub-pages, e.g. the documents of a Woo-besluit."),
      max_per_locatie: z.number().int().min(1).max(200).default(25),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ organisatie, zoekterm, informatiecategorie, volg_links, diepte, max_per_locatie }) => {
    const params = Object.fromEntries(Object.entries({ organisatie, zoekterm, informatiecategorie, volg_links, diepte, max_per_locatie }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    try {
      let tooi = /^https:\/\/identifier\.overheid\.nl\/tooi\/id\//.test(organisatie.trim()) ? organisatie.trim() : null;
      let alternatieven: string[] = [];
      if (!tooi) {
        const r = await organisaties.search({ query: organisatie, rows: 5, enrich: false, activeOnly: true });
        tooi = r.items[0]?.tooi_uri ?? null;
        alternatieven = r.items.slice(1).map((i) => i.title);
      }
      if (!tooi) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen overheidsorganisatie gevonden voor '${organisatie}'.`, suggestion: "Zoek de naam met overheidsorganisaties_search." }));
      const { data: idx, url: indexUrl } = await haalWooIndex(tooi);
      const label = idx.label ?? organisatie;
      const locaties = (idx.wooIndex ?? []).filter((l) => !informatiecategorie || l.informatiecategorie?.toLowerCase().includes(informatiecategorie.toLowerCase()));

      // What open.overheid.nl holds for this body, for comparison.
      let openOverheid: { organisatie: string; totaal: number; url: string } | null = null;
      for (const naam of wooOrganisatieNamen(label)) {
        try {
          const u = wooZoekUrl({ zoektekst: zoekterm, organisatie: [naam], aantal: 10 });
          const { data } = await getJson<WooZoekResponse>(u, { connector: CONNECTOR, timeoutMs: TIMEOUT_MS, retries: 0, headers: { Accept: "application/json" } });
          if (data.totaal) { openOverheid = { organisatie: naam, totaal: data.totaal, url: u }; break; }
        } catch { break; }
      }

      const opts = { zoekterm, diepte: diepte as 1 | 2, maxPerLocatie: max_per_locatie };
      const resultaten: LocatieResultaat[] = volg_links
        ? await Promise.all(locaties.map((l) => volgLocatie(l, opts)))
        : locaties.map((l) => ({ ...l, methode: "overgeslagen" as const, gevonden: null, documenten: [] }));
      const n = resultaten.reduce((a, r) => a + r.documenten.length, 0);
      const records: MCPRecord[] = [
        {
          source_name: "organisaties.overheid.nl",
          title: `Woo-index ${label}`,
          canonical_url: idx.wooInformatie?.overzichtUrl ?? indexUrl,
          data: {
            organisatie: label, tooi_uri: tooi, woo_pagina: idx.wooInformatie?.url,
            locaties: (idx.wooIndex ?? []).length,
            open_overheid: openOverheid ?? { totaal: 0, opmerking: "Geen documenten van deze organisatie gevonden op open.overheid.nl (met deze zoekterm)." },
            ...(alternatieven.length ? { andere_treffers: alternatieven } : {}),
          },
        },
        ...resultaten.map((r) => ({
          source_name: "woo-index",
          title: `${r.informatiecategorie}${r.toelichting ? ` — ${r.toelichting}` : ""}`,
          canonical_url: r.url,
          snippet: r.documenten.slice(0, 3).map((d) => d.titel).join(" | ") || r.opmerking || r.fout,
          data: { ...r },
        })),
      ];
      return toMcpToolPayload(successResponse({
        summary: `${label}: ${(idx.wooIndex ?? []).length} locaties in de Woo-index${volg_links ? `; ${n} documenten/pagina's gevonden${zoekterm ? ` voor '${zoekterm}'` : ""}` : ""}; open.overheid.nl: ${openOverheid?.totaal ?? 0}`,
        records,
        provenance: { tool: "woo_index", endpoint: indexUrl, query_params: params, timestamp: nowIso(), returned_results: records.length, total_results: records.length },
        access_note:
          "Bron: Woo-index in het Register van Overheidsorganisaties (api-organisaties.overheid.nl, /woo), de locaties die het bestuursorgaan zelf opgeeft per informatiecategorie (art. 3.3 Woo). " +
          "De gevolgde websites zijn per organisatie anders ingericht: 'gevonden' telt wat de tool op de pagina kon lezen (titels; bij bekendmakingen de tekst). Ontbreekt iets, open dan de locatie zelf. " +
          "methode 'lijst-api' = de lijst achter de pagina is volledig doorzocht; 'html' = alleen de links op de pagina; bijlagen = de PDF's op de gevonden subpagina's (lees ze met woo_document_get of fetch). " +
          "Woo-documenten die niet op open.overheid.nl staan, komen hier wel naar voren; zoek daarnaast met woo_zoeken.",
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "Woo-index", "https://organisaties.overheid.nl/woo"));
    }
  });
}

/** Paragraph-ish passages containing the term, with one line of context on each side. */
export function wooPassages(text: string, term: string): string[] {
  const lines = text.split(/\n+/);
  const t = term.toLowerCase();
  const out: string[] = [];
  let last = -2;
  lines.forEach((l, i) => {
    if (!l.toLowerCase().includes(t)) return;
    const from = Math.max(i - 1, last + 2), to = Math.min(i + 1, lines.length - 1);
    if (from <= to) out.push(lines.slice(from, to + 1).join("\n"));
    last = to - 1;
  });
  return out;
}

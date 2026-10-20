/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Legal literature from open scholarly sources:
 * - literatuur_zoeken: OpenAlex (api.openalex.org, free and open, CC0 metadata), OpenAIRE Graph (European
 *   repositories with peer review status) and CORE (repository full texts) — dissertations, articles in
 *   journals, books and reports, with author, institution, journal or repository, DOI, citations and the
 *   open access location. Filters for type, language, country of the institution (NL, BE), open access,
 *   field of law and years.
 * - literatuur_document_get: the text of one open access work (PDF or repository page), tried over all its
 *   open access locations; many university portals (Pure) sit behind a browser check, which is reported.
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

export const OPENALEX = "https://api.openalex.org";
export const CORE_API = "https://api.core.ac.uk/v3";
export const OPENAIRE_API = "https://api.openaire.eu/graph/v1/researchProducts";
const OPENAIRE_TOKEN_URL = "https://aai.openaire.eu/oidc/token";
const OPENAIRE_REFRESH_URL = "https://services.openaire.eu/uoa-user-management/api/users/getAccessToken";
/** OAPEN Library en Directory of Open Access Books, als bron in OpenAlex. */
const OAPEN_BRONNEN = "S4306402535|S4306400539";
/** Gratis sleutels: zonder sleutel delen OpenAlex en CORE een klein budget per IP-adres. */
const sleutel = (naam: "OPENALEX_API_KEY" | "CORE_API_KEY" | "OPENAIRE_REFRESH_TOKEN" | "OPENAIRE_CLIENT_ID" | "OPENAIRE_CLIENT_SECRET" | "GOOGLE_BOOKS_API_KEY") => process.env[naam]?.trim() || undefined;
/** Een sleutel hoort nooit in de uitvoer. */
export const zonderSleutel = (url: string) => url.replace(/([?&])(?:api_key|key)=[^&]*&?/, "$1").replace(/[?&]$/, "");
export const GOOGLE_BOOKS = "https://www.googleapis.com/books/v1/volumes";

/** Google Books: één boek (volume) naar de velden van literatuur_zoeken. */
export function googleBooksWerk(i: W) {
  const v = (i.volumeInfo ?? {}) as W;
  const ids = (v.industryIdentifiers ?? []) as W[];
  const isbn = ids.find((x) => x.type === "ISBN_13")?.identifier ?? ids.find((x) => x.type === "ISBN_10")?.identifier;
  return {
    id: `gb:${i.id}`, titel: [v.title, v.subtitle].filter(Boolean).join(": "), auteurs: (v.authors ?? []) as string[], jaar: Number(String(v.publishedDate ?? "").slice(0, 4)) || undefined,
    datum: v.publishedDate as string | undefined, uitgever: v.publisher as string | undefined, isbn, soort: "boek", taal: v.language as string | undefined, paginas: v.pageCount as number | undefined,
    categorieen: v.categories as string[] | undefined, beschrijving: v.description ? String(v.description).replace(/<[^>]+>/g, " ").slice(0, 800) : undefined,
    herkomst_beschrijving: v.description ? "beschrijving van de uitgever of Google Books: voor selectie, niet om te citeren" : undefined,
    inkijk: i.accessInfo?.viewability && i.accessInfo.viewability !== "NO_PAGES" ? (i.accessInfo.viewability === "ALL_PAGES" ? "volledig te lezen" : "gedeeltelijk in te zien") : "geen inkijk",
    pagina: (v.infoLink ?? v.canonicalVolumeLink) as string | undefined,
    betrouwbaarheid: "boek: controleer uitgever en druk (handboek, monografie of praktijkboek)",
  };
}
const VELDEN = "id,doi,title,display_name,publication_year,publication_date,type,language,authorships,primary_location,best_oa_location,locations,open_access,cited_by_count,abstract_inverted_index,primary_topic,biblio";
const SOORT: Record<string, string> = { proefschrift: "dissertation", artikel: "article", boek: "book|book-chapter", rapport: "report", preprint: "preprint" };
const SOORT_NL: Record<string, string> = { dissertation: "proefschrift", article: "artikel", book: "boek", "book-chapter": "boekhoofdstuk", report: "rapport", preprint: "preprint (niet beoordeeld)", review: "recensie", other: "overig", dataset: "dataset", editorial: "redactioneel stuk", letter: "brief" };

type W = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** OpenAlex slaat de samenvatting op als omgekeerde index; terug naar tekst. */
export function samenvatting(inv: Record<string, number[]> | null | undefined): string | undefined {
  if (!inv) return undefined;
  const woorden: string[] = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) woorden[p] = w;
  const t = woorden.filter(Boolean).join(" ").trim();
  return t || undefined;
}

/** Hoe betrouwbaar is het soort publicatie? Een proefschrift is verdedigd, een tijdschrift in DOAJ is peer-reviewed open access. */
export function status(w: W): string {
  const src = w.primary_location?.source ?? {};
  if (w.type === "dissertation") return "proefschrift (openbaar verdedigd)";
  if (w.type === "preprint" || /ssrn|arxiv|preprint/i.test(String(src.display_name ?? ""))) return "preprint of werkdocument: niet door vakgenoten beoordeeld";
  if (src.type === "journal") return src.is_in_doaj ? "artikel in een peer-reviewed open-accesstijdschrift (DOAJ)" : "artikel in een tijdschrift";
  if (src.type === "repository") return "publicatie in een universiteitsrepositorium";
  return SOORT_NL[w.type] ?? w.type ?? "onbekend";
}

const kortId = (id: string) => String(id ?? "").replace(/^https?:\/\/openalex\.org\//, "");

/** OpenAlex-werk → leesbare velden. */
export function werk(w: W) {
  const src = w.primary_location?.source ?? {};
  const instellingen = [...new Set((w.authorships ?? []).flatMap((a: W) => (a.institutions ?? []).map((i: W) => i.display_name)).filter(Boolean))] as string[];
  const oa = w.best_oa_location ?? {};
  return {
    id: kortId(w.id), titel: String(w.display_name ?? w.title ?? "").replace(/\s+/g, " ").trim(), jaar: w.publication_year, datum: w.publication_date,
    soort: SOORT_NL[w.type] ?? w.type, betrouwbaarheid: status(w),
    auteurs: (w.authorships ?? []).slice(0, 8).map((a: W) => a.author?.display_name).filter(Boolean),
    instellingen: instellingen.slice(0, 5),
    bron: src.display_name, ...(src.issn_l ? { issn: src.issn_l } : {}), ...(w.biblio?.volume ? { jaargang: w.biblio.volume, nummer: w.biblio.issue, paginas: [w.biblio.first_page, w.biblio.last_page].filter(Boolean).join("-") || undefined } : {}),
    taal: w.language, doi: w.doi ?? undefined, geciteerd: w.cited_by_count ?? 0,
    open_access: Boolean(w.open_access?.is_oa), ...(w.open_access?.is_oa ? { oa_link: oa.pdf_url ?? oa.landing_page_url ?? w.open_access?.oa_url } : {}),
    pagina: w.primary_location?.landing_page_url ?? w.doi ?? undefined,
    vakgebied: w.primary_topic?.subfield?.display_name, onderwerp: w.primary_topic?.display_name,
    samenvatting: samenvatting(w.abstract_inverted_index)?.slice(0, 1500),
  };
}

export function zoekUrl(a: { zoekterm: string; zoeken_in?: string; bron?: string; soort?: string; taal?: string; land?: string; alleen_open_access?: boolean; recht?: boolean; van?: number; tot?: number; sortering?: string; pagina?: number; aantal?: number }): string {
  const f: string[] = [];
  // Standaard alleen in titel en samenvatting: zoeken in de volledige tekst geeft veel ruis.
  const precies = a.zoeken_in !== "alles";
  if (precies) f.push(`title_and_abstract.search:${a.zoekterm.replace(/[,:|]/g, " ").trim()}`);
  if (a.soort && a.soort !== "alle") f.push(`type:${SOORT[a.soort] ?? a.soort}`);
  else f.push("type:!dataset"); // datasets (archeologie, metingen) zijn geen literatuur
  if (a.taal && a.taal !== "alle") f.push(`language:${a.taal}`);
  if (a.land && a.land !== "alle") f.push(`authorships.institutions.country_code:${a.land === "NL+BE" ? "NL|BE" : a.land}`);
  if (a.alleen_open_access) f.push("is_oa:true");
  if (a.recht) f.push("primary_topic.subfield.id:3308");
  if (a.bron === "oa_boeken") f.push(`locations.source.id:${OAPEN_BRONNEN}`);
  if (a.van || a.tot) f.push(`publication_year:${a.van ?? 1800}-${a.tot ?? 2100}`);
  const u = new URL(`${OPENALEX}/works`);
  if (!precies) u.searchParams.set("search", a.zoekterm);
  if (f.length) u.searchParams.set("filter", f.join(","));
  if (a.sortering === "nieuwste") u.searchParams.set("sort", "publication_date:desc");
  else if (a.sortering === "meest_geciteerd") u.searchParams.set("sort", "cited_by_count:desc");
  u.searchParams.set("per-page", String(a.aantal ?? 20));
  u.searchParams.set("page", String(a.pagina ?? 1));
  u.searchParams.set("select", VELDEN);
  const k = sleutel("OPENALEX_API_KEY");
  if (k) u.searchParams.set("api_key", k);
  return u.toString();
}

/** OpenAIRE-resultaat → dezelfde velden; met of een vindplaats door vakgenoten is beoordeeld. */
export function openaireWerk(r: W) {
  const inst = (r.instances ?? []) as W[];
  const urls = [...new Set(inst.flatMap((i) => i.urls ?? []).filter((u: string) => /^https?:\/\//.test(u) && !/^https?:\/\/(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(u)))] as string[];
  const doi = ((r.pids ?? []) as W[]).find((p) => /doi/i.test(p.scheme ?? p.id?.scheme ?? ""))?.value ?? ((r.pids ?? []) as W[]).find((p) => /doi/i.test(p.id?.scheme ?? ""))?.id?.value ?? urls.map((u) => /doi\.org\/(10\..+)$/.exec(u)?.[1]).find(Boolean);
  const peer = inst.some((i) => i.refereed === "peerReviewed");
  const soorten = inst.map((i) => String(i.type ?? "")).filter(Boolean);
  const proefschrift = soorten.some((t) => /doctoral thesis/i.test(t));
  const c = r.container ?? {};
  const oa = String(r.bestAccessRight?.label ?? "").toUpperCase() === "OPEN";
  return {
    id: `openaire:${r.id}`, titel: String(r.mainTitle ?? "").replace(/\s+/g, " ").trim(), jaar: Number(String(r.publicationDate ?? "").slice(0, 4)) || undefined, datum: r.publicationDate,
    soort: proefschrift ? "proefschrift" : soorten[0]?.toLowerCase(),
    betrouwbaarheid: proefschrift ? "proefschrift (openbaar verdedigd)" : peer ? "door vakgenoten beoordeeld (peer reviewed)" : "niet als peer reviewed geregistreerd",
    auteurs: ((r.authors ?? []) as W[]).slice(0, 8).map((a) => a.fullName).filter(Boolean),
    bron: c.name ?? r.publisher ?? undefined, ...(c.name ? { jaargang: c.vol ?? undefined, nummer: c.iss ?? undefined, paginas: [c.sp, c.ep].filter(Boolean).join("-") || undefined, issn: c.issnPrinted ?? c.issnOnline ?? undefined } : {}),
    taal: r.language?.code && r.language.code !== "und" ? r.language.code : undefined, doi: doi ? `https://doi.org/${String(doi).replace(/^https?:\/\/doi\.org\//, "")}` : undefined,
    open_access: oa, ...(oa && urls[0] ? { oa_link: urls[0] } : {}), pagina: urls[0], vindplaatsen: urls.slice(0, 5),
    onderwerpen: ((r.subjects ?? []) as W[]).map((s) => s.subject?.value).filter(Boolean).slice(0, 8),
    samenvatting: (Array.isArray(r.descriptions) ? r.descriptions.join(" ") : undefined)?.replace(/<[^>]+>/g, " ").slice(0, 1500),
  };
}

export function openaireUrl(a: { zoekterm: string; soort?: string; land?: string; alleen_open_access?: boolean; recht?: boolean; van?: number; tot?: number; sortering?: string; pagina?: number; aantal?: number }): string {
  const u = new URL(OPENAIRE_API);
  u.searchParams.set("search", a.zoekterm);
  u.searchParams.set("type", "publication");
  if (a.land && a.land !== "alle") u.searchParams.set("countryCode", a.land === "NL+BE" ? "NL,BE" : a.land);
  if (a.recht) u.searchParams.set("fos", "0505 law");
  if (a.alleen_open_access) u.searchParams.set("bestOpenAccessRightLabel", "OPEN");
  if (a.soort === "proefschrift") u.searchParams.set("instanceType", "Doctoral thesis");
  if (a.van) u.searchParams.set("fromPublicationDate", `${a.van}-01-01`);
  if (a.tot) u.searchParams.set("toPublicationDate", `${a.tot}-12-31`);
  if (a.sortering === "nieuwste") u.searchParams.set("sortBy", "publicationDate DESC");
  else if (a.sortering === "meest_geciteerd") u.searchParams.set("sortBy", "citationCount DESC");
  u.searchParams.set("page", String(a.pagina ?? 1));
  u.searchParams.set("pageSize", String(a.aantal ?? 15));
  return u.toString();
}

/** CORE-resultaat → dezelfde velden als een OpenAlex-werk. */
export function coreWerk(w: W) {
  const outputId = /\/outputs\/(\d+)/.exec(String((w.outputs ?? [])[0] ?? ""))?.[1] ?? /\/download\/(\d+)/.exec(String(w.downloadUrl ?? ""))?.[1];
  const tekst = String(w.fullText ?? "");
  return {
    id: `core:${w.id}`, titel: String(w.title ?? "").replace(/\s+/g, " ").trim(), jaar: w.yearPublished, soort: w.documentType ?? undefined,
    betrouwbaarheid: /thesis|dissert/i.test(String(w.documentType ?? "")) ? "proefschrift of scriptie (controleer welke)" : "publicatie in een repositorium (CORE)",
    auteurs: (w.authors ?? []).slice(0, 8).map((a: W) => a.name).filter(Boolean),
    bron: (w.dataProviders ?? []).map((d: W) => (typeof d === "object" ? d.name : d)).filter(Boolean)[0], doi: w.doi ? `https://doi.org/${w.doi}` : undefined,
    taal: w.language?.code, open_access: true, oa_link: w.downloadUrl ?? undefined, pagina: w.links?.find((l: W) => l.type === "display")?.url ?? w.downloadUrl ?? undefined,
    ...(outputId ? { core_output: outputId } : {}),
    samenvatting: String(w.abstract ?? "").slice(0, 1500) || undefined, volledige_tekst_beschikbaar: tekst.length > 1000,
  };
}

/** Een werk-id uit een OpenAlex-id, DOI of DOI-link. */
export function werkId(input: string): string | null {
  const s = String(input ?? "").trim();
  const oa = /\b(W\d{4,12})\b/.exec(s);
  if (oa) return oa[1];
  const doi = /\b(10\.\d{4,9}\/[^\s"<>]+)/.exec(s);
  if (doi) return `doi:${doi[1].replace(/[.,;)]+$/, "")}`;
  return null;
}

/** Op een repositoriumpagina staat de pdf meestal in <meta name="citation_pdf_url">. */
export function pdfUitPagina(html: string, base: string): string | undefined {
  const m = /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i.exec(html);
  try { return m ? new URL(decodeEntities(m[1]), base).toString() : undefined; } catch { return undefined; }
}

const bronNaam = (id: string) => (id.startsWith("openaire:") ? "openaire.eu" : id.startsWith("core:") ? "core.ac.uk" : id.startsWith("gb:") ? "books.google.com" : "openalex.org");
const rec = (title: string, url: string, date: string | undefined, snippet: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: bronNaam(String(data.id ?? "")), title, canonical_url: url, ...(date ? { date } : {}), ...(snippet ? { snippet: snippet.slice(0, 400) } : {}), data });
const NOTE = "Bron: OpenAlex (open catalogus van wetenschappelijke publicaties, CC0), met de vindplaats in tijdschrift of universiteitsrepositorium. Literatuur is geen recht: gebruik haar voor uitleg, onderbouwing en de stand van de discussie, en noem auteur, titel, vindplaats, jaar en pagina. Citeer alleen uit tekst die je hebt gelezen (literatuur_document_get).";

const defaultPdf: PdfLezer = async (url) => {
  const r = await fetchPdfText(url, { connector: "literatuur", timeoutMs: 60_000, retries: 1, maxChars: 1_500_000, headers: { "User-Agent": "Mozilla/5.0", Accept: "application/pdf,*/*" } });
  return r.ok ? { ok: true, text: r.text } : { ok: false, message: r.message };
};

export function registerLiteratuur(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }, f: Fetcher = httpFetch, leesPdf: PdfLezer = defaultPdf): void {
  const prov = (tool: string, endpoint: string, p: Record<string, unknown>, n: number, total: number) => ({ tool, endpoint, query_params: Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: n, total_results: total });
  const json = async (url: string) => {
    const r = await f(url, { headers: { Accept: "application/json" } });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`OpenAlex antwoordde met HTTP ${r.status}`);
    return JSON.parse(r.text) as W;
  };

  const core = async (pad: string) => {
    const k = sleutel("CORE_API_KEY");
    const r = await f(`${CORE_API}${pad}`, { headers: { Accept: "application/json", ...(k ? { Authorization: `Bearer ${k}` } : {}) } });
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error(`CORE: limiet bereikt${k ? "" : " (geen CORE_API_KEY; met een gratis sleutel is de limiet ruimer)"}`);
    if (r.status !== 200) throw new Error(`CORE antwoordde met HTTP ${r.status}`);
    return JSON.parse(r.text) as W;
  };
  /** De volledige tekst staat bij CORE per output (repositoriumkopie), niet altijd bij het werk zelf. */
  const coreTekst = async (w: W): Promise<{ tekst: string; bron: string } | null> => {
    if (String(w.fullText ?? "").length > 1000) return { tekst: String(w.fullText), bron: w.downloadUrl ?? `core:${w.id}` };
    for (const o of ((w.outputs ?? []) as string[]).slice(0, 4)) {
      const id = /\/outputs\/(\d+)/.exec(String(o))?.[1];
      if (!id) continue;
      const out = await core(`/outputs/${id}`).catch(() => null);
      if (String(out?.fullText ?? "").length > 1000) return { tekst: String(out!.fullText), bron: out?.downloadUrl ?? `https://core.ac.uk/outputs/${id}` };
    }
    return null;
  };
  const coreZoeken = async (a: { zoekterm: string; soort?: string; taal?: string; van?: number; tot?: number; pagina?: number; aantal?: number }) => {
    const q = [a.zoekterm, a.soort === "proefschrift" ? "documentType:thesis" : "", a.taal && a.taal !== "alle" ? `language.code:${a.taal}` : "", a.van ? `yearPublished>=${a.van}` : "", a.tot ? `yearPublished<=${a.tot}` : ""].filter(Boolean).join(" AND ");
    const pad = `/search/works/?q=${encodeURIComponent(q)}&limit=${a.aantal ?? 15}&offset=${((a.pagina ?? 1) - 1) * (a.aantal ?? 15)}`;
    try {
      const r = await core(pad);
      const items = ((r?.results ?? []) as W[]).map(coreWerk);
      const records = items.map((w) => rec(w.titel, w.pagina ?? w.oa_link ?? CORE_API, w.jaar ? String(w.jaar) : undefined, w.samenvatting, w));
      return toMcpToolPayload(successResponse({ summary: `CORE: ${r?.totalHits ?? records.length} publicaties voor '${a.zoekterm}'; ${records.length} getoond`, records, provenance: prov("literatuur_zoeken", `${CORE_API}${pad}`, a, records.length, Number(r?.totalHits ?? records.length)),
        access_note: `${NOTE} CORE bundelt de volledige teksten van repositoria wereldwijd${sleutel("CORE_API_KEY") ? "" : "; zonder CORE_API_KEY geen tekst en een krappe limiet"}. Lees met literatuur_document_get (id core:…).` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CORE", CORE_API)); }
  };

  /** Boeken (handboeken, monografieën, praktijkboeken) via Google Books; de enige bron hier met gesloten juridische boeken. */
  const googleBooksZoeken = async (a: { zoekterm: string; taal?: string; pagina?: number; aantal?: number; sortering?: string }) => {
    const k = sleutel("GOOGLE_BOOKS_API_KEY");
    const n = Math.min(40, a.aantal ?? 15);
    const u = new URL(GOOGLE_BOOKS);
    u.searchParams.set("q", a.zoekterm); u.searchParams.set("printType", "books"); u.searchParams.set("maxResults", String(n));
    u.searchParams.set("startIndex", String(((a.pagina ?? 1) - 1) * n));
    if (a.taal && a.taal !== "alle") u.searchParams.set("langRestrict", a.taal);
    if (a.sortering === "nieuwste") u.searchParams.set("orderBy", "newest");
    if (k) u.searchParams.set("key", k);
    try {
      const r = await f(u.toString(), { headers: { Accept: "application/json" } });
      if (r.status === 429) throw new Error(`Google Books: limiet bereikt${k ? "" : " (geen GOOGLE_BOOKS_API_KEY)"}`);
      if (r.status !== 200) throw new Error(`Google Books antwoordde met HTTP ${r.status}`);
      const d = JSON.parse(r.text) as W;
      const items = ((d.items ?? []) as W[]).map(googleBooksWerk);
      const records = items.map((w) => rec(w.titel, w.pagina ?? GOOGLE_BOOKS, w.datum, w.beschrijving, w));
      return toMcpToolPayload(successResponse({ summary: `Google Books: ${d.totalItems ?? records.length} boeken voor '${a.zoekterm}'; ${records.length} getoond`, records, provenance: prov("literatuur_zoeken", zonderSleutel(u.toString()), a, records.length, Number(d.totalItems ?? records.length)),
        access_note: `${NOTE} Google Books: boeken met titel, auteurs, uitgever, jaar, ISBN en of er een inkijk is; de tekst zelf is er (meestal) niet. Elke druk is een apart resultaat: kies de druk die je gebruikt. Vakgebied- en landfilters gelden hier niet. Een verwijzing naar een boek controleer je met verify_legal_reference ('literatuur: …') in de verwijzingscontroleur.` }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "Google Books", GOOGLE_BOOKS)); }
  };

  // OpenAIRE: zonder token 60 verzoeken per uur, met token 7200. Een token geldt een uur; we bewaren het 55 minuten.
  let openaireToken: { token: string; tot: number } | undefined;
  const haalOpenaireToken = async (): Promise<string | undefined> => {
    if (openaireToken && openaireToken.tot > Date.now()) return openaireToken.token;
    const id = sleutel("OPENAIRE_CLIENT_ID"), geheim = sleutel("OPENAIRE_CLIENT_SECRET"), refresh = sleutel("OPENAIRE_REFRESH_TOKEN");
    try {
      let r;
      if (id && geheim) r = await f(OPENAIRE_TOKEN_URL, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${id}:${geheim}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "grant_type=client_credentials" });
      else if (refresh) r = await f(`${OPENAIRE_REFRESH_URL}?refreshToken=${encodeURIComponent(refresh)}`, { headers: { Accept: "application/json" } });
      else return undefined;
      const token = r.status === 200 ? (JSON.parse(r.text) as W)?.access_token : undefined;
      if (!token) return undefined;
      openaireToken = { token, tot: Date.now() + 55 * 60_000 };
      return token;
    } catch { return undefined; }
  };
  const openaire = async (url: string) => {
    const token = await haalOpenaireToken();
    const r = await f(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error(`OpenAIRE: limiet bereikt (${token ? "7200" : "60"} verzoeken per uur${token ? "" : "; met OPENAIRE_CLIENT_ID/OPENAIRE_CLIENT_SECRET of OPENAIRE_REFRESH_TOKEN 7200"}). Zoek zolang via OpenAlex.`);
    if (r.status !== 200) throw new Error(`OpenAIRE antwoordde met HTTP ${r.status}`);
    return JSON.parse(r.text) as W;
  };

  type Gevonden = { items: Array<ReturnType<typeof werk> | ReturnType<typeof openaireWerk>>; totaal: number; url: string };
  const zoekOpenalex = async (a: Parameters<typeof zoekUrl>[0], recht: boolean): Promise<Gevonden> => {
    const url = zoekUrl({ ...a, recht });
    const r = await json(url);
    return { items: ((r?.results ?? []) as W[]).map(werk), totaal: Number(r?.meta?.count ?? 0), url: zonderSleutel(url) };
  };
  const zoekOpenaire = async (a: Parameters<typeof openaireUrl>[0], recht: boolean): Promise<Gevonden> => {
    const url = openaireUrl({ ...a, recht });
    const r = await openaire(url);
    return { items: ((r?.results ?? []) as W[]).map(openaireWerk), totaal: Number(r?.header?.numFound ?? 0), url };
  };
  const sleutelVan = (w: { doi?: string; titel: string }) => (w.doi ?? w.titel).toLowerCase().replace(/\W+/g, "");

  server.registerTool("literatuur_zoeken", {
    description: "Search legal literature in open scholarly sources (OpenAlex, OpenAIRE, CORE): dissertations (proefschriften), journal articles, books and reports, with author, institution, journal or university repository, DOI, number of citations, abstract and the open access link. Filters: soort (proefschrift, artikel, boek, rapport, alle), taal ('nl', 'en'), land of the authors' institution ('NL', 'BE', 'NL+BE'), alleen_open_access (default true), vakgebied (default recht_eerst: first works classified under Law, and only when that gives fewer than 5 results the broader search added, marked 'buiten Recht geclassificeerd'; alleen_recht; alle), years and sort order. bron openaire searches the European OpenAIRE Graph (all Dutch university repositories via NARCIS, with peer review status and the full journal citation). bron google_books finds books, also closed legal handbooks and monographs (publisher, year, ISBN, each edition separately; no text). Each result says how reliable the type is (defended dissertation, peer-reviewed open access journal, repository, preprint). Read the text with literatuur_document_get.",
    inputSchema: {
      zoekterm: z.string().min(2).max(300),
      zoeken_in: z.enum(["titel_samenvatting", "alles"]).default("titel_samenvatting").describe("titel_samenvatting: precise (title and abstract); alles: also the full text, broader but noisier. Use alles when the precise search finds too little."),
      bron: z.enum(["openalex", "openaire", "oa_boeken", "core", "google_books"]).default("openalex").describe("openalex: the broad catalogue; openaire: the European OpenAIRE Graph, strong for Dutch repositories, dissertations and peer review status (60 requests/hour without token); oa_boeken: only open access books from OAPEN and DOAB; core: CORE, repository full texts (needs CORE_API_KEY for the text); google_books: books incl. closed legal handbooks and monographs (title, authors, publisher, year, ISBN, edition, preview), no full text."),
      soort: z.enum(["proefschrift", "artikel", "boek", "rapport", "alle"]).default("alle"),
      taal: z.enum(["nl", "en", "alle"]).default("alle"), land: z.enum(["NL", "BE", "NL+BE", "alle"]).default("alle"),
      alleen_open_access: z.boolean().default(true),
      vakgebied: z.enum(["recht_eerst", "alleen_recht", "alle"]).default("recht_eerst").describe("recht_eerst: works classified under Law first, broadened only when that finds fewer than 5; alleen_recht; alle. The classification is automatic and misses some legal works (CORE has none)."),
      van: z.number().int().min(1800).max(2100).optional(), tot: z.number().int().min(1800).max(2100).optional(),
      sortering: z.enum(["relevantie", "nieuwste", "meest_geciteerd"]).default("relevantie"),
      pagina: z.number().int().min(1).max(50).default(1), aantal: z.number().int().min(1).max(50).default(15),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    if (a.bron === "core") return coreZoeken(a);
    if (a.bron === "google_books") return googleBooksZoeken(a);
    const naam = a.bron === "openaire" ? "OpenAIRE" : "OpenAlex";
    const zoek = (recht: boolean) => (a.bron === "openaire" ? zoekOpenaire(a, recht) : zoekOpenalex(a, recht));
    try {
      const eerst = await zoek(a.vakgebied !== "alle");
      let items: Array<Record<string, unknown> & { titel: string; doi?: string }> = eerst.items;
      let verbreed = false;
      if (a.vakgebied === "recht_eerst" && a.pagina === 1 && items.length < 5) {
        const breed = await zoek(false);
        const al = new Set(items.map(sleutelVan));
        const extra = breed.items.filter((w) => !al.has(sleutelVan(w))).slice(0, a.aantal - items.length).map((w) => ({ ...w, vakgebied: "buiten Recht geclassificeerd" }));
        verbreed = extra.length > 0;
        items = [...items.map((w) => ({ ...w, vakgebied: "Recht" })), ...extra];
      }
      const records = items.map((w) => rec(w.titel, String(w.pagina ?? w.oa_link ?? (a.bron === "openaire" ? OPENAIRE_API : `https://openalex.org/${w.id}`)), (w.datum as string | undefined), (w.samenvatting as string | undefined), w));
      const totaal = eerst.totaal || records.length;
      const vakNote = a.vakgebied === "alle" ? "Gezocht in alle vakgebieden." : `Eerst gezocht binnen Recht (${naam === "OpenAIRE" ? "fos 0505 law" : "OpenAlex-subveld Law"})${verbreed ? `; dat gaf ${eerst.items.length} resultaten, daarom aangevuld met werken buiten Recht (gemarkeerd; beoordeel ze zelf)` : ""}. De indeling is automatisch en mist soms juridische werken: zoek bij twijfel met vakgebied 'alle'.`;
      return toMcpToolPayload(successResponse({
        summary: verbreed ? `${naam}: ${eerst.items.length} publicaties binnen Recht voor '${a.zoekterm}', aangevuld met ${records.length - eerst.items.length} buiten Recht (gemarkeerd)` : `${naam}: ${totaal} publicaties voor '${a.zoekterm}'${a.vakgebied === "alle" ? "" : " binnen Recht"}; ${records.length} getoond (pagina ${a.pagina})`, records, provenance: prov("literatuur_zoeken", eerst.url, a, records.length, totaal),
        access_note: `${NOTE} ${vakNote} ${a.bron === "openaire" ? "OpenAIRE zoekt in titel, samenvatting en trefwoorden; 'betrouwbaarheid' volgt de peer-reviewregistratie van de vindplaats." : a.zoeken_in === "alles" ? "Breed gezocht (ook in de volledige tekst): beoordeel de relevantie per titel." : "Gezocht in titel en samenvatting; vind je te weinig, zoek dan met zoeken_in 'alles'."} Zoek ook met Engelse termen en synoniemen; een Nederlandse titel kan onder een Engelse samenvatting staan. Gesloten literatuur (handboeken, Asser-serie, annotaties, tijdschriften als NJB en WPNR) staat hier niet of zonder tekst in.`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, naam, a.bron === "openaire" ? OPENAIRE_API : OPENALEX)); }
  });

  const coreDocument = async (id: string, a: { zoekterm?: string; max_chars: number }) => {
    try {
      const w = await core(`/works/${id}`);
      if (!w) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `CORE kent werk ${id} niet.`, suggestion: "Zoek opnieuw met literatuur_zoeken (bron core)." }));
      const meta = coreWerk(w);
      const gevonden = await coreTekst(w);
      const tekst = gevonden?.tekst ?? "";
      if (!gevonden) return toMcpToolPayload(successResponse({ summary: `${meta.titel}: geen volledige tekst${sleutel("CORE_API_KEY") ? "" : " (zet CORE_API_KEY)"}`, records: [rec(meta.titel, meta.pagina ?? CORE_API, meta.jaar ? String(meta.jaar) : undefined, meta.samenvatting, { ...meta, open_in_browser: meta.oa_link })], provenance: prov("literatuur_document_get", `${CORE_API}/works/${id}`, { werk: `core:${id}` }, 1, 1), access_note: NOTE }));
      const body = a.zoekterm ? passages(tekst, a.zoekterm).join("\n…\n") : tekst;
      return toMcpToolPayload(successResponse({ summary: `${meta.titel}: ${tekst.length} tekens uit CORE (${gevonden.bron})`, records: [rec(meta.titel, meta.pagina ?? CORE_API, meta.jaar ? String(meta.jaar) : undefined, meta.samenvatting, { ...meta, tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body, ingekort: body.length > a.max_chars })], provenance: prov("literatuur_document_get", `${CORE_API}/works/${id}`, { werk: `core:${id}`, zoekterm: a.zoekterm }, 1, 1), access_note: NOTE }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "CORE", CORE_API)); }
  };

  /** Probeert de open vindplaatsen op volgorde: PDF, of de repositoriumpagina en de PDF waarnaar die verwijst. */
  const haalTekst = async (plekken: string[]) => {
    const pogingen: Array<{ url: string; resultaat: string }> = [];
    let tekst: string | undefined, bron: string | undefined;
    for (const u of plekken.slice(0, 6)) {
      try {
        const r = await f(u, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (r.status !== 200) { pogingen.push({ url: u, resultaat: `HTTP ${r.status}${/just a moment|cloudflare/i.test(r.text) ? " (browsercontrole)" : ""}` }); continue; }
        const pdfLink = /%PDF-/.test(r.text.slice(0, 1024)) ? u : pdfUitPagina(r.text, r.url);
        if (pdfLink) {
          const p = await leesPdf(pdfLink);
          if (p.ok && p.text.trim().length > 500) { tekst = p.text; bron = pdfLink; break; }
          pogingen.push({ url: pdfLink, resultaat: p.ok ? "pdf zonder tekst (scan?)" : p.message });
          continue;
        }
        const t = decodeEntities(htmlNaarTekst(r.text));
        if (t.length > 5000 && !/just a moment|cloudflare/i.test(r.text)) { tekst = t; bron = r.url; break; }
        pogingen.push({ url: u, resultaat: "pagina zonder volledige tekst" });
      } catch (e) { pogingen.push({ url: u, resultaat: e instanceof Error ? e.message : String(e) }); }
    }
    return { tekst, bron, pogingen };
  };

  server.registerTool("literatuur_document_get", {
    description: "The text of one open access publication found with literatuur_zoeken: by OpenAlex id (W…), OpenAIRE id (openaire:…), CORE id (core:…), DOI or DOI link. Tries every open access location (PDF, or the repository page and the PDF it points to) and returns the text, or only the passages with a search term. Many university portals (Pure) sit behind a browser check; then the tool says so and gives the link to open in a browser.",
    inputSchema: { werk: z.string().min(4).max(400), zoekterm: z.string().max(200).optional(), max_chars: z.number().int().min(1000).max(120_000).default(30_000) },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const coreId = /^core:(\d+)$/i.exec(a.werk.trim())?.[1];
    if (coreId) return coreDocument(coreId, a);
    const oaireId = /^openaire:(.+)$/i.exec(a.werk.trim())?.[1];
    if (oaireId) {
      try {
        const r = await openaire(`${OPENAIRE_API}/${encodeURIComponent(oaireId)}`);
        if (!r) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `OpenAIRE kent ${oaireId} niet.`, suggestion: "Zoek opnieuw met literatuur_zoeken (bron openaire)." }));
        const meta = openaireWerk(r);
        // Met een DOI weet OpenAlex meestal meer open vindplaatsen (en valt CORE terug): ga via de DOI.
        if (meta.doi) a = { ...a, werk: meta.doi };
        else {
          const { tekst, bron, pogingen } = await haalTekst(meta.vindplaatsen);
          const body = tekst ? (a.zoekterm ? passages(tekst, a.zoekterm).join("\n…\n") : tekst) : undefined;
          return toMcpToolPayload(successResponse({
            summary: tekst ? `${meta.titel}: ${tekst.length} tekens uit ${bron}` : `${meta.titel}: geen open tekst automatisch op te halen`,
            records: [rec(meta.titel, meta.pagina ?? OPENAIRE_API, meta.datum, meta.samenvatting, { ...meta, ...(bron ? { tekst_bron: bron } : {}), ...(body !== undefined ? { tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body, ingekort: body.length > a.max_chars } : { pogingen, open_in_browser: meta.oa_link ?? meta.pagina }) })],
            provenance: prov("literatuur_document_get", `${OPENAIRE_API}/${oaireId}`, { werk: a.werk, zoekterm: a.zoekterm }, 1, 1),
            access_note: tekst ? NOTE : `${NOTE} De tekst kon niet automatisch worden opgehaald (zie pogingen). Open de link in een browser en citeer pas na lezing.`,
          }));
        }
      } catch (e) { return toMcpToolPayload(mapSourceError(e, "OpenAIRE", OPENAIRE_API)); }
    }
    const id = werkId(a.werk);
    if (!id) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen OpenAlex-id of DOI in '${a.werk.slice(0, 80)}'.`, suggestion: "Gebruik het id of de DOI uit literatuur_zoeken." }));
    const url = `${OPENALEX}/works/${id}?select=${VELDEN}${sleutel("OPENALEX_API_KEY") ? `&api_key=${sleutel("OPENALEX_API_KEY")}` : ""}`;
    try {
      const w = await json(url);
      if (!w) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `OpenAlex kent ${id} niet.`, suggestion: "Controleer de DOI of zoek met literatuur_zoeken." }));
      const meta = werk(w);
      const plekken: string[] = [];
      for (const l of [w.best_oa_location, ...(w.locations ?? [])] as W[]) {
        if (!l?.is_oa) continue;
        for (const u of [l.pdf_url, l.landing_page_url]) if (u && !plekken.includes(u)) plekken.push(u);
      }
      const { pogingen, ...gevonden } = await haalTekst(plekken);
      let { tekst, bron } = gevonden;
      // Geen tekst bij de bron zelf: CORE heeft vaak een eigen kopie (op DOI), mits er een sleutel is.
      if (!tekst && meta.doi && sleutel("CORE_API_KEY")) {
        try {
          const c = await core(`/search/works/?q=${encodeURIComponent(`doi:"${String(meta.doi).replace(/^https?:\/\/doi\.org\//, "")}"`)}&limit=1`);
          const t = c?.results?.[0] ? await coreTekst(c.results[0]) : null;
          if (t) { tekst = t.tekst; bron = `CORE (${t.bron})`; }
          else pogingen.push({ url: "CORE", resultaat: "geen volledige tekst in CORE" });
        } catch (e) { pogingen.push({ url: "CORE", resultaat: e instanceof Error ? e.message : String(e) }); }
      }
      const body = tekst ? (a.zoekterm ? passages(tekst, a.zoekterm).join("\n…\n") : tekst) : undefined;
      return toMcpToolPayload(successResponse({
        summary: tekst ? `${meta.titel}: ${tekst.length} tekens uit ${bron}${a.zoekterm ? `; passages met '${a.zoekterm}'` : ""}` : `${meta.titel}: geen open tekst automatisch op te halen`,
        records: [rec(meta.titel, meta.pagina ?? `https://openalex.org/${meta.id}`, meta.datum, meta.samenvatting, {
          ...meta, ...(bron ? { tekst_bron: bron } : {}),
          ...(body !== undefined ? { tekst: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}…` : body, ingekort: body.length > a.max_chars } : { pogingen, open_in_browser: meta.oa_link ?? meta.pagina }),
        })],
        provenance: prov("literatuur_document_get", zonderSleutel(url), { werk: a.werk, zoekterm: a.zoekterm }, 1, 1),
        access_note: tekst ? NOTE : `${NOTE} De tekst kon niet automatisch worden opgehaald (zie pogingen; universiteitsportalen vragen vaak een browsercontrole). Open de link in een browser en citeer pas na lezing.`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, "OpenAlex", zonderSleutel(url))); }
  });
}

/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Three sources for legal research that the
 * upstream tools do not cover (found by scanning data.overheid.nl):
 *
 * - PUC (puc.overheid.nl, KOOP): uitvoeringsinformatie that bodies publish themselves:
 *   SVB Beleidsregels, IND werkinstructies and informatieberichten, RSJ uitspraken,
 *   NZa beleidsregels, ministeriële en Defensie publicaties. Search pages and documents
 *   (HTML; PUC answers only from European addresses).
 * - Woo-jurisprudentiedatabase of the ACOI (woo-wijzer.acoi.nl): annotated rulings on the
 *   Woo/Wob since May 2022, via the site's own JSON-RPC (SearchJurisprudentie).
 * - ANBI register (Belastingdienst open data, anbi.zip): every public-benefit institution with
 *   RSIN, place, start and end date of the status; cached for 12 hours.
 */
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MCPRecord } from "../types.js";
import { getBinary, getText, postJson } from "../utils/http.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";

// ---------- shared HTML helpers ----------

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const BLOCK = /<\/?(p|div|h[1-6]|li|ul|ol|tr|table|section|article|blockquote|br|dd|dt|dl|header|footer)\b[^>]*>/gi;
/** HTML to text with one line per block element. */
export function htmlNaarTekst(html: string): string {
  return decodeEntities(
    html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(BLOCK, "\n").replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}
const inline = (html: string) => htmlNaarTekst(html).replace(/\s*\n\s*/g, " ").trim();

function passages(text: string, term: string, max = 30): string[] {
  const lines = text.split("\n");
  const t = term.toLowerCase();
  const out: string[] = [];
  let last = -2;
  lines.forEach((l, i) => {
    if (out.length >= max || !l.toLowerCase().includes(t)) return;
    const from = Math.max(i - 1, last + 2), to = Math.min(i + 1, lines.length - 1);
    if (from <= to) out.push(lines.slice(from, to + 1).join("\n"));
    last = to - 1;
  });
  return out;
}

// ---------- PUC ----------

export const PUC_BASE = "https://puc.overheid.nl";
export const PUC_PORTALEN: Record<string, string> = {
  svb: "Sociale Verzekeringsbank (beleidsregels, Woo-publicaties, jurisprudentie)",
  ind: "IND (werkinstructies, informatieberichten, landenrapporten)",
  rsj: "Raad voor strafrechtstoepassing en jeugdbescherming (uitspraken beklag/beroep)",
  nza: "Nederlandse Zorgautoriteit (beleidsregels, regelingen)",
  "mp-bundels": "Ministeriële en Defensie publicaties",
  mrt: "Militair Rechtelijk Tijdschrift",
  anvs: "Autoriteit Nucleaire Veiligheid en Stralingsbescherming",
};

/** PUC writes spaces in a search term as "-wt_" in its search URLs. */
export function pucZoekUrl(a: { portaal?: string; zoekterm: string; pagina?: number; geldigVandaag?: boolean; sorteer?: "relevantie" | "datum" }): string {
  const term = a.zoekterm.replace(/[^\p{L}\p{N}:.\- ]+/gu, " ").trim().split(/\s+/).map(encodeURIComponent).join("-wt_");
  const parts = [a.portaal ? `/${a.portaal}` : "", "/zoeken/resultaat/q/", term, `/p/${a.pagina ?? 1}`];
  if (a.geldigVandaag) parts.push("/gdlv/1");
  if (a.sorteer === "datum") parts.push("/s/datumdocument-wt_desc");
  return `${PUC_BASE}${parts.join("")}/`;
}

export interface PucTreffer { id: string; versie?: string; titel: string; url: string; soort?: string; organisatie?: string; kenmerk?: string; beschikbaar?: string; geldig_vanaf?: string; datum?: string; fragment?: string }

/** One result page. Each hit is one link to /doc/PUC_…, its text holds title, snippet and metadata. */
export function parsePucZoek(html: string): { totaal: number | null; treffers: PucTreffer[] } {
  const totaal = /(\d+)\s*t\/m\s*(\d+)\s*van\s*([\d.]+)/i.exec(inline(html.slice(0, 400_000)));
  const seen = new Set<string>();
  const treffers: PucTreffer[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]*\/doc\/(PUC_\d+_\d+)(?:\/(\d+))?[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href, id, versie, inner] = m;
    const chunks = htmlNaarTekst(inner.replace(/<\/(span|strong|em|b|i)>/gi, "</$1>\n")).split("\n").map((s) => s.trim()).filter(Boolean);
    const all = chunks.join(" ").replace(/\s+/g, " ");
    if (all.length < 15 || /^samenvatting$/i.test(all) || seen.has(id)) continue;
    seen.add(id);
    const title = (chunks[0] && !chunks[0].startsWith("...") ? chunks[0] : all.split(" ... ")[0]).slice(0, 300);
    const get = (re: RegExp) => re.exec(all)?.[1]?.trim();
    // Metadata follow the last "..." of the snippet: "<documentsoort> - <organisatie> Kenmerk: … Beschikbaar: …".
    const metaStart = all.search(/\s(?:Kenmerk|Publicatiedatum|Uitspraakdatum|Vaststellingsdatum|Beschikbaar):/);
    const pre = metaStart > 0 ? all.slice(0, metaStart) : "";
    const dots = pre.lastIndexOf("...");
    const seg = (dots >= 0 ? pre.slice(dots + 3) : pre.startsWith(title) ? pre.slice(title.length) : "").trim();
    const [soort, ...org] = seg ? seg.split(" - ") : [];
    const soortOrg = soort ? [seg, soort.trim(), org.join(" - ").trim()] : null;
    const frag = all.includes(" ... ") ? all.slice(all.indexOf(" ... ") + 5, dots > 0 ? dots : undefined).replace(/\s*\.\.\.\s*$/, "").trim() : undefined;
    treffers.push({
      id, ...(versie ? { versie } : {}), titel: title, url: new URL(decodeEntities(href), PUC_BASE).toString(),
      ...(soortOrg ? { soort: soortOrg[1], ...(soortOrg[2] ? { organisatie: soortOrg[2] } : {}) } : {}),
      ...(get(/Kenmerk:\s*(.+?)\s+(?:Publicatiedatum|Uitspraakdatum|Vaststellingsdatum|Beschikbaar):/) ? { kenmerk: get(/Kenmerk:\s*(.+?)\s+(?:Publicatiedatum|Uitspraakdatum|Vaststellingsdatum|Beschikbaar):/) } : {}),
      ...(get(/(?:Uitspraakdatum|Publicatiedatum|Vaststellingsdatum):\s*(\d{2}-\d{2}-\d{4})/) ? { datum: get(/(?:Uitspraakdatum|Publicatiedatum|Vaststellingsdatum):\s*(\d{2}-\d{2}-\d{4})/) } : {}),
      ...(get(/Beschikbaar:\s*(\d{2}-\d{2}-\d{4})/) ? { beschikbaar: get(/Beschikbaar:\s*(\d{2}-\d{2}-\d{4})/) } : {}),
      ...(get(/Geldig vandaag:\s*van\s*(\d{2}-\d{2}-\d{4})/) ? { geldig_vanaf: get(/Geldig vandaag:\s*van\s*(\d{2}-\d{2}-\d{4})/) } : {}),
      ...(frag ? { fragment: frag.slice(0, 400) } : {}),
    });
  }
  return { totaal: totaal ? Number(totaal[3].replace(/\./g, "")) : treffers.length ? null : 0, treffers };
}

export interface PucDocument {
  id: string; titel: string; tekst: string; versie?: string; geldigheid?: string; documentsoort?: string; organisatie?: string; kenmerk?: string;
  relaties: Array<{ titel: string; url: string; soort: "wet" | "rechtspraak" | "bekendmaking" | "puc" }>;
}

/** A PUC document page: the text between the title and the metadata block, plus metadata and relations. */
export function parsePucDocument(html: string, id: string): PucDocument {
  const titel = inline(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? id);
  const h1 = html.search(/<h1\b/i);
  const body = h1 >= 0 ? html.slice(h1) : html;
  const full = htmlNaarTekst(body);
  const lines = full.split("\n");
  const start = Math.max(0, lines.findIndex((l, i) => i > 0 && /^(Inleiding|Maak een PDF)$/i.test(l)));
  let end = lines.findIndex((l) => /^(Bijlagen|Informatietype en toegang)$/i.test(l));
  if (end < 0) end = lines.length;
  const noise = /^(Permanente link|Maak een PDF|in\/uitklappen|Naar boven|Externe relaties|Onderstaande relaties zijn gevonden.*|Themastructuur.*|Dit onderwerp bevat de volgende rubrieken\.?)$/i;
  const tekst = lines.slice(start, end).filter((l) => !noise.test(l)).join("\n");
  const meta = full.replace(/\n/g, " ");
  const get = (re: RegExp) => re.exec(meta)?.[1]?.trim();
  const relaties: PucDocument["relaties"] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = decodeEntities(m[1]);
    const soort = /wetten\.overheid\.nl\/jci/i.test(url) ? "wet" : /ECLI:/i.test(url) ? "rechtspraak" : /officielebekendmakingen\.nl\/(stcrt|stb|gmb|prb|wsb|kst|trb)-/i.test(url) ? "bekendmaking" : /\/doc\/PUC_\d+/i.test(url) && !url.includes(id) ? "puc" : null;
    if (!soort) continue;
    const key = url.replace(/[?&](z|g)=[^&]*/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    relaties.push({ titel: inline(m[2]).slice(0, 200) || url, url: new URL(url, PUC_BASE).toString(), soort });
  }
  return {
    id, titel, tekst, relaties,
    ...(get(/Identificatie\s+PUC_\d+_\d+\s+Versie\s+(\d+)/) ? { versie: get(/Identificatie\s+PUC_\d+_\d+\s+Versie\s+(\d+)/) } : {}),
    ...(get(/Geldigheid\s+(van\s+\d{2}-\d{2}-\d{4}\s+tot\s+en\s+met(?:\s+\d{2}-\d{2}-\d{4})?)/) ? { geldigheid: get(/Geldigheid\s+(van\s+\d{2}-\d{2}-\d{4}\s+tot\s+en\s+met(?:\s+\d{2}-\d{2}-\d{4})?)/) } : {}),
    ...(get(/Documentsoort\s+(.+?)\s+(?:Toegangsrechten|Identificatie)/) ? { documentsoort: get(/Documentsoort\s+(.+?)\s+(?:Toegangsrechten|Identificatie)/) } : {}),
    ...(get(/Organisatie\s*(.+?)\s+Taal\b/) ? { organisatie: get(/Organisatie\s*(.+?)\s+Taal\b/) } : {}),
    ...(get(/Beleidsregelnummer\s+(\S+)/) ? { kenmerk: get(/Beleidsregelnummer\s+(\S+)/) } : {}),
  };
}

const PUC_NOTE =
  "Bron: PUC Open Data (puc.overheid.nl, KOOP): uitvoeringsinformatie die organisaties zelf publiceren. Beleidsregels binden het bestuursorgaan (art. 4:84 Awb); werkinstructies en informatieberichten (IND) zijn géén beleidsregels maar laten de uitvoeringspraktijk zien. " +
  "Let op de geldigheid (versie en 'geldig vanaf'): oudere versies staan er ook in. PUC antwoordt alleen vanuit Europa; een 403 betekent dat de server PUC niet mag bereiken.";

async function pucGet(url: string): Promise<string> {
  return (await getText(url, { connector: "puc", timeoutMs: 30_000, retries: 1, headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; NL-GOV-MCP)" } })).data;
}

// ---------- ACOI Woo-jurisprudentie ----------

export const ACOI_RPC = "https://woo-wijzer.acoi.nl/wh_services/acoi/jurisprudentie/";
const ACOI_FOLDER = "https://woo-wijzer.acoi.nl/jurisprudentie-database/";
export const ACOI_INSTANTIES: Record<string, string> = { "6599": "Afdeling bestuursrechtspraak van de Raad van State", "6602": "Hoge Raad", "6601": "Gerechtshoven", "6603": "Rechtbanken", "6600": "College van Beroep voor het bedrijfsleven" };
export const ACOI_GRONDEN: Record<string, string> = {
  "511a-eenheid-kroon": "5.1 lid 1 a (eenheid Kroon)", "511b-veiligheid-staat": "5.1 lid 1 b (veiligheid Staat)", "511c-bedrijfs-en-fabricagegegevens": "5.1 lid 1 c (bedrijfs- en fabricagegegevens)",
  "511d-bijzondere-persoonsgegevens": "5.1 lid 1 d (bijzondere persoonsgegevens)", "511e-identificatienummers": "5.1 lid 1 e (identificatienummers)", "512a-internationale-betrekkingen": "5.1 lid 2 a (internationale betrekkingen)",
  "512b-economischefinanciele-belangen": "5.1 lid 2 b (economische/financiële belangen)", "512c-opsporing-en-vervolging-strafbare-feiten": "5.1 lid 2 c (opsporing en vervolging)", "512d-inspectie-controle-en-toezicht": "5.1 lid 2 d (inspectie, controle en toezicht)",
  "512e-persoonlijke-levenssfeer": "5.1 lid 2 e (persoonlijke levenssfeer)", "512f-concurrentiegevoelige-bedrijfs-en-fabricagegegevens": "5.1 lid 2 f (concurrentiegevoelige gegevens)", "512g-bescherming-van-milieu": "5.1 lid 2 g (milieu)",
  "512h-beveiliging-personenbedrijven-sabotage": "5.1 lid 2 h (beveiliging; sabotage)", "512i-goed-functioneren": "5.1 lid 2 i (goed functioneren)", "515-onevenredige-benadeling": "5.1 lid 5 (onevenredige benadeling)",
  "521-pers-beleidsopvattingen-intern-beraad": "5.2 lid 1 (persoonlijke beleidsopvattingen, intern beraad)", "522-pers-beleidsopvattingen-geanonimiseerd": "5.2 lid 2 (geanonimiseerd)", "523-formele-bestuurlijke-besluitvorming": "5.2 lid 3 (formele bestuurlijke besluitvorming)", "53-verzwaarde-motivering": "5.3 (verzwaarde motivering)",
};

/** "5.1 lid 2 e", "512e", "persoonlijke levenssfeer" → the site's code. */
export function acoiGrond(input: string | undefined): string | undefined | null {
  if (!input?.trim()) return undefined;
  const s = input.toLowerCase().replace(/artikel|art\.?|woo|lid|sub|,/g, " ").replace(/\s+/g, " ").trim();
  if (ACOI_GRONDEN[s]) return s;
  const compact = s.replace(/[^0-9a-z]/g, "");
  for (const code of Object.keys(ACOI_GRONDEN)) {
    const [num, ...words] = code.split("-");
    if (compact === num || compact.startsWith(num) && compact.length === num.length) return code;
    if (words.length && s.includes(words.join(" ").slice(0, 12))) return code;
  }
  for (const [code, label] of Object.entries(ACOI_GRONDEN)) if (label.toLowerCase().includes(s)) return code;
  return null;
}
export function acoiInstantie(input: string | undefined): string | undefined | null {
  if (!input?.trim()) return undefined;
  const s = input.toLowerCase();
  if (ACOI_INSTANTIES[s]) return s;
  if (/raad van state|abrvs|afdeling/.test(s)) return "6599";
  if (/hoge raad|\bhr\b/.test(s)) return "6602";
  if (/hof|hoven/.test(s)) return "6601";
  if (/rechtbank/.test(s)) return "6603";
  if (/cbb|bedrijfsleven/.test(s)) return "6600";
  return null;
}

export interface AcoiUitspraak { ecli: string; datum?: string; samenvatting: string; annotatie_url?: string; uitspraak_url?: string }
export function parseAcoiHtml(html: string): AcoiUitspraak[] {
  return [...html.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map(([a]) => {
    const ecli = inline(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(a)?.[1] ?? "");
    const datum = inline(/mediamonitor-item__when[^>]*>([\s\S]*?)<\/div>/i.exec(a)?.[1] ?? "").replace(/^Datum uitspraak:\s*/i, "");
    const samenvatting = htmlNaarTekst(/mediamonitor-item__description[^>]*>([\s\S]*?)<\/div>/i.exec(a)?.[1] ?? "");
    const links = [...a.matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
    return { ecli, ...(datum ? { datum } : {}), samenvatting, ...(links.find((l) => /acoi\.nl/.test(l)) ? { annotatie_url: links.find((l) => /acoi\.nl/.test(l)) } : {}), ...(links.find((l) => /rechtspraak\.nl/.test(l)) ? { uitspraak_url: links.find((l) => /rechtspraak\.nl/.test(l)) } : {}) };
  }).filter((x) => x.ecli);
}

// ---------- ANBI ----------

export const ANBI_ZIP = "https://download.belastingdienst.nl/data/anbi/anbi.zip";
export interface AnbiInstelling { naam: string; alias?: string; rsin?: string; plaats?: string; website?: string; ingang?: string; eind?: string; intrekking?: string; cultuur_ingang?: string; cultuur_eind?: string; dossier?: string }

/** The one XML file from a zip archive (central directory, deflate or stored). */
export function unzipEersteXml(buf: Uint8Array): Uint8Array {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 70_000); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Geen geldig zip-bestand");
  let p = b.readUInt32LE(eocd + 16);
  const n = b.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    if (/\.xml$/i.test(name)) {
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + csize);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("Geen XML-bestand in het zip-bestand");
}

export function parseAnbiXml(xml: string): { aangemaakt?: string; instellingen: AnbiInstelling[] } {
  const tag = (blok: string, t: string) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(blok); return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() || undefined : undefined; };
  const instellingen: AnbiInstelling[] = [];
  for (const m of xml.matchAll(/<beschikking>([\s\S]*?)<\/beschikking>/g)) {
    const x = m[1];
    const naam = tag(x, "naam");
    if (!naam) continue;
    instellingen.push(Object.fromEntries(Object.entries({
      naam, alias: tag(x, "aliasNaam"), rsin: tag(x, "fiscaalNummer"), plaats: tag(x, "vestigingsPlaats"), website: tag(x, "webSite"),
      ingang: tag(x, "ingangsDatum"), eind: tag(x, "eindDatum"), intrekking: tag(x, "intrekkingsDatum"), cultuur_ingang: tag(x, "ingangsDatumCultuur"), cultuur_eind: tag(x, "eindDatumCultuur"), dossier: tag(x, "dossierNummer"),
    }).filter(([, v]) => v !== undefined)) as unknown as AnbiInstelling);
  }
  return { aangemaakt: /<aanmaakDatum>([^<]+)</.exec(xml)?.[1], instellingen };
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function zoekAnbi(list: AnbiInstelling[], q: { naam?: string; rsin?: string; plaats?: string; peildatum?: string }, max: number): { totaal: number; items: Array<AnbiInstelling & { status: string }> } {
  const rsin = q.rsin?.replace(/\D/g, "");
  const woorden = q.naam ? fold(q.naam).split(" ").filter(Boolean) : [];
  const plaats = q.plaats ? fold(q.plaats) : undefined;
  const peil = q.peildatum ?? new Date().toISOString().slice(0, 10);
  const hits = list.filter((i) =>
    (!rsin || (i.rsin ?? "").replace(/\D/g, "").replace(/^0+/, "") === rsin.replace(/^0+/, "")) &&
    (!woorden.length || woorden.every((w) => fold(`${i.naam} ${i.alias ?? ""}`).split(" ").some((t) => t.startsWith(w)))) &&
    (!plaats || fold(i.plaats ?? "") === plaats));
  const status = (i: AnbiInstelling) => {
    const einde = [i.eind, i.intrekking].filter(Boolean).sort()[0];
    const anbi = (i.ingang ?? "0000") <= peil && (!einde || einde >= peil) ? `ANBI op ${peil}` : einde && einde < peil ? `geen ANBI meer (sinds ${einde})` : `nog geen ANBI op ${peil} (vanaf ${i.ingang})`;
    const cult = i.cultuur_ingang && i.cultuur_ingang <= peil && (!i.cultuur_eind || i.cultuur_eind >= peil) ? "; culturele ANBI" : "";
    return anbi + cult;
  };
  // Exact name matches first.
  const exact = q.naam ? fold(q.naam) : "";
  hits.sort((a, b) => Number(fold(b.naam) === exact) - Number(fold(a.naam) === exact) || a.naam.localeCompare(b.naam));
  return { totaal: hits.length, items: hits.slice(0, max).map((i) => ({ ...i, status: status(i) })) };
}

interface AnbiRegister { at: number; aangemaakt?: string; instellingen: AnbiInstelling[] }
let anbiCache: AnbiRegister | null = null;
let anbiLoading: Promise<AnbiRegister> | null = null;
async function laadAnbi(): Promise<AnbiRegister> {
  if (anbiCache && Date.now() - anbiCache.at < 12 * 3600_000) return anbiCache;
  anbiLoading ??= (async () => {
    try {
      const { data } = await getBinary(ANBI_ZIP, { connector: "anbi", timeoutMs: 60_000, retries: 1, maxResponseBytes: 20 * 1024 * 1024 });
      const xml = new TextDecoder("latin1").decode(unzipEersteXml(data));
      const reg: AnbiRegister = { at: Date.now(), ...parseAnbiXml(xml) };
      anbiCache = reg;
      return reg;
    } finally { anbiLoading = null; }
  })();
  return anbiLoading;
}

// ---------- tools ----------

export function registerJuridischeBronnen(server: McpServer, deps: { TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  server.registerTool("puc_zoeken", {
    description:
      "Search PUC (puc.overheid.nl), where bodies publish their own uitvoeringsinformatie: SVB Beleidsregels (AOW, AKW, Anw, Participatiewet/AIO), IND werkinstructies and informatieberichten, RSJ uitspraken (beklag/beroep in detentie en jeugdbescherming), NZa beleidsregels, ministeriële en Defensie publicaties. " +
      "Use it for the policy and practice behind a decision of these bodies. Returns title, document type, kenmerk (e.g. SB1407), validity and a link; read with puc_document_get.",
    inputSchema: {
      zoekterm: z.string().min(2).max(200).describe("Search words, e.g. 'terugvordering dringende reden', 'gezinshereniging inkomenseis'."),
      portaal: z.string().regex(/^[a-z0-9-]{2,30}$/).optional().describe(`Portal: ${Object.entries(PUC_PORTALEN).map(([k, v]) => `'${k}' = ${v}`).join("; ")}. Without: all of PUC.`),
      alleen_geldig: z.boolean().default(true).describe("Only versions valid today (true) or also older versions (false, for a past peildatum)."),
      sorteer: z.enum(["relevantie", "datum"]).default("relevantie"),
      pagina: z.number().int().min(1).max(50).default(1).describe("Result page (20 per page)."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ zoekterm, portaal, alleen_geldig, sorteer, pagina }) => {
    const url = pucZoekUrl({ portaal, zoekterm, pagina, geldigVandaag: alleen_geldig, sorteer });
    const params = Object.fromEntries(Object.entries({ zoekterm, portaal, alleen_geldig, sorteer, pagina }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    try {
      const r = parsePucZoek(await pucGet(url));
      const records: MCPRecord[] = r.treffers.map((t) => ({ source_name: "puc.overheid.nl", title: t.titel, canonical_url: t.url, date: t.datum ?? t.geldig_vanaf ?? t.beschikbaar, snippet: t.fragment, data: { ...t } }));
      return toMcpToolPayload(successResponse({
        summary: `PUC${portaal ? ` (${portaal})` : ""}: ${r.totaal ?? "?"} treffers voor '${zoekterm}'; ${records.length} getoond (pagina ${pagina})`,
        records,
        provenance: { tool: "puc_zoeken", endpoint: url, query_params: params, timestamp: nowIso(), returned_results: records.length, total_results: r.totaal ?? records.length },
        access_note: PUC_NOTE,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PUC", url));
    }
  });

  server.registerTool("puc_document_get", {
    description: "Read one PUC document (puc.overheid.nl/doc/PUC_…): text, version and validity, document type, kenmerk, and its relations (articles of law via Juriconnect, ECLI's, Staatscourant). Optionally a specific version or only the passages with a search term.",
    inputSchema: {
      id: z.string().max(300).describe("PUC id ('PUC_811677_20') or URL."),
      versie: z.number().int().min(1).max(500).optional().describe("Version number (older policy at an earlier date); default the current one."),
      zoekterm: z.string().max(120).optional(),
      max_chars: z.number().int().min(1000).max(100_000).default(20_000),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ id, versie, zoekterm, max_chars }) => {
    const m = /PUC_\d+_\d+/i.exec(id);
    if (!m) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen PUC-id in '${id.slice(0, 100)}'.`, suggestion: "Gebruik een id uit puc_zoeken, bijv. PUC_811677_20." }));
    const pid = m[0].toUpperCase();
    const url = `${PUC_BASE}/doc/${pid}${versie ? `/${versie}` : ""}`;
    try {
      const d = parsePucDocument(await pucGet(url), pid);
      const body = zoekterm ? passages(d.tekst, zoekterm).join("\n…\n") : d.tekst;
      const tekst = body.length > max_chars ? `${body.slice(0, max_chars)}…` : body;
      return toMcpToolPayload(successResponse({
        summary: `${d.titel}${d.kenmerk ? ` (${d.kenmerk})` : ""}${d.geldigheid ? `, geldig ${d.geldigheid}` : ""}; ${d.relaties.length} relaties`,
        records: [{ source_name: "puc.overheid.nl", title: d.titel, canonical_url: url, data: { ...d, tekst, ingekort: body.length > max_chars, ...(zoekterm ? { zoekterm } : {}) } }],
        provenance: { tool: "puc_document_get", endpoint: url, query_params: { id, ...(versie ? { versie: String(versie) } : {}), ...(zoekterm ? { zoekterm } : {}) }, timestamp: nowIso(), returned_results: 1, total_results: 1 },
        access_note: `${PUC_NOTE} relaties: de wetsartikelen (Juriconnect-links, bruikbaar in lido_relaties), uitspraken en bekendmakingen waarnaar het document verwijst.`,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "PUC", url));
    }
  });

  server.registerTool("woo_jurisprudentie_zoeken", {
    description:
      "Search the Woo-jurisprudentiedatabase of the Adviescollege Openbaarheid en Informatiehuishouding (ACOI, woo-wijzer.acoi.nl): rulings on the Woo and Wob since May 2022, each with a short expert summary. " +
      "Filter on court, refusal ground (art. 5.1/5.2/5.3 Woo) and date. Returns ECLI, date, summary and links; read the ruling itself with rechtspraak_get_by_ecli.",
    inputSchema: {
      zoekterm: z.string().max(200).optional(),
      instantie: z.string().max(80).optional().describe("'Raad van State', 'Hoge Raad', 'hof', 'rechtbank', 'CBb'."),
      weigeringsgrond: z.string().max(80).optional().describe("Woo ground: '5.1 lid 2 e', '5.2 lid 1', '5.3', or words ('persoonlijke levenssfeer', 'intern beraad')."),
      vanaf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      tot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      sorteer: z.enum(["recent", "oudnieuw"]).default("recent"),
      pagina: z.number().int().min(1).max(50).default(1).describe("20 per page."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ zoekterm, instantie, weigeringsgrond, vanaf, tot, sorteer, pagina }) => {
    const inst = acoiInstantie(instantie), grond = acoiGrond(weigeringsgrond);
    if (inst === null) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Instantie '${instantie}' onbekend.`, suggestion: `Kies uit: ${Object.values(ACOI_INSTANTIES).join(", ")}.` }));
    if (grond === null) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Weigeringsgrond '${weigeringsgrond}' onbekend.`, suggestion: `Bijv. ${Object.values(ACOI_GRONDEN).slice(0, 6).join("; ")}.` }));
    const filter = { folderurl: ACOI_FOLDER, query: zoekterm ?? "", sorteer, page: pagina - 1, ...(inst ? { instantie: [inst] } : {}), ...(grond ? { uitzonderingsgrond: grond } : {}), ...(vanaf ? { vanaf } : {}), ...(tot ? { tot } : {}) };
    const params = Object.fromEntries(Object.entries({ zoekterm, instantie, weigeringsgrond, vanaf, tot, sorteer, pagina }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    try {
      const { data } = await postJson<{ error?: { message?: string } | null; result?: { totalcount?: number; resultshtml?: string; filtercounts?: Array<{ items?: Array<{ id: number; results: number }> }> } }>(
        ACOI_RPC, { id: 1, method: "SearchJurisprudentie", params: [filter] }, { connector: "acoi", timeoutMs: 30_000, retries: 1, headers: { Accept: "application/json" } });
      if (data.error) throw new Error(`ACOI: ${data.error.message ?? "fout"}`);
      const items = parseAcoiHtml(data.result?.resultshtml ?? "");
      const perInstantie = (data.result?.filtercounts?.[0]?.items ?? []).filter((i) => ACOI_INSTANTIES[String(i.id)]).map((i) => ({ instantie: ACOI_INSTANTIES[String(i.id)], aantal: i.results }));
      const records: MCPRecord[] = items.map((u) => ({ source_name: "woo-wijzer.acoi.nl", title: u.ecli, date: u.datum, canonical_url: u.uitspraak_url ?? u.annotatie_url ?? ACOI_FOLDER, snippet: u.samenvatting.slice(0, 400), data: { ...u } }));
      return toMcpToolPayload(successResponse({
        summary: `ACOI Woo-jurisprudentie: ${data.result?.totalcount ?? records.length} uitspraken; ${records.length} getoond (pagina ${pagina})`,
        records,
        provenance: { tool: "woo_jurisprudentie_zoeken", endpoint: ACOI_RPC, query_params: params, timestamp: nowIso(), returned_results: records.length, total_results: data.result?.totalcount ?? records.length },
        access_note: `Bron: Woo-jurisprudentiedatabase van het ACOI (woo-wijzer.acoi.nl), uitspraken sinds mei 2022 met een korte duiding door het ACOI. De duiding is geen bron: lees de uitspraak (rechtspraak_get_by_ecli) en citeer daaruit. Verdeling per instantie: ${JSON.stringify(perInstantie)}.`,
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "ACOI", ACOI_FOLDER));
    }
  });

  server.registerTool("anbi_zoeken", {
    description:
      "Check whether an institution is (or was) an ANBI, a public-benefit institution (algemeen nut beogende instelling) in the Belastingdienst register: on name, RSIN/fiscaal nummer or place, with start and end date and cultural-ANBI status on a reference date. " +
      "Relevant for gifts and inheritances (schenk- en erfbelasting, giftenaftrek) and for the status of foundations.",
    inputSchema: {
      naam: z.string().max(200).optional(),
      rsin: z.string().max(20).optional().describe("RSIN / fiscaal nummer."),
      plaats: z.string().max(80).optional(),
      peildatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Status on this date (default today), e.g. the date of a gift or death."),
      max: z.number().int().min(1).max(100).default(20),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async ({ naam, rsin, plaats, peildatum, max }) => {
    if (!naam?.trim() && !rsin?.trim()) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Geef een naam of RSIN.", suggestion: "Bijv. naam: 'KWF Kankerbestrijding' of rsin: '002295001'." }));
    try {
      const reg = await laadAnbi();
      const r = zoekAnbi(reg.instellingen, { naam, rsin, plaats, peildatum }, max);
      const records: MCPRecord[] = r.items.map((i) => ({ source_name: "Belastingdienst ANBI-register", title: i.naam, canonical_url: `https://www.belastingdienst.nl/rekenhulpen/giften/anbi-zoeken/`, snippet: `${i.status}${i.plaats ? `, ${i.plaats}` : ""}${i.rsin ? `, RSIN ${i.rsin}` : ""}`, data: { ...i } }));
      return toMcpToolPayload(successResponse({
        summary: `ANBI-register (stand ${reg.aangemaakt ?? "?"}): ${r.totaal} treffers; ${records.length} getoond`,
        records,
        provenance: { tool: "anbi_zoeken", endpoint: ANBI_ZIP, query_params: Object.fromEntries(Object.entries({ naam, rsin, plaats, peildatum }).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: records.length, total_results: r.totaal },
        access_note:
          `Bron: open data ANBI-register van de Belastingdienst (${ANBI_ZIP}, ${reg.instellingen.length} beschikkingen, aangemaakt ${reg.aangemaakt ?? "onbekend"}; in deze server 12 uur gecachet). ` +
          "Status volgt uit ingangs-, eind- en intrekkingsdatum op de peildatum. Een instelling die niet voorkomt, had geen ANBI-beschikking (of staat er onder een andere naam: zoek ook op RSIN). Controleer bij twijfel op belastingdienst.nl (ANBI zoeken).",
      }));
    } catch (e) {
      return toMcpToolPayload(mapSourceError(e, "ANBI-register", ANBI_ZIP));
    }
  });
}

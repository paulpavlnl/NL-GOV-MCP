/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. Resolves EU references through
 * the CELLAR SPARQL endpoint (owl:sameAs between resource/ecli, resource/celex
 * and resource/case), reads metadata, and fetches the Dutch text by content
 * negotiation on resource/celex, with EUR-Lex, the Dutch PDF and another
 * language as fallbacks.
 */
import type { AppConfig } from "../types.js";
import { getJson, getText, SourceRequestError } from "../utils/http.js";
import { fetchPdfText } from "../utils/pdf-text.js";
import {
  analyseUitspraak,
  analyseWetgeving,
  caseNumberCelexCandidates,
  caseResourceUri,
  detectTaal,
  cleanPdfLines,
  ecliResourceUri,
  isPlaceholderInfo,
  euHtmlToLines,
  instantieFromCelex,
  soortFromCelex,
  type EuDocSoort,
  type EuReferences,
  type EuUitspraakTekst,
  type EuWetgevingTekst,
} from "./eu-tekst.js";

export const CELLAR_SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
export const CELLAR_CELEX = "https://publications.europa.eu/resource/celex/";
export const EURLEX_HTML = "https://eur-lex.europa.eu/legal-content/NL/TXT/HTML/?uri=CELEX:";
export const EURLEX_NL = "https://eur-lex.europa.eu/legal-content/NL/TXT/?uri=CELEX:";

/** CELLAR and EUR-Lex can be slow on a cold cache; a Render instance waking up adds to that. */
const SPARQL_TIMEOUT_MS = 25_000;
const TEXT_TIMEOUT_MS = 35_000;
const TEXT_MAX_BYTES = 20 * 1024 * 1024;

const PREFIXES =
  "PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>\n" +
  "PREFIX owl: <http://www.w3.org/2002/07/owl#>\n" +
  "PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>\n";
const LANG_NLD = "http://publications.europa.eu/resource/authority/language/NLD";
const LANG_ENG = "http://publications.europa.eu/resource/authority/language/ENG";

type Binding = Record<string, { value?: string } | undefined>;
const val = (row: Binding, key: string): string | undefined => {
  const v = row[key]?.value;
  return v === undefined || v === "" ? undefined : v;
};

/** Only these strings ever reach a SPARQL query: digits, capitals and the fixed separators. */
const SAFE_CELEX = /^[36]\d{4}[A-Z]{1,2}\d{4}$/;
const SAFE_ECLI = /^ECLI:EU:[CTF]:\d{4}:\d{1,6}$/;
const SAFE_CASE = /^(?:[CTF]-)?\d{1,4}\/\d{2,4}$/;

export interface EuIdentificatie {
  /** The identifier as written ("ECLI:EU:C:2005:315", "C-478/03", "32001L0023"). */
  invoer: string;
  soort: "ecli" | "celex" | "zaaknummer" | "wetgeving";
  /** CELEX numbers CELLAR links to it (empty: CELLAR does not know it). */
  celex: string[];
}

export interface EuResolutie {
  identificaties: EuIdentificatie[];
  /** The document the reference points to: the CELEX all identifiers agree on, else the first found. */
  celex?: string;
  /** Set when the identifiers point to different documents (e.g. an ECLI of another case). */
  inconsistent?: string;
}

export interface EuMetadata {
  celex: string;
  ecli?: string;
  datum?: string;
  soort: EuDocSoort;
  instantie?: string;
  titel?: string;
  titel_taal?: "nl" | "en";
  partijen?: string;
  zaaknummer?: string;
  onderwerp?: string;
  /** "Arrest van het Hof (Eerste kamer) van 26 mei 2005." */
  aanduiding?: string;
  resource_type?: string;
  in_force?: boolean | null;
  eli?: string;
}

export interface EuTekstPoging {
  bron: "cellar_html" | "eurlex_html" | "cellar_pdf" | "cellar_html_andere_taal";
  url: string;
  ok: boolean;
  taal?: string;
  reden?: string;
}

export interface EuTekst {
  lines: string[];
  url: string;
  taal: string;
  formaat: "html" | "pdf";
  pogingen: EuTekstPoging[];
}

function reason(e: unknown): string {
  if (e instanceof SourceRequestError) return e.status ? `HTTP ${e.status}` : e.code;
  return e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
}

export class EuTekstSource {
  constructor(private readonly config: AppConfig) {}

  private async select(query: string): Promise<Binding[]> {
    const { data } = await getJson<{ results?: { bindings?: Binding[] } }>(CELLAR_SPARQL, {
      query: { query: PREFIXES + query },
      headers: { Accept: "application/sparql-results+json" },
      connector: "eu_cellar",
      timeoutMs: SPARQL_TIMEOUT_MS,
      retries: 1,
    });
    const bindings = data?.results?.bindings;
    if (!Array.isArray(bindings)) throw new Error("CELLAR SPARQL gaf een onverwacht antwoord (geen results.bindings).");
    return bindings;
  }

  /**
   * All identifiers of a reference in one SPARQL query: an ECLI or case number
   * through owl:sameAs (resource/ecli, resource/case → work → resource_legal_id_celex),
   * CELEX numbers (written or derived from a case number) by exact lookup.
   */
  async resolve(refs: EuReferences): Promise<EuResolutie> {
    const eclis = refs.eclis.filter((e) => SAFE_ECLI.test(e));
    const zaken = refs.zaaknummers.filter((z) => SAFE_CASE.test(z.zaaknummer));
    const celexValues = new Set<string>([...refs.caseCelex, ...refs.legislationCelex, ...zaken.flatMap(caseNumberCelexCandidates)].filter((c) => SAFE_CELEX.test(c)));
    const parts: string[] = [];
    if (eclis.length) {
      parts.push(`{ VALUES (?key ?id) { ${eclis.map((e) => `("ecli|${e}" <${ecliResourceUri(e)}>)`).join(" ")} }
    ?work owl:sameAs ?id . ?work cdm:resource_legal_id_celex ?celex }`);
    }
    if (zaken.length) {
      parts.push(`{ VALUES (?key ?id) { ${zaken.map((z) => `("case|${z.zaaknummer}" <${caseResourceUri(z.zaaknummer)}>)`).join(" ")} }
    ?dossier owl:sameAs ?id . ?dossier cdm:dossier_contains_work ?work . ?work cdm:resource_legal_id_celex ?celex }`);
    }
    if (celexValues.size) {
      parts.push(`{ VALUES ?celex { ${[...celexValues].map((c) => `"${c}"^^xsd:string`).join(" ")} }
    ?work cdm:resource_legal_id_celex ?celex . BIND(CONCAT("celex|", STR(?celex)) AS ?key) }`);
    }
    if (!parts.length) return { identificaties: [] };
    const rows = await this.select(`SELECT DISTINCT ?key ?celex WHERE {\n  ${parts.join("\n  UNION\n  ")}\n} LIMIT 500`);
    const byKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = val(r, "key");
      const celex = val(r, "celex");
      if (!key || !celex || celex.includes("(")) continue;
      byKey.set(key, (byKey.get(key) ?? new Set()).add(celex));
    }
    const found = (key: string) => [...(byKey.get(key) ?? [])];
    const identificaties: EuIdentificatie[] = [
      ...eclis.map((e) => ({ invoer: e, soort: "ecli" as const, celex: found(`ecli|${e}`) })),
      ...refs.caseCelex.map((c) => ({ invoer: c, soort: "celex" as const, celex: found(`celex|${c}`) })),
      ...zaken.map((z) => {
        // The dossier (newer cases) lists every document of the case; else the derived CELEX numbers that exist.
        const dossier = found(`case|${z.zaaknummer}`);
        const derived = caseNumberCelexCandidates(z).filter((c) => byKey.has(`celex|${c}`));
        return { invoer: z.zaaknummer, soort: "zaaknummer" as const, celex: rankCaseCelex([...new Set([...dossier, ...derived])]) };
      }),
      ...refs.legislationCelex.map((c) => ({ invoer: c, soort: "wetgeving" as const, celex: found(`celex|${c}`) })),
    ];
    return { identificaties, ...pickDocument(identificaties) };
  }

  async metadata(celex: string): Promise<EuMetadata | null> {
    if (!SAFE_CELEX.test(celex)) throw new Error(`Ongeldig CELEX-nummer: ${celex.slice(0, 40)}`);
    const rows = await this.select(`SELECT ?ecli ?date ?type ?force ?eli ?titleNl ?titleEn ?parties ?caseId ?subject ?info WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^xsd:string .
  OPTIONAL { ?work cdm:case-law_ecli ?ecli }
  OPTIONAL { ?work cdm:work_date_document ?date }
  OPTIONAL { ?work cdm:work_has_resource-type ?type }
  OPTIONAL { ?work cdm:resource_legal_in-force ?force }
  OPTIONAL { ?work cdm:resource_legal_eli ?eli }
  OPTIONAL { ?nl cdm:expression_belongs_to_work ?work ; cdm:expression_uses_language <${LANG_NLD}> .
    OPTIONAL { ?nl cdm:expression_title ?titleNl }
    OPTIONAL { ?nl cdm:expression_case-law_parties ?parties }
    OPTIONAL { ?nl cdm:expression_case-law_identifier_case ?caseId }
    OPTIONAL { ?nl cdm:expression_case-law_indicator_decision ?subject }
    OPTIONAL { ?nl cdm:expression_title_information_additional ?info } }
  OPTIONAL { ?en cdm:expression_belongs_to_work ?work ; cdm:expression_uses_language <${LANG_ENG}> ; cdm:expression_title ?titleEn }
} LIMIT 50`);
    if (!rows.length) return null;
    const first = (k: string) => rows.map((r) => val(r, k)).find((v) => v !== undefined);
    const types = rows.map((r) => val(r, "type")?.split("/").pop()).filter((t): t is string => Boolean(t));
    const titleNl = first("titleNl");
    const titleEn = first("titleEn");
    const clean = (s?: string) => s?.replace(/\s*#\s*/g, " ").replace(/\s+/g, " ").trim();
    const zaak = first("caseId")?.replace(/^(?:zaak|zaken|gevoegde\s+zaken)\s+/i, "").replace(/\.$/, "");
    const force = first("force");
    return {
      celex,
      ecli: first("ecli"),
      datum: first("date")?.slice(0, 10),
      soort: soortFromCelex(celex),
      instantie: instantieFromCelex(celex),
      titel: clean(titleNl ?? titleEn),
      titel_taal: titleNl ? "nl" : titleEn ? "en" : undefined,
      partijen: first("parties")?.replace(/\.$/, ""),
      zaaknummer: zaak ?? zaakFromTitle(titleNl ?? titleEn),
      onderwerp: first("subject"),
      aanduiding: isPlaceholderInfo(first("info")) ? undefined : first("info"),
      resource_type: types[0],
      ...(celex.startsWith("3") ? { in_force: force === "true" || force === "1" ? true : force === "false" || force === "0" ? false : null, eli: first("eli") } : {}),
    };
  }

  /**
   * The text of a document, Dutch first: content negotiation on resource/celex
   * (Accept: application/xhtml+xml, text/html; Accept-Language: nl), then the
   * EUR-Lex HTML page, then the Dutch PDF. Only when no Dutch text exists, the
   * HTML in another language, with that language reported.
   */
  async text(celex: string): Promise<EuTekst | { pogingen: EuTekstPoging[] }> {
    if (!SAFE_CELEX.test(celex)) throw new Error(`Ongeldig CELEX-nummer: ${celex.slice(0, 40)}`);
    const pogingen: EuTekstPoging[] = [];
    let other: EuTekst | undefined;
    const html = async (bron: EuTekstPoging["bron"], url: string, lang: string): Promise<EuTekst | undefined> => {
      try {
        const { data, meta } = await getText(url, {
          headers: { Accept: "application/xhtml+xml, text/html", "Accept-Language": lang },
          connector: "eu_cellar",
          timeoutMs: TEXT_TIMEOUT_MS,
          retries: 1,
          maxResponseBytes: TEXT_MAX_BYTES,
        });
        const lines = euHtmlToLines(data);
        const chars = lines.reduce((n, l) => n + l.length, 0);
        if (chars < 200) {
          // EUR-Lex answers bots with HTTP 202 and an empty page.
          pogingen.push({ bron, url, ok: false, reden: `geen tekst ontvangen (HTTP ${meta.status}, ${chars} tekens)` });
          return undefined;
        }
        const taal = detectTaal(lines.join(" "));
        pogingen.push({ bron, url: meta.url, ok: true, taal });
        return { lines, url: meta.url, taal, formaat: "html", pogingen };
      } catch (e) {
        pogingen.push({ bron, url, ok: false, reden: reason(e) });
        return undefined;
      }
    };

    const first = await html("cellar_html", CELLAR_CELEX + celex, "nl");
    if (first?.taal === "nl") return first;
    if (first) other = first;
    const eurlex = await html("eurlex_html", EURLEX_HTML + celex, "nl");
    if (eurlex?.taal === "nl") return eurlex;
    other ??= eurlex;

    const pdf = await fetchPdfText(CELLAR_CELEX + celex, { connector: "eu_cellar", timeoutMs: TEXT_TIMEOUT_MS, retries: 1, maxChars: 200_000, headers: { "Accept-Language": "nl" } });
    if (pdf.ok) {
      const lines = cleanPdfLines(pdf.text.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean));
      const taal = detectTaal(pdf.text);
      pogingen.push({ bron: "cellar_pdf", url: pdf.source_url, ok: true, taal });
      if (taal === "nl") return { lines, url: pdf.source_url, taal, formaat: "pdf", pogingen };
      other ??= { lines, url: pdf.source_url, taal, formaat: "pdf", pogingen };
    } else {
      pogingen.push({ bron: "cellar_pdf", url: pdf.source_url, ok: false, reden: pdf.message?.slice(0, 200) ?? pdf.reason });
    }

    if (!other) other = await html("cellar_html_andere_taal", CELLAR_CELEX + celex, "en, fr;q=0.9, de;q=0.8");
    return other ? { ...other, pogingen } : { pogingen };
  }
}

/** Judgment first, then order, then opinion; within a kind the lowest number (the first of joined cases). */
export function rankCaseCelex(celex: string[]): string[] {
  const rank = (c: string) => {
    const t = c.slice(5, 7);
    return (/J$/.test(t) ? 0 : /O$/.test(t) ? 1 : /C$/.test(t) ? 2 : 3);
  };
  return [...celex].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The document all identifiers agree on. An ECLI belongs to exactly one
 * document; a case number to all documents of the case (judgment, opinion,
 * orders): they agree when the ECLI's document is one of them.
 */
export function pickDocument(ids: EuIdentificatie[]): Pick<EuResolutie, "celex" | "inconsistent"> {
  const withDocs = ids.filter((i) => i.celex.length);
  if (!withDocs.length) return {};
  const strict = withDocs.filter((i) => i.soort !== "zaaknummer");
  const anchor = strict[0] ?? withDocs[0];
  const celex = anchor.celex[0];
  const disagree = withDocs.filter((i) => !i.celex.includes(celex));
  if (!disagree.length) return { celex };
  return {
    celex,
    inconsistent:
      `De identificaties wijzen naar verschillende documenten: ${anchor.invoer} is ${celex}, ` +
      disagree.map((i) => `${i.invoer} is ${i.celex.slice(0, 3).join("/")}`).join(", ") + ". Controleer welke bedoeld is.",
  };
}

function zaakFromTitle(title?: string): string | undefined {
  return title?.match(/(?:Zaak|Zaken|Gevoegde zaken)\s+([^#.]+?)\.?(?:#|$)/i)?.[1]?.trim();
}

export type { EuUitspraakTekst, EuWetgevingTekst };
export { analyseUitspraak, analyseWetgeving };

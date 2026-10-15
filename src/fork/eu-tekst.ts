/**
 * FORK MODULE (paulpavlnl) — EU case law and legislation by ECLI, CELEX, case
 * number or citation. Not part of WAINUTAI/NL-GOV-MCP: keep it in src/fork/ so
 * upstream merges never touch it. See docs/FORK.md.
 *
 * This file is pure: recognising references, turning CELLAR/EUR-Lex HTML into
 * lines, finding paragraph numbers (randnummers), the operative part (dictum),
 * articles and recitals, language detection, search and citation checks.
 */
import { normalizeCelex } from "../sources/eu-cellar.js";

/* ------------------------------------------------------------------ */
/* References                                                          */
/* ------------------------------------------------------------------ */

export type EuCourt = "C" | "T" | "F";

export interface EuZaaknummer {
  /** As CELLAR writes it: "C-478/03", "T-12/19", or "287/86" before 1989. */
  zaaknummer: string;
  court: EuCourt;
  year: string;
  number: string;
}

export interface EuReferences {
  eclis: string[];
  /** Sector 6 (case law) CELEX numbers written in the reference. */
  caseCelex: string[];
  zaaknummers: EuZaaknummer[];
  /** Sector 3 (legislation) CELEX: written, or read from a citation ("Richtlijn 2001/23/EG"). */
  legislationCelex: string[];
}

const ECLI_EU_RE = /ECLI:EU:([CTF]):(\d{4}):(\d{1,6})/gi;
/** 6YYYY + document letters + number: CJ (judgment), CC (A-G opinion), CO (order), TJ/TO/TC (General Court), FJ/FO (Civil Service Tribunal) and the rarer letters. */
const CASE_CELEX_RE = /(?<![\dA-Z])6((?:19|20)\d{2})([CTF][A-Z])(\d{4})(?:\(\d{1,2}\))?(?![\dA-Z])/gi;
const LEG_CELEX_RE = /(?<![\dA-Z])(?:CELEX:?\s*)?3((?:19|20)\d{2})([RLD])(\d{4})(?![\dA-Z])/gi;
/** "C-478/03", "C‑478/03" (non-breaking hyphen), "T 12/19", "zaak C-344/18 P". */
const CASE_NUMBER_RE = /(?<![\p{L}\d])([CTF])\s*[-‑–]\s*(\d{1,4})\s*\/\s*(\d{2}|\d{4})(?!\d)/giu;
/** Pre-1989 numbers carry no court letter and need the word: "zaak 287/86", "zaken 24/85". */
const OLD_CASE_NUMBER_RE = /\b(?:zaak|zaken|case|cases|affaire)\s+(\d{1,4})\s*\/\s*(\d{2})(?!\d)/giu;

function fullYear(y: string): string {
  if (y.length === 4) return y;
  return Number(y) >= 53 ? `19${y}` : `20${y}`;
}

/** Every EU identifier in a reference, in order of appearance, without duplicates. */
export function parseEuReferences(input: string): EuReferences {
  const s = String(input ?? "").normalize("NFC");
  const eclis = [...new Set([...s.matchAll(ECLI_EU_RE)].map((m) => `ECLI:EU:${m[1].toUpperCase()}:${m[2]}:${Number(m[3])}`))];
  const caseCelex = [...new Set([...s.matchAll(CASE_CELEX_RE)].map((m) => `6${m[1]}${m[2].toUpperCase()}${m[3]}`))];
  const zaaknummers: EuZaaknummer[] = [];
  const seen = new Set<string>();
  // An ECLI or CELEX holds digits that look like nothing here, but strip them anyway.
  const rest = s.replace(ECLI_EU_RE, " ").replace(CASE_CELEX_RE, " ");
  for (const m of rest.matchAll(CASE_NUMBER_RE)) {
    const court = m[1].toUpperCase() as EuCourt;
    const year = fullYear(m[3]);
    const number = String(Number(m[2]));
    const zaaknummer = `${court}-${number}/${m[3]}`;
    if (!seen.has(zaaknummer)) { seen.add(zaaknummer); zaaknummers.push({ zaaknummer, court, year, number }); }
  }
  for (const m of rest.matchAll(OLD_CASE_NUMBER_RE)) {
    const year = fullYear(m[2]);
    if (Number(year) >= 1989) continue; // since 1989 every number has C- or T-
    const number = String(Number(m[1]));
    const zaaknummer = `${number}/${m[2]}`;
    if (!seen.has(zaaknummer)) { seen.add(zaaknummer); zaaknummers.push({ zaaknummer, court: "C", year, number }); }
  }
  const legislationCelex = [...new Set([...s.matchAll(LEG_CELEX_RE)].map((m) => `3${m[1]}${m[2].toUpperCase()}${m[3]}`))];
  if (!legislationCelex.length && !eclis.length && !caseCelex.length && !zaaknummers.length) {
    const cited = normalizeCelex(s);
    if (cited) legislationCelex.push(cited);
  }
  return { eclis, caseCelex, zaaknummers, legislationCelex };
}

export function hasEuReference(refs: EuReferences): boolean {
  return Boolean(refs.eclis.length || refs.caseCelex.length || refs.zaaknummers.length || refs.legislationCelex.length);
}

/**
 * CELEX numbers a case number can carry, most likely first: the judgment, then
 * an order, then the A-G opinion. Joined cases carry the CELEX of the first
 * case; CELLAR's dossier (resource/case) finds those.
 */
export function caseNumberCelexCandidates(z: EuZaaknummer): string[] {
  const n = z.number.padStart(4, "0");
  const letters = z.court === "C" ? ["CJ", "CO", "CC"] : z.court === "T" ? ["TJ", "TO", "TC"] : ["FJ", "FO"];
  return letters.map((l) => `6${z.year}${l}${n}`);
}

/** The CELLAR resource URI CELLAR links with owl:sameAs ("…/case/C-478%2F03"). */
export function caseResourceUri(zaaknummer: string): string {
  return `http://publications.europa.eu/resource/case/${encodeURIComponent(zaaknummer)}`;
}

export function ecliResourceUri(ecli: string): string {
  return `http://publications.europa.eu/resource/ecli/${encodeURIComponent(ecli)}`;
}

export type EuDocSoort = "arrest" | "beschikking" | "conclusie" | "advies" | "uitspraak" | "verordening" | "richtlijn" | "besluit" | "wetgeving";

/** Kind of document from the CELEX document letters. */
export function soortFromCelex(celex: string): EuDocSoort {
  if (celex.startsWith("3")) return celex[5] === "R" ? "verordening" : celex[5] === "L" ? "richtlijn" : celex[5] === "D" ? "besluit" : "wetgeving";
  const t = celex.slice(5, 7);
  if (/^[CTF]J$/.test(t)) return "arrest";
  if (/^[CTF]O$/.test(t)) return "beschikking";
  if (/^[CTF]C$/.test(t) || t === "CP" || t === "CV") return t === "CV" ? "advies" : "conclusie";
  return "uitspraak";
}

export function instantieFromCelex(celex: string): string | undefined {
  if (!celex.startsWith("6")) return undefined;
  return { C: "Hof van Justitie", T: "Gerecht", F: "Gerecht voor ambtenarenzaken" }[celex[5]];
}

/* ------------------------------------------------------------------ */
/* HTML → lines                                                        */
/* ------------------------------------------------------------------ */

/** Marks where the signatures start, so names never end up in the dictum. */
export const END_MARK = "⟦einde⟧";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", euml: "ë", iuml: "ï",
  ouml: "ö", uuml: "ü", auml: "ä", eacute: "é", egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", oacute: "ó", uacute: "ú",
  iacute: "í", ccedil: "ç", szlig: "ß", deg: "°", sect: "§", middot: "·", times: "×", oslash: "ø", aring: "å", aelig: "æ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(?:([a-zA-Z][a-zA-Z0-9]*)|#(\d+)|#[xX]([0-9a-fA-F]+));/g, (m, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
    if (name) return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    return cp >= 1 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

function cleanLine(s: string): string {
  return s
    .replace(/[    ]/g, " ")
    .replace(/‑/g, "-")
    .replace(/­/g, "")
    // Old judgments (before ±1990) write a non-breaking space as '*': "ARTIKEL*177", "12*NOVEMBER*1986".
    .replace(/(?<=[\p{L}\p{N}.,)])\*(?=[\p{L}\p{N}(])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lines of an EU document in reading order. A table row is one line: modern
 * judgments put the paragraph number and its text in two cells, and a recital
 * number "(1)" and its text likewise.
 */
export function euHtmlToLines(html: string): string[] {
  let s = String(html ?? "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(?:p|td|table|div|tr)\b[^>]*class="[^"]*(?:signat|Signature)[^"]*"[^>]*>/i, (m) => `\n${END_MARK}\n${m}`);
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi, (_m, inner: string) => `\n${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}\n`);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|h[1-6]|li|ul|ol|table|tbody|thead|section|article|hr|txt_te|dl|dt|dd|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).split("\n").map(cleanLine).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Language                                                            */
/* ------------------------------------------------------------------ */

const STOPWORDS: Record<string, string[]> = {
  nl: ["het", "een", "van", "zijn", "niet", "worden", "wordt", "deze", "ook", "bij", "dat", "aan", "door", "voor", "moet", "artikel", "lid"],
  en: ["the", "of", "and", "to", "is", "that", "with", "which", "are", "this", "be", "must", "article", "shall"],
  fr: ["le", "la", "les", "des", "du", "est", "une", "dans", "pour", "qui", "sur", "au", "doit", "article"],
  de: ["der", "das", "und", "ist", "nicht", "mit", "von", "den", "dem", "für", "auf", "im", "artikel", "muss"],
  es: ["el", "los", "las", "del", "y", "por", "para", "una", "con", "artículo", "debe"],
  it: ["il", "della", "che", "di", "per", "non", "sono", "gli", "delle", "articolo", "deve"],
  pt: ["os", "da", "do", "em", "uma", "não", "para", "com", "artigo", "deve"],
};

export const TAAL_NAAM: Record<string, string> = { nl: "Nederlands", en: "Engels", fr: "Frans", de: "Duits", es: "Spaans", it: "Italiaans", pt: "Portugees" };

/** The language of a text by stopword counts, or "onbekend" when no language clearly leads. */
export function detectTaal(text: string): string {
  const words = String(text ?? "").slice(0, 30_000).toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (words.length < 20) return "onbekend";
  const counts: Record<string, number> = {};
  const lookup = new Map<string, string[]>();
  for (const [lang, list] of Object.entries(STOPWORDS)) for (const w of list) lookup.set(w, [...(lookup.get(w) ?? []), lang]);
  for (const w of words) for (const lang of lookup.get(w) ?? []) counts[lang] = (counts[lang] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < words.length * 0.04) return "onbekend";
  if (ranked[1] && ranked[1][1] > ranked[0][1] * 0.8) return "onbekend";
  return ranked[0][0];
}

/* ------------------------------------------------------------------ */
/* Case law: randnummers and dictum                                    */
/* ------------------------------------------------------------------ */

export interface EuEenheid {
  /** "39" for a randnummer, "artikel 3" or "overweging 12" for legislation, "dictum". */
  id: string;
  titel?: string;
  tekst: string;
}

export interface EuUitspraakTekst {
  randnummers: EuEenheid[];
  /** Headings between the randnummers, with the randnummer they precede. */
  koppen: Array<{ voor_randnummer: string; kop: string }>;
  dictum?: string;
  /** How the dictum or the A-G's proposal was found. */
  dictum_kop?: string;
}

const DICTUM_HEAD_RE = /(?:verklaart\s+(?:voor\s+recht|het\s+hof)|verklaart|beslist|rechtdoende|beschikt|bepaalt|hereby\s+(?:rules|orders|declares)|dit\s+pour\s+droit|déclare\s+et\s+arrête|ordonne|für\s+recht\s+erkannt|beschlossen)\s*(?:het\s+volgende\s*)?:\s*$/i;
const CONCLUSIE_HEAD_RE = /^(?:[IVXL]+\s*\.?\s*[-–—]?\s*)?(?:conclusie|conclusion|schlussfolgerung|ergebnis)\s*$/i;
const DICTUM_END_RE = new RegExp(`^(?:${END_MARK}|ondertekening(?:en)?|handtekeningen|signatures?|\\(?\\*\\d*\\)?\\s*procestaal\\b|procestaal\\b|uitgesproken\\s+ter\\s+openbare\\s+terechtzitting|delivered\\s+in\\s+open\\s+court|luxemburg,\\s+\\d|de\\s+griffier\\b|top$)`, "i");
const RANDNUMMER_RE = /^(\d{1,3})\.?\s+(\S[\s\S]*)$/;

function looksLikeHeading(line: string): boolean {
  return line.length <= 90 && !/[.;:,]$/.test(line) && /^[\p{Lu}IVX]/u.test(line);
}

/**
 * Randnummers are the longest run 1, 2, 3, … of lines that start with that
 * number: a summary at the top ("1. …", "2. …") forms a shorter run and loses.
 * Only lines before the dictum count.
 */
export function analyseUitspraak(lines: string[], soort: EuDocSoort = "arrest"): EuUitspraakTekst {
  let dictumStart = -1;
  const headRe = soort === "conclusie" ? CONCLUSIE_HEAD_RE : DICTUM_HEAD_RE;
  for (let i = 0; i < lines.length; i++) if (lines[i].length < 400 && headRe.test(lines[i])) dictumStart = i;
  const end = dictumStart >= 0 && soort !== "conclusie" ? dictumStart : lines.length;

  type Run = { units: EuEenheid[]; koppen: EuUitspraakTekst["koppen"] };
  const runs: Run[] = [];
  let cur: Run | null = null;
  let pendingKoppen: string[] = [];
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    if (line === END_MARK) continue;
    const m = RANDNUMMER_RE.exec(line);
    const n = m ? Number(m[1]) : NaN;
    if (m && n === 1 && (!cur || cur.units.length !== 0)) {
      cur = { units: [], koppen: [] };
      runs.push(cur);
    }
    if (m && cur && n === cur.units.length + 1) {
      for (const kop of pendingKoppen) cur.koppen.push({ voor_randnummer: String(n), kop });
      pendingKoppen = [];
      cur.units.push({ id: String(n), tekst: m[2] });
      continue;
    }
    if (cur && cur.units.length) {
      if (looksLikeHeading(line)) pendingKoppen.push(line);
      else {
        const last = cur.units[cur.units.length - 1];
        if (pendingKoppen.length) { last.tekst += `\n${pendingKoppen.join("\n")}`; pendingKoppen = []; }
        last.tekst += `\n${line}`;
      }
    }
  }
  const best = runs.reduce<Run | null>((a, r) => (!a || r.units.length > a.units.length ? r : a), null);

  let dictum: string | undefined;
  let dictumKop: string | undefined;
  if (dictumStart >= 0) {
    dictumKop = lines[dictumStart];
    const out: string[] = [];
    for (let i = dictumStart + 1; i < lines.length; i++) {
      if (DICTUM_END_RE.test(lines[i])) break;
      out.push(lines[i]);
    }
    dictum = out.join("\n").slice(0, 8_000) || undefined;
  }
  return { randnummers: best?.units ?? [], koppen: best?.koppen ?? [], dictum, dictum_kop: dictumKop };
}

/* ------------------------------------------------------------------ */
/* Legislation: articles and recitals                                  */
/* ------------------------------------------------------------------ */

export interface EuWetgevingTekst {
  artikelen: EuEenheid[];
  overwegingen: EuEenheid[];
}

const ARTIKEL_HEAD_RE = /^(?:artikel|article|artikkel|art\.)\s+(\d{1,3}\s*[a-z]?(?:\s+(?:bis|ter|quater|quinquies))?)\s*$/i;
const STRUCTURE_RE = /^(?:hoofdstuk|titel|afdeling|deel|bijlage|gedaan\s+te|chapter|title|section|annex|done\s+at)\b/i;
const RECITAL_RE = /^\((\d{1,3})\)\s+(\S[\s\S]*)$/;

export function analyseWetgeving(lines: string[]): EuWetgevingTekst {
  const artikelen: EuEenheid[] = [];
  const seen = new Set<string>();
  let firstArticle = -1;
  let cur: EuEenheid | null = null;
  let expectTitle = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = ARTIKEL_HEAD_RE.exec(line);
    if (head) {
      const nr = head[1].replace(/\s+/g, " ").toLowerCase();
      if (seen.has(nr)) { cur = null; continue; }
      seen.add(nr);
      if (firstArticle < 0) firstArticle = i;
      cur = { id: `artikel ${nr}`, tekst: "" };
      artikelen.push(cur);
      expectTitle = true;
      continue;
    }
    if (!cur) continue;
    if (STRUCTURE_RE.test(line)) { cur = null; continue; }
    if (expectTitle) {
      expectTitle = false;
      if (line.length <= 150 && !/^[\d(]/.test(line) && !/[.;:]$/.test(line)) { cur.titel = line; continue; }
    }
    cur.tekst += cur.tekst ? `\n${line}` : line;
  }
  const overwegingen: EuEenheid[] = [];
  const upto = firstArticle < 0 ? lines.length : firstArticle;
  for (let i = 0; i < upto; i++) {
    const m = RECITAL_RE.exec(lines[i]);
    if (m && Number(m[1]) === overwegingen.length + 1) overwegingen.push({ id: `overweging ${m[1]}`, tekst: m[2] });
    else if (overwegingen.length && !RECITAL_RE.test(lines[i]) && i < upto && lines[i].length > 90) {
      overwegingen[overwegingen.length - 1].tekst += `\n${lines[i]}`;
    }
  }
  return { artikelen, overwegingen };
}

/* ------------------------------------------------------------------ */
/* Section, search and citation                                        */
/* ------------------------------------------------------------------ */

export type EuSectie =
  | { soort: "dictum" }
  | { soort: "randnummers"; van: number; tot: number }
  | { soort: "artikel"; nr: string }
  | { soort: "overweging"; nr: number };

/** "39", "punt 39", "r.o. 39", "rn. 39-44", "dictum", "artikel 3", "art. 6 bis", "overweging 12". */
export function parseEuSectie(input: string): EuSectie | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  if (/^(?:dictum|beslissing|operative part|conclusie|voorstel)$/.test(s)) return { soort: "dictum" };
  const art = /^(?:artikel|art\.?|article)\s*(\d{1,3}(?:\s+(?:bis|ter|quater|quinquies)\b|\s?[a-z]\b)?)/.exec(s);
  if (art) return { soort: "artikel", nr: art[1].replace(/\s+/g, " ") };
  const ov = /^(?:overweging|considerans|recital|ov\.?)\s*\(?(\d{1,3})\)?$/.exec(s);
  if (ov) return { soort: "overweging", nr: Number(ov[1]) };
  const rn = /^(?:(?:punt(?:en)?|r\.?\s?o\.?|rov\.?|rn\.?|randnummers?|paragraa?f|par\.?|point|paragraph)\s*)?(\d{1,3})(?:\s*(?:-|–|t\/m|tot en met)\s*(\d{1,3}))?$/.exec(s);
  if (rn) {
    const van = Number(rn[1]);
    const tot = rn[2] ? Number(rn[2]) : van;
    return tot >= van && tot - van <= 50 ? { soort: "randnummers", van, tot } : null;
  }
  return null;
}

/** Lower case, accents, quotes and punctuation removed: for search and citation checks. */
export function foldText(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(\*?\d*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface EuTreffer {
  id: string;
  tekst: string;
  ingekort: boolean;
}

/** Units holding every word of the search term (case and accents ignored). */
export function searchUnits(units: EuEenheid[], zoekterm: string, maxChars: number): { treffers: EuTreffer[]; totaal: number } {
  const words = foldText(zoekterm).split(" ").filter(Boolean);
  if (!words.length) return { treffers: [], totaal: 0 };
  const hits = units.filter((u) => { const t = foldText(u.tekst); return words.every((w) => t.includes(w)); });
  const treffers: EuTreffer[] = [];
  let used = 0;
  for (const u of hits) {
    if (used >= maxChars) break;
    const room = Math.max(300, maxChars - used);
    const ingekort = u.tekst.length > room;
    const tekst = ingekort ? `${u.tekst.slice(0, room)}…` : u.tekst;
    used += tekst.length;
    treffers.push({ id: u.id, tekst, ingekort });
  }
  return { treffers, totaal: hits.length };
}

export interface EuCitaatControle {
  gevonden: boolean;
  /** Where the quote starts (randnummer, "dictum", "artikel 3"), when found. */
  vindplaats?: string;
  /** When not found: the unit sharing most words with the quote, and how many. */
  dichtstbij?: { id: string; dekking: number; fragment: string };
}

/**
 * Whether a quoted sentence occurs in the text. Quotes, punctuation, case and
 * accents are ignored, nothing else: a changed or missing word means not found.
 */
export function checkCitaat(units: EuEenheid[], citaat: string): EuCitaatControle {
  const q = foldText(citaat);
  if (!q) return { gevonden: false };
  const folded = units.map((u) => ({ u, t: foldText(u.tekst) }));
  const whole = folded.map((f) => f.t).join(" ");
  if (whole.includes(q)) {
    const head = q.split(" ").slice(0, 6).join(" ");
    const at = folded.find((f) => f.t.includes(q)) ?? folded.find((f) => f.t.includes(head));
    return { gevonden: true, ...(at ? { vindplaats: at.u.id } : {}) };
  }
  const words = [...new Set(q.split(" ").filter((w) => w.length >= 3))];
  let best: { id: string; dekking: number; fragment: string } | undefined;
  for (const f of folded) {
    if (!words.length) break;
    const share = words.filter((w) => f.t.includes(w)).length / words.length;
    if (!best || share > best.dekking) best = { id: f.u.id, dekking: Math.round(share * 100) / 100, fragment: f.u.tekst.slice(0, 400) };
  }
  return { gevonden: false, ...(best && best.dekking >= 0.5 ? { dichtstbij: best } : {}) };
}

/** "1–46" style summary of the randnummers, or undefined. */
export function randnummerBereik(units: EuEenheid[]): string | undefined {
  return units.length ? `${units[0].id}–${units[units.length - 1].id}` : undefined;
}

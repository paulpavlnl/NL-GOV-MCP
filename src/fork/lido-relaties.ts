/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. All LiDO relations of any kind
 * of government document, through LiDO's services: rulings (NL and EU), laws,
 * AMvB's, ministerial regulations, policy rules, local regulations (CVDR),
 * treaties, Staatsblad/Staatscourant and EU legislation. get-links returns the
 * linked documents per 100 with direction, and facets per document type,
 * issuing body and year; it filters on each of them.
 */
import { XMLParser } from "fast-xml-parser";
import { getText } from "../utils/http.js";

export const LIDO_SERVICE = "https://linkeddata.overheid.nl/service";
const PORTAL_LIST = "https://linkeddata.overheid.nl/front/portal/spiegel-lijstweergave";
/** LiDO silently falls back to 20 rows above 100. */
export const LIDO_PAGE_ROWS = 100;
const TIMEOUT_MS = 15_000;

type Node = Record<string, unknown>;
const parser = new XMLParser({ htmlEntities: true, ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", removeNSPrefix: true, parseTagValue: false, trimValues: true });
const arr = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | null => {
  const x = arr(v)[0];
  if (x === undefined || x === null) return null;
  if (typeof x === "object") { const t = (x as Node)["#text"]; return t != null ? String(t) : null; }
  return String(x);
};
const attr = (n: unknown, name: string): string | undefined => (n && typeof n === "object" ? ((n as Node)[`@_${name}`] as string | undefined) : undefined);
const SAFE_FILTER = /^[\p{L}\p{N} '’.,()&-]{1,120}$/u;

export type LidoLookup = { id: string } | { "ext-id": string } | { "juriconnect-ref": string };

/** How LiDO knows an identifier; empty when it is none LiDO knows (an article goes via the toestand). */
export function lidoLookups(identifier: string): LidoLookup[] {
  const id = String(identifier ?? "").trim();
  const up = id.toUpperCase();
  if (/^https?:\/\/linkeddata\.overheid\.nl\/terms\//i.test(id)) return [{ id: id.replace(/^https:/i, "http:") }];
  if (/^ECLI:[A-Z]{2}:[A-Z0-9]{1,7}:\d{4}:[A-Z0-9.]{1,25}$/.test(up)) return [{ "ext-id": up }];
  const celex = up.match(/^(?:CELEX:)?([1-9]\d{4}[A-Z]{1,2}\d{1,6}(?:\(\d{1,3}\))?)$/);
  if (celex) return [{ "ext-id": `CELEX:${celex[1]}` }];
  const oep = id.match(/^(?:OEP:)?((?:stb|stcrt|trb|kst|blg|ah|h|gmb|prb|wsb|bgr)-[0-9a-z]+(?:-[0-9a-z]+){1,4})$/i);
  if (oep) return [{ "ext-id": `OEP:${oep[1].toLowerCase()}` }];
  const cvdr = up.match(/^CVDR(\d{5,8})(?:_(\d+))?$/);
  if (cvdr) {
    // LiDO's spelling for CVDR is undocumented: the variants are tried in order.
    const variants = [`CVDR${cvdr[1]}${cvdr[2] ? `_${cvdr[2]}` : ""}`, `CVDR:CVDR${cvdr[1]}`, `CVDR${cvdr[1]}`, `CVDR:${cvdr[1]}`];
    return [...new Set(variants)].map((v) => ({ "ext-id": v }));
  }
  if (/^BWB[RV]\d{7}$/.test(up)) return [{ "juriconnect-ref": up }];
  return [];
}

function serviceUrl(service: string, params: Record<string, string | string[]>): string {
  const u = new URL(`${LIDO_SERVICE}/${service}`);
  for (const [k, v] of Object.entries(params)) for (const one of arr(v)) u.searchParams.append(k, String(one));
  return u.toString();
}

export function portalUrl(lookup: LidoLookup): string {
  const u = new URL(PORTAL_LIST);
  if ("id" in lookup) u.searchParams.set("id", lookup.id);
  else if ("ext-id" in lookup) u.searchParams.set("ext-id", lookup["ext-id"]);
  return u.toString();
}

export function linkFilters(f: { type?: string; instantie?: string; jaar?: string }): string[] {
  const fq: string[] = [];
  for (const [tag, v] of [["obj_type", f.type], ["obj_organisatie", f.instantie], ["obj_jaar", f.jaar]] as const) {
    if (v === undefined || v === null || v === "") continue;
    const s = String(v).trim();
    if (!SAFE_FILTER.test(s) || s.includes('"')) throw new Error(`Ongeldige filterwaarde voor ${tag}: ${s.slice(0, 60)}`);
    fq.push(`{!tag=${tag}}${tag}:"${s}"`);
  }
  return fq;
}

export interface LidoTelling { lidoId: string | null; totaal: number; perType: Array<{ type: string; aantal: number }> }

export function parseTelling(xml: string): LidoTelling {
  const root = ((parser.parse(String(xml ?? "")) as Node).lido ?? {}) as Node;
  const id = String(root["@_id"] ?? "").trim();
  const perType = arr(root.aantal)
    .map((a) => ({ type: String(attr(a, "informatietype-label") ?? "").trim(), aantal: Number(text(a) ?? NaN) }))
    .filter((t) => t.type && Number.isFinite(t.aantal))
    .sort((a, b) => b.aantal - a.aantal);
  return { lidoId: id || null, totaal: perType.reduce((n, t) => n + t.aantal, 0), perType };
}

export function parseGetId(xml: string): string | null {
  const root = ((parser.parse(String(xml ?? "")) as Node).lido ?? {}) as Node;
  return text(root.id)?.trim() || null;
}

export interface LidoDocument {
  lidoId: string;
  id: string | null;
  titel: string | null;
  type: string | null;
  instantie: string | null;
  gewijzigd: string | null;
  url: string | null;
  richting: "inkomend" | "uitgaand" | "beide" | null;
  labels: string[];
}
export interface Facet { naam: string; aantal: number }

/** CELLAR titles reach LiDO with '#' between their parts ("Arrest …#Celtec Ltd tegen …#Verzoek om …"). */
export function schoneTitel(t: string | null | undefined): string | null {
  const v = t?.replace(/\s*#+\s*/g, " — ").replace(/^ — | — $/g, "").trim();
  return v || null;
}

function facet(root: Node, name: string): Facet[] | null {
  const f = arr((root.facetten as Node | undefined)?.facet).find((x) => attr(x, "name") === name);
  return f ? arr((f as Node).int).map((i) => ({ naam: String(attr(i, "name") ?? ""), aantal: Number(text(i) ?? 0) })).filter((x) => x.naam).sort((a, b) => b.aantal - a.aantal) : null;
}

export function parseLinks(xml: string) {
  const root = ((parser.parse(String(xml ?? "")) as Node).lido ?? {}) as Node;
  const subjects = arr(root.subject) as Node[];
  const selfId = String(root["@_lido-id"] ?? "") || null;
  const self = subjects.find((s) => s["@_id"] === selfId) ?? subjects[0];
  if (!self) return null;
  const sid = String(self["@_id"]);
  const refs = (c: unknown) => arr((c as Node | undefined)?.["subject-ref"]).map((r) => [attr(r, "idref"), attr(r, "label")] as const).filter(([i]) => i);
  const add = (m: Map<string, Set<string>>, i: string, l?: string) => m.set(i, new Set([...(m.get(i) ?? []), ...(l ? [l] : [])]));
  const inc = new Map<string, Set<string>>(), out = new Map<string, Set<string>>();
  for (const [i, l] of refs(self["inkomende-links"])) add(inc, i!, l);
  for (const [i, l] of refs(self["uitgaande-links"])) add(out, i!, l);
  const seen = new Set<string>();
  const items: LidoDocument[] = [];
  for (const s of subjects) {
    const id = String(s["@_id"] ?? "");
    if (!id || id === sid || seen.has(id)) continue;
    seen.add(id);
    let i = inc.get(id), o = out.get(id);
    if (!i && !o) {
      // Mirrored: the relation is recorded with the linked document.
      const mo = refs(s["uitgaande-links"]).filter(([x]) => x === sid), mi = refs(s["inkomende-links"]).filter(([x]) => x === sid);
      if (mo.length) i = new Set(mo.map(([, l]) => l).filter((l): l is string => Boolean(l)));
      if (mi.length) o = new Set(mi.map(([, l]) => l).filter((l): l is string => Boolean(l)));
    }
    const ext = arr(s.identifier).find((n) => attr(n, "type") === "extern");
    items.push({
      lidoId: id,
      id: text(ext),
      titel: schoneTitel(text(s.title)),
      type: text(s.type),
      instantie: text(s.creator) ?? text(s.authority),
      gewijzigd: text(s.modified)?.slice(0, 10) ?? null,
      url: text(s.hasVersion),
      richting: i && o ? "beide" : i ? "inkomend" : o ? "uitgaand" : null,
      labels: [...new Set([...(i ?? []), ...(o ?? [])])],
    });
  }
  const perType = facet(root, "obj_type");
  return {
    lidoId: sid,
    titel: schoneTitel(text(self.title)),
    totaal: perType ? perType.reduce((n, t) => n + t.aantal, 0) : null,
    paginaRegels: subjects.length - 1,
    perType: perType ?? [],
    perInstantie: facet(root, "obj_organisatie") ?? [],
    perJaar: facet(root, "obj_jaar") ?? [],
    items,
  };
}

/**
 * A Juriconnect reference (standaarden.overheid.nl/juriconnect): "jci1.3:c:BWBR0005537&hoofdstuk=3&artikel=3:4",
 * "jci1.31:c:BWBR0005289&boek=6&titeldeel=3&artikel=162&z=2024-01-01&g=2024-01-01". Returns the BWB id and the
 * article as the tools take it ("6:162" when the book is a separate parameter and the article has no colon).
 */
export function parseJci(ref: string): { bwb: string; artikel?: string; geldigOp?: string } | null {
  const m = /^\s*jci\d+(?:\.\d+)*:[cv]:(BWB[RV]\d{7})((?:&[a-z]+=[^&\s]*)*)\s*$/i.exec(ref);
  if (!m) return null;
  const p = new URLSearchParams(m[2].replace(/^&/, ""));
  const art = p.get("artikel")?.trim();
  const boek = p.get("boek")?.trim();
  const artikel = art ? (boek && !art.includes(":") ? `${boek}:${art}` : art) : undefined;
  const geldigOp = p.get("g") ?? p.get("z") ?? undefined;
  return { bwb: m[1].toUpperCase(), ...(artikel ? { artikel } : {}), ...(geldigOp ? { geldigOp } : {}) };
}

/** Decentrale regelgeving staat niet in LiDO (geen relaties, ook niet met art. 149 Gemeentewet). */
export const CVDR_NOTE = "LiDO bevat geen decentrale regelgeving (CVDR): ook de grondslagartikelen ervan (art. 149 Gemeentewet) hebben geen relaties met CVDR-regelingen. Zoek lokale regelingen met cvdr_search.";

export interface LidoRelatiesResult {
  bekend: boolean;
  opmerking?: string;
  geprobeerd?: string[];
  lidoId?: string;
  titel?: string | null;
  portalUrl?: string;
  endpoint: string;
  totaal?: number;
  perType?: Array<{ type: string; aantal: number }>;
  filter?: Record<string, string>;
  totaalMetFilter?: number | null;
  perInstantie?: Facet[];
  perJaar?: Facet[];
  volledig?: boolean | null;
  items: LidoDocument[];
  /** Without a type filter: the newest case law separately, so it is not buried under laws and regulations. */
  rechtspraak?: LidoDocument[];
}

const fetchXml = async (url: string) => (await getText(url, { connector: "lido", timeoutMs: TIMEOUT_MS, retries: 1, headers: { Accept: "application/xml,text/xml" } })).data;

/** All relations of a document: LiDO object, counts, then get-links per 100 up to `max`. */
export async function lidoRelaties(
  identifier: string,
  opts: { type?: string; instantie?: string; jaar?: string; max?: number; lidoObject?: string | null } = {},
  fetchText: (url: string) => Promise<string> = fetchXml,
): Promise<LidoRelatiesResult> {
  const max = Math.max(1, Math.min(opts.max ?? 100, 500));
  let lookups: LidoLookup[] = opts.lidoObject ? [{ id: opts.lidoObject }] : lidoLookups(identifier);
  if (!lookups.length) return { bekend: false, endpoint: LIDO_SERVICE, items: [], opmerking: "Geen identificatie die LiDO kent: geef een ECLI, BWBR (met wet/artikel voor een artikel), CVDR, CELEX of stb-/stcrt-publicatie." };
  const first = lookups[0];
  if ("juriconnect-ref" in first) {
    const url = serviceUrl("get-id", first);
    const found = parseGetId(await fetchText(url));
    if (!found) return { bekend: false, endpoint: url, items: [], opmerking: `LiDO kent ${identifier} niet.` };
    lookups = [{ id: found }];
  }
  let lookup: LidoLookup | null = null;
  let telling: LidoTelling | null = null;
  let endpoint = LIDO_SERVICE;
  for (const l of lookups) {
    endpoint = serviceUrl("get-aantal-per-informatietype", l as Record<string, string>);
    const t = parseTelling(await fetchText(endpoint));
    if (t.lidoId) { lookup = l; telling = t; break; }
  }
  if (!lookup || !telling) {
    const cvdr = /^CVDR/i.test(identifier.trim());
    return { bekend: false, endpoint, items: [], geprobeerd: lookups.map((l) => ("ext-id" in l ? l["ext-id"] : "id" in l ? l.id : l["juriconnect-ref"])), opmerking: cvdr ? CVDR_NOTE : `LiDO kent ${identifier} niet (geen LiDO-object).` };
  }

  const fq = linkFilters(opts);
  const items: LidoDocument[] = [];
  const seen = new Set<string>();
  let firstPage: ReturnType<typeof parseLinks> = null;
  for (let start = 0, pages = 0; pages < Math.ceil(max / LIDO_PAGE_ROWS) + 1 && items.length < max; start += LIDO_PAGE_ROWS, pages++) {
    const url = serviceUrl("get-links", { ...(lookup as Record<string, string>), output: "xml", start: String(start), rows: String(LIDO_PAGE_ROWS), ...(fq.length ? { fq } : {}) });
    const page = parseLinks(await fetchText(url));
    if (!page) break;
    if (!firstPage) { firstPage = page; endpoint = url; }
    for (const it of page.items) if (!seen.has(it.lidoId) && items.length < max) { seen.add(it.lidoId); items.push(it); }
    if (page.paginaRegels < LIDO_PAGE_ROWS) break;
  }
  // Facets count without their own filter ({!tag=…}) but with the other filters: the facet of any
  // one active filter gives the total for the combination. A name missing from a long (cut) facet stays unknown.
  const from = (list: Array<{ naam: string; aantal: number }> | undefined, name: string) => {
    const hit = list?.find((x) => x.naam === name);
    return hit ? hit.aantal : list && list.length >= 100 ? null : 0;
  };
  const totaalMetFilter = !fq.length ? (firstPage?.totaal ?? null)
    : opts.jaar ? from(firstPage?.perJaar, String(opts.jaar))
    : opts.instantie ? from(firstPage?.perInstantie, opts.instantie)
    : from(firstPage?.perType, opts.type!);
  let rechtspraak: LidoDocument[] | undefined;
  const nJur = telling.perType.find((t) => t.type === "Jurisprudentie")?.aantal ?? 0;
  if (!fq.length && nJur && items.filter((i) => i.type === "Jurisprudentie").length < Math.min(nJur, 25)) {
    const url = serviceUrl("get-links", { ...(lookup as Record<string, string>), output: "xml", start: "0", rows: "25", fq: linkFilters({ type: "Jurisprudentie" }) });
    rechtspraak = parseLinks(await fetchText(url))?.items.filter((i) => i.type === "Jurisprudentie").slice(0, 25);
  }
  return {
    bekend: true,
    lidoId: telling.lidoId!,
    titel: firstPage?.titel ?? null,
    portalUrl: portalUrl(lookup),
    endpoint,
    totaal: telling.totaal,
    perType: telling.perType,
    ...(fq.length ? { filter: Object.fromEntries(Object.entries({ type: opts.type, instantie: opts.instantie, jaar: opts.jaar }).filter(([, v]) => v)) as Record<string, string>, totaalMetFilter } : {}),
    perInstantie: firstPage?.perInstantie ?? [],
    perJaar: firstPage?.perJaar ?? [],
    volledig: totaalMetFilter !== null ? items.length >= totaalMetFilter : null,
    items,
    ...(rechtspraak ? { rechtspraak } : {}),
  };
}

/** Documents grouped per document type, the shape the tool returns. The separately fetched newest case law goes first in Jurisprudentie, without duplicates. */
export function groepeerPerType(items: LidoDocument[], rechtspraak: LidoDocument[] = []): Record<string, Array<Omit<LidoDocument, "lidoId" | "type" | "gewijzigd">>> {
  const out: Record<string, Array<Omit<LidoDocument, "lidoId" | "type" | "gewijzigd">>> = {};
  const seen = new Set<string>();
  for (const { lidoId, type, gewijzigd: _g, ...rest } of [...rechtspraak, ...items]) {
    if (seen.has(lidoId)) continue;
    seen.add(lidoId);
    (out[type ?? "Onbekend"] ??= []).push(rest);
  }
  return out;
}

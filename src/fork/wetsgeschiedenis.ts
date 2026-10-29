/**
 * FORK MODULE (paulpavlnl) — see docs/FORK.md. wetsgeschiedenis_get: the legislative history of one article.
 * 1. The article in the BWB (wet + artikel, or BWB-id): its label-id, text and current version.
 * 2. The BWB's wetstechnische informatie (WTI, repository.officiele-overheidspublicaties.nl/bwb/{id}/{id}.WTI):
 *    for every version of that article the change (nieuw, wijziging), the date it entered into force, the
 *    Kamerstukken dossier and the Staatsblad. At the level of the whole law also the bills still pending
 *    ("Aanhangig").
 * 3. Per dossier the parliamentary papers from the KOOP SRU (officielepublicaties, w.dossiernummer), sorted
 *    by kind: memorie van toelichting, advies Raad van State and nader rapport, nota naar aanleiding van het
 *    verslag, nota's van wijziging, memorie van antwoord (Eerste Kamer) …
 * 4. In the main papers the passages about the article (or a search term), with the citation
 *    (Kamerstukken II 1996/97, 25 263, nr. 3, p. …) and a link.
 * Papers from before 1995 are not in the KOOP repository (Staten-Generaal Digitaal); the tool says so.
 * Registered from registerEuForkTools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, MCPRecord } from "../types.js";
import { getText } from "../utils/http.js";
import { errorResponse, mapSourceError, nowIso, successResponse, toMcpToolPayload } from "../utils/response.js";
import { BwbArtikelSource } from "../sources/bwb-artikel.js";
import { WettenBwbSource } from "../sources/wetten-bwb.js";
import { decodeEntities, htmlNaarTekst } from "./juridische-bronnen.js";

export const WTI_URL = (bwbId: string) => `https://repository.officiele-overheidspublicaties.nl/bwb/${bwbId}/${bwbId}.WTI`;
const KOOP_SRU = "https://repository.overheid.nl/sru";
const SGD = "https://www.statengeneraaldigitaal.nl";

export interface Wijziging { datum: string; betreft: string; dossiers: string[]; staatsblad: string[]; ondertekening?: string }

const tags = (xml: string, naam: string) => [...xml.matchAll(new RegExp(`<${naam}>([^<]+)</${naam}>`, "g"))].map((m) => m[1].trim());

/** The changes to one article (label-id) and the bills pending for the whole law, from the WTI. */
export function parseWti(xml: string, labelId: string): { wijzigingen: Wijziging[]; aanhangig: string[] } {
  const start = xml.indexOf("<wijzigingen");
  const deel = start >= 0 ? xml.slice(start) : xml;
  const wijzigingen: Wijziging[] = [];
  const re = new RegExp(`<regelingelement label-id="${labelId}"[^>]*>([\\s\\S]*?)</regelingelement>`, "g");
  for (const blok of deel.matchAll(re)) {
    for (const d of blok[1].matchAll(/<datum waarde="([^"]+)"[^>]*>([\s\S]*?)<\/datum>/g)) {
      const ontstaan = /<ontstaansbron>([\s\S]*?)<\/ontstaansbron>/.exec(d[2])?.[1] ?? "";
      wijzigingen.push({
        datum: d[1], betreft: /<betreft>([^<]+)<\/betreft>/.exec(d[2])?.[1]?.trim() ?? "",
        dossiers: [...new Set(tags(ontstaan, "dossiernummer"))],
        staatsblad: [...new Set([...ontstaan.matchAll(/urlidentifier="([^"]+)"/g)].map((m) => m[1]))],
        ondertekening: tags(ontstaan, "ondertekening")[0],
      });
    }
  }
  wijzigingen.sort((a, b) => b.datum.localeCompare(a.datum));
  // Pending bills sit at the level of the whole regulation (<regeling>), before the elements.
  const regeling = /<regeling>([\s\S]*?)(?:<regelingelement|<\/regeling>)/.exec(deel)?.[1] ?? "";
  const aanhangig = [...regeling.matchAll(/<details>\s*<betreft>Aanhangig<\/betreft>([\s\S]*?)<\/details>/g)].flatMap((m) => tags(m[1], "dossiernummer"));
  return { wijzigingen, aanhangig: [...new Set(aanhangig)] };
}

/** The kind of a parliamentary paper, from the part of its title after the dossier title. */
export function kamerstukSoort(titel: string): string {
  const t = titel.toLowerCase();
  const regels: Array<[RegExp, string]> = [
    [/memorie van toelichting/, "memorie van toelichting"], [/nader rapport/, "advies Raad van State en nader rapport"], [/advies (?:van de )?raad van state|advies afdeling advisering/, "advies Raad van State en nader rapport"],
    [/nota naar aanleiding van het (?:nader )?verslag/, "nota naar aanleiding van het verslag"], [/memorie van antwoord/, "memorie van antwoord"],
    [/nota van wijziging/, "nota van wijziging"], [/voorstel van wet|gewijzigd voorstel/, "voorstel van wet"], [/amendement/, "amendement"],
    [/(?:voorlopig |nader )?verslag/, "verslag"], [/motie/, "motie"], [/koninklijke boodschap/, "koninklijke boodschap"], [/brief/, "brief"],
  ];
  return regels.find(([re]) => re.test(t))?.[1] ?? "overig";
}
/** Kinds whose text explains the article; read in this order. */
export const KERNSTUKKEN = ["memorie van toelichting", "advies Raad van State en nader rapport", "nota naar aanleiding van het verslag", "nota van wijziging", "memorie van antwoord"];

export interface Kamerstuk { id: string; nummer: string; soort: string; titel: string; datum?: string; vergaderjaar?: string; kamer: "I" | "II"; dossiertitel?: string; html?: string; url: string }

export function parseKamerstukken(sru: string): Kamerstuk[] {
  return [...sru.matchAll(/<sru:record>([\s\S]*?)<\/sru:record>/g)].map((m): Kamerstuk => {
    const r = m[1];
    const v = (re: RegExp) => decodeEntities(re.exec(r)?.[1]?.trim() ?? "") || undefined;
    const id = v(/<dcterms:identifier>([^<]+)</) ?? "";
    const titel = v(/<dcterms:title>([^<]+)</) ?? "";
    return {
      id, nummer: v(/<overheidwetgeving:ondernummer[^>]*>([^<]+)</) ?? id.split("-").pop() ?? "",
      soort: kamerstukSoort(titel.includes(";") ? titel.slice(titel.indexOf(";") + 1) : titel), titel,
      datum: v(/<dcterms:available>([^<]+)</), vergaderjaar: v(/<overheidwetgeving:vergaderjaar>([^<]+)</),
      kamer: /Eerste Kamer/i.test(v(/<dcterms:creator[^>]*>([^<]+)</) ?? "") ? "I" : "II",
      dossiertitel: v(/<overheidwetgeving:dossiertitel>([^<]+)</),
      html: v(/<gzd:itemUrl manifestation="html">([^<]+)</),
      url: v(/<gzd:preferredUrl>([^<]+)</) ?? `https://zoek.officielebekendmakingen.nl/${id}.html`,
    };
  }).filter((k) => k.id);
}

/** "Kamerstukken II 1996/97, 25 263, nr. 3" */
export function vindplaats(k: Pick<Kamerstuk, "kamer" | "vergaderjaar" | "nummer">, dossier: string): string {
  const jaar = k.vergaderjaar?.replace(/^(\d{4})-\d{2}(\d{2})$/, "$1/$2");
  const dos = dossier.replace(/^(\d{2,3})(\d{3})$/, "$1 $2");
  return `Kamerstukken ${k.kamer}${jaar ? ` ${jaar}` : ""}, ${dos}, nr. ${k.nummer}`;
}

/** How an article is written in parliamentary papers: "artikel 658", "7:658", "art. 3:4", "artikel 55a". */
export function artikelPatroon(artikel: string): RegExp {
  const a = artikel.trim().replace(/^(?:artikel|art\.?)\s*/i, "").toLowerCase();
  const [boek, nr] = a.includes(":") ? a.split(":") : [undefined, a];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const n = `${esc(nr)}(?![\\da-z])`;
  return new RegExp(`${boek ? `\\b${esc(boek)}:${n}|` : ""}\\bart(?:ikel(?:en)?|\\.)\\s+(?:${boek ? `${esc(boek)}:` : ""})?${n}`, "i");
}

/**
 * Terms the legislature uses for the same thing: a search for one finds the others. The Kamerstukken of
 * Boek 10 BW, for instance, speak of the "exceptieclausule" where literature says "uitzonderingsclausule".
 */
const SYNONIEMEN: ReadonlyArray<ReadonlyArray<string>> = [
  ["uitzonderingsclausule", "exceptieclausule", "ontsnappingsclausule", "correctieclausule"],
  ["redelijkheid en billijkheid", "goede trouw"],
  ["openbare orde", "ordre public"],
  ["voorrangsregel", "voorrangsregels", "dwingende bepalingen"],
];

/** The term, its synonyms, and the words of each allowed to run over a line or spaces; case ignored. */
export function zoektermPatroon(zoekterm: string): { re: RegExp; termen: string[] } {
  const term = zoekterm.trim().toLowerCase();
  const groep = SYNONIEMEN.find((g) => g.includes(term));
  const termen = groep ? [term, ...groep.filter((t) => t !== term)] : [term];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return { re: new RegExp(termen.map(esc).join("|"), "i"), termen };
}

/** Passages that mention the article (or the term): the paragraph, with the heading above it when short. */
export function passagesMet(tekst: string, re: RegExp, max = 4, lengte = 1400): string[] {
  const regels = tekst.split("\n").map((l) => l.trim()).filter(Boolean);
  const uit: string[] = []; let tot = -1;
  regels.forEach((l, i) => {
    if (uit.length >= max || i <= tot || !re.test(l)) return;
    const kop = i > 0 && regels[i - 1].length < 90 && !/[.;:]$/.test(regels[i - 1]) ? `${regels[i - 1]}\n` : "";
    let s = l, j = i;
    while (s.length < lengte && j + 1 < regels.length && !/^(?:artikel|§|\d+(?:\.\d+)*\s)/i.test(regels[j + 1])) s += `\n${regels[++j]}`;
    tot = j;
    uit.push(`${kop}${s.length > lengte ? `${s.slice(0, lengte)}…` : s}`);
  });
  return uit;
}

/** The page number before a passage, from the "[p. 12]" markers htmlNaarTekst keeps (if any). */
const PAGINA = /(?:^|\n)\s*(?:\[?(?:p\.|pagina)\s*(\d{1,4})\]?)\s*(?:\n|$)/gi;
function paginaVoor(tekst: string, passage: string): string | undefined {
  const i = tekst.indexOf(passage.split("\n").find((l) => l.length > 30) ?? passage.slice(0, 60));
  if (i < 0) return undefined;
  let p: string | undefined;
  for (const m of tekst.slice(0, i).matchAll(PAGINA)) p = m[1];
  return p;
}

/**
 * Which acts to read. "invoering" (default): the act that introduced the article, then the newest amendments.
 * "nieuwste": only the newest amendments, for a part added later (BW 7:631 lid 8: 2018, not 23 438 of 1996/97).
 */
export function kiesDossiers(wijzigingen: Wijziging[], max: number, volgorde: "invoering" | "nieuwste" = "invoering"): string[] {
  const nieuwsteEerst = [...wijzigingen].sort((a, b) => b.datum.localeCompare(a.datum)).flatMap((w) => w.dossiers);
  const nieuw = volgorde === "invoering" ? wijzigingen.filter((w) => w.betreft === "nieuw").flatMap((w) => w.dossiers).slice(-1) : [];
  return [...new Set([...nieuw, ...nieuwsteEerst])].slice(0, max);
}

const rec = (title: string, url: string, date: string | undefined, data: Record<string, unknown>): MCPRecord => ({ source_name: "officielebekendmakingen.nl", title, canonical_url: url, ...(date ? { date } : {}), data });
const NOTE = "Wetsgeschiedenis uit de BWB (wetstechnische informatie: welke wet het artikel invoerde of wijzigde, dossier en Staatsblad) en de Kamerstukken van KOOP. De passages zijn gevonden op het artikelnummer: lees de stukken zelf voordat je citeert, en let erop dat een passage over een eerdere versie van het artikel kan gaan. Citeer als Kamerstukken II jaar/jaar, dossiernummer, nr., p. Wetsgeschiedenis is een uitlegbron, geen recht; de rechter weegt haar naast tekst, systeem en doel.";

export function registerWetsgeschiedenis(server: McpServer, deps: { config: AppConfig; TOOL_ANNOTATIONS: Record<string, unknown> }): void {
  const wettenBwb = new WettenBwbSource(deps.config);
  const bwbArtikel = new BwbArtikelSource(deps.config);

  const kamerstukken = async (dossiers: string[]) => {
    const q = `c.product-area==officielepublicaties and (${dossiers.map((d) => `w.dossiernummer==${d}`).join(" or ")}) and w.publicatienaam==Kamerstuk`;
    const { data } = await getText(KOOP_SRU, { query: { operation: "searchRetrieve", version: "2.0", recordSchema: "gzd", maximumRecords: 1000, query: q }, connector: "officiele_bekendmakingen", timeoutMs: 45_000, maxResponseBytes: 20_000_000 });
    return parseKamerstukken(data);
  };

  server.registerTool("wetsgeschiedenis_get", {
    description:
      "The legislative history of one article: which acts introduced or amended it (date in force, Kamerstukken dossier, Staatsblad, from the BWB's wetstechnische informatie), per dossier the parliamentary papers by kind (memorie van toelichting, advies Raad van State and nader rapport, nota naar aanleiding van het verslag, nota van wijziging, memorie van antwoord) with the passages about the article, the citation (Kamerstukken II 1996/97, 25 263, nr. 3) and links; and the bills still pending that amend the law. " +
      "Give wet ('BW', 'Awb', 'Wet op de ondernemingsraden') and artikel ('7:658', '3:4', '25'), or bwb_id. With zoekterm the passages are about that term instead of the article number. Papers from before 1995 are not digital at KOOP: the tool says so and points to Staten-Generaal Digitaal.",
    inputSchema: {
      wet: z.string().max(200).optional(), bwb_id: z.string().max(20).optional(), artikel: z.string().min(1).max(30),
      zoekterm: z.string().max(200).optional().describe("Search the papers for this term instead of the article number."),
      max_dossiers: z.number().int().min(1).max(10).default(4).describe("How many acts to read: the one that introduced the article, then the newest amendments (see volgorde)."),
      volgorde: z.enum(["invoering", "nieuwste"]).default("invoering").describe("invoering (default): the introducing act first, then the newest amendments. nieuwste: the newest amendments only, for a paragraph (lid) added later; with max_dossiers 1 the latest amending act."),
      passages: z.boolean().default(true).describe("Read the main papers and return the passages (slower)."),
      aanhangig: z.boolean().default(true).describe("Also list the bills still pending for this law."),
    },
    annotations: deps.TOOL_ANNOTATIONS,
  }, async (a) => {
    const label = `${a.wet ?? a.bwb_id ?? ""} artikel ${a.artikel}`.trim();
    try {
      let bwbId = a.bwb_id?.trim().toUpperCase();
      if (!bwbId) {
        if (!a.wet) return toMcpToolPayload(errorResponse({ error: "unexpected", message: "Geef wet of bwb_id.", suggestion: "Bijv. wet 'BW' met artikel '7:658', of bwb_id 'BWBR0005537' met artikel '3:4'." }));
        const r = await wettenBwb.tekst({ wet: a.wet, artikel: a.artikel, max_chars: 300 });
        if (r.kind !== "tekst") return toMcpToolPayload(errorResponse({ error: "unexpected", message: `'${a.wet}' wijst niet eenduidig naar één regeling: ${r.candidates.slice(0, 5).map((c) => `${c.title} [${c.identifier}]`).join("; ")}.`, suggestion: "Geef het BWB-id." }));
        bwbId = r.regeling.identifier;
      }
      const art = await bwbArtikel.getArtikel({ bwbId, artikel: a.artikel });
      if (art.items.length !== 1) return toMcpToolPayload(errorResponse({ error: "unexpected", message: art.items.length ? `Artikel ${a.artikel} komt meer dan eens voor in ${bwbId}.` : `Artikel ${a.artikel} niet gevonden in ${bwbId}.`, suggestion: art.items.length ? "Geef het BWB-id van het juiste boek of deel." : "Controleer het artikelnummer met wetten_bwb_tekst." }));
      const artikel = art.items[0];
      if (!artikel.label_id) return toMcpToolPayload(errorResponse({ error: "unexpected", message: `Geen label-id voor artikel ${a.artikel} in ${bwbId}.`, suggestion: "Lees de wetsgeschiedenis via officiele_bekendmakingen_search." }));

      const { data: wti } = await getText(WTI_URL(bwbId), { connector: "wetten_bwb", timeoutMs: 60_000, maxResponseBytes: 80_000_000 });
      const { wijzigingen, aanhangig } = parseWti(wti, artikel.label_id);
      // The act that introduced the article explains it most; then the newest amendments (or, with volgorde nieuwste, only those).
      const dossiers = kiesDossiers(wijzigingen, a.max_dossiers, a.volgorde);
      const stukken = dossiers.length ? await kamerstukken(dossiers) : [];
      const zoek = a.zoekterm ? zoektermPatroon(a.zoekterm) : undefined;
      const artRe = artikelPatroon(a.artikel);
      const re = zoek?.re ?? artRe;
      let gelukt = 0;
      let mislukt = 0;
      let metTerm = 0;

      const records: MCPRecord[] = [];
      for (const w of wijzigingen.filter((x) => x.dossiers.some((d) => dossiers.includes(d)))) {
        for (const dossier of w.dossiers.filter((d) => dossiers.includes(d))) {
          if (records.some((r) => (r.data as { dossier?: string }).dossier === dossier)) continue;
          const eigen = stukken.filter((k) => k.id.includes(`-${dossier}-`)).sort((x, y) => (x.datum ?? "").localeCompare(y.datum ?? ""));
          const kern = KERNSTUKKEN.flatMap((s) => eigen.filter((k) => k.soort === s));
          const gelezen: Array<Record<string, unknown>> = [];
          if (a.passages) {
            for (const k of kern.slice(0, 6)) {
              try {
                const { data: html } = await getText(k.html ?? k.url, { connector: "officiele_bekendmakingen", timeoutMs: 30_000, maxResponseBytes: 15_000_000 });
                const tekst = decodeEntities(htmlNaarTekst(html));
                gelukt++;
                let p = passagesMet(tekst, re);
                if (p.length && zoek) metTerm++;
                // No passage with the term: the passages about the article itself, marked as such.
                const opArtikel = !p.length && zoek ? passagesMet(tekst, artRe) : [];
                if (opArtikel.length) p = opArtikel;
                gelezen.push({
                  soort: k.soort, vindplaats: vindplaats(k, dossier), datum: k.datum, link: k.url, tekens: tekst.length,
                  passages: p.map((x) => ({ tekst: x, pagina: paginaVoor(tekst, x) })),
                  ...(opArtikel.length ? { gevonden_op: `artikel ${a.artikel} (geen passage met ${zoek!.termen.map((t) => `'${t}'`).join(" of ")})` } : {}),
                  ...(p.length ? {} : { opmerking: `Geen passage met ${zoek ? zoek.termen.map((t) => `'${t}'`).join(" of ") : `artikel ${a.artikel}`} gevonden in dit stuk (${tekst.length} tekens gelezen); het stuk kan het artikel anders noemen (onderdeel van artikel I, of de nummering van het wetsvoorstel).` }),
                });
              } catch (e) { mislukt++; gelezen.push({ soort: k.soort, vindplaats: vindplaats(k, dossier), link: k.url, fout: e instanceof Error ? e.message : String(e) }); }
            }
          }
          const titel = eigen[0]?.dossiertitel ?? `Kamerstukken ${dossier}`;
          records.push(rec(`${titel} (${dossier.replace(/^(\d{2,3})(\d{3})$/, "$1 $2")})`, `https://zoek.officielebekendmakingen.nl/dossier/${dossier}`, w.datum, {
            dossier, betreft: w.betreft, in_werking: w.datum, ondertekening: w.ondertekening,
            staatsblad: w.staatsblad.map((s) => ({ id: s, link: `https://zoek.officielebekendmakingen.nl/${s}.html` })),
            stukken_per_soort: Object.fromEntries([...new Set(eigen.map((k) => k.soort))].map((s) => [s, eigen.filter((k) => k.soort === s).map((k) => ({ vindplaats: vindplaats(k, dossier), datum: k.datum, link: k.url }))])),
            ...(a.passages ? { gelezen } : {}),
            ...(!eigen.length ? { opmerking: `Geen Kamerstukken van dossier ${dossier} in de KOOP-repository (vóór 1995 niet digitaal daar): zoek op ${SGD} met het dossiernummer.` }
              : !eigen.some((k) => k.soort === "memorie van toelichting") ? { opmerking: `De memorie van toelichting van dossier ${dossier} staat niet in de KOOP-repository (stukken van vóór 1995 ontbreken daar): zoek haar op ${SGD} (nr. 3 van het dossier).` } : {}),
          }));
        }
      }
      let pending: Array<Record<string, unknown>> = [];
      if (a.aanhangig && aanhangig.length) {
        const ks = await kamerstukken(aanhangig.slice(0, 12)).catch(() => [] as Kamerstuk[]);
        pending = aanhangig.slice(0, 12).map((d) => { const k = ks.find((x) => x.id.includes(`-${d}-`)); return { dossier: d, titel: k?.dossiertitel, link: `https://zoek.officielebekendmakingen.nl/dossier/${d}` }; });
      }
      // Dossiers whose papers discuss the article first.
      const treffers = (r: MCPRecord) => ((r.data as { gelezen?: Array<{ passages?: unknown[] }> }).gelezen ?? []).reduce((n, g) => n + (g.passages?.length ?? 0), 0);
      records.sort((x, y) => treffers(y) - treffers(x));
      if (pending.length) records.push(rec(`Aanhangige wetsvoorstellen die ${artikel.titel_regeling ?? bwbId} wijzigen`, `https://zoek.officielebekendmakingen.nl/`, undefined, { aanhangig: pending, let_op: "Geldt voor de hele wet, niet per artikel: kijk in het wetsvoorstel of het dit artikel raakt." }));
      // Not one paper could be fetched: that is a failure, not "no passages".
      if (a.passages && mislukt && !gelukt) {
        return toMcpToolPayload(errorResponse({ error: "http_error", message: `Geen van de ${mislukt} Kamerstukken kon worden opgehaald bij zoek.officielebekendmakingen.nl.`, retry_after: 60, suggestion: "Probeer het over een minuut opnieuw; de links naar de stukken staan in de dossiers op zoek.officielebekendmakingen.nl." }));
      }
      const zoekNoot = !a.passages || !zoek ? ""
        : metTerm ? ` Gezocht op ${zoek.termen.map((t) => `'${t}'`).join(" of ")}: ${metTerm} van ${gelukt} stukken bevatten de term.`
        : ` Geen enkel stuk bevat ${zoek.termen.map((t) => `'${t}'`).join(" of ")} (${gelukt} stukken gelezen); getoond zijn de passages over artikel ${a.artikel}. Zoek anders met de woorden van de wetgever zelf.`;
      const foutNoot = mislukt ? ` ${mislukt} stuk(ken) konden niet worden opgehaald (veld fout).` : "";
      return toMcpToolPayload(successResponse({
        summary: `${artikel.titel_regeling ?? bwbId}, artikel ${artikel.artikel}: ${wijzigingen.length} versie(s) in de BWB, ${dossiers.length} wetgevingsdossier(s) gelezen${pending.length ? `; ${pending.length} aanhangig(e) wetsvoorstel(len) voor deze wet` : ""}`,
        records,
        provenance: { tool: "wetsgeschiedenis_get", endpoint: WTI_URL(bwbId), query_params: Object.fromEntries(Object.entries({ wet: a.wet, bwb_id: bwbId, artikel: a.artikel, zoekterm: a.zoekterm, volgorde: a.volgorde }).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), timestamp: nowIso(), returned_results: records.length, total_results: wijzigingen.length },
        access_note: `${NOTE} Artikel: ${artikel.wetten_url}. Versies (nieuwste eerst): ${wijzigingen.map((w) => `${w.datum} ${w.betreft} (${w.dossiers.join(", ") || "geen dossier"}; ${w.staatsblad.join(", ")})`).join(" · ") || "geen"}.${wijzigingen.length > dossiers.length ? ` Meer dossiers: verhoog max_dossiers${a.volgorde === "invoering" ? ", of kies volgorde 'nieuwste' voor een later ingevoegd lid" : ""}.` : ""} Gelezen (volgorde ${a.volgorde}): ${dossiers.join(", ") || "geen"}. De BWB kent alleen de geschiedenis vanaf de opname in de huidige wet: voor een voorloper (bijv. het oude BW) zoek je de wetsgeschiedenis van die bepaling apart.${pending.length ? " De aanhangige wetsvoorstellen staan in het laatste record." : ""}${zoekNoot}${foutNoot}`,
      }));
    } catch (e) { return toMcpToolPayload(mapSourceError(e, `BWB/KOOP (${label})`, "https://wetten.overheid.nl")); }
  });
}

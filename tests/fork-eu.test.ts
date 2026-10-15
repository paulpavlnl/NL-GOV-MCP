/**
 * FORK (docs/FORK.md) — EU case law and legislation: recognition, CELLAR
 * resolution, text parsing and the eurlex_tekst_get tool. Offline: fetch is
 * stubbed. tests/fork-eu.live.test.ts checks the same documents against CELLAR.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import {
  analyseUitspraak,
  analyseWetgeving,
  caseNumberCelexCandidates,
  checkCitaat,
  cleanPdfLines,
  isPlaceholderInfo,
  detectTaal,
  euHtmlToLines,
  parseEuReferences,
  parseEuSectie,
  searchUnits,
} from "../src/fork/eu-tekst.js";
import { EuTekstSource, pickDocument, rankCaseCelex } from "../src/fork/eu-bron.js";
import { euTekstResult } from "../src/fork/eu-tools.js";
import { CELTEC_HTML, ENGLISH_HTML, ISS_HTML, NY_MOLLE_KRO_HTML, RICHTLIJN_2001_23_HTML, VERORDENING_HTML } from "./helpers/eu-fixtures.js";
import { jsonResponse, testConfig } from "./helpers/config.js";

/**
 * The test documents with their identifiers as CELLAR links them (owl:sameAs,
 * checked 2026-10-15). Celtec's ECLI is ECLI:EU:C:2005:321, not :315.
 */
export const EU_TESTDOCUMENTEN = [
  { naam: "Celtec", celex: "62003CJ0478", ecli: "ECLI:EU:C:2005:321", zaak: "C-478/03" },
  { naam: "Ny Mølle Kro", celex: "61986CJ0287", ecli: "ECLI:EU:C:1987:573", zaak: "zaak 287/86" },
  { naam: "Katsikas", celex: "61991CJ0132", ecli: "ECLI:EU:C:1992:517", zaak: "C-132/91" },
  { naam: "ISS Facility Services", celex: "62018CJ0344", ecli: "ECLI:EU:C:2020:239", zaak: "C-344/18" },
  { naam: "Redmond Stichting", celex: "61991CJ0029", ecli: "ECLI:EU:C:1992:220", zaak: "C-29/91" },
] as const;

const XSD = "http://www.w3.org/2001/XMLSchema#";
const lit = (value: string) => ({ type: "literal", datatype: `${XSD}string`, value });
const sparql = (bindings: Array<Record<string, unknown>>) => ({ head: { vars: [] }, results: { bindings } });

beforeEach(() => {
  vi.unstubAllGlobals();
  clearHttpCache();
});

describe("parseEuReferences", () => {
  it("reads ECLIs of the Court and the General Court", () => {
    expect(parseEuReferences("ECLI:EU:C:2005:321").eclis).toEqual(["ECLI:EU:C:2005:321"]);
    expect(parseEuReferences("zie ecli:eu:t:2019:12.").eclis).toEqual(["ECLI:EU:T:2019:12"]);
  });

  it("reads case-law CELEX numbers: judgments, A-G opinions and orders", () => {
    expect(parseEuReferences("62003CJ0478").caseCelex).toEqual(["62003CJ0478"]);
    expect(parseEuReferences("61986CJ0287, 62003CC0478 en 62019CO0123").caseCelex).toEqual(["61986CJ0287", "62003CC0478", "62019CO0123"]);
  });

  it("reads case numbers, also with a non-breaking hyphen and old numbers after 'zaak'", () => {
    const celtec = parseEuReferences("HvJ EG 26 mei 2005, C-478/03 (Celtec)");
    expect(celtec.zaaknummers).toEqual([{ zaaknummer: "C-478/03", court: "C", year: "2003", number: "478" }]);
    expect(caseNumberCelexCandidates(celtec.zaaknummers[0])).toEqual(["62003CJ0478", "62003CO0478", "62003CC0478"]);
    expect(parseEuReferences("Zaak C‑132/91").zaaknummers[0].zaaknummer).toBe("C-132/91");
    const old = parseEuReferences("HvJ EG 17 december 1987, zaak 287/86 (Ny Mølle Kro)");
    expect(old.zaaknummers).toEqual([{ zaaknummer: "287/86", court: "C", year: "1986", number: "287" }]);
    expect(caseNumberCelexCandidates(old.zaaknummers[0])[0]).toBe("61986CJ0287");
    expect(caseNumberCelexCandidates(parseEuReferences("T-12/19").zaaknummers[0])[0]).toBe("62019TJ0012");
    // A bare number pair is no case number (it could be a directive).
    expect(parseEuReferences("287/86").zaaknummers).toEqual([]);
  });

  it("reads EU legislation: CELEX and citations of directives and regulations", () => {
    expect(parseEuReferences("Richtlijn 2001/23/EG").legislationCelex).toEqual(["32001L0023"]);
    expect(parseEuReferences("32001L0023").legislationCelex).toEqual(["32001L0023"]);
    expect(parseEuReferences("CELEX:32016R0679").legislationCelex).toEqual(["32016R0679"]);
    expect(parseEuReferences("Verordening (EU) 2016/679").legislationCelex).toEqual(["32016R0679"]);
    expect(parseEuReferences("Verordening (EG) nr. 883/2004").legislationCelex).toEqual(["32004R0883"]);
    expect(parseEuReferences("Richtlijn 77/187/EEG").legislationCelex).toEqual(["31977L0187"]);
  });

  it("keeps every identifier of a citation, and recognises nothing in a Dutch reference", () => {
    const r = parseEuReferences("HvJ EG 26 mei 2005, C-478/03, ECLI:EU:C:2005:315 (Celtec)");
    expect(r.eclis).toEqual(["ECLI:EU:C:2005:315"]);
    expect(r.zaaknummers.map((z) => z.zaaknummer)).toEqual(["C-478/03"]);
    const nl = parseEuReferences("artikel 7:663 BW");
    expect([nl.eclis, nl.caseCelex, nl.zaaknummers, nl.legislationCelex].flat()).toEqual([]);
  });
});

describe("text parsing", () => {
  it("2000s layout (Celtec): randnummers, headings and dictum; the summary is no run of randnummers", () => {
    const lines = euHtmlToLines(CELTEC_HTML);
    expect(lines).toContain("Zaak C-478/03");
    const u = analyseUitspraak(lines, "arrest");
    expect(u.randnummers.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(u.randnummers[3].tekst).toContain("Artikel 3, lid 1, van richtlijn 77/187 moet aldus worden uitgelegd");
    expect(u.koppen).toContainEqual({ voor_randnummer: "5", kop: "Kosten" });
    expect(u.dictum_kop).toBe("Het Hof van Justitie (Eerste kamer) verklaart voor recht:");
    expect(u.dictum).toMatch(/^1\) Artikel 3, lid 1, van richtlijn 77\/187\/EEG/);
    expect(u.dictum).toContain("2) Voor de toepassing");
    expect(u.dictum).not.toContain("ondertekeningen");
    expect(u.dictum).not.toContain("Procestaal");
  });

  it("1980s layout (Ny Mølle Kro): '*' is a space, the dictum follows 'VERKLAART VOOR RECHT :'", () => {
    const u = analyseUitspraak(euHtmlToLines(NY_MOLLE_KRO_HTML), "arrest");
    expect(u.randnummers.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(u.randnummers[0].tekst).toContain("12 NOVEMBER 1986");
    expect(u.dictum).toMatch(/^1 \) ARTIKEL 1, LID 1, VAN RICHTLIJN 77\/187/);
    expect(u.dictum).toContain("2 ) ARTIKEL 3, LID 2");
  });

  it("XHTML layout (ISS): number and text in table cells, signatures stay out of the dictum", () => {
    const lines = euHtmlToLines(ISS_HTML);
    const u = analyseUitspraak(lines, "arrest");
    expect(u.randnummers.map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(u.randnummers[1].tekst).toMatch(/^Dit verzoek is ingediend/);
    expect(u.dictum).toMatch(/^Bij een overgang van onderneming waarbij verschillende verkrijgers/);
    expect(u.dictum).not.toContain("Vilaras");
    expect(u.dictum).not.toContain("Uitgesproken");
  });

  it("legislation: articles with titles, recitals, structure headings end an article (old and new layout)", () => {
    const old = analyseWetgeving(euHtmlToLines(RICHTLIJN_2001_23_HTML));
    expect(old.artikelen.map((a) => a.id)).toEqual(["artikel 1", "artikel 2", "artikel 3"]);
    expect(old.artikelen[2].tekst).toMatch(/^1\. De rechten en verplichtingen/);
    expect(old.artikelen[1].tekst).not.toContain("HOOFDSTUK");
    expect(old.artikelen[2].tekst).not.toContain("Gedaan te");
    expect(old.overwegingen.map((o) => o.id)).toEqual(["overweging 1", "overweging 2"]);

    const reg = analyseWetgeving(euHtmlToLines(VERORDENING_HTML));
    expect(reg.artikelen.map((a) => [a.id, a.titel])).toEqual([["artikel 1", "Onderwerp en doelstellingen"], ["artikel 3", "Territoriaal toepassingsgebied"]]);
    expect(reg.overwegingen[0]).toEqual({ id: "overweging 1", tekst: "De bescherming van natuurlijke personen bij de verwerking van persoonsgegevens is een grondrecht." });
  });

  it("detects the language", () => {
    expect(detectTaal(euHtmlToLines(CELTEC_HTML).join(" "))).toBe("nl");
    expect(detectTaal(euHtmlToLines(NY_MOLLE_KRO_HTML).join(" "))).toBe("nl");
    expect(detectTaal(euHtmlToLines(ENGLISH_HTML).join(" "))).toBe("en");
    expect(detectTaal("Le présent arrêt est rendu dans le cadre de la procédure qui est pendante devant la juridiction pour la question de la directive et des droits sur le transfert, qui est une question au sujet du droit des travailleurs.")).toBe("fr");
  });
});

describe("clean-up", () => {
  it("drops the Official Journal header, rule and page number from PDF text", () => {
    expect(cleanPdfLines([
      "1. Degenen op wie deze verordening van toepassing is, zijn slechts aan de wetgeving van één",
      "lidstaat onderworpen.",
      "30.4.2004 NL Publicatieblad van de Europese Unie L 166/",
      "_______________________________________________________________________________",
      "23",
      "2. Voor de toepassing van deze titel",
    ])).toEqual(["1. Degenen op wie deze verordening van toepassing is, zijn slechts aan de wetgeving van één", "lidstaat onderworpen.", "2. Voor de toepassing van deze titel"]);
  });

  it("treats CELLAR's 'CELEX1' as no title information", () => {
    expect(isPlaceholderInfo("CELEX1")).toBe(true);
    expect(isPlaceholderInfo("Arrest van het Hof (Eerste kamer) van 26 mei 2005.")).toBe(false);
  });
});

describe("sectie, zoekterm and citaat", () => {
  const units = analyseUitspraak(euHtmlToLines(CELTEC_HTML), "arrest").randnummers;

  it("parses sections", () => {
    expect(parseEuSectie("39")).toEqual({ soort: "randnummers", van: 39, tot: 39 });
    expect(parseEuSectie("punt 43-44")).toEqual({ soort: "randnummers", van: 43, tot: 44 });
    expect(parseEuSectie("r.o. 12")).toEqual({ soort: "randnummers", van: 12, tot: 12 });
    expect(parseEuSectie("Dictum")).toEqual({ soort: "dictum" });
    expect(parseEuSectie("artikel 3")).toEqual({ soort: "artikel", nr: "3" });
    expect(parseEuSectie("art. 6 bis")).toEqual({ soort: "artikel", nr: "6 bis" });
    expect(parseEuSectie("overweging 12")).toEqual({ soort: "overweging", nr: 12 });
    expect(parseEuSectie("hoofdstuk zoveel")).toBeNull();
  });

  it("finds paragraphs holding every word, accents and case ignored", () => {
    const s = searchUnits(units, "prejudiciele uitlegging", 5000);
    expect(s.totaal).toBe(1);
    expect(s.treffers[0].id).toBe("1");
  });

  it("checks a quote literally, punctuation and quotes ignored, and points to the closest paragraph otherwise", () => {
    const ok = checkCitaat(units, "„het tijdstip van de overgang in de zin van die bepaling samenvalt met het tijdstip waarop de hoedanigheid van ondernemer”");
    expect(ok).toEqual({ gevonden: true, vindplaats: "4" });
    const changed = checkCitaat(units, "het tijdstip van de overgang in de zin van die bepaling valt samen met het moment waarop de hoedanigheid van ondernemer overgaat");
    expect(changed.gevonden).toBe(false);
    expect(changed.dichtstbij?.id).toBe("4");
  });
});

describe("resolution", () => {
  it("ranks the judgment before order and opinion", () => {
    expect(rankCaseCelex(["62003CC0478", "62003CJ0478", "62003CO0478"])).toEqual(["62003CJ0478", "62003CO0478", "62003CC0478"]);
  });

  it("flags an ECLI of another case than the case number", () => {
    const r = pickDocument([
      { invoer: "ECLI:EU:C:2005:315", soort: "ecli", celex: ["62003CJ0999"] },
      { invoer: "C-478/03", soort: "zaaknummer", celex: ["62003CJ0478", "62003CC0478"] },
    ]);
    expect(r.celex).toBe("62003CJ0999");
    expect(r.inconsistent).toContain("C-478/03 is 62003CJ0478/62003CC0478");
    expect(pickDocument([
      { invoer: "ECLI:EU:C:2005:321", soort: "ecli", celex: ["62003CJ0478"] },
      { invoer: "C-478/03", soort: "zaaknummer", celex: ["62003CJ0478", "62003CC0478"] },
    ])).toEqual({ celex: "62003CJ0478" });
  });

  it("asks CELLAR with owl:sameAs on resource/ecli and resource/case and with the derived CELEX numbers", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      queries.push(url.searchParams.get("query") ?? "");
      return jsonResponse(sparql([
        { key: lit("ecli|ECLI:EU:C:2005:321"), celex: lit("62003CJ0478") },
        { key: lit("celex|62003CJ0478"), celex: lit("62003CJ0478") },
        { key: lit("celex|62003CC0478"), celex: lit("62003CC0478") },
      ]));
    }));
    const r = await new EuTekstSource(testConfig).resolve(parseEuReferences("C-478/03, ECLI:EU:C:2005:321"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("<http://publications.europa.eu/resource/ecli/ECLI%3AEU%3AC%3A2005%3A321>");
    expect(queries[0]).toContain("<http://publications.europa.eu/resource/case/C-478%2F03>");
    expect(queries[0]).toContain("owl:sameAs");
    expect(queries[0]).toContain('"62003CJ0478"^^xsd:string');
    expect(r.celex).toBe("62003CJ0478");
    expect(r.inconsistent).toBeUndefined();
    expect(r.identificaties.find((i) => i.soort === "zaaknummer")?.celex).toEqual(["62003CJ0478", "62003CC0478"]);
  });
});

/** Route the stubbed fetch by URL: SPARQL by query content, text by URL and headers. */
function stubCellar(opts: { meta: Array<Record<string, unknown>>; resolve: Array<Record<string, unknown>>; text: (url: string, headers: Headers) => Response }) {
  const calls: Array<{ url: string; lang: string | null; accept: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url: href, lang: headers.get("accept-language"), accept: headers.get("accept") });
    const url = new URL(href);
    if (url.pathname.endsWith("/sparql")) {
      const q = url.searchParams.get("query") ?? "";
      return jsonResponse(sparql(q.includes("?key") ? opts.resolve : opts.meta));
    }
    return opts.text(href, headers);
  }));
  return calls;
}

const CELTEC_META = [{
  ecli: lit("ECLI:EU:C:2005:321"), date: lit("2005-05-26"), type: { type: "uri", value: "http://publications.europa.eu/resource/authority/resource-type/JUDG" },
  titleNl: lit("Arrest van het Hof (Eerste kamer) van 26 mei 2005.#Celtec Ltd tegen John Astley en anderen.#Zaak C-478/03."),
  parties: lit("Celtec Ltd tegen John Astley en anderen."), caseId: lit("Zaak C-478/03."), info: lit("Arrest van het Hof (Eerste kamer) van 26 mei 2005."),
  subject: lit("Richtlijn 77/187/EEG - Artikel 3, lid 1 - Begrip \"tijdstip van overgang\"."),
}];

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html;charset=UTF-8" } });

describe("euTekstResult", () => {
  it("returns metadata, randnummers and dictum of a ruling, with the Dutch text from content negotiation", async () => {
    const calls = stubCellar({
      resolve: [{ key: lit("celex|62003CJ0478"), celex: lit("62003CJ0478") }],
      meta: CELTEC_META,
      text: () => html(CELTEC_HTML),
    });
    const out = await euTekstResult(new EuTekstSource(testConfig), undefined, { id: "62003CJ0478", sectie: "4", citaat: "samenvalt met het tijdstip waarop de hoedanigheid van ondernemer", max_chars: 5000 });
    if (!("records" in out)) throw new Error(out.message);
    const d = out.records[0].data as Record<string, any>;
    expect(d).toMatchObject({
      bestaat: true, soort: "arrest", instantie: "Hof van Justitie", ecli: "ECLI:EU:C:2005:321", celex: "62003CJ0478",
      zaaknummer: "C-478/03", datum: "2005-05-26", partijen: "Celtec Ltd tegen John Astley en anderen",
      randnummers_aantal: 5, randnummers: "1–5", tekst_bron: { taal: "nl", formaat: "html" },
      citaat_controle: { gevonden: true, vindplaats: "4" },
    });
    expect(d.dictum).toMatch(/^1\) Artikel 3, lid 1/);
    expect((d.sectie as { bestaat: boolean; tekst: string }).bestaat).toBe(true);
    expect((d.sectie as { tekst: string }).tekst).toMatch(/^\[4\]\nGelet op een en ander/);
    const textCall = calls.find((c) => c.url === "https://publications.europa.eu/resource/celex/62003CJ0478");
    expect(textCall).toMatchObject({ lang: "nl", accept: "application/xhtml+xml, text/html" });
    expect(d.taal_melding).toBeUndefined();
  });

  it("says when a randnummer does not exist", async () => {
    stubCellar({ resolve: [{ key: lit("celex|62003CJ0478"), celex: lit("62003CJ0478") }], meta: CELTEC_META, text: () => html(CELTEC_HTML) });
    const out = await euTekstResult(new EuTekstSource(testConfig), undefined, { id: "62003CJ0478", sectie: "39", max_chars: 5000 });
    if (!("records" in out)) throw new Error(out.message);
    expect((out.records[0].data as Record<string, any>).sectie).toMatchObject({ bestaat: false, label: "randnummer 39" });
    expect(out.summary).toContain("randnummer 39 niet gevonden");
    expect(out.access_note).toContain("randnummer 39 komt niet voor in de tekst (randnummers 1–5)");
  });

  it("falls back to EUR-Lex and the PDF, and reports the language when only another language exists", async () => {
    const calls = stubCellar({
      resolve: [{ key: lit("ecli|ECLI:EU:C:2020:239"), celex: lit("62018CJ0344") }],
      meta: [{ ecli: lit("ECLI:EU:C:2020:239"), date: lit("2020-03-26") }],
      text: (url, headers) => {
        if (url.includes("eur-lex.europa.eu")) return html("", 202);
        if (headers.get("accept")?.includes("pdf")) return html("not found", 404);
        return headers.get("accept-language") === "nl" ? html("not found", 404) : html(ENGLISH_HTML);
      },
    });
    const out = await euTekstResult(new EuTekstSource(testConfig), undefined, { id: "ECLI:EU:C:2020:239", max_chars: 5000 });
    if (!("records" in out)) throw new Error(out.message);
    const d = out.records[0].data as Record<string, any>;
    expect(d.tekst_bron.taal).toBe("en");
    expect(d.taal_melding).toContain("niet Nederlands maar Engels");
    expect(d.tekst_bron.pogingen.map((p: { bron: string; ok: boolean }) => `${p.bron}:${p.ok}`)).toEqual(["cellar_html:false", "eurlex_html:false", "cellar_pdf:false", "cellar_html_andere_taal:true"]);
    expect(d.tekst_bron.pogingen[1].reden).toContain("HTTP 202");
    expect(calls.some((c) => c.url === "https://eur-lex.europa.eu/legal-content/NL/TXT/HTML/?uri=CELEX:62018CJ0344")).toBe(true);
  });

  it("reports a document CELLAR does not know as not existing, without fetching text", async () => {
    const calls = stubCellar({ resolve: [], meta: [], text: () => html(CELTEC_HTML) });
    const out = await euTekstResult(new EuTekstSource(testConfig), undefined, { id: "ECLI:EU:C:2005:99999", max_chars: 5000 });
    if (!("records" in out)) throw new Error(out.message);
    expect(out.records).toEqual([]);
    expect(out.summary).toContain("niet gevonden in CELLAR");
    expect(calls.every((c) => c.url.includes("/sparql"))).toBe(true);
  });

  it("reads articles of a regulation and adds LiDO counts by CELEX", async () => {
    stubCellar({
      resolve: [{ key: lit("celex|32016R0679"), celex: lit("32016R0679") }],
      meta: [{ date: lit("2016-04-27"), titleNl: lit("Verordening (EU) 2016/679 van het Europees Parlement en de Raad van 27 april 2016"), force: lit("true"), info: lit("CELEX1") }],
      text: () => html(VERORDENING_HTML),
    });
    const lido = { references: vi.fn(async () => ({ items: [{ total_references: 1234, per_type: [{ type: "Jurisprudentie", count: 1000 }], portal_url: "https://linkeddata.overheid.nl/x" }] })) };
    const out = await euTekstResult(new EuTekstSource(testConfig), lido as never, { id: "Verordening (EU) 2016/679", sectie: "artikel 3", max_chars: 5000 });
    if (!("records" in out)) throw new Error(out.message);
    const d = out.records[0].data as Record<string, any>;
    expect(d).toMatchObject({ soort: "verordening", celex: "32016R0679", in_force: true, artikelen_aantal: 2, overwegingen_aantal: 2 });
    expect(d.artikelen).toEqual([{ artikel: "1", titel: "Onderwerp en doelstellingen" }, { artikel: "3", titel: "Territoriaal toepassingsgebied" }]);
    expect(d.sectie.tekst).toContain("[artikel 3] Territoriaal toepassingsgebied");
    expect(d.lido).toMatchObject({ id: "32016R0679", total_references: 1234 });
    expect(d.aanduiding).toBeUndefined();
    expect(out.records[0].title).toContain("Verordening (EU) 2016/679");
    expect(lido.references).toHaveBeenCalledWith({ id: "32016R0679" });
  });
});

describe("eurlex_tekst_get via MCP", () => {
  it("is registered and answers over the protocol", async () => {
    stubCellar({ resolve: [{ key: lit("celex|32001L0023"), celex: lit("32001L0023") }], meta: [{ date: lit("2001-03-12") }], text: () => html(RICHTLIJN_2001_23_HTML) });
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fork-eu-test", version: "1.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const res = (await client.callTool({ name: "eurlex_tekst_get", arguments: { id: "Richtlijn 2001/23/EG", sectie: "artikel 3", lido: false } })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(res.content[0].text);
      expect(payload.records[0].data).toMatchObject({ celex: "32001L0023", soort: "richtlijn", artikelen_aantal: 3 });
      expect(payload.records[0].data.sectie.tekst).toContain("gaan door deze overgang over op de verkrijger");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

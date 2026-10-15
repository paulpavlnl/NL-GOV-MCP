/**
 * FORK (docs/FORK.md) — European Court of Human Rights (HUDOC): search, structure of a judgment,
 * meaning for the Netherlands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { betekenisVoorNederland, hudocEenheden, hudocQueryUrl, hudocRef, hudocRegels, hudocStructuur, kiesEenheden, kiesHudocDocument, staatCode } from "../src/fork/ehrm.js";
import { htmlResponse, jsonResponse } from "./helpers/config.js";

afterEach(() => { vi.unstubAllGlobals(); clearHttpCache(); });

// As HUDOC delivers it: table of contents (Grand Chamber), "3 . On …" with a space before the period,
// submissions per party, assessment with general principles and application, operative part, two opinions.
const p = (t: string) => `<p>${t}</p>`;
const HTML = [
  "<style>p{margin:0}</style>",
  p("GRAND CHAMBER"), p("CASE OF X v. TÜRKIYE"), p("TABLE OF CONTENTS"), p("THE FACTS"), p("THE LAW"), p("JOINT DISSENTING OPINION OF JUDGES A AND B"),
  p("This judgment is final but it may be subject to editorial revision."),
  p("The European Court of Human Rights, sitting as a Grand Chamber composed of:"),
  p("PROCEDURE"), p("1. The case originated in an application (no. 1234/20)."),
  p("THE FACTS"), p("2. The applicant was born in 1960."), p("3 . On 1 May 2020 the applicant was arrested."),
  p("RELEVANT LEGAL FRAMEWORK"), p("4. Article 2 of the Constitution reads as follows:"), p("“1. The Republic is a democratic State.”"),
  p("THE LAW"), p("ALLEGED VIOLATION OF ARTICLE 10 OF THE CONVENTION"), p("5. The applicant complained that his detention breached Article 10."),
  p("Merits"), p("The parties’ submissions"), p("(a) The applicant"), p("6. The applicant submitted that the measures had no legal basis."),
  p("(b) The Government"), p("7. The Government argued that the interference was justified."),
  p("Third-party intervener"), p("8. The Commissioner for Human Rights noted a pattern."),
  p("The Court’s assessment"), p("General principles"), p("9. The Court reiterates that freedom of expression constitutes one of the essential foundations of a democratic society."),
  p("Application of those principles to the present case"), p("10. The Government argued before the Court that the applicant had incited violence."), p("11. The Court finds that the interference was not necessary in a democratic society."),
  p("FOR THESE REASONS, THE COURT, UNANIMOUSLY,"), p("Holds that there has been a violation of Article 10 of the Convention;"),
  p("Done in English and in French, and delivered at a public hearing."), p("Registrar President"),
  p("In accordance with Article 45 § 2 of the Convention, the following separate opinions are annexed to this judgment:"), p("(a) Joint dissenting opinion of Judges A and B;"),
  p("JOINT DISSENTING OPINION OF JUDGES A AND B"), p("1. We respectfully disagree with the majority."), p("2. The interference was necessary."),
  p("CONCURRING OPINION OF JUDGE C"), p("1. I agree with the outcome."),
].join("\n");

describe("HUDOC parsing", () => {
  it("divides a judgment into parts, parties and the Court's assessment", () => {
    const u = hudocEenheden(hudocRegels(HTML));
    const by = Object.fromEntries(u.map((x) => [x.id, x]));
    expect(u.filter((x) => /^\d+$/.test(x.id)).map((x) => x.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(by["3"]).toMatchObject({ soort: "feiten", tekst: "On 1 May 2020 the applicant was arrested." });
    expect(by["4"].soort).toBe("rechtskader");
    expect(by["4"].tekst).toContain("democratic State");
    expect(by["5"]).toMatchObject({ soort: "klacht", klacht: "ALLEGED VIOLATION OF ARTICLE 10 OF THE CONVENTION" });
    expect(by["6"]).toMatchObject({ soort: "standpunten", partij: "verzoeker" });
    expect(by["7"]).toMatchObject({ soort: "standpunten", partij: "regering" });
    expect(by["8"]).toMatchObject({ soort: "standpunten", partij: "derde-belanghebbende" });
    expect(by["9"]).toMatchObject({ soort: "beoordeling", deel: "algemene beginselen" });
    expect(by["10"]).toMatchObject({ deel: "toepassing", weergave: "standpunt partij" });
    expect(by.beslissing.tekst).toBe("Holds that there has been a violation of Article 10 of the Convention;");
    expect(by["mening 1 §2"]).toMatchObject({ soort: "afwijkende mening", deel: "JOINT DISSENTING OPINION OF JUDGES A AND B" });
    expect(by["mening 2 §1"].deel).toBe("CONCURRING OPINION OF JUDGE C");
    const s = hudocStructuur(u);
    expect(s).toContainEqual({ alineas: "6", onderdeel: "standpunten", partij: "verzoeker", klacht: "ALLEGED VIOLATION OF ARTICLE 10 OF THE CONVENTION" });
    expect(s).toContainEqual({ alineas: "mening 1 §1–§2", onderdeel: "afwijkende mening", deel: "JOINT DISSENTING OPINION OF JUDGES A AND B" });
    expect(kiesEenheden(u, { onderdeel: ["algemene beginselen"] }).map((x) => x.id)).toEqual(["9"]);
    expect(kiesEenheden(u, { alineas: "§ 6-8" }).map((x) => x.id)).toEqual(["6", "7", "8"]);
  });

  it("recognises references, states and builds queries", () => {
    expect(hudocRef("ECLI:CE:ECHR:2008:1127JUD003639102")).toEqual({ ecli: "ECLI:CE:ECHR:2008:1127JUD003639102" });
    expect(hudocRef("https://hudoc.echr.coe.int/eng#{%22itemid%22:[%22001-89893%22]}")).toEqual({ itemid: "001-89893" });
    expect(hudocRef("001-252629")).toEqual({ itemid: "001-252629" });
    expect(hudocRef("Salduz v. Turkey [GC], no. 36391/02, § 55")).toEqual({ appno: "36391/02" });
    expect(hudocRef("Salduz")).toBeNull();
    expect(staatCode("Nederland")).toBe("NLD");
    expect(staatCode("the Netherlands")).toBe("NLD");
    expect(staatCode("Türkiye")).toBe("TUR");
    expect(staatCode("tur")).toBe("TUR");
    const u = new URL(hudocQueryUrl(`(respondent:"NLD")`));
    expect(u.searchParams.get("query")).toBe(`contentsitename:ECHR AND (respondent:"NLD") AND NOT (doctype:"PR")`);
    expect(u.searchParams.get("sort")).toBe("kpdate Descending");
    expect(u.searchParams.get("start")).toBe("0");
  });

  it("chooses the document and says what it means for the Netherlands", () => {
    const { gekozen, andere } = kiesHudocDocument([
      { itemid: "001-2", languageisocode: "FRE", documentcollectionid2: "CASELAW;JUDGMENTS;CHAMBER;FRE", kpdate: "2026-10-06" },
      { itemid: "002-1", languageisocode: "ENG", documentcollectionid2: "CASELAW;CLIN;ENG", kpdate: "2026-10-06" },
      { itemid: "001-1", languageisocode: "ENG", documentcollectionid2: "CASELAW;JUDGMENTS;CHAMBER;ENG", kpdate: "2026-10-06" },
    ]);
    expect(gekozen?.itemid).toBe("001-1");
    expect(andere.map((d) => d.soort)).toEqual(["arrest", "samenvatting (Legal Summary)"]);
    const nl = betekenisVoorNederland({ respondent: "NLD", documentcollectionid2: "CASELAW;JUDGMENTS;CHAMBER;ENG", doctypebranch: "CHAMBER", kpdate: "2026-10-06" }, "will become final in the circumstances set out in Article 44 § 2", { vandaag: new Date("2026-10-15") });
    expect(nl).toMatchObject({ nederland_partij: true, definitief: false, kamer: "Kamer" });
    expect(nl.toelichting).toMatch(/res judicata/);
    expect(nl.toelichting).toMatch(/nog niet definitief/);
    const tr = betekenisVoorNederland({ respondent: "TUR", documentcollectionid2: "CASELAW;JUDGMENTS;GRANDCHAMBER;ENG", doctypebranch: "GRANDCHAMBER", importance: "1" });
    expect(tr.toelichting).toMatch(/res interpretata.*relevantie voor de Nederlandse praktijk.*Grote Kamer.*key case/);
    expect(betekenisVoorNederland({ respondent: "FRA", documentcollectionid2: "CASELAW;ADVISORYOPINIONS;ENG" }).toelichting).toMatch(/Protocol 16: niet bindend/);
  });
});

const DOC = { itemid: "001-1", docname: "CASE OF X v. TÜRKIYE", appno: "1234/20", ecli: "ECLI:CE:ECHR:2026:0101JUD000123420", respondent: "TUR", kpdate: "2026-01-01T00:00:00", doctypebranch: "GRANDCHAMBER", documentcollectionid2: "CASELAW;JUDGMENTS;GRANDCHAMBER;ENG", languageisocode: "ENG", importance: "1", article: "10;10-1", conclusion: "Violation of Article 10", separateopinion: "TRUE", scl: "Salduz v. Turkey [GC], no. 36391/02, ECHR 2008" };
const DUT = { ...DOC, itemid: "001-7", docname: "X v. TÜRKIYE - [Dutch Translation] summary by the Dutch Ministry of Foreign Affairs", languageisocode: "DUT", documentcollectionid2: "CASELAW;JUDGMENTS;GRANDCHAMBER;DUT" };

describe("HUDOC tools", () => {
  it("ehrm_zoeken builds the HUDOC query from the filters", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { urls.push(String(input instanceof Request ? input.url : input)); return jsonResponse({ resultcount: 1, results: [{ columns: DOC }] }); }));
    const r = await call("ehrm_zoeken", { verweerder: "Turkije", artikel: "artikel 10", grote_kamer: true, belang: ["1"], van: "2020", tot: "2026" });
    const q = new URL(urls[0]).searchParams.get("query")!;
    expect(q).toContain(`(respondent:"TUR")`);
    expect(q).toContain(`(article:"10")`);
    expect(q).toContain(`(documentcollectionid2:"JUDGMENTS")`);
    expect(q).toContain(`(doctypebranch:"GRANDCHAMBER")`);
    expect(q).toContain(`(importance:"1")`);
    expect(q).toContain(`kpdate>="2020-01-01T00:00:00.0Z" AND kpdate<="2026-12-31T00:00:00.0Z"`);
    expect(q).toContain(`NOT (doctype:"PR")`);
    expect(r.records[0]).toMatchObject({ canonical_url: "https://hudoc.echr.coe.int/eng?i=001-1", data: { nederland_partij: false, belang: "1 (key case / zeer belangrijk)" } });
    expect((await call("ehrm_zoeken", { verweerder: "Atlantis" })).error).toBeDefined();
  });

  it("ehrm_uitspraak_get gives structure, selection, meaning for NL and Dutch versions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/query/results")) return jsonResponse({ resultcount: 2, results: [{ columns: DUT }, { columns: DOC }] });
      if (u.includes("/conversion/")) return htmlResponse(HTML);
      return htmlResponse("<x/>", 404); // LiDO
    }));
    const r = await call("ehrm_uitspraak_get", { uitspraak: "X v. Türkiye [GC], no. 1234/20", onderdeel: ["algemene beginselen", "beslissing"] });
    const d = r.records[0].data;
    expect(d.itemid).toBe("001-1");
    expect(d.alineas_totaal).toBe(11);
    expect(d.betekenis_voor_nederland).toMatchObject({ nederland_partij: false, kamer: "Grote Kamer", definitief: true });
    expect(d.tekst).toMatch(/^§ 9 \[beoordeling – algemene beginselen\]/);
    expect(d.tekst).toContain("beslissing [beslissing]");
    expect(d.tekst).not.toContain("§ 6 ");
    expect(d.structuur.some((s: Record<string, string>) => s.partij === "regering")).toBe(true);
    expect(d.nederlandse_versie[0].url).toBe("https://hudoc.echr.coe.int/eng?i=001-7");
    expect(d.aangehaalde_rechtspraak).toEqual(["Salduz v. Turkey [GC], no. 36391/02, ECHR 2008"]);
    expect(d.nederlandse_rechtspraak).toBeDefined();
    expect((await call("ehrm_uitspraak_get", { uitspraak: "zomaar een zaak" })).error).toBeDefined();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0].text);
  } finally { await client.close(); await server.close(); }
}

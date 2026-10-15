/**
 * FORK (docs/FORK.md) — live check of eurlex_tekst_get against CELLAR and
 * EUR-Lex. Opt-in: npm run test:acceptance -- tests/fork-eu.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { EuTekstSource } from "../src/fork/eu-bron.js";
import { euTekstResult } from "../src/fork/eu-tools.js";
import { testConfig } from "./helpers/config.js";

const source = new EuTekstSource(testConfig);
const run = (id: string, extra: Record<string, unknown> = {}) => euTekstResult(source, undefined, { id, max_chars: 4000, lido: false, ...extra });

/** As CELLAR links them (owl:sameAs), checked 2026-10-15. */
const DOCS = [
  { naam: "Celtec", celex: "62003CJ0478", ecli: "ECLI:EU:C:2005:321", zaak: "C-478/03", partij: /Celtec/ },
  { naam: "Ny Mølle Kro", celex: "61986CJ0287", ecli: "ECLI:EU:C:1987:573", zaak: "zaak 287/86", partij: /Ny M(?:ø|oe)lle Kro|Landsorganisationen/i },
  { naam: "Katsikas", celex: "61991CJ0132", ecli: "ECLI:EU:C:1992:517", zaak: "C-132/91", partij: /Katsikas/ },
  { naam: "ISS Facility Services", celex: "62018CJ0344", ecli: "ECLI:EU:C:2020:239", zaak: "C-344/18", partij: /ISS Facility Services/ },
  { naam: "Redmond Stichting", celex: "61991CJ0029", ecli: "ECLI:EU:C:1992:220", zaak: "C-29/91", partij: /Redmond/ },
];

describe("EU case law, live", () => {
  for (const d of DOCS) {
    it(`${d.naam}: ECLI, CELEX and case number lead to the same Dutch judgment with randnummers and dictum`, async () => {
      for (const id of [d.ecli, d.celex, d.zaak]) {
        const out = await run(id);
        if (!("records" in out)) throw new Error(`${id}: ${out.message}`);
        const data = out.records[0]?.data as Record<string, any>;
        expect(data, id).toMatchObject({ bestaat: true, celex: d.celex, ecli: d.ecli, soort: "arrest" });
        expect(String(data.partijen ?? data.titel), id).toMatch(d.partij);
        expect(data.tekst_bron.taal, id).toBe("nl");
        expect(data.randnummers_aantal, id).toBeGreaterThan(5);
        expect(String(data.dictum ?? ""), id).toMatch(/richtlijn|RICHTLIJN/);
      }
    });
  }

  it("Celtec with ECLI:EU:C:2005:315 is flagged: that ECLI belongs to another document", async () => {
    const out = await run("C-478/03, ECLI:EU:C:2005:315");
    if (!("records" in out)) throw new Error(out.message);
    const data = out.records[0].data as Record<string, any>;
    expect(data.inconsistentie).toContain("C-478/03");
  });

  it("Celtec: randnummer 44 exists, 99 does not, and a quote from the dictum is found", async () => {
    const ok = await run("62003CJ0478", { sectie: "44", citaat: "Hierbij gaat het om een precies tijdstip, dat niet naar goeddunken van de vervreemder of de verkrijger naar later kan worden verschoven" });
    if (!("records" in ok)) throw new Error(ok.message);
    expect((ok.records[0].data as any).sectie.bestaat).toBe(true);
    expect((ok.records[0].data as any).citaat_controle.gevonden).toBe(true);
    const missing = await run("62003CJ0478", { sectie: "99" });
    if (!("records" in missing)) throw new Error(missing.message);
    expect((missing.records[0].data as any).sectie.bestaat).toBe(false);
  });
});

describe("EU legislation, live", () => {
  it("Richtlijn 2001/23/EG: articles, recitals and article 3", async () => {
    const out = await run("Richtlijn 2001/23/EG", { sectie: "artikel 3" });
    if (!("records" in out)) throw new Error(out.message);
    const data = out.records[0].data as Record<string, any>;
    expect(data).toMatchObject({ celex: "32001L0023", soort: "richtlijn", tekst_bron: { taal: "nl" } });
    expect(data.artikelen_aantal).toBeGreaterThanOrEqual(14);
    expect(data.sectie.tekst).toContain("verkrijger");
  });

  it("Verordening (EU) 2016/679: 99 articles with titles", async () => {
    const out = await run("Verordening (EU) 2016/679", { sectie: "artikel 3" });
    if (!("records" in out)) throw new Error(out.message);
    const data = out.records[0].data as Record<string, any>;
    expect(data).toMatchObject({ celex: "32016R0679", soort: "verordening", artikelen_aantal: 99 });
    expect(data.sectie.tekst).toContain("Territoriaal toepassingsgebied");
  });

  it("Verordening (EG) nr. 883/2004: no Dutch HTML, so the PDF or another language is used and reported", async () => {
    const out = await run("Verordening (EG) nr. 883/2004");
    if (!("records" in out)) throw new Error(out.message);
    const data = out.records[0].data as Record<string, any>;
    expect(data.celex).toBe("32004R0883");
    expect(data.tekst_bron?.formaat === "pdf" || Boolean(data.taal_melding) || data.tekst_bron?.taal === "nl").toBe(true);
  });
});

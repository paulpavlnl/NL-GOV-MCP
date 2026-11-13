import { describe, expect, it } from "vitest";
import { parseCaoNaam, parseKenmerken, parseDocumenten, zoekArtikel, zoekPassages } from "../src/fork/cao.js";

describe("cao (FORK)", () => {
  it("ontleedt de regelnaam uit de databank", () => {
    expect(parseCaoNaam("54351", "487 - METALEKTRO - 01-01-2026 - 31-12-2028 - Regulier - kvo datum - 17-02-2026")).toMatchObject({ nummer: "487", naam: "METALEKTRO", ingang: "2026-01-01", expiratie: "2028-12-31", type: "Regulier", kvo: "2026-02-17", wijziging: false });
    const ttw = parseCaoNaam("1", "4089 - STAAT DER NEDERLANDEN AANVULLENDE CAO RIJK UITZENDINGEN - 01-01-2020 - 31-12-2023 - Regulier - kvo datum - 29-01-2026 - TTW Stilzwijgend verlengde CAO");
    expect(ttw).toMatchObject({ nummer: "4089", wijziging: true, extra: "Stilzwijgend verlengde CAO" });
    expect(parseCaoNaam("2", "689 - METALEKTRO CAO inzake Arbeidsmarkt en Opleiding - 01-01-2026 - 31-12-2026 - Sociaal Fonds - kvo datum - 09-04-2026").type).toBe("Sociaal Fonds");
  });

  it("leest kenmerken en documenten van een detailpagina", () => {
    const h = '<dl class="moz-dl"><dt class="prompttekst">Soort cao</dt><dd class="aandachttekst"><div><span>Bedrijfstak</span></div></dd></dl><dl class="moz-dl"><dt class="prompttekst">SBI-code</dt><dd><span>240</span></dd></dl><a href="document/docnr/7862,,8294,/TTW_cao_Bouw___Infra_integraal.pdf">pdf</a><a href="document/docnr/7862,,8294,/TTW_cao_Bouw___Infra_integraal.pdf">pdf</a>';
    expect(parseKenmerken(h)).toEqual({ "Soort cao": "Bedrijfstak", "SBI-code": "240" });
    expect(parseDocumenten(h)).toEqual([{ pad: "document/docnr/7862,,8294,/TTW_cao_Bouw___Infra_integraal.pdf", naam: "TTW_cao_Bouw___Infra_integraal.pdf" }]);
  });

  it("vindt een artikel in beide nummeringen en slaat de inhoudsopgave over", () => {
    const paginas = [
      "Inhoud\nArtikel 12 Vakantie ........ 14\n",
      "Artikel 11 Arbeidsduur\nDe arbeidsduur is 38 uur.\nArtikel 12 Vakantie\n1. De werknemer heeft recht op 25 vakantiedagen per jaar, naar rato van de arbeidsduur.\nArtikel 13 Feestdagen\nNiet hier.",
      "1.5 Voltijd en deeltijd\n1.5.1 Uitzonderingen\nDe evenredigheid geldt niet bij kort verzuim en vakbondsverlof, zoals hieronder staat.\n1.6 Proeftijd\nNiet hier.",
    ];
    const a = zoekArtikel(paginas, "12");
    expect(a).toHaveLength(1);
    expect(a[0].pagina).toBe(2);
    expect(a[0].tekst).toContain("25 vakantiedagen");
    expect(a[0].tekst).not.toContain("Feestdagen");
    const b = zoekArtikel(paginas, "1.5");
    expect(b[0].pagina).toBe(3);
    expect(b[0].tekst).toContain("vakbondsverlof");
    expect(b[0].tekst).not.toContain("Proeftijd");
    expect(zoekPassages(paginas, "vakantiedagen")[0].pagina).toBe(2);
  });
});

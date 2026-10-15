/** FORK (docs/FORK.md) — rechtspraak_richtlijnen: documents, validity and the current version. */
import { describe, expect, it } from "vitest";
import { actueel, geldigheid, parseRichtlijnPagina } from "../src/fork/richtlijnen.js";

const KANTON = `<h2>Procesreglementen kanton</h2><h3>Procesreglementen</h3>
<p>Landelijk procesreglement<strong> civiele dagvaardingszaken </strong>rechtbanken<strong>&nbsp;handel en kanton</strong>:</p>
<ul><li><p><a href="/binaries/_rts_1/content/assets/a-2026.pdf">geldig vanaf 1 juli 2026 (pdf, 1 MB)</a></p></li>
<li><p><a href="/binaries/_rts_2/content/assets/a-2025.pdf">geldig juli 2025-juni 2026 (pdf, 505 KB)</a></p></li></ul>
<h3>Overig</h3><ul><li><a href="/binaries/_rts_3/h.pdf">Handleiding erfrechtprocedures kantonrechter (pdf, 1 MB)</a></li></ul>`;

const ALIMENTATIE = `<h2>Alimentatienormen</h2><h3>Aangepast Rapport Alimentatienormen 2026</h3>
<a href="/r26.pdf">Rapport alimentatienormen, versie januari 2026 (pdf, 673 KB)</a><a href="/b26a.pdf">Bijlage rapport alimentatienormen, versie januari 2026 (pdf)</a><a href="/b26b.pdf">Bijlage rapport alimentatienormen, versie juli 2026 (pdf)</a>
<h3>Aangepast Rapport Alimentatienormen 2025</h3><a href="/r25.pdf">Rapport alimentatienormen, versie januari 2025 (pdf)</a>
<h3>Aangepast Rapport Alimentatienormen 2023</h3><a href="/r23.pdf">Rapport alimentatienormen (tremarapport), versie januari 2023 (pdf)</a><a href="/t23.pdf">Behoeftetabel 2023 (pdf)</a>`;

describe("rechtspraak_richtlijnen", () => {
  it("reads validity from titles", () => {
    expect(geldigheid("geldig vanaf 1 juli 2026")).toEqual({ vanaf: "2026-07-01" });
    expect(geldigheid("geldig juli 2025-juni 2026")).toEqual({ vanaf: "2025-07-01", tot: "2026-07-01" });
    expect(geldigheid("geldig januari-juni 2026")).toEqual({ vanaf: "2026-01-01", tot: "2026-07-01" });
    expect(geldigheid("Indicatietarieven Rechtbanken, 1 april 2017 - 1 februari 2026")).toEqual({ vanaf: "2017-04-01", tot: "2026-02-01" });
    expect(geldigheid("geldig tot 1 oktober 2019")).toEqual({ tot: "2019-10-01" });
    expect(geldigheid("Aanbevelingen rekenrente")).toEqual({});
  });

  it("titles a bare validity link after the paragraph above it and picks the version in force", () => {
    const docs = parseRichtlijnPagina(KANTON);
    expect(docs.map((d) => d.titel)).toEqual([
      "Landelijk procesreglement civiele dagvaardingszaken rechtbanken handel en kanton (geldig vanaf 1 juli 2026)",
      "Landelijk procesreglement civiele dagvaardingszaken rechtbanken handel en kanton (geldig juli 2025-juni 2026)",
      "Handleiding erfrechtprocedures kantonrechter",
    ]);
    expect(docs[0].url).toBe("https://www.rechtspraak.nl/binaries/_rts_1/content/assets/a-2026.pdf");
    expect([...actueel(docs, "2026-10-15")].map((d) => d.url.split("/").pop())).toEqual(["a-2026.pdf", "h.pdf"]);
    expect([...actueel(docs, "2026-03-01")].map((d) => d.url.split("/").pop())).toEqual(["a-2025.pdf", "h.pdf"]);
  });

  it("treats older year sections as archive", () => {
    const docs = parseRichtlijnPagina(ALIMENTATIE);
    expect([...actueel(docs, "2026-10-15")].map((d) => d.url)).toEqual(["https://www.rechtspraak.nl/r26.pdf", "https://www.rechtspraak.nl/b26b.pdf"]);
    expect([...actueel(docs, "2025-05-01")].map((d) => d.url)).toEqual(["https://www.rechtspraak.nl/r25.pdf"]);
  });
});

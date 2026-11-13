import { describe, expect, it } from "vitest";
import { splitNaam, samenstelling, binnenLoopbaan, gerechtSleutel, rnlState } from "../src/fork/rechterprofiel.js";

describe("rechterprofiel (FORK)", () => {
  it("haalt voorletters en (hoofd)achternaam uit de registernaam", () => {
    expect(splitNaam("mr. T.J. Sleeswijk Visser-De Boer")).toEqual({ voorletters: "T.J.", achternaam: "Sleeswijk Visser-De Boer", hoofdnaam: "Sleeswijk Visser" });
    expect(splitNaam("mr. drs. B.M. Visser")).toMatchObject({ voorletters: "B.M.", hoofdnaam: "Visser" });
    expect(splitNaam("drs. A.W.T.M. van der Visser LL.M.")).toMatchObject({ voorletters: "A.W.T.M.", hoofdnaam: "van der Visser" });
  });

  it("vindt de naam in de samenstelling, ook na 'mr.' en met voorletters", () => {
    const t = "3.2. houdt iedere verdere beslissing aan. Dit vonnis is gewezen door mr. T.J. Sleeswijk Visser en in het openbaar uitgesproken op 14 april 2026.";
    expect(samenstelling(t, "Sleeswijk Visser", "T.J.").gevonden).toBe(true);
    const hof = "Dit arrest is gewezen door mr. R.M. Bouritius, mr. T.J. Sleeswijk Visser–De Boer en mr. K.I. de Jong, in bijzijn van de griffier.";
    expect(samenstelling(hof, "Sleeswijk Visser", "T.J.").gevonden).toBe(true);
    expect(samenstelling(hof, "Sleeswijk Visser", "A.B.").gevonden).toBe(false);
    expect(samenstelling("Zie het arrest van mr. Sleeswijk Visser in een andere zaak.", "Sleeswijk Visser", "T.J.").gevonden).toBe(false);
    const wr = "op het verzoek strekkende tot de wraking van mr. T.J. Sleeswijk Visser rechter in deze rechtbank. Aldus gegeven door mr. M. Brinksma, voorzitter.";
    expect(samenstelling(wr, "Sleeswijk Visser", "T.J.")).toEqual({ gevonden: false, wraking: true });
    expect(samenstelling("Deze uitspraak is gedaan door mr. P. de Groot, voorzitter, en mr. Q. Jansen.", "de Groot", "P.").rol).toBe("voorzitter");
  });

  it("toetst gerecht en datum aan de loopbaan, met oude gerechtsnamen", () => {
    const a = [{ functie: "Rechter", instantie: "Rechtbank 's-Gravenhage", van: "1997-01-01", tot: "2006-06-30" }];
    expect(gerechtSleutel("Rechtbank 's-Gravenhage")).toBe(gerechtSleutel("Rechtbank Den Haag"));
    expect(binnenLoopbaan(a, "Rechtbank Den Haag", "2000-05-05")).toBeTruthy();
    expect(binnenLoopbaan(a, "Rechtbank Den Haag", "2010-05-05")).toBeUndefined();
    expect(binnenLoopbaan(a, "Rechtbank Amsterdam", "2000-05-05")).toBeUndefined();
  });

  it("leest de gegevens uit rnl-state", () => {
    expect(rnlState('<script nonce="x" id="rnl-state" type="application/json">{"neroSearchResults":[]}</script>')).toEqual({ neroSearchResults: [] });
    expect(() => rnlState("<html></html>")).toThrow();
  });
});

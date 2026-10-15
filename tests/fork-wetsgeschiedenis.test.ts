/** FORK (docs/FORK.md) — wetsgeschiedenis_get: WTI, Kamerstukken and passages. */
import { describe, expect, it } from "vitest";
import { artikelPatroon, kamerstukSoort, parseKamerstukken, parseWti, passagesMet, vindplaats } from "../src/fork/wetsgeschiedenis.js";

const WTI = `<wetstechnische-informatie><gerelateerde-regelgeving><regelingelement label-id="2914084"><verwijzing-door/></regelingelement></gerelateerde-regelgeving>
<wijzigingen><regeling><datum><details><betreft>Aanhangig</betreft><ontstaansbron><bron type="oorspronkelijk"><dossiernummer>37037</dossiernummer></bron></ontstaansbron></details>
<details><betreft>Aanhangig</betreft><ontstaansbron><bron type="oorspronkelijk"><dossiernummer>36996</dossiernummer></bron></ontstaansbron></details></datum></regeling>
<regelingelement label-id="2914084">
<datum waarde="1999-01-01" label="Artikel 658"><details><betreft>wijziging</betreft><ontstaansbron><bron type="oorspronkelijk"><dossiernummer>25263</dossiernummer><ondertekening>1998-05-14</ondertekening><bekendmaking soort="Stb" urlidentifier="stb-1998-300"/></bron></ontstaansbron></details></datum>
<datum waarde="1997-04-01" label="Artikel 658"><details><betreft>nieuw</betreft><ontstaansbron><bron type="oorspronkelijk"><dossiernummer>23438</dossiernummer><bekendmaking soort="Stb" urlidentifier="stb-1996-406"/></bron></ontstaansbron></details></datum>
</regelingelement><regelingelement label-id="999"><datum waarde="2020-01-01"><details><betreft>nieuw</betreft><ontstaansbron><bron><dossiernummer>1</dossiernummer></bron></ontstaansbron></details></datum></regelingelement></wijzigingen></wetstechnische-informatie>`;

const SRU = `<sru:record><dcterms:identifier>kst-33818-3</dcterms:identifier><dcterms:title>Wijziging van verschillende wetten (Wet werk en zekerheid); Memorie van toelichting</dcterms:title><dcterms:creator scheme="x">Tweede Kamer der Staten-Generaal</dcterms:creator><dcterms:available>2013-12-19</dcterms:available><overheidwetgeving:dossiertitel>Wet werk en zekerheid</overheidwetgeving:dossiertitel><overheidwetgeving:ondernummer>3</overheidwetgeving:ondernummer><overheidwetgeving:vergaderjaar>2013-2014</overheidwetgeving:vergaderjaar><gzd:preferredUrl>https://zoek.officielebekendmakingen.nl/kst-33818-3.html</gzd:preferredUrl><gzd:itemUrl manifestation="html">https://repository.overheid.nl/frbr/officielepublicaties/kst/33818/kst-33818-3/1/html/kst-33818-3.html</gzd:itemUrl></sru:record>
<sru:record><dcterms:identifier>kst-33818-C</dcterms:identifier><dcterms:title>Wet werk en zekerheid; Memorie van antwoord</dcterms:title><dcterms:creator scheme="x">Eerste Kamer der Staten-Generaal</dcterms:creator><overheidwetgeving:ondernummer>C</overheidwetgeving:ondernummer><overheidwetgeving:vergaderjaar>2013-2014</overheidwetgeving:vergaderjaar></sru:record>`;

describe("wetsgeschiedenis", () => {
  it("reads the versions of one article and the pending bills from the WTI", () => {
    const w = parseWti(WTI, "2914084");
    expect(w.wijzigingen).toEqual([
      { datum: "1999-01-01", betreft: "wijziging", dossiers: ["25263"], staatsblad: ["stb-1998-300"], ondertekening: "1998-05-14" },
      { datum: "1997-04-01", betreft: "nieuw", dossiers: ["23438"], staatsblad: ["stb-1996-406"], ondertekening: undefined },
    ]);
    expect(w.aanhangig).toEqual(["37037", "36996"]);
  });

  it("sorts parliamentary papers by kind and cites them", () => {
    expect(kamerstukSoort("Advies Raad van State en nader rapport")).toBe("advies Raad van State en nader rapport");
    expect(kamerstukSoort("Nota naar aanleiding van het verslag")).toBe("nota naar aanleiding van het verslag");
    expect(kamerstukSoort("Tweede nota van wijziging")).toBe("nota van wijziging");
    expect(kamerstukSoort("Amendement van het lid X")).toBe("amendement");
    const [mvt, mva] = parseKamerstukken(SRU);
    expect(mvt).toMatchObject({ id: "kst-33818-3", nummer: "3", soort: "memorie van toelichting", kamer: "II", dossiertitel: "Wet werk en zekerheid" });
    expect(vindplaats(mvt, "33818")).toBe("Kamerstukken II 2013/14, 33 818, nr. 3");
    expect(vindplaats(mva, "33818")).toBe("Kamerstukken I 2013/14, 33 818, nr. C");
    expect(mva.url).toBe("https://zoek.officielebekendmakingen.nl/kst-33818-C.html");
  });

  it("finds the article the way papers write it", () => {
    const re = artikelPatroon("7:669");
    for (const t of ["artikel 7:669, derde lid", "Op grond van artikel 669 kan", "art. 7:669 BW", "(artikel 7:669)"]) expect(re.test(t), t).toBe(true);
    for (const t of ["artikel 7:669a", "artikel 6699", "artikel 7:670"]) expect(re.test(t), t).toBe(false);
    expect(artikelPatroon("3:4").test("artikel 3:4, tweede lid, Awb")).toBe(true);
    expect(artikelPatroon("25").test("artikel 25a")).toBe(false);
    const p = passagesMet("Inleiding\n3.2.4 Ontslag wegens ziekte\nOp grond van artikel 7:669, lid 3, geldt dat de werkgever.\nDit is een vervolg.\n4 Andere kop\nNiets.", artikelPatroon("7:669"));
    expect(p).toEqual(["3.2.4 Ontslag wegens ziekte\nOp grond van artikel 7:669, lid 3, geldt dat de werkgever.\nDit is een vervolg."]);
  });
});

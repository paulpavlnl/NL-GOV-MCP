import type { AppConfig } from "../types.js";
import { getText } from "../utils/http.js";

/**
 * Haalt de officiële tekst van één wetsartikel uit het Basiswettenbestand (BWB).
 *
 * Werkwijze:
 *  1. BWB SRU (zoekservice.overheid.nl) op identifier + geldigheidsdatum → de
 *     toestand die op die datum gold, met de URL van de toestand-XML.
 *  2. Die XML (officiële repository van KOOP) ophalen en daarin het <artikel>
 *     zoeken. Elk artikel draagt het pad (bwb-ng-variabel-deel, bijv.
 *     "/Hoofdstuk7/Paragraaf7.1/Artikel55") en het LiDO-label-id.
 *  3. Alleen dat artikel teruggeven, als leesbare tekst, met permanente links
 *     (wetten.overheid.nl, jci en LiDO).
 *
 * Dit voorkomt het probleem dat bij grote wetten de volledige tekst te lang is
 * voor één toolresultaat: de hele wet wordt server-side verwerkt, alleen het
 * gevraagde artikel gaat terug.
 */

const BWB_SRU_ENDPOINT = "https://zoekservice.overheid.nl/sru/Search";
const LIDO_ORIGIN = "https://linkeddata.overheid.nl";
/** Toestand-XML van grote wetten (BW, Awb) kan enkele MB zijn. */
const MAX_TOESTAND_BYTES = 12 * 1024 * 1024;

export interface BwbArtikel {
  bwb_id: string;
  titel_regeling?: string;
  artikel: string;
  kop: string;
  pad: string;
  label_id?: string;
  inwerking?: string;
  bron_wijziging?: string;
  tekst: string;
  toestand: string;
  geldigheidsdatum: string;
  wetten_url: string;
  jci: string;
  lido_url?: string;
  lido_tekst_url?: string;
  xml_url: string;
}

/** Normaliseer "55", "art. 55", "Artikel 55a", "7:658" naar het artikelnummer. */
export function normalizeArtikelNr(input: string): string {
  return input
    .trim()
    .replace(/^(artikel|art\.?)\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : undefined;
}

/** Zet de BWB-XML van één artikel om in leesbare tekst met leden en onderdelen. */
export function artikelXmlToText(xml: string): { kop: string; tekst: string } {
  const kopXml = xml.match(/<kop\b[^>]*>([\s\S]*?)<\/kop>/)?.[1] ?? "";
  const kop = decodeEntities(
    kopXml
      .replace(/<\/(label|nr)>/g, " ")
      .replace(/<titel\b[^>]*>/g, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );

  let body = xml
    .replace(/<kop\b[^>]*>[\s\S]*?<\/kop>/, "")
    // metadata en redactionele elementen weglaten
    .replace(/<meta-data\b[\s\S]*?<\/meta-data>/g, "")
    .replace(/<redactie\b[\s\S]*?<\/redactie>/g, "")
    .replace(/<noot\b[\s\S]*?<\/noot>/g, "")
    // structuur → regels
    .replace(/<lidnr\b[^>]*>([\s\S]*?)<\/lidnr>/g, "\n$1 ")
    .replace(/<li\.nr\b[^>]*>([\s\S]*?)<\/li\.nr>/g, "\n$1 ")
    .replace(/<\/(al|lid|li)>/g, "\n")
    .replace(/<[^>]+>/g, "");

  const lines = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  // Een regel die alleen een lid- of onderdeelnummer is ("1", "a.", "2°.") samenvoegen met de volgende regel.
  const merged: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^(\d+[a-z]?|[a-z]{1,2})[.°]*\.?$/i.test(l) && i + 1 < lines.length) {
      const marker = /^\d+[a-z]?$/i.test(l) ? `${l}.` : l;
      merged.push(`${marker} ${lines[++i]}`);
    } else {
      merged.push(l);
    }
  }
  body = merged.join("\n");

  return { kop, tekst: body };
}

/** Zoek alle <artikel>-elementen met het gevraagde nummer (optioneel gefilterd op pad). */
export function findArtikelen(
  toestandXml: string,
  artikelNr: string,
  padFilter?: string,
): Array<{ openTag: string; xml: string; pad: string }> {
  let wanted = normalizeArtikelNr(artikelNr);
  // BW-notatie "7:658" → artikel 658 in Boek 7. Wetten met hoofdstuknummering (Awb "1:7",
  // Wvggz "6:4") kennen geen Boek-pad; daar is "1:7" zelf het artikelnummer.
  const bw = wanted.match(/^(\d+[a-z]?):(.+)$/);
  const isBwBoek = bw !== null && toestandXml.toLowerCase().includes(`bwb-ng-variabel-deel="/boek${bw[1]}/`);
  if (bw && isBwBoek) {
    wanted = bw[2];
    padFilter = padFilter ?? `/Boek${bw[1]}/`;
  }
  const out: Array<{ openTag: string; xml: string; pad: string }> = [];
  const re = /<artikel\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toestandXml))) {
    const openTag = m[0];
    const pad = attr(openTag, "bwb-ng-variabel-deel") ?? "";
    const lastSeg = pad.split("/").pop() ?? "";
    const nrFromPad = lastSeg.replace(/^Artikel/i, "").toLowerCase();
    const label = (attr(openTag, "label") ?? "").replace(/^Artikel\s*/i, "").replace(/\s+/g, "").toLowerCase();
    if (nrFromPad !== wanted && label !== wanted) continue;
    if (padFilter && !pad.toLowerCase().includes(padFilter.toLowerCase())) continue;
    const end = toestandXml.indexOf("</artikel>", m.index);
    if (end < 0) continue;
    out.push({ openTag, xml: toestandXml.slice(m.index, end + "</artikel>".length), pad });
  }
  return out;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export class BwbArtikelSource {
  constructor(private readonly config: AppConfig) {}

  /** Stap 1: welke toestand (en XML-URL) gold op de gevraagde datum? */
  async resolveToestand(bwbId: string, datum: string) {
    const params = {
      "x-connection": "BWB",
      operation: "searchRetrieve",
      version: "1.2",
      query: `dcterms.identifier==${bwbId} and overheidbwb.geldigheidsdatum==${datum}`,
      maximumRecords: 1,
    };
    const { data, meta } = await getText(BWB_SRU_ENDPOINT, { query: params, connector: "wetten_bwb" });
    const xmlUrl = data.match(/<overheidbwb:locatie_toestand>([^<]+)<\/overheidbwb:locatie_toestand>/)?.[1];
    const toestand = data.match(/<overheidbwb:toestand>([^<]+)<\/overheidbwb:toestand>/)?.[1];
    const titel = data.match(/<dcterms:title>([^<]+)<\/dcterms:title>/)?.[1];
    return {
      xmlUrl: xmlUrl?.trim(),
      toestand: toestand?.trim(),
      titel: titel ? decodeEntities(titel.trim()) : undefined,
      endpoint: meta.url,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    };
  }

  async getArtikel(args: { bwbId: string; artikel: string; datum?: string; pad?: string }) {
    const bwbId = args.bwbId.trim().toUpperCase();
    if (!/^BWBR\d{7}$/.test(bwbId)) {
      throw new Error(`Ongeldig BWB-id "${args.bwbId}". Verwacht bijv. BWBR0019057; zoek het id met wetten_bwb_search.`);
    }
    const datum = args.datum ?? todayIso();
    const res = await this.resolveToestand(bwbId, datum);
    if (!res.xmlUrl) {
      return { items: [] as BwbArtikel[], total: 0, endpoint: res.endpoint, params: res.params,
        access_note: `Geen toestand van ${bwbId} gevonden die geldig was op ${datum}.` };
    }

    const { data: xml } = await getText(res.xmlUrl, {
      connector: "wetten_bwb",
      maxResponseBytes: MAX_TOESTAND_BYTES,
      timeoutMs: 30_000,
    });

    const hits = findArtikelen(xml, args.artikel, args.pad);
    const toestandDatum = res.toestand?.split("/")[5] ?? datum;
    const items: BwbArtikel[] = hits.map((h) => {
      const { kop, tekst } = artikelXmlToText(h.xml);
      const labelId = attr(h.openTag, "label-id");
      const nr = (h.pad.split("/").pop() ?? "").replace(/^Artikel/i, "") || normalizeArtikelNr(args.artikel);
      const padUrl = h.pad.replace(/^\//, "");
      const extId = `http://wetten.overheid.nl/id/${bwbId}/${toestandDatum}/0${h.pad}`;
      return {
        bwb_id: bwbId,
        titel_regeling: res.titel,
        artikel: nr,
        kop,
        pad: h.pad,
        label_id: labelId,
        inwerking: attr(h.openTag, "inwerking"),
        bron_wijziging: attr(h.openTag, "bron"),
        tekst,
        toestand: res.toestand ?? "",
        geldigheidsdatum: datum,
        wetten_url: `https://wetten.overheid.nl/${bwbId}/${toestandDatum}/0/${padUrl}`,
        jci: `jci1.3:c:${bwbId}&artikel=${nr}&g=${datum}&z=${datum}`,
        lido_url: `${LIDO_ORIGIN}/front/portal/linktool-bwb-verfijnen?ext-id=${encodeURIComponent(extId)}&geldigheidsdatum=${datum}&zichtdatum=${datum}`,
        lido_tekst_url: labelId
          ? `${LIDO_ORIGIN}/front/portal/component/bwb-zoek-toestand?bwb-id=${bwbId}&z=${datum}&g=${datum}&label-id=${labelId}`
          : undefined,
        xml_url: res.xmlUrl!,
      };
    });

    return {
      items,
      total: items.length,
      endpoint: res.xmlUrl,
      params: { ...res.params, artikel: args.artikel, ...(args.pad ? { pad: args.pad } : {}) },
      access_note:
        items.length === 0
          ? `Artikel ${args.artikel} niet gevonden in ${bwbId} (toestand ${toestandDatum}). Controleer het nummer of geef 'pad' mee (bijv. "Boek7").`
          : items.length > 1
            ? `Meerdere artikelen ${args.artikel} gevonden (bijv. in verschillende boeken/bijlagen). Verfijn met 'pad'.`
            : `Officiële tekst uit het Basiswettenbestand (KOOP), toestand geldig op ${datum}.`,
    };
  }
}

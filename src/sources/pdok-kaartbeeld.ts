import sharp from "sharp";
import type { AppConfig } from "../types.js";
import { getBinary, getText } from "../utils/http.js";
import { parseRdPoint, RD_EXTENT, type RdPoint } from "../utils/geo.js";
import { PdokSource } from "./pdok.js";

/**
 * PDOK kaartbeeld: a map image around one point, composed server-side from
 * PDOK WMS GetMap layers (WMS 1.3.0, EPSG:28992).
 *
 * The tools return data; this returns a picture: a base layer (luchtfoto, BRT
 * or BGT), the kadastrale kaart as transparent overlay and a marker on the
 * point. A layer that fails leaves the others standing (see `notes`).
 *
 * Layer names come from each service's GetCapabilities (cached per process):
 * PDOK renames layers between service versions, and a GetMap with a stale name
 * answers with an XML ServiceException instead of an image.
 */

export const KAARTBEELD_CONNECTOR = "pdok_wms";
export const KAARTBEELD_ATTRIBUTION = "© Kadaster / PDOK, Beeldmateriaal.nl";
/** Upper bound on the returned image, in bytes (before base64). */
export const KAARTBEELD_MAX_BYTES = 1_000_000;
export const KAARTBEELD_DEFAULT_LAYERS: KaartLaag[] = ["luchtfoto", "kadastrale_kaart"];
export const KAARTBEELD_LAYERS = ["luchtfoto", "kadastrale_kaart", "bgt", "brt"] as const;
export type KaartLaag = (typeof KAARTBEELD_LAYERS)[number];

export interface WmsService {
  label: string;
  url: string;
  /** Layer names to look for in GetCapabilities, best first (case-insensitive). */
  candidates: string[];
  format: "image/png" | "image/jpeg";
  transparent: boolean;
  /** Drawing order: lower is further down. */
  z: number;
}

export const WMS_SERVICES: Record<KaartLaag, WmsService> = {
  luchtfoto: {
    label: "Luchtfoto (Beeldmateriaal.nl, actueel HR)",
    url: "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0",
    candidates: ["Actueel_orthoHR", "Actueel_ortho25"],
    format: "image/jpeg",
    transparent: false,
    z: 0,
  },
  brt: {
    label: "BRT Achtergrondkaart",
    url: "https://service.pdok.nl/brt/achtergrondkaart/wms/v2_0",
    candidates: ["standaard", "grijs", "pastel"],
    format: "image/png",
    transparent: true,
    z: 1,
  },
  bgt: {
    label: "BGT (Basisregistratie Grootschalige Topografie)",
    url: "https://service.pdok.nl/lv/bgt/wms/v1_0",
    candidates: ["standaardvisualisatie", "achtergrondvisualisatie", "omtrekgerichtevisualisatie"],
    format: "image/png",
    transparent: true,
    z: 2,
  },
  kadastrale_kaart: {
    label: "Kadastrale kaart (BRK)",
    url: "https://service.pdok.nl/kadaster/kadastralekaart/wms/v5_0",
    candidates: ["Kadastralekaart", "KadastraleKaart", "kadastralekaart", "Perceel", "KadastraleGrens"],
    format: "image/png",
    transparent: true,
    z: 3,
  },
};

export type Bbox = [number, number, number, number];

/**
 * Bbox around an RD point with square pixels: `straalM` is the half-extent of
 * the shorter image side, the longer side follows the aspect ratio. Rounded to
 * centimetres so the GetMap URLs are stable (and cacheable upstream).
 */
export function kaartBbox(center: RdPoint, straalM: number, breedte: number, hoogte: number): Bbox {
  const [x, y] = center;
  const halfW = breedte >= hoogte ? straalM * (breedte / hoogte) : straalM;
  const halfH = hoogte > breedte ? straalM * (hoogte / breedte) : straalM;
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r(x - halfW), r(y - halfH), r(x + halfW), r(y + halfH)];
}

/** Whether an RD point lies in the Netherlands extent the services cover. */
export function isRdPointInExtent([x, y]: RdPoint): boolean {
  return x >= RD_EXTENT.minX && x <= RD_EXTENT.maxX && y >= RD_EXTENT.minY && y <= RD_EXTENT.maxY;
}

/** Pixel position of an RD point in the image of `bbox`. */
export function rdToPixel([x, y]: RdPoint, bbox: Bbox, breedte: number, hoogte: number): [number, number] {
  const [minx, miny, maxx, maxy] = bbox;
  return [((x - minx) / (maxx - minx)) * breedte, ((maxy - y) / (maxy - miny)) * hoogte];
}

/** Every <Name> of a <Layer> in a WMS GetCapabilities document. */
export function parseWmsLayerNames(xml: string): string[] {
  const names: string[] = [];
  const layerRe = /<(?:\w+:)?Layer\b[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<(?:\w+:)?Name>\s*([^<]+?)\s*<\/(?:\w+:)?Name>/g;
  let m: RegExpExecArray | null;
  while ((m = layerRe.exec(xml))) names.push(m[1]);
  return names;
}

/** The first candidate the capabilities list (case-insensitive), as the service spells it. */
export function pickLayerName(available: string[], candidates: string[]): string | undefined {
  for (const c of candidates) {
    const hit = available.find((a) => a.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** The text of a WMS ServiceException, for a GetMap that answered with XML instead of an image. */
export function parseServiceException(body: string): string | undefined {
  const m = body.match(/<(?:\w+:)?ServiceException\b[^>]*>([\s\S]*?)<\/(?:\w+:)?ServiceException>/);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

export interface LaagResultaat {
  laag: KaartLaag;
  status: "ok" | "mislukt";
  layer_name: string;
  getmap_url: string;
  params: Record<string, string>;
  fout?: string;
  /** Raw image bytes; left out of what the tool reports. */
  data?: Uint8Array;
}

export interface KaartbeeldArgs {
  adres?: string;
  rd_x?: number;
  rd_y?: number;
  straal_m?: number;
  lagen?: KaartLaag[];
  breedte?: number;
  hoogte?: number;
  markering?: boolean;
}

export interface KaartbeeldResult {
  image?: Buffer;
  mimeType?: "image/png" | "image/jpeg";
  width: number;
  height: number;
  bbox: Bbox;
  center: RdPoint;
  adres?: { query: string; weergavenaam?: string; endpoint: string; params: Record<string, string> };
  straal_m: number;
  lagen: Omit<LaagResultaat, "data">[];
  notes: string[];
  timestamp: string;
}

export class KaartbeeldInputError extends Error {}

const capabilitiesCache = new Map<string, Promise<string[]>>();

/** For tests: forget the GetCapabilities answers. */
export function clearKaartbeeldCapabilities(): void {
  capabilitiesCache.clear();
}

/** Layer opacity when drawn over a luchtfoto: a topographic map on top would hide the photo. */
const OVER_LUCHTFOTO_OPACITY = 0.55;

export class PdokKaartbeeldSource {
  private readonly pdok: PdokSource;

  constructor(config: AppConfig) {
    this.pdok = new PdokSource(config);
  }

  /** Address → RD point via the PDOK Locatieserver (addresses first, then any location type). */
  async resolveAdres(query: string): Promise<{ center: RdPoint; weergavenaam?: string; endpoint: string; params: Record<string, string> }> {
    const adres = await this.pdok.bagLookupAddress({ query, rows: 1 });
    let doc = adres.items[0];
    let endpoint = adres.endpoint;
    let params: Record<string, string> = adres.params;
    if (!parseRdPoint(doc?.centroide_rd)) {
      const any = await this.pdok.search({ query, rows: 1 });
      doc = any.items[0];
      endpoint = any.endpoint;
      params = any.params;
    }
    const center = parseRdPoint(doc?.centroide_rd);
    if (!center) throw new KaartbeeldInputError(`Adres of locatie '${query}' niet gevonden in de PDOK Locatieserver.`);
    return { center, weergavenaam: doc?.weergavenaam, endpoint, params };
  }

  /** The layer name to request, checked against GetCapabilities; the first candidate when that fails. */
  async layerName(laag: KaartLaag): Promise<{ name: string; note?: string }> {
    const service = WMS_SERVICES[laag];
    let pending = capabilitiesCache.get(service.url);
    if (!pending) {
      pending = getText(service.url, {
        query: { SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetCapabilities" },
        connector: KAARTBEELD_CONNECTOR,
        timeoutMs: 15_000,
        retries: 1,
      }).then(({ data }) => parseWmsLayerNames(data));
      capabilitiesCache.set(service.url, pending);
      // A failed lookup is retried on the next call, not cached.
      pending.catch(() => capabilitiesCache.delete(service.url));
    }
    try {
      const available = await pending;
      const name = pickLayerName(available, service.candidates);
      if (name) return { name };
      return { name: service.candidates[0], note: `${laag}: geen van de verwachte laagnamen (${service.candidates.join(", ")}) in GetCapabilities; '${service.candidates[0]}' geprobeerd.` };
    } catch {
      return { name: service.candidates[0], note: `${laag}: GetCapabilities niet bereikbaar; standaardlaagnaam '${service.candidates[0]}' gebruikt.` };
    }
  }

  async fetchLaag(laag: KaartLaag, bbox: Bbox, breedte: number, hoogte: number): Promise<LaagResultaat & { note?: string }> {
    const service = WMS_SERVICES[laag];
    const { name, note } = await this.layerName(laag);
    const params: Record<string, string> = {
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetMap",
      LAYERS: name,
      STYLES: "",
      CRS: "EPSG:28992",
      BBOX: bbox.join(","),
      WIDTH: String(breedte),
      HEIGHT: String(hoogte),
      FORMAT: service.format,
      TRANSPARENT: service.transparent ? "TRUE" : "FALSE",
    };
    const url = new URL(service.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const base = { laag, layer_name: name, getmap_url: url.toString(), params, note };
    try {
      const { data, contentType } = await getBinary(service.url, { query: params, connector: KAARTBEELD_CONNECTOR, timeoutMs: 20_000, retries: 1 });
      if (!contentType.startsWith("image/")) {
        const text = new TextDecoder().decode(data.slice(0, 4000));
        return { ...base, status: "mislukt", fout: `geen afbeelding ontvangen (${contentType || "onbekend type"})${parseServiceException(text) ? `: ${parseServiceException(text)}` : ""}` };
      }
      return { ...base, status: "ok", data };
    } catch (error) {
      return { ...base, status: "mislukt", fout: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }

  async kaartbeeld(args: KaartbeeldArgs): Promise<KaartbeeldResult> {
    const breedte = clampInt(args.breedte ?? 800, 64, 1600);
    const hoogte = clampInt(args.hoogte ?? 800, 64, 1600);
    const straal = clampNumber(args.straal_m ?? 60, 5, 500);
    const lagen = uniqueLayers(args.lagen?.length ? args.lagen : KAARTBEELD_DEFAULT_LAYERS);
    const notes: string[] = [];

    let center: RdPoint;
    let adres: KaartbeeldResult["adres"];
    if (typeof args.rd_x === "number" && typeof args.rd_y === "number") {
      center = [args.rd_x, args.rd_y];
      if (args.adres) notes.push("rd_x/rd_y opgegeven: het adres is niet opgezocht.");
    } else if (args.adres?.trim()) {
      const resolved = await this.resolveAdres(args.adres.trim());
      center = resolved.center;
      adres = { query: args.adres.trim(), weergavenaam: resolved.weergavenaam, endpoint: resolved.endpoint, params: resolved.params };
    } else {
      throw new KaartbeeldInputError("Geef een adres of rd_x en rd_y (EPSG:28992).");
    }
    if (!isRdPointInExtent(center)) throw new KaartbeeldInputError(`Punt ${center.join(", ")} ligt buiten het RD-bereik van Nederland (EPSG:28992).`);

    const bbox = kaartBbox(center, straal, breedte, hoogte);
    const fetched = await Promise.all(lagen.map((laag) => this.fetchLaag(laag, bbox, breedte, hoogte)));
    for (const f of fetched) {
      if (f.note) notes.push(f.note);
      if (f.status === "mislukt") notes.push(`Laag ${f.laag} mislukt: ${f.fout}`);
    }
    const ok = fetched.filter((f) => f.status === "ok" && f.data);
    const lagenReport = fetched.map(({ data: _data, note: _note, ...rest }) => rest);
    const base = { width: breedte, height: hoogte, bbox, center, adres, straal_m: straal, lagen: lagenReport, notes, timestamp: new Date().toISOString() };
    if (!ok.length) return base;

    const hasLuchtfoto = ok.some((f) => f.laag === "luchtfoto");
    const layers = ok
      .sort((a, b) => WMS_SERVICES[a.laag].z - WMS_SERVICES[b.laag].z)
      .map((f) => ({
        data: f.data as Uint8Array,
        opacity: hasLuchtfoto && (f.laag === "brt" || f.laag === "bgt") ? OVER_LUCHTFOTO_OPACITY : 1,
      }));
    const marker = args.markering === false ? undefined : rdToPixel(center, bbox, breedte, hoogte);
    const composed = await composeKaartbeeld(layers, breedte, hoogte, marker);
    const encoded = await encodeWithinLimit(composed, { photo: hasLuchtfoto, maxBytes: KAARTBEELD_MAX_BYTES });
    if (encoded.note) notes.push(encoded.note);
    return { ...base, image: encoded.data, mimeType: encoded.mimeType, width: encoded.width, height: encoded.height };
  }
}

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNumber(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function uniqueLayers(lagen: KaartLaag[]): KaartLaag[] {
  return [...new Set(lagen)].filter((l) => l in WMS_SERVICES);
}

/** Multiply the alpha channel of an image by `opacity`. */
async function withOpacity(input: Uint8Array, width: number, height: number, opacity: number): Promise<Buffer> {
  const { data, info } = await sharp(input).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += info.channels) data[i] = Math.round(data[i] * opacity);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}

/** Red circle with a white edge and a crosshair, as SVG for compositing. */
export function markerSvg(width: number, height: number, [px, py]: [number, number]): string {
  const r = Math.max(8, Math.round(Math.min(width, height) / 50));
  const arm = r * 2;
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="white" stroke-width="5"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#e00000" stroke-width="2.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    line(px - arm - r, py, px - r, py) + line(px + r, py, px + arm + r, py) + line(px, py - arm - r, px, py - r) + line(px, py + r, px, py + arm + r) +
    `<circle cx="${px}" cy="${py}" r="${r}" fill="none" stroke="white" stroke-width="6"/>` +
    `<circle cx="${px}" cy="${py}" r="${r}" fill="none" stroke="#e00000" stroke-width="3"/>` +
    `<circle cx="${px}" cy="${py}" r="2.5" fill="#e00000"/></svg>`;
}

/**
 * Stack the layers (first = bottom) on a white canvas and draw the marker.
 * Returns a lossless PNG; encodeWithinLimit picks the final format.
 */
export async function composeKaartbeeld(
  layers: Array<{ data: Uint8Array; opacity?: number }>,
  width: number,
  height: number,
  marker?: [number, number],
): Promise<Buffer> {
  const overlays: sharp.OverlayOptions[] = [];
  for (const layer of layers) {
    const opacity = layer.opacity ?? 1;
    const input = opacity < 1
      ? await withOpacity(layer.data, width, height, opacity)
      : await sharp(layer.data).resize(width, height, { fit: "fill" }).png().toBuffer();
    overlays.push({ input, top: 0, left: 0 });
  }
  if (marker) overlays.push({ input: Buffer.from(markerSvg(width, height, marker)), top: 0, left: 0 });
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(overlays)
    .png()
    .toBuffer();
}

/**
 * Encode under `maxBytes`: PNG first; for a photo JPEG at falling quality,
 * for a map a palette PNG first; then smaller dimensions.
 */
export async function encodeWithinLimit(
  png: Buffer,
  opts: { photo: boolean; maxBytes: number },
): Promise<{ data: Buffer; mimeType: "image/png" | "image/jpeg"; width: number; height: number; note?: string }> {
  const meta = await sharp(png).metadata();
  const width0 = meta.width ?? 0;
  const height0 = meta.height ?? 0;
  const lossless = await sharp(png).png({ compressionLevel: 9 }).toBuffer();
  if (lossless.length <= opts.maxBytes) return { data: lossless, mimeType: "image/png", width: width0, height: height0 };

  for (const scale of [1, 0.75, 0.5, 0.35]) {
    const width = Math.max(1, Math.round(width0 * scale));
    const height = Math.max(1, Math.round(height0 * scale));
    const resized = () => sharp(png).resize(width, height);
    const shrunk = scale < 1 ? `, verkleind naar ${width}×${height} px` : "";
    if (!opts.photo) {
      const palette = await resized().png({ palette: true, compressionLevel: 9 }).toBuffer();
      if (palette.length <= opts.maxBytes) return { data: palette, mimeType: "image/png", width, height, note: `Afbeelding als PNG met kleurenpalet gecomprimeerd${shrunk} (limiet ${opts.maxBytes} bytes).` };
    }
    for (const quality of [85, 75, 65]) {
      const jpeg = await resized().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (jpeg.length <= opts.maxBytes) return { data: jpeg, mimeType: "image/jpeg", width, height, note: `Afbeelding als JPEG (kwaliteit ${quality}) gecomprimeerd${shrunk} om onder ${opts.maxBytes} bytes te blijven.` };
    }
  }
  const width = Math.max(1, Math.round(width0 * 0.25));
  const height = Math.max(1, Math.round(height0 * 0.25));
  const last = await sharp(png).resize(width, height).jpeg({ quality: 60 }).toBuffer();
  return { data: last, mimeType: "image/jpeg", width, height, note: `Afbeelding sterk verkleind naar ${width}×${height} px (JPEG) om onder ${opts.maxBytes} bytes te blijven.` };
}

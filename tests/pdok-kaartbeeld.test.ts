import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { loadConfig } from "../src/config.js";
import {
  PdokKaartbeeldSource,
  clearKaartbeeldCapabilities,
  composeKaartbeeld,
  encodeWithinLimit,
  kaartBbox,
  parseServiceException,
  parseWmsLayerNames,
  pickLayerName,
  rdToPixel,
  KAARTBEELD_ATTRIBUTION,
  MAX_TILES,
  RD_TILES,
  parseWmtsCapabilities,
  planTiles,
  wmtsTileUrl,
} from "../src/sources/pdok-kaartbeeld.js";
import { kaartbeeldPayload } from "../src/utils/kaartbeeld-payload.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { detectKaartbeeldIntent } from "../src/router/intents.js";
import { routeChain, type RouteFacts } from "../src/router/routes.js";

const config = loadConfig();

/** Visstraat 19, 3311 KX Dordrecht. */
const VISSTRAAT: [number, number] = [105255.6, 425245.7];

const CAPABILITIES = (names: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Capability><Layer><Title>root</Title>
    ${names.map((n) => `<Layer queryable="1"><Name>${n}</Name><Title>${n}</Title></Layer>`).join("\n    ")}
  </Layer></Capability>
</WMS_Capabilities>`;

const SERVICE_EXCEPTION = `<?xml version="1.0"?><ServiceExceptionReport version="1.3.0" xmlns="http://www.opengis.net/ogc">
  <ServiceException code="LayerNotDefined">Layer 'Kadastralekaart' not defined</ServiceException></ServiceExceptionReport>`;

async function solid(width: number, height: number, rgb: { r: number; g: number; b: number }, format: "jpeg" | "png"): Promise<Buffer> {
  const img = sharp({ create: { width, height, channels: 3, background: rgb } });
  return format === "jpeg" ? img.jpeg().toBuffer() : img.png().toBuffer();
}

/** Transparent PNG with one opaque blue vertical line at x = `lineX`. */
async function overlayWithLine(width: number, height: number, lineX: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${lineX}" y="0" width="4" height="${height}" fill="#0000ff"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pixel(img: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

function binary(body: Buffer | string, contentType: string, status = 200): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": contentType } });
}

/**
 * fetch for the PDOK services: GetCapabilities per service, GetMap per layer,
 * the Locatieserver for addresses. `getmap` decides each layer's answer.
 */
function pdokFetch(getmap: (url: URL) => Promise<Response> | Response) {
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.hostname === "api.pdok.nl") {
      return binary(JSON.stringify({ response: { numFound: 1, docs: [{ id: "adr-1", weergavenaam: "Visstraat 19, 3311KX Dordrecht", type: "adres", huisnummer: 19, postcode: "3311KX", centroide_rd: "POINT(105255.6 425245.7)" }] } }), "application/json");
    }
    if (url.searchParams.get("REQUEST") === "GetCapabilities") {
      if (url.pathname.includes("luchtfotorgb")) return binary(CAPABILITIES(["Actueel_ortho25", "Actueel_orthoHR", "2023_orthoHR"]), "text/xml");
      if (url.pathname.includes("kadastralekaart")) return binary(CAPABILITIES(["Kadastralekaart", "Perceel", "KadastraleGrens", "Label"]), "text/xml");
      if (url.pathname.includes("bgt")) return binary(CAPABILITIES(["achtergrondvisualisatie", "standaardvisualisatie"]), "text/xml");
      return binary(CAPABILITIES(["standaard", "grijs", "pastel", "water"]), "text/xml");
    }
    return getmap(url);
  });
}

describe("pdok_kaartbeeld: bbox", () => {
  it("puts a square bbox of 2 × straal around the point", () => {
    expect(kaartBbox(VISSTRAAT, 60, 800, 800)).toEqual([105195.6, 425185.7, 105315.6, 425305.7]);
  });

  it("keeps pixels square for a wide or tall image: straal is the shorter half-side", () => {
    const [minx, miny, maxx, maxy] = kaartBbox(VISSTRAAT, 60, 1200, 800);
    expect(maxx - minx).toBeCloseTo(180, 6);
    expect(maxy - miny).toBeCloseTo(120, 6);
    const tall = kaartBbox(VISSTRAAT, 100, 400, 800);
    expect(tall[2] - tall[0]).toBeCloseTo(200, 6);
    expect(tall[3] - tall[1]).toBeCloseTo(400, 6);
  });

  it("maps the point to the image centre, and north to the top", () => {
    const bbox = kaartBbox(VISSTRAAT, 60, 800, 600);
    expect(rdToPixel(VISSTRAAT, bbox, 800, 600)).toEqual([400, 300]);
    const [, top] = rdToPixel([VISSTRAAT[0], VISSTRAAT[1] + 30], bbox, 800, 600);
    expect(top).toBeLessThan(300);
  });
});

describe("pdok_kaartbeeld: layer names from GetCapabilities", () => {
  it("reads the layer names and picks the first known candidate as the service spells it", () => {
    const names = parseWmsLayerNames(CAPABILITIES(["Actueel_ortho25", "Actueel_orthoHR"]));
    expect(names).toEqual(["Actueel_ortho25", "Actueel_orthoHR"]);
    expect(pickLayerName(names, ["actueel_orthohr", "Actueel_ortho25"])).toBe("Actueel_orthoHR");
    expect(pickLayerName(names, ["Kadastralekaart"])).toBeUndefined();
  });

  it("reads the message of a ServiceException", () => {
    expect(parseServiceException(SERVICE_EXCEPTION)).toBe("Layer 'Kadastralekaart' not defined");
  });
});

describe("pdok_kaartbeeld: address to RD", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
  });

  it("resolves an address via the PDOK Locatieserver to its RD centroid", async () => {
    const fetchMock = pdokFetch(() => binary("", "text/plain", 404));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new PdokKaartbeeldSource(config).resolveAdres("Visstraat 19, 3311 KX Dordrecht");

    expect(out.center).toEqual(VISSTRAAT);
    expect(out.weergavenaam).toBe("Visstraat 19, 3311KX Dordrecht");
    const called = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(called.pathname).toContain("/bzk/locatieserver/search/v3_1/free");
    expect(called.searchParams.get("q")).toBe("Visstraat 19, 3311 KX Dordrecht");
    expect(called.searchParams.get("fq")).toBe("type:adres");
  });
});

describe("pdok_kaartbeeld: compositing", () => {
  it("stacks base, transparent overlay and marker in that order", async () => {
    const base = await solid(200, 200, { r: 0, g: 160, b: 0 }, "jpeg");
    const overlay = await overlayWithLine(200, 200, 40);
    const out = await composeKaartbeeld([{ data: base }, { data: overlay }], 200, 200, [100, 100]);

    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([200, 200]);
    const [r1, g1, b1] = await pixel(out, 10, 10); // base shows through the transparent overlay
    expect(g1).toBeGreaterThan(120);
    expect(r1 + b1).toBeLessThan(60);
    const [, , b2] = await pixel(out, 41, 10); // the overlay line
    expect(b2).toBeGreaterThan(200);
    const ring = Math.max(8, Math.round(200 / 50));
    const [r3, g3] = await pixel(out, 100 + ring, 100); // the red marker ring
    expect(r3).toBeGreaterThan(180);
    expect(g3).toBeLessThan(80);
  });

  it("scales a layer delivered at another size to the canvas", async () => {
    const small = await solid(50, 50, { r: 0, g: 0, b: 255 }, "png");
    const out = await composeKaartbeeld([{ data: small }], 120, 80);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([120, 80]);
    expect((await pixel(out, 110, 70))[2]).toBeGreaterThan(200);
  });

  it("stays under the size limit: JPEG for a photo, smaller when needed", async () => {
    const noise = Buffer.alloc(600 * 600 * 3);
    let seed = 0x2545f491;
    for (let i = 0; i < noise.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      noise[i] = seed & 0xff;
    }
    const png = await sharp(noise, { raw: { width: 600, height: 600, channels: 3 } }).png().toBuffer();
    expect(png.length).toBeGreaterThan(200_000);

    const out = await encodeWithinLimit(png, { photo: true, maxBytes: 200_000 });
    expect(out.data.length).toBeLessThanOrEqual(200_000);
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.note).toMatch(/JPEG/);
  });

  it("keeps a small map as lossless PNG", async () => {
    const png = await solid(300, 300, { r: 255, g: 255, b: 255 }, "png");
    const out = await encodeWithinLimit(png, { photo: false, maxBytes: 1_000_000 });
    expect(out.mimeType).toBe("image/png");
    expect(out.note).toBeUndefined();
  });
});

describe("pdok_kaartbeeld: one layer fails", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
    clearKaartbeeldCapabilities();
  });

  it("returns the image of the layers that worked, and names the failed one", async () => {
    const luchtfoto = await solid(400, 300, { r: 90, g: 120, b: 60 }, "jpeg");
    const fetchMock = pdokFetch((url) =>
      url.pathname.includes("luchtfotorgb") ? binary(luchtfoto, "image/jpeg") : binary(SERVICE_EXCEPTION, "text/xml"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await new PdokKaartbeeldSource(config).kaartbeeld({ adres: "Visstraat 19, 3311 KX Dordrecht", breedte: 400, hoogte: 300 });

    expect(out.image).toBeDefined();
    expect(out.mimeType).toBe("image/png");
    expect(out.lagen.map((l) => [l.laag, l.status])).toEqual([["luchtfoto", "ok"], ["kadastrale_kaart", "mislukt"]]);
    expect(out.notes.join(" ")).toContain("kadastrale_kaart mislukt");
    expect(out.notes.join(" ")).toContain("Layer 'Kadastralekaart' not defined");

    // The GetMap request: WMS 1.3.0, RD, the bbox around the address, the name from GetCapabilities.
    const getmap = fetchMock.mock.calls
      .map((c) => new URL(String((c as unknown[])[0])))
      .find((u) => u.searchParams.get("REQUEST") === "GetMap" && u.pathname.includes("luchtfotorgb"))!;
    expect(getmap.searchParams.get("VERSION")).toBe("1.3.0");
    expect(getmap.searchParams.get("CRS")).toBe("EPSG:28992");
    expect(getmap.searchParams.get("LAYERS")).toBe("Actueel_orthoHR");
    expect(getmap.searchParams.get("BBOX")).toBe("105175.6,425185.7,105335.6,425305.7");
    expect(getmap.searchParams.get("WIDTH")).toBe("400");

    const payload = kaartbeeldPayload(out, "pdok_kaartbeeld");
    expect(payload.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    const text = JSON.parse((payload.content[1] as { text: string }).text);
    expect(text.access_note).toContain(KAARTBEELD_ATTRIBUTION);
    expect(text.access_note).toContain("kadastrale_kaart mislukt");
    expect(text.provenance.tool).toBe("pdok_kaartbeeld");
    expect(text.provenance.query_params.bbox).toBe("105175.6,425185.7,105335.6,425305.7");
    expect(text.provenance.query_params.getmap_luchtfoto).toContain("REQUEST=GetMap");
    expect(text.records[0].data.bronvermelding).toBe(KAARTBEELD_ATTRIBUTION);
    expect(text.summary).toContain("mislukt: kadastrale_kaart");
  });

  it("returns an error and no image when every layer fails", async () => {
    vi.stubGlobal("fetch", pdokFetch(() => binary(SERVICE_EXCEPTION, "text/xml")));

    const out = await new PdokKaartbeeldSource(config).kaartbeeld({ rd_x: VISSTRAAT[0], rd_y: VISSTRAAT[1], breedte: 200, hoogte: 200 });
    expect(out.image).toBeUndefined();

    const payload = kaartbeeldPayload(out, "pdok_kaartbeeld");
    expect(payload.content).toHaveLength(1);
    expect(JSON.parse((payload.content[0] as { text: string }).text).error).toBe("http_error");
  });

  it("uses the first candidate name when GetCapabilities does not answer", async () => {
    const luchtfoto = await solid(200, 200, { r: 90, g: 120, b: 60 }, "jpeg");
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.searchParams.get("REQUEST") === "GetCapabilities") return binary("not found", "text/plain", 404);
      return binary(luchtfoto, "image/jpeg");
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new PdokKaartbeeldSource(config).kaartbeeld({ rd_x: VISSTRAAT[0], rd_y: VISSTRAAT[1], lagen: ["luchtfoto"], breedte: 200, hoogte: 200, markering: false });
    expect(out.image).toBeDefined();
    expect(out.lagen[0].layer_name).toBe("Actueel_orthoHR");
    expect(out.notes.join(" ")).toContain("GetCapabilities niet bereikbaar");
  });

  it("refuses a point outside the Netherlands", async () => {
    await expect(new PdokKaartbeeldSource(config).kaartbeeld({ rd_x: 900000, rd_y: 100 })).rejects.toThrow(/buiten het RD-bereik/);
  });
});

describe("nl_gov_ask: kaartbeeld route", () => {
  it("reads the address and the layers from a picture request", () => {
    expect(detectKaartbeeldIntent("Laat een luchtfoto zien van Visstraat 19, 3311 KX Dordrecht")).toEqual({ adres: "Visstraat 19, 3311 KX Dordrecht", lagen: ["luchtfoto", "kadastrale_kaart"] });
    expect(detectKaartbeeldIntent("Kaart van Visstraat 19 Dordrecht")?.adres).toBe("Visstraat 19 Dordrecht");
    expect(detectKaartbeeldIntent("Toon Visstraat 19 Dordrecht op de kaart")?.adres).toBe("Visstraat 19 Dordrecht");
    expect(detectKaartbeeldIntent("Kadastrale kaart van De Bilt")?.adres).toBe("De Bilt");
    expect(detectKaartbeeldIntent("Plattegrond rond Dam 1 Amsterdam")?.lagen).toEqual(["brt", "kadastrale_kaart"]);
  });

  it("leaves rules, documents and data at an address to the other routes", () => {
    expect(detectKaartbeeldIntent("Welke regels gelden op Visstraat 19 Dordrecht?")).toBeUndefined();
    expect(detectKaartbeeldIntent("Mag ik een dakkapel plaatsen op Visstraat 19 Dordrecht?")).toBeUndefined();
    expect(detectKaartbeeldIntent("Laat zien welke moties over stikstof zijn aangenomen")).toBeUndefined();
    expect(detectKaartbeeldIntent("luchtfoto datasets van PDOK")).toBeUndefined();
    expect(detectKaartbeeldIntent("Hoeveel inwoners heeft Utrecht?")).toBeUndefined();
  });

  it("takes the kaartbeeld route after the DSO and before the catalogue", () => {
    const facts: RouteFacts = { q: "luchtfoto van visstraat 19 dordrecht", place: undefined, eu: false, dso: false, kaartbeeld: true, ecli: false, foreignEcli: false, wetArtikel: false, research: undefined, debat: false, algoritme: false, multi: false, multiSources: [], budget: false, rechtspraak: false, rijk: false, oriGemeente: false, policy: undefined, policyMunicipal: false };
    expect(routeChain(facts)[0]).toBe("kaartbeeld");
    expect(routeChain({ ...facts, dso: true }).slice(0, 2)).toEqual(["dso", "kaartbeeld"]);
  });
});

const WMTS_CAPS = (layers: string[], base: string, levels = 15) => `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
  <Contents>
    ${layers.map((l) => `<Layer>
      <ows:Title>${l}</ows:Title>
      <ows:Identifier>${l}</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style>
      <Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>EPSG:28992</TileMatrixSet></TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="${base}/${l}/{TileMatrixSet}/{TileMatrix}/{TileCol}/{TileRow}.png"/>
    </Layer>`).join("\n    ")}
    <TileMatrixSet>
      <ows:Identifier>EPSG:3857</ows:Identifier>
      <TileMatrix><ows:Identifier>00</ows:Identifier></TileMatrix>
    </TileMatrixSet>
    <TileMatrixSet>
      <ows:Identifier>EPSG:28992</ows:Identifier>
      ${Array.from({ length: levels }, (_, i) => `<TileMatrix><ows:Identifier>${String(i).padStart(2, "0")}</ows:Identifier><ScaleDenominator>1</ScaleDenominator></TileMatrix>`).join("")}
    </TileMatrixSet>
  </Contents>
</Capabilities>`;

describe("pdok_kaartbeeld: WMTS tiles (BRT, BGT)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
    clearKaartbeeldCapabilities();
  });

  it("reads layers, their tile template and the EPSG:28992 levels from WMTS GetCapabilities", () => {
    const caps = parseWmtsCapabilities(WMTS_CAPS(["standaard", "grijs"], "https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0"));
    expect(caps.layers).toEqual(["standaard", "grijs"]);
    expect(caps.templates.standaard).toBe("https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/{TileMatrixSet}/{TileMatrix}/{TileCol}/{TileRow}.png");
    expect(caps.maxZoom).toBe(14);
    expect(caps.matrixIds[3]).toBe("03");
    expect(wmtsTileUrl(caps.templates.standaard, caps.matrixIds[14], 7, 9)).toBe("https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:28992/14/7/9.png");
  });

  it("picks the level just sharper than asked, within the service's levels, and puts the bbox in the mosaic", () => {
    const bbox = kaartBbox(VISSTRAAT, 60, 800, 800);
    const plan = planTiles(bbox, 800, 16);
    expect(plan.zoom).toBe(15); // 0.105 m/px for the 0.15 m/px asked
    expect(plan.res).toBeCloseTo(3440.64 / 2 ** 15, 9);
    const span = 256 * plan.res;
    // The mosaic's top-left corner plus the crop offset is the bbox's top-left corner.
    expect(RD_TILES.originX + plan.colMin * span + plan.crop.left * plan.res).toBeCloseTo(bbox[0], 0);
    expect(RD_TILES.originY - plan.rowMin * span - plan.crop.top * plan.res).toBeCloseTo(bbox[3], 0);
    expect(plan.crop.width).toBe(Math.round(120 / plan.res));
    expect(planTiles(bbox, 800, 14).zoom).toBe(14);
  });

  it("takes a coarser level rather than more than MAX_TILES tiles", () => {
    const bbox = kaartBbox(VISSTRAAT, 500, 1600, 1600);
    const plan = planTiles(bbox, 1600, 16);
    expect((plan.colMax - plan.colMin + 1) * (plan.rowMax - plan.rowMin + 1)).toBeLessThanOrEqual(MAX_TILES);
  });

  it("stitches the tiles and cuts them to the bbox: the tile under the point lands in the image centre", async () => {
    const base = "https://service.pdok.nl/lv/bgt/wmts/v1_0";
    const bbox = kaartBbox(VISSTRAAT, 60, 400, 400);
    const plan = planTiles(bbox, 400, 16);
    const span = 256 * plan.res;
    const pointCol = Math.floor((VISSTRAAT[0] - RD_TILES.originX) / span);
    const pointRow = Math.floor((RD_TILES.originY - VISSTRAAT[1]) / span);
    const red = await solid(256, 256, { r: 220, g: 0, b: 0 }, "png");
    const grey = await solid(256, 256, { r: 200, g: 200, b: 200 }, "png");
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.searchParams.get("REQUEST") === "GetCapabilities") return binary(WMTS_CAPS(["standaardvisualisatie"], base, 17), "text/xml");
      const m = /\/standaardvisualisatie\/EPSG:28992\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
      if (!m) return binary("", "text/plain", 404);
      return binary(Number(m[2]) === pointCol && Number(m[3]) === pointRow ? red : grey, "image/png");
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await new PdokKaartbeeldSource(config).kaartbeeld({ rd_x: VISSTRAAT[0], rd_y: VISSTRAAT[1], lagen: ["bgt"], breedte: 400, hoogte: 400, markering: false });

    expect(out.lagen[0]).toMatchObject({ laag: "bgt", status: "ok", layer_name: "standaardvisualisatie" });
    expect(plan.zoom).toBe(14); // 0.105 m/px is not needed for 0.3 m/px
    expect(out.lagen[0].params.TILEMATRIX).toBe("14");
    expect(out.lagen[0].getmap_url).toMatch(/\/lv\/bgt\/wmts\/v1_0\/standaardvisualisatie\/EPSG:28992\/14\/\d+\/\d+\.png$/);
    const [r, g] = await pixel(out.image!, 200, 200);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(60);
    const tileCount = (plan.colMax - plan.colMin + 1) * (plan.rowMax - plan.rowMin + 1);
    expect(fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).endsWith(".png"))).toHaveLength(tileCount);
  });

  it("tries the next coarser level once when the deepest has no tiles", async () => {
    const tile = await solid(256, 256, { r: 240, g: 240, b: 200 }, "png");
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.searchParams.get("REQUEST") === "GetCapabilities") return binary("unavailable", "text/plain", 404);
      return /\/EPSG:28992\/14\//.test(url.pathname) ? binary("not found", "text/plain", 404) : binary(tile, "image/png");
    }));

    const out = await new PdokKaartbeeldSource(config).kaartbeeld({ rd_x: VISSTRAAT[0], rd_y: VISSTRAAT[1], lagen: ["brt"], breedte: 300, hoogte: 300 });

    expect(out.lagen[0]).toMatchObject({ laag: "brt", status: "ok", layer_name: "standaard" });
    expect(out.lagen[0].params.TILEMATRIX).toBe("13");
    expect(out.lagen[0].getmap_url).toContain("https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/standaard/EPSG:28992/13/");
    expect(out.image).toBeDefined();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { clearKaartbeeldCapabilities } from "../src/sources/pdok-kaartbeeld.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Handler = (args: Record<string, unknown>) => Promise<{ content: Content[] }>;
const tools = new Map<string, { schema: Record<string, { parse: (v: unknown) => unknown }>; handler: Handler }>();
registerTools({
  registerTool(name: string, cfg: { inputSchema?: Record<string, { parse: (v: unknown) => unknown }> }, handler: Handler) {
    tools.set(name, { schema: cfg.inputSchema ?? {}, handler });
  },
} as unknown as McpServer);

async function call(name: string, args: Record<string, unknown>): Promise<Content[]> {
  const tool = tools.get(name)!;
  const parsed: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.schema)) parsed[key] = schema.parse(args[key]);
  return (await tool.handler(parsed)).content;
}

const json = (c: Content | undefined) => JSON.parse(c?.text ?? "{}");

const LOCATIESERVER = { response: { numFound: 1, docs: [{ id: "adr-visstraat-19", weergavenaam: "Visstraat 19, 3311KX Dordrecht", type: "adres", huisnummer: 19, postcode: "3311KX", gemeentenaam: "Dordrecht", centroide_rd: "POINT(105255.6 425245.7)" }] } };
const CAPS = (names: string[]) => `<WMS_Capabilities version="1.3.0"><Capability><Layer>${names.map((n) => `<Layer><Name>${n}</Name></Layer>`).join("")}</Layer></Capability></WMS_Capabilities>`;

let luchtfoto: Buffer;
let perceelgrenzen: Buffer;

function stubPdok() {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const respond = (body: string | Buffer, type: string) => new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200, headers: { "content-type": type } });
    if (url.hostname === "api.pdok.nl") return respond(JSON.stringify(LOCATIESERVER), "application/json");
    if (url.searchParams.get("REQUEST") === "GetCapabilities") {
      return respond(url.pathname.includes("luchtfotorgb") ? CAPS(["Actueel_orthoHR"]) : CAPS(["Kadastralekaart"]), "text/xml");
    }
    const w = Number(url.searchParams.get("WIDTH"));
    const h = Number(url.searchParams.get("HEIGHT"));
    const img = url.pathname.includes("luchtfotorgb") ? luchtfoto : perceelgrenzen;
    return respond(await sharp(img).resize(w, h, { fit: "fill" }).toBuffer(), url.pathname.includes("luchtfotorgb") ? "image/jpeg" : "image/png");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("pdok_kaartbeeld tool", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearHttpCache();
    clearKaartbeeldCapabilities();
    luchtfoto ??= await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 80, g: 110, b: 70 } } }).jpeg().toBuffer();
    perceelgrenzen ??= await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect x="300" y="0" width="3" height="800" fill="#ff8800"/></svg>`)).png().toBuffer();
  });

  it("returns an image and a text block with bbox, GetMap URLs and bronvermelding (Visstraat 19, Dordrecht)", async () => {
    stubPdok();
    const content = await call("pdok_kaartbeeld", { adres: "Visstraat 19, 3311 KX Dordrecht" });

    expect(content[0].type).toBe("image");
    expect(content[0].mimeType).toBe("image/png");
    const img = Buffer.from(content[0].data!, "base64");
    expect(img.length).toBeLessThanOrEqual(1_000_000);
    const meta = await sharp(img).metadata();
    expect([meta.width, meta.height]).toEqual([800, 800]);

    const text = json(content[1]);
    expect(text.summary).toContain("luchtfoto + kadastrale_kaart");
    expect(text.records[0].data.bbox).toEqual([105195.6, 425185.7, 105315.6, 425305.7]);
    expect(text.records[0].data.rd_x).toBe(105255.6);
    expect(text.provenance.query_params.adres).toBe("Visstraat 19, 3311 KX Dordrecht");
    expect(text.provenance.query_params.getmap_kadastrale_kaart).toContain("LAYERS=Kadastralekaart");
    expect(text.access_note).toContain("© Kadaster / PDOK, Beeldmateriaal.nl");
    expect(Number.isNaN(Date.parse(text.provenance.timestamp))).toBe(false);
  });

  it("rejects half a coordinate pair", async () => {
    const content = await call("pdok_kaartbeeld", { rd_x: 105255.6 });
    expect(json(content[0]).error).toBe("unexpected");
  });

  it("is what nl_gov_ask answers for 'laat een luchtfoto zien van <adres>'", async () => {
    stubPdok();
    const content = await call("nl_gov_ask", { question: "Laat een luchtfoto zien van Visstraat 19, 3311 KX Dordrecht" });
    expect(content[0].type).toBe("image");
    expect(json(content[1]).provenance.tool).toBe("nl_gov_ask");
  });

  it("plans the kaartbeeld route in dryRun", async () => {
    const content = await call("nl_gov_ask", { question: "Kaart van Visstraat 19 Dordrecht", dryRun: true });
    const plan = json(content[0]);
    expect(plan.estimated_sources).toEqual(["pdok_kaartbeeld"]);
    expect(plan.planned_requests[0].params.q).toBe("Visstraat 19 Dordrecht");
  });

  it("adds the image to bag_address_detail with includeImage", async () => {
    stubPdok();
    const content = await call("bag_address_detail", { query: "Visstraat 19 Dordrecht", includeImage: true });
    expect(json(content[0]).records[0].data.rd_x).toBe(105255.6);
    expect(content[1].type).toBe("image");
    expect(json(content[2]).kaartbeeld.summary).toContain("Kaartbeeld");
  });

  it("adds the image of the bbox centre to brk_kadastrale_kaart_search with includeImage", async () => {
    const fetchMock = stubPdok();
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [], numberReturned: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
    const content = await call("brk_kadastrale_kaart_search", { bbox: "105195.6,425185.7,105315.6,425305.7", includeImage: true });
    expect(content[1].type).toBe("image");
    expect(json(content[2]).kaartbeeld.bbox).toEqual([105195.6, 425185.7, 105315.6, 425305.7]);
  });

  it("leaves bag_address_detail without an image by default", async () => {
    stubPdok();
    const content = await call("bag_address_detail", { query: "Visstraat 19 Dordrecht" });
    expect(content).toHaveLength(1);
  });
});

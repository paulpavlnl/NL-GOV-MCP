import { KAARTBEELD_ATTRIBUTION, KaartbeeldInputError, type KaartbeeldResult } from "../sources/pdok-kaartbeeld.js";
import { errorResponse, mapSourceError, nowIso, successResponse } from "./response.js";
import { mergeAccessNotes } from "./tool-runner.js";
import type { MCPToolResponse, ToolResult } from "../types.js";

export type ImageContent = { type: "image"; data: string; mimeType: string };
export type TextContent = { type: "text"; text: string };

export interface KaartbeeldPayload {
  [key: string]: unknown;
  content: Array<TextContent | ImageContent>;
  structuredContent: Record<string, unknown>;
}

/**
 * The JSON part of a kaartbeeld answer: one record describing the image, the
 * GetMap URL of every layer in provenance.query_params, and the bronvermelding.
 * An image without any layer is an error, never a white square with a marker.
 */
export function kaartbeeldToolResult(out: KaartbeeldResult, tool: string): ToolResult {
  const okLagen = out.lagen.filter((l) => l.status === "ok");
  const failed = out.lagen.filter((l) => l.status === "mislukt");
  if (!out.image || !okLagen.length) {
    return errorResponse({
      error: "http_error",
      message: "Geen enkele kaartlaag kon bij PDOK worden opgehaald.",
      suggestion: "Probeer het later opnieuw of kies andere lagen (luchtfoto, kadastrale_kaart, bgt, brt).",
      details: { bbox: out.bbox, lagen: out.lagen, notes: out.notes },
    });
  }
  const [x, y] = out.center;
  const plek = out.adres?.weergavenaam ?? `RD ${x}, ${y}`;
  const queryParams: Record<string, string> = {
    ...(out.adres ? { adres: out.adres.query, locatieserver: out.adres.endpoint } : {}),
    rd_x: String(x),
    rd_y: String(y),
    straal_m: String(out.straal_m),
    bbox: out.bbox.join(","),
    crs: "EPSG:28992",
    lagen: out.lagen.map((l) => l.laag).join(","),
  };
  for (const l of out.lagen) queryParams[`getmap_${l.laag}`] = l.getmap_url;
  const provenance: MCPToolResponse["provenance"] = {
    tool,
    endpoint: okLagen[0].getmap_url.split("?")[0],
    query_params: queryParams,
    timestamp: out.timestamp,
    returned_results: 1,
    total_results: 1,
  };
  const data: Record<string, unknown> = {
    adres: out.adres?.weergavenaam,
    rd_x: x,
    rd_y: y,
    bbox: out.bbox,
    crs: "EPSG:28992",
    straal_m: out.straal_m,
    breedte: out.width,
    hoogte: out.height,
    mime_type: out.mimeType,
    bytes: out.image.length,
    lagen: out.lagen,
    bronvermelding: KAARTBEELD_ATTRIBUTION,
  };
  return successResponse({
    summary: `Kaartbeeld ${plek}: ${okLagen.map((l) => l.laag).join(" + ")}${failed.length ? ` (mislukt: ${failed.map((l) => l.laag).join(", ")})` : ""}, ${out.width}×${out.height} px, straal ${out.straal_m} m.`,
    records: [{ source_name: "pdok_wms", title: `Kaartbeeld ${plek}`, canonical_url: okLagen[0].getmap_url, data, snippet: `bbox ${out.bbox.join(",")} (EPSG:28992)`, date: out.timestamp.slice(0, 10) }],
    provenance,
    access_note: mergeAccessNotes(`Bron: ${KAARTBEELD_ATTRIBUTION} (CC BY 4.0).`, ...out.notes),
  });
}

/** MCP content for a kaartbeeld: the image first, then the JSON text. */
export function kaartbeeldPayload(out: KaartbeeldResult, tool: string): KaartbeeldPayload {
  const result = kaartbeeldToolResult(out, tool);
  const content: Array<TextContent | ImageContent> = [];
  if (out.image && out.mimeType && !("error" in result)) content.push({ type: "image", data: out.image.toString("base64"), mimeType: out.mimeType });
  content.push({ type: "text", text: JSON.stringify(result) });
  return { content, structuredContent: result as unknown as Record<string, unknown> };
}

/** The error answer of a kaartbeeld that could not start (bad input, Locatieserver down). */
export function kaartbeeldError(error: unknown): ToolResult {
  if (error instanceof KaartbeeldInputError) {
    return errorResponse({ error: "unexpected", message: error.message, suggestion: "Geef een volledig adres (straat, huisnummer, plaats) of RD-coördinaten rd_x/rd_y." });
  }
  return mapSourceError(error, "PDOK kaartbeeld", "https://www.pdok.nl/viewer/");
}

/**
 * An extra kaartbeeld for another tool's answer (includeImage): the image and
 * a short text block, or only a text block saying why there is no image.
 */
export function kaartbeeldExtraContent(out: KaartbeeldResult | Error): Array<TextContent | ImageContent> {
  if (out instanceof Error) return [{ type: "text", text: JSON.stringify({ kaartbeeld: { error: kaartbeeldError(out) } }) }];
  const result = kaartbeeldToolResult(out, "pdok_kaartbeeld");
  if ("error" in result || !out.image || !out.mimeType) return [{ type: "text", text: JSON.stringify({ kaartbeeld: result }) }];
  return [
    { type: "image", data: out.image.toString("base64"), mimeType: out.mimeType },
    { type: "text", text: JSON.stringify({ kaartbeeld: { summary: result.summary, provenance: result.provenance, access_note: result.access_note, bbox: out.bbox, generated_at: nowIso() } }) },
  ];
}

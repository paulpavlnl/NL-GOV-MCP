/**
 * Live check of the three identifiers of 28-10-2026 against a running server (default the
 * woonkamer-pc through Tailscale Funnel; LIVE_MCP_URL overrides), through the tools themselves:
 * lido_relaties, lido_relations_by_identifier, rechtspraak_get_by_ecli and bronnen_status.
 * Run with: npx vitest run --config vitest.live.config.ts tests/lido-robuust.live.test.ts
 */
import { beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.LIVE_MCP_URL ?? "https://woonkamer.tail122f37.ts.net/nlgov/mcp";
let sid: string | null = null;

async function post(body: unknown) {
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body) });
  sid ??= r.headers.get("mcp-session-id");
  const t = await r.text();
  const m = [...t.matchAll(/^data: (.*)$/gm)].pop();
  return t ? JSON.parse(m ? m[1] : t) : null;
}
async function tool(name: string, args: Record<string, unknown>) {
  const j = await post({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(j.result.content[0].text);
}

beforeAll(async () => {
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-lido", version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
});

describe(`LiDO and Rechtspraak live (${URL_})`, () => {
  it.each([
    [{ id: "ECLI:NL:CRVB:2021:2984" }],
    [{ id: "ECLI:NL:CRVB:2024:2331" }],
    [{ id: "BWBR0005537", artikel: "7:2" }],
  ])("lido_relaties %o", async (args) => {
    const r = await tool("lido_relaties", { ...args, max: 5 });
    expect(r.error, JSON.stringify(r).slice(0, 400)).toBeUndefined();
    expect(r.records[0].data.totaal).toBeGreaterThan(0);
    expect(["lido-services", "lido-portaal"]).toContain(r.records[0].data.bron);
  }, 180_000);

  it.each([
    [{ identifier: "ECLI:NL:CRVB:2021:2984" }],
    [{ identifier: "ECLI:NL:CRVB:2024:2331" }],
    [{ identifier: "BWBR0005537", artikel: "7:2" }],
  ])("lido_relations_by_identifier %o", async (args) => {
    const r = await tool("lido_relations_by_identifier", args);
    expect(r.error, JSON.stringify(r).slice(0, 400)).toBeUndefined();
    expect(r.records.length).toBeGreaterThan(0);
  }, 180_000);

  it("rechtspraak_get_by_ecli", async () => {
    const r = await tool("rechtspraak_get_by_ecli", { ecli: "ECLI:NL:CRVB:2024:2331", returnType: "META" });
    expect(r.error, JSON.stringify(r).slice(0, 400)).toBeUndefined();
    expect(r.records.length).toBe(1);
  }, 120_000);

  it("bronnen_status: every source answers", async () => {
    const r = await tool("bronnen_status", {});
    expect(r.records.filter((x: { data: { ok: boolean } }) => !x.data.ok)).toEqual([]);
  }, 60_000);
});

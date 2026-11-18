import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../src/server.js";
import { ARGUMENT_MAX_CHARS, ARGUMENT_MAX_CHARS_BY_TOOL, overlongArgument, registerTools } from "../src/tools.js";
import { clearHttpCache } from "../src/utils/connector-runtime.js";
import { jsonResponse } from "./helpers/config.js";

/**
 * One central limit on the length of string arguments: no tool handler runs with
 * a string (nested in arrays and objects too) longer than ARGUMENT_MAX_CHARS, or
 * the higher limit a few arguments need; such a call is invalid_input naming the
 * argument and the limit, before any request.
 */

interface Payload {
  error?: string;
  message?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
  records?: unknown[];
}

async function callRaw(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  } finally {
    await client.close();
    await server.close();
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Payload> {
  return JSON.parse((await callRaw(name, args)).content[0].text) as Payload;
}

const SPARQL_ROW = {
  head: { vars: ["s"] },
  results: { bindings: [{ s: { type: "uri", value: "http://voorbeeld.example/a" } }] },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  clearHttpCache();
  fetchMock = vi.fn(async () => jsonResponse({ response: { numFound: 0, docs: [] } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("overlongArgument", () => {
  it("finds an overlong string at any depth and names its path", () => {
    const long = "x".repeat(ARGUMENT_MAX_CHARS + 1);
    expect(overlongArgument({ query: long })).toEqual({ path: "query", length: ARGUMENT_MAX_CHARS + 1, max: ARGUMENT_MAX_CHARS });
    expect(overlongArgument({ select: ["a", long] })?.path).toBe("select[1]");
    expect(overlongArgument({ filters: { Perioden: ["2024JJ00", long] } })?.path).toBe("filters.Perioden[1]");
    expect(overlongArgument({ filters: { [long]: "a" } })?.path).toBe("filters (sleutel)");
  });

  it("control: a string of exactly the limit, numbers and booleans pass", () => {
    expect(overlongArgument({ query: "x".repeat(ARGUMENT_MAX_CHARS), top: 10, verbose: true, filters: { a: ["b", 1] } })).toBeUndefined();
    expect(overlongArgument(undefined)).toBeUndefined();
  });

  it("applies a per-argument limit to that argument and everything in it", () => {
    expect(overlongArgument({ query: "x".repeat(10_000) }, { query: 10_000 })).toBeUndefined();
    expect(overlongArgument({ query: "x".repeat(10_001) }, { query: 10_000 })).toMatchObject({ path: "query", max: 10_000 });
    // Another argument of the same tool keeps the general limit.
    expect(overlongArgument({ query: "x", other: "x".repeat(ARGUMENT_MAX_CHARS + 1) }, { query: 10_000 })).toMatchObject({ path: "other", max: ARGUMENT_MAX_CHARS });
  });

  it("does not recurse: deep nesting cannot exhaust the stack", () => {
    let deep: unknown = "x".repeat(ARGUMENT_MAX_CHARS + 1);
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(overlongArgument({ select: deep })?.max).toBe(ARGUMENT_MAX_CHARS);
  });
});

describe("the guard on every tool", () => {
  it("refuses a string argument over the limit with invalid_input, before the handler and any request", async () => {
    const out = await callTool("pdok_search", { query: "a".repeat(ARGUMENT_MAX_CHARS + 1) });
    expect(out.error).toBe("invalid_input");
    expect(out.message).toBe(`Argument 'query' is te lang: ${ARGUMENT_MAX_CHARS + 1} tekens, het maximum is ${ARGUMENT_MAX_CHARS}.`);
    expect(out.suggestion).toContain(`hooguit ${ARGUMENT_MAX_CHARS} tekens`);
    expect(out.details).toEqual({ argument: "query", length: ARGUMENT_MAX_CHARS + 1, max_length: ARGUMENT_MAX_CHARS });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("control: a value of exactly the limit reaches the source", async () => {
    const out = await callTool("pdok_search", { query: "a".repeat(ARGUMENT_MAX_CHARS) });
    expect(out.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("checks strings nested in arrays and objects", async () => {
    const select = await callTool("cbs_observations", { tableId: "85000NED", select: ["Perioden", "x".repeat(ARGUMENT_MAX_CHARS + 1)] });
    expect(select).toMatchObject({ error: "invalid_input", details: { argument: "select[1]" } });
    const filters = await callTool("cbs_observations", { tableId: "85000NED", filters: { Perioden: ["2024JJ00", "x".repeat(ARGUMENT_MAX_CHARS + 1)] } });
    expect(filters).toMatchObject({ error: "invalid_input", details: { argument: "filters.Perioden[1]" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a SPARQL query may be longer: a just-valid query of 10,000 characters runs, one more is refused", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(SPARQL_ROW));
    const head = "SELECT ?s WHERE { ?s ?p ?o }";
    const tail = " LIMIT 5";
    const max = ARGUMENT_MAX_CHARS_BY_TOOL.bag_linked_data_select.query;
    expect(max).toBe(10_000);
    const query = `${head}${" ".repeat(max - head.length - tail.length)}${tail}`;
    expect(query).toHaveLength(max);
    const ok = await callTool("bag_linked_data_select", { query, limit: 5 });
    expect(ok.error).toBeUndefined();
    expect(ok.records).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const tooLong = await callTool("rce_linked_data_select", { query: `${query} `, limit: 5 });
    expect(tooLong).toMatchObject({ error: "invalid_input", details: { argument: "query", max_length: 10_000 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a schema's own stricter maximum still applies first", async () => {
    const result = await callRaw("ori_search", { query: "x".repeat(501) });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("covers every tool with arguments that registerTools registers, nl_gov_ask included", async () => {
    const server = createServer();
    const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools;
    const withArgs = Object.entries(registered).filter(([, tool]) => tool.inputSchema);
    expect(withArgs.length).toBeGreaterThan(80);
    expect(withArgs.map(([name]) => name)).toContain("nl_gov_ask");
    for (const [name, tool] of withArgs) {
      const result = await tool.handler({ voorbeeld: "x".repeat(20_001) }, {});
      expect(JSON.parse(result.content[0].text), name).toMatchObject({ error: "invalid_input", details: { argument: "voorbeeld" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps registration in one place: a tool registered through registerTools later gets the guard too", () => {
    const handlers = new Map<string, (args: unknown, extra: unknown) => unknown>();
    const fake = {
      registerTool(name: string, config: { inputSchema?: unknown }, handler: (args: unknown, extra: unknown) => unknown) {
        if (config.inputSchema) handlers.set(name, handler);
      },
    };
    registerTools(fake as unknown as McpServer);
    // Every handler with arguments handed to the server is the guarded one, also of tools added after this test was written.
    expect(handlers.size).toBeGreaterThan(80);
    for (const [name, handler] of handlers) {
      const out = handler({ voorbeeld: "x".repeat(20_001) }, {}) as { content: Array<{ text: string }> };
      expect(JSON.parse(out.content[0].text).error, name).toBe("invalid_input");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

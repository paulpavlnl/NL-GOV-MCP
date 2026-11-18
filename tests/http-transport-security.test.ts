import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionRegistry,
  allowedHostNames,
  resolveHttpOptions,
  startSseServer,
  startStreamableHttpServer,
  type HttpServerOptions,
  type ServerHandle,
} from "../src/server.js";
import { logger } from "../src/utils/logger.js";

// Count how many McpServers get built: every createServer() registers the tools once.
const built = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools.js")>();
  return {
    ...actual,
    registerTools: (server: Parameters<typeof actual.registerTools>[0]) => {
      built.count++;
      actual.registerTools(server);
    },
  };
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

// Two network peers on one machine: 127.0.0.2 is also a loopback address.
const PEER_A = "127.0.0.1";
const PEER_B = "127.0.0.2";
/** Whether this machine has that second loopback address (Linux and Windows do; a default macOS does not). */
const SECOND_LOOPBACK = await new Promise<boolean>((resolve) => {
  const probe = createNetServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, PEER_B, () => probe.close(() => resolve(true)));
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionRegistry per peer", () => {
  function registry(maxSessions: number) {
    let now = 0;
    const closed: string[] = [];
    const reg = new SessionRegistry<string>({
      ttlMs: 1_000,
      maxSessions,
      close: (_value, id) => closed.push(id),
      now: () => ++now,
    });
    return { reg, closed };
  }

  it("closes the requesting peer's own sessions and keeps another peer's active session", async () => {
    const { reg, closed } = registry(2);
    expect(reg.add("victim", "V", "a")).toBe(true);
    reg.acquire("victim"); // open stream
    expect(reg.add("b1", "B", "b")).toBe(true);
    reg.acquire("b1");
    for (const id of ["b2", "b3", "b4"]) {
      expect(reg.add(id, "B", "b")).toBe(true);
      reg.acquire(id);
    }
    await wait(0);
    expect(closed).toEqual(["b1", "b2", "b3"]);
    expect([reg.has("victim"), reg.has("b4"), reg.size]).toEqual([true, true, 2]);
  });

  it("closes an idle session of another peer when the requester has none", async () => {
    const { reg, closed } = registry(2);
    reg.add("a1", "A", "a");
    reg.acquire("a1");
    reg.add("a2", "A", "a"); // idle
    expect(reg.canAdd("b")).toBe(true);
    expect(reg.add("b1", "B", "b")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["a2"]);
    expect([reg.has("a1"), reg.has("b1")]).toEqual([true, true]);
  });

  it("refuses a new session rather than close another peer's active session", async () => {
    const { reg, closed } = registry(1);
    reg.add("a1", "A", "a");
    reg.acquire("a1");
    expect(reg.canAdd("b")).toBe(false);
    expect(reg.add("b1", "B", "b")).toBe(false);
    await wait(0);
    expect(closed).toEqual([]);
    expect([reg.has("a1"), reg.has("b1"), reg.size]).toEqual([true, false, 1]);
    // The same peer may still replace its own active session.
    expect(reg.add("a2", "A", "a")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["a1"]);
  });

  it("prefers the requester's idle sessions over its active ones", async () => {
    const { reg, closed } = registry(2);
    reg.add("a1", "A", "a");
    reg.acquire("a1");
    reg.add("a2", "A", "a");
    expect(reg.add("a3", "A", "a")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["a2"]);
  });
});

describe("SessionRegistry shares the cap fairly between peers", () => {
  function registry(maxSessions: number) {
    let now = 0;
    const closed: string[] = [];
    const reg = new SessionRegistry<string>({
      ttlMs: 1_000,
      maxSessions,
      close: (_value, id) => closed.push(id),
      now: () => ++now,
    });
    /** Add an active session (an open stream) of `peer`. */
    const open = (id: string, peer: string) => {
      const added = reg.add(id, id, peer);
      if (added) reg.acquire(id);
      return added;
    };
    return { reg, closed, open };
  }

  it("lets a newcomer in when one peer holds every slot with open streams: that peer loses its oldest", async () => {
    const { reg, closed, open } = registry(3);
    for (const id of ["h1", "h2", "h3"]) expect(open(id, "heavy")).toBe(true);
    expect(reg.canAdd("new")).toBe(true);
    expect(open("n1", "new")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["h1"]);
    expect([reg.has("h2"), reg.has("h3"), reg.has("n1"), reg.size]).toEqual([true, true, true, 3]);
  });

  it("control: takes the heavy peer's idle session before its active ones", async () => {
    const { reg, closed, open } = registry(3);
    open("h1", "heavy");
    reg.add("h2", "h2", "heavy"); // idle
    open("h3", "heavy");
    expect(open("n1", "new")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["h2"]);
  });

  it("gives a requester with fewer sessions a slot of the peer with the most, not its own", async () => {
    const { reg, closed, open } = registry(4);
    open("s1", "small");
    for (const id of ["h1", "h2", "h3"]) open(id, "heavy");
    expect(open("s2", "small")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["h1"]);
    // Now both hold two: the requester is a largest holder and replaces its own.
    expect(open("s3", "small")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["h1", "s1"]);
  });

  it("control: never closes an active session for a requester that holds as many or more", async () => {
    const { reg, closed, open } = registry(3);
    open("a1", "a");
    open("b1", "b");
    open("b2", "b");
    // b already holds more than a: it replaces its own session, a keeps its stream.
    expect(open("b3", "b")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["b1"]);
    expect(reg.has("a1")).toBe(true);
  });

  it("converges to one session each and then answers no", async () => {
    const { reg, closed, open } = registry(3);
    for (const id of ["h1", "h2", "h3"]) open(id, "heavy");
    expect(open("x1", "x")).toBe(true);
    expect(open("y1", "y")).toBe(true);
    await wait(0);
    expect(closed).toEqual(["h1", "h2"]);
    // Every peer holds one active session: a fourth peer gets no slot, nothing is closed.
    expect(reg.canAdd("z")).toBe(false);
    expect(open("z1", "z")).toBe(false);
    await wait(0);
    expect(closed).toEqual(["h1", "h2"]);
    expect(reg.size).toBe(3);
  });

  it("control: without peers (one proxy address) it stays plain LRU, idle before active", async () => {
    const { reg, closed } = registry(2);
    reg.add("p1", "p1", "proxy");
    reg.acquire("p1");
    reg.add("p2", "p2", "proxy");
    reg.add("p3", "p3", "proxy");
    reg.acquire("p3");
    reg.add("p4", "p4", "proxy");
    await wait(0);
    expect(closed).toEqual(["p2", "p1"]);
  });
});

interface Reply {
  status: number;
  headers: IncomingMessage["headers"];
  text: string;
}

describe("HTTP transports: sessions per peer, Host check and initialize-only server builds", () => {
  let handle: ServerHandle | undefined;
  let port = 0;
  const streams: IncomingMessage[] = [];

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.destroy();
    await handle?.closeConnections();
    handle?.httpServer?.closeAllConnections();
    handle?.httpServer?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function start(kind: "sse" | "streamable-http", overrides: Partial<HttpServerOptions> = {}): Promise<void> {
    const options = { port: 0, host: "127.0.0.1", allowedOrigins: [], ...overrides };
    handle = kind === "sse" ? await startSseServer(options) : await startStreamableHttpServer(options);
    const server = handle.httpServer!;
    if (!server.listening) await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  }

  function send(
    method: string,
    path: string,
    opts: { from?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, localAddress: opts.from ?? PEER_A, headers: opts.headers },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
        },
      );
      req.on("error", reject);
      req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
    });
  }

  /** Open an SSE stream (GET /mcp) from one peer; resolves with the session id or the refusal. */
  function openSse(from: string): Promise<{ sessionId?: string; status: number; headers: IncomingMessage["headers"] }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "GET", path: "/mcp", localAddress: from, headers: { accept: "text/event-stream" } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ status: res.statusCode!, headers: res.headers });
            return;
          }
          streams.push(res);
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            const match = /sessionId=([\w-]+)/.exec(text);
            if (match) resolve({ sessionId: match[1], status: 200, headers: res.headers });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  const ping = (sessionId: string, from: string) =>
    send("POST", `/messages?sessionId=${sessionId}`, {
      from,
      headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 9, method: "ping" },
    });

  it.skipIf(!SECOND_LOOPBACK)("SSE: a peer opening many streams closes its own, not another peer's open stream", async () => {
    await start("sse", { maxSessions: 2 });
    const victim = await openSse(PEER_A);
    for (let i = 0; i < 4; i++) expect((await openSse(PEER_B)).status).toBe(200);
    await wait(20);
    expect(handle!.sessionCount!()).toBe(2);
    expect((await ping(victim.sessionId!, PEER_A)).status).toBe(202);
  });

  it.skipIf(!SECOND_LOOPBACK)("SSE: answers 503 with Retry-After when only other peers' open streams fill the cap", async () => {
    await start("sse", { maxSessions: 1 });
    const victim = await openSse(PEER_A);
    const refused = await openSse(PEER_B);
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect((await ping(victim.sessionId!, PEER_A)).status).toBe(202);
    // Control: the same peer may still replace its own stream.
    const again = await openSse(PEER_A);
    expect(again.status).toBe(200);
    expect(handle!.sessionCount!()).toBe(1);
  });

  it.skipIf(!SECOND_LOOPBACK)("SSE: a peer holding every slot with open streams does not keep a second peer out", async () => {
    await start("sse", { maxSessions: 3 });
    const heavy: string[] = [];
    for (let i = 0; i < 3; i++) heavy.push((await openSse(PEER_B)).sessionId!);
    const newcomer = await openSse(PEER_A);
    expect(newcomer.status).toBe(200);
    await wait(20);
    expect(handle!.sessionCount!()).toBe(3);
    // The heavy peer lost its oldest stream and keeps the other two; the newcomer's session works.
    expect((await ping(heavy[0], PEER_B)).status).toBe(404);
    expect((await ping(heavy[1], PEER_B)).status).toBe(202);
    expect((await ping(heavy[2], PEER_B)).status).toBe(202);
    expect((await ping(newcomer.sessionId!, PEER_A)).status).toBe(202);
    // Control: the heavy peer, now at two against one, does not win the newcomer's stream back.
    expect((await openSse(PEER_B)).status).toBe(200);
    await wait(20);
    expect((await ping(newcomer.sessionId!, PEER_A)).status).toBe(202);
    expect(handle!.sessionCount!()).toBe(3);
  });

  it.skipIf(!SECOND_LOOPBACK)("Streamable HTTP: an idle session of another peer makes room, an active one does not", async () => {
    await start("streamable-http", { maxSessions: 1 });
    const initA = await send("POST", "/mcp", { from: PEER_A, headers: MCP_HEADERS, body: INIT });
    expect(initA.status).toBe(200);
    const initB = await send("POST", "/mcp", { from: PEER_B, headers: MCP_HEADERS, body: INIT });
    expect(initB.status).toBe(200);
    const sessionB = initB.headers["mcp-session-id"] as string;
    await wait(20);
    expect(handle!.sessionCount!()).toBe(1);

    // B opens its GET stream, so its session is active.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/mcp",
          localAddress: PEER_B,
          headers: { accept: "text/event-stream", "mcp-session-id": sessionB, "mcp-protocol-version": "2025-06-18" },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          streams.push(res);
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
    const before = built.count;
    const refused = await send("POST", "/mcp", { from: PEER_A, headers: MCP_HEADERS, body: INIT });
    expect(refused.status).toBe(503);
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect(JSON.parse(refused.text)).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
    expect(built.count).toBe(before);
    const list = await send("POST", "/mcp", {
      from: PEER_B,
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionB, "mcp-protocol-version": "2025-06-18" },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    });
    expect(list.status).toBe(200);
  });

  it("Streamable HTTP: a POST without session id that is not initialize gets 400 without building a server", async () => {
    await start("streamable-http");
    const before = built.count;
    const notInit = await send("POST", "/mcp", { headers: MCP_HEADERS, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(notInit.status).toBe(400);
    expect(JSON.parse(notInit.text)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Server not initialized" },
      id: null,
    });
    const notJsonRpc = await send("POST", "/mcp", { headers: MCP_HEADERS, body: { hello: "world" } });
    expect(notJsonRpc.status).toBe(400);
    expect(JSON.parse(notJsonRpc.text)).toMatchObject({ error: { code: -32700 }, id: null });
    expect(built.count).toBe(before);
    expect(handle!.sessionCount!()).toBe(0);

    // Control: initialize still builds a server and opens a session.
    const init = await send("POST", "/mcp", { headers: MCP_HEADERS, body: INIT });
    expect(init.status).toBe(200);
    expect(built.count).toBe(before + 1);
    expect(handle!.sessionCount!()).toBe(1);
  });

  it.each(["sse", "streamable-http"] as const)(
    "%s on 127.0.0.1 rejects a foreign Host with 403 on every route and accepts loopback names",
    async (kind) => {
      await start(kind);
      const before = built.count;
      for (const host of [`rebind.example:${port}`, "rebind.example", `127.0.0.1.rebind.example:${port}`]) {
        for (const [method, path, body] of [
          ["POST", "/mcp", INIT],
          ["GET", "/mcp", undefined],
          ["GET", "/health", undefined],
          ["GET", "/health/sources", undefined],
        ] as const) {
          const reply = await send(method, path, { headers: { ...MCP_HEADERS, host, origin: `http://${host}` }, body });
          expect([host, path, reply.status]).toEqual([host, path, 403]);
        }
      }
      expect(built.count).toBe(before);
      expect(handle!.sessionCount!()).toBe(0);

      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, "localhost"]) {
        const reply = await send("GET", "/health", { headers: { host } });
        expect([host, reply.status]).toEqual([host, 200]);
      }
    },
  );

  it("keeps any Host on a non-loopback bind without NL_GOV_ALLOWED_HOSTS, and checks it with the list", async () => {
    await start("streamable-http", { host: "0.0.0.0", stateless: true });
    expect((await send("GET", "/health", { headers: { host: "mcp.internal.example:3333" } })).status).toBe(200);
    await handle!.closeConnections();
    handle!.httpServer!.closeAllConnections();
    handle!.httpServer!.close();

    await start("streamable-http", { host: "0.0.0.0", allowedHosts: ["MCP.example.org", "10.0.0.5:3333"] });
    for (const host of ["mcp.example.org", "mcp.example.org:443", "10.0.0.5", `127.0.0.1:${port}`, "localhost"]) {
      expect([host, (await send("GET", "/health", { headers: { host } })).status]).toEqual([host, 200]);
    }
    for (const host of ["other.example", "mcp.example.org.other.example", "10.0.0.6"]) {
      expect([host, (await send("GET", "/health", { headers: { host } })).status]).toEqual([host, 403]);
    }
  });

  it("says in the 403 which setting a reverse proxy needs, and logs the allowed names once at startup", async () => {
    const info = vi.spyOn(logger, "info");
    await start("streamable-http", { allowedHosts: ["mcp.example.org"] });
    const hostLines = info.mock.calls.filter(([, msg]) => /Host check/.test(String(msg)));
    expect(hostLines).toHaveLength(1);
    expect(hostLines[0][0]).toEqual({ allowedHosts: ["localhost", "127.0.0.1", "[::1]", "mcp.example.org"] });
    expect(String(hostLines[0][1])).toMatch(/localhost, 127\.0\.0\.1, \[::1\], mcp\.example\.org.*NL_GOV_ALLOWED_HOSTS/);

    const refused = await send("GET", "/health", { headers: { host: "public.example.org" } });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.text)).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000, message: expect.stringMatching(/^Forbidden: Host not allowed\b.*NL_GOV_ALLOWED_HOSTS/) },
      id: null,
    });
    // Control: a listed name passes.
    expect((await send("GET", "/health", { headers: { host: "mcp.example.org:8443" } })).status).toBe(200);
  });

  it("control: logs no Host check line when Host is not checked", async () => {
    const info = vi.spyOn(logger, "info");
    await start("streamable-http", { host: "0.0.0.0", allowedOrigins: ["https://client.example"], stateless: true });
    expect(info.mock.calls.filter(([, msg]) => /Host check/.test(String(msg)))).toHaveLength(0);
  });

  it("reads NL_GOV_ALLOWED_HOSTS and decides when the Host check applies", () => {
    vi.stubEnv("NL_GOV_ALLOWED_HOSTS", " mcp.example.org , ,[fd00::1]:3333");
    expect(resolveHttpOptions({ port: 1 }).allowedHosts).toEqual(["mcp.example.org", "[fd00::1]:3333"]);
    vi.stubEnv("NL_GOV_ALLOWED_HOSTS", "");
    expect(resolveHttpOptions({ port: 1 }).allowedHosts).toEqual([]);

    expect(allowedHostNames({ host: undefined, allowedHosts: [] })).toBeUndefined();
    expect(allowedHostNames({ host: "0.0.0.0", allowedHosts: [] })).toBeUndefined();
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(allowedHostNames({ host, allowedHosts: [] })).toEqual(new Set(["localhost", "127.0.0.1", "[::1]"]));
    }
    expect(allowedHostNames({ host: undefined, allowedHosts: ["[fd00::1]:3333", "fd00::2"] })).toEqual(
      new Set(["localhost", "127.0.0.1", "[::1]", "[fd00::1]", "[fd00::2]"]),
    );
  });
});

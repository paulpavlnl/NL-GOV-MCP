import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools.js";
import { installHallucinatieBeveiliging } from "./fork/hallucinatie.js"; // FORK: diagnose, geldigheid, bekende valkuilen, foutlog (docs/FORK.md)
import { getAllConnectorHealth } from "./utils/connector-runtime.js";
import { logger } from "./utils/logger.js";

const BANNER = `
  _   _ _       ____  _____   __       __  __  ____ ____
 | \\ | | |     / ___||  _  | \\ \\     / / |  \\/  | / ___|  _ \\
 |  \\| | |    | |  _ | | | |  \\ \\   / /  | |\\/| || |   | |_) |
 | |\\  | |___ | |_| || |_| |   \\ \\_/ /   | |  | || |___|  __/
 |_| \\_|_____|\\____| |_____|    \\___/    |_|  |_| \\____|_|

 Built by WAINUT (https://wainut.ai) — Unleash Your Potential.
`;

function printBanner(): void {
  process.stderr.write(BANNER + "\n");
}

/* ------------------------------------------------------------------ */
/*  Shutdown registry                                                  */
/* ------------------------------------------------------------------ */

/**
 * Handle returned by the start* functions so that index.ts can perform a
 * graceful shutdown: stop accepting new HTTP connections and close any
 * active MCP transports/servers.
 */
export interface ServerHandle {
  /** Underlying HTTP server (only for the SSE/streamable-http transports). */
  httpServer?: HttpServer;
  /** Close all active MCP transports and McpServers. Idempotent-safe. */
  closeConnections: () => Promise<void>;
  /** Number of open MCP sessions (only for the SSE/streamable-http transports; always 0 when stateless). */
  sessionCount?: () => number;
  /** Requests being served right now (only for the stateless Streamable HTTP mode). */
  inFlightCount?: () => number;
}

interface Closeable {
  close: () => unknown | Promise<unknown>;
}

// Live transports and McpServers, tracked so a signal handler can drain them.
const activeTransports = new Set<Closeable>();
const activeMcpServers = new Set<McpServer>();
// Session registries whose idle-sweep timers must stop on shutdown.
const activeRegistries = new Set<{ stop: () => void }>();

async function closeConnections(): Promise<void> {
  for (const registry of activeRegistries) registry.stop();
  activeRegistries.clear();
  const pending: Promise<unknown>[] = [];
  for (const transport of activeTransports) {
    pending.push(Promise.resolve(transport.close()).catch(() => undefined));
  }
  for (const server of activeMcpServers) {
    pending.push(server.close().catch(() => undefined));
  }
  activeTransports.clear();
  activeMcpServers.clear();
  await Promise.all(pending);
}

/**
 * Track a transport/McpServer pair and clean both up once the transport closes.
 * The guard matters: McpServer.close() closes its transport again, and the SSE
 * transport calls onclose on every close(), which would otherwise recurse until
 * the stack overflows.
 */
function trackSession(transport: Transport, server: McpServer, onClosed: () => void): void {
  activeTransports.add(transport);
  activeMcpServers.add(server);
  let closed = false;
  transport.onclose = () => {
    if (closed) return;
    closed = true;
    onClosed();
    activeTransports.delete(transport);
    activeMcpServers.delete(server);
    server.close().catch(() => undefined);
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP options, sessions and middleware                              */
/* ------------------------------------------------------------------ */

export const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSIONS = 100;
/** Each stateless request builds its own McpServer (~15 MB while it runs), so this caps memory like the session cap. */
export const DEFAULT_MAX_CONCURRENT = 50;
const JSON_BODY_LIMIT = "1mb";

export interface HttpServerOptions {
  port: number;
  /**
   * Interface to bind (NL_GOV_HTTP_HOST). Unset keeps Node's default of all interfaces (IPv4 and IPv6),
   * so Docker and network clients can connect; 127.0.0.1 limits the server to this machine.
   */
  host?: string;
  /** Allowed Origin headers (NL_GOV_ALLOWED_ORIGINS); empty means no Origin check. */
  allowedOrigins: string[];
  /**
   * Host names a request's Host header may name besides the loopback names (NL_GOV_ALLOWED_HOSTS).
   * A loopback bind always checks Host; on other binds an empty list means no Host check.
   */
  allowedHosts?: string[];
  /** Close a session after this long without requests and without an open stream (NL_GOV_SESSION_TTL_MS). */
  sessionTtlMs: number;
  /**
   * Most concurrent sessions (NL_GOV_MAX_SESSIONS). To make room, the requesting peer's own least recently
   * used session is closed when it holds the most sessions, else one of the peer holding the most when that
   * peer holds more than the requester would, else the requester's own or another peer's idle session;
   * otherwise the new session gets 503.
   */
  maxSessions: number;
  /** How often idle sessions are swept; defaults to half the TTL, between 1 s and 60 s. */
  sweepIntervalMs?: number;
  /**
   * Streamable HTTP without sessions (NL_GOV_HTTP_STATELESS): each POST is served by a fresh McpServer,
   * no Mcp-Session-Id is issued or required, and GET and DELETE /mcp answer 405. Default false.
   */
  stateless?: boolean;
  /** Answer Streamable HTTP POSTs with application/json instead of an SSE stream (NL_GOV_HTTP_JSON_RESPONSE). Default false. */
  jsonResponse?: boolean;
  /** Most requests served at once in stateless mode; more get 503 with Retry-After (NL_GOV_HTTP_MAX_CONCURRENT). */
  maxConcurrent?: number;
  /** Serve GET /health/sources (NL_GOV_HTTP_SOURCE_HEALTH). Default true; false answers 404. */
  sourceHealth?: boolean;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${name}: ${process.env[name]} (expected true or false)`);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw} (expected a positive integer)`);
  }
  return value;
}

/** Compare origins without case or a trailing slash ("https://Example.org/" equals "https://example.org"). */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/** HTTP transport options from config and environment, with explicit overrides (used by tests). */
export function resolveHttpOptions(overrides: Partial<HttpServerOptions> = {}): HttpServerOptions {
  const allowedOrigins = overrides.allowedOrigins ?? (process.env.NL_GOV_ALLOWED_ORIGINS ?? "").split(",");
  const allowedHosts = overrides.allowedHosts ?? (process.env.NL_GOV_ALLOWED_HOSTS ?? "").split(",");
  return {
    port: overrides.port ?? loadConfig().server.httpPort,
    host: overrides.host ?? (process.env.NL_GOV_HTTP_HOST?.trim() || undefined),
    allowedOrigins: allowedOrigins.map(normalizeOrigin).filter(Boolean),
    allowedHosts: allowedHosts.map((host) => host.trim()).filter(Boolean),
    sessionTtlMs: overrides.sessionTtlMs ?? positiveIntegerEnv("NL_GOV_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS),
    maxSessions: overrides.maxSessions ?? positiveIntegerEnv("NL_GOV_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
    sweepIntervalMs: overrides.sweepIntervalMs,
    stateless: overrides.stateless ?? booleanEnv("NL_GOV_HTTP_STATELESS", false),
    jsonResponse: overrides.jsonResponse ?? booleanEnv("NL_GOV_HTTP_JSON_RESPONSE", false),
    maxConcurrent: overrides.maxConcurrent ?? positiveIntegerEnv("NL_GOV_HTTP_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT),
    sourceHealth: overrides.sourceHealth ?? booleanEnv("NL_GOV_HTTP_SOURCE_HEALTH", true),
  };
}

const ALL_INTERFACES = new Set(["", "0.0.0.0", "::", "[::]"]);

/**
 * The startup warning for a server that every network client can reach and every website could call
 * from a browser: bound to all interfaces without an Origin allowlist. Undefined otherwise.
 */
export function exposureWarning(options: Pick<HttpServerOptions, "host" | "allowedOrigins">): string | undefined {
  if (!ALL_INTERFACES.has((options.host ?? "").trim()) || options.allowedOrigins.length > 0) return undefined;
  return (
    "The HTTP transport listens on all interfaces without an Origin allowlist and has no authentication. " +
    "Set NL_GOV_HTTP_HOST=127.0.0.1 for local use, or set NL_GOV_ALLOWED_ORIGINS to the origins of your clients " +
    "and put authentication in front of the server when a network can reach it."
  );
}

export type EvictionReason = "idle" | "capacity";

interface SessionSlot<T> {
  value: T;
  lastSeen: number;
  /** Requests or streams currently open on this session; an active session is never idle. */
  active: number;
  /** The network peer that opened the session. */
  peer: string | undefined;
}

/**
 * Session map with an idle TTL and a size cap. Map order doubles as LRU order
 * (acquire moves a session to the end). An evicted session is removed first and
 * then closed through the `close` callback. At the cap a new session displaces the
 * same peer's sessions, a session of a peer holding more than its share, or another
 * peer's idle one (see victimFor), so one client can neither end the open stream of a
 * client with fewer sessions nor keep every other client out.
 */
export class SessionRegistry<T> {
  private readonly slots = new Map<string, SessionSlot<T>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      ttlMs: number;
      maxSessions: number;
      close: (value: T, id: string, reason: EvictionReason) => unknown;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.slots.size;
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  get(id: string): T | undefined {
    return this.slots.get(id)?.value;
  }

  /** Whether add() would admit a new session of this peer, without closing anything. */
  canAdd(peer?: string): boolean {
    return this.slots.size < this.options.maxSessions || this.victimFor(peer) !== undefined;
  }

  /**
   * Add a session of `peer`, first making room when the cap is reached (see victimFor).
   * Returns false, and adds nothing, when only other peers' active sessions fill the cap.
   */
  add(id: string, value: T, peer?: string): boolean {
    while (this.slots.size >= this.options.maxSessions) {
      const victim = this.victimFor(peer);
      if (victim === undefined) return false;
      this.evict(victim, "capacity");
    }
    this.slots.set(id, { value, lastSeen: this.now(), active: 0, peer });
    return true;
  }

  /** Mark a request or stream on the session as open; call the returned function when it ends. */
  acquire(id: string): () => void {
    const slot = this.slots.get(id);
    if (!slot) return () => undefined;
    slot.active++;
    slot.lastSeen = this.now();
    this.slots.delete(id);
    this.slots.set(id, slot);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slot.active--;
      slot.lastSeen = this.now();
    };
  }

  delete(id: string): boolean {
    return this.slots.delete(id);
  }

  /** Close sessions that have been idle for at least the TTL. Returns how many were closed. */
  sweep(): number {
    const now = this.now();
    let closed = 0;
    for (const [id, slot] of [...this.slots]) {
      if (slot.active === 0 && now - slot.lastSeen >= this.options.ttlMs) {
        this.evict(id, "idle");
        closed++;
      }
    }
    return closed;
  }

  startSweeper(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The session to close for a new one of `peer`, so the cap is shared fairly between peers. Each
   * choice takes that peer's least recently used session, idle before active:
   * 1. the requester's own, when it holds at least as many sessions as any other peer;
   * 2. else that of the peer holding the most sessions, when it holds more than the requester will
   *    after the new one is added;
   * 3. else the requester's own, when it has any;
   * 4. else the least recently used idle session of another peer.
   * So a peer never loses an active session to a requester that holds as many or more; with a single
   * peer (a reverse proxy) this is plain LRU.
   */
  private victimFor(peer: string | undefined): string | undefined {
    const held = new Map<string | undefined, { count: number; oldest: string; oldestIdle?: string }>();
    let otherIdle: string | undefined;
    for (const [id, slot] of this.slots) {
      let entry = held.get(slot.peer);
      if (!entry) held.set(slot.peer, (entry = { count: 0, oldest: id }));
      entry.count++;
      if (slot.active === 0) {
        entry.oldestIdle ??= id;
        if (slot.peer !== peer) otherIdle ??= id;
      }
    }
    const own = held.get(peer);
    const ownCount = own?.count ?? 0;
    let largest: { count: number; oldest: string; oldestIdle?: string } | undefined;
    for (const [other, entry] of held) {
      if (other !== peer && entry.count > (largest?.count ?? 0)) largest = entry;
    }
    const lru = (entry: { oldest: string; oldestIdle?: string }) => entry.oldestIdle ?? entry.oldest;
    if (own && ownCount >= (largest?.count ?? 0)) return lru(own);
    if (largest && largest.count > ownCount + 1) return lru(largest);
    return own ? lru(own) : otherIdle;
  }

  private evict(id: string, reason: EvictionReason): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    logger.info({ sessionId: id, reason }, "Closing MCP session");
    Promise.resolve()
      .then(() => this.options.close(slot.value, id, reason))
      .catch(() => undefined);
  }
}

/** The JSON-RPC code the MCP SDK itself uses for an unknown session (with HTTP 404). */
const SESSION_NOT_FOUND = -32001;

function jsonRpcError(code: number, message: string): object {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

/** Reject requests whose Origin header is not on the allowlist; requests without an Origin header pass. */
export function originGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map(normalizeOrigin).filter(Boolean));
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (allowed.size === 0 || origin === undefined || allowed.has(normalizeOrigin(origin))) {
      next();
      return;
    }
    res.status(403).json(jsonRpcError(-32000, "Forbidden: Origin not allowed"));
  };
}

/** Bind addresses that only this machine can reach. */
const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
/** Host names that always reach this machine; a DNS-rebinding page cannot use them as its own origin. */
const LOOPBACK_HOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Host name of a Host header or list entry, lower-cased and without the port ("[::1]:3333" gives "[::1]"). */
function hostName(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colons = host.split(":").length - 1;
  if (colons > 1) return `[${host}]`; // a bare IPv6 address in a list entry
  return colons === 1 ? host.slice(0, host.indexOf(":")) : host;
}

/**
 * The Host names a request may name, or undefined when Host is not checked. A loopback bind always
 * checks Host (against DNS rebinding); other binds only when NL_GOV_ALLOWED_HOSTS is set. Loopback
 * names are always allowed, so local clients and health checks keep working.
 */
export function allowedHostNames(options: Pick<HttpServerOptions, "host" | "allowedHosts">): Set<string> | undefined {
  const listed = (options.allowedHosts ?? []).map(hostName).filter(Boolean);
  const loopback = LOOPBACK_BINDS.has((options.host ?? "").trim().toLowerCase());
  if (!loopback && listed.length === 0) return undefined;
  return new Set([...LOOPBACK_HOST_NAMES, ...listed]);
}

/** The 403 message for a Host that is not allowed; it names the setting a reverse proxy in front needs. */
const HOST_NOT_ALLOWED =
  "Forbidden: Host not allowed. A reverse proxy or other client that sends this server another host name " +
  "needs that name in NL_GOV_ALLOWED_HOSTS (comma-separated).";

/** Reject requests whose Host header names a host that is not allowed (any port), before any route. */
export function hostGuard(options: Pick<HttpServerOptions, "host" | "allowedHosts">): RequestHandler {
  const allowed = allowedHostNames(options);
  return (req, res, next) => {
    const host = req.headers.host;
    if (allowed === undefined || (host !== undefined && allowed.has(hostName(host)))) {
      next();
      return;
    }
    res.status(403).json(jsonRpcError(-32000, HOST_NOT_ALLOWED));
  };
}

/** Seconds a client is asked to wait when the session cap holds only other clients' open sessions. */
const SESSIONS_FULL_RETRY_AFTER_S = 5;

function sessionsFull(res: express.Response): void {
  res
    .status(503)
    .set("Retry-After", String(SESSIONS_FULL_RETRY_AFTER_S))
    .json(jsonRpcError(-32000, "Server busy: too many open sessions"));
}

/** Whether a POST body holds an initialize request (alone or in a batch), the only message that opens a session. */
function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some((message) => isInitializeRequest(message)) : isInitializeRequest(body);
}

/** Whether a POST body is one JSON-RPC message or a batch of them. */
function isJsonRpcBody(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).every((message) => JSONRPCMessageSchema.safeParse(message).success);
}

/** Answer body-parser and route errors as JSON-RPC errors, without stack traces or file paths. */
export const jsonRpcErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = (err ?? {}) as { type?: string; status?: number; statusCode?: number };
  const status = e.status ?? e.statusCode;
  if (e.type === "entity.parse.failed") {
    res.status(400).json(jsonRpcError(-32700, "Parse error: request body is not valid JSON"));
  } else if (e.type === "entity.too.large") {
    res.status(413).json(jsonRpcError(-32600, `Invalid Request: request body exceeds the ${JSON_BODY_LIMIT} limit`));
  } else if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json(jsonRpcError(-32600, "Invalid Request"));
  } else {
    logger.error({ err }, "Unhandled HTTP error");
    res.status(500).json(jsonRpcError(-32603, "Internal error"));
  }
};

/** Express app with the Host and Origin checks and JSON body parsing shared by both HTTP transports. */
function createHttpApp(options: HttpServerOptions): express.Express {
  const app = express();
  app.use(hostGuard(options));
  app.use(originGuard(options.allowedOrigins));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  return app;
}

function startSweeper(registry: SessionRegistry<unknown>, options: HttpServerOptions): void {
  const interval =
    options.sweepIntervalMs ?? Math.min(60_000, Math.max(1_000, Math.floor(options.sessionTtlMs / 2)));
  registry.startSweeper(interval);
  activeRegistries.add(registry);
}

function listen(app: express.Express, options: HttpServerOptions, label: string): HttpServer {
  const warning = exposureWarning(options);
  if (warning) logger.warn({ host: options.host ?? "all interfaces" }, warning);
  const hosts = allowedHostNames(options);
  if (hosts) {
    logger.info(
      { allowedHosts: [...hosts] },
      `Host check active: only requests whose Host header names ${[...hosts].join(", ")} (any port) are served; ` +
        "add the names a reverse proxy forwards to NL_GOV_ALLOWED_HOSTS",
    );
  }
  const onListening = () => {
    const address = httpServer.address();
    const bound = typeof address === "object" && address ? address : undefined;
    logger.info({ host: bound?.address ?? options.host, port: bound?.port ?? options.port }, `MCP ${label} server started`);
  };
  const httpServer = options.host
    ? app.listen(options.port, options.host, onListening)
    : app.listen(options.port, onListening);
  attachServerErrorHandler(httpServer, options.port);
  return httpServer;
}

/** Log a clear message on EADDRINUSE (and other listen errors) and exit. */
function attachServerErrorHandler(httpServer: HttpServer, port: number): void {
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error({ port }, `Port ${port} is already in use (EADDRINUSE); cannot start HTTP server`);
    } else {
      logger.error({ err }, "HTTP server error");
    }
    process.exit(1);
  });
}

/**
 * Sent to the client at initialize. With tool search (Claude Code) only tool names and these
 * instructions load upfront, so they say when to reach for this server and how to read results.
 */
export const SERVER_INSTRUCTIONS =
  "NL-GOV-MCP searches official Dutch government sources (Tweede Kamer, bekendmakingen, wetten, Rechtspraak, CBS, council records, DSO/Omgevingswet, PDOK/BAG, KNMI, TenderNed, subsidies and funding calls of RVO, NWO/ZonMw and the EU, and more). " +
  "Start with nl_gov_ask when the right source is unclear; it reports the source it used. Then use that source's own tools for details or full text (e.g. tweede_kamer_document_get, officiele_bekendmakingen_record_get, dso_omgevingsdocument_tekst). " +
  "Records carry an official canonical URL and provenance: cite those URLs. A result with an 'error' field is a failure; 'failures' lists sources that failed while others answered; zero records without either means the source answered and found nothing; access_note explains filters, truncation and fallbacks. " +
  "Some tools need a free API key: DSO_API_KEY, KNMI_API_KEY, OVERHEID_API_KEY, BAG_API_KEY, NED_API_KEY, EP_ONLINE_API_KEY, NS_API_KEY, DNB_API_KEY; without it the tool says so.";

export function createServer(): McpServer {
  const config = loadConfig();
  const server = new McpServer(
    {
      name: config.server.name,
      version: config.server.version,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  installHallucinatieBeveiliging(server); // FORK (docs/FORK.md)
  registerTools(server);
  return server;
}

/* ------------------------------------------------------------------ */
/*  stdio                                                              */
/* ------------------------------------------------------------------ */

export async function startStdioServer(): Promise<ServerHandle> {
  printBanner();
  const server = createServer();
  const transport = new StdioServerTransport();
  activeMcpServers.add(server);
  await server.connect(transport);
  logger.info("MCP stdio server started");
  return { closeConnections };
}

/* ------------------------------------------------------------------ */
/*  SSE (legacy)                                                       */
/* ------------------------------------------------------------------ */

export async function startSseServer(overrides: Partial<HttpServerOptions> = {}): Promise<ServerHandle> {
  printBanner();
  const config = loadConfig();
  const options = resolveHttpOptions(overrides);
  const app = createHttpApp(options);

  const sessions = new SessionRegistry<{ server: McpServer; transport: SSEServerTransport }>({
    ttlMs: options.sessionTtlMs,
    maxSessions: options.maxSessions,
    close: (session) => session.transport.close(),
  });
  startSweeper(sessions as SessionRegistry<unknown>, options);

  app.get("/mcp", async (req, res) => {
    const peer = req.socket.remoteAddress;
    if (!sessions.canAdd(peer)) {
      sessionsFull(res);
      return;
    }
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    trackSession(transport, server, () => sessions.delete(sessionId));
    // canAdd() just said yes and nothing ran in between, so this adds the session.
    sessions.add(sessionId, { server, transport }, peer);
    // The open SSE stream keeps the session active until the client disconnects.
    res.on("close", sessions.acquire(sessionId));
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).send("Missing sessionId");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json(jsonRpcError(SESSION_NOT_FOUND, "Session not found"));
      return;
    }
    res.on("close", sessions.acquire(sessionId));
    await session.transport.handlePostMessage(req, res, req.body);
  });

  addHealthRoutes(app, config, options);
  app.use(jsonRpcErrorHandler);

  const httpServer = listen(app, options, "SSE");
  return { httpServer, closeConnections, sessionCount: () => sessions.size };
}

/* ------------------------------------------------------------------ */
/*  Streamable HTTP (protocol versions 2024-10-07 up to 2025-11-25)    */
/* ------------------------------------------------------------------ */

/**
 * Stateless Streamable HTTP: each POST gets its own McpServer and transport, closed when the response
 * ends, so no Mcp-Session-Id is needed (sessions are optional in the spec). This keeps working behind
 * proxies and gateways that drop that header. The server keeps no per-session state, so nothing is lost.
 */
function addStatelessMcpRoutes(app: express.Express, options: HttpServerOptions): () => number {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  let inFlight = 0;

  app.post("/mcp", async (req, res) => {
    if (inFlight >= maxConcurrent) {
      res.status(503).set("Retry-After", "1").json(jsonRpcError(-32000, "Server busy: too many concurrent requests"));
      return;
    }
    inFlight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    // 'close' fires after the response is sent, on a client abort and after an error response alike.
    res.on("close", release);
    if (res.destroyed) {
      release();
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.jsonResponse,
    });
    trackSession(transport, server, release);
    res.on("close", () => {
      transport.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Without sessions there is no stream to open (GET) and nothing to terminate (DELETE).
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed: this server is stateless, use POST"));
  });

  return () => inFlight;
}

export async function startStreamableHttpServer(overrides: Partial<HttpServerOptions> = {}): Promise<ServerHandle> {
  printBanner();
  const config = loadConfig();
  const options = resolveHttpOptions(overrides);
  const app = createHttpApp(options);

  if (options.stateless) {
    const inFlightCount = addStatelessMcpRoutes(app, options);
    addHealthRoutes(app, config, options);
    app.use(jsonRpcErrorHandler);
    const httpServer = listen(app, options, "Streamable HTTP (stateless)");
    return { httpServer, closeConnections, sessionCount: () => 0, inFlightCount };
  }

  const sessions = new SessionRegistry<{ server: McpServer; transport: StreamableHTTPServerTransport }>({
    ttlMs: options.sessionTtlMs,
    maxSessions: options.maxSessions,
    close: (session) => session.transport.close(),
  });
  startSweeper(sessions as SessionRegistry<unknown>, options);

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Handle DELETE for session termination
    if (req.method === "DELETE") {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && session) {
        sessions.delete(sessionId);
        await session.transport.close();
        res.status(200).end();
      } else {
        res.status(404).end();
      }
      return;
    }

    // For GET and POST, check if there's an existing session
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        // Unknown or closed session: 404 tells the client to start a new one with initialize.
        res.status(404).json(jsonRpcError(SESSION_NOT_FOUND, "Session not found"));
        return;
      }
      // Existing session — route to its transport; an open GET stream keeps it active.
      res.on("close", sessions.acquire(sessionId));
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session (no session ID header) — only POST allowed for initialization
    if (req.method !== "POST") {
      res.status(400).json({ error: "New sessions must be initialized via POST" });
      return;
    }

    // Only an initialize request opens a session; answer anything else as the SDK would, without building a server.
    if (!isInitializeBody(req.body)) {
      if (isJsonRpcBody(req.body)) {
        res.status(400).json(jsonRpcError(-32000, "Bad Request: Server not initialized"));
      } else {
        res.status(400).json(jsonRpcError(-32700, "Parse error: Invalid JSON-RPC message"));
      }
      return;
    }

    const peer = req.socket.remoteAddress;
    if (!sessions.canAdd(peer)) {
      sessionsFull(res);
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: options.jsonResponse,
    });

    trackSession(transport, server, () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Session ID is set after handleRequest processes the initialize message
    const sid = transport.sessionId;
    if (sid && !sessions.has(sid)) {
      // Concurrent initializes may have filled the cap since canAdd(); then this session cannot be kept.
      if (!sessions.add(sid, { server, transport }, peer)) await transport.close();
    } else if (!sid) {
      // The SDK refused the initialize request, so there is no session to keep: release the server now.
      await transport.close();
    }
  });

  addHealthRoutes(app, config, options);
  app.use(jsonRpcErrorHandler);

  const httpServer = listen(app, options, "Streamable HTTP");
  return { httpServer, closeConnections, sessionCount: () => sessions.size };
}

/* ------------------------------------------------------------------ */
/*  Shared health routes                                               */
/* ------------------------------------------------------------------ */

interface HealthConfig {
  server: { name: string; version: string };
}

function addHealthRoutes(app: express.Express, config: HealthConfig, options: Pick<HttpServerOptions, "sourceHealth">): void {
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: config.server.name, version: config.server.version });
  });

  // NL_GOV_HTTP_SOURCE_HEALTH=false hides which upstream sources fail, for deployments that should not share that.
  if (options.sourceHealth === false) return;

  app.get("/health/sources", (_req, res) => {
    res.json({
      ok: true,
      name: config.server.name,
      version: config.server.version,
      connectors: getAllConnectorHealth(),
    });
  });
}

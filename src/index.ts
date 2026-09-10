#!/usr/bin/env node
import "dotenv/config";
import { startStreamableHttpServer } from "./server.js";

async function main(): Promise<void> {
  const handle = await startStreamableHttpServer();

  const shutdown = (reason: string): void => {
    console.log(`Shutting down Workflowy MCP (${reason})…`);
    handle.httpServer?.close();
    handle.closeConnections().catch(() => undefined).finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "node:http";
import { createServerApp, parsePort } from "./httpApp.js";
import { SnakeRoom } from "./rooms/SnakeRoom.js";

const port = parsePort(process.env.PORT, 2567);
const host = process.env.HOST?.trim() || "0.0.0.0";

const app = createServerApp();

const server = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({
    server,
  }),
});

gameServer.define("snake_duel", SnakeRoom);

await gameServer.listen(port, host);

console.info(`[server] listening on ws://${host}:${port}`);
console.info(`[server] health check: http://${host}:${port}/health`);

const shutdown = async (signal: string) => {
  console.info(`[server] graceful shutdown (${signal})`);
  await gameServer.gracefullyShutdown(false);
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServerApp, parsePort } from "./httpApp.js";

let activeServer: ReturnType<typeof createServer> | null = null;

afterEach(async () => {
  if (!activeServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    activeServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  activeServer = null;
});

describe("parsePort", () => {
  it("keeps a valid integer port", () => {
    expect(parsePort("8080", 2567)).toBe(8080);
  });

  it("falls back for invalid values", () => {
    expect(parsePort(undefined, 2567)).toBe(2567);
    expect(parsePort("0", 2567)).toBe(2567);
    expect(parsePort("65536", 2567)).toBe(2567);
    expect(parsePort("abc", 2567)).toBe(2567);
    expect(parsePort("42.5", 2567)).toBe(2567);
  });
});

describe("createServerApp", () => {
  it("serves health and ready endpoints with security headers", async () => {
    const app = createServerApp({
      uptimeSeconds: () => 12.4,
    });
    activeServer = createServer(app);

    await new Promise<void>((resolve, reject) => {
      activeServer?.once("error", reject);
      activeServer?.listen(0, "127.0.0.1", () => {
        activeServer?.off("error", reject);
        resolve();
      });
    });

    const { port } = activeServer.address() as AddressInfo;

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(healthResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(healthResponse.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    await expect(healthResponse.json()).resolves.toEqual({
      status: "ok",
      service: "snake-duel-server",
    });

    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyResponse.status).toBe(200);
    await expect(readyResponse.json()).resolves.toEqual({
      status: "ready",
      uptimeSec: 12,
    });
  });
});

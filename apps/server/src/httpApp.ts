import express, { type Express } from "express";

export interface CreateServerAppOptions {
  readonly uptimeSeconds?: () => number;
}

export function createServerApp(options: CreateServerAppOptions = {}): Express {
  const app = express();
  const getUptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());

  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "snake-duel-server" });
  });

  app.get("/ready", (_req, res) => {
    res.status(200).json({
      status: "ready",
      uptimeSec: Math.round(getUptimeSeconds()),
    });
  });

  return app;
}

export function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

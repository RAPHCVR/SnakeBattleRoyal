import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactsDir = path.join(rootDir, ".tmp", "public-health");

const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim() || "https://snake.raphcvr.me";
const publicWsUrl = process.env.PUBLIC_WS_URL?.trim() || "wss://apisnake.raphcvr.me";
const publicApiHttpUrl =
  process.env.PUBLIC_API_HTTP_URL?.trim() || publicWsUrl.replace(/^ws/i, "http").replace(/\/+$/, "");

const checks = [];

await fs.mkdir(artifactsDir, { recursive: true });

try {
  const home = await fetchWithText(publicBaseUrl);
  pushCheck("public ui responds", home.ok, {
    status: home.status,
    contentType: home.contentType,
  });
  pushCheck("public ui contains app shell", home.text.includes("Snake Duel Arena"), {
    titlePresent: home.text.includes("Snake Duel Arena"),
  });

  const health = await fetchWithJson(`${publicApiHttpUrl}/health`);
  pushCheck("public api health responds", health.ok, {
    status: health.status,
    body: health.json,
  });
  pushCheck("public api health status ok", health.json?.status === "ok", health.json);

  const ready = await fetchWithJson(`${publicApiHttpUrl}/ready`);
  pushCheck("public api ready responds", ready.ok, {
    status: ready.status,
    body: ready.json,
  });
  pushCheck("public api ready status ready", ready.json?.status === "ready", ready.json);

  const summary = {
    checkedAt: new Date().toISOString(),
    publicBaseUrl,
    publicWsUrl,
    publicApiHttpUrl,
    checks,
  };

  const summaryPath = path.join(artifactsDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ ok: false, failed, summaryPath }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, summaryPath, checks: checks.length }, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

async function fetchWithText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    text: await response.text(),
  };
}

async function fetchWithJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    json,
  };
}

function pushCheck(name, ok, details) {
  checks.push({
    name,
    ok,
    details,
  });
}

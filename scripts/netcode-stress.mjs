import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const clientPort = Number(process.env.NETCODE_CLIENT_PORT ?? 4273);
const serverPort = Number(process.env.NETCODE_SERVER_PORT ?? 3667);
const baseUrl = process.env.NETCODE_BASE_URL?.trim() || `http://127.0.0.1:${clientPort}`;
const wsBaseUrl = process.env.NETCODE_WS_URL?.trim() || `ws://127.0.0.1:${serverPort}`;
const usesExternalBaseUrl = Boolean(process.env.NETCODE_BASE_URL?.trim());

const stressRootDir = path.join(rootDir, ".tmp", "qa-netcode");
const stressClientDistDir = path.join(stressRootDir, "client-dist");
const artifactsDir = path.join(stressRootDir, "artifacts");
const serverLogPath = path.join(stressRootDir, "server.log");

const scenarios = [
  {
    name: "baseline",
    delayMs: 0,
    jitterMs: 0,
    rounds: 3,
    thresholds: {
      maxIdleGapMs: 140,
      maxLateIdleGaps: 1,
      maxDisplayGapMs: 150,
      maxP95DisplayGapMs: 130,
      maxCorrectionDistance: 2,
    },
  },
  {
    name: "mild-jitter",
    delayMs: 24,
    jitterMs: 16,
    rounds: 3,
    thresholds: {
      maxIdleGapMs: 150,
      maxLateIdleGaps: 2,
      maxDisplayGapMs: 190,
      maxP95DisplayGapMs: 160,
      maxCorrectionDistance: 2,
    },
  },
];

let stopStaticServer = null;
let stopGameServer = null;

await fs.mkdir(artifactsDir, { recursive: true });

try {
  if (!usesExternalBaseUrl) {
    await prepareStressBuild();
    stopGameServer = await startGameServer();
    stopStaticServer = await startStaticServer();

    await waitForOk(`${wsBaseUrl.replace("ws://", "http://").replace("wss://", "https://")}/health`);
    await waitForOk(baseUrl);
  }

  const results = [];
  const failures = [];

  for (const scenario of scenarios) {
    for (let round = 1; round <= scenario.rounds; round += 1) {
      const result = await runScenarioRound(scenario, round);
      results.push(result);

      for (const assertion of result.assertions) {
        if (!assertion.ok) {
          failures.push({
            scenario: scenario.name,
            round,
            ...assertion,
          });
        }
      }
    }
  }

  const summaryPath = path.join(artifactsDir, "summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        baseUrl,
        wsBaseUrl,
        external: usesExternalBaseUrl,
        scenarios,
        results,
        failures,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        summaryPath,
        rounds: results.length,
        thresholdBreaches: failures.length,
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled([stopStaticServer?.(), stopGameServer?.()].filter(Boolean));
}

async function prepareStressBuild() {
  await fs.rm(stressRootDir, { recursive: true, force: true });
  await fs.mkdir(artifactsDir, { recursive: true });

  await runCommand("npm", ["run", "build", "--workspace", "@snake-duel/shared"], {
    cwd: rootDir,
    label: "shared build",
  });

  await runCommand("npm", ["run", "build", "--workspace", "@snake-duel/server"], {
    cwd: rootDir,
    label: "server build",
  });

  const clientDir = path.join(rootDir, "apps", "client");
  const outDir = path.relative(clientDir, stressClientDistDir);

  await runCommand(
    "node",
    [path.join(rootDir, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir],
    {
      cwd: clientDir,
      env: {
        ...process.env,
        VITE_COLYSEUS_URL: wsBaseUrl,
      },
      label: "client stress build",
    },
  );
}

async function startGameServer() {
  const logFile = await fs.open(serverLogPath, "w");
  const child = spawn(
    process.execPath,
    [path.join(rootDir, "apps", "server", "dist", "index.js")],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(serverPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout?.on("data", (chunk) => {
    void logFile.write(chunk.toString());
  });
  child.stderr?.on("data", (chunk) => {
    void logFile.write(chunk.toString());
  });

  child.on("exit", () => {
    void logFile.close();
  });

  return async () => {
    if (!child.killed) {
      child.kill();
    }
    await onceExit(child);
  };
}

async function startStaticServer() {
  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", baseUrl);
      const pathname = decodeURIComponent(requestUrl.pathname);
      let filePath = path.join(stressClientDistDir, pathname);
      let stat = await fs.stat(filePath).catch(() => null);

      if (stat?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        stat = await fs.stat(filePath).catch(() => null);
      }

      if (!stat) {
        filePath = path.join(stressClientDistDir, "index.html");
        stat = await fs.stat(filePath).catch(() => null);
      }

      if (!stat) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", getContentType(filePath));
      createReadStream(filePath).pipe(response);
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : "Unexpected error");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(clientPort, "127.0.0.1", resolve);
  });

  return async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });
  };
}

async function runScenarioRound(scenario, round) {
  const browser = await chromium.launch({ headless: true });
  const context1 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const context2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });

  if (scenario.delayMs > 0 || scenario.jitterMs > 0) {
    const pattern = new RegExp(`^${escapeRegExp(wsBaseUrl)}`);
    await Promise.all([
      context1.routeWebSocket(pattern, createDelayedWebSocketRoute(scenario)),
      context2.routeWebSocket(pattern, createDelayedWebSocketRoute(scenario)),
    ]);
  }

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();
  const screenshotPath = path.join(artifactsDir, `${scenario.name}-round-${round}.png`);

  try {
    await Promise.all([
      page1.goto(baseUrl, { waitUntil: "networkidle" }),
      page2.goto(baseUrl, { waitUntil: "networkidle" }),
    ]);

    await Promise.all([
      page1.getByRole("button", { name: /Jouer en Ligne/i }).click(),
      page2.getByRole("button", { name: /Jouer en Ligne/i }).click(),
    ]);

    await Promise.all([waitForRunning(page1), waitForRunning(page2)]);
    const samples = await sampleMatch(page1, page2);
    const page1Metrics = analyseSamples(samples.page1, "page1");
    const page2Metrics = analyseSamples(samples.page2, "page2");
    await page1.screenshot({ path: screenshotPath, fullPage: false });

    const assertions = [
      makeAssertion(
        "display cadence stays smooth enough for the active snake",
        page1Metrics.maxDisplayGapMs <= scenario.thresholds.maxDisplayGapMs &&
          page2Metrics.maxDisplayGapMs <= scenario.thresholds.maxDisplayGapMs &&
          page1Metrics.p95DisplayGapMs <= scenario.thresholds.maxP95DisplayGapMs &&
          page2Metrics.p95DisplayGapMs <= scenario.thresholds.maxP95DisplayGapMs,
        {
          page1: {
            maxDisplayGapMs: page1Metrics.maxDisplayGapMs,
            p95DisplayGapMs: page1Metrics.p95DisplayGapMs,
          },
          page2: {
            maxDisplayGapMs: page2Metrics.maxDisplayGapMs,
            p95DisplayGapMs: page2Metrics.p95DisplayGapMs,
          },
        },
      ),
      makeAssertion(
        "idle gaps stay under the expected ceiling",
        page1Metrics.maxIdleGapMs <= scenario.thresholds.maxIdleGapMs &&
          page2Metrics.maxIdleGapMs <= scenario.thresholds.maxIdleGapMs,
        { page1: page1Metrics.maxIdleGapMs, page2: page2Metrics.maxIdleGapMs },
      ),
      makeAssertion(
        "long idle stalls stay rare",
        page1Metrics.lateIdleGapCount <= scenario.thresholds.maxLateIdleGaps &&
          page2Metrics.lateIdleGapCount <= scenario.thresholds.maxLateIdleGaps,
        { page1: page1Metrics.lateIdleGapCount, page2: page2Metrics.lateIdleGapCount },
      ),
      makeAssertion(
        "corrections stay bounded",
        page1Metrics.maxCorrectionDistance <= scenario.thresholds.maxCorrectionDistance &&
          page2Metrics.maxCorrectionDistance <= scenario.thresholds.maxCorrectionDistance,
        { page1: page1Metrics.maxCorrectionDistance, page2: page2Metrics.maxCorrectionDistance },
      ),
    ];

    return {
      scenario: scenario.name,
      round,
      screenshotPath,
      wsDelay: {
        delayMs: scenario.delayMs,
        jitterMs: scenario.jitterMs,
      },
      page1: page1Metrics,
      page2: page2Metrics,
      assertions,
    };
  } finally {
    await Promise.allSettled([context1.close(), context2.close()]);
    await browser.close();
  }
}

function createDelayedWebSocketRoute({ delayMs, jitterMs }) {
  return async (route) => {
    const server = route.connectToServer();

    route.onMessage((message) => {
      const delay = computeDelayMs(delayMs, jitterMs);
      setTimeout(() => server.send(message), delay);
    });

    server.onMessage((message) => {
      const delay = computeDelayMs(delayMs, jitterMs);
      setTimeout(() => route.send(message), delay);
    });
  };
}

async function waitForRunning(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const state = await readAutomationState(page);
    if (state.mode === "online" && state.game?.status === "running") {
      return state;
    }
    await page.waitForTimeout(100);
  }

  throw new Error("Timed out waiting for the online round to start.");
}

async function sampleMatch(page1, page2) {
  const plan = buildInputPlan();
  let nextStepIndex = 0;
  const startedAt = Date.now();

  await Promise.all([startRecording(page1), startRecording(page2)]);

  while (Date.now() - startedAt < 9_000) {
    const elapsed = Date.now() - startedAt;

    while (nextStepIndex < plan.length && plan[nextStepIndex].timeMs <= elapsed) {
      const step = plan[nextStepIndex];
      await Promise.all([
        enqueueDirection(page1, step.page1Direction),
        enqueueDirection(page2, step.page2Direction),
      ]);
      nextStepIndex += 1;
    }

    const [page1Status, page2Status] = await Promise.all([
      readGameStatus(page1),
      readGameStatus(page2),
    ]);

    if (page1Status !== "running" || page2Status !== "running") {
      break;
    }

    await page1.waitForTimeout(40);
  }

  const [page1Samples, page2Samples] = await Promise.all([
    stopRecording(page1),
    stopRecording(page2),
  ]);

  return {
    page1: page1Samples,
    page2: page2Samples,
  };
}

function buildInputPlan() {
  const steps = [];
  const cycle = [
    { atMs: 100, page1Direction: "up", page2Direction: "down" },
    { atMs: 700, page1Direction: "left", page2Direction: "right" },
    { atMs: 1_800, page1Direction: "down", page2Direction: "up" },
    { atMs: 2_900, page1Direction: "right", page2Direction: "left" },
  ];

  for (let cycleIndex = 0; cycleIndex < 3; cycleIndex += 1) {
    const offsetMs = cycleIndex * 3_600;
    for (const step of cycle) {
      steps.push({
        timeMs: offsetMs + step.atMs,
        page1Direction: step.page1Direction,
        page2Direction: step.page2Direction,
      });
    }
  }

  return steps;
}

async function enqueueDirection(page, direction) {
  return page.evaluate((queuedDirection) => window.enqueueInput?.(queuedDirection) ?? false, direction);
}

async function readAutomationState(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text?.() ?? "{}"));
}

async function readGameStatus(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(window.render_game_to_text?.() ?? "{}")?.game?.status ?? "unknown";
    } catch {
      return "unknown";
    }
  });
}

async function startRecording(page) {
  await page.evaluate(() => {
    const previousRecorder = window.__netcodeRecorder;
    if (previousRecorder?.intervalHandle) {
      window.clearInterval(previousRecorder.intervalHandle);
    }

    const startedAt = performance.now();
    const samples = [];
    const recordSample = () => {
      try {
        samples.push({
          ts: performance.now() - startedAt,
          state: JSON.parse(window.render_game_to_text?.() ?? "{}"),
        });
      } catch {
        // Ignore transient parse failures during teardown.
      }
    };

    recordSample();
    const intervalHandle = window.setInterval(recordSample, 12);
    window.__netcodeRecorder = {
      intervalHandle,
      samples,
    };
  });
}

async function stopRecording(page) {
  return page.evaluate(() => {
    const recorder = window.__netcodeRecorder;
    if (!recorder) {
      return [];
    }

    if (recorder.intervalHandle) {
      window.clearInterval(recorder.intervalHandle);
    }

    const samples = recorder.samples ?? [];
    window.__netcodeRecorder = null;
    return samples;
  });
}

function analyseSamples(samples, label) {
  const runningSamples = samples.filter((sample) => sample.state?.game?.status === "running");
  const tickRateMs = runningSamples[0]?.state?.game?.tickRateMs ?? 100;
  const lateGapThresholdMs = Math.round(tickRateMs * 1.4);
  const displayGaps = [];
  const idleGaps = [];
  let maxCorrectionCount = 0;
  let maxCorrectionDistance = 0;
  let maxPredictionLead = 0;
  let maxPendingInputs = 0;
  let previousDisplayTick = null;
  let previousDisplayAt = null;
  let idleSegmentStartAt = null;
  let idleSegmentTick = null;

  for (const sample of runningSamples) {
    const online = sample.state?.online ?? {};
    const network = online.network ?? {};
    const displayTick = Number(online.displayTick ?? 0);
    const transitionActive = Boolean(sample.state?.transition);

    maxCorrectionCount = Math.max(maxCorrectionCount, Number(network.correctionCount ?? 0));
    maxCorrectionDistance = Math.max(
      maxCorrectionDistance,
      Number(network.lastCorrectionDistance ?? 0),
    );
    maxPredictionLead = Math.max(maxPredictionLead, Number(network.predictionLeadTicks ?? 0));
    maxPendingInputs = Math.max(maxPendingInputs, Number(network.pendingInputs ?? 0));

    if (!transitionActive) {
      if (idleSegmentStartAt === null || idleSegmentTick !== displayTick) {
        idleSegmentStartAt = sample.ts;
        idleSegmentTick = displayTick;
      }
    } else if (idleSegmentStartAt !== null) {
      idleGaps.push(Math.max(0, sample.ts - idleSegmentStartAt));
      idleSegmentStartAt = null;
      idleSegmentTick = null;
    }

    if (previousDisplayTick === null) {
      previousDisplayTick = displayTick;
      previousDisplayAt = sample.ts;
      continue;
    }

    if (displayTick > previousDisplayTick && previousDisplayAt !== null) {
      displayGaps.push(sample.ts - previousDisplayAt);
      if (idleSegmentStartAt !== null && idleSegmentTick === previousDisplayTick) {
        idleGaps.push(Math.max(0, sample.ts - idleSegmentStartAt));
        idleSegmentStartAt = null;
        idleSegmentTick = null;
      }
      previousDisplayTick = displayTick;
      previousDisplayAt = sample.ts;
    }
  }

  if (idleSegmentStartAt !== null) {
    const lastSampleAt = runningSamples.at(-1)?.ts ?? idleSegmentStartAt;
    idleGaps.push(Math.max(0, lastSampleAt - idleSegmentStartAt));
  }

  displayGaps.sort((a, b) => a - b);
  idleGaps.sort((a, b) => a - b);
  const maxDisplayGapMs = displayGaps.at(-1) ?? 0;
  const lateDisplayGapCount = displayGaps.filter((gap) => gap > lateGapThresholdMs).length;
  const maxIdleGapMs = idleGaps.at(-1) ?? 0;
  const lateIdleGapCount = idleGaps.filter((gap) => gap > lateGapThresholdMs).length;

  return {
    label,
    sampleCount: samples.length,
    runningSampleCount: runningSamples.length,
    tickRateMs,
    maxDisplayGapMs,
    p95DisplayGapMs: percentile(displayGaps, 0.95),
    lateDisplayGapCount,
    maxIdleGapMs,
    p95IdleGapMs: percentile(idleGaps, 0.95),
    lateIdleGapCount,
    maxCorrectionCount,
    maxCorrectionDistance,
    maxPredictionLead,
    maxPendingInputs,
    endedEarly: samples.at(-1)?.state?.game?.status !== "running",
    finalStatus: samples.at(-1)?.state?.game?.status ?? "unknown",
  };
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index] ?? 0;
}

function makeAssertion(name, ok, details) {
  return { name, ok, details };
}

function computeDelayMs(baseDelayMs, jitterMs) {
  if (baseDelayMs <= 0 && jitterMs <= 0) {
    return 0;
  }

  const variance = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
  return Math.max(0, Math.round(baseDelayMs + variance));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const resolvedCommand =
      command === "npm" && process.env.npm_execpath
        ? {
            executable: process.execPath,
            args: [process.env.npm_execpath, ...args],
          }
        : {
            executable: command,
            args,
          };

    const child = spawn(resolvedCommand.executable, resolvedCommand.args, {
      cwd: options.cwd ?? rootDir,
      env: options.env ?? process.env,
      stdio: "pipe",
    });

    let stderr = "";
    let stdout = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${options.label ?? command} failed with code ${code}\n${stdout}\n${stderr}`.trim(),
        ),
      );
    });
  });
}

async function waitForOk(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(undefined);
      return;
    }
    child.once("exit", () => resolve(undefined));
  });
}

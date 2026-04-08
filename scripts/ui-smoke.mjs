import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, webkit, devices } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const clientPort = Number(process.env.SMOKE_CLIENT_PORT ?? 4173);
const serverPort = Number(process.env.SMOKE_SERVER_PORT ?? 3567);
const baseUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${clientPort}`;
const wsBaseUrl = process.env.SMOKE_WS_URL?.trim() || `ws://127.0.0.1:${serverPort}`;
const usesExternalBaseUrl = Boolean(process.env.SMOKE_BASE_URL?.trim());

const smokeRootDir = path.join(rootDir, ".tmp", "qa-smoke");
const artifactsDir = path.join(smokeRootDir, "artifacts");
const smokeClientDistDir = path.join(smokeRootDir, "client-dist");
const serverLogPath = path.join(smokeRootDir, "server.log");

/** @type {Array<{scenario: string; ok: boolean; details: unknown}>} */
const assertions = [];

await fs.mkdir(artifactsDir, { recursive: true });

let stopStaticServer = null;
let stopGameServer = null;

try {
  if (!usesExternalBaseUrl) {
    await prepareSmokeBuild();
    stopGameServer = await startGameServer();
    stopStaticServer = await startStaticServer();

    await waitForOk(`${wsBaseUrl.replace("ws://", "http://").replace("wss://", "https://")}/health`);
    await waitForOk(baseUrl);
  }

  const results = [];
  results.push(await runMenuScenario());
  results.push(await runDesktopLocalScenario());
  results.push(await runMobileMenuScenario());
  results.push(await runMobileLocalScenario());
  results.push(await runMobileLocalFullscreenScenario());
  results.push(await runAutomationHooksScenario());
  results.push(await runMobileLocalGameOverScenario());
  results.push(await runAndroidPortraitScenario());
  results.push(await runAndroidLandscapeScenario());
  results.push(await runOnlineWaitingScenario());
  results.push(await runWebkitOnlineScenario());

  const summaryPath = path.join(artifactsDir, "summary.json");
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        baseUrl,
        wsBaseUrl: usesExternalBaseUrl ? process.env.SMOKE_WS_URL ?? null : wsBaseUrl,
        external: usesExternalBaseUrl,
        assertions,
        results,
      },
      null,
      2,
    ),
  );

  const failed = assertions.filter((assertion) => !assertion.ok);
  if (failed.length > 0) {
    console.error(JSON.stringify({ failed, summaryPath }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, summaryPath, assertions: assertions.length }, null, 2));
  }
} finally {
  await Promise.allSettled([stopStaticServer?.(), stopGameServer?.()].filter(Boolean));
}

async function prepareSmokeBuild() {
  await fs.rm(smokeRootDir, { recursive: true, force: true });
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
  const outDir = path.relative(clientDir, smokeClientDistDir);

  await runCommand(
    "node",
    [path.join(rootDir, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir],
    {
      cwd: clientDir,
      env: {
        ...process.env,
        VITE_COLYSEUS_URL: wsBaseUrl,
      },
      label: "client smoke build",
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
      let filePath = path.join(smokeClientDistDir, pathname);
      let stat = await fs.stat(filePath).catch(() => null);

      if (stat?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        stat = await fs.stat(filePath).catch(() => null);
      }

      if (!stat) {
        filePath = path.join(smokeClientDistDir, "index.html");
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

async function runMenuScenario() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "desktop-menu.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("desktop menu fits viewport", snapshot.scroll.scrollHeight <= snapshot.viewport.height + 4, {
    scrollHeight: snapshot.scroll.scrollHeight,
    viewportHeight: snapshot.viewport.height,
  });
  pushAssertion("desktop menu has no page errors", issues.pageErrors.length === 0, issues.pageErrors);
  pushAssertion("desktop menu has no request failures", issues.requestFailures.length === 0, issues.requestFailures);

  await context.close();
  await browser.close();

  return { scenario: "desktop-menu", screenshotPath, snapshot, issues };
}

async function runDesktopLocalScenario() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(1200);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "desktop-local.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion(
    "desktop local keeps the hud outside the playfield",
    (snapshot.hud?.bottom ?? 0) <= (snapshot.section?.top ?? Number.POSITIVE_INFINITY) + 1,
    { hud: snapshot.hud, section: snapshot.section },
  );
  pushAssertion(
    "desktop local keeps the square canvas inside the panel height",
    (snapshot.canvas?.cssHeight ?? Number.POSITIVE_INFINITY) <=
      (snapshot.section?.height ?? Number.NEGATIVE_INFINITY) + 1,
    { canvas: snapshot.canvas, section: snapshot.section },
  );
  pushAssertion(
    "desktop local keeps the square canvas visible",
    !snapshot.canvas?.outOfViewport,
    snapshot.canvas,
  );
  pushAssertion("desktop local has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "desktop-local", screenshotPath, snapshot, issues };
}

async function runMobileMenuScenario() {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPhone SE"] });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "mobile-menu-iphone-se.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("mobile menu has no vertical scroll", !snapshot.scroll.hasVerticalScroll, snapshot.scroll);
  pushAssertion("mobile menu CTA fits viewport", allButtonsFit(snapshot), snapshot.buttons);
  pushAssertion("mobile menu has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-menu-iphone-se", screenshotPath, snapshot, issues };
}

async function runMobileLocalScenario() {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPhone SE"] });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(1200);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "mobile-local-iphone-se.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("mobile local has no vertical scroll", !snapshot.scroll.hasVerticalScroll, snapshot.scroll);
  pushAssertion("mobile local dock fits viewport", !snapshot.touchDock?.outOfViewport, snapshot.touchDock);
  pushAssertion("mobile local controls fit viewport", allButtonsFit(snapshot), snapshot.buttons);
  pushAssertion(
    "mobile local keeps the hud outside the playfield",
    (snapshot.hud?.bottom ?? 0) <= (snapshot.section?.top ?? Number.POSITIVE_INFINITY) + 1,
    { hud: snapshot.hud, section: snapshot.section },
  );
  pushAssertion(
    "mobile local keeps a readable playfield size",
    (snapshot.canvas?.cssHeight ?? 0) >= 240,
    snapshot.canvas,
  );
  pushAssertion("mobile local keeps game visible", (snapshot.section?.bottom ?? 0) < snapshot.viewport.height, snapshot.section);
  pushAssertion("mobile local has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-local-iphone-se", screenshotPath, snapshot, issues };
}

async function runMobileLocalFullscreenScenario() {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPhone SE"] });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Plein ecran/i }).click();
  await page.waitForTimeout(350);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "mobile-local-iphone-se-fullscreen.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("mobile local fullscreen has no vertical scroll", !snapshot.scroll.hasVerticalScroll, snapshot.scroll);
  pushAssertion("mobile local fullscreen keeps the dock within viewport", !snapshot.touchDock?.outOfViewport, snapshot.touchDock);
  pushAssertion("mobile local fullscreen keeps the arena within viewport", !snapshot.section?.outOfViewport, snapshot.section);
  pushAssertion(
    "mobile local fullscreen keeps a dense backing canvas",
    (snapshot.canvas?.backingScaleX ?? 0) >= 1 && (snapshot.canvas?.backingScaleX ?? 0) <= 2.05,
    snapshot.canvas,
  );
  pushAssertion(
    "mobile local fullscreen exposes an exit action",
    snapshot.buttons.some((button) => /quitter/i.test(button.text)),
    snapshot.buttons,
  );
  pushAssertion("mobile local fullscreen has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-local-iphone-se-fullscreen", screenshotPath, snapshot, issues };
}

async function runAutomationHooksScenario() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(120);

  const countdownState = await page.evaluate(() => JSON.parse(window.render_game_to_text?.() ?? "{}"));
  await page.waitForTimeout(3200);

  const before = await page.evaluate(() => JSON.parse(window.render_game_to_text?.() ?? "{}"));
  const zeroStepAdvance = await page.evaluate(() => window.advanceTime?.(0) ?? null);
  await page.waitForTimeout(90);
  const afterNoop = await page.evaluate(() => JSON.parse(window.render_game_to_text?.() ?? "{}"));

  await page.evaluate(async () => {
    for (let index = 0; index < 10; index += 1) {
      await window.advanceTime?.(1000 / 60);
    }
  });
  const afterManualAdvance = await page.evaluate(() =>
    JSON.parse(window.render_game_to_text?.() ?? "{}"),
  );
  const screenshotPath = path.join(artifactsDir, "automation-hooks-local.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const beforeHeads = before.game?.snakes?.map((snake) => snake.body?.[0] ?? null) ?? [];
  const afterNoopHeads = afterNoop.game?.snakes?.map((snake) => snake.body?.[0] ?? null) ?? [];
  const afterManualAdvanceHeads =
    afterManualAdvance.game?.snakes?.map((snake) => snake.body?.[0] ?? null) ?? [];

  pushAssertion(
    "local automation exposes a pre-round countdown",
    countdownState.countdown?.active === true && countdownState.game?.status === "waiting",
    countdownState,
  );
  pushAssertion("advanceTime(0) reports zero steps", zeroStepAdvance === 0, zeroStepAdvance);
  pushAssertion(
    "advanceTime(0) keeps the automatic loop running",
    JSON.stringify(beforeHeads) !== JSON.stringify(afterNoopHeads),
    { beforeHeads, afterNoopHeads },
  );
  pushAssertion(
    "advanceTime(0) does not force manual mode",
    afterNoop.automation?.manualTimeControl === false,
    afterNoop.automation,
  );
  pushAssertion(
    "advanceTime(frame) accumulates partial frame deltas into gameplay ticks",
    JSON.stringify(afterNoopHeads) !== JSON.stringify(afterManualAdvanceHeads),
    { afterNoopHeads, afterManualAdvanceHeads },
  );
  pushAssertion(
    "advanceTime(frame) switches to manual control once stepping begins",
    afterManualAdvance.automation?.manualTimeControl === true,
    afterManualAdvance.automation,
  );
  pushAssertion("automation hooks have no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return {
    scenario: "automation-hooks-local",
    screenshotPath,
    countdownState,
    before,
    afterNoop,
    afterManualAdvance,
    issues,
    zeroStepAdvance,
  };
}

async function runMobileLocalGameOverScenario() {
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ ...devices["iPhone SE"] });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(5200);

  const snapshot = await collectSnapshot(page);
  const bodyText = await page.locator("body").innerText();
  const screenshotPath = path.join(artifactsDir, "mobile-local-iphone-se-game-over.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("mobile local game over is visible", /game over|victoire|match nul/i.test(bodyText), bodyText);
  pushAssertion(
    "mobile local game over hides pause action",
    snapshot.buttons.every((button) => !/pause|reprendre/i.test(button.text)),
    snapshot.buttons,
  );
  pushAssertion("mobile local game over hides touch dock", snapshot.touchDock === null, snapshot.touchDock);
  pushAssertion("mobile local game over has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-local-iphone-se-game-over", screenshotPath, snapshot, issues, bodyText };
}

async function runAndroidPortraitScenario() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ...devices["Pixel 5"] });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(1200);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "mobile-local-pixel5.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("android portrait has no vertical scroll", !snapshot.scroll.hasVerticalScroll, snapshot.scroll);
  pushAssertion("android portrait controls fit viewport", allButtonsFit(snapshot), snapshot.buttons);
  pushAssertion("android portrait has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-local-pixel5", screenshotPath, snapshot, issues };
}

async function runAndroidLandscapeScenario() {
  const browser = await chromium.launch({ headless: true });
  const pixel5 = devices["Pixel 5"];
  const viewport = { width: pixel5.viewport.height, height: pixel5.viewport.width };
  const context = await browser.newContext({
    ...pixel5,
    viewport,
    screen: viewport,
  });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Local/i }).click();
  await page.waitForTimeout(1200);

  const snapshot = await collectSnapshot(page);
  const screenshotPath = path.join(artifactsDir, "mobile-local-pixel5-landscape.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("android landscape has no overflow", !snapshot.scroll.hasVerticalScroll && !snapshot.scroll.hasHorizontalScroll, snapshot.scroll);
  pushAssertion("android landscape split controls fit viewport", !snapshot.touchSideControls?.outOfViewport, snapshot.touchSideControls);
  pushAssertion("android landscape has no page errors", issues.pageErrors.length === 0, issues.pageErrors);

  await context.close();
  await browser.close();

  return { scenario: "mobile-local-pixel5-landscape", screenshotPath, snapshot, issues };
}

async function runOnlineWaitingScenario() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const issues = attachIssueCollectors(page);

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Jouer en Ligne/i }).click();
  await page.waitForTimeout(2500);

  const snapshot = await collectSnapshot(page);
  const bodyText = await page.locator("body").innerText();
  const screenshotPath = path.join(artifactsDir, "desktop-online-waiting.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });

  pushAssertion("online waiting keeps a waiting message visible", /en attente d'un adversaire/i.test(bodyText), bodyText);
  pushAssertion("online waiting keeps a room exit CTA", /quitter la room/i.test(bodyText), bodyText);
  pushAssertion(
    "online waiting keeps the phaser canvas backing store at or above display density",
    (snapshot.canvas?.backingWidth ?? 0) >= (snapshot.canvas?.cssWidth ?? 0) &&
      (snapshot.canvas?.backingHeight ?? 0) >= (snapshot.canvas?.cssHeight ?? 0),
    snapshot.canvas,
  );
  pushAssertion("online waiting has no page errors", issues.pageErrors.length === 0, issues.pageErrors);
  pushAssertion("online waiting has no request failures", issues.requestFailures.length === 0, issues.requestFailures);

  await context.close();
  await browser.close();

  return { scenario: "desktop-online-waiting", screenshotPath, snapshot, issues, bodyText };
}

async function runWebkitOnlineScenario() {
  const browser = await webkit.launch({ headless: true });
  const device = devices["iPhone 14 Pro Max"];
  const context1 = await browser.newContext({ ...device });
  const context2 = await browser.newContext({ ...device });
  const page1 = await context1.newPage();
  const page2 = await context2.newPage();
  const issues1 = attachIssueCollectors(page1);
  const issues2 = attachIssueCollectors(page2);

  await Promise.all([
    page1.goto(baseUrl, { waitUntil: "networkidle" }),
    page2.goto(baseUrl, { waitUntil: "networkidle" }),
  ]);

  await Promise.all([
    page1.getByRole("button", { name: /Jouer en Ligne/i }).click(),
    page2.getByRole("button", { name: /Jouer en Ligne/i }).click(),
  ]);

  await page1.waitForTimeout(2200);
  await page2.waitForTimeout(2200);

  const snapshot = await collectSnapshot(page1);
  const screenshotPath = path.join(artifactsDir, "mobile-online-iphone-14pm.png");
  await page1.screenshot({ path: screenshotPath, fullPage: false });

  const bodyText = await page1.locator("body").innerText();
  const combinedErrors = [...issues1.pageErrors, ...issues2.pageErrors];
  const combinedFailures = [...issues1.requestFailures, ...issues2.requestFailures];

  pushAssertion(
    "webkit online exposes round and seat context",
    /MANCHE 1/i.test(bodyText) && /PLAYER1|PLAYER2/i.test(bodyText),
    bodyText,
  );
  pushAssertion("webkit online has no page errors", combinedErrors.length === 0, combinedErrors);
  pushAssertion("webkit online has no request failures", combinedFailures.length === 0, combinedFailures);
  pushAssertion("webkit online touch dock fits viewport", !snapshot.touchDock?.outOfViewport, snapshot.touchDock);
  pushAssertion("webkit online has no vertical scroll", !snapshot.scroll.hasVerticalScroll, snapshot.scroll);

  await Promise.all([context1.close(), context2.close()]);
  await browser.close();

  return {
    scenario: "mobile-online-iphone-14pm",
    screenshotPath,
    snapshot,
    issues: {
      pageErrors: combinedErrors,
      requestFailures: combinedFailures,
      consoleMessages: [...issues1.consoleMessages, ...issues2.consoleMessages],
    },
  };
}

function attachIssueCollectors(page) {
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      errorText: request.failure()?.errorText ?? "unknown",
    });
  });

  return { consoleMessages, pageErrors, requestFailures };
}

async function collectSnapshot(page) {
  return page.evaluate(() => {
    const documentEl = document.scrollingElement || document.documentElement;
    const selectors = {
      header: "header.glass-panel",
      hud: "[data-arena-hud]",
      section: "section.glass-panel",
      footer: "footer.glass-panel",
      touchDock: ".touch-dock",
      touchSideControls: ".touch-side-controls",
    };

    const rectOf = (selector) => {
      const node = document.querySelector(selector);
      if (!node) {
        return null;
      }
      const rect = node.getBoundingClientRect();
      return {
        selector,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        outOfViewport:
          rect.x < -1 ||
          rect.y < -1 ||
          rect.right > window.innerWidth + 1 ||
          rect.bottom > window.innerHeight + 1,
      };
    };

    const buttons = Array.from(document.querySelectorAll("button"))
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0.05;

        return {
          text: button.textContent?.trim() ?? "",
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          visible,
          outOfViewport:
            rect.x < -1 ||
            rect.y < -1 ||
            rect.right > window.innerWidth + 1 ||
            rect.bottom > window.innerHeight + 1,
        };
      })
      .filter((button) => button.visible);

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      scroll: {
        scrollHeight: documentEl.scrollHeight,
        scrollWidth: documentEl.scrollWidth,
        hasVerticalScroll: documentEl.scrollHeight > window.innerHeight + 2,
        hasHorizontalScroll: documentEl.scrollWidth > window.innerWidth + 2,
      },
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      header: rectOf(selectors.header),
      hud: rectOf(selectors.hud),
      section: rectOf(selectors.section),
      footer: rectOf(selectors.footer),
      touchDock: rectOf(selectors.touchDock),
      touchSideControls: rectOf(selectors.touchSideControls),
      canvas: (() => {
        const canvas = document.querySelector(".phaser-viewport canvas");
        if (!(canvas instanceof HTMLCanvasElement)) {
          return null;
        }

        const rect = canvas.getBoundingClientRect();
        const cssWidth = Math.round(rect.width);
        const cssHeight = Math.round(rect.height);

        return {
          cssWidth,
          cssHeight,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          backingScaleX: Number((canvas.width / Math.max(rect.width, 1)).toFixed(2)),
          backingScaleY: Number((canvas.height / Math.max(rect.height, 1)).toFixed(2)),
          outOfViewport:
            rect.x < -1 ||
            rect.y < -1 ||
            rect.right > window.innerWidth + 1 ||
            rect.bottom > window.innerHeight + 1,
        };
      })(),
      buttons,
    };
  });
}

function allButtonsFit(snapshot) {
  return snapshot.buttons.every((button) => !button.outOfViewport);
}

function pushAssertion(scenario, ok, details) {
  assertions.push({ scenario, ok, details });
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
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".woff2":
      return "font/woff2";
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

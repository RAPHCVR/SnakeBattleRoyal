import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const artifactsDir = path.join(rootDir, ".tmp", "deploy-prod");
const envFilePath = path.join(rootDir, ".env.prod");

await fs.mkdir(artifactsDir, { recursive: true });

const fileEnv = await readSimpleEnvFile(envFilePath);
const config = {
  clientHostPort: process.env.CLIENT_HOST_PORT?.trim() || fileEnv.CLIENT_HOST_PORT || "5173",
  serverHostPort: process.env.SERVER_HOST_PORT?.trim() || fileEnv.SERVER_HOST_PORT || "2567",
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || fileEnv.PUBLIC_BASE_URL || "https://snake.raphcvr.me",
  publicWsUrl: process.env.PUBLIC_WS_URL?.trim() || fileEnv.PUBLIC_WS_URL || "wss://apisnake.raphcvr.me",
  viteColyseusUrl:
    process.env.VITE_COLYSEUS_URL?.trim() ||
    fileEnv.VITE_COLYSEUS_URL ||
    process.env.PUBLIC_WS_URL?.trim() ||
    fileEnv.PUBLIC_WS_URL ||
    "wss://apisnake.raphcvr.me",
  skipPublicSmoke: isTruthy(process.env.SKIP_PUBLIC_SMOKE),
  skipLegacyStop: isTruthy(process.env.SKIP_LEGACY_STOP),
};
const publicApiHttpUrl = config.publicWsUrl.replace(/^ws/i, "http").replace(/\/+$/, "");

const commandEnv = {
  ...process.env,
  ...fileEnv,
  CLIENT_HOST_PORT: config.clientHostPort,
  SERVER_HOST_PORT: config.serverHostPort,
  PUBLIC_BASE_URL: config.publicBaseUrl,
  PUBLIC_WS_URL: config.publicWsUrl,
  PUBLIC_API_HTTP_URL: publicApiHttpUrl,
  VITE_COLYSEUS_URL: config.viteColyseusUrl,
};

console.log(
  JSON.stringify(
    {
      step: "deploy-config",
      envFileUsed: Boolean(Object.keys(fileEnv).length),
      clientHostPort: config.clientHostPort,
      serverHostPort: config.serverHostPort,
      publicBaseUrl: config.publicBaseUrl,
      publicWsUrl: config.publicWsUrl,
      viteColyseusUrl: config.viteColyseusUrl,
      skipPublicSmoke: config.skipPublicSmoke,
    },
    null,
    2,
  ),
);

try {
  await runCommand("npm", ["run", "prod:check:full"], {
    cwd: rootDir,
    env: commandEnv,
    label: "preflight checks",
  });

  if (process.platform === "win32" && !config.skipLegacyStop) {
    await stopLegacyWindowsListeners(config.clientHostPort, config.serverHostPort);
  }

  await runCommand("docker", composeArgs("down", "--remove-orphans"), {
    cwd: rootDir,
    env: commandEnv,
    label: "docker compose down",
    allowFailure: true,
  });

  await runCommand("docker", composeArgs("up", "-d", "--build", "--remove-orphans"), {
    cwd: rootDir,
    env: commandEnv,
    label: "docker compose up",
    timeoutMs: 15 * 60 * 1000,
  });

  await waitForOk(`http://127.0.0.1:${config.clientHostPort}`, "local client");
  await waitForOk(`http://127.0.0.1:${config.serverHostPort}/health`, "local server health");

  await runCommand("docker", composeArgs("ps"), {
    cwd: rootDir,
    env: commandEnv,
    label: "docker compose ps",
  });

  await runCommand(process.execPath, [path.join("scripts", "public-health.mjs")], {
    cwd: rootDir,
    env: commandEnv,
    label: "public health",
  });

  if (!config.skipPublicSmoke) {
    await runCommand(process.execPath, [path.join("scripts", "ui-smoke.mjs")], {
      cwd: rootDir,
      env: {
        ...commandEnv,
        SMOKE_BASE_URL: config.publicBaseUrl,
        SMOKE_WS_URL: config.publicWsUrl,
      },
      label: "public smoke",
      timeoutMs: 10 * 60 * 1000,
    });
  }

  const summary = {
    deployedAt: new Date().toISOString(),
    clientHostPort: config.clientHostPort,
    serverHostPort: config.serverHostPort,
    publicBaseUrl: config.publicBaseUrl,
    publicWsUrl: config.publicWsUrl,
    publicApiHttpUrl,
    skipPublicSmoke: config.skipPublicSmoke,
  };

  const summaryPath = path.join(artifactsDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(JSON.stringify({ ok: true, summaryPath }, null, 2));
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

function composeArgs(...tailArgs) {
  const args = ["compose"];
  if (Object.keys(fileEnv).length > 0) {
    args.push("--env-file", ".env.prod");
  }
  args.push("-f", "docker-compose.prod.yml", ...tailArgs);
  return args;
}

async function waitForOk(url, label) {
  const deadline = Date.now() + 60_000;
  let lastError = "Unknown error";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
      lastError = `${label} returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_500);
  }

  throw new Error(`${label} did not become ready: ${lastError}`);
}

async function stopLegacyWindowsListeners(clientPort, serverPort) {
  const ports = [clientPort, serverPort].map((port) => Number(port)).filter(Number.isInteger);
  if (ports.length === 0) {
    return;
  }

  const psWorkspaceRoot = rootDir.replace(/'/gu, "''");
  const command = `
$workspaceRoot = '${psWorkspaceRoot}'
$ports = @(${ports.join(",")})
$targets = @()
foreach ($port in $ports) {
  $connections = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $targets += $connection.OwningProcess
  }
}
$targets = $targets | Sort-Object -Unique
foreach ($targetProcessId in $targets) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $targetProcessId"
    if (-not $process -or -not $process.CommandLine) {
      Write-Output ("Skipping process " + $targetProcessId + ": no command line")
      continue
    }

    $isWorkspaceProcess = $process.CommandLine -match [regex]::Escape($workspaceRoot)
    $isServerProcess = $process.CommandLine -match "apps\\\\server\\\\(dist\\\\index\\.js|src\\\\index\\.ts)"
    $isClientPreview =
      ($process.CommandLine -match "npm-cli\\.js" -and $process.CommandLine -match "run preview --workspace @snake-duel/client") -or
      ($process.CommandLine -match "vite(\\.js)?")

    if ($isServerProcess -or ($isWorkspaceProcess -and $isClientPreview)) {
      Stop-Process -Id $targetProcessId -Force -ErrorAction Stop
      Write-Output ("Stopped process " + $targetProcessId)
    } else {
      Write-Output ("Skipping process " + $targetProcessId + ": not a legacy workspace listener")
    }
  } catch {
    Write-Output ("Failed to stop process " + $targetProcessId + ": " + $_.Exception.Message)
  }
}
`.trim();

  await runCommand("powershell", ["-NoProfile", "-Command", command], {
    cwd: rootDir,
    env: process.env,
    label: "stop legacy listeners",
  });
}

async function readSimpleEnvFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const entries = {};

    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      let value = line.slice(separatorIndex + 1).trim();

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      entries[key] = value;
    }

    return entries;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/iu.test(value ?? "");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = rootDir,
    env = process.env,
    label = command,
    timeoutMs = 0,
    allowFailure = false,
  } = options;

  const { executable, finalArgs } = resolveCommand(command, args);

  await new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });

    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);
    }

    child.on("error", reject);
    child.on("exit", (code) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (code === 0 || allowFailure) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function resolveCommand(command, args) {
  if (command === "npm") {
    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath) {
      return {
        executable: process.execPath,
        finalArgs: [npmExecPath, ...args],
      };
    }
  }

  return {
    executable: command,
    finalArgs: args,
  };
}

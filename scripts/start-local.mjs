#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  inspectBootstrapConfig,
  isAllowedInsecureHttpHost,
  runSetupWizard,
} from "./setup.mjs";

const DEFAULT_DOCKER_WAIT_ATTEMPTS = 60;
const DEFAULT_DOCKER_WAIT_MS = 1_000;

export async function startLocalPrism({
  setupIfMissing = true,
  inspectConfig = inspectBootstrapConfig,
  setupWizard = runSetupWizard,
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmCliPath = process.env.npm_execpath,
  probeDocker = () =>
    commandSucceeds("docker", ["info", "--format", "{{.ServerVersion}}"]),
  probeService = prismServiceReady,
  run = runCommand,
  pause = wait,
  log = console.log,
  dockerWaitAttempts = DEFAULT_DOCKER_WAIT_ATTEMPTS,
  dockerWaitMs = DEFAULT_DOCKER_WAIT_MS,
} = {}) {
  const config = inspectConfig();
  if (!config.configured) {
    if (!setupIfMissing) {
      throw new Error(
        `Prism configuration is incomplete: ${config.missing.join(", ")}`,
      );
    }
    const setup = await setupWizard();
    if (setup.selection === "none") {
      log("Prism is configured and was not started.");
      return;
    }
    if (setup.selection === "docker") {
      await startDockerPrism({
        platform,
        probeDocker,
        run,
        pause,
        log,
        dockerWaitAttempts,
        dockerWaitMs,
        inspectConfig,
      });
      return;
    }
  }

  const npmInvocation = resolveNpmInvocation({
    platform,
    nodeExecutable,
    npmCliPath,
  });
  await ensureDocker({
    platform,
    probeDocker,
    run,
    pause,
    log,
    dockerWaitAttempts,
    dockerWaitMs,
  });

  log("Starting Prism PostgreSQL...");
  await run("docker", [
    "compose",
    "--env-file",
    ".env.local",
    "up",
    "-d",
    "postgres",
  ]);

  log("Applying Prism database migrations...");
  await run(npmInvocation.command, [
    ...npmInvocation.prefixArgs,
    "run",
    "db:migrate",
  ]);

  if (await probeService()) {
    log("Prism's existing web server is healthy at http://localhost:3732.");
    return;
  }

  log("Starting Prism at http://localhost:3732 ...");
  await run(npmInvocation.command, [...npmInvocation.prefixArgs, "run", "dev"]);
}

export async function startDockerPrism({
  platform = process.platform,
  probeDocker = () =>
    commandSucceeds("docker", ["info", "--format", "{{.ServerVersion}}"]),
  run = runCommand,
  pause = wait,
  log = console.log,
  dockerWaitAttempts = DEFAULT_DOCKER_WAIT_ATTEMPTS,
  dockerWaitMs = DEFAULT_DOCKER_WAIT_MS,
  inspectConfig = inspectBootstrapConfig,
} = {}) {
  const config = inspectConfig();
  if (!config.configured) {
    throw new Error(
      `Prism configuration is incomplete: ${config.missing.join(", ")}. Run npm run setup first.`,
    );
  }
  if (!dockerPublicUrlAllowed(config.env)) {
    throw new Error(
      "Prism Docker requires HTTPS, or explicit HTTP opt-in for a localhost, private-network, or link-local URL written by `npm run setup`.",
    );
  }
  await ensureDocker({
    platform,
    probeDocker,
    run,
    pause,
    log,
    dockerWaitAttempts,
    dockerWaitMs,
  });
  log("Building and starting Prism with Docker in the background...");
  await run("docker", [
    "compose",
    "--env-file",
    ".env.local",
    "up",
    "-d",
    "--build",
    "--wait",
  ]);
  log("Prism is healthy in Docker at the configured public URL.");
}

export function dockerPublicUrlAllowed(environment = {}) {
  try {
    const url = new URL(environment.PRISM_PUBLIC_BASE_URL);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["1", "true"].includes(
        String(environment.PRISM_OIDC_ALLOW_INSECURE_HTTP).toLowerCase(),
      ) &&
      isAllowedInsecureHttpHost(url.hostname)
    );
  } catch {
    return false;
  }
}

async function ensureDocker({
  platform,
  probeDocker,
  run,
  pause,
  log,
  dockerWaitAttempts,
  dockerWaitMs,
}) {
  let dockerReady = await probeDocker();
  if (!dockerReady && platform === "win32") {
    log("Docker Desktop is not running. Starting it for Prism...");
    await run("docker", ["desktop", "start"]);
    for (let attempt = 0; attempt < dockerWaitAttempts; attempt += 1) {
      if (await probeDocker()) {
        dockerReady = true;
        break;
      }
      await pause(dockerWaitMs);
    }
  }
  if (!dockerReady) {
    throw new Error(
      "Prism requires a working Docker engine for PostgreSQL. Start Docker, then try again.",
    );
  }
}

async function prismServiceReady() {
  try {
    const response = await fetch("http://localhost:3732/v1/prism/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.service === "ok" && health?.database === "ok";
  } catch {
    return false;
  }
}

export function resolveNpmInvocation({ platform, nodeExecutable, npmCliPath }) {
  if (platform !== "win32") return { command: "npm", prefixArgs: [] };
  if (!npmCliPath) {
    throw new Error(
      "Prism local startup could not locate npm's CLI. Run this command through npm start.",
    );
  }
  return { command: nodeExecutable, prefixArgs: [npmCliPath] };
}

function commandSucceeds(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      shell: false,
      env: process.env,
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || (code === null && signal)) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} exited with code ${code}`),
        );
    });
  });
}

const invokedPath = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedPath) {
  startLocalPrism().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Prism local startup failed.",
    );
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_DOCKER_WAIT_ATTEMPTS = 60;
const DEFAULT_DOCKER_WAIT_MS = 1_000;

export async function startLocalPrism({
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmCliPath = process.env.npm_execpath,
  probeDocker = () => commandSucceeds("docker", ["info", "--format", "{{.ServerVersion}}"]),
  run = runCommand,
  pause = wait,
  log = console.log,
  dockerWaitAttempts = DEFAULT_DOCKER_WAIT_ATTEMPTS,
  dockerWaitMs = DEFAULT_DOCKER_WAIT_MS,
} = {}) {
  const npmInvocation = resolveNpmInvocation({ platform, nodeExecutable, npmCliPath });
  let dockerReady = await probeDocker();

  if (!dockerReady && platform === "win32") {
    log("Docker Desktop is not running. Starting it for Prism local development...");
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
      "Prism local startup requires a working Docker engine for PostgreSQL. Start Docker, then run npm start again.",
    );
  }

  log("Starting Prism PostgreSQL...");
  await run("docker", ["compose", "--env-file", ".env.local", "up", "-d", "postgres"]);

  log("Applying Prism database migrations...");
  await run(npmInvocation.command, [...npmInvocation.prefixArgs, "run", "db:migrate"]);

  log("Starting Prism at http://localhost:3732 ...");
  await run(npmInvocation.command, [...npmInvocation.prefixArgs, "run", "dev"]);
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
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

const invokedPath = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedPath) {
  startLocalPrism().catch((error) => {
    console.error(error instanceof Error ? error.message : "Prism local startup failed.");
    process.exitCode = 1;
  });
}

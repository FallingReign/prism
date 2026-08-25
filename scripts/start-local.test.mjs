import { describe, expect, it, vi } from "vitest";

import { startDockerPrism, startLocalPrism } from "./start-local.mjs";

describe("Prism local startup", () => {
  it("starts PostgreSQL, migrates, and launches the development server", async () => {
    const calls = [];

    await startLocalPrism({
      platform: "win32",
      nodeExecutable: "node.exe",
      npmCliPath: "C:/npm-cli.js",
      probeDocker: async () => true,
      inspectConfig: () => ({ configured: true, missing: [] }),
      probeService: async () => false,
      run: async (command, args) => calls.push([command, ...args]),
      log: () => undefined,
    });

    expect(calls).toEqual([
      ["docker", "compose", "--env-file", ".env.local", "up", "-d", "postgres"],
      ["node.exe", "C:/npm-cli.js", "run", "db:migrate"],
      ["node.exe", "C:/npm-cli.js", "run", "dev"],
    ]);
  });

  it("starts Docker Desktop on Windows when needed", async () => {
    const calls = [];
    const probeDocker = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await startLocalPrism({
      platform: "win32",
      nodeExecutable: "node.exe",
      npmCliPath: "C:/npm-cli.js",
      probeDocker,
      inspectConfig: () => ({ configured: true, missing: [] }),
      probeService: async () => false,
      run: async (command, args) => calls.push([command, ...args]),
      pause: async () => undefined,
      log: () => undefined,
    });

    expect(calls).toEqual([
      ["docker", "desktop", "start"],
      ["docker", "compose", "--env-file", ".env.local", "up", "-d", "postgres"],
      ["node.exe", "C:/npm-cli.js", "run", "db:migrate"],
      ["node.exe", "C:/npm-cli.js", "run", "dev"],
    ]);
  });

  it("reuses an existing web server after restoring its database", async () => {
    const calls = [];

    await startLocalPrism({
      platform: "win32",
      nodeExecutable: "node.exe",
      npmCliPath: "C:/npm-cli.js",
      probeDocker: async () => true,
      inspectConfig: () => ({ configured: true, missing: [] }),
      probeService: async () => true,
      run: async (command, args) => calls.push([command, ...args]),
      log: () => undefined,
    });

    expect(calls).toEqual([
      ["docker", "compose", "--env-file", ".env.local", "up", "-d", "postgres"],
      ["node.exe", "C:/npm-cli.js", "run", "db:migrate"],
    ]);
  });

  it("fails clearly when a Docker engine is unavailable", async () => {
    await expect(
      startLocalPrism({
        platform: "linux",
        probeDocker: async () => false,
        inspectConfig: () => ({ configured: true, missing: [] }),
        run: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toThrow("requires a working Docker engine");
  });

  it("runs setup on first start and honors the Docker selection", async () => {
    const calls = [];
    const inspectConfig = vi.fn()
      .mockReturnValueOnce({ configured: false, missing: [".env.local"] })
      .mockReturnValueOnce({
        configured: true,
        missing: [],
        env: { PRISM_PUBLIC_BASE_URL: "https://prism.example" },
      });

    await startLocalPrism({
      platform: "linux",
      inspectConfig,
      setupWizard: async () => ({ selection: "docker" }),
      probeDocker: async () => true,
      run: async (command, args) => calls.push([command, ...args]),
      log: () => undefined,
    });

    expect(calls).toEqual([
      ["docker", "compose", "--env-file", ".env.local", "up", "-d", "--build", "--wait"],
    ]);
  });

  it("does not prompt when configuration is already valid", async () => {
    const setupWizard = vi.fn();

    await startLocalPrism({
      platform: "linux",
      inspectConfig: () => ({ configured: true, missing: [] }),
      setupWizard,
      probeDocker: async () => true,
      probeService: async () => true,
      run: async () => undefined,
      log: () => undefined,
    });

    expect(setupWizard).not.toHaveBeenCalled();
  });

  it("rejects localhost HTTP before starting the production-mode Docker server", async () => {
    const run = vi.fn();

    await expect(startDockerPrism({
      inspectConfig: () => ({
        configured: true,
        missing: [],
        env: { PRISM_PUBLIC_BASE_URL: "http://localhost:3732" },
      }),
      run,
    })).rejects.toThrow("requires an HTTPS public URL");

    expect(run).not.toHaveBeenCalled();
  });
});

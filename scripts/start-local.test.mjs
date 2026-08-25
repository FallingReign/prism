import { describe, expect, it, vi } from "vitest";

import { startLocalPrism } from "./start-local.mjs";

describe("Prism local startup", () => {
  it("starts PostgreSQL, migrates, and launches the development server", async () => {
    const calls = [];

    await startLocalPrism({
      platform: "win32",
      nodeExecutable: "node.exe",
      npmCliPath: "C:/npm-cli.js",
      probeDocker: async () => true,
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
      probeService: async () => true,
      run: async (command, args) => calls.push([command, ...args]),
      log: () => undefined,
    });

    expect(calls).toEqual([
      ["docker", "compose", "--env-file", ".env.local", "up", "-d", "postgres"],
      ["node.exe", "C:/npm-cli.js", "run", "db:migrate"],
    ]);
  });

  it("can prepare Docker, PostgreSQL, and migrations without starting web", async () => {
    const calls = [];

    await startLocalPrism({
      startWeb: false,
      platform: "win32",
      nodeExecutable: "node.exe",
      npmCliPath: "C:/npm-cli.js",
      probeDocker: async () => true,
      probeService: async () => {
        throw new Error("prepare-only must not probe web");
      },
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
        run: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toThrow("requires a working Docker engine");
  });
});

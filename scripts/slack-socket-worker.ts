import { Client } from "pg";
import { LogLevel, SocketModeClient } from "@slack/socket-mode";

import { getDatabaseUrl } from "../src/server/config";
import { closeDatabasePool, database } from "../src/server/db";
import { createPostgresPrismInboxStore } from "../src/server/slack/postgres-prism-inbox-store";
import { loadSlackSocketConfiguration } from "../src/server/slack/socket-configuration";
import { handleSlackSocketEvent, updateSocketWorkerHealth, type SlackSocketEvent } from "../src/server/slack/socket-worker";

const WORKER_KEY = "primary";
const ADVISORY_LOCK_NAME = "prism:slack-socket-worker:primary";

async function main(): Promise<void> {
  let configuration = await loadSlackSocketConfiguration({ database });
  let disabledReported = false;
  while (!configuration.enabled) {
    await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status: "disabled" });
    if (!disabledReported) {
      console.log("Slack Socket worker is disabled and waiting for configuration.");
      disabledReported = true;
    }
    const signal = createSignalWaiter();
    const outcome = await Promise.race([
      signal.promise.then(() => "shutdown" as const),
      delay(15_000).then(() => "retry" as const)
    ]);
    signal.dispose();
    if (outcome === "shutdown") return;
    configuration = await loadSlackSocketConfiguration({ database });
  }

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) throw new Error("database-unconfigured");
  const lockClient = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;
  let socket: SocketModeClient | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const shutdown = createSignalWaiter();
  try {
    await lockClient.connect();
    const lock = await lockClient.query<{ acquired: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired", [ADVISORY_LOCK_NAME]);
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status: "standby" });
      console.log("Slack Socket worker is in standby because another worker owns the connection.");
      await shutdown.promise;
      return;
    }

    socket = new SocketModeClient({ appToken: configuration.appToken, logLevel: LogLevel.ERROR, autoReconnectEnabled: true });
    const inbox = createPostgresPrismInboxStore(database);
    let status: "starting" | "connected" | "disconnected" | "error" = "starting";
    let lastErrorClass: string | null = null;
    await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status });

    socket.on("slack_event", async (event: SlackSocketEvent) => {
      try {
        await handleSlackSocketEvent({ event, store: inbox, apiAppId: configuration.apiAppId });
        status = "connected";
        lastErrorClass = null;
        await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status }).catch(() => undefined);
      } catch (error) {
        lastErrorClass = error instanceof Error ? error.name : "unknown_error";
        status = "error";
        await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status, lastErrorClass }).catch(() => undefined);
      }
    });
    socket.on("error", (error: unknown) => {
      status = "error";
      lastErrorClass = error instanceof Error ? error.name : "socket_error";
      void updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status, lastErrorClass }).catch(() => undefined);
    });
    socket.on("connected", () => {
      status = "connected";
      lastErrorClass = null;
      void updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status, connectedAt: new Date() }).catch(() => undefined);
    });
    socket.on("disconnected", () => {
      status = "disconnected";
      void updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status }).catch(() => undefined);
    });

    heartbeat = setInterval(() => {
      void updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status, lastErrorClass }).catch(() => undefined);
    }, 15_000);

    await socket.start();
    console.log(`Slack Socket worker started from ${configuration.source} configuration.`);
    await shutdown.promise;
  } finally {
    shutdown.dispose();
    if (heartbeat) clearInterval(heartbeat);
    if (socket) await socket.disconnect().catch(() => undefined);
    if (lockAcquired) {
      await lockClient.query("select pg_advisory_unlock(hashtextextended($1, 0))", [ADVISORY_LOCK_NAME]).catch(() => undefined);
    }
    await lockClient.end().catch(() => undefined);
  }
}

function createSignalWaiter(): { promise: Promise<void>; dispose: () => void } {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let resolveWaiter: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveWaiter = resolve;
  });
  for (const signal of signals) process.once(signal, resolveWaiter);
  return {
    promise,
    dispose: () => {
      for (const signal of signals) process.removeListener(signal, resolveWaiter);
    }
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main()
  .catch(async (error) => {
    console.error("Slack Socket worker failed.", { errorName: error instanceof Error ? error.name : typeof error });
    try {
      await updateSocketWorkerHealth(database, { workerKey: WORKER_KEY, status: "error", lastErrorClass: error instanceof Error ? error.name : "unknown_error" });
    } catch {}
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePool();
  });

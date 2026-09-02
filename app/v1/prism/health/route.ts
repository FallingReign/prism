import { NextResponse } from "next/server";

import { database } from "../../../../src/server/db";
import { checkHealth } from "../../../../src/server/health";
import { readSocketWorkerHealth } from "../../../../src/server/slack/socket-worker";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await checkHealth(database);
  const status = health.database === "ok" ? 200 : 503;
  const socket = health.database === "ok"
    ? await readSocketWorkerHealth(database).catch(() => ({ status: "unavailable" as const, heartbeatAt: null, lastErrorClass: null }))
    : { status: "unavailable" as const, heartbeatAt: null, lastErrorClass: null };

  return NextResponse.json({ ...health, socket }, { status });
}

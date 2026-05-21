import { NextResponse } from "next/server";

import { database } from "../../../../src/server/db";
import { checkHealth } from "../../../../src/server/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const health = await checkHealth(database);
  const status = health.database === "ok" ? 200 : 503;

  return NextResponse.json(health, { status });
}

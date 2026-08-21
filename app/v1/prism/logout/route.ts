import { NextRequest, NextResponse } from "next/server";

import { database } from "../../../../src/server/db";
import { rejectCrossOriginBrowserMutation } from "../../../../src/server/http/browser-mutation-csrf";
import { createPostgresPrismSessionStore, logoutPrismSession } from "../../../../src/server/prism-session";
import { prismSessionCookieName } from "../../../../src/server/slack/oauth-flow";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const csrfRejection = rejectCrossOriginBrowserMutation(request);
  if (csrfRejection) return csrfRejection;

  await logoutPrismSession({
    store: createPostgresPrismSessionStore(database),
    sessionToken: request.cookies.get(prismSessionCookieName)?.value
  });

  const response = NextResponse.json({ status: "logged_out" });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set({
    name: prismSessionCookieName,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: 0
  });
  return response;
}

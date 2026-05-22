import { NextResponse } from "next/server";

import { getSlackOAuthConfig, isSetupRequiredError } from "../../../../../src/server/config";
import { database } from "../../../../../src/server/db";
import { createSlackOAuthStart } from "../../../../../src/server/slack/oauth-flow";
import { createPostgresOAuthFlowStore } from "../../../../../src/server/slack/postgres-store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const config = getSlackOAuthConfig();
    const start = await createSlackOAuthStart({
      store: createPostgresOAuthFlowStore(database),
      config
    });
    const response = NextResponse.redirect(start.redirectUrl, { status: 302 });
    response.cookies.set(start.cookie.name, start.cookie.value, {
      httpOnly: start.cookie.httpOnly,
      sameSite: start.cookie.sameSite,
      secure: start.cookie.secure,
      path: start.cookie.path,
      maxAge: start.cookie.maxAge
    });
    return response;
  } catch (error) {
    if (isSetupRequiredError(error)) {
      return NextResponse.redirect(setupRedirect(), { status: 302 });
    }
    return NextResponse.redirect(errorRedirect(), { status: 302 });
  }
}

function setupRedirect(): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=setup_required`;
}

function errorRedirect(): string {
  const base = process.env.PRISM_PUBLIC_BASE_URL?.includes("replace-with")
    ? "http://localhost:3732"
    : process.env.PRISM_PUBLIC_BASE_URL || "http://localhost:3732";
  return `${base.replace(/\/$/, "")}/?slack=error`;
}

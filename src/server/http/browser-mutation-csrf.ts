import "server-only";

import { NextRequest, NextResponse } from "next/server";

/**
 * Defends cookie-authenticated browser mutations. API clients using bearer
 * credentials do not use this guard; they have no ambient browser credential.
 */
export function rejectCrossOriginBrowserMutation(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  // A browser that supplies Fetch Metadata must be making a same-origin
  // request. In particular, same-site is insufficient: sibling origins must
  // not be able to exercise a Prism browser session.
  if (fetchSite !== null && fetchSite !== "same-origin") return rejected();

  // If Origin is unavailable, only a positive same-origin Fetch Metadata
  // signal is accepted. Metadata-free requests cannot mutate an ambient
  // Prism browser session.
  if (origin === null) return fetchSite === "same-origin" ? null : rejected();
  if (origin === "null") return rejected();

  const expectedOrigin = configuredPrismOrigin();
  return origin === expectedOrigin ? null : rejected();
}

function configuredPrismOrigin(): string | null {
  const configured = process.env.PRISM_PUBLIC_BASE_URL;
  if (!configured || configured.includes("replace-with") || /[\u0000-\u001f\u007f\\]/.test(configured)) return null;

  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function rejected(): NextResponse {
  const response = NextResponse.json({ error: "csrf_rejected" }, { status: 403 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOriginBrowserMutation } from "../http/browser-mutation-csrf";
import {
  SETUP_BROWSER_TRANSACTION_COOKIE_NAME,
  SETUP_BROWSER_TRANSACTION_COOKIE_PATH
} from "./browser-transaction";

export type SetupBrowserMutationProof = {
  expectedOrigin?: string;
  secureBrowserTransactionCookie?: boolean;
  validateBrowserTransaction?(cookieValue: string | undefined, proof: string): boolean;
};

export function rejectUnprovenSetupBrowserMutation(request: NextRequest, dependencies: SetupBrowserMutationProof, proof: string): NextResponse | null {
  const genericRejection = rejectCrossOriginBrowserMutation(request);
  if (!genericRejection) return null;

  const cookieValue = readSingleSetupBrowserTransactionCookie(request.headers.get("cookie"));
  const bindingValid = cookieValue !== undefined && dependencies.validateBrowserTransaction?.(cookieValue, proof) === true;
  const metadataSafe = hasSafeSetupNavigationMetadata(request, dependencies.expectedOrigin);
  if (!bindingValid || !metadataSafe) return genericRejection;
  return null;
}

const MAX_COOKIE_HEADER_BYTES = 8 * 1024;

function readSingleSetupBrowserTransactionCookie(header: string | null): string | undefined {
  if (header === null || header.length > MAX_COOKIE_HEADER_BYTES || new TextEncoder().encode(header).byteLength > MAX_COOKIE_HEADER_BYTES) return undefined;
  let match: string | undefined;
  for (const rawSegment of header.split(";")) {
    const segment = rawSegment.trim();
    const equals = segment.indexOf("=");
    if (equals <= 0 || segment.slice(0, equals) !== SETUP_BROWSER_TRANSACTION_COOKIE_NAME) continue;
    if (match !== undefined) return undefined;
    const value = segment.slice(equals + 1);
    if (value.length === 0 || value.length > 512) return undefined;
    match = value;
  }
  return match;
}

export function clearSetupBrowserTransaction(response: NextResponse, secureCookie: boolean): NextResponse {
  response.cookies.set(SETUP_BROWSER_TRANSACTION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: secureCookie,
    path: SETUP_BROWSER_TRANSACTION_COOKIE_PATH,
    maxAge: 0
  });
  return response;
}

export function hasSafeSetupNavigationMetadata(request: NextRequest, expectedOrigin: string | undefined): boolean {
  if (!expectedOrigin) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null" && origin !== expectedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return fetchSite === null || fetchSite === "none" || fetchSite === "same-origin";
}

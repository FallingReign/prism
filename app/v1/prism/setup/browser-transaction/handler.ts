import { NextRequest, NextResponse } from "next/server";

import {
  SETUP_BROWSER_TRANSACTION_COOKIE_NAME,
  SETUP_BROWSER_TRANSACTION_COOKIE_PATH
} from "../../../../../src/server/setup/browser-transaction";
import { secure } from "../session/handler";

export const setupBrowserTransactionCookieName = SETUP_BROWSER_TRANSACTION_COOKIE_NAME;

export type SetupBrowserTransactionDependencies = {
  secureCookie: boolean;
  issue(): { cookieValue: string; proof: string; expiresAt: Date };
};

export async function handleSetupBrowserTransactionGet(request: NextRequest, dependencies: SetupBrowserTransactionDependencies): Promise<NextResponse> {
  if (request.nextUrl.search.length > 0) return secure(NextResponse.json({ error: "invalid_request" }, { status: 400 }));
  const transaction = dependencies.issue();
  const response = NextResponse.json({ proof: transaction.proof });
  response.cookies.set(SETUP_BROWSER_TRANSACTION_COOKIE_NAME, transaction.cookieValue, {
    httpOnly: true,
    sameSite: "strict",
    secure: dependencies.secureCookie,
    path: SETUP_BROWSER_TRANSACTION_COOKIE_PATH,
    maxAge: Math.max(1, Math.min(300, Math.floor((transaction.expiresAt.getTime() - Date.now()) / 1000)))
  });
  return secure(response);
}

import "server-only";

import { NextResponse } from "next/server";

import type { ConcreteExecutionMode } from "../token-profiles/execution-identity";

export type PrismSlackResponseDiagnostics = {
  requestId: string;
  policyDecision: "allowed" | "denied" | "unsupported" | "auth_failed";
  executionMode?: ConcreteExecutionMode;
  upstreamCalled: boolean;
};

export function slackSuccessResponse(body: unknown, diagnostics: PrismSlackResponseDiagnostics, status = 200): NextResponse {
  return slackApiResponse(body, diagnostics, status);
}

export function slackApiResponse(body: unknown, diagnostics: PrismSlackResponseDiagnostics, status = 200): NextResponse {
  const response = NextResponse.json(body, { status });
  applyPrismDiagnosticsHeaders(response, diagnostics);
  return response;
}

export function applyPrismDiagnosticsHeaders(response: NextResponse, diagnostics: PrismSlackResponseDiagnostics): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Prism-Request-ID", diagnostics.requestId);
  response.headers.set("X-Prism-Policy-Decision", diagnostics.policyDecision);
  response.headers.set("X-Prism-Upstream-Called", diagnostics.upstreamCalled ? "true" : "false");
  if (diagnostics.executionMode) response.headers.set("X-Prism-Execution-Mode", diagnostics.executionMode);
  return response;
}

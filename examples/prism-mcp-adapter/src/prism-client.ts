import type { AdapterConfig, PrismCapabilitiesBody, PrismHttpResult, PrismStatusBody } from "./types.js";

export type PrismClient = {
  status(): Promise<PrismStatusBody>;
  capabilities(): Promise<PrismCapabilitiesBody>;
  callSlackMethod(input: { method: string; httpMethod: "GET" | "POST"; payload: Record<string, unknown>; headers?: Record<string, string> }): Promise<PrismHttpResult>;
};

export function createPrismClient({ config, fetch = globalThis.fetch }: { config: AdapterConfig; fetch?: typeof globalThis.fetch }): PrismClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const authorization = `Bearer ${config.developerToken}`;

  return {
    async status() {
      return (await requestJson(`${baseUrl}/v1/prism/status`, { method: "GET", headers: { authorization } }, fetch)).body as PrismStatusBody;
    },
    async capabilities() {
      return (await requestJson(`${baseUrl}/v1/prism/capabilities`, { method: "GET", headers: { authorization } }, fetch)).body as PrismCapabilitiesBody;
    },
    async callSlackMethod({ method, httpMethod, payload, headers = {} }) {
      const requestHeaders = { authorization, ...headers };
      if (httpMethod === "GET") {
        const url = new URL(`${baseUrl}/v1/slack/api/${method}`);
        for (const [key, value] of Object.entries(payload)) {
          if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
        }
        return requestJson(url.toString(), { method: "GET", headers: requestHeaders }, fetch);
      }

      return requestJson(
        `${baseUrl}/v1/slack/api/${method}`,
        {
          method: "POST",
          headers: { ...requestHeaders, "content-type": "application/json" },
          body: JSON.stringify(stripLocalToken(payload))
        },
        fetch
      );
    }
  };
}

async function requestJson(url: string, init: RequestInit, fetch: typeof globalThis.fetch): Promise<PrismHttpResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    body,
    headers: selectedHeaders(response.headers)
  };
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const header of ["x-prism-request-id", "x-prism-upstream-called", "x-prism-policy-decision", "x-prism-execution-mode", "retry-after", "x-slack-req-id"]) {
    const value = headers.get(header);
    if (value) selected[header] = value;
  }
  return selected;
}

function stripLocalToken(payload: Record<string, unknown>): Record<string, unknown> {
  const { token: _token, ...safePayload } = payload;
  return safePayload;
}

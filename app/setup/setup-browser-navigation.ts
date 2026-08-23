type BrowserFetch = (input: string, init: RequestInit) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export async function prepareSetupBrowserTransaction(input: { fetcher?: BrowserFetch } = {}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher("/v1/prism/setup/browser-transaction", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  const body = await response.json();
  if (!response.ok || !isExactProofResponse(body)) throw new Error("setup_browser_transaction_failed");
  return body.proof;
}

function isExactProofResponse(value: unknown): value is { proof: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.proof === "string" && isSetupProof(record.proof);
}

function isSetupProof(value: string): boolean {
  return /^v1\.\d{13}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(value);
}

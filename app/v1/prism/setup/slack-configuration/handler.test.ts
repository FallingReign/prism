import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSlackConfigurationPost, handleSlackConfigurationPut } from "./handler";

const SETUP_PROOF = `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"b".repeat(43)}`;

describe("PUT /v1/prism/setup/slack-configuration", () => {
  beforeEach(() => {
    vi.stubEnv("PRISM_PUBLIC_BASE_URL", "http://localhost:3732");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("saves through the server-resolved setup session and returns only redacted fields", async () => {
    const secret = "client-secret-canary";
    const createPendingConfiguration = vi.fn().mockResolvedValue({ clientId: "123.456", version: "7", botScopes: ["users:read"], userScopes: ["chat:write"] });
    const response = await handleSlackConfigurationPut(configurationRequest({ clientId: "123.456", clientSecret: secret, botScopes: ["users:read"], userScopes: ["chat:write"] }), {
      resolveSession: vi.fn().mockResolvedValue({ id: "setup-session-1", pendingConfigurationVersionId: "server-selected-pending" }),
      createPendingConfiguration
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ configuration: { clientId: "123.456", version: "7", secretStored: true, botScopes: ["users:read"], userScopes: ["chat:write"] } });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("server-selected-pending");
    expect(createPendingConfiguration).toHaveBeenCalledWith(expect.objectContaining({ setupSessionId: "setup-session-1", expectedPendingVersionId: "server-selected-pending", clientSecret: secret, requestId: expect.any(String) }));
  });

  it("rejects an absent setup session and does not inspect configuration values", async () => {
    const createPendingConfiguration = vi.fn();
    const response = await handleSlackConfigurationPut(configurationRequest({ clientId: "123", clientSecret: "secret-canary", botScopes: [], userScopes: ["chat:write"] }, false), {
      resolveSession: vi.fn().mockResolvedValue(null),
      createPendingConfiguration
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_expired" });
    expect(createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("fails closed on cross-origin and oversized bodies", async () => {
    const dependencies = { resolveSession: vi.fn(), createPendingConfiguration: vi.fn() };
    const crossOrigin = await handleSlackConfigurationPut(configurationRequest({ clientId: "123", clientSecret: "secret", botScopes: [], userScopes: ["chat:write"] }, true, "https://attacker.invalid"), dependencies);
    const oversized = await handleSlackConfigurationPut(new NextRequest("http://localhost:3732/v1/prism/setup/slack-configuration", { method: "PUT", headers: headers({ "content-length": "20000", cookie: "prism_setup_session=session" }), body: "{}" }), dependencies);

    expect(crossOrigin.status).toBe(403);
    expect(oversized.status).toBe(413);
    expect(dependencies.resolveSession).not.toHaveBeenCalled();
    expect(dependencies.createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("rejects every query string before setup-session or body work", async () => {
    const dependencies = { resolveSession: vi.fn(), createPendingConfiguration: vi.fn() };
    const request = configurationRequest(
      { clientId: "123", clientSecret: "secret", botScopes: [], userScopes: ["chat:write"] },
      true,
      "http://localhost:3732",
      "?versionId=browser-selected"
    );

    const response = await handleSlackConfigurationPut(request, dependencies);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(dependencies.resolveSession).not.toHaveBeenCalled();
    expect(dependencies.createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("rejects unknown JSON fields before saving", async () => {
    const createPendingConfiguration = vi.fn();
    const response = await handleSlackConfigurationPut(configurationRequest({ clientId: "123", clientSecret: "secret", userScopes: ["chat:write"], botScopes: [], versionId: "browser-selected" }), {
      resolveSession: vi.fn().mockResolvedValue({ id: "setup-session", pendingConfigurationVersionId: null }),
      createPendingConfiguration
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_configuration" });
    expect(createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("maps validation and conflict failures without reflecting submitted secrets", async () => {
    const secret = "secret-error-canary";
    for (const [code, expectedStatus, expectedError] of [["invalid_input", 400, "invalid_configuration"], ["conflict", 409, "configuration_conflict"], ["environment_locked", 409, "environment_locked"]] as const) {
      const error = Object.assign(new Error(secret), { code });
      const response = await handleSlackConfigurationPut(configurationRequest({ clientId: "123", clientSecret: secret, botScopes: [], userScopes: ["chat:write"] }), {
        resolveSession: vi.fn().mockResolvedValue({ id: "setup-session", pendingConfigurationVersionId: null }),
        createPendingConfiguration: vi.fn().mockRejectedValue(error)
      });
      const text = await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(JSON.parse(text)).toEqual({ error: expectedError });
      expect(text).not.toContain(secret);
    }
  });

  it.each([
    ["cookie-bound with opaque metadata", "null", "none", true],
    ["cookie-bound with exact origin", "http://localhost:3732", "none", true]
  ])("saves a native form using %s and redirects only to the configured public origin", async (_label, origin, fetchSite, withProofCookie) => {
    const secret = "native-client-secret-canary";
    const createPendingConfiguration = vi.fn().mockResolvedValue({ clientId: "123.456", version: "8", botScopes: ["users:read"], userScopes: ["chat:write"] });
    const response = await handleSlackConfigurationPost(nativeConfigurationRequest({ origin, fetchSite, withProofCookie, secret, requestUrl: "http://0.0.0.0:3732/v1/prism/setup/slack-configuration" }), nativeDependencies(createPendingConfiguration));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3732/setup");
    expect(response.headers.get("location")).not.toContain(secret);
    expect(response.headers.get("set-cookie")).toMatch(/prism_setup_browser_transaction=;/i);
    expect(createPendingConfiguration).toHaveBeenCalledWith(expect.objectContaining({ clientId: "123.456", clientSecret: secret, botScopes: ["users:read"], userScopes: ["chat:write"] }));
  });

  it.each([
    ["attacker origin", "https://attacker.invalid", "none", SETUP_PROOF],
    ["cross-site", null, "cross-site", SETUP_PROOF],
    ["same-site", null, "same-site", SETUP_PROOF],
    ["tampered proof", null, "none", `v1.${"1".repeat(13)}.${"a".repeat(43)}.${"c".repeat(43)}`]
  ])("rejects native configuration submission with %s", async (_label, origin, fetchSite, proof) => {
    const createPendingConfiguration = vi.fn();
    const response = await handleSlackConfigurationPost(nativeConfigurationRequest({ origin, fetchSite, proof }), nativeDependencies(createPendingConfiguration));

    expect(response.status).toBe(origin === "https://attacker.invalid" || fetchSite === "cross-site" || fetchSite === "same-site" ? 403 : 303);
    if (response.status === 303) expect(response.headers.get("location")).toBe("http://localhost:3732/setup?error=secure_form_expired");
    expect(createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("rejects unknown, duplicate, and oversized native form fields before saving", async () => {
    const createPendingConfiguration = vi.fn();
    const dependencies = nativeDependencies(createPendingConfiguration);
    const base = new URLSearchParams({ setupProof: SETUP_PROOF, clientId: "123", clientSecret: "secret", userScope: "chat:write" });
    const unknown = new URLSearchParams(base); unknown.set("versionId", "browser-selected");
    const duplicate = new URLSearchParams(base); duplicate.append("clientId", "456");
    const request = (body: string, contentLength?: string) => new NextRequest("http://0.0.0.0:3732/v1/prism/setup/slack-configuration", { method: "POST", headers: nativeHeaders({ ...(contentLength ? { "content-length": contentLength } : {}) }), body });

    expect((await handleSlackConfigurationPost(request(unknown.toString()), dependencies)).status).toBe(303);
    expect((await handleSlackConfigurationPost(request(duplicate.toString()), dependencies)).status).toBe(303);
    expect((await handleSlackConfigurationPost(request(base.toString(), "20000"), dependencies)).status).toBe(413);
    expect(createPendingConfiguration).not.toHaveBeenCalled();
  });

  it("requires the exact native form media-type essence while accepting normal casing, whitespace, and parameters", async () => {
    const createPendingConfiguration = vi.fn().mockResolvedValue({ clientId: "123.456", version: "8", botScopes: ["users:read"], userScopes: ["chat:write"] });
    const dependencies = nativeDependencies(createPendingConfiguration);
    const prefixed = await handleSlackConfigurationPost(nativeConfigurationRequest({
      origin: "http://localhost:3732",
      fetchSite: "same-origin",
      contentType: "application/x-www-form-urlencoded-evil"
    }), dependencies);
    const parameterized = await handleSlackConfigurationPost(nativeConfigurationRequest({
      origin: "http://localhost:3732",
      fetchSite: "same-origin",
      contentType: " Application/X-WWW-Form-Urlencoded ; charset=UTF-8 "
    }), dependencies);

    expect(prefixed.status).toBe(415);
    expect(parameterized.status).toBe(303);
    expect(createPendingConfiguration).toHaveBeenCalledOnce();
  });
});

function nativeDependencies(createPendingConfiguration: ReturnType<typeof vi.fn>) {
  return {
    expectedOrigin: "http://localhost:3732",
    secureBrowserTransactionCookie: false,
    validateBrowserTransaction: (cookieValue: string | undefined, proof: string) => cookieValue === "signed-browser-cookie" && proof === SETUP_PROOF,
    resolveSession: vi.fn().mockResolvedValue({ id: "setup-session-1", pendingConfigurationVersionId: null }),
    createPendingConfiguration
  };
}

function nativeConfigurationRequest(input: { origin?: string | null; fetchSite?: string | null; withProofCookie?: boolean; proof?: string; secret?: string; requestUrl?: string; contentType?: string } = {}) {
  const form = new URLSearchParams({ setupProof: input.proof ?? SETUP_PROOF, clientId: "123.456", clientSecret: input.secret ?? "secret", botScope: "users:read", userScope: "chat:write" });
  return new NextRequest(input.requestUrl ?? "http://0.0.0.0:3732/v1/prism/setup/slack-configuration", {
    method: "POST",
    headers: nativeHeaders({
      ...(input.origin !== null ? { origin: input.origin ?? "null" } : {}),
      ...(input.fetchSite !== null ? { "sec-fetch-site": input.fetchSite ?? "none" } : {}),
      ...(input.contentType ? { "content-type": input.contentType } : {}),
      cookie: `prism_setup_session=setup-session-token${input.withProofCookie ? "; prism_setup_browser_transaction=signed-browser-cookie" : ""}`
    }),
    body: form.toString()
  });
}

function nativeHeaders(extra: Record<string, string> = {}) {
  return { "content-type": "application/x-www-form-urlencoded", ...extra };
}

function configurationRequest(body: unknown, cookie = true, origin = "http://localhost:3732", search = "") {
  return new NextRequest(`http://localhost:3732/v1/prism/setup/slack-configuration${search}`, {
    method: "PUT",
    headers: headers({ origin, ...(cookie ? { cookie: "prism_setup_session=setup-session-token" } : {}) }),
    body: JSON.stringify(body)
  });
}

function headers(extra: Record<string, string> = {}) {
  return { origin: "http://localhost:3732", "sec-fetch-site": "same-origin", "content-type": "application/json", ...extra };
}

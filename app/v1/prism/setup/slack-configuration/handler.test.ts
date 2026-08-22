import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSlackConfigurationPut } from "./handler";

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
});

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

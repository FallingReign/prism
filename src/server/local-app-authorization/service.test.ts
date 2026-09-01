import { describe, expect, it, vi } from "vitest";

import type { LocalAppAuthorizationStore } from "./types";
import {
  beginLocalAppAuthorization,
  decideLocalAppAuthorization,
  pollLocalAppAuthorization,
  resolveLocalAppConsent
} from "./service";

function store(overrides: Partial<LocalAppAuthorizationStore> = {}): LocalAppAuthorizationStore {
  return {
    begin: vi.fn(async () => "created"),
    consumeRequestRateLimit: vi.fn(async () => true),
    resolveConsent: vi.fn(async () => ({ kind: "unavailable" })),
    decide: vi.fn(async () => "approved"),
    denyAfterOAuth: vi.fn(async () => undefined),
    exchange: vi.fn(async () => ({ kind: "pending" })),
    ...overrides
  };
}

describe("generic local-app authorization service", () => {
  it("returns raw codes once while giving the store hashes only", async () => {
    const begin = vi.fn(async () => "created" as const);
    const result = await beginLocalAppAuthorization({
      store: store({ begin }),
      request: {
        clientId: "example-local-app",
        displayName: "Example Local App",
        intendedUse: "Read and reply to Slack messages",
        requestedPreset: "messages_only",
        executionIdentity: "user"
      },
      publicBaseUrl: "https://prism.example",
      now: new Date("2026-09-01T00:00:00Z"),
      randomBytes: (size) => Buffer.alloc(size, 7),
      randomId: () => "00000000-0000-4000-8000-000000000000"
    });

    expect(result).toMatchObject({
      kind: "created",
      deviceCode: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      userCode: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
      verificationUriComplete: expect.stringContaining("/local-app/authorize?user_code=")
    });
    const stored = begin.mock.calls[0]![0];
    expect(stored.deviceCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.userCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(result.kind === "created" ? result.deviceCode : "never");
  });

  it("binds browser decisions to the hashed website session", async () => {
    const decide = vi.fn(async () => "approved" as const);
    await decideLocalAppAuthorization({
      store: store({ decide }),
      requestId: "00000000-0000-4000-8000-000000000000",
      sessionToken: "website-session-secret",
      decision: "approve",
      auditRequestId: "audit-1"
    });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      sessionTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      decision: "approve"
    }));
    expect(JSON.stringify(decide.mock.calls)).not.toContain("website-session-secret");
  });

  it("requires the OAuth continuation request and browser-held human code to match", async () => {
    const resolveConsent: LocalAppAuthorizationStore["resolveConsent"] = vi.fn(async () => ({
      kind: "preview",
      preview: {
        requestId: "00000000-0000-4000-8000-000000000000",
        clientId: "example-local-app",
        displayName: "Example Local App",
        intendedUse: "Read and reply to Slack messages",
        expiresAt: new Date("2026-09-01T00:10:00Z"),
        rePairing: false,
        identity: {
          prismUserId: "user-1",
          slackConnectionId: "connection-1",
          slackUserId: "U1",
          slackUserDisplayName: "Person",
          installationScope: "workspace",
          teamId: "T1",
          teamName: "Studio",
          enterpriseId: null,
          enterpriseName: null
        }
      }
    }));
    const result = await resolveLocalAppConsent({
      store: store({ resolveConsent }),
      requestId: "00000000-0000-4000-8000-000000000000",
      userCode: "ABCD-2345",
      sessionToken: "website-session-secret"
    });
    expect(resolveConsent).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "00000000-0000-4000-8000-000000000000",
      userCodeHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    }));
    expect(result).toMatchObject({ kind: "preview", preview: { userCode: "ABCD-2345" } });
  });

  it("rate limits invalid device-code polling before exchange lookup", async () => {
    const exchange = vi.fn(async () => ({ kind: "invalid_grant" as const }));
    const result = await pollLocalAppAuthorization({
      store: store({ consumeRequestRateLimit: vi.fn(async () => false), exchange }),
      clientId: "example-local-app",
      deviceCode: "A".repeat(43),
      developerTokenConfig: { pepper: "test-pepper", pepperId: "v1" },
      auditRequestId: "audit-1"
    });
    expect(result).toEqual({ kind: "rate_limited", retryAfterSeconds: 60 });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("generates the copy-once developer token only inside an approved exchange", async () => {
    const exchange: LocalAppAuthorizationStore["exchange"] = vi.fn(async (input) => {
      const credential = input.issueCredential();
      expect(credential.verifier.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      return {
        kind: "issued",
        developerToken: credential.developerToken,
        tokenProfileId: "profile-1",
        clientId: input.clientId,
        subject: {
          prismUserId: "user-1",
          installationScope: "workspace",
          slackTeamId: "T123",
          slackEnterpriseId: null,
          workspaces: [{ teamId: "T123", teamName: "Studio" }]
        }
      };
    });
    const result = await pollLocalAppAuthorization({
      store: store({ exchange }),
      clientId: "example-local-app",
      deviceCode: "A".repeat(43),
      developerTokenConfig: { pepper: "test-pepper", pepperId: "v1" },
      auditRequestId: "audit-1",
      randomBytes: () => Buffer.alloc(32, 9)
    });
    expect(result).toMatchObject({ kind: "issued", developerToken: expect.stringMatching(/^prism_dev_/) });
  });
});

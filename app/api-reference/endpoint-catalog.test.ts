import { describe, expect, it } from "vitest";

import { apiEndpointGroups } from "./endpoint-catalog";

describe("Prism API endpoint catalog", () => {
  it("documents developer and website endpoint groups without listing detailed admin APIs", () => {
    expect(apiEndpointGroups.map((group) => group.title)).toEqual([
      "Local tool endpoints",
      "Website/session management endpoints",
      "Admin handoff"
    ]);

    expect(flatEndpointKeys()).toEqual(
      expect.arrayContaining([
        "GET /v1/prism/health none local-tool",
        "GET /v1/prism/status prismDeveloperToken local-tool",
        "GET /v1/prism/capabilities prismDeveloperToken local-tool",
        "GET /v1/slack/api/{method} prismDeveloperToken local-tool",
        "POST /v1/slack/api/{method} prismDeveloperToken local-tool",
        "GET /v1/prism/token-profiles websiteSession website-session",
        "POST /v1/prism/token-profiles websiteSession website-session",
        "POST /v1/prism/token-profiles/{profileId}/rotate websiteSession website-session",
        "POST /v1/prism/token-profiles/{profileId}/revoke websiteSession website-session",
        "DELETE /v1/prism/token-profiles/{profileId} websiteSession website-session",
        "GET /v1/prism/activity websiteSession website-session",
        "GET /v1/slack/oauth/start websiteSession website-session",
        "GET /v1/slack/oauth/callback websiteSession website-session",
        "DELETE /v1/prism/slack-connection websiteSession website-session"
      ])
    );

    expect(catalogText()).toContain("Admin operations live in the Prism admin console");
    expect(catalogText()).toContain("https://docs.slack.dev/apis/web-api/");
    expect(catalogText()).toContain("https://docs.slack.dev/reference/methods/users.info/");
    expect(catalogText()).toContain("https://docs.slack.dev/reference/methods/chat.postMessage/");
    expect(catalogText()).toContain("https://docs.slack.dev/authentication/installing-with-oauth/");
    expect(catalogText()).not.toMatch(/\/v1\/prism\/admin\/(?:users|session|token-profile-policy)/);
  });

  it("keeps examples placeholder-only and secret safe", () => {
    expect(findSafetyViolations(catalogText())).toEqual([]);
  });
});

function flatEndpointKeys(): string[] {
  return apiEndpointGroups.flatMap((group) =>
    group.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.authModel} ${endpoint.surface}`)
  );
}

function catalogText(): string {
  return JSON.stringify(apiEndpointGroups);
}

function findSafetyViolations(value: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["real-looking Prism developer token", /\bprism_dev_[A-Za-z0-9_-]{32,}\b/],
    ["Slack token format", /\b(?:xox[abpr]|xapp)-[A-Za-z0-9-]{10,}\b/],
    ["concrete Authorization bearer", /Authorization:\s*Bearer\s+(?!prism_dev_\.\.\.)(?!<[^>\n]+>)[A-Za-z0-9._~+/=-]{16,}/i],
    ["client secret value", /client_secret\s*[:=]\s*["']?(?!<[^>\n]+>)[A-Za-z0-9._~+/=-]{8,}/i],
    ["refresh token value", /refresh_token\s*[:=]\s*["']?(?!<[^>\n]+>)[A-Za-z0-9._~+/=-]{8,}/i],
    ["access token value", /access_token\s*[:=]\s*["']?(?!<[^>\n]+>)[A-Za-z0-9._~+/=-]{8,}/i],
    ["token hash canary", /\b(?:tokenHash|TOKEN_HASH_CANARY|token_hash_canary)\b/],
    ["pepper secret canary", /\b(?:pepper-secret-canary|PEPPER_SECRET_CANARY|pepper_secret_canary)\b/],
    [
      "sensitive payload canary",
      /\b(?:MESSAGE_TEXT_CANARY|BLOCK_KIT_CANARY|RAW_SEARCH_QUERY_CANARY|SEARCH_RESULT_CANARY|FILE_CONTENT_CANARY|CANVAS_CONTENT_CANARY|LIST_CONTENT_CANARY)\b/
    ]
  ];

  return checks.flatMap(([label, pattern]) => (pattern.test(value) ? [label] : []));
}

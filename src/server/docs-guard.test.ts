import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const publishedDocs = ["README.md", "docs/setup.md", "docs/security.md", "docs/slack/README.md", "examples/prism-mcp-adapter/README.md"];

describe("Prism published docs", () => {
  it("cover the self-serve setup, security posture, and deferred v1 surfaces", async () => {
    const docs = await readPublishedDocs();

    for (const topic of [
      "Local tool",
      "Prism hosted service",
      "Prism developer token",
      "Slack credentials",
      "Token profile",
      "Capability map",
      "Execution identity",
      "Method registry",
      "Slack-compatible endpoint",
      "Metadata-only audit",
      "Reauth required",
      "PRISM_BASE_URL",
      "/api-reference",
      "Authorization: Bearer",
      "/v1/prism/health",
      "/v1/prism/status",
      "/v1/prism/capabilities",
      "/v1/slack/api/{method}",
      "rotate",
      "revoke",
      "policy",
      "policy denied",
      "unsupported method",
      "Prism-side rate limit",
      "upstream Slack rate limit",
      "credential custody",
      "encrypted envelopes",
      "KMS-equivalent",
      "prompt-injection",
      "local execution",
      "token theft",
      "inbound events",
      "Socket Mode",
      "slash commands",
      "interactivity",
      "app mentions",
      "file transfer",
      "canvases",
      "lists",
      "payload logging",
      "content moderation",
      "Supabase platform services",
      "Slack administration"
    ]) {
      expect(docs.toLowerCase()).toContain(topic.toLowerCase());
    }
  });

  it("reject real-looking secrets, bearer tokens, and sensitive payload examples", async () => {
    const docs = await readPublishedDocs();

    expect(findPublishedDocSafetyViolations(docs)).toEqual([]);
  });

  it("detects unsafe examples while allowing placeholder-only token references", () => {
    const slackTokenLikeValue = `${["xox", "b-"].join("")}${"1".repeat(10)}-${"2".repeat(10)}-${"a".repeat(26)}`;
    const unsafeExamples = `
Authorization: Bearer prism_dev_abcdefghijklmnopqrstuvwxyzABCDEF
${slackTokenLikeValue}
client_secret="super-secret-value"
refresh_token: "refresh-token-value"
access_token: "access-token-value"
MESSAGE_TEXT_CANARY
`;

    expect(findPublishedDocSafetyViolations(unsafeExamples)).toEqual(
      expect.arrayContaining([
        "real-looking Prism developer token",
        "Slack token format",
        "client secret value",
        "refresh token value",
        "access token value",
        "sensitive payload canary"
      ])
    );

    expect(
      findPublishedDocSafetyViolations(`
Authorization: Bearer prism_dev_...
PRISM_DEVELOPER_TOKEN=prism_dev_...
SLACK_CLIENT_SECRET=<placeholder>
`)
    ).toEqual([]);
  });
});

async function readPublishedDocs(): Promise<string> {
  return (await Promise.all(publishedDocs.map((file) => readFile(file, "utf8")))).join("\n");
}

function findPublishedDocSafetyViolations(markdown: string): string[] {
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

  return checks.flatMap(([label, pattern]) => (pattern.test(markdown) ? [label] : []));
}

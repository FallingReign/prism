import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("/api-reference", () => {
  it("renders Prism endpoint docs with auth, diagnostics, failures, audit, and deferred surfaces", async () => {
    const { default: ApiReferencePage } = await import("./page");
    const html = renderToStaticMarkup(<ApiReferencePage />);

    for (const expected of [
      "Prism API reference",
      "PRISM_BASE_URL",
      "Authorization: Bearer prism_dev_...",
      "Prism website session cookie",
      "Local tool endpoints",
      "Website/session management endpoints",
      "/v1/prism/health",
      "/v1/prism/status",
      "/v1/prism/capabilities",
      "/v1/slack/api/{method}",
      "/v1/prism/token-profiles",
      "/v1/prism/activity",
      "/v1/slack/oauth/start",
      "/v1/prism/slack-connection",
      "X-Prism-Surface",
      "X-Prism-Workspace-ID",
      "X-Prism-Execution-Mode",
      "X-Prism-Request-ID",
      "X-Prism-Upstream-Called",
      "Retry-After",
      "Slack Web API reference",
      "Slack users.info documentation",
      "Slack chat.postMessage documentation",
      "Slack OAuth documentation",
      "Slack rate limit documentation",
      "https://docs.slack.dev/apis/web-api/",
      "https://docs.slack.dev/reference/methods/users.info/",
      "https://docs.slack.dev/reference/methods/chat.postMessage/",
      "https://docs.slack.dev/authentication/installing-with-oauth/",
      "https://docs.slack.dev/apis/web-api/rate-limits/",
      "policy denied",
      "unsupported method",
      "Prism-side rate limit",
      "upstream Slack rate limit",
      "metadata only",
      "Admin operations live in the Prism admin console",
      "Events, slash commands, Block Kit interactivity, file transfer, canvases, and lists are deferred"
    ]) {
      expect(html).toContain(expected);
    }

    expect(html).not.toMatch(/\/v1\/prism\/admin\/(?:users|session|token-profile-policy)/);
    expect(html).not.toMatch(/prism_dev_[A-Za-z0-9_-]{32,}|xox[baprs]-|client_secret|refresh_token|access_token|tokenHash/i);
  });
});

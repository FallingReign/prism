import { describe, expect, it } from "vitest";

import {
  renderDelegatedConsentCsrfErrorPage,
  renderDelegatedConsentErrorPage,
  renderDelegatedConsentPage
} from "./presentation";

describe("delegated delivery consent presentation", () => {
  it("renders an escaped readable preview with collapsed exact payload verification", () => {
    const html = renderDelegatedConsentPage({
      requestId: "ddr_1234567890123456",
      externalJobId: "job-123",
      revision: 2,
      payload: {
        channel: "C123ABC",
        text: "Fallback <script>MESSAGE_CANARY</script>",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Release <img src=x>" } },
          { type: "section", text: { type: "mrkdwn", text: "Readable section" }, fields: [{ type: "plain_text", text: "Field one" }] },
          { type: "divider" },
          { type: "context", elements: [{ type: "plain_text", text: "Owner context" }] }
        ]
      },
      payloadSha256: "a".repeat(64),
      channelId: "C123ABC",
      notBefore: new Date("2026-08-22T00:05:00.000Z"),
      deliveryExpiresAt: new Date("2026-08-22T00:35:00.000Z"),
      approvalExpiresAt: new Date("2026-08-22T00:10:00.000Z"),
      identity: {
        prismUserId: "prism-user-123",
        slackConnectionId: "connection-1",
        slackUserId: "U0123456789",
        slackUserDisplayName: "Ada <Admin>",
        teamId: "T0123456789",
        teamName: "Studio"
      }
    });

    expect(html).toContain("Release &lt;img src=x&gt;");
    expect(html).toContain("Readable section");
    expect(html).toContain("Fallback &lt;script&gt;MESSAGE_CANARY&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<details><summary>Advanced payload verification</summary>");
    expect(html).toContain("&quot;channel&quot;:&quot;C123ABC&quot;");
    expect(html).toContain("Approve by");
    expect(html).toContain("@media(max-width:600px)");
    expect(html).toContain(".meta,.block-fields{grid-template-columns:minmax(0,1fr)}");
  });

  it("separates an unverifiable browser mutation from identity policy denial", () => {
    const csrf = renderDelegatedConsentCsrfErrorPage();
    expect(csrf).toContain("Approval request could not be verified");
    expect(csrf).toContain("Return to the original Prism approval page and try again.");
    expect(csrf).not.toContain("not available for this identity");
    expect(csrf).not.toContain("<script");

    const policy = renderDelegatedConsentErrorPage(403);
    expect(policy).toContain("Approval is not available for this identity");
    expect(policy).not.toContain("could not be verified");
  });
});

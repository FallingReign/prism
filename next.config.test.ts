import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("Next development request logging", () => {
  it("suppresses the delegated approval locator without broad route suppression", () => {
    const logging = nextConfig.logging;
    const incomingRequests = logging && typeof logging === "object" ? logging.incomingRequests : false;
    const ignored = incomingRequests && typeof incomingRequests === "object"
      ? (incomingRequests.ignore ?? []) as RegExp[]
      : [];
    const approvalHandle = "APPROVAL_HANDLE_SECRET_CANARY_1234567890123";
    const approvalUrl = `/delegations/slack-message/authorize?request=${approvalHandle}`;

    expect(ignored.some((pattern) => pattern.test(approvalUrl))).toBe(true);
    expect(ignored.some((pattern) => pattern.test("/delegations/slack-message/help"))).toBe(false);
    expect(JSON.stringify(nextConfig)).not.toContain(approvalHandle);
  });
});

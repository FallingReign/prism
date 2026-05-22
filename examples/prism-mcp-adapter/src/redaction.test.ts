import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redaction";

describe("adapter redaction", () => {
  it("removes Prism developer tokens, Slack credentials, and authorization values from diagnostic text", () => {
    const redacted = redactSecrets({
      authorization: "Bearer prism_dev_redactioncanaryredactioncanary12",
      slack: "xoxb-slack-secret-canary",
      user: "xoxp-user-secret-canary",
      clientSecret: "client-secret-canary",
      refreshToken: "refresh-secret-canary",
      accessToken: "access-secret-canary"
    });

    expect(redacted).not.toMatch(/prism_dev_|xoxb-|xoxp-|client-secret-canary|refresh-secret-canary|access-secret-canary/i);
    expect(redacted).toContain("[redacted]");
  });
});

import { describe, expect, it } from "vitest";

import { describeErrorForLog } from "./error-details";

describe("describeErrorForLog", () => {
  it("reports the connection fields that identify an unreachable database", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 172.18.0.2:5432"), {
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "postgres",
      port: 5432,
      errno: -111
    });

    expect(describeErrorForLog(error)).toEqual({
      errorName: "Error",
      code: "ECONNREFUSED",
      syscall: "connect",
      address: "postgres",
      port: 5432,
      errno: -111
    });
  });

  it("never emits the error message, stack, or any field outside the allowlist", () => {
    const error = Object.assign(new Error("password authentication failed for user hunter2"), {
      code: "28P01",
      connectionString: "postgres://prism:hunter2@postgres:5432/prism",
      appToken: "xapp-1-A0000000000-secret"
    });

    const details = describeErrorForLog(error);

    expect(details).toEqual({ errorName: "Error", code: "28P01" });
    expect(JSON.stringify(details)).not.toContain("hunter2");
    expect(JSON.stringify(details)).not.toContain("xapp-");
  });

  it("rejects allowlisted fields that carry free text rather than an enum-like code", () => {
    const error = Object.assign(new Error("failed"), {
      code: "Slack rejected the token xoxb-1-secret for this workspace"
    });

    expect(describeErrorForLog(error)).toEqual({ errorName: "Error" });
  });

  it("names the type when the thrown value is not an Error", () => {
    expect(describeErrorForLog("boom")).toEqual({ errorName: "string" });
    expect(describeErrorForLog(undefined)).toEqual({ errorName: "undefined" });
  });

  it("normalizes a numeric code so it stays loggable as a string", () => {
    const error = Object.assign(new Error("failed"), { code: 500 });

    expect(describeErrorForLog(error)).toEqual({ errorName: "Error", code: "500" });
  });
});

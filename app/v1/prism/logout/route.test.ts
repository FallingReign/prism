import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockDb = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock("../../../../src/server/db", () => ({ database: mockDb }));

describe("POST /v1/prism/logout", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 1 });
    process.env.PRISM_PUBLIC_BASE_URL = "http://localhost:3732";
  });

  it("invalidates the local hashed session and clears the browser cookie", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/logout", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", origin: "http://localhost:3732", "sec-fetch-site": "same-origin" }
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "logged_out" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("prism_session=");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mockDb.query.mock.calls[0]?.[0]).toBe("delete from prism_sessions where session_token_hash = $1");
    expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain("session-token");
  });

  it("rejects cross-site logout before inspecting the session", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest("http://localhost:3732/v1/prism/logout", {
        method: "POST",
        headers: { cookie: "prism_session=session-token", origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "csrf_rejected" });
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  query: vi.fn<() => Promise<unknown>>()
}));

vi.mock("../../../../src/server/db", () => ({
  database: mockDb
}));

describe("GET /v1/prism/health", () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.query.mockReset();
  });

  it("returns 200 and sanitized health JSON when the database is reachable", async () => {
    mockDb.query.mockResolvedValue(undefined);
    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({ service: "ok", database: "ok" });
    expect(JSON.stringify(body)).not.toMatch(/secret|token|password|connection|string|stack/i);
  });

  it("returns 503 and sanitized health JSON when the database is unavailable", async () => {
    mockDb.query.mockRejectedValue(new Error("postgres://user:password@localhost/prism stack"));
    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ service: "ok", database: "unavailable" });
    expect(JSON.stringify(body)).not.toMatch(/postgres|user|password|localhost|stack|secret|token/i);
  });
});

import { describe, expect, it, vi } from "vitest";

import { handleSlackSocketEvent, readSocketWorkerHealth } from "./socket-worker";

const body = {
  type: "block_actions",
  api_app_id: "A1234567890",
  team: { id: "T123" },
  user: { id: "U123" },
  channel: { id: "C123" },
  container: { message_ts: "111.222" },
  actions: [{ type: "static_select", action_id: "prism.route.route-secret-1", selected_option: { value: "option-1" } }]
};

describe("Slack Socket worker", () => {
  it("acknowledges an interaction only after the Delivery store succeeds", async () => {
    const order: string[] = [];
    const store = {
      deliverBlockAction: vi.fn(async () => { order.push("stored"); return { kind: "delivered" as const }; })
    } as any;
    const ack = vi.fn(async () => { order.push("acknowledged"); });

    await expect(handleSlackSocketEvent({ event: { type: "interactive", envelope_id: "envelope-1", body, ack }, store, apiAppId: "A1234567890" })).resolves.toBe("delivered");
    expect(order).toEqual(["stored", "acknowledged"]);
  });

  it("does not acknowledge an interaction when Delivery persistence fails", async () => {
    const store = { deliverBlockAction: vi.fn(async () => { throw new Error("database unavailable"); }) } as any;
    const ack = vi.fn();

    await expect(handleSlackSocketEvent({ event: { type: "interactive", envelope_id: "envelope-1", body, ack }, store, apiAppId: "A1234567890" })).rejects.toThrow("database unavailable");
    expect(ack).not.toHaveBeenCalled();
  });

  it("acknowledges and discards unconfigured envelope types", async () => {
    const ack = vi.fn(async () => undefined);
    const store = {} as any;
    await expect(handleSlackSocketEvent({ event: { type: "events_api", envelope_id: "envelope-2", body: {}, ack }, store, apiAppId: "A1234567890" })).resolves.toBe("discarded");
    expect(ack).toHaveBeenCalledOnce();
  });

  it("marks a stale connected worker as disconnected", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [{ status: "connected", heartbeat_at: new Date("2026-09-02T00:00:00.000Z"), last_error_class: null }],
        rowCount: 1
      }))
    } as any;

    await expect(readSocketWorkerHealth(database, new Date("2026-09-02T00:00:46.000Z"))).resolves.toEqual({
      status: "disconnected",
      heartbeatAt: "2026-09-02T00:00:00.000Z",
      lastErrorClass: "heartbeat_stale"
    });
  });
});

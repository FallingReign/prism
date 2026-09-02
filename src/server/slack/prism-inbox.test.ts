import { describe, expect, it, vi } from "vitest";

import {
  createInboundRoute,
  ingestSlackSocketEnvelope,
  leasePrismInbox,
  acknowledgePrismInboxDelivery,
  type InboundRouteOwner,
  type PrismInboxStore
} from "./prism-inbox";

const now = new Date("2026-09-02T00:00:00.000Z");

function owner(overrides: Partial<InboundRouteOwner> = {}): InboundRouteOwner {
  return {
    tokenProfileId: "profile-1",
    slackConnectionId: "connection-1",
    slackUserId: "U123",
    slackTeamId: "T123",
    slackEnterpriseId: null,
    blockActionsAllowed: true,
    ...overrides
  };
}

function blockActionEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope_id: "envelope-1",
    type: "interactive",
    payload: {
      type: "block_actions",
      api_app_id: "A123",
      team: { id: "T123" },
      user: { id: "U123" },
      channel: { id: "C123" },
      container: { type: "message", message_ts: "111.222", channel_id: "C123" },
      message: { ts: "111.222", text: "must not be stored" },
      response_url: "https://hooks.slack.com/actions/secret",
      trigger_id: "secret-trigger",
      actions: [
        {
          type: "static_select",
          action_id: "prism.route.route-secret-1",
          block_id: "project-picker",
          selected_option: { text: { type: "plain_text", text: "private project label" }, value: "option-1" }
        }
      ]
    },
    ...overrides
  };
}

function memoryStore() {
  const route = {
    id: "route-1",
    routeKeyHash: "route-secret-1",
    tokenProfileId: "profile-1",
    slackConnectionId: "connection-1",
    workspaceId: "T123",
    channelId: "C123",
    slackUserId: "U123",
    envelopeType: "block_actions" as const,
    actionType: "static_select" as const,
    expiresAt: new Date("2026-09-02T01:00:00.000Z")
  };
  const deliveries: any[] = [];
  const store: PrismInboxStore = {
    createRoute: vi.fn(async () => ({ id: route.id })),
    closeRoute: vi.fn(async () => true),
    deliverBlockAction: vi.fn(async (input) => {
      if (input.routeKey !== "route-secret-1") return { kind: "unmatched" as const };
      if (input.workspaceId !== route.workspaceId || input.channelId !== route.channelId || input.slackUserId !== route.slackUserId) return { kind: "unmatched" as const };
      if (deliveries.some((delivery) => delivery.envelopeId === input.envelopeId)) return { kind: "duplicate" as const };
      deliveries.push({ id: "delivery-1", tokenProfileId: route.tokenProfileId, ...input });
      return { kind: "delivered" as const };
    }),
    leaseDeliveries: vi.fn(async (input) => deliveries
      .filter((delivery) => delivery.tokenProfileId === input.tokenProfileId && !delivery.ackedAt)
      .map((delivery) => ({
        id: delivery.id,
        routeId: route.id,
        envelopeId: delivery.envelopeId,
        payloadType: "block_actions" as const,
        workspaceId: delivery.workspaceId,
        channelId: delivery.channelId,
        slackUserId: delivery.slackUserId,
        messageTs: delivery.messageTs,
        blockId: delivery.blockId,
        actionId: delivery.actionId,
        actionType: delivery.actionType,
        selectedOptionValue: delivery.selectedOptionValue,
        receivedAt: input.now,
        expiresAt: new Date(input.now.getTime() + 86_400_000),
        leaseId: "lease-1"
      }))),
    acknowledgeDelivery: vi.fn(async (input) => {
      const delivery = deliveries.find((item) => item.id === input.deliveryId && item.tokenProfileId === input.tokenProfileId);
      if (!delivery) return "not_found" as const;
      if (delivery.ackedAt) return "acknowledged" as const;
      if (input.leaseId !== "lease-1") return "lease_mismatch" as const;
      delivery.ackedAt = input.now;
      delivery.selectedOptionValue = null;
      return "acknowledged" as const;
    })
  };
  return { store, deliveries };
}

describe("Prism Inbox", () => {
  it("creates a short-lived Route only when block actions are allowed", async () => {
    const { store } = memoryStore();
    const created = await createInboundRoute({
      store,
      owner: owner(),
      workspaceId: "T123",
      channelId: "C123",
      expiresInSeconds: 600,
      now,
      routeKey: "route-secret-1"
    });
    const denied = await createInboundRoute({
      store,
      owner: owner({ blockActionsAllowed: false }),
      workspaceId: "T123",
      channelId: "C123",
      expiresInSeconds: 600,
      now,
      routeKey: "route-secret-2"
    });

    expect(created).toEqual({ kind: "created", routeId: "route-1", routeKey: "route-secret-1", expiresAt: new Date("2026-09-02T00:10:00.000Z") });
    expect(denied).toEqual({ kind: "denied", error: "inbound_capability_denied" });
    expect(store.createRoute).toHaveBeenCalledTimes(1);
  });

  it("persists one normalized Delivery before telling the Socket worker to acknowledge", async () => {
    const { store, deliveries } = memoryStore();
    const result = await ingestSlackSocketEnvelope({ store, envelope: blockActionEnvelope(), apiAppId: "A123", now });
    const duplicate = await ingestSlackSocketEnvelope({ store, envelope: blockActionEnvelope(), apiAppId: "A123", now });

    expect(result).toEqual({ kind: "delivered", acknowledge: true });
    expect(duplicate).toEqual({ kind: "duplicate", acknowledge: true });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      envelopeId: "envelope-1",
      workspaceId: "T123",
      slackUserId: "U123",
      channelId: "C123",
      messageTs: "111.222",
      blockId: "project-picker",
      actionId: "prism.route.route-secret-1",
      actionType: "static_select",
      selectedOptionValue: "option-1"
    });
    expect(JSON.stringify(deliveries)).not.toMatch(/must not be stored|hooks\.slack\.com|secret-trigger|private project label/);
  });

  it.each([
    ["wrong app", blockActionEnvelope(), "A999"],
    ["wrong workspace", blockActionEnvelope({ payload: { ...blockActionEnvelope().payload, team: { id: "T999" } } }), "A123"],
    ["wrong user", blockActionEnvelope({ payload: { ...blockActionEnvelope().payload, user: { id: "U999" } } }), "A123"],
    ["wrong channel", blockActionEnvelope({ payload: { ...blockActionEnvelope().payload, channel: { id: "C999" }, container: { type: "message", message_ts: "111.222", channel_id: "C999" } } }), "A123"],
    ["unknown route", blockActionEnvelope({ payload: { ...blockActionEnvelope().payload, actions: [{ type: "static_select", action_id: "prism.route.unknown-route", selected_option: { value: "option-1" } }] } }), "A123"]
  ])("acknowledges and discards %s actions without creating a Delivery", async (_label, envelope, apiAppId) => {
    const { store, deliveries } = memoryStore();
    const result = await ingestSlackSocketEnvelope({ store, envelope, apiAppId, now });

    expect(result).toEqual({ kind: "discarded", acknowledge: true });
    expect(deliveries).toHaveLength(0);
  });

  it("does not acknowledge when durable Delivery insertion fails", async () => {
    const { store } = memoryStore();
    store.deliverBlockAction = vi.fn(async () => { throw new Error("database unavailable"); });

    await expect(ingestSlackSocketEnvelope({ store, envelope: blockActionEnvelope(), apiAppId: "A123", now })).rejects.toThrow("database unavailable");
  });

  it("isolates leased Deliveries by Token profile and removes the selected value on acknowledgement", async () => {
    const { store, deliveries } = memoryStore();
    await ingestSlackSocketEnvelope({ store, envelope: blockActionEnvelope(), apiAppId: "A123", now });

    const wrongProfile = await leasePrismInbox({ store, tokenProfileId: "profile-2", limit: 10, now });
    const leased = await leasePrismInbox({ store, tokenProfileId: "profile-1", limit: 10, now });
    const acknowledged = await acknowledgePrismInboxDelivery({ store, tokenProfileId: "profile-1", deliveryId: "delivery-1", leaseId: "lease-1", now });
    const acknowledgedAgain = await acknowledgePrismInboxDelivery({ store, tokenProfileId: "profile-1", deliveryId: "delivery-1", leaseId: "lease-1", now });

    expect(wrongProfile).toEqual([]);
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({ id: "delivery-1", selectedOptionValue: "option-1", leaseId: "lease-1" });
    expect(acknowledged).toBe("acknowledged");
    expect(acknowledgedAgain).toBe("acknowledged");
    expect(deliveries[0].selectedOptionValue).toBeNull();
  });
});

import "server-only";

export type InboundRouteOwner = {
  tokenProfileId: string;
  slackConnectionId: string;
  slackUserId: string;
  slackTeamId: string | null;
  slackEnterpriseId: string | null;
  blockActionsAllowed: boolean;
};

export type InboundRouteRecord = {
  id: string;
  tokenProfileId: string;
  slackConnectionId: string;
  workspaceId: string;
  channelId: string;
  slackUserId: string;
  envelopeType: "block_actions";
  actionType: "static_select";
  routeKey: string;
  expiresAt: Date;
  now: Date;
};

export type NormalizedBlockAction = {
  envelopeId: string;
  apiAppId: string;
  routeKey: string;
  workspaceId: string;
  enterpriseId: string | null;
  slackUserId: string;
  channelId: string;
  messageTs: string;
  blockId: string | null;
  actionId: string;
  actionType: "static_select";
  selectedOptionValue: string;
  receivedAt: Date;
  expiresAt: Date;
};

export type PrismInboxDelivery = {
  id: string;
  routeId: string;
  envelopeId: string;
  payloadType: "block_actions";
  workspaceId: string;
  channelId: string;
  slackUserId: string;
  messageTs: string;
  blockId: string | null;
  actionId: string;
  actionType: "static_select";
  selectedOptionValue: string;
  receivedAt: Date;
  expiresAt: Date;
  leaseId: string;
};

export type PrismInboxStore = {
  createRoute(input: InboundRouteRecord): Promise<{ id: string }>;
  closeRoute(input: { routeId: string; tokenProfileId: string; now: Date }): Promise<boolean>;
  deliverBlockAction(input: NormalizedBlockAction): Promise<{ kind: "delivered" | "duplicate" | "unmatched" }>;
  leaseDeliveries(input: { tokenProfileId: string; limit: number; now: Date; leaseExpiresAt: Date }): Promise<PrismInboxDelivery[]>;
  acknowledgeDelivery(input: { tokenProfileId: string; deliveryId: string; leaseId: string; now: Date }): Promise<"acknowledged" | "not_found" | "lease_mismatch">;
};

const ROUTE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]{1,31}$/;
const ACTION_ID_PREFIX = "prism.route.";
const MAX_ROUTE_TTL_SECONDS = 60 * 60;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_TTL_MS = 60 * 1000;

export async function createInboundRoute({
  store,
  owner,
  workspaceId,
  channelId,
  expiresInSeconds,
  now,
  routeId,
  routeKey
}: {
  store: PrismInboxStore;
  owner: InboundRouteOwner;
  workspaceId: string;
  channelId: string;
  expiresInSeconds: number;
  now: Date;
  routeId?: string;
  routeKey: string;
}): Promise<
  | { kind: "created"; routeId: string; routeKey: string; expiresAt: Date }
  | { kind: "denied"; error: "inbound_capability_denied" | "workspace_denied" | "invalid_route" }
> {
  if (!owner.blockActionsAllowed) return { kind: "denied", error: "inbound_capability_denied" };
  if (owner.slackTeamId && workspaceId !== owner.slackTeamId) return { kind: "denied", error: "workspace_denied" };
  if (
    !SLACK_ID_PATTERN.test(workspaceId)
    || !SLACK_ID_PATTERN.test(channelId)
    || !ROUTE_KEY_PATTERN.test(routeKey)
    || !Number.isInteger(expiresInSeconds)
    || expiresInSeconds < 60
    || expiresInSeconds > MAX_ROUTE_TTL_SECONDS
  ) {
    return { kind: "denied", error: "invalid_route" };
  }

  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000);
  const created = await store.createRoute({
    id: routeId ?? "",
    tokenProfileId: owner.tokenProfileId,
    slackConnectionId: owner.slackConnectionId,
    workspaceId,
    channelId,
    slackUserId: owner.slackUserId,
    envelopeType: "block_actions",
    actionType: "static_select",
    routeKey,
    expiresAt,
    now
  });
  return { kind: "created", routeId: created.id, routeKey, expiresAt };
}

export async function ingestSlackSocketEnvelope({
  store,
  envelope,
  apiAppId,
  now
}: {
  store: PrismInboxStore;
  envelope: unknown;
  apiAppId: string;
  now: Date;
}): Promise<{ kind: "delivered" | "duplicate" | "discarded"; acknowledge: true }> {
  const normalized = normalizeBlockAction(envelope, apiAppId, now);
  if (!normalized) return { kind: "discarded", acknowledge: true };
  const result = await store.deliverBlockAction(normalized);
  if (result.kind === "unmatched") return { kind: "discarded", acknowledge: true };
  return { kind: result.kind, acknowledge: true };
}

export async function leasePrismInbox({
  store,
  tokenProfileId,
  limit,
  now
}: {
  store: PrismInboxStore;
  tokenProfileId: string;
  limit: number;
  now: Date;
}): Promise<PrismInboxDelivery[]> {
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 10, 50));
  return store.leaseDeliveries({ tokenProfileId, limit: boundedLimit, now, leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) });
}

export function acknowledgePrismInboxDelivery({
  store,
  tokenProfileId,
  deliveryId,
  leaseId,
  now
}: {
  store: PrismInboxStore;
  tokenProfileId: string;
  deliveryId: string;
  leaseId: string;
  now: Date;
}) {
  return store.acknowledgeDelivery({ tokenProfileId, deliveryId, leaseId, now });
}

function normalizeBlockAction(envelope: unknown, expectedApiAppId: string, now: Date): NormalizedBlockAction | null {
  if (!isRecord(envelope) || typeof envelope.envelope_id !== "string" || envelope.type !== "interactive" || !isRecord(envelope.payload)) return null;
  const payload = envelope.payload;
  if (payload.type !== "block_actions" || payload.api_app_id !== expectedApiAppId) return null;
  if (!isRecord(payload.team) || typeof payload.team.id !== "string") return null;
  if (!isRecord(payload.user) || typeof payload.user.id !== "string") return null;
  if (!isRecord(payload.channel) || typeof payload.channel.id !== "string") return null;
  if (!isRecord(payload.container) || typeof payload.container.message_ts !== "string") return null;
  if (!Array.isArray(payload.actions) || payload.actions.length !== 1 || !isRecord(payload.actions[0])) return null;

  const action = payload.actions[0];
  if (action.type !== "static_select" || typeof action.action_id !== "string" || !action.action_id.startsWith(ACTION_ID_PREFIX)) return null;
  if (!isRecord(action.selected_option) || typeof action.selected_option.value !== "string") return null;
  const routeKey = action.action_id.slice(ACTION_ID_PREFIX.length);
  if (!ROUTE_KEY_PATTERN.test(routeKey) || action.selected_option.value.length < 1 || action.selected_option.value.length > 150) return null;

  const enterpriseId = isRecord(payload.enterprise) && typeof payload.enterprise.id === "string" ? payload.enterprise.id : null;
  return {
    envelopeId: bounded(payloadString(envelope.envelope_id), 255),
    apiAppId: bounded(payloadString(payload.api_app_id), 64),
    routeKey,
    workspaceId: bounded(payloadString(payload.team.id), 32),
    enterpriseId: enterpriseId ? bounded(enterpriseId, 32) : null,
    slackUserId: bounded(payloadString(payload.user.id), 32),
    channelId: bounded(payloadString(payload.channel.id), 32),
    messageTs: bounded(payloadString(payload.container.message_ts), 32),
    blockId: typeof action.block_id === "string" ? bounded(action.block_id, 255) : null,
    actionId: bounded(action.action_id, 255),
    actionType: "static_select",
    selectedOptionValue: action.selected_option.value,
    receivedAt: now,
    expiresAt: new Date(now.getTime() + DELIVERY_TTL_MS)
  };
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function payloadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

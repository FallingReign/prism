import "server-only";

export type TokenProfilePreset = "read_only" | "messages_only" | "full_slack_bridge" | "custom";
export type ExecutionIdentity = "user" | "bot" | "automatic" | "selectable";
export type ExperimentTtl = "24h" | "7d";

export type TokenProfilePolicyInput = {
  preset: TokenProfilePreset;
  executionIdentity: ExecutionIdentity;
  destructive?: boolean;
  experiment?: ExperimentTtl;
  custom?: {
    read?: boolean;
    search?: boolean;
    writeMessages?: boolean;
    reactions?: boolean;
    filesMetadata?: boolean;
    destructive?: boolean;
  };
};

export type CapabilityMap = {
  version: 1;
  preset: TokenProfilePreset;
  workspaces: { mode: "linked_slack_connection" };
  surfaces: {
    publicChannels: boolean;
    privateChannels: boolean;
    directMessages: boolean;
    groupDirectMessages: boolean;
    search: boolean;
    filesMetadata: boolean;
    canvases: false;
    lists: false;
    future: false;
  };
  actions: {
    read: boolean;
    search: boolean;
    writeMessages: boolean;
    reactions: boolean;
    filesMetadata: boolean;
    destructive: boolean;
  };
  executionIdentity: ExecutionIdentity;
  experiment: { enabled: boolean; ttl: ExperimentTtl | null };
  mutation: {
    destructiveOptIn: boolean;
    narrowingAppliesImmediately: true;
    broadeningRequiresRotation: true;
  };
  deferred: {
    admin: false;
    fileTransfer: false;
    events: false;
    slashCommands: false;
    interactivity: false;
    canvases: false;
    lists: false;
  };
};

export type TokenProfilePolicy = {
  capabilityMap: CapabilityMap;
  expiresAt: Date | null;
};

export function buildTokenProfilePolicy(input: TokenProfilePolicyInput, now = new Date()): TokenProfilePolicy {
  const actions = actionsFor(input);
  const experiment = input.experiment ?? null;
  return {
    capabilityMap: {
      version: 1,
      preset: input.preset,
      workspaces: { mode: "linked_slack_connection" },
      surfaces: {
        publicChannels: true,
        privateChannels: true,
        directMessages: true,
        groupDirectMessages: true,
        search: actions.search,
        filesMetadata: actions.filesMetadata,
        canvases: false,
        lists: false,
        future: false
      },
      actions,
      executionIdentity: input.executionIdentity,
      experiment: { enabled: experiment !== null, ttl: experiment },
      mutation: {
        destructiveOptIn: actions.destructive,
        narrowingAppliesImmediately: true,
        broadeningRequiresRotation: true
      },
      deferred: {
        admin: false,
        fileTransfer: false,
        events: false,
        slashCommands: false,
        interactivity: false,
        canvases: false,
        lists: false
      }
    },
    expiresAt: expiryFor(input, actions.destructive, now)
  };
}

function actionsFor(input: TokenProfilePolicyInput): CapabilityMap["actions"] {
  if (input.preset === "read_only") {
    return { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false };
  }
  if (input.preset === "messages_only") {
    return { read: true, search: false, writeMessages: true, reactions: true, filesMetadata: false, destructive: false };
  }
  if (input.preset === "full_slack_bridge") {
    return {
      read: true,
      search: true,
      writeMessages: true,
      reactions: true,
      filesMetadata: true,
      destructive: input.destructive === true
    };
  }

  return {
    read: input.custom?.read ?? true,
    search: input.custom?.search ?? true,
    writeMessages: input.custom?.writeMessages ?? false,
    reactions: input.custom?.reactions ?? input.custom?.writeMessages ?? false,
    filesMetadata: input.custom?.filesMetadata ?? false,
    destructive: input.custom?.destructive === true
  };
}

function expiryFor(input: TokenProfilePolicyInput, destructive: boolean, now: Date): Date | null {
  if (input.experiment === "24h") return addDays(now, 1);
  if (input.experiment === "7d") return addDays(now, 7);
  if (destructive) return addDays(now, 30);
  if (input.preset === "read_only") return null;
  return addDays(now, 90);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

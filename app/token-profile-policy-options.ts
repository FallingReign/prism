export type TokenProfilePolicyPreset = "read_only" | "messages_only" | "full_slack_bridge" | "custom";
export type TokenProfileExecutionIdentity = "automatic" | "user" | "bot" | "selectable";
export type TokenProfileExperimentTtl = "24h" | "7d";

export type TokenProfileCapabilitySelection = {
  read: boolean;
  search: boolean;
  writeMessages: boolean;
  reactions: boolean;
  filesMetadata: boolean;
  destructive: boolean;
};

export type TokenProfilePolicyOptions = {
  presets: {
    allowed: TokenProfilePolicyPreset[];
    default: TokenProfilePolicyPreset;
  };
  executionIdentities: {
    allowed: TokenProfileExecutionIdentity[];
    default: TokenProfileExecutionIdentity;
  };
  capabilities: {
    defaults: TokenProfileCapabilitySelection;
    maximum: TokenProfileCapabilitySelection;
  };
  experiments: {
    allowed: TokenProfileExperimentTtl[];
    default: TokenProfileExperimentTtl | null;
  };
};

type GlobalTokenProfilePolicyLike = {
  presets: TokenProfilePolicyOptions["presets"];
  executionIdentities: TokenProfilePolicyOptions["executionIdentities"];
  capabilities: {
    defaults: { actions: TokenProfileCapabilitySelection };
    maximum: { actions: TokenProfileCapabilitySelection };
  };
  expiry: {
    allowedExperimentTtls: TokenProfileExperimentTtl[];
    defaultExperimentTtl: TokenProfileExperimentTtl | null;
  };
};

export const defaultTokenProfilePolicyOptions: TokenProfilePolicyOptions = {
  presets: {
    allowed: ["read_only", "messages_only", "full_slack_bridge", "custom"],
    default: "read_only"
  },
  executionIdentities: {
    allowed: ["automatic", "user", "bot", "selectable"],
    default: "automatic"
  },
  capabilities: {
    defaults: { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false },
    maximum: { read: true, search: true, writeMessages: true, reactions: true, filesMetadata: true, destructive: true }
  },
  experiments: {
    allowed: ["24h", "7d"],
    default: null
  }
};

export function capabilityTemplateForPreset(preset: Exclude<TokenProfilePolicyPreset, "custom">): TokenProfileCapabilitySelection {
  if (preset === "read_only") {
    return { read: true, search: true, writeMessages: false, reactions: false, filesMetadata: false, destructive: false };
  }
  if (preset === "messages_only") {
    return { read: true, search: false, writeMessages: true, reactions: true, filesMetadata: false, destructive: false };
  }
  return { read: true, search: true, writeMessages: true, reactions: true, filesMetadata: true, destructive: false };
}

export function tokenProfilePolicyOptionsFromGlobalPolicy(policy: GlobalTokenProfilePolicyLike): TokenProfilePolicyOptions {
  return {
    presets: {
      allowed: [...policy.presets.allowed],
      default: policy.presets.default
    },
    executionIdentities: {
      allowed: [...policy.executionIdentities.allowed],
      default: policy.executionIdentities.default
    },
    capabilities: {
      defaults: { ...policy.capabilities.defaults.actions },
      maximum: { ...policy.capabilities.maximum.actions }
    },
    experiments: {
      allowed: [...policy.expiry.allowedExperimentTtls],
      default: policy.expiry.defaultExperimentTtl
    }
  };
}

export function presetAvailability(
  preset: TokenProfilePolicyPreset,
  options: TokenProfilePolicyOptions
): { allowed: true; reason: null } | { allowed: false; reason: string } {
  if (!options.presets.allowed.includes(preset)) return { allowed: false, reason: "Global policy disables this preset." };
  if (preset === "custom") return { allowed: true, reason: null };

  const disabledCapabilities = disabledCapabilityLabels(capabilityTemplateForPreset(preset), options.capabilities.maximum);
  if (disabledCapabilities.length === 0) return { allowed: true, reason: null };
  return { allowed: false, reason: `Global policy disables ${joinLabels(disabledCapabilities)}.` };
}

function disabledCapabilityLabels(selection: TokenProfileCapabilitySelection, maximum: TokenProfileCapabilitySelection): string[] {
  const labels: string[] = [];
  if (selection.read && !maximum.read) labels.push("Read");
  if (selection.search && !maximum.search) labels.push("Search");
  if (selection.writeMessages && !maximum.writeMessages) labels.push("Write messages");
  if (selection.reactions && !maximum.reactions) labels.push("Reactions");
  if (selection.filesMetadata && !maximum.filesMetadata) labels.push("Files metadata");
  if (selection.destructive && !maximum.destructive) labels.push("Destructive methods");
  return labels;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

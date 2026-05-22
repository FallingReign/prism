import "server-only";

import type { CapabilityMap } from "../token-profiles/presets";

type CapabilityField = keyof CapabilityMap["actions"];

export type MethodCategory =
  | "conversations.read"
  | "users.read"
  | "search"
  | "messages.write"
  | "messages.destructive"
  | "reactions"
  | "files.metadata"
  | "admin"
  | "events"
  | "slashCommands"
  | "interactivity"
  | "fileTransfer"
  | "canvases"
  | "lists"
  | "future";

export type MethodAvailability = {
  categories: Record<string, { allowed: boolean; methods: string[] }>;
  methods: Record<string, { category: MethodCategory; status: "allowed" | "denied" | "unsupported"; requiredCapability: CapabilityField | "unsupported"; supported: boolean }>;
  unsupported: { surfaces: string[] };
};

const supportedRegistry: Array<{ category: MethodCategory; methods: string[]; required: CapabilityField[] }> = [
  { category: "conversations.read", methods: ["conversations.list", "conversations.info", "conversations.history", "conversations.replies"], required: ["read"] },
  { category: "users.read", methods: ["users.info", "users.list"], required: ["read"] },
  { category: "search", methods: ["search.messages"], required: ["search"] },
  { category: "messages.write", methods: ["chat.postMessage", "chat.update"], required: ["writeMessages"] },
  { category: "messages.destructive", methods: ["chat.delete"], required: ["writeMessages", "destructive"] },
  { category: "reactions", methods: ["reactions.add", "reactions.remove", "reactions.get"], required: ["reactions"] },
  { category: "files.metadata", methods: ["files.info", "files.list"], required: ["filesMetadata"] }
];

const unsupportedRegistry: Array<{ category: MethodCategory; methods: string[] }> = [
  { category: "admin", methods: ["admin.users.list", "admin.conversations.search"] },
  { category: "events", methods: ["events.subscribe"] },
  { category: "slashCommands", methods: ["commands.invoke"] },
  { category: "interactivity", methods: ["views.open"] },
  { category: "fileTransfer", methods: ["files.upload", "files.delete"] },
  { category: "canvases", methods: ["canvases.create"] },
  { category: "lists", methods: ["lists.create"] },
  { category: "future", methods: ["future.method"] }
];

export function buildMethodAvailability(capabilityMap: CapabilityMap): MethodAvailability {
  const categories: MethodAvailability["categories"] = {};
  const methods: MethodAvailability["methods"] = {};

  for (const entry of supportedRegistry) {
    const allowed = entry.required.every((capability) => capabilityMap.actions[capability]);
    categories[entry.category] = { allowed, methods: entry.methods };
    const requiredCapability =
      entry.required
        .slice()
        .reverse()
        .find((capability) => !capabilityMap.actions[capability]) ?? entry.required[entry.required.length - 1]!;
    for (const method of entry.methods) {
      methods[method] = {
        category: entry.category,
        status: allowed ? "allowed" : "denied",
        requiredCapability,
        supported: true
      };
    }
  }

  for (const entry of unsupportedRegistry) {
    categories[entry.category] = { allowed: false, methods: entry.methods };
    for (const method of entry.methods) {
      methods[method] = {
        category: entry.category,
        status: "unsupported",
        requiredCapability: "unsupported",
        supported: false
      };
    }
  }

  return {
    categories,
    methods,
    unsupported: { surfaces: unsupportedRegistry.map((entry) => entry.category) }
  };
}

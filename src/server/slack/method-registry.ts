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

export type SupportedMethodClassification = {
  method: string;
  category: MethodCategory;
  supported: true;
  status: "supported";
  requiredCapabilities: CapabilityField[];
  requiresSurface: boolean;
};

export type UnsupportedMethodClassification = {
  method: string;
  category: MethodCategory;
  supported: false;
  status: "unsupported" | "deferred";
  requiredCapabilities: [];
  requiresSurface: false;
};

export type MethodClassification = SupportedMethodClassification | UnsupportedMethodClassification;

const supportedRegistry: Array<Omit<SupportedMethodClassification, "method" | "supported" | "status"> & { methods: string[] }> = [
  {
    category: "conversations.read",
    methods: ["conversations.list", "conversations.info", "conversations.history", "conversations.replies"],
    requiredCapabilities: ["read"],
    requiresSurface: true
  },
  { category: "users.read", methods: ["users.info", "users.list"], requiredCapabilities: ["read"], requiresSurface: false },
  { category: "search", methods: ["search.messages"], requiredCapabilities: ["search"], requiresSurface: false },
  { category: "messages.write", methods: ["chat.postMessage", "chat.update"], requiredCapabilities: ["writeMessages"], requiresSurface: true },
  { category: "messages.destructive", methods: ["chat.delete"], requiredCapabilities: ["writeMessages", "destructive"], requiresSurface: true },
  { category: "reactions", methods: ["reactions.add", "reactions.remove", "reactions.get"], requiredCapabilities: ["reactions"], requiresSurface: true },
  { category: "files.metadata", methods: ["files.info", "files.list"], requiredCapabilities: ["filesMetadata"], requiresSurface: false }
];

const unsupportedRegistry: Array<{ category: MethodCategory; methods: string[]; status: "unsupported" | "deferred" }> = [
  { category: "admin", methods: ["admin.users.list", "admin.conversations.search"], status: "unsupported" },
  { category: "events", methods: ["events.subscribe"], status: "deferred" },
  { category: "slashCommands", methods: ["commands.invoke"], status: "deferred" },
  { category: "interactivity", methods: ["views.open"], status: "deferred" },
  { category: "fileTransfer", methods: ["files.upload", "files.delete"], status: "deferred" },
  { category: "canvases", methods: ["canvases.create"], status: "deferred" },
  { category: "lists", methods: ["lists.create"], status: "deferred" },
  { category: "future", methods: ["future.method"], status: "unsupported" }
];

const unsupportedPrefixes: Array<{ prefix: string; category: MethodCategory; status: "unsupported" | "deferred" }> = [
  { prefix: "admin.", category: "admin", status: "unsupported" },
  { prefix: "team.", category: "admin", status: "unsupported" },
  { prefix: "usergroups.", category: "admin", status: "unsupported" },
  { prefix: "apps.", category: "admin", status: "unsupported" },
  { prefix: "events.", category: "events", status: "deferred" },
  { prefix: "commands.", category: "slashCommands", status: "deferred" },
  { prefix: "views.", category: "interactivity", status: "deferred" },
  { prefix: "canvases.", category: "canvases", status: "deferred" },
  { prefix: "lists.", category: "lists", status: "deferred" }
];

export function classifySlackMethod(method: string): MethodClassification {
  for (const entry of supportedRegistry) {
    if (entry.methods.includes(method)) {
      return {
        method,
        category: entry.category,
        supported: true,
        status: "supported",
        requiredCapabilities: entry.requiredCapabilities,
        requiresSurface: entry.requiresSurface
      };
    }
  }

  for (const entry of unsupportedRegistry) {
    if (entry.methods.includes(method)) {
      return { method, category: entry.category, supported: false, status: entry.status, requiredCapabilities: [], requiresSurface: false };
    }
  }

  const prefix = unsupportedPrefixes.find((entry) => method.startsWith(entry.prefix));
  if (prefix) {
    return { method, category: prefix.category, supported: false, status: prefix.status, requiredCapabilities: [], requiresSurface: false };
  }

  return { method, category: "future", supported: false, status: "unsupported", requiredCapabilities: [], requiresSurface: false };
}

export function buildMethodAvailability(capabilityMap: CapabilityMap): MethodAvailability {
  const categories: MethodAvailability["categories"] = {};
  const methods: MethodAvailability["methods"] = {};

  for (const entry of supportedRegistry) {
    const allowed = entry.requiredCapabilities.every((capability) => capabilityMap.actions[capability]);
    categories[entry.category] = { allowed, methods: entry.methods };
    const requiredCapability =
      entry.requiredCapabilities
        .slice()
        .reverse()
        .find((capability) => !capabilityMap.actions[capability]) ?? entry.requiredCapabilities[entry.requiredCapabilities.length - 1]!;
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

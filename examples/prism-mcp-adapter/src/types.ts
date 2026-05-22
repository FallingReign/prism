export type AdapterConfig = {
  baseUrl: string;
  developerToken: string;
};

export type AdapterToolDefinition = {
  name: string;
  description: string;
  method: string;
};

export type AdapterToolResult = {
  isError: boolean;
  content?: Array<{ type: "text"; text: string }>;
  structuredContent: {
    method: string;
    ok: boolean;
    prism: {
      requestId: string | null;
      upstreamCalled: boolean | null;
      retryAfter?: string;
      slackRequestId?: string;
    };
    slack?: unknown;
    error?: string;
  };
};

export type PrismStatusBody = {
  requestId: string;
  token: { valid?: boolean; status: string; tokenProfileId?: string; expiresAt?: string | null };
  slack?: { status: string; reauthRequired?: boolean };
};

export type PrismCapabilitiesBody = {
  requestId: string;
  token: { valid?: boolean; status: string; tokenProfileId?: string; expiresAt?: string | null };
  slack?: { status: string; reauthRequired?: boolean };
  methods?: Record<string, { status: "allowed" | "denied" | "unsupported"; supported: boolean; category?: string; requiredCapability?: string }>;
};

export type PrismHttpResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

import "server-only";

export type RemoteCodexSessionStatus = "ready" | "active" | "attention" | "unavailable";

export type SafeRemoteCodexSession = {
  threadId: string;
  title: string;
  projectLabel: string;
  status: RemoteCodexSessionStatus;
  lastActivity: Date;
};

export type SessionCatalogStore = {
  replaceCatalog(input: {
    installationId: string;
    catalogVersion: string;
    sessions: SafeRemoteCodexSession[];
    now: Date;
  }): Promise<void>;
};

export async function syncSessionCatalog({
  store,
  installationId,
  body,
  now = new Date()
}: {
  store: SessionCatalogStore;
  installationId: string;
  body: unknown;
  now?: Date;
}): Promise<{ kind: "synced"; count: number } | { kind: "invalid" }> {
  if (!isRecord(body) || !hasExactKeys(body, ["catalogVersion", "sessions"])) return { kind: "invalid" };
  if (typeof body.catalogVersion !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.catalogVersion)) return { kind: "invalid" };
  if (!Array.isArray(body.sessions) || body.sessions.length > 50) return { kind: "invalid" };

  const sessions: SafeRemoteCodexSession[] = [];
  for (const value of body.sessions) {
    const session = parseSession(value);
    if (!session) return { kind: "invalid" };
    sessions.push(session);
  }
  if (new Set(sessions.map((session) => session.threadId)).size !== sessions.length) return { kind: "invalid" };

  await store.replaceCatalog({ installationId, catalogVersion: body.catalogVersion, sessions, now });
  return { kind: "synced", count: sessions.length };
}

function parseSession(value: unknown): SafeRemoteCodexSession | null {
  if (!isRecord(value) || !hasExactKeys(value, ["threadId", "title", "projectLabel", "status", "lastActivity"])) return null;
  const { threadId, title, projectLabel, status, lastActivity } = value;
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) return null;
  const safeTitle = safeLabel(title, 90);
  const safeProjectLabel = safeLabel(projectLabel, 60);
  if (!safeTitle || !safeProjectLabel || !isSessionStatus(status)) return null;
  if (!Number.isInteger(lastActivity) || (lastActivity as number) < 0 || (lastActivity as number) > 4_102_444_800) return null;
  return {
    threadId,
    title: safeTitle,
    projectLabel: safeProjectLabel,
    status,
    lastActivity: new Date((lastActivity as number) * 1000)
  };
}

function safeLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.trim();
  return normalized || null;
}

function isSessionStatus(value: unknown): value is RemoteCodexSessionStatus {
  return value === "ready" || value === "active" || value === "attention" || value === "unavailable";
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

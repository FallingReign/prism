import { describe, expect, it, vi } from "vitest";

import type { Database } from "../db";
import { hashSecret } from "./pairing-service";
import { getPairingApprovalContext } from "./browser-pairing";

describe("remote Codex browser pairing context", () => {
  it("uses the exact session connection and lists only its explicit workspace targets", async () => {
    const now = new Date("2026-08-31T06:00:00.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("from prism_sessions s");
      expect(sql).toContain("c.id = s.slack_connection_id");
      expect(sql).toContain("c.prism_user_id = s.prism_user_id");
      expect(sql).toContain("c.status = 'healthy'");
      expect(sql).not.toMatch(/access_token|refresh_token|secret_hash|public_key/i);
      expect(params).toEqual([hashSecret("website-session"), "rc_pair_1", now]);
      return {
        rows: [
          {
            pairing_id: "rc_pair_1",
            machine_label: "Workstation",
            companion_version: "0.1.0",
            verification_phrase: "violet-river-42",
            expires_at: new Date("2026-08-31T06:10:00.000Z"),
            connection_id: "connection-owner",
            installation_scope: "workspace",
            target_team_id: "T123",
            target_team_name: "Example Workspace",
            enterprise_id: null,
            enterprise_name: null,
            slack_user_id: "U123",
            slack_user_display_name: "Jill"
          }
        ],
        rowCount: 1
      };
    });

    await expect(
      getPairingApprovalContext(fakeDatabase(query), { pairingId: "rc_pair_1", sessionToken: "website-session", now })
    ).resolves.toEqual({
      kind: "ready",
      pairingId: "rc_pair_1",
      machineLabel: "Workstation",
      companionVersion: "0.1.0",
      verificationPhrase: "violet-river-42",
      expiresAt: "2026-08-31T06:10:00.000Z",
      identity: {
          connectionId: "connection-owner",
          installationLabel: "Example Workspace",
          slackUserId: "U123",
          slackUserLabel: "Jill"
      },
      workspaces: [{ teamId: "T123", label: "Example Workspace" }]
    });
  });

  it("offers only active grants from the exact organization connection", async () => {
    const now = new Date("2026-08-31T06:00:00.000Z");
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("g.status = 'active'");
      expect(sql).toContain("c.id = s.slack_connection_id");
      return {
        rows: [
          {
            pairing_id: "rc_pair_1", machine_label: "Workstation", companion_version: "0.1.0",
            verification_phrase: "violet-river-42", expires_at: new Date("2026-08-31T06:10:00.000Z"),
            connection_id: "connection-org", installation_scope: "organization", target_team_id: "TAAA",
            target_team_name: "Alpha", enterprise_id: "E123", enterprise_name: "Example Enterprise",
            slack_user_id: "U123", slack_user_display_name: "Jill"
          },
          {
            pairing_id: "rc_pair_1", machine_label: "Workstation", companion_version: "0.1.0",
            verification_phrase: "violet-river-42", expires_at: new Date("2026-08-31T06:10:00.000Z"),
            connection_id: "connection-org", installation_scope: "organization", target_team_id: "TBBB",
            target_team_name: "Beta", enterprise_id: "E123", enterprise_name: "Example Enterprise",
            slack_user_id: "U123", slack_user_display_name: "Jill"
          }
        ],
        rowCount: 2
      };
    });

    const context = await getPairingApprovalContext(fakeDatabase(query), {
      pairingId: "rc_pair_1", sessionToken: "website-session", now
    });

    expect(context).toMatchObject({
      kind: "ready",
      identity: { connectionId: "connection-org", installationLabel: "Example Enterprise" },
      workspaces: [{ teamId: "TAAA", label: "Alpha" }, { teamId: "TBBB", label: "Beta" }]
    });
  });

  it("does not query or disclose pairing metadata without a website session", async () => {
    const query = vi.fn();
    await expect(getPairingApprovalContext(fakeDatabase(query), { pairingId: "rc_pair_1", sessionToken: undefined })).resolves.toEqual({
      kind: "unauthenticated"
    });
    expect(query).not.toHaveBeenCalled();
  });
});

function fakeDatabase(query: ReturnType<typeof vi.fn>): Database {
  const databaseQuery = query as unknown as Database["query"];
  return { query: databaseQuery, transaction: async (callback) => callback(fakeDatabase(query)) };
}

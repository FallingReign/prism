import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("remote Codex Slack binding migration", () => {
  it("enforces one active session binding, one Slack thread binding, and metadata-only receipts", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0025_remote_codex_slack.sql"), "utf8");
    expect(sql).toContain("remote_codex_active_session_binding_idx");
    expect(sql).toContain("remote_codex_active_slack_thread_binding_idx");
    expect(sql).toContain("slack_inbound_receipts");
    expect(sql).toContain("remote_codex_app_home_published");
    expect(sql).toContain("remote_codex_binding_created");
    expect(sql).toContain("remote_codex_binding_status_updated");
    expect(sql).toContain("delegated_delivery_requested");
    expect(sql).toContain("configuration_admin_claimed");
    expect(sql).not.toMatch(/prompt|transcript|output|diff|cwd|access_token|refresh_token/i);
  });
});

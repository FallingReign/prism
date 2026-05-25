"use client";

import { FormEvent, useState } from "react";

import { formatUtcDate, formatUtcDateTime } from "./date-format";
import { Button, Notice, Panel, StatusBadge } from "./ui";

export type TokenProfileSummary = {
  id: string;
  name: string;
  intendedUse: string;
  preset: "read_only" | "messages_only" | "full_slack_bridge" | "custom";
  executionIdentity: "user" | "bot" | "automatic" | "selectable";
  expiresAt: string | null;
  createdAt: string;
  developerToken?: {
    status: "active" | "expired" | "revoked" | "missing";
    createdAt?: string | null;
    expiresAt?: string | null;
    lastUsedAt?: string | null;
    revokedAt?: string | null;
    overlapExpiresAt?: string | null;
  };
};

export function TokenProfilesPanel({
  initialProfiles,
  slackStatus
}: {
  initialProfiles: TokenProfileSummary[];
  slackStatus: "healthy" | "reauth_required";
}) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const [developerToken, setDeveloperToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);
    const preset = String(form.get("preset"));
    const custom = {
      read: form.get("customRead") === "on",
      search: form.get("customSearch") === "on",
      writeMessages: form.get("customWriteMessages") === "on",
      reactions: form.get("customReactions") === "on",
      filesMetadata: form.get("customFilesMetadata") === "on",
      destructive: form.get("destructive") === "on"
    };

    const response = await fetch("/v1/prism/token-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(form.get("name") ?? ""),
        intendedUse: String(form.get("intendedUse") ?? ""),
        preset,
        executionIdentity: String(form.get("executionIdentity") ?? "automatic"),
        destructive: form.get("destructive") === "on",
        experiment: String(form.get("experiment") ?? "") || undefined,
        custom: preset === "custom" ? custom : undefined
      })
    });
    const body = await response.json();
    setSubmitting(false);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not create Token profile.");
      return;
    }
    setDeveloperToken(body.developerToken);
    setProfiles((current) => [toSummary(body.profile), ...current]);
  }

  async function onRevoke(profile: TokenProfileSummary) {
    setActionProfileId(profile.id);
    setError(null);
    setDeveloperToken(null);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/revoke`, { method: "POST" });
    const body = await response.json();
    setActionProfileId(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not revoke Token profile.");
      return;
    }
    replaceProfile(body.profile);
  }

  async function onRotate(event: FormEvent<HTMLFormElement>, profile: TokenProfileSummary) {
    event.preventDefault();
    setActionProfileId(profile.id);
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overlap: String(form.get("overlap") ?? "none") })
    });
    const body = await response.json();
    setActionProfileId(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not rotate Token profile.");
      return;
    }
    setDeveloperToken(body.developerToken);
    replaceProfile(body.profile);
  }

  async function onPolicyUpdate(event: FormEvent<HTMLFormElement>, profile: TokenProfileSummary) {
    event.preventDefault();
    setActionProfileId(profile.id);
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: profile.name,
        intendedUse: profile.intendedUse,
        preset: String(form.get("policyPreset") ?? profile.preset),
        executionIdentity: String(form.get("policyExecutionIdentity") ?? profile.executionIdentity),
        experiment: String(form.get("policyExperiment") ?? "") || undefined,
        confirmBroadening: form.get("confirmBroadening") === "on"
      })
    });
    const body = await response.json();
    setActionProfileId(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not update Token profile policy.");
      return;
    }
    if (body.developerToken) setDeveloperToken(body.developerToken);
    replaceProfile(body.profile);
  }

  function replaceProfile(profile: TokenProfileSummary) {
    setProfiles((current) => current.map((candidate) => (candidate.id === profile.id ? toSummary(profile) : candidate)));
  }

  return (
    <Panel
      className="token-profiles"
      title="Create Token profile"
      titleId="token-profiles-title"
      eyebrow="Token profiles"
      accent="primary"
      badge={<StatusBadge tone={slackStatus === "healthy" ? "success" : "warning"}>{slackStatus === "healthy" ? "Slack ready" : "Reauth needed"}</StatusBadge>}
    >
      {slackStatus === "reauth_required" ? (
        <Notice title="Slack reauth required" tone="warning">
          Slack reauth is required before these profiles can be used for Slack calls, but profile management is preserved.
        </Notice>
      ) : null}
      <Notice title="Local tool safety" tone="info">
        Slack content is untrusted input to Local tools. Prism does not execute local actions. Copy the Prism developer token when it is shown; it
        cannot be retrieved later.
      </Notice>
      <form className="token-form" onSubmit={onSubmit}>
        <label>
          Profile name
          <input name="name" required maxLength={80} placeholder="Local MCP read" />
        </label>
        <label>
          Intended use
          <input name="intendedUse" required maxLength={180} placeholder="Read Slack context from my local MCP server" />
        </label>
        <label>
          Preset
          <select name="preset" defaultValue="read_only">
            <option value="read_only">Read-only</option>
            <option value="messages_only">Messages only</option>
            <option value="full_slack_bridge">Full Slack bridge</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          Execution identity
          <select name="executionIdentity" defaultValue="automatic">
            <option value="automatic">Automatic</option>
            <option value="user">User-backed</option>
            <option value="bot">Bot-backed</option>
            <option value="selectable">Selectable by request</option>
          </select>
        </label>
        <div className="checkbox-grid" aria-label="Custom capability options">
          <label>
            <input type="checkbox" name="customRead" defaultChecked /> Read
          </label>
          <label>
            <input type="checkbox" name="customSearch" defaultChecked /> Search
          </label>
          <label>
            <input type="checkbox" name="customWriteMessages" /> Write messages
          </label>
          <label>
            <input type="checkbox" name="customReactions" /> Reactions
          </label>
          <label>
            <input type="checkbox" name="customFilesMetadata" /> Files metadata
          </label>
          <label>
            <input type="checkbox" name="destructive" /> Explicit destructive opt-in
          </label>
        </div>
        <label>
          Experiment expiry
          <select name="experiment" defaultValue="">
            <option value="">Not an experiment token</option>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
          </select>
        </label>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating..." : "Create and show token once"}
        </Button>
      </form>
      {error ? <p className="form-error">{error}</p> : null}
      {developerToken ? (
        <div className="copy-once" role="status">
          <strong>Copy this Prism developer token now. It will not be shown again.</strong>
          <code>{developerToken}</code>
        </div>
      ) : null}
      <div className="profile-list" aria-label="Existing Token profiles">
        <h3>Existing profiles</h3>
        {profiles.length === 0 ? <p>No Token profiles yet.</p> : null}
        {profiles.map((profile) => (
          <article className="profile-card" key={profile.id}>
            <h4>{profile.name}</h4>
            <p>{profile.intendedUse}</p>
            <dl>
              <div>
                <dt>Preset</dt>
                <dd>{presetLabel(profile.preset)}</dd>
              </div>
              <div>
                <dt>Execution identity</dt>
                <dd>{executionIdentityLabel(profile.executionIdentity)}</dd>
              </div>
              <div>
                <dt>Token status</dt>
                <dd>
                  <StatusBadge tone={developerTokenStatusTone(profile.developerToken?.status)}>
                    {developerTokenStatusLabel(profile.developerToken?.status)}
                  </StatusBadge>
                </dd>
              </div>
              <div>
                <dt>Expiry</dt>
                <dd>{formatUtcDate(profile.expiresAt ?? profile.developerToken?.expiresAt ?? null) ?? "No expiry"}</dd>
              </div>
              <div>
                <dt>Last used</dt>
                <dd>{formatUtcDateTime(profile.developerToken?.lastUsedAt ?? null) ?? "Not used yet"}</dd>
              </div>
              {profile.developerToken?.overlapExpiresAt ? (
                <div>
                  <dt>Overlap until</dt>
                  <dd>{formatUtcDateTime(profile.developerToken.overlapExpiresAt)}</dd>
                </div>
              ) : null}
              {profile.developerToken?.revokedAt ? (
                <div>
                  <dt>Revoked</dt>
                  <dd>{formatUtcDateTime(profile.developerToken.revokedAt)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="profile-actions">
              <form onSubmit={(event) => onRotate(event, profile)}>
                <label>
                  Rotation overlap
                  <select name="overlap" defaultValue="none">
                    <option value="none">No overlap</option>
                    <option value="15m">15 minutes</option>
                    <option value="1h">1 hour</option>
                    <option value="24h">24 hours</option>
                  </select>
                </label>
                <Button type="submit" disabled={actionProfileId === profile.id}>
                  Rotate token
                </Button>
              </form>
              <form onSubmit={(event) => onPolicyUpdate(event, profile)}>
                <label>
                  Policy preset
                  <select name="policyPreset" defaultValue={profile.preset}>
                    <option value="read_only">Read-only</option>
                    <option value="messages_only">Messages only</option>
                    <option value="full_slack_bridge">Full Slack bridge</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label>
                  Execution identity
                  <select name="policyExecutionIdentity" defaultValue={profile.executionIdentity}>
                    <option value="automatic">Automatic</option>
                    <option value="user">User-backed</option>
                    <option value="bot">Bot-backed</option>
                    <option value="selectable">Selectable by request</option>
                  </select>
                </label>
                <label>
                  Expiry
                  <select name="policyExperiment" defaultValue="">
                    <option value="">Policy default</option>
                    <option value="24h">24 hours</option>
                    <option value="7d">7 days</option>
                  </select>
                </label>
                <label className="inline-check">
                  <input type="checkbox" name="confirmBroadening" /> Confirm broadening and rotate token
                </label>
                <Button type="submit" disabled={actionProfileId === profile.id}>
                  Update policy
                </Button>
              </form>
              <Button variant="danger" type="button" onClick={() => onRevoke(profile)} disabled={actionProfileId === profile.id}>
                Revoke token
              </Button>
            </div>
          </article>
        ))}
      </div>
    </Panel>
  );
}

function toSummary(profile: TokenProfileSummary & { capabilityMap?: { executionIdentity?: TokenProfileSummary["executionIdentity"] } }): TokenProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    intendedUse: profile.intendedUse,
    preset: profile.preset,
    executionIdentity: profile.executionIdentity ?? profile.capabilityMap?.executionIdentity ?? "automatic",
    expiresAt: profile.expiresAt,
    createdAt: profile.createdAt,
    developerToken: profile.developerToken
  };
}

function presetLabel(preset: TokenProfileSummary["preset"]): string {
  if (preset === "read_only") return "Read-only";
  if (preset === "messages_only") return "Messages only";
  if (preset === "full_slack_bridge") return "Full Slack bridge";
  return "Custom";
}

function executionIdentityLabel(identity: TokenProfileSummary["executionIdentity"]): string {
  if (identity === "user") return "User-backed";
  if (identity === "bot") return "Bot-backed";
  if (identity === "selectable") return "Selectable by request";
  return "Automatic";
}

function developerTokenStatusLabel(status: NonNullable<TokenProfileSummary["developerToken"]>["status"] | undefined): string {
  if (status === "expired") return "Expired";
  if (status === "revoked") return "Revoked";
  if (status === "missing") return "Missing";
  return "Active";
}

function developerTokenStatusTone(status: NonNullable<TokenProfileSummary["developerToken"]>["status"] | undefined): "success" | "warning" | "neutral" {
  if (status === "active" || status === undefined) return "success";
  if (status === "missing") return "warning";
  return "neutral";
}

"use client";

import { FormEvent, useState } from "react";

import { formatUtcDate, formatUtcDateTime } from "./date-format";
import { buildCreateTokenProfileRequestBody, buildPolicyUpdateRequestBody } from "./token-profile-form";
import { Button, Notice, Panel, StatusBadge } from "./ui";

type ProfileAction = { profileId: string; kind: "rotate" | "policy" | "revoke" };

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
  const [profileAction, setProfileAction] = useState<ProfileAction | null>(null);
  const actionStatus = profileActionStatus(profileAction);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);

    const response = await fetch("/v1/prism/token-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCreateTokenProfileRequestBody(form))
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
    setProfileAction({ profileId: profile.id, kind: "revoke" });
    setError(null);
    setDeveloperToken(null);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/revoke`, { method: "POST" });
    const body = await response.json();
    setProfileAction(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not revoke Token profile.");
      return;
    }
    replaceProfile(body.profile);
  }

  async function onRotate(event: FormEvent<HTMLFormElement>, profile: TokenProfileSummary) {
    event.preventDefault();
    setProfileAction({ profileId: profile.id, kind: "rotate" });
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overlap: String(form.get("overlap") ?? "none") })
    });
    const body = await response.json();
    setProfileAction(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not rotate Token profile.");
      return;
    }
    setDeveloperToken(body.developerToken);
    replaceProfile(body.profile);
  }

  async function onPolicyUpdate(event: FormEvent<HTMLFormElement>, profile: TokenProfileSummary) {
    event.preventDefault();
    setProfileAction({ profileId: profile.id, kind: "policy" });
    setError(null);
    setDeveloperToken(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPolicyUpdateRequestBody(form, profile))
    });
    const body = await response.json();
    setProfileAction(null);
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
      <form className="token-form guided-token-form" onSubmit={onSubmit}>
        <fieldset className="guided-step">
          <legend>
            <span className="step-kicker">1. Name the local tool</span>
            <span className="step-title">Make the access grant recognizable later.</span>
          </legend>
          <label className="field">
            Profile name
            <input name="name" required maxLength={80} placeholder="Local MCP read" />
            <span className="field-help">Use the local tool, agent, or workflow name.</span>
          </label>
          <label className="field">
            Intended use
            <input name="intendedUse" required maxLength={180} placeholder="Read Slack context from my local MCP server" />
            <span className="field-help">This appears in profile metadata so future reviews know why access exists.</span>
          </label>
        </fieldset>

        <fieldset className="guided-step">
          <legend>
            <span className="step-kicker">2. Choose least-privilege access</span>
            <span className="step-title">Start narrow. Broader policies can require rotation.</span>
          </legend>
          <div className="preset-grid">
            <label className="choice-card">
              <input type="radio" name="preset" value="read_only" defaultChecked />
              <span>
                <strong>Read-only</strong>
                <span>Recommended for MCP readers and context tools.</span>
              </span>
            </label>
            <label className="choice-card">
              <input type="radio" name="preset" value="messages_only" />
              <span>
                <strong>Messages only</strong>
                <span>Read context, post messages, and manage reactions.</span>
              </span>
            </label>
            <label className="choice-card">
              <input type="radio" name="preset" value="full_slack_bridge" />
              <span>
                <strong>Full Slack bridge</strong>
                <span>Use the representative bridge surface with explicit destructive opt-in.</span>
              </span>
            </label>
            <label className="choice-card">
              <input type="radio" name="preset" value="custom" />
              <span>
                <strong>Custom</strong>
                <span>Choose individual read, search, message, reaction, and file metadata capabilities.</span>
              </span>
            </label>
          </div>
          <fieldset className="custom-capabilities">
            <legend>Custom capability details</legend>
            <p className="field-help">Only applies when Custom is selected.</p>
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
            </div>
          </fieldset>
          <fieldset className="custom-capabilities destructive-opt-in">
            <legend>Destructive methods</legend>
            <p className="field-help">Applies to Full Slack bridge and Custom profiles.</p>
            <label className="inline-check">
              <input type="checkbox" name="destructive" /> Allow explicitly destructive Slack methods for this Token profile
            </label>
          </fieldset>
        </fieldset>

        <fieldset className="guided-step">
          <legend>
            <span className="step-kicker">3. Set runtime boundaries</span>
            <span className="step-title">Choose who Slack sees and when the token should expire.</span>
          </legend>
          <label className="field">
            Execution identity
            <select name="executionIdentity" defaultValue="automatic">
              <option value="automatic">Automatic</option>
              <option value="user">User-backed</option>
              <option value="bot">Bot-backed</option>
              <option value="selectable">Selectable by request</option>
            </select>
            <span className="field-help">Automatic lets Prism choose the safest available Slack identity for the method.</span>
          </label>
          <label className="field">
            Experiment expiry
            <select name="experiment" defaultValue="">
              <option value="">Not an experiment token</option>
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
            </select>
            <span className="field-help">Use short expiry for trials. Prism still applies server-side policy expiries.</span>
          </label>
        </fieldset>

        <fieldset className="guided-step review-step">
          <legend>
            <span className="step-kicker">4. Review and create</span>
            <span className="step-title">Server custody, Prism token only.</span>
          </legend>
          <ul className="review-list">
            <li>Slack credentials stay encrypted with Prism.</li>
            <li>The developer token is shown once after creation.</li>
            <li>Slack content remains untrusted input to local tools.</li>
          </ul>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create and show token once"}
          </Button>
        </fieldset>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          {error} Check the fields and try again.
        </p>
      ) : null}
      {actionStatus ? (
        <p className="sr-only" role="status" aria-live="polite">
          {actionStatus}
        </p>
      ) : null}
      {developerToken ? (
        <div className="copy-once" role="status">
          <strong>Copy this Prism developer token now. It will not be shown again.</strong>
          <code>{developerToken}</code>
        </div>
      ) : (
        <p className="copy-placeholder">Copy-once token appears here after create or rotate.</p>
      )}
      <div className="profile-list" aria-label="Existing Token profiles">
        <h3>Existing profiles</h3>
        {profiles.length === 0 ? <p>No Token profiles yet. Create one above to give a local tool scoped Slack access.</p> : null}
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
             <section className="profile-action-card" aria-labelledby={`${profile.id}-rotate-title`} aria-busy={isProfileAction(profileAction, profile.id, "rotate")}>
               <h5 id={`${profile.id}-rotate-title`}>Rotate safely</h5>
               <p>Issue a replacement developer token. The old token can stop immediately or keep a short overlap.</p>
               <form onSubmit={(event) => onRotate(event, profile)}>
                 <label>
                   Overlap window
                   <select name="overlap" defaultValue="none">
                     <option value="none">No overlap</option>
                     <option value="15m">15 minutes</option>
                     <option value="1h">1 hour</option>
                     <option value="24h">24 hours</option>
                   </select>
                 </label>
                 <Button type="submit" disabled={isProfileBusy(profileAction, profile.id)}>
                   {isProfileAction(profileAction, profile.id, "rotate") ? "Rotating..." : "Rotate token"}
                 </Button>
               </form>
             </section>
             <section className="profile-action-card" aria-labelledby={`${profile.id}-policy-title`} aria-busy={isProfileAction(profileAction, profile.id, "policy")}>
               <h5 id={`${profile.id}-policy-title`}>Policy changes</h5>
               <p>Broadening requires token rotation. Narrowing can apply immediately through the server policy check.</p>
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
                 <fieldset className="custom-capabilities policy-custom-capabilities">
                   <legend>Policy custom capabilities</legend>
                   <p className="field-help">Used when Policy preset is Custom.</p>
                   <div className="checkbox-grid" aria-label="Policy custom capability options">
                     <label>
                       <input type="checkbox" name="policyRead" defaultChecked /> Read
                     </label>
                     <label>
                       <input type="checkbox" name="policySearch" defaultChecked /> Search
                     </label>
                     <label>
                       <input type="checkbox" name="policyWriteMessages" /> Write messages
                     </label>
                     <label>
                       <input type="checkbox" name="policyReactions" /> Reactions
                     </label>
                     <label>
                       <input type="checkbox" name="policyFilesMetadata" /> Files metadata
                     </label>
                   </div>
                 </fieldset>
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
                 <label className="inline-check">
                   <input type="checkbox" name="policyDestructive" /> Allow destructive methods for Full Slack bridge or Custom policy
                 </label>
                 <Button type="submit" disabled={isProfileBusy(profileAction, profile.id)}>
                   {isProfileAction(profileAction, profile.id, "policy") ? "Updating..." : "Update policy"}
                 </Button>
               </form>
             </section>
             <section className="profile-action-card profile-action-card--danger" aria-labelledby={`${profile.id}-revoke-title`} aria-busy={isProfileAction(profileAction, profile.id, "revoke")}>
               <h5 id={`${profile.id}-revoke-title`}>Revocation is immediate</h5>
               <p>Use revoke when a local tool no longer needs Slack access or a token may have been copied somewhere unsafe.</p>
               <Button variant="danger" type="button" onClick={() => onRevoke(profile)} disabled={isProfileBusy(profileAction, profile.id)}>
                 {isProfileAction(profileAction, profile.id, "revoke") ? "Revoking..." : "Revoke token"}
               </Button>
             </section>
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

function isProfileBusy(action: ProfileAction | null, profileId: string): boolean {
  return action?.profileId === profileId;
}

function isProfileAction(action: ProfileAction | null, profileId: string, kind: ProfileAction["kind"]): boolean {
  return action?.profileId === profileId && action.kind === kind;
}

function profileActionStatus(action: ProfileAction | null): string | null {
  if (!action) return null;
  if (action.kind === "rotate") return "Rotating Token profile developer token.";
  if (action.kind === "policy") return "Updating Token profile policy.";
  return "Revoking Token profile developer token.";
}

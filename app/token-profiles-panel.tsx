"use client";

import { FormEvent, useId, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

import { formatUtcDate, formatUtcDateTime } from "./date-format";
import { buildCreateTokenProfileRequestBody, buildPolicyUpdateRequestBody } from "./token-profile-form";
import { Button, Notice, Panel, StatusBadge, cn } from "./ui";

type ProfileAction = { profileId: string; kind: "rotate" | "policy" | "revoke" };

const fieldClass = "grid gap-2 text-sm font-medium text-foreground";
const helperClass = "text-xs leading-5 text-muted-foreground";
const choiceClass =
  "flex min-h-24 gap-3 rounded-xl bg-muted/35 p-4 text-sm transition-colors hover:bg-muted/55";
const checkboxLabelClass =
  "flex min-h-11 items-center gap-3 rounded-lg bg-muted/35 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/55";
const actionCardClass = "grid gap-3 rounded-xl bg-muted/35 p-4";
const executionIdentityOptions = [
  { value: "automatic", label: "Automatic" },
  { value: "user", label: "User-backed" },
  { value: "bot", label: "Bot-backed" },
  { value: "selectable", label: "Selectable by request" }
];
const experimentOptions = [
  { value: "none", label: "Not an experiment token" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" }
];
const policyExperimentOptions = [
  { value: "none", label: "Policy default" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" }
];
const presetOptions = [
  { value: "read_only", label: "Read-only" },
  { value: "messages_only", label: "Messages only" },
  { value: "full_slack_bridge", label: "Full Slack bridge" },
  { value: "custom", label: "Custom" }
];
const overlapOptions = [
  { value: "none", label: "No overlap" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" }
];

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
    <>
    <Panel
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
      <details className="group/create rounded-2xl bg-muted/25 p-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          Create a new Token profile
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Open form</span>
        </summary>
        <form className="mt-5 hidden gap-6 group-open/create:grid" onSubmit={onSubmit}>
        <fieldset className="grid gap-4">
          <legend>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">1. Name the local tool</span>
            <span className="mt-1 block text-base font-semibold tracking-tight text-foreground">Make the access grant recognizable later.</span>
          </legend>
          <label className={fieldClass}>
            Profile name
            <Input name="name" required maxLength={80} placeholder="Local MCP read" />
            <span className={helperClass}>Use the local tool, agent, or workflow name.</span>
          </label>
          <label className={fieldClass}>
            Intended use
            <Textarea name="intendedUse" required maxLength={180} placeholder="Read Slack context from my local MCP server" />
            <span className={helperClass}>This appears in profile metadata so future reviews know why access exists.</span>
          </label>
        </fieldset>

        <Separator />

        <fieldset className="grid gap-4">
          <legend>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">2. Choose least-privilege access</span>
            <span className="mt-1 block text-base font-semibold tracking-tight text-foreground">Start narrow. Broader policies can require rotation.</span>
          </legend>
          <RadioGroup name="preset" defaultValue="read_only" className="grid gap-3 md:grid-cols-2">
            <PresetChoice
              id="preset-read-only"
              value="read_only"
              label="Read-only"
              description="Recommended for MCP readers and context tools."
            />
            <PresetChoice
              id="preset-messages-only"
              value="messages_only"
              label="Messages only"
              description="Read context, post messages, and manage reactions."
            />
            <PresetChoice
              id="preset-full-bridge"
              value="full_slack_bridge"
              label="Full Slack bridge"
              description="Use the representative bridge surface with explicit destructive opt-in."
            />
            <PresetChoice
              id="preset-custom"
              value="custom"
              label="Custom"
              description="Choose individual read, search, message, reaction, and file metadata capabilities."
            />
          </RadioGroup>
          <details className="group/custom rounded-xl bg-muted/25 p-3">
            <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
              Custom and destructive options
            </summary>
            <div className="mt-4 hidden gap-3 group-open/custom:grid">
              <fieldset className="grid gap-3 rounded-xl bg-background/70 p-4">
                <legend className="px-1 text-sm font-semibold text-foreground">Custom capability details</legend>
                <p className={helperClass}>Only applies when Custom is selected.</p>
                <div className="grid gap-2 sm:grid-cols-2" aria-label="Custom capability options">
                  <CheckboxField name="customRead" label="Read" defaultChecked />
                  <CheckboxField name="customSearch" label="Search" defaultChecked />
                  <CheckboxField name="customWriteMessages" label="Write messages" />
                  <CheckboxField name="customReactions" label="Reactions" />
                  <CheckboxField name="customFilesMetadata" label="Files metadata" />
                </div>
              </fieldset>
              <fieldset className="grid gap-3 rounded-xl bg-destructive/5 p-4">
                <legend className="px-1 text-sm font-semibold text-foreground">Destructive methods</legend>
                <p className={helperClass}>Applies to Full Slack bridge and Custom profiles.</p>
                <CheckboxField name="destructive" label="Allow explicitly destructive Slack methods for this Token profile" />
              </fieldset>
            </div>
          </details>
        </fieldset>

        <Separator />

        <fieldset className="grid gap-4">
          <legend>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">3. Set runtime boundaries</span>
            <span className="mt-1 block text-base font-semibold tracking-tight text-foreground">Choose who Slack sees and when the token should expire.</span>
          </legend>
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              name="executionIdentity"
              label="Execution identity"
              defaultValue="automatic"
              options={executionIdentityOptions}
              help="Automatic lets Prism choose the safest available Slack identity for the method."
            />
            <SelectField
              name="experiment"
              label="Experiment expiry"
              defaultValue="none"
              options={experimentOptions}
              help="Use short expiry for trials. Prism still applies server-side policy expiries."
            />
          </div>
        </fieldset>

        <Separator />

        <fieldset className="grid gap-4 rounded-2xl bg-muted/30 p-4">
          <legend>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">4. Review and create</span>
            <span className="mt-1 block text-base font-semibold tracking-tight text-foreground">Server custody, Prism token only.</span>
          </legend>
          <ul className="grid gap-2 pl-5 text-sm leading-6 text-muted-foreground">
            <li>Slack credentials stay encrypted with Prism.</li>
            <li>The developer token is shown once after creation.</li>
            <li>Slack content remains untrusted input to local tools.</li>
          </ul>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create and show token once"}
          </Button>
        </fieldset>
        </form>
      </details>
      {error ? (
        <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
          {error} Check the fields and try again.
        </p>
      ) : null}
      {actionStatus ? (
        <p className="sr-only" role="status" aria-live="polite">
          {actionStatus}
        </p>
      ) : null}
      {developerToken ? (
        <div className="grid gap-3 rounded-2xl border border-[color:var(--prism-warning)] bg-[color:var(--prism-warning-soft)] p-4">
          <p className="sr-only" role="status" aria-live="polite">
            Prism developer token created. Copy it from the code field now because it will not be shown again.
          </p>
          <strong className="text-foreground">Copy this Prism developer token now. It will not be shown again.</strong>
          <code className="rounded-lg bg-foreground p-3 text-sm text-background [overflow-wrap:anywhere]">{developerToken}</code>
        </div>
      ) : null}
    </Panel>
    <Panel title="Token profiles" titleId="token-profile-list-title" eyebrow="Manage access" badge={<StatusBadge tone="neutral">{profiles.length} active grants</StatusBadge>}>
      <div className="grid gap-3" aria-label="Existing Token profiles">
        {profiles.length === 0 ? <p className="text-sm leading-6 text-muted-foreground">No Token profiles yet. Create one above to give a local tool scoped Slack access.</p> : null}
        {profiles.map((profile) => (
          <article className="grid gap-4 rounded-2xl bg-muted/20 p-4" key={profile.id}>
            <div>
              <h4 className="text-base font-semibold tracking-tight text-foreground">{profile.name}</h4>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{profile.intendedUse}</p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Preset</dt>
                <dd className="mt-1 text-sm text-foreground">{presetLabel(profile.preset)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Execution identity</dt>
                <dd className="mt-1 text-sm text-foreground">{executionIdentityLabel(profile.executionIdentity)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Token status</dt>
                <dd>
                  <StatusBadge tone={developerTokenStatusTone(profile.developerToken?.status)}>
                    {developerTokenStatusLabel(profile.developerToken?.status)}
                  </StatusBadge>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Expiry</dt>
                <dd className="mt-1 text-sm text-foreground">{formatUtcDate(profile.expiresAt ?? profile.developerToken?.expiresAt ?? null) ?? "No expiry"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Last used</dt>
                <dd className="mt-1 text-sm text-foreground">{formatUtcDateTime(profile.developerToken?.lastUsedAt ?? null) ?? "Not used yet"}</dd>
              </div>
              {profile.developerToken?.overlapExpiresAt ? (
                <div>
                 <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Overlap until</dt>
                 <dd className="mt-1 text-sm text-foreground">{formatUtcDateTime(profile.developerToken.overlapExpiresAt)}</dd>
                </div>
              ) : null}
              {profile.developerToken?.revokedAt ? (
                <div>
                 <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Revoked</dt>
                 <dd className="mt-1 text-sm text-foreground">{formatUtcDateTime(profile.developerToken.revokedAt)}</dd>
                </div>
              ) : null}
            </dl>
            <details className="group/manage rounded-xl bg-background/70 p-3">
             <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
               Manage rotation, policy, and revocation
               <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Open</span>
             </summary>
             <div className="mt-4 hidden gap-3 group-open/manage:grid xl:grid-cols-3">
             <section className={actionCardClass} aria-labelledby={`${profile.id}-rotate-title`} aria-busy={isProfileAction(profileAction, profile.id, "rotate")}>
               <h5 className="text-sm font-semibold text-foreground" id={`${profile.id}-rotate-title`}>Rotate safely</h5>
               <p className="text-sm leading-6 text-muted-foreground">Issue a replacement developer token. The old token can stop immediately or keep a short overlap.</p>
               <form className="grid gap-3" onSubmit={(event) => onRotate(event, profile)}>
                 <SelectField name="overlap" label="Overlap window" defaultValue="none" options={overlapOptions} />
                 <Button type="submit" disabled={isProfileBusy(profileAction, profile.id)}>
                   {isProfileAction(profileAction, profile.id, "rotate") ? "Rotating..." : "Rotate token"}
                 </Button>
               </form>
             </section>
             <section className={actionCardClass} aria-labelledby={`${profile.id}-policy-title`} aria-busy={isProfileAction(profileAction, profile.id, "policy")}>
               <h5 className="text-sm font-semibold text-foreground" id={`${profile.id}-policy-title`}>Policy changes</h5>
               <p className="text-sm leading-6 text-muted-foreground">Broadening requires token rotation. Narrowing can apply immediately through the server policy check.</p>
               <form className="grid gap-3" onSubmit={(event) => onPolicyUpdate(event, profile)}>
                 <SelectField name="policyPreset" label="Policy preset" defaultValue={profile.preset} options={presetOptions} />
                 <fieldset className="grid gap-3 rounded-xl bg-background/70 p-3">
                   <legend className="px-1 text-sm font-semibold text-foreground">Policy custom capabilities</legend>
                   <p className={helperClass}>Used when Policy preset is Custom.</p>
                   <div className="grid gap-2" aria-label="Policy custom capability options">
                     <CheckboxField name="policyRead" label="Read" defaultChecked />
                     <CheckboxField name="policySearch" label="Search" defaultChecked />
                     <CheckboxField name="policyWriteMessages" label="Write messages" />
                     <CheckboxField name="policyReactions" label="Reactions" />
                     <CheckboxField name="policyFilesMetadata" label="Files metadata" />
                   </div>
                 </fieldset>
                 <SelectField name="policyExecutionIdentity" label="Execution identity" defaultValue={profile.executionIdentity} options={executionIdentityOptions} />
                 <SelectField name="policyExperiment" label="Expiry" defaultValue="none" options={policyExperimentOptions} />
                 <CheckboxField name="confirmBroadening" label="Confirm broadening and rotate token" />
                 <CheckboxField name="policyDestructive" label="Allow destructive methods for Full Slack bridge or Custom policy" />
                 <Button type="submit" disabled={isProfileBusy(profileAction, profile.id)}>
                   {isProfileAction(profileAction, profile.id, "policy") ? "Updating..." : "Update policy"}
                 </Button>
               </form>
             </section>
             <section className={cn(actionCardClass, "border-destructive/35 bg-destructive/5")} aria-labelledby={`${profile.id}-revoke-title`} aria-busy={isProfileAction(profileAction, profile.id, "revoke")}>
               <h5 className="text-sm font-semibold text-foreground" id={`${profile.id}-revoke-title`}>Revocation is immediate</h5>
               <p className="text-sm leading-6 text-muted-foreground">Use revoke when a local tool no longer needs Slack access or a token may have been copied somewhere unsafe.</p>
               <Button variant="danger" type="button" onClick={() => onRevoke(profile)} disabled={isProfileBusy(profileAction, profile.id)}>
                 {isProfileAction(profileAction, profile.id, "revoke") ? "Revoking..." : "Revoke token"}
               </Button>
             </section>
            </div>
           </details>
          </article>
        ))}
      </div>
    </Panel>
    </>
  );
}

function PresetChoice({
  id,
  value,
  label,
  description
}: {
  id: string;
  value: string;
  label: string;
  description: string;
}) {
  return (
    <div className={choiceClass}>
      <RadioGroupItem id={id} value={value} className="mt-1" />
      <Label htmlFor={id} className="grid cursor-pointer gap-1 leading-6">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="font-normal text-muted-foreground">{description}</span>
      </Label>
    </div>
  );
}

function CheckboxField({ name, label, defaultChecked = false }: { name: string; label: string; defaultChecked?: boolean }) {
  const id = `${name}-${useId()}`;

  return (
    <div className={checkboxLabelClass}>
      <Checkbox id={id} name={name} defaultChecked={defaultChecked} />
      <Label htmlFor={id} className="cursor-pointer leading-5">
        {label}
      </Label>
    </div>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  options,
  help
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  help?: string;
}) {
  const id = `${name}-${useId()}`;

  return (
    <div className={fieldClass}>
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} defaultValue={defaultValue}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help ? <span className={helperClass}>{help}</span> : null}
    </div>
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

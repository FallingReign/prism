"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";

import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import type { ActivityAuditSummary } from "../src/server/audit/presentation";
import { ActivityAuditPanel } from "./activity-audit-panel";
import { copyTextToClipboard } from "./client-clipboard";
import { formatUtcDate, formatUtcDateTime } from "./date-format";
import { buildPolicyUpdateRequestBody } from "./token-profile-form";
import {
  capabilityTemplateForPreset,
  defaultTokenProfilePolicyOptions,
  executionIdentityLabel,
  executionIdentitySelectOptions,
  presetAvailability,
  type TokenProfileCapabilitySelection,
  type TokenProfilePolicyOptions,
  type TokenProfilePolicyPreset
} from "./token-profile-policy-options";
import type { TokenProfileSummary } from "./token-profile-summary";
import { accessStatusForProfile, isInactiveTokenProfile } from "./token-profile-workspace";
import { Button, Notice, Panel, StatusBadge, cn } from "./ui";

type ProfileAction = { kind: "rotate" | "policy" | "revoke" | "delete" };

const fieldClass = "grid gap-2 text-sm font-medium text-foreground";
const helperClass = "text-xs leading-5 text-muted-foreground";
const checkboxLabelClass =
  "flex min-h-11 items-center gap-3 rounded-lg bg-muted/35 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/55";
const actionCardClass = "grid gap-3 rounded-xl bg-muted/35 p-4";
const presetOptions = [
  { value: "read_only", label: "Read-only" },
  { value: "messages_only", label: "Messages only" },
  { value: "full_slack_bridge", label: "Full Slack bridge" },
  { value: "custom", label: "Custom" }
];
const capabilityOptions: Array<{ key: keyof TokenProfileCapabilitySelection; label: string; description?: string }> = [
  { key: "read", label: "Read" },
  { key: "search", label: "Search" },
  { key: "writeMessages", label: "Write messages" },
  { key: "reactions", label: "Reactions" },
  { key: "filesMetadata", label: "Files metadata" },
  { 
    key: "destructive", 
    label: "Destructive methods",
    description: "Allows chat.delete to permanently delete messages. Tokens with this capability expire after 30 days. Non-destructive tokens never expire."
  }
];
const overlapOptions = [
  { value: "none", label: "No overlap" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" }
];

export function TokenProfileDetailWorkspace({
  initialProfile,
  profile: profileProp,
  slackStatus,
  activity,
  policyOptions = defaultTokenProfilePolicyOptions
}: {
  initialProfile?: TokenProfileSummary;
  profile?: TokenProfileSummary;
  slackStatus: "healthy" | "reauth_required";
  activity: ActivityAuditSummary[];
  policyOptions?: TokenProfilePolicyOptions;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(initialProfile ?? profileProp!);
  const [policyPreset, setPolicyPreset] = useState<TokenProfilePolicyPreset>(() => (initialProfile ?? profileProp!).preset);
  const [policyCapabilities, setPolicyCapabilities] = useState<TokenProfileCapabilitySelection>(() => capabilitiesForProfile(initialProfile ?? profileProp!));
  const [developerToken, setDeveloperToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [profileAction, setProfileAction] = useState<ProfileAction | null>(null);
  const accessStatus = accessStatusForProfile(profile, slackStatus);
  const inactive = isInactiveTokenProfile(profile);
  const outsideGlobalPolicy = profile.globalPolicyStatus?.kind === "outside";
  const actionStatus = profileActionStatus(profileAction);

  async function onRotate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileAction({ kind: "rotate" });
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
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
    setTokenCopied(false);
    const nextProfile = toSummary(body.profile);
    setProfile(nextProfile);
    setPolicyPreset(nextProfile.preset);
    setPolicyCapabilities(capabilitiesForProfile(nextProfile));
    router.refresh();
  }

  async function onPolicyUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileAction({ kind: "policy" });
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
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
    if (body.developerToken) {
      setDeveloperToken(body.developerToken);
      setTokenCopied(false);
    }
    const nextProfile = toSummary(body.profile);
    setProfile(nextProfile);
    setPolicyPreset(nextProfile.preset);
    setPolicyCapabilities(capabilitiesForProfile(nextProfile));
    router.refresh();
  }

  async function onRevoke() {
    setProfileAction({ kind: "revoke" });
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/revoke`, { method: "POST" });
    const body = await response.json();
    setProfileAction(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not remove access.");
      return;
    }
    setProfile(toSummary(body.profile));
    setRemoveOpen(false);
    router.refresh();
  }

  async function onDelete() {
    setProfileAction({ kind: "delete" });
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    const body = await response.json();
    setProfileAction(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not delete Token profile.");
      return;
    }
    setDeleteOpen(false);
    router.push("/");
    router.refresh();
  }

  async function copyDeveloperToken() {
    if (!developerToken) return;
    try {
      await copyTextToClipboard(developerToken);
      setTokenCopied(true);
      setError(null);
    } catch {
      setError("Could not copy automatically. Select the token and copy it before continuing.");
    }
  }

  function onPolicyPresetChange(value: string) {
    const nextPreset = value as TokenProfilePolicyPreset;
    setPolicyPreset(nextPreset);
    if (nextPreset !== "custom") {
      setPolicyCapabilities(capabilityTemplateForPreset(nextPreset));
    }
  }

  function onPolicyCapabilityChange(key: keyof TokenProfileCapabilitySelection, checked: boolean) {
    setPolicyCapabilities((current) => ({ ...current, [key]: checked }));
    if (!(key === "destructive" && policyPreset === "full_slack_bridge")) {
      setPolicyPreset("custom");
    }
  }

  return (
    <div className="grid gap-5">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {actionStatus}
      </p>
      <Panel
        title={profile.name}
        titleId="token-profile-detail-title"
        eyebrow="Token profile"
        accent="primary"
        badge={<StatusBadge tone={accessStatus.tone}>{accessStatus.label}</StatusBadge>}
      >
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{profile.intendedUse}</p>
        {outsideGlobalPolicy ? (
          <Notice title="Outside global policy" tone="warning">
            This existing profile keeps its current token until normal expiry or revocation, but Prism blocks rotation and broadening until the policy is narrowed.
          </Notice>
        ) : null}
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metadata label="Preset" value={presetLabel(profile.preset)} />
          <Metadata label="Execution identity" value={executionIdentityLabel(profile.executionIdentity)} />
          <Metadata label="Created" value={formatUtcDate(profile.createdAt)} />
          <Metadata label="Last used" value={formatUtcDateTime(profile.developerToken?.lastUsedAt ?? null) ?? "Not used yet"} />
        </dl>
        {slackStatus === "reauth_required" ? (
          <Notice title="Slack reauth required" tone="warning">
            This profile is preserved, but local tools cannot use Slack through Prism until Slack is reconnected.
          </Notice>
        ) : null}
      </Panel>

      <Panel
        title="Lifecycle"
        titleId="token-profile-lifecycle-title"
        eyebrow="Copy-once actions"
        accent="warning"
        badge={<StatusBadge tone={developerTokenStatusTone(profile.developerToken?.status)}>{developerTokenStatusLabel(profile.developerToken?.status)}</StatusBadge>}
      >
        <div className="grid gap-3 xl:grid-cols-3">
          {inactive ? null : (
            <section className={actionCardClass} aria-labelledby="rotate-token-title" aria-busy={profileAction?.kind === "rotate"}>
              <h3 className="text-sm font-semibold text-foreground" id="rotate-token-title">
                Rotate developer token
              </h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Issue a replacement Prism developer token. The old token can stop immediately or keep a short overlap.
              </p>
              <form className="grid gap-3" onSubmit={onRotate}>
                <SelectField name="overlap" label="Overlap window" defaultValue="none" options={overlapOptions} />
                {outsideGlobalPolicy ? (
                  <Notice title="Rotation blocked" tone="warning">
                    Narrow this profile inside the Global Token profile policy before issuing replacement developer tokens.
                  </Notice>
                ) : null}
                <Button type="submit" disabled={Boolean(profileAction) || outsideGlobalPolicy}>
                  {profileAction?.kind === "rotate" ? "Rotating..." : "Rotate developer token"}
                </Button>
              </form>
            </section>
          )}
          <section className={actionCardClass} aria-labelledby="refresh-detail-title">
            <h3 className="text-sm font-semibold text-foreground" id="refresh-detail-title">
              Refresh metadata
            </h3>
            <p className="text-sm leading-6 text-muted-foreground">
              Re-read profile status, last-used metadata, and profile events without changing policy or token material.
            </p>
            <Button type="button" variant="secondary" onClick={() => router.refresh()}>
              Refresh detail
            </Button>
          </section>
          {inactive ? (
            <section className={cn(actionCardClass, "border-destructive/35 bg-destructive/5")} aria-labelledby="delete-profile-title" aria-busy={profileAction?.kind === "delete"}>
              <h3 className="text-sm font-semibold text-foreground" id="delete-profile-title">
                Delete permanently
              </h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Remove this inactive Token profile and its developer-token verifiers. Metadata-only audit can remain until retention expires.
              </p>
              <Button type="button" variant="danger" onClick={() => setDeleteOpen(true)}>
                Delete permanently
              </Button>
              <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Delete {profile.name} permanently?</DialogTitle>
                    <DialogDescription>
                      This removes {profile.name} from the manager. Historical metadata-only audit rows may remain.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="secondary">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="button" variant="danger" disabled={profileAction?.kind === "delete"} onClick={onDelete}>
                      {profileAction?.kind === "delete" ? "Deleting..." : "Delete permanently"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </section>
          ) : (
            <section className={cn(actionCardClass, "border-destructive/35 bg-destructive/5")} aria-labelledby="remove-access-title" aria-busy={profileAction?.kind === "revoke"}>
              <h3 className="text-sm font-semibold text-foreground" id="remove-access-title">
                Remove access
              </h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Revoke the current Prism developer token. Profile metadata and audit events stay available here.
              </p>
              <Button type="button" variant="danger" onClick={() => setRemoveOpen(true)}>
                Remove access
              </Button>
              <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>Remove access?</DialogTitle>
                    <DialogDescription>
                      This revokes the current Prism developer token for {profile.name}. Metadata-only audit is preserved.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="secondary">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="button" variant="danger" disabled={profileAction?.kind === "revoke"} onClick={onRevoke}>
                      {profileAction?.kind === "revoke" ? "Removing..." : "Remove access"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </section>
          )}
        </div>
        {developerToken ? (
          <div className="grid gap-3 rounded-xl bg-muted/35 p-4">
            <p className="sr-only" role="status" aria-live="polite">
              Prism developer token created. Copy it from the code field now because it will not be shown again.
            </p>
            <Notice title="Copy this Prism developer token now" tone="warning">
              It will not be shown again. Slack credentials still stay server-side with Prism.
            </Notice>
            <code className="rounded-lg bg-foreground p-3 text-sm text-background [overflow-wrap:anywhere]">{developerToken}</code>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="secondary" onClick={copyDeveloperToken}>
                Copy token
              </Button>
              <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-foreground">
                <input className="size-4" type="checkbox" checked={tokenCopied} onChange={(event) => setTokenCopied(event.currentTarget.checked)} />
                I have copied this token
              </label>
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </Panel>

      <Panel title="Policy" titleId="token-profile-policy-title" eyebrow="Configuration" accent="info">
        <p className="text-sm leading-6 text-muted-foreground">
          {inactive
            ? "This inactive profile is preserved for review. Delete it permanently when its retained metadata is no longer needed."
            : outsideGlobalPolicy
              ? "Narrow this profile back inside the Global Token profile policy before rotating or broadening developer-token access."
              : "Narrowing takes effect immediately. Broadening capabilities requires explicit confirmation and returns a replacement token once."}
        </p>
        {inactive ? (
          <Notice title="Policy locked" tone="neutral">
            Access removal is already complete, so Prism will not issue or broaden developer-token permissions for this profile.
          </Notice>
        ) : (
          <form className="grid gap-4" onSubmit={onPolicyUpdate}>
            <div className="grid gap-4 lg:grid-cols-2">
              <SelectField
                name="policyPreset"
                label="Policy preset"
                value={policyPreset}
                onValueChange={onPolicyPresetChange}
                options={presetOptions.map((option) => ({ ...option, disabled: !presetAvailability(option.value as TokenProfilePolicyPreset, policyOptions).allowed }))}
              />
              <SelectField
                name="policyExecutionIdentity"
                label="Execution identity"
                defaultValue={profile.executionIdentity}
                options={executionIdentitySelectOptions(policyOptions, profile.executionIdentity)}
                help={executionIdentityHelp(policyOptions, profile.executionIdentity)}
              />
              <NumberField
                name="policyExpiryDays"
                label="Expires in (days)"
                help={profile.expiresAt ? `Current expiry: ${formatUtcDate(profile.expiresAt)}. Enter a number to reset it from today.` : "No current expiry. Enter a number to set one."}
              />
            </div>
            <fieldset className="grid gap-3 rounded-xl bg-muted/30 p-4">
              <legend className="px-1 text-sm font-semibold text-foreground">Capability template</legend>
              <p className={helperClass}>
                Current capabilities: {capabilitySummary(policyCapabilities)}. Selecting a named preset applies its template; manual capability changes switch this policy to Custom.
              </p>
              <div className="grid gap-2 sm:grid-cols-2" aria-label="Policy custom capability options">
                {capabilityOptions.map((option) => {
                  const allowed = policyOptions.capabilities.maximum[option.key];
                  const checked = policyCapabilities[option.key];
                  const helpText = !allowed 
                    ? `Global policy blocks adding ${option.label}.`
                    : option.description;
                  return (
                    <CheckboxField
                      key={option.key}
                      name={option.key === "destructive" ? "policyDestructive" : `policy${capabilityFieldSuffix(option.key)}`}
                      label={option.label}
                      checked={checked}
                      disabled={!allowed && !checked}
                      help={helpText}
                      onCheckedChange={(nextChecked) => onPolicyCapabilityChange(option.key, nextChecked)}
                    />
                  );
                })}
              </div>
            </fieldset>
            <div className="grid gap-2">
              <CheckboxField name="confirmBroadening" label="Confirm broadening and rotate token" />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" disabled={Boolean(profileAction)}>
                {profileAction?.kind === "policy" ? "Updating..." : "Update policy"}
              </Button>
            </div>
          </form>
        )}
      </Panel>

      <section className="grid gap-3" aria-labelledby="profile-events-title">
        <h2 id="profile-events-title" className="text-xl font-semibold tracking-tight text-foreground">
          Profile events
        </h2>
        <ActivityAuditPanel activity={activity} />
      </section>
    </div>
  );
}

function Metadata({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function CheckboxField({
  name,
  label,
  defaultChecked = false,
  checked,
  disabled = false,
  help,
  onCheckedChange
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  checked?: boolean;
  disabled?: boolean;
  help?: string;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const id = `${name}-${useId()}`;

  return (
    <div className={cn(checkboxLabelClass, disabled && "opacity-70")}>
      <Checkbox
        id={id}
        name={name}
        defaultChecked={checked === undefined ? defaultChecked : undefined}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange?.(value === true)}
      />
      <div className="grid gap-1">
        <Label htmlFor={id} className={cn("leading-5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          {label}
        </Label>
        {help ? <span className={helperClass}>{help}</span> : null}
      </div>
    </div>
  );
}

function NumberField({ name, label, help }: { name: string; label: string; help?: string }) {
  const id = `${name}-${useId()}`;
  return (
    <div className={fieldClass}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type="number" min={1} max={3650} placeholder="e.g. 30" />
      {help ? <span className={helperClass}>{help}</span> : null}
    </div>
  );
}

function SelectField({
  name,
  label,
  defaultValue,
  value,
  onValueChange,
  options,
  help
}: {
  name: string;
  label: string;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  help?: string;
}) {
  const id = `${name}-${useId()}`;

  return (
    <div className={fieldClass}>
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} defaultValue={value === undefined ? (defaultValue ?? "") : undefined} value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help ? <span className={helperClass}>{help}</span> : null}
    </div>
  );
}

function toSummary(
  profile: TokenProfileSummary & {
    capabilityMap?: { executionIdentity?: TokenProfileSummary["executionIdentity"]; actions?: TokenProfileCapabilitySelection };
  }
): TokenProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    intendedUse: profile.intendedUse,
    preset: profile.preset,
    executionIdentity: profile.executionIdentity ?? profile.capabilityMap?.executionIdentity ?? "automatic",
    expiresAt: profile.expiresAt,
    status: profile.status,
    createdAt: profile.createdAt,
    developerToken: profile.developerToken,
    globalPolicyStatus: profile.globalPolicyStatus,
    capabilities: profile.capabilities ?? capabilitySelectionFromPresetOrActions(profile.preset, profile.capabilityMap?.actions)
  };
}

function capabilitiesForProfile(profile: TokenProfileSummary): TokenProfileCapabilitySelection {
  return profile.capabilities ?? capabilitySelectionFromPresetOrActions(profile.preset);
}

function capabilitySelectionFromPresetOrActions(
  preset: TokenProfileSummary["preset"],
  actions?: TokenProfileCapabilitySelection
): TokenProfileCapabilitySelection {
  if (actions) return { ...actions };
  if (preset === "custom") return { ...defaultTokenProfilePolicyOptions.capabilities.defaults };
  return capabilityTemplateForPreset(preset);
}

function capabilitySummary(capabilities: TokenProfileCapabilitySelection): string {
  const labels = capabilityOptions.filter((option) => capabilities[option.key]).map((option) => option.label);
  return labels.length > 0 ? labels.join(", ") : "No Slack capabilities";
}

function capabilityFieldSuffix(key: keyof TokenProfileCapabilitySelection): string {
  if (key === "writeMessages") return "WriteMessages";
  if (key === "filesMetadata") return "FilesMetadata";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function profileActionStatus(action: ProfileAction | null): string | null {
  if (!action) return null;
  if (action.kind === "rotate") return "Rotating Token profile developer token.";
  if (action.kind === "policy") return "Updating Token profile policy.";
  if (action.kind === "delete") return "Deleting Token profile permanently.";
  return "Removing Token profile access.";
}

function presetLabel(preset: TokenProfileSummary["preset"]): string {
  if (preset === "read_only") return "Read-only";
  if (preset === "messages_only") return "Messages only";
  if (preset === "full_slack_bridge") return "Full Slack bridge";
  return "Custom";
}

function developerTokenStatusLabel(status: NonNullable<TokenProfileSummary["developerToken"]>["status"] | undefined): string {
  if (status === "expired") return "Expired";
  if (status === "revoked") return "Revoked";
  if (status === "missing") return "Missing";
  return "Active";
}

function executionIdentityHelp(policyOptions: TokenProfilePolicyOptions, current: TokenProfileSummary["executionIdentity"]): string {
  const allowedLabels = policyOptions.executionIdentities.allowed.map(executionIdentityLabel);
  const allowed = joinLabels(allowedLabels);
  if (!policyOptions.executionIdentities.allowed.includes(current)) {
    return `Current execution identity is outside the Global Token profile policy. Choose ${allowed} to narrow it.`;
  }
  return `Global policy allows ${allowed}.`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function developerTokenStatusTone(status: NonNullable<TokenProfileSummary["developerToken"]>["status"] | undefined): "success" | "warning" | "neutral" {
  if (status === "active" || status === undefined) return "success";
  if (status === "missing") return "warning";
  return "neutral";
}

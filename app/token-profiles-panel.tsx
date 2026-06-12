"use client";

import { FormEvent, useId, useState } from "react";
import Link from "next/link";

import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { buildCreateTokenProfileModalRequestBody } from "./token-profile-form";
import {
  capabilityTemplateForPreset,
  defaultTokenProfilePolicyOptions,
  executionIdentityLabel,
  executionIdentitySelectOptions,
  presetAvailability,
  type TokenProfileCapabilitySelection,
  type TokenProfileExecutionIdentity,
  type TokenProfilePolicyOptions,
  type TokenProfilePolicyPreset
} from "./token-profile-policy-options";
import type { TokenProfileSummary } from "./token-profile-summary";
import { accessStatusForProfile, hasUsableDeveloperToken, isInactiveTokenProfile, managerTokenProfiles } from "./token-profile-workspace";
import { copyTextToClipboard } from "./client-clipboard";
import { Button, Notice, Panel, StatusBadge, cn } from "./ui";

type ProfileAction = { profileId: string; kind: "revoke" | "delete" };

const fieldClass = "grid gap-2 text-sm font-medium text-foreground";
const helperClass = "text-xs leading-5 text-muted-foreground";
const choiceClass =
  "flex min-h-20 gap-3 rounded-xl bg-muted/35 p-4 text-sm transition-colors hover:bg-muted/55";
const checkboxLabelClass =
  "flex min-h-11 items-start gap-3 rounded-lg bg-muted/35 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/55";
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

export function TokenProfilesPanel({
  initialProfiles,
  slackStatus,
  policyOptions = defaultTokenProfilePolicyOptions
}: {
  initialProfiles: TokenProfileSummary[];
  slackStatus: "healthy" | "reauth_required";
  policyOptions?: TokenProfilePolicyOptions;
}) {
  const [profiles, setProfiles] = useState(initialProfiles);
  const initialCreatePreset = policyOptions.presets.default;
  const [createPreset, setCreatePreset] = useState<TokenProfilePolicyPreset>(initialCreatePreset);
  const [createCapabilities, setCreateCapabilities] = useState<TokenProfileCapabilitySelection>(() => initialCapabilitiesForPreset(initialCreatePreset, policyOptions));
  const [createExecutionIdentity, setCreateExecutionIdentity] = useState<TokenProfileExecutionIdentity>(policyOptions.executionIdentities.default);
  const [developerToken, setDeveloperToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [removeProfileId, setRemoveProfileId] = useState<string | null>(null);
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [profileAction, setProfileAction] = useState<ProfileAction | null>(null);
  const actionStatus = profileActionStatus(profileAction);
  const managerProfiles = managerTokenProfiles(profiles);
  const activeAccessCount = profiles.filter(hasUsableDeveloperToken).length;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
    const form = new FormData(event.currentTarget);

    const response = await fetch("/v1/prism/token-profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildCreateTokenProfileModalRequestBody(form))
    });
    const body = await response.json();
    setSubmitting(false);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not create Token profile.");
      return;
    }
    setDeveloperToken(body.developerToken);
    setTokenCopied(false);
    setProfiles((current) => [toSummary(body.profile), ...current]);
  }

  function resetCreatePolicy() {
    const nextPreset = policyOptions.presets.default;
    setCreatePreset(nextPreset);
    setCreateCapabilities(initialCapabilitiesForPreset(nextPreset, policyOptions));
    setCreateExecutionIdentity(policyOptions.executionIdentities.default);
  }

  function onCreatePresetChange(value: string) {
    const nextPreset = value as TokenProfilePolicyPreset;
    setCreatePreset(nextPreset);
    setCreateCapabilities(initialCapabilitiesForPreset(nextPreset, policyOptions));
  }

  function onCreateCapabilityChange(key: keyof TokenProfileCapabilitySelection, checked: boolean) {
    const customAllowed = policyOptions.presets.allowed.includes("custom");
    if (!(key === "destructive" && createPreset === "full_slack_bridge") && !customAllowed) return;
    setCreateCapabilities((current) => ({ ...current, [key]: checked }));
    if (!(key === "destructive" && createPreset === "full_slack_bridge")) {
      setCreatePreset("custom");
    }
  }

  async function onRevoke(profile: TokenProfileSummary) {
    setProfileAction({ profileId: profile.id, kind: "revoke" });
    setError(null);
    setDeveloperToken(null);
    setTokenCopied(false);
    const response = await fetch(`/v1/prism/token-profiles/${encodeURIComponent(profile.id)}/revoke`, { method: "POST" });
    const body = await response.json();
    setProfileAction(null);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not revoke Token profile.");
      return;
    }
    setProfiles((current) => current.map((candidate) => (candidate.id === profile.id ? toSummary(body.profile) : candidate)));
    setRemoveProfileId(null);
  }

  async function onDelete(profile: TokenProfileSummary) {
    setProfileAction({ profileId: profile.id, kind: "delete" });
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
    setProfiles((current) => current.filter((candidate) => candidate.id !== profile.id));
    setDeleteProfileId(null);
  }

  async function copyDeveloperToken() {
    if (!developerToken) return;
    try {
      await copyTextToClipboard(developerToken);
      setTokenCopied(true);
      setError(null);
    } catch {
      setError("Could not copy automatically. Select the token and copy it before closing.");
    }
  }

  return (
    <>
    <Panel
      title="Token profiles"
      titleId="token-profiles-title"
      eyebrow="Active access"
      accent="primary"
      badge={<StatusBadge tone="neutral">{activeAccessCount} active</StatusBadge>}
    >
      {slackStatus === "reauth_required" ? (
        <Notice title="Slack reauth required" tone="warning">
          Slack reauth is required before these profiles can be used for Slack calls, but profile management is preserved.
        </Notice>
      ) : null}
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            Add the local tools that should call Slack through Prism. Open a profile to configure policy, rotate tokens, and review events.
          </p>
          <Button type="button" onClick={() => setCreateOpen(true)}>
            Create Token profile
          </Button>
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              if (!open && developerToken && !tokenCopied) {
                setError("Confirm that you copied this token before closing. Prism cannot show it again.");
                return;
              }
              setCreateOpen(open);
              if (open) {
                setError(null);
                setDeveloperToken(null);
                setTokenCopied(false);
                resetCreatePolicy();
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Token profile</DialogTitle>
                <DialogDescription>
                  Name the local tool, choose a starter policy, then copy the Prism developer token once.
                </DialogDescription>
              </DialogHeader>
              {developerToken ? (
                <div className="grid gap-4">
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
                  {error ? (
                    <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="secondary" disabled={!tokenCopied}>
                        Done
                      </Button>
                    </DialogClose>
                  </DialogFooter>
                </div>
              ) : (
                <form className="grid gap-4" onSubmit={onSubmit}>
                  <label className={fieldClass}>
                    Profile name
                    <Input name="name" required maxLength={80} placeholder="Local MCP read" />
                    <span className={helperClass}>Use the local tool, agent, or workflow name.</span>
                  </label>
                  <label className={fieldClass}>
                    Intended use
                    <Textarea name="intendedUse" required maxLength={180} placeholder="Read Slack context from my local MCP server" />
                    <span className={helperClass}>Shown in profile details so future reviews know why access exists.</span>
                  </label>
                  <fieldset className="grid gap-3">
                    <legend className="text-sm font-semibold text-foreground">Access preset</legend>
                    <RadioGroup name="preset" value={createPreset} onValueChange={onCreatePresetChange} className="grid gap-3">
                      <PresetChoice
                        id="create-preset-read-only"
                        value="read_only"
                        label="Read-only"
                        description="Recommended for MCP readers and context tools."
                        availability={presetAvailability("read_only", policyOptions)}
                      />
                      <PresetChoice
                        id="create-preset-messages-only"
                        value="messages_only"
                        label="Messages only"
                        description="Read context, post messages, and manage reactions."
                        availability={presetAvailability("messages_only", policyOptions)}
                      />
                      <PresetChoice
                        id="create-preset-full-bridge"
                        value="full_slack_bridge"
                        label="Full Slack bridge"
                        description="Representative bridge surface, destructive methods still off."
                        availability={presetAvailability("full_slack_bridge", policyOptions)}
                      />
                      <PresetChoice
                        id="create-preset-custom"
                        value="custom"
                        label="Custom"
                        description="Start from the default template and tune individual capabilities."
                        availability={presetAvailability("custom", policyOptions)}
                      />
                    </RadioGroup>
                  </fieldset>
                  <fieldset className="grid gap-3 rounded-xl bg-muted/30 p-4">
                    <legend className="px-1 text-sm font-semibold text-foreground">Capability template</legend>
                    <p className={helperClass}>
                      Current capabilities: {capabilitySummary(createCapabilities)}. Selecting a preset applies its template; manual capability changes switch this profile to Custom.
                    </p>
                    {!policyOptions.presets.allowed.includes("custom") ? (
                      <p className={helperClass}>Global policy requires named presets, so manual capability edits are disabled.</p>
                    ) : null}
                    <div className="grid gap-2 sm:grid-cols-2" aria-label="Create Token profile capability options">
                      {capabilityOptions.map((option) => {
                        const allowed = policyOptions.capabilities.maximum[option.key];
                        const checked = createCapabilities[option.key];
                        const canToggle = allowed && (policyOptions.presets.allowed.includes("custom") || (option.key === "destructive" && createPreset === "full_slack_bridge"));
                        const helpText = !allowed 
                          ? `Global policy blocks adding ${option.label}.`
                          : option.description;
                        return (
                          <CapabilityCheckboxField
                            key={option.key}
                            name={option.key === "destructive" ? "destructive" : `custom${capabilityFieldSuffix(option.key)}`}
                            label={option.label}
                            checked={checked}
                            disabled={!canToggle}
                            help={helpText}
                            onCheckedChange={(nextChecked) => onCreateCapabilityChange(option.key, nextChecked)}
                          />
                        );
                      })}
                    </div>
                  </fieldset>
                  <SelectField
                    name="executionIdentity"
                    label="Execution identity"
                    value={createExecutionIdentity}
                    onValueChange={(value) => setCreateExecutionIdentity(value as TokenProfileExecutionIdentity)}
                    options={executionIdentitySelectOptions(policyOptions)}
                    help={`Global policy default: ${executionIdentityLabel(policyOptions.executionIdentities.default)}.`}
                  />
                  <Notice title="Safe defaults" tone="info">
                    Prism starts with {executionIdentityLabel(createExecutionIdentity)} execution identity and no experiment expiry. Configure advanced policy after creation.
                  </Notice>
                  {error ? (
                    <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
                      {error} Check the fields and try again.
                    </p>
                  ) : null}
                  <DialogFooter>
                    <DialogClose asChild>
                      <Button type="button" variant="secondary">
                        Cancel
                      </Button>
                    </DialogClose>
                    <Button type="submit" disabled={submitting}>
                      {submitting ? "Creating..." : "Create and show token once"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
        {managerProfiles.length === 0 ? (
          <div className="rounded-2xl bg-muted/25 p-5">
            <h3 className="text-base font-semibold text-foreground">No Token profiles yet.</h3>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">
              Create one profile for each local tool that should call Slack through Prism.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-2xl border border-border bg-background/70" aria-label="Token profiles">
            {managerProfiles.map((profile) => {
              const accessStatus = accessStatusForProfile(profile, slackStatus);
              const removing = isProfileAction(profileAction, profile.id, "revoke");
              const deleting = isProfileAction(profileAction, profile.id, "delete");
              const inactive = isInactiveTokenProfile(profile);
              return (
                <article key={profile.id} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Link
                    href={`/token-profiles/${encodeURIComponent(profile.id)}`}
                    className="grid min-h-11 gap-1 rounded-xl px-2 py-2 text-foreground no-underline transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    aria-label={`Open Token profile ${profile.name}`}
                  >
                    <span className="font-semibold [overflow-wrap:anywhere]">{profile.name}</span>
                    <span className="text-xs text-muted-foreground">Open details, policy, lifecycle, and events</span>
                  </Link>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <StatusBadge tone={accessStatus.tone}>{accessStatus.label}</StatusBadge>
                    {profile.globalPolicyStatus?.kind === "outside" ? <StatusBadge tone="warning">Outside global policy</StatusBadge> : null}
                    {inactive ? null : (
                      <>
                        <Button type="button" variant="danger" onClick={() => setRemoveProfileId(profile.id)}>
                          Remove access
                        </Button>
                        <Dialog open={removeProfileId === profile.id} onOpenChange={(open) => setRemoveProfileId(open ? profile.id : null)}>
                          <DialogContent className="max-w-md">
                            <DialogHeader>
                              <DialogTitle>Remove access?</DialogTitle>
                              <DialogDescription>
                                This revokes the current Prism developer token for {profile.name}. Metadata-only audit is preserved.
                              </DialogDescription>
                            </DialogHeader>
                            {error ? (
                              <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
                                {error}
                              </p>
                            ) : null}
                            <DialogFooter>
                              <DialogClose asChild>
                                <Button type="button" variant="secondary">
                                  Cancel
                                </Button>
                              </DialogClose>
                              <Button type="button" variant="danger" disabled={removing} onClick={() => onRevoke(profile)}>
                                {removing ? "Removing..." : "Remove access"}
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </>
                    )}
                    {inactive ? (
                      <>
                        <Button type="button" variant="danger" onClick={() => setDeleteProfileId(profile.id)}>
                          Delete permanently
                        </Button>
                        <Dialog open={deleteProfileId === profile.id} onOpenChange={(open) => setDeleteProfileId(open ? profile.id : null)}>
                          <DialogContent className="max-w-md">
                            <DialogHeader>
                              <DialogTitle>Delete {profile.name} permanently?</DialogTitle>
                              <DialogDescription>
                                This removes {profile.name} and its developer-token verifiers. Metadata-only audit events may remain until audit retention expires.
                              </DialogDescription>
                            </DialogHeader>
                            {error ? (
                              <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
                                {error}
                              </p>
                            ) : null}
                            <DialogFooter>
                              <DialogClose asChild>
                                <Button type="button" variant="secondary">
                                  Cancel
                                </Button>
                              </DialogClose>
                              <Button type="button" variant="danger" disabled={deleting} onClick={() => onDelete(profile)}>
                                {deleting ? "Deleting..." : "Delete permanently"}
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      </>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {error ? (
        <p className={cn("rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive", (createOpen || removeProfileId || deleteProfileId) && "sr-only")} role="alert">
          {error} Check the fields and try again.
        </p>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {actionStatus ?? ""}
      </p>
    </Panel>
    </>
  );
}

function PresetChoice({
  id,
  value,
  label,
  description,
  availability
}: {
  id: string;
  value: string;
  label: string;
  description: string;
  availability: { allowed: true; reason: null } | { allowed: false; reason: string };
}) {
  return (
    <div className={cn(choiceClass, !availability.allowed && "opacity-70")}>
      <RadioGroupItem id={id} value={value} className="mt-1" disabled={!availability.allowed} />
      <Label htmlFor={id} className={cn("grid gap-1 leading-6", availability.allowed ? "cursor-pointer" : "cursor-not-allowed")}>
        <span className="font-semibold text-foreground">{label}</span>
        <span className="font-normal text-muted-foreground">{description}</span>
        {!availability.allowed ? <span className={helperClass}>{availability.reason}</span> : null}
      </Label>
    </div>
  );
}

function CapabilityCheckboxField({
  name,
  label,
  checked,
  disabled,
  help,
  onCheckedChange
}: {
  name: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  help?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className={cn(checkboxLabelClass, disabled && "opacity-70")}>
      <Checkbox id={`create-${name}`} name={name} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <div className="grid gap-1">
        <Label htmlFor={`create-${name}`} className={cn("leading-5", disabled ? "cursor-not-allowed" : "cursor-pointer")}>
          {label}
        </Label>
        {help ? <span className={helperClass}>{help}</span> : null}
      </div>
    </div>
  );
}

function SelectField({
  name,
  label,
  value,
  onValueChange,
  options,
  help
}: {
  name: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  help?: string;
}) {
  const id = `${name}-${useId()}`;

  return (
    <div className={fieldClass}>
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} value={value} onValueChange={onValueChange}>
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

function initialCapabilitiesForPreset(preset: TokenProfilePolicyPreset, policyOptions: TokenProfilePolicyOptions): TokenProfileCapabilitySelection {
  if (preset === "custom") return { ...policyOptions.capabilities.defaults };
  return capabilityTemplateForPreset(preset);
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

function isProfileAction(action: ProfileAction | null, profileId: string, kind: ProfileAction["kind"]): boolean {
  return action?.profileId === profileId && action.kind === kind;
}

function profileActionStatus(action: ProfileAction | null): string | null {
  if (!action) return null;
  if (action.kind === "delete") return "Deleting Token profile permanently.";
  return "Revoking Token profile developer token.";
}

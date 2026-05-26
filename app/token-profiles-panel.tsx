"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import { buildCreateTokenProfileModalRequestBody } from "./token-profile-form";
import type { TokenProfileSummary } from "./token-profile-summary";
import { accessStatusForProfile, hasUsableDeveloperToken, isInactiveTokenProfile, managerTokenProfiles } from "./token-profile-workspace";
import { copyTextToClipboard } from "./client-clipboard";
import { Button, Notice, Panel, StatusBadge, cn } from "./ui";

type ProfileAction = { profileId: string; kind: "revoke" | "delete" };

const fieldClass = "grid gap-2 text-sm font-medium text-foreground";
const helperClass = "text-xs leading-5 text-muted-foreground";
const choiceClass =
  "flex min-h-20 gap-3 rounded-xl bg-muted/35 p-4 text-sm transition-colors hover:bg-muted/55";

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
                    <RadioGroup name="preset" defaultValue="read_only" className="grid gap-3">
                      <PresetChoice id="create-preset-read-only" value="read_only" label="Read-only" description="Recommended for MCP readers and context tools." />
                      <PresetChoice id="create-preset-messages-only" value="messages_only" label="Messages only" description="Read context, post messages, and manage reactions." />
                      <PresetChoice id="create-preset-full-bridge" value="full_slack_bridge" label="Full Slack bridge" description="Representative bridge surface, destructive methods still off." />
                    </RadioGroup>
                  </fieldset>
                  <Notice title="Safe defaults" tone="info">
                    Prism uses automatic execution identity and no experiment expiry. Configure advanced policy after creation.
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

function toSummary(profile: TokenProfileSummary & { capabilityMap?: { executionIdentity?: TokenProfileSummary["executionIdentity"] } }): TokenProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    intendedUse: profile.intendedUse,
    preset: profile.preset,
    executionIdentity: profile.executionIdentity ?? profile.capabilityMap?.executionIdentity ?? "automatic",
    expiresAt: profile.expiresAt,
    status: profile.status,
    createdAt: profile.createdAt,
    developerToken: profile.developerToken
  };
}

function isProfileAction(action: ProfileAction | null, profileId: string, kind: ProfileAction["kind"]): boolean {
  return action?.profileId === profileId && action.kind === kind;
}

function profileActionStatus(action: ProfileAction | null): string | null {
  if (!action) return null;
  if (action.kind === "delete") return "Deleting Token profile permanently.";
  return "Revoking Token profile developer token.";
}

"use client";

import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type { TokenProfileSummary } from "../../token-profile-summary";
import { Button, Notice } from "../../ui";

type AdminTokenProfileAction = "revoke" | "delete";

type AdminTokenProfileActionFormProps = {
  action: AdminTokenProfileAction;
  expectedConfirmation: "REVOKE" | "DELETE";
  reason: string;
  confirmation: string;
  submitting?: boolean;
  error?: string | null;
  cancelControl?: ReactNode;
  onReasonChange?: (value: string) => void;
  onConfirmationChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

export function AdminTokenProfileActions({ userId, profile }: { userId: string; profile: TokenProfileSummary }) {
  const actions = useMemo(() => availableActions(profile), [profile]);
  if (actions.length === 0) return null;
  return (
    <div className="mt-3 grid gap-2 rounded-xl border border-border bg-background/70 p-3">
      <p className="text-xs leading-5 text-muted-foreground">Admin actions require typed confirmation and a required reason. The target user's metadata audit will show the admin actor and reason.</p>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <AdminTokenProfileActionDialog key={action} action={action} userId={userId} profile={profile} />
        ))}
      </div>
    </div>
  );
}

function AdminTokenProfileActionDialog({ action, userId, profile }: { action: AdminTokenProfileAction; userId: string; profile: TokenProfileSummary }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expectedConfirmation = action === "revoke" ? "REVOKE" : "DELETE";
  const canSubmit = confirmation === expectedConfirmation && reason.trim().length > 0 && reason.trim().length <= 240 && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(actionUrl(action, userId, profile.id), {
        method: action === "revoke" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation, reason })
      });
      let body: { error?: string; message?: string } = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) {
        setError(actionErrorMessage(body));
        return;
      }
      setConfirmation("");
      setReason("");
      setOpen(false);
      window.location.reload();
    } catch {
      setError("Could not reach Prism. Keep this dialog open and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={action === "delete" ? "danger" : "secondary"}>
          {action === "delete" ? "Delete profile" : "Revoke access"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === "delete" ? "Delete this Token profile?" : "Revoke this Token profile?"}</DialogTitle>
          <DialogDescription>
            This scoped admin action affects {profile.name}. Prism records a metadata-only admin audit event for the target user.
          </DialogDescription>
        </DialogHeader>
        <AdminTokenProfileActionForm
          action={action}
          expectedConfirmation={expectedConfirmation}
          reason={reason}
          confirmation={confirmation}
          submitting={submitting}
          error={error}
          onReasonChange={setReason}
          onConfirmationChange={setConfirmation}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AdminTokenProfileActionForm({
  action,
  expectedConfirmation,
  reason,
  confirmation,
  submitting = false,
  error = null,
  cancelControl,
  onReasonChange,
  onConfirmationChange,
  onSubmit
}: AdminTokenProfileActionFormProps) {
  const confirmId = useId();
  const reasonId = useId();
  const canSubmit = confirmation === expectedConfirmation && reason.trim().length > 0 && reason.trim().length <= 240 && !submitting;
  return (
    <>
      <Notice title="Required admin audit reason" tone="warning">
        Enter a concise reason. Do not paste Slack content, tokens, or secrets.
      </Notice>
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>Reason</Label>
          <Textarea id={reasonId} value={reason} onChange={(event) => onReasonChange?.(event.currentTarget.value)} maxLength={240} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={confirmId}>Type {expectedConfirmation} to continue</Label>
          <Input id={confirmId} value={confirmation} onChange={(event) => onConfirmationChange?.(event.currentTarget.value)} autoComplete="off" />
        </div>
        {error ? (
          <p className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {cancelControl ?? (
            <DialogClose asChild>
              <Button type="button" variant="quiet" disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
          )}
          <Button type="submit" variant={action === "delete" ? "danger" : "primary"} disabled={!canSubmit}>
            {submitting ? "Working..." : action === "delete" ? "Delete Token profile" : "Revoke Token profile"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function availableActions(profile: TokenProfileSummary): AdminTokenProfileAction[] {
  const actions: AdminTokenProfileAction[] = [];
  if (profile.status !== "revoked") actions.push("revoke");
  if (profile.status === "revoked" || profile.developerToken?.status !== "active") actions.push("delete");
  return actions;
}

function actionUrl(action: AdminTokenProfileAction, userId: string, profileId: string): string {
  const base = `/v1/prism/admin/users/${encodeURIComponent(userId)}/token-profiles/${encodeURIComponent(profileId)}`;
  return action === "revoke" ? `${base}/revoke` : base;
}

function actionErrorMessage(body: { error?: string; message?: string }): string {
  if (body.error === "validation_error" && body.message) return body.message;
  if (body.error === "unauthorized") return "Your Prism session expired. Reconnect Slack before taking admin action.";
  if (body.error === "forbidden") return "Your admin scope cannot change this Token profile.";
  if (body.error === "not_found") return "This Token profile is no longer visible in your admin scope.";
  if (body.error === "active_profile_requires_revoke") return "Revoke access before deleting an active Token profile.";
  if (body.error === "audit_unavailable") return "Prism could not record the required admin audit event, so no change was made.";
  return "Could not complete the admin action.";
}

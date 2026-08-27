"use client";

import { type FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button, Notice, StatusBadge } from "../../ui";

export function AdminGlobalAdminActions({
  userId,
  userLabel,
  active,
  source,
  isCurrentActor,
  isLastAdmin
}: {
  userId: string;
  userLabel: string;
  active: boolean;
  source: "initial_bootstrap" | "setup_recovery" | "admin_grant" | null;
  isCurrentActor: boolean;
  isLastAdmin: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const blockedReason = isCurrentActor
    ? "You cannot remove your own administrator access."
    : isLastAdmin
      ? "Prism must always retain at least one global administrator."
      : null;

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-background/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Prism application access</h3>
            <StatusBadge tone={active ? "success" : "neutral"}>{active ? "Global administrator" : "Standard user"}</StatusBadge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {active ? `Full Prism administration${source ? ` · ${sourceLabel(source)}` : ""}.` : "No persisted Prism administrator role."}
          </p>
        </div>
        {active ? (
          <AdminRoleDialog action="revoke" userId={userId} userLabel={userLabel} disabledReason={blockedReason} onComplete={setMessage} />
        ) : (
          <AdminRoleDialog action="grant" userId={userId} userLabel={userLabel} disabledReason={null} onComplete={setMessage} />
        )}
      </div>
      {blockedReason ? <p className="text-xs font-medium text-muted-foreground">{blockedReason}</p> : null}
      {message ? <p className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm" role="status">{message}</p> : null}
    </div>
  );
}

function AdminRoleDialog({
  action, userId, userLabel, disabledReason, onComplete
}: {
  action: "grant" | "revoke";
  userId: string;
  userLabel: string;
  disabledReason: string | null;
  onComplete: (message: string | null) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = action === "grant" ? "GRANT" : "REMOVE";
  const canSubmit = !disabledReason && confirmation === expected && reason.trim().length > 0 && reason.trim().length <= 240 && !submitting;
  const reasonId = useId();
  const confirmationId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    onComplete(null);
    try {
      const response = await fetch(`/v1/prism/admin/users/${encodeURIComponent(userId)}/global-admin`, {
        method: action === "grant" ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmation })
      });
      const body = await safeJson(response);
      if (!response.ok) {
        setError(actionErrorMessage(body));
        return;
      }
      setOpen(false);
      setReason("");
      setConfirmation("");
      onComplete(action === "grant" ? `${userLabel} is now a global Prism administrator.` : `${userLabel} is no longer a global Prism administrator.`);
      router.refresh();
    } catch {
      setError("Could not reach Prism. Keep this dialog open and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant={action === "revoke" ? "danger" : "primary"} disabled={Boolean(disabledReason)} title={disabledReason ?? undefined}>
          {action === "grant" ? "Make administrator" : "Remove administrator"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === "grant" ? "Grant global Prism administration?" : "Remove global Prism administration?"}</DialogTitle>
          <DialogDescription>This changes application-wide access for {userLabel}. Prism records the acting administrator and reason.</DialogDescription>
        </DialogHeader>
        <Notice title="Required administrator audit reason" tone="warning">Enter a concise reason without tokens, secrets, or Slack content.</Notice>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2"><Label htmlFor={reasonId}>Reason</Label><Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.currentTarget.value)} maxLength={240} required /></div>
          <div className="grid gap-2"><Label htmlFor={confirmationId}>Type {expected} to continue</Label><Input id={confirmationId} value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" /></div>
          {error ? <p className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="quiet" disabled={submitting}>Cancel</Button></DialogClose>
            <Button type="submit" variant={action === "revoke" ? "danger" : "primary"} disabled={!canSubmit}>{submitting ? "Working..." : action === "grant" ? "Grant administrator" : "Remove administrator"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function safeJson(response: Response): Promise<{ error?: string; message?: string; status?: string }> {
  try { return await response.json(); } catch { return {}; }
}

function actionErrorMessage(body: { error?: string; message?: string }): string {
  if (body.error === "validation_error" && body.message) return body.message;
  if (body.error === "unauthorized") return "Your Prism session expired. Reconnect Slack and try again.";
  if (body.error === "forbidden") return "Only a global Prism administrator can change this role.";
  if (body.error === "self_demotion_forbidden") return "You cannot remove your own administrator access.";
  if (body.error === "last_admin_forbidden") return "Prism must always retain at least one global administrator.";
  if (body.error === "not_found") return "This Prism user is no longer available.";
  if (body.error === "audit_unavailable") return "Prism could not record the required audit event, so no change was made.";
  return "Could not change this Prism administrator role.";
}

function sourceLabel(source: "initial_bootstrap" | "setup_recovery" | "admin_grant"): string {
  if (source === "initial_bootstrap") return "initial setup";
  if (source === "setup_recovery") return "setup recovery";
  return "granted by an administrator";
}

"use client";

import { type FormEvent, type ReactNode, useId, useState } from "react";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Button, Notice } from "../../ui";

type AdminSlackConnectionActionFormProps = {
  reason: string;
  confirmation: string;
  submitting?: boolean;
  error?: string | null;
  cancelControl?: ReactNode;
  onReasonChange?: (value: string) => void;
  onConfirmationChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
};

export function AdminSlackConnectionActions({ userId, slackUserLabel }: { userId: string; slackUserLabel: string }) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = confirmation === "REMOVE" && reason.trim().length > 0 && reason.trim().length <= 240 && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/v1/prism/admin/users/${encodeURIComponent(userId)}/slack-connection`, {
        method: "DELETE",
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
    <div className="grid gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3">
      <Notice title="Prism-local Slack connection removal" tone="warning">
        This removes Prism's local Slack connection for {slackUserLabel}. It does not revoke Slack authorization, uninstall the Slack app, or call Slack admin/Web APIs.
      </Notice>
      <div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="danger">
              Remove Slack connection
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove this Slack connection?</DialogTitle>
              <DialogDescription>
                Prism will delete its local connection and cascading local credentials, Token profiles, developer tokens, and forwarding rate limits. Slack itself is not called.
              </DialogDescription>
            </DialogHeader>
            <AdminSlackConnectionActionForm
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
      </div>
    </div>
  );
}

export function AdminSlackConnectionActionForm({
  reason,
  confirmation,
  submitting = false,
  error = null,
  cancelControl,
  onReasonChange,
  onConfirmationChange,
  onSubmit
}: AdminSlackConnectionActionFormProps) {
  const confirmId = useId();
  const reasonId = useId();
  const canSubmit = confirmation === "REMOVE" && reason.trim().length > 0 && reason.trim().length <= 240 && !submitting;
  return (
    <>
      <Notice title="Required admin audit reason" tone="warning">
        Enter a concise reason. Do not paste Slack content, tokens, or secrets. Type REMOVE to confirm this Prism-local action.
      </Notice>
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-2">
          <Label htmlFor={reasonId}>Reason</Label>
          <Textarea id={reasonId} value={reason} onChange={(event) => onReasonChange?.(event.currentTarget.value)} maxLength={240} required />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={confirmId}>Type REMOVE to continue</Label>
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
          <Button type="submit" variant="danger" disabled={!canSubmit}>
            {submitting ? "Working..." : "Remove Slack connection"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function actionErrorMessage(body: { error?: string; message?: string }): string {
  if (body.error === "validation_error" && body.message) return body.message;
  if (body.error === "unauthorized") return "Your Prism session expired. Reconnect Slack before taking admin action.";
  if (body.error === "forbidden") return "Your admin scope cannot remove this Slack connection.";
  if (body.error === "not_found") return "This Slack connection is already disconnected or no longer visible in your admin scope.";
  if (body.error === "audit_unavailable") return "Prism could not record the required admin audit event, so no change was made.";
  return "Could not complete the admin action.";
}

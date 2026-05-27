"use client";

import { FormEvent, useId, useState } from "react";
import { useRouter } from "next/navigation";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Button, LinkButton, Notice, cn } from "./ui";

export function SlackConnectionActions({
  reauthRequired = false,
  className,
  compact = false
}: {
  reauthRequired?: boolean;
  className?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const confirmId = useId();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRemove = confirmText === "REMOVE" && !removing;

  async function onRemove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRemove) return;
    setRemoving(true);
    setError(null);
    try {
      const response = await fetch("/v1/prism/slack-connection", { method: "DELETE" });
      let body: { error?: string } = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      if (!response.ok) {
        setError(removalErrorMessage(body.error));
        return;
      }
      setConfirmText("");
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach Prism. Keep this dialog open and try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className={cn(compact ? "mt-4 grid gap-3" : "grid gap-3", className)}>
      <div className="flex flex-wrap gap-2">
        <LinkButton href="/v1/slack/oauth/start" variant={reauthRequired ? "primary" : "secondary"}>
          {reauthRequired ? "Reconnect Slack" : "Change Slack authorization"}
        </LinkButton>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="danger">
              Remove Slack connection
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove Slack connection?</DialogTitle>
              <DialogDescription>
                This removes the current Slack connection from Prism only. It does not uninstall Prism from Slack, revoke Slack tokens, or change Slack admin approval.
              </DialogDescription>
            </DialogHeader>
            <Notice title="Local Prism reset only" tone="warning">
              Token profiles and Prism developer tokens for this connection are deleted with it. Slack controls workspace and organization approval if you connect again.
            </Notice>
            <form className="grid gap-4" onSubmit={onRemove}>
              <div className="grid gap-2">
                <Label htmlFor={confirmId}>Type REMOVE to continue</Label>
                <Input id={confirmId} value={confirmText} onChange={(event) => setConfirmText(event.currentTarget.value)} autoComplete="off" />
              </div>
              {error ? (
                <p className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="quiet" disabled={removing}>
                    Keep connection
                  </Button>
                </DialogClose>
                <Button type="submit" variant="danger" disabled={!canRemove}>
                  {removing ? "Removing..." : "Remove local connection"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <p className="max-w-xl text-xs leading-5 text-muted-foreground">
        Slack controls workspace and organization approval. Removing this connection only resets Prism locally; it does not uninstall Prism from Slack.
      </p>
    </div>
  );
}

function removalErrorMessage(error: string | undefined): string {
  if (error === "unauthenticated") return "Your Prism session expired. Reconnect Slack before removing the connection.";
  if (error === "not_linked" || error === "not_found") return "This Slack connection is already removed.";
  if (error === "audit_unavailable") return "Prism could not record the metadata audit event, so the connection was not removed.";
  return "Could not remove the Slack connection.";
}

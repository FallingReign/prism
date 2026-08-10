"use client";

import { useEffect, useState } from "react";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import { copyTextToClipboard } from "./client-clipboard";
import { Button, Notice } from "./ui";

export function buildInstallPrompt(origin: string): string {
  const normalized = normalizeBrowserOrigin(origin);
  if (!normalized) {
    throw new Error("A browser origin is required.");
  }
  return `Go to ${normalized}/skills/install.md and follow the setup instructions.`;
}

function normalizeBrowserOrigin(origin: string): string | null {
  const value = origin.trim().replace(/\/+$/, "");
  if (!value || value === "null") return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function currentBrowserOrigin(): string | null {
  const directOrigin = normalizeBrowserOrigin(window.location.origin);
  if (directOrigin) return directOrigin;
  if (!["http:", "https:"].includes(window.location.protocol) || !window.location.host) {
    return null;
  }
  return normalizeBrowserOrigin(`${window.location.protocol}//${window.location.host}`);
}

export function SkillInstallCta() {
  const [origin, setOrigin] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(currentBrowserOrigin());
  }, []);

  const prompt = origin
    ? buildInstallPrompt(origin)
    : "Open Prism from an HTTP(S) browser URL to generate the agent setup prompt.";

  async function copyPrompt() {
    setError(null);
    setCopied(false);
    try {
      const currentOrigin = currentBrowserOrigin();
      if (!currentOrigin) throw new Error("A browser origin is required.");
      await copyTextToClipboard(buildInstallPrompt(currentOrigin));
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select the prompt and copy it.");
    }
  }

  async function handleInstallClick() {
    setOpen(true);
    await copyPrompt();
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent prompt</span>
        <code className="select-text break-all rounded-lg bg-muted/55 px-3 py-2 font-mono text-xs leading-5 text-foreground">{prompt}</code>
      </div>
      <Button type="button" variant="secondary" onClick={handleInstallClick}>
          Install Prism skill
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setCopied(false);
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install Prism skill</DialogTitle>
            <DialogDescription>
              Copy this prompt into your local agent. It points the agent to the instructions served by this Prism instance.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm font-medium text-foreground" htmlFor="prism-skill-install-prompt">
              Agent prompt
              <textarea
                id="prism-skill-install-prompt"
                className="min-h-24 w-full resize-y rounded-xl border border-border bg-muted/35 p-3 font-mono text-sm leading-6 text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                readOnly
                value={prompt}
                aria-label="Prism skill installation prompt"
              />
            </label>
            <p className="text-xs leading-5 text-muted-foreground">
              Origin: <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono">{origin ?? "current browser origin"}</code>
            </p>
            {copied ? <p className="text-sm font-medium text-[color:var(--prism-success-foreground)]" role="status" aria-live="polite">Prompt copied.</p> : null}
            {error ? <Notice title="Copy the prompt manually" tone="warning" role="alert">{error}</Notice> : null}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="quiet">Close</Button>
            </DialogClose>
            <Button type="button" onClick={copyPrompt}>Copy prompt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

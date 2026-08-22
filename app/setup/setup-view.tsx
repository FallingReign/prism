"use client";

import { FormEvent, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Button, LinkButton, Notice, Panel, StatusBadge } from "../ui";

export type SetupScopeOption = {
  id: string;
  label: string;
  description: string;
  tokenKind: "bot" | "user";
  required: boolean;
};

export type SetupPendingConfiguration = {
  clientId: string;
  secretStored: true;
  botScopes: string[];
  userScopes: string[];
  version: string;
};

export type SetupViewState =
  | { kind: "code_required"; error?: "invalid_or_expired" | "rate_limited" | "session_expired" }
  | { kind: "configure"; scopes: SetupScopeOption[]; selectedBotScopes: string[]; selectedUserScopes: string[]; pending: SetupPendingConfiguration | null; error?: "verification_unavailable" }
  | { kind: "environment_locked"; botScopes: string[]; userScopes: string[] }
  | { kind: "complete" };

export function SetupView({ state, callbackUri }: { state: SetupViewState; callbackUri: string }) {
  const step = state.kind === "code_required" ? 1 : state.kind === "configure" ? (state.pending ? 3 : 2) : 3;
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <SetupHeader />
      <SetupProgress activeStep={step} />
      {state.kind === "code_required" ? <CodeEntry callbackUri={callbackUri} error={state.error} /> : null}
      {state.kind === "configure" ? <SlackConfigurationForm callbackUri={callbackUri} initialState={state} /> : null}
      {state.kind === "environment_locked" ? <EnvironmentLocked callbackUri={callbackUri} botScopes={state.botScopes} userScopes={state.userScopes} /> : null}
      {state.kind === "complete" ? <SetupComplete /> : null}
    </main>
  );
}

function SetupHeader() {
  return (
    <header className="grid gap-3 rounded-3xl bg-card/85 p-5 shadow-sm ring-1 ring-foreground/5 backdrop-blur lg:p-6">
      <a className="inline-flex w-fit items-center gap-3 rounded-xl text-foreground no-underline" href="/">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground" aria-hidden="true">P</span>
        <span className="grid"><strong className="text-sm font-semibold">Prism setup</strong><span className="text-xs text-muted-foreground">Slack configuration</span></span>
      </a>
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Guided configuration</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Connect Prism to your existing Slack app</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">Prism encrypts the Slack client secret and never returns it to this page. Deployment URLs, database access, and the root encryption key remain host-managed.</p>
      </div>
    </header>
  );
}

function SetupProgress({ activeStep }: { activeStep: number }) {
  return (
    <ol className="grid gap-2 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 sm:grid-cols-3" aria-label="Setup progress">
      {["Unlock setup", "Configure Slack", "Verify connection"].map((label, index) => {
        const current = index + 1;
        const active = current === activeStep;
        return (
          <li key={label} className={`flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm ${active ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`} aria-current={active ? "step" : undefined}>
            <span className={`grid size-7 place-items-center rounded-full text-xs font-semibold ${current <= activeStep ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`} aria-hidden="true">{current < activeStep ? "✓" : current}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function CodeEntry({ callbackUri, error }: { callbackUri: string; error?: "invalid_or_expired" | "rate_limited" | "session_expired" }) {
  return (
    <Panel title="Enter your one-time setup code" titleId="setup-code-title" eyebrow="Step 1" accent="primary">
      <p>Run <code>npm run setup:bootstrap</code> on the Prism host. Paste the code printed once in that terminal.</p>
      <Notice title="Keep this code private" tone="warning">The code expires quickly and works once. It is sent only in this same-origin form; Prism never puts it in a URL or browser storage.</Notice>
      {error === "invalid_or_expired" ? <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">That setup code is invalid or expired. Mint a new code on the Prism host and try again.</p> : null}
      {error === "rate_limited" ? <p className="rounded-xl border border-[color:var(--prism-warning)]/60 bg-[color:var(--prism-warning-soft)] px-4 py-3 text-sm text-[color:var(--prism-warning-foreground)]" role="alert">Too many setup attempts were made. Wait a minute, then try again with your one-time code.</p> : null}
      {error === "session_expired" ? <p className="rounded-xl border border-[color:var(--prism-warning)]/60 bg-[color:var(--prism-warning-soft)] px-4 py-3 text-sm text-[color:var(--prism-warning-foreground)]" role="alert">Your setup session expired. Mint a new one-time code on the Prism host to continue.</p> : null}
      <form className="grid max-w-xl gap-4" action="/v1/prism/setup/session" method="post">
        <div className="grid gap-2"><Label htmlFor="setup-code">One-time setup code</Label><Input id="setup-code" name="setupCode" type="password" required minLength={32} maxLength={512} autoComplete="off" spellCheck={false} /></div>
        <Button type="submit" className="w-fit">Unlock setup</Button>
      </form>
      <CallbackUri value={callbackUri} />
    </Panel>
  );
}

function SlackConfigurationForm({ callbackUri, initialState }: { callbackUri: string; initialState: Extract<SetupViewState, { kind: "configure" }> }) {
  const [pending, setPending] = useState(initialState.pending);
  const [clientId, setClientId] = useState(initialState.pending?.clientId ?? "");
  const [botScopes, setBotScopes] = useState(() => new Set(initialState.pending?.botScopes ?? initialState.selectedBotScopes));
  const [userScopes, setUserScopes] = useState(() => new Set(initialState.pending?.userScopes ?? initialState.selectedUserScopes));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const botOptions = useMemo(() => initialState.scopes.filter((scope) => scope.tokenKind === "bot"), [initialState.scopes]);
  const userOptions = useMemo(() => initialState.scopes.filter((scope) => scope.tokenKind === "user"), [initialState.scopes]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    setMessage(null);
    setError(null);
    const form = new FormData(formElement);
    try {
      const response = await fetch("/v1/prism/setup/slack-configuration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret: form.get("clientSecret"), botScopes: [...botScopes], userScopes: [...userScopes] })
      });
      const body = (await response.json()) as { configuration?: SetupPendingConfiguration; error?: string };
      if (!response.ok || !body.configuration) {
        setError(configurationError(body.error));
        return;
      }
      setPending(body.configuration);
      setClientId(body.configuration.clientId);
      setBotScopes(new Set(body.configuration.botScopes));
      setUserScopes(new Set(body.configuration.userScopes));
      formElement.reset();
      setMessage("Slack configuration saved securely. Verify it with Slack before Prism activates it.");
    } catch {
      setError("Could not reach Prism. Your secret was not saved; check the server and try again.");
    } finally {
      setSaving(false);
    }
  }

  const selectAll = () => {
    setBotScopes(new Set(botOptions.map((scope) => scope.id)));
    setUserScopes(new Set(userOptions.map((scope) => scope.id)));
  };
  const resetDefault = () => {
    setBotScopes(new Set(botOptions.map((scope) => scope.id)));
    setUserScopes(new Set(userOptions.map((scope) => scope.id)));
  };

  return (
    <div className="grid gap-6">
      {initialState.error === "verification_unavailable" ? <Notice title="Slack verification could not start" tone="warning">The pending configuration was not changed. Check Prism availability, then try verification again.</Notice> : null}
      <Panel title="Slack app credentials" titleId="slack-configuration-title" eyebrow="Step 2" accent="primary" badge={pending ? <StatusBadge tone="warning">Not verified</StatusBadge> : <StatusBadge>Not saved</StatusBadge>}>
        <CallbackUri value={callbackUri} />
        <Notice title="Use an existing approved Slack app" tone="info">Copy the Client ID and Client Secret from Slack app management. Scope choices here must already be configured and approved on that app.</Notice>
        <form className="grid gap-5" onSubmit={save}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="slack-client-id">Slack Client ID</Label><Input id="slack-client-id" name="clientId" value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} required maxLength={255} autoComplete="off" spellCheck={false} /></div>
            <div className="grid gap-2">
              <Label htmlFor="slack-client-secret">Slack Client Secret</Label>
              <Input id="slack-client-secret" name="clientSecret" type="password" required maxLength={4096} autoComplete="new-password" spellCheck={false} />
              <p className="text-xs leading-5 text-muted-foreground">{pending?.secretStored ? "Stored securely. Enter it again only when replacing this pending configuration." : "Encrypted before storage and never shown again."}</p>
            </div>
          </div>
          <section className="grid gap-4 rounded-xl bg-muted/35 p-4" aria-labelledby="scope-selection-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 id="scope-selection-title" className="text-base font-semibold text-foreground">Slack scopes</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">There is no Slack all-scopes wildcard. Prism sends only the explicit scopes selected below.</p></div>
              <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={selectAll}>Select all Prism-supported</Button><Button type="button" variant="quiet" onClick={resetDefault}>Reset to default</Button></div>
            </div>
            <Notice title="Selection is not Slack approval" tone="warning">When scope settings are omitted, Prism defaults to every scope in this reviewed list. Selecting them does not add them to the Slack app or bypass workspace approval. User <code>chat:write</code> remains required for Playtest announcements.</Notice>
            <ScopeGroup legend="User scopes" options={userOptions} selected={userScopes} onChange={setUserScopes} />
            <ScopeGroup legend="Bot scopes" options={botOptions} selected={botScopes} onChange={setBotScopes} />
          </section>
          {message ? <p className="rounded-xl border border-[color:var(--prism-success)]/45 bg-[color:var(--prism-success-soft)] px-4 py-3 text-sm text-[color:var(--prism-success-foreground)]" role="status">{message}</p> : null}
          {error ? <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><Button type="submit" disabled={saving}>{saving ? "Saving securely..." : pending ? "Replace pending configuration" : "Save Slack configuration"}</Button></div>
        </form>
      </Panel>
      {pending ? (
        <Panel title="Verify with Slack" titleId="verify-slack-title" eyebrow="Step 3" accent="warning" badge={<StatusBadge tone="warning">Not verified</StatusBadge>}>
          <p>Prism will open Slack using this exact immutable configuration. It becomes active only after Slack completes OAuth successfully.</p>
          <form action="/v1/prism/setup/slack-configuration/verify" method="post"><Button type="submit">Verify and connect Slack</Button></form>
        </Panel>
      ) : null}
    </div>
  );
}

function ScopeGroup({ legend, options, selected, onChange }: { legend: string; options: SetupScopeOption[]; selected: Set<string>; onChange: (value: Set<string>) => void }) {
  return (
    <fieldset className="grid gap-3 rounded-xl border border-border bg-background/65 p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">{legend}</legend>
      {options.length === 0 ? <p className="text-sm text-muted-foreground">No scopes in this group.</p> : (
        <div className="grid gap-2 sm:grid-cols-2">
          {options.map((scope) => (
            <label key={`${scope.tokenKind}:${scope.id}`} className="flex min-h-14 items-start gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-sm text-foreground">
              <input className="mt-1 size-4" type="checkbox" name={`${scope.tokenKind}Scopes`} value={scope.id} checked={selected.has(scope.id)} disabled={scope.required} onChange={(event) => { const next = new Set(selected); if (event.currentTarget.checked) next.add(scope.id); else next.delete(scope.id); onChange(next); }} />
              <span className="grid gap-1"><span className="font-medium">{scope.id}{scope.required ? " — required" : ""}</span><span className="text-xs leading-5 text-muted-foreground">{scope.description}</span></span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function CallbackUri({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); }
  }
  return (
    <section className="grid gap-2 rounded-xl border border-border bg-muted/30 p-4" aria-labelledby="callback-uri-title">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="callback-uri-title" className="text-sm font-semibold text-foreground">Slack redirect URL</h3><Button type="button" variant="quiet" onClick={copy}>{copied ? "Copied" : "Copy URL"}</Button></div>
      <code className="overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground" aria-label="Slack redirect URL value">{value}</code>
      <p className="text-xs leading-5 text-muted-foreground">Add this exact URL to the existing Slack app before verification. Prism derives it from the deployment and it cannot be edited here.</p>
    </section>
  );
}

function EnvironmentLocked({ callbackUri, botScopes, userScopes }: { callbackUri: string; botScopes: string[]; userScopes: string[] }) {
  return (
    <Panel title="Environment locked" titleId="environment-locked-title" eyebrow="Slack configuration" accent="info" badge={<StatusBadge tone="success">Configured</StatusBadge>}>
      <p>Slack credentials are managed by this deployment. Prism will not let a browser replace or reveal them.</p>
      <CallbackUri value={callbackUri} />
      <div className="grid gap-3 sm:grid-cols-2"><ScopeSummary label="User scopes" values={userScopes} /><ScopeSummary label="Bot scopes" values={botScopes} /></div>
      <LinkButton href="/" variant="secondary">Return to Prism</LinkButton>
    </Panel>
  );
}

function SetupComplete() {
  return <Panel title="Slack configuration is active" titleId="setup-complete-title" eyebrow="Setup complete" accent="success" badge={<StatusBadge tone="success">Verified</StatusBadge>}><p>Prism verified the app with Slack, activated the configuration, and signed you in as the initial configuration administrator.</p><div className="flex flex-wrap gap-2"><LinkButton href="/">Open Prism</LinkButton><LinkButton href="/admin/configuration" variant="secondary">View configuration</LinkButton></div></Panel>;
}

function ScopeSummary({ label, values }: { label: string; values: string[] }) {
  return <section className="rounded-xl bg-muted/35 p-4"><h3 className="text-sm font-semibold text-foreground">{label}</h3><p className="mt-2 text-sm text-muted-foreground">{values.length ? values.join(", ") : "None"}</p></section>;
}

function configurationError(error: string | undefined): string {
  if (error === "invalid_configuration") return "Check the client credentials and selected scopes. Prism did not save this configuration.";
  if (error === "session_expired" || error === "unauthorized") return "Your setup session expired. Mint a new one-time setup code on the Prism host.";
  if (error === "configuration_conflict") return "The pending configuration changed in another window. Refresh before trying again.";
  if (error === "environment_locked") return "This deployment manages Slack credentials outside the browser.";
  return "Prism could not save the Slack configuration.";
}

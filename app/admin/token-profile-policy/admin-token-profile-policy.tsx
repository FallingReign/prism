"use client";

import { FormEvent, useState } from "react";

import type { AdminScope } from "../../../src/server/admin/authorization";
import type { GlobalTokenProfilePolicy } from "../../../src/server/token-profiles/global-policy";
import { Button, Notice, Panel, StatusBadge, SummaryMetric } from "../../ui";

type PolicyViewSettings = {
  policy: GlobalTokenProfilePolicy;
  version: number;
  updatedAt: string | null;
  updatedByPrismUserId: string | null;
};

const presetOptions: Array<{ value: GlobalTokenProfilePolicy["presets"]["allowed"][number]; label: string }> = [
  { value: "read_only", label: "Read-only" },
  { value: "messages_only", label: "Messages only" },
  { value: "full_slack_bridge", label: "Full Slack bridge" },
  { value: "custom", label: "Custom" }
];
const identityOptions: Array<{ value: GlobalTokenProfilePolicy["executionIdentities"]["allowed"][number]; label: string }> = [
  { value: "automatic", label: "Automatic" },
  { value: "user", label: "User-backed" },
  { value: "bot", label: "Bot-backed" },
  { value: "selectable", label: "Selectable by request" }
];
const experimentOptions: Array<{ value: "24h" | "7d"; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" }
];
const actionOptions = [
  { key: "read", label: "Read" },
  { key: "search", label: "Search" },
  { key: "writeMessages", label: "Write messages" },
  { key: "reactions", label: "Reactions" },
  { key: "filesMetadata", label: "Files metadata" },
  { key: "destructive", label: "Destructive methods" }
] as const;

export function AdminTokenProfilePolicyView({ scope, settings, editable }: { scope: AdminScope; settings: PolicyViewSettings; editable: boolean }) {
  const [policy, setPolicy] = useState(settings.policy);
  const [version, setVersion] = useState(settings.version);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    const nextPolicy = policyFromForm(new FormData(event.currentTarget), policy);
    const response = await fetch("/v1/prism/admin/token-profile-policy", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: nextPolicy })
    });
    const body = await response.json();
    setSubmitting(false);
    if (!response.ok) {
      setError(body.message ?? body.error ?? "Could not update Global Token profile policy.");
      return;
    }
    setPolicy(body.policy);
    setVersion(body.version);
    setMessage("Global Token profile policy updated.");
  }

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <AdminPolicyHeader scope={scope} />

      <Panel
        title="Global Token profile policy"
        titleId="admin-token-profile-policy-title"
        eyebrow="Deployment setting"
        accent="primary"
        badge={<StatusBadge tone={editable ? "success" : "neutral"}>{editable ? "Editable global scope" : "Read-only scope"}</StatusBadge>}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryMetric label="Policy version" value={`v${version}`} detail="Stored in Prism deployment settings." tone="primary" />
          <SummaryMetric label="Default preset" value={presetLabel(policy.presets.default)} detail="Applied by the server when callers omit a preset." tone="info" />
          <SummaryMetric label="Scope" value={scope.kind} detail={editable ? "Global admins can edit this deployment policy." : "Scoped admins can review but cannot edit."} tone="neutral" />
        </div>
        <Notice title="Policy boundary" tone="info">
          This setting constrains Token profile defaults and maximums only. It does not control Slack OAuth scopes, workspace membership,
          rate limits, or audit retention.
        </Notice>
      </Panel>

      <Panel title="Policy editor" titleId="admin-token-profile-policy-editor-title" eyebrow="Defaults and maximums" accent={editable ? "warning" : "info"}>
        {!editable ? (
          <Notice title="Read-only admin scope" tone="neutral">
            Enterprise and team admins can inspect the effective policy, but only global admins can save deployment-wide changes.
          </Notice>
        ) : null}
        <form className="grid gap-5" onSubmit={onSubmit}>
          <fieldset className="grid gap-3 rounded-xl bg-muted/35 p-4" disabled={!editable}>
            <legend className="px-1 text-sm font-semibold text-foreground">Allowed presets</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {presetOptions.map((option) => (
                <CheckboxField key={option.value} name={`preset:${option.value}`} label={option.label} defaultChecked={policy.presets.allowed.includes(option.value)} disabled={!editable} />
              ))}
            </div>
            <SelectField name="defaultPreset" label="Default preset" defaultValue={policy.presets.default} options={presetOptions} disabled={!editable} />
          </fieldset>

          <fieldset className="grid gap-3 rounded-xl bg-muted/35 p-4" disabled={!editable}>
            <legend className="px-1 text-sm font-semibold text-foreground">Execution identity</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {identityOptions.map((option) => (
                <CheckboxField
                  key={option.value}
                  name={`identity:${option.value}`}
                  label={option.label}
                  defaultChecked={policy.executionIdentities.allowed.includes(option.value)}
                  disabled={!editable}
                />
              ))}
            </div>
            <SelectField name="defaultExecutionIdentity" label="Default execution identity" defaultValue={policy.executionIdentities.default} options={identityOptions} disabled={!editable} />
          </fieldset>

          <fieldset className="grid gap-3 rounded-xl bg-muted/35 p-4" disabled={!editable}>
            <legend className="px-1 text-sm font-semibold text-foreground">Maximum capabilities</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {actionOptions.map((option) => (
                <CheckboxField
                  key={option.key}
                  name={`action:${option.key}`}
                  label={option.label}
                  defaultChecked={policy.capabilities.maximum.actions[option.key]}
                  disabled={!editable}
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="grid gap-3 rounded-xl bg-muted/35 p-4" disabled={!editable}>
            <legend className="px-1 text-sm font-semibold text-foreground">Expiry and rotation maximums</legend>
            <div className="grid gap-3 lg:grid-cols-3">
              <NumberField name="maxNonDestructiveDays" label="Non-destructive max days" defaultValue={policy.expiry.maximumDays.nonDestructive} disabled={!editable} />
              <NumberField name="maxDestructiveDays" label="Destructive max days" defaultValue={policy.expiry.maximumDays.destructive} disabled={!editable} />
              <SelectField name="maxRotationOverlap" label="Max rotation overlap" defaultValue={policy.mutation.maxRotationOverlap} options={rotationOverlapOptions()} disabled={!editable} />
            </div>
            <CheckboxField name="allowNoExpiryForReadOnly" label="Allow no-expiry Read-only profiles" defaultChecked={policy.expiry.allowNoExpiryForReadOnly} disabled={!editable} />
            <div className="grid gap-2 sm:grid-cols-2">
              {experimentOptions.map((option) => (
                <CheckboxField
                  key={option.value}
                  name={`experiment:${option.value}`}
                  label={`Allow ${option.label} experiment expiry`}
                  defaultChecked={policy.expiry.allowedExperimentTtls.includes(option.value)}
                  disabled={!editable}
                />
              ))}
            </div>
          </fieldset>

          {message ? (
            <p className="rounded-xl border border-[color:var(--prism-success)]/45 bg-[color:var(--prism-success-soft)] px-4 py-3 text-sm font-medium text-[color:var(--prism-success-foreground)]" role="status">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {editable ? (
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving..." : "Save policy"}
              </Button>
            </div>
          ) : null}
        </form>
      </Panel>
    </main>
  );
}

function AdminPolicyHeader({ scope }: { scope: AdminScope }) {
  return (
    <header className="grid gap-4 rounded-2xl bg-card/75 p-3 shadow-sm ring-1 ring-foreground/5 backdrop-blur sm:grid-cols-[auto_1fr_auto] sm:items-center">
      <a className="inline-flex items-center gap-3 rounded-xl text-foreground no-underline" href="/admin">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm" aria-hidden="true">
          P
        </span>
        <span className="grid">
          <strong className="text-sm font-semibold leading-5">Prism admin</strong>
          <span className="text-xs text-muted-foreground">Global policy</span>
        </span>
      </a>
      <nav className="flex flex-wrap gap-1 sm:justify-center" aria-label="Admin policy">
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin">
          Admin overview
        </a>
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/users">
          User directory
        </a>
        <a className="inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground" href="/admin/token-profile-policy">
          Global policy
        </a>
      </nav>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <StatusBadge tone="success">{scope.kind}</StatusBadge>
      </div>
    </header>
  );
}

function policyFromForm(form: FormData, current: GlobalTokenProfilePolicy): GlobalTokenProfilePolicy {
  const allowedPresets = presetOptions.map((option) => option.value).filter((value) => form.get(`preset:${value}`) === "on");
  const allowedIdentities = identityOptions.map((option) => option.value).filter((value) => form.get(`identity:${value}`) === "on");
  const maximumActions = {
    read: form.get("action:read") === "on",
    search: form.get("action:search") === "on",
    writeMessages: form.get("action:writeMessages") === "on",
    reactions: form.get("action:reactions") === "on",
    filesMetadata: form.get("action:filesMetadata") === "on",
    destructive: form.get("action:destructive") === "on"
  };
  const maximumSurfaces: GlobalTokenProfilePolicy["capabilities"]["maximum"]["surfaces"] = {
    publicChannels: current.capabilities.maximum.surfaces.publicChannels,
    privateChannels: current.capabilities.maximum.surfaces.privateChannels,
    directMessages: current.capabilities.maximum.surfaces.directMessages,
    groupDirectMessages: current.capabilities.maximum.surfaces.groupDirectMessages,
    search: maximumActions.search,
    filesMetadata: maximumActions.filesMetadata,
    canvases: false,
    lists: false,
    future: false
  };
  const defaults = {
    actions: capActions(current.capabilities.defaults.actions, maximumActions),
    surfaces: capSurfaces(current.capabilities.defaults.surfaces, maximumSurfaces)
  };

  return {
    ...current,
    presets: {
      allowed: allowedPresets.length > 0 ? allowedPresets : [current.presets.default],
      default: presetValue(form.get("defaultPreset"), allowedPresets, current.presets.default)
    },
    executionIdentities: {
      allowed: allowedIdentities.length > 0 ? allowedIdentities : [current.executionIdentities.default],
      default: identityValue(form.get("defaultExecutionIdentity"), allowedIdentities, current.executionIdentities.default)
    },
    capabilities: {
      defaults,
      maximum: { actions: maximumActions, surfaces: maximumSurfaces }
    },
    expiry: {
      ...current.expiry,
      allowNoExpiryForReadOnly: form.get("allowNoExpiryForReadOnly") === "on",
      maximumDays: {
        readOnly: current.expiry.maximumDays.readOnly,
        nonDestructive: positiveInteger(form.get("maxNonDestructiveDays"), current.expiry.maximumDays.nonDestructive),
        destructive: positiveInteger(form.get("maxDestructiveDays"), current.expiry.maximumDays.destructive) ?? current.expiry.maximumDays.destructive
      },
      allowedExperimentTtls: experimentOptions.map((option) => option.value).filter((value) => form.get(`experiment:${value}`) === "on")
    },
    mutation: {
      ...current.mutation,
      maxRotationOverlap: rotationOverlapValue(form.get("maxRotationOverlap"), current.mutation.maxRotationOverlap)
    }
  };
}

function CheckboxField({ name, label, defaultChecked, disabled }: { name: string; label: string; defaultChecked: boolean; disabled: boolean }) {
  return (
    <label className="flex min-h-11 items-center gap-3 rounded-lg bg-background/65 px-3 py-2 text-sm font-medium text-foreground">
      <input className="size-4" type="checkbox" name={name} defaultChecked={defaultChecked} disabled={disabled} />
      {label}
    </label>
  );
}

function SelectField({ name, label, defaultValue, options, disabled }: { name: string; label: string; defaultValue: string; options: Array<{ value: string; label: string }>; disabled: boolean }) {
  return (
    <label className="grid gap-2 text-sm font-medium text-foreground">
      {label}
      <select className="min-h-11 rounded-lg border border-border bg-background px-3 text-foreground" name={name} defaultValue={defaultValue} disabled={disabled}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({ name, label, defaultValue, disabled }: { name: string; label: string; defaultValue: number | null; disabled: boolean }) {
  return (
    <label className="grid gap-2 text-sm font-medium text-foreground">
      {label}
      <input className="min-h-11 rounded-lg border border-border bg-background px-3 text-foreground" type="number" min={1} max={3650} name={name} defaultValue={defaultValue ?? undefined} disabled={disabled} />
    </label>
  );
}

function capActions(
  current: GlobalTokenProfilePolicy["capabilities"]["defaults"]["actions"],
  maximum: GlobalTokenProfilePolicy["capabilities"]["maximum"]["actions"]
): GlobalTokenProfilePolicy["capabilities"]["defaults"]["actions"] {
  return {
    read: current.read && maximum.read,
    search: current.search && maximum.search,
    writeMessages: current.writeMessages && maximum.writeMessages,
    reactions: current.reactions && maximum.reactions,
    filesMetadata: current.filesMetadata && maximum.filesMetadata,
    destructive: current.destructive && maximum.destructive
  };
}

function capSurfaces(
  current: GlobalTokenProfilePolicy["capabilities"]["defaults"]["surfaces"],
  maximum: GlobalTokenProfilePolicy["capabilities"]["maximum"]["surfaces"]
): GlobalTokenProfilePolicy["capabilities"]["defaults"]["surfaces"] {
  return {
    publicChannels: current.publicChannels && maximum.publicChannels,
    privateChannels: current.privateChannels && maximum.privateChannels,
    directMessages: current.directMessages && maximum.directMessages,
    groupDirectMessages: current.groupDirectMessages && maximum.groupDirectMessages,
    search: current.search && maximum.search,
    filesMetadata: current.filesMetadata && maximum.filesMetadata,
    canvases: false,
    lists: false,
    future: false
  };
}

function presetValue(value: FormDataEntryValue | null, allowed: Array<GlobalTokenProfilePolicy["presets"]["allowed"][number]>, fallback: GlobalTokenProfilePolicy["presets"]["default"]) {
  return presetOptions.some((option) => option.value === value) && allowed.includes(value as never) ? (value as GlobalTokenProfilePolicy["presets"]["default"]) : fallback;
}

function identityValue(value: FormDataEntryValue | null, allowed: Array<GlobalTokenProfilePolicy["executionIdentities"]["allowed"][number]>, fallback: GlobalTokenProfilePolicy["executionIdentities"]["default"]) {
  return identityOptions.some((option) => option.value === value) && allowed.includes(value as never) ? (value as GlobalTokenProfilePolicy["executionIdentities"]["default"]) : fallback;
}

function rotationOverlapValue(value: FormDataEntryValue | null, fallback: GlobalTokenProfilePolicy["mutation"]["maxRotationOverlap"]) {
  return value === "none" || value === "15m" || value === "1h" || value === "24h" ? value : fallback;
}

function positiveInteger(value: FormDataEntryValue | null, fallback: number | null): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : fallback;
}

function rotationOverlapOptions() {
  return [
    { value: "none", label: "No overlap" },
    { value: "15m", label: "15 minutes" },
    { value: "1h", label: "1 hour" },
    { value: "24h", label: "24 hours" }
  ];
}

function presetLabel(preset: GlobalTokenProfilePolicy["presets"]["default"]): string {
  return presetOptions.find((option) => option.value === preset)?.label ?? preset;
}

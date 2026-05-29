import type { TokenProfileSummary } from "./token-profile-summary";

export type TokenProfileRequestBody = {
  name: string;
  intendedUse: string;
  preset: string;
  executionIdentity: string;
  destructive: boolean;
  experiment?: string;
  custom?: {
    read: boolean;
    search: boolean;
    writeMessages: boolean;
    reactions: boolean;
    filesMetadata: boolean;
    destructive: boolean;
  };
};

export type TokenProfilePolicyRequestBody = TokenProfileRequestBody & {
  confirmBroadening: boolean;
};

export function buildCreateTokenProfileRequestBody(form: FormData): TokenProfileRequestBody {
  const preset = formString(form, "preset");
  return withOptionalFields({
    name: formString(form, "name"),
    intendedUse: formString(form, "intendedUse"),
    preset,
    executionIdentity: formString(form, "executionIdentity", "automatic"),
    destructive: form.get("destructive") === "on",
    experiment: experimentValue(form),
    custom: preset === "custom" ? customCapabilities(form) : undefined
  });
}

export function buildCreateTokenProfileModalRequestBody(form: FormData): TokenProfileRequestBody {
  const preset = formString(form, "preset", "read_only");
  return withOptionalFields({
    name: formString(form, "name"),
    intendedUse: formString(form, "intendedUse"),
    preset,
    executionIdentity: formString(form, "executionIdentity", "automatic"),
    destructive: form.get("destructive") === "on",
    custom: preset === "custom" ? customCapabilities(form) : undefined
  });
}

export function buildPolicyUpdateRequestBody(form: FormData, profile: TokenProfileSummary): TokenProfilePolicyRequestBody {
  const preset = formString(form, "policyPreset", profile.preset);
  return {
    ...withOptionalFields({
      name: profile.name,
      intendedUse: profile.intendedUse,
      preset,
      executionIdentity: formString(form, "policyExecutionIdentity", profile.executionIdentity),
      destructive: form.get("policyDestructive") === "on",
      experiment: experimentValue(form, "policyExperiment"),
      custom: preset === "custom" ? customCapabilities(form, "policy") : undefined
    }),
    confirmBroadening: form.get("confirmBroadening") === "on"
  };
}

function customCapabilities(form: FormData, prefix = "custom") {
  return {
    read: form.get(`${prefix}Read`) === "on",
    search: form.get(`${prefix}Search`) === "on",
    writeMessages: form.get(`${prefix}WriteMessages`) === "on",
    reactions: form.get(`${prefix}Reactions`) === "on",
    filesMetadata: form.get(`${prefix}FilesMetadata`) === "on",
    destructive: form.get(prefix === "policy" ? "policyDestructive" : "destructive") === "on"
  };
}

function experimentValue(form: FormData, field = "experiment"): string | undefined {
  const value = formString(form, field);
  return value === "" || value === "none" ? undefined : value;
}

function formString(form: FormData, field: string, fallback = ""): string {
  return String(form.get(field) ?? fallback);
}

function withOptionalFields(body: TokenProfileRequestBody): TokenProfileRequestBody {
  const result: TokenProfileRequestBody = {
    name: body.name,
    intendedUse: body.intendedUse,
    preset: body.preset,
    executionIdentity: body.executionIdentity,
    destructive: body.destructive
  };
  if (body.experiment !== undefined) result.experiment = body.experiment;
  if (body.custom !== undefined) result.custom = body.custom;
  return result;
}

import "server-only";

import type { OidcProviderConfig } from "../config";

const AUTHORIZATION_PARAMETERS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method"
] as const;

const TOKEN_PARAMETERS = [
  "grant_type",
  "client_id",
  "redirect_uri",
  "code",
  "code_verifier"
] as const;

const SUPPORTED_SCOPES = new Set(["openid", "profile", "email"]);

export type ValidatedAuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  responseType: "code";
  scope: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export type ValidatedTokenRequest = {
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
};

export type OidcAuthorizationError =
  | "access_denied"
  | "invalid_request"
  | "login_required"
  | "server_error";

export function validateAuthorizationRequest(
  url: URL,
  config: OidcProviderConfig
):
  | { kind: "valid"; request: ValidatedAuthorizationRequest }
  | { kind: "invalid"; error: "invalid_request" | "unauthorized_client" } {
  const values = uniqueParameters(url.searchParams, AUTHORIZATION_PARAMETERS);
  if (!values) return { kind: "invalid", error: "invalid_request" };

  if (
    values.client_id !== config.playtestClient.clientId ||
    values.redirect_uri !== config.playtestClient.redirectUri
  ) {
    return { kind: "invalid", error: "unauthorized_client" };
  }

  const scopes = values.scope.split(/\s+/).filter(Boolean);
  if (
    values.response_type !== "code" ||
    scopes.length === 0 ||
    !scopes.includes("openid") ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !SUPPORTED_SCOPES.has(scope)) ||
    !boundedOpaque(values.state) ||
    !boundedOpaque(values.nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(values.code_challenge) ||
    values.code_challenge_method !== "S256"
  ) {
    return { kind: "invalid", error: "invalid_request" };
  }

  return {
    kind: "valid",
    request: {
      clientId: values.client_id,
      redirectUri: values.redirect_uri,
      responseType: "code",
      scope: scopes.join(" "),
      state: values.state,
      nonce: values.nonce,
      codeChallenge: values.code_challenge,
      codeChallengeMethod: "S256"
    }
  };
}

export function validateTokenRequest(
  params: URLSearchParams,
  config: OidcProviderConfig
):
  | { kind: "valid"; request: ValidatedTokenRequest }
  | { kind: "invalid"; error: "invalid_grant" | "invalid_request" | "unsupported_grant_type" } {
  const values = uniqueParameters(params, TOKEN_PARAMETERS);
  if (!values) return { kind: "invalid", error: "invalid_request" };
  if (values.grant_type !== "authorization_code") {
    return { kind: "invalid", error: "unsupported_grant_type" };
  }
  if (
    values.client_id !== config.playtestClient.clientId ||
    values.redirect_uri !== config.playtestClient.redirectUri ||
    !/^[A-Za-z0-9_-]{16,512}$/.test(values.code) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(values.code_verifier)
  ) {
    return { kind: "invalid", error: "invalid_grant" };
  }
  return {
    kind: "valid",
    request: {
      clientId: values.client_id,
      redirectUri: values.redirect_uri,
      code: values.code,
      codeVerifier: values.code_verifier
    }
  };
}

export function authorizationErrorRedirect(
  request: Pick<ValidatedAuthorizationRequest, "redirectUri" | "state">,
  error: OidcAuthorizationError
): URL {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", error);
  redirect.searchParams.set("state", request.state);
  return redirect;
}

export function authorizationCodeRedirect(
  request: Pick<ValidatedAuthorizationRequest, "redirectUri" | "state">,
  code: string
): URL {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", request.state);
  return redirect;
}

function uniqueParameters<const Names extends readonly string[]>(
  params: URLSearchParams,
  names: Names
): { [Name in Names[number]]: string } | null {
  const allowed = new Set<string>(names);
  for (const name of params.keys()) {
    if (!allowed.has(name)) return null;
  }
  const values = {} as { [Name in Names[number]]: string };
  for (const name of names as readonly Names[number][]) {
    const matches = params.getAll(name);
    if (matches.length !== 1) return null;
    values[name] = matches[0]!;
  }
  return values;
}

function boundedOpaque(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

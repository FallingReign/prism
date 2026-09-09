/** Safe, display-only OAuth failure contract shared with first-party clients. */
export const OAUTH_FAILURE_REASONS = [
  "authorization_denied", "runtime_unavailable", "provider_rejected", "provider_unavailable",
  "invalid_provider_response", "persistence_failed"
] as const;

export type OAuthFailureReason = typeof OAUTH_FAILURE_REASONS[number];

export function isOAuthFailureReason(value: unknown): value is OAuthFailureReason {
  return typeof value === "string" && OAUTH_FAILURE_REASONS.some((reason) => reason === value);
}

export function oauthFailureStandardError(reason: OAuthFailureReason | undefined): "access_denied" | "server_error" {
  return reason === "runtime_unavailable" || reason === "provider_unavailable" || reason === "invalid_provider_response" || reason === "persistence_failed"
    ? "server_error" : "access_denied";
}

export function slackExchangeFailureReason(errorClass: import("./oauth-client").SlackOAuthFailure["errorClass"]): OAuthFailureReason {
  switch (errorClass) {
    case "malformed_oauth_response": return "invalid_provider_response";
    case "network_error": case "service_unavailable": case "request_timeout":
    case "ratelimited": case "internal_error": case "fatal_error": return "provider_unavailable";
    case "invalid_client_id": case "bad_client_secret": return "runtime_unavailable";
    default: return "provider_rejected";
  }
}

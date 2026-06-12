export type ApiAuthModel = "none" | "prismDeveloperToken" | "websiteSession";
export type ApiSurface = "local-tool" | "website-session" | "admin-handoff";
export type ApiMethod = "GET" | "POST" | "DELETE";

export type ApiEndpoint = {
  method: ApiMethod;
  path: string;
  authModel: ApiAuthModel;
  surface: ApiSurface;
  summary: string;
  details: string[];
  example?: string;
  docsLinks?: readonly { label: string; href: string }[];
};

export type ApiEndpointGroup = {
  title: string;
  description: string;
  endpoints: readonly ApiEndpoint[];
};

export const apiEndpointGroups = [
  {
    title: "Local tool endpoints",
    description:
      "Endpoints for CLIs, MCP servers, and coding agents that hold a Prism developer token. Local tools never receive Slack credentials.",
    endpoints: [
      {
        method: "GET",
        path: "/v1/prism/health",
        authModel: "none",
        surface: "local-tool",
        summary: "Process health for deployment checks.",
        details: ["No bearer token is required.", "Returns a small JSON health payload and no-store caching headers."],
        example: "curl \"$PRISM_BASE_URL/v1/prism/health\""
      },
      {
        method: "GET",
        path: "/v1/prism/status",
        authModel: "prismDeveloperToken",
        surface: "local-tool",
        summary: "Status for the Token profile behind a Prism developer token.",
        details: ["Returns the local-tool connection state, Token profile policy, and reauth-required status.", "Includes X-Prism-Request-ID where practical."],
        example: "curl -H \"Authorization: Bearer prism_dev_...\" \"$PRISM_BASE_URL/v1/prism/status\""
      },
      {
        method: "GET",
        path: "/v1/prism/capabilities",
        authModel: "prismDeveloperToken",
        surface: "local-tool",
        summary: "Capability map for the current Prism developer token.",
        details: ["Lists allowed Slack-compatible method families and execution identity options.", "Use this before showing local tool affordances."],
        example: "curl -H \"Authorization: Bearer prism_dev_...\" \"$PRISM_BASE_URL/v1/prism/capabilities\""
      },
      {
        method: "GET",
        path: "/v1/slack/api/{method}",
        authModel: "prismDeveloperToken",
        surface: "local-tool",
        summary: "Slack-compatible Web API forwarding for safe GET-style calls.",
        details: [
          "The method name remains Slack-shaped, for example users.info.",
          "Prism evaluates Method registry policy, execution identity, rate limits, and metadata-only audit before forwarding."
        ],
        example: "curl -H \"Authorization: Bearer prism_dev_...\" \"$PRISM_BASE_URL/v1/slack/api/users.info?user=<slack-user-id>\"",
        docsLinks: [
          { label: "Slack Web API reference", href: "https://docs.slack.dev/apis/web-api/" },
          { label: "Slack users.info documentation", href: "https://docs.slack.dev/reference/methods/users.info/" }
        ]
      },
      {
        method: "POST",
        path: "/v1/slack/api/{method}",
        authModel: "prismDeveloperToken",
        surface: "local-tool",
        summary: "Slack-compatible Web API forwarding for safe POST-style calls.",
        details: [
          "Use JSON or form payloads that the target Slack method already accepts.",
          "Surface-gated methods (chat.*, reactions.*, conversations.*) require X-Prism-Surface header.",
          "Enterprise Grid: Use X-Prism-Workspace-ID to target specific workspace.",
          "Prism removes local token fields before upstream calls and records only metadata, not Slack payload content."
        ],
        example:
          "# Basic message\ncurl -X POST \\\n  -H \"Authorization: Bearer prism_dev_...\" \\\n  -H \"Content-Type: application/json\" \\\n  -H \"X-Prism-Surface: public_channel\" \\\n  \"$PRISM_BASE_URL/v1/slack/api/chat.postMessage\" \\\n  -d '{\"channel\":\"C...\",\"text\":\"Hello!\"}'\\n\\n# With workspace targeting (Enterprise Grid)\ncurl -X POST \\\n  -H \"Authorization: Bearer prism_dev_...\" \\\n  -H \"Content-Type: application/json\" \\\n  -H \"X-Prism-Surface: dm\" \\\n  -H \"X-Prism-Workspace-ID: T...\" \\\n  \"$PRISM_BASE_URL/v1/slack/api/chat.postMessage\" \\\n  -d '{\"channel\":\"U...\",\"text\":\"DM\"}'\\n\\n# Add reaction\ncurl -X POST \\\n  -H \"Authorization: Bearer prism_dev_...\" \\\n  -H \"Content-Type: application/json\" \\\n  -H \"X-Prism-Surface: public_channel\" \\\n  \"$PRISM_BASE_URL/v1/slack/api/reactions.add\" \\\n  -d '{\"channel\":\"C...\",\"name\":\"tada\",\"timestamp\":\"1234.56\"}'",
        docsLinks: [
          { label: "Slack Web API reference", href: "https://docs.slack.dev/apis/web-api/" },
          { label: "Slack chat.postMessage documentation", href: "https://docs.slack.dev/reference/methods/chat.postMessage/" }
        ]
      }
    ]
  },
  {
    title: "Website/session management endpoints",
    description:
      "Endpoints used by the Prism website after Slack OAuth creates a browser session. They are not authenticated with Prism developer tokens.",
    endpoints: [
      {
        method: "GET",
        path: "/v1/prism/token-profiles",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "List Token profiles for the current Prism user.",
        details: ["Requires the HTTP-only Prism website session cookie.", "Returns metadata only; copy-once developer token values are never listed."]
      },
      {
        method: "POST",
        path: "/v1/prism/token-profiles",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Create a Token profile and issue one copy-once Prism developer token.",
        details: ["Global Token profile policy is enforced server-side.", "The raw Prism developer token is shown only once in the response."]
      },
      {
        method: "POST",
        path: "/v1/prism/token-profiles/{profileId}/rotate",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Rotate a Token profile developer token.",
        details: ["Supports immediate and overlap rotation flows.", "Policy broadening stays behind the rotation-required gate."]
      },
      {
        method: "POST",
        path: "/v1/prism/token-profiles/{profileId}/revoke",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Revoke a Token profile developer token.",
        details: ["Stops local tools from using the profile token.", "Existing audit rows remain metadata only."]
      },
      {
        method: "DELETE",
        path: "/v1/prism/token-profiles/{profileId}",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Permanently delete an inactive Token profile.",
        details: ["Active profiles must be revoked before deletion.", "The route is scoped to the current Prism user."]
      },
      {
        method: "GET",
        path: "/v1/prism/activity",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "List recent metadata-only Prism activity for the current Prism user.",
        details: ["Includes method, policy outcome, object identifiers, request IDs, and timing metadata.", "Never includes Slack message text, files, canvases, lists, or raw Slack payloads."]
      },
      {
        method: "GET",
        path: "/v1/slack/oauth/start",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Start or change Slack authorization for the website session.",
        details: ["Redirects to Slack OAuth.", "Slack credential custody remains server-side."],
        docsLinks: [{ label: "Slack OAuth documentation", href: "https://docs.slack.dev/authentication/installing-with-oauth/" }]
      },
      {
        method: "GET",
        path: "/v1/slack/oauth/callback",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Complete Slack OAuth and establish the Prism website session.",
        details: ["Consumes Slack OAuth response data server-side.", "The browser receives a Prism session cookie, not Slack credentials."],
        docsLinks: [{ label: "Slack OAuth documentation", href: "https://docs.slack.dev/authentication/installing-with-oauth/" }]
      },
      {
        method: "DELETE",
        path: "/v1/prism/slack-connection",
        authModel: "websiteSession",
        surface: "website-session",
        summary: "Remove the current user's local Slack connection from Prism.",
        details: ["Requires typed confirmation in the website UI.", "Cascades local Token profile state without touching the Slack workspace."]
      }
    ]
  },
  {
    title: "Admin handoff",
    description:
      "Admin operations live in the Prism admin console and require existing Prism admin authorization. The developer API reference intentionally does not list detailed admin-only API routes.",
    endpoints: []
  }
] as const satisfies readonly ApiEndpointGroup[];

export function authModelLabel(authModel: ApiAuthModel): string {
  if (authModel === "none") return "No auth";
  if (authModel === "prismDeveloperToken") return "Authorization: Bearer prism_dev_...";
  return "Prism website session cookie";
}

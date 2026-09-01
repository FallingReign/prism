import type { LocalAppAuthorizationPreview } from "./types";

export function renderLocalAppConsentPage(preview: LocalAppAuthorizationPreview): string {
  const identity = preview.identity;
  const workspace = identity.teamName ?? identity.teamId ?? "Choose a workspace in the app after pairing";
  const organization = identity.enterpriseName ?? identity.enterpriseId;
  const slackUser = identity.slackUserDisplayName ?? identity.slackUserId;
  const code = preview.userCode ? `<div class="code">${escapeHtml(preview.userCode)}</div>` : "";
  const rePairing = preview.rePairing
    ? `<div class="warning"><strong>This app is already paired.</strong> Approving replaces its current token immediately. The existing pairing will stop working.</div>`
    : "";
  return page("Connect a local app", `
    <p class="eyebrow">Prism local app pairing</p>
    <h1>Connect ${escapeHtml(preview.displayName)}?</h1>
    ${code}
    <p class="lede">This is an unverified local app identifier. Approve only if you started this request and this code exactly matches the code shown by the local app. If this app identifier is already paired, approving replaces that token immediately.</p>
    ${rePairing}
    <dl>
      <div><dt>App identifier</dt><dd>${escapeHtml(preview.clientId)}</dd></div>
      <div><dt>Purpose</dt><dd>${escapeHtml(preview.intendedUse)}</dd></div>
      <div><dt>Acts as</dt><dd>${escapeHtml(slackUser)} (${escapeHtml(identity.slackUserId)})</dd></div>
      <div><dt>Slack workspace</dt><dd>${escapeHtml(workspace)}</dd></div>
      ${organization ? `<div><dt>Slack organization</dt><dd>${escapeHtml(organization)}</dd></div>` : ""}
      <div><dt>Access</dt><dd>Read and send Slack messages as you. No files, administration, or app management.</dd></div>
      <div><dt>Request expires</dt><dd>${escapeHtml(preview.expiresAt.toISOString())}</dd></div>
    </dl>
    <form method="post" action="/local-app/authorize">
      <input type="hidden" name="request" value="${escapeHtml(preview.requestId)}">
      <div class="actions">
        <button class="primary" type="submit" name="decision" value="approve">Approve and connect</button>
        <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>
  `);
}

export function renderLocalAppResultPage(
  result: "approved" | "denied" | "unavailable" | "connection_unavailable",
  options?: { reconnectUrl?: string }
): string {
  if (result === "approved") {
    return page("Local app connected", `<h1>Connected</h1><p class="lede">You can close this tab and return to the local app.</p>`);
  }
  if (result === "denied") {
    return page("Connection denied", `<h1>Not connected</h1><p class="lede">The local app was not given access. You can close this tab.</p>`);
  }
  if (result === "connection_unavailable") {
    const action = options?.reconnectUrl
      ? `<p><a class="button primary" href="${escapeHtml(options.reconnectUrl)}">Reconnect Slack</a></p>`
      : "";
    return page("Slack connection unavailable", `<h1>Reconnect Slack</h1><p class="lede">Your Prism Slack connection needs to be refreshed before this local app can connect.</p>${action}`);
  }
  return page("Pairing request unavailable", `<h1>Pairing request unavailable</h1><p class="lede">This request is invalid, expired, or has already been used. Start pairing again in the local app.</p>`);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - Prism</title><style>
  :root{color-scheme:light;background:#f4f3ef;color:#1f2522;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(640px,100%);background:#fff;border:1px solid #d9ddd8;border-radius:20px;padding:clamp(24px,5vw,44px);box-shadow:0 20px 60px rgba(24,36,29,.10)}h1{font-size:clamp(28px,5vw,42px);line-height:1.08;margin:.15em 0 .45em}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:750;color:#287354}.lede{font-size:17px;line-height:1.55;color:#4b5650}.code{font:700 24px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.1em;padding:14px 16px;background:#edf8f2;border-radius:12px;margin:20px 0}.warning{padding:14px 16px;background:#fff5d8;border:1px solid #e9c96e;border-radius:12px;line-height:1.45;margin:20px 0}dl{margin:28px 0;border-top:1px solid #e5e8e5}dl div{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:20px;padding:14px 0;border-bottom:1px solid #e5e8e5}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere;color:#46514b}.actions{display:flex;gap:12px;flex-wrap:wrap}button,.button{display:inline-block;border:0;border-radius:10px;padding:13px 18px;font:700 15px inherit;cursor:pointer;text-decoration:none}.primary{background:#176b4a;color:white}.secondary{background:#e9ecea;color:#26322c}@media(max-width:520px){dl div{grid-template-columns:1fr;gap:5px}.actions button{width:100%}}</style></head><body><main class="card">${content}</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

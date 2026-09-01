import "server-only";

import type { DelegatedConsentPreview } from "./types";
import { canonicalJson } from "./validation";

export function renderDelegatedConsentPage(preview: DelegatedConsentPreview): string {
  const sender = preview.identity.slackUserDisplayName ?? preview.identity.slackUserId;
  const team = preview.identity.teamName ?? preview.identity.teamId;
  const canonicalPayload = canonicalJson(preview.payload);
  const readableBlocks = renderReadableBlocks(preview.payload.blocks);
  const approvePath = `/v1/prism/delegations/slack-message/${encodeURIComponent(preview.requestId)}/approve`;
  const denyPath = `/v1/prism/delegations/slack-message/${encodeURIComponent(preview.requestId)}/deny`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve exact Slack message · Prism</title>
  <style>
    :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#111827;color:#f9fafb}main{max-width:760px;margin:3rem auto;padding:0 1.25rem}.card{background:#1f2937;border:1px solid #374151;border-radius:16px;padding:1.5rem;box-shadow:0 16px 40px #0006}.meta{display:grid;grid-template-columns:minmax(9rem,auto) 1fr;gap:.6rem 1rem}.label{color:#9ca3af}.message,pre,.blocks{white-space:pre-wrap;overflow-wrap:anywhere;background:#111827;border:1px solid #374151;border-radius:10px;padding:1rem}pre{max-height:22rem;overflow:auto}.block{padding:.7rem 0;border-bottom:1px solid #374151}.block:last-child{border-bottom:0}.block-header{font-size:1.15rem;font-weight:750}.block-context{color:#d1d5db;font-size:.92rem}.block-fields{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem}.block-divider{border:0;border-top:1px solid #6b7280}details{margin:1rem 0}summary{cursor:pointer;font-weight:650}form{display:inline-block;margin:.5rem .5rem 0 0}button{border:0;border-radius:9px;padding:.75rem 1rem;font:inherit;font-weight:700;cursor:pointer}.approve{background:#22c55e;color:#052e16}.deny{background:#374151;color:#f9fafb}.warning{color:#fbbf24}code{overflow-wrap:anywhere}@media(max-width:600px){main{margin:1rem auto;padding:0 .75rem}.card{padding:1rem}.meta,.block-fields{grid-template-columns:minmax(0,1fr)}.meta{gap:.25rem}.label{margin-top:.5rem}}
  </style>
</head>
<body><main><div class="card">
  <h1>Approve this exact Slack message</h1>
  <p class="warning">Approval is for one message only. Prism will bind it to the sender, workspace, channel, content, and delivery window shown below.</p>
  <div class="meta">
    <div class="label">Sender</div><div>${escapeHtml(sender)} <code>${escapeHtml(preview.identity.slackUserId)}</code></div>
    <div class="label">Workspace</div><div>${escapeHtml(team)} <code>${escapeHtml(preview.identity.teamId)}</code></div>
    <div class="label">Channel</div><div><code>${escapeHtml(preview.channelId)}</code></div>
    <div class="label">Approve by</div><div>${escapeHtml(preview.approvalExpiresAt.toISOString())}</div>
    <div class="label">Delivery time</div><div>${escapeHtml(preview.notBefore.toISOString())}</div>
    <div class="label">Delivery deadline</div><div>${escapeHtml(preview.deliveryExpiresAt.toISOString())}</div>
    <div class="label">Application request</div><div><code>${escapeHtml(preview.externalJobId)}</code> revision ${preview.revision}</div>
  </div>
  <h2>Fallback text</h2><div class="message">${escapeHtml(preview.payload.text)}</div>
  <h2>Message blocks</h2><div class="blocks">${readableBlocks}</div>
  <details><summary>Advanced payload verification</summary>
    <p>SHA-256: <code>${escapeHtml(preview.payloadSha256)}</code></p>
    <pre>${escapeHtml(canonicalPayload)}</pre>
  </details>
  <form method="post" action="${approvePath}"><button class="approve" type="submit">Approve one message</button></form>
  <form method="post" action="${denyPath}"><button class="deny" type="submit">Deny and return</button></form>
</div></main></body></html>`;
}

export function renderDelegatedConsentErrorPage(status: number): string {
  const title = status === 410 ? "Approval request expired" : status === 403 ? "Approval is not available for this identity" : "Approval request unavailable";
  return renderErrorDocument(title, "Return to the application that started this request and create a new authorization request if needed.");
}

export function renderDelegatedConsentCsrfErrorPage(): string {
  return renderErrorDocument(
    "Approval request could not be verified",
    "Return to the original Prism authorization page and try again. If needed, return to the requesting application and start a new request."
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]!);
}

function renderErrorDocument(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Prism</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function renderReadableBlocks(blocks: unknown[]): string {
  if (blocks.length === 0) return '<div class="block block-context">No Block Kit blocks. Slack will use the fallback text above.</div>';
  return blocks.map((block) => renderReadableBlock(block)).join("");
}

function renderReadableBlock(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string") return '<div class="block block-context">Unsupported block</div>';
  if (value.type === "divider") return '<hr class="block block-divider">';
  if (value.type === "header") {
    return `<div class="block block-header">${escapeHtml(textObject(value.text) ?? "Header")}</div>`;
  }
  if (value.type === "section") {
    const text = textObject(value.text) ?? "";
    const fields = Array.isArray(value.fields)
      ? value.fields.map((field) => textObject(field)).filter((field): field is string => field !== null)
      : [];
    return `<div class="block"><div>${escapeHtml(text)}</div>${fields.length > 0 ? `<div class="block-fields">${fields.map((field) => `<div>${escapeHtml(field)}</div>`).join("")}</div>` : ""}</div>`;
  }
  if (value.type === "context") {
    const elements = Array.isArray(value.elements)
      ? value.elements.map((element) => textObject(element) ?? (isRecord(element) && typeof element.alt_text === "string" ? element.alt_text : null)).filter((text): text is string => text !== null)
      : [];
    return `<div class="block block-context">${escapeHtml(elements.join(" · ") || "Context")}</div>`;
  }
  if (value.type === "image") {
    const label = textObject(value.title) ?? (typeof value.alt_text === "string" ? value.alt_text : "Image");
    return `<div class="block block-context">Image: ${escapeHtml(label)}</div>`;
  }
  if (value.type === "actions") return '<div class="block block-context">Interactive actions</div>';
  return `<div class="block block-context">${escapeHtml(value.type)} block</div>`;
}

function textObject(value: unknown): string | null {
  return isRecord(value) && typeof value.text === "string" ? value.text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

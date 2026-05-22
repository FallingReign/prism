# Prism Slack admin installation plan

This plan documents the required human Slack admin/security steps before any real Prism Slack app installation. It does not grant approval by itself.

## Required human approvals

1. Slack admin/security owner approves the non-admin scope set, redirect URLs, and installation target.
2. Developer/security owner confirms Prism remains the hosted credential custodian and Local tools receive only Prism developer tokens.
3. Issue #4 implementer confirms OAuth callback, token rotation, encryption, and credential custody design before any token exchange is attempted.

## Installation sequence

1. Review `docs/slack/scope-review-packet.md` and remove any scope not needed for the first approved Method registry slice.
2. Create or update the Slack app from `docs/slack/prism-slack-app-manifest.template.yml` in Slack App Management, replacing only placeholders in the Slack UI.
3. Configure redirect URLs for the selected environments:
   - local: `http://localhost:3732/v1/slack/oauth/callback`
   - pilot host VM: `http://10.62.240.10:3732/v1/slack/oauth/callback`
   - dev tunnel: `https://<dev-tunnel-host>/v1/slack/oauth/callback`
   - hosted: `https://<prism-hostname>/v1/slack/oauth/callback` or `https://prism.<internal-domain>/v1/slack/oauth/callback`
4. Confirm Enterprise Grid org-ready deployment for the dev pilot. The committed manifest enables org deploy so org-level issues surface during development; production org rollout still requires explicit Slack admin/security approval.
5. Keep Socket Mode disabled for v1. Do not configure event subscriptions, slash commands, interactivity, workflows, incoming webhooks, canvases, lists, or file transfer.
6. Approve and install only after final scope review.
7. Record approved scopes, workspace/org target, and admin decision notes outside source control.
8. Store Slack client secret, signing secret, bot/user/refresh tokens, and any app-level token only in approved deployment secret storage. Do not commit, print, or paste them into docs.

## Enterprise Grid notes

Enterprise Grid governance remains Slack-admin controlled. Prism must not imply it can override Slack workspace, org, Okta, or security policy. The dev pilot enables org deploy to expose org-readiness issues early; production org-wide deployment remains a separate admin/security decision.

## Handoff to issue #4

Issue #4 may implement OAuth only after the approved redirect URI, token rotation posture, credential custody storage, and final Slack scope list are known. The OAuth implementation must preserve the selected redirect URI through authorize and token exchange.

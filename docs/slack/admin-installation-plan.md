# Slack Bridge installation and access

Prism serves multiple applications. Review the combined Slack permissions those applications need; keep each application's Prism token restricted to its own work. Slack credentials are encrypted and stored on the Prism server.

## Connect an organization or workspace

1. Approve Slack Bridge and its required permissions in Slack. Configure the exact callback URL used by Prism. Production callbacks must use HTTPS; see [internal HTTPS](internal-https.md).
2. Install Slack Bridge at the approved organization or workspace level. Prism detects the installation type from Slack's response; an organization connection can have no workspace ID.
3. For an organization installation, grant Slack Bridge access to the workspaces people need. Organization installation alone does not establish every workspace grant.
4. Check Member Permissions. If access is restricted, include the intended people or approved groups. No change is needed when the existing policy already allows them.
5. Have the person start a fresh Playtest sign-in. Prism reuses their existing Slack connection when possible. In Playtest, choose an available workspace and channel independently of the login identity.
6. Assign the appropriate Playtest role. Slack access alone does not grant Manager or Admin permission to manage playtests or send announcements.

Playtest's sign-in page contains the recovery steps above. The workspace and channel chooser shows guidance for empty results and connection failures. Some Slack policy screens never return to Prism, so Playtest cannot automatically identify the exact restriction on those screens.

Keep Slack client secrets and Slack bot, user, and refresh tokens in deployment secret storage. Do not put them in diagnostics, screenshots, source control, or support messages.

## Acceptance

Use a person who is allowed by Slack policy but is not a Slack app collaborator. Verify fresh sign-in, the intended workspace and channel, the person's Playtest role, and one explicitly authorized test announcement with its chosen sender. Automated tests use synthetic Slack responses and do not replace this enterprise acceptance check.

References: [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/), [Slack organization administration](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization).
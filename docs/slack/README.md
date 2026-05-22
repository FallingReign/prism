# Slack app setup packet

- `prism-slack-app-manifest.template.yml` — canonical placeholder-only Slack app manifest template.
- `scope-review-packet.md` — candidate v1 non-admin scopes, exclusions, and review checkpoints.
- `admin-installation-plan.md` — required human Slack admin/security approval and installation steps.

These artefacts are docs/config only. OAuth routes and encrypted credential custody are implemented by issue #4; Method registry and pre-forwarding policy enforcement are implemented by issue #7. Representative Slack-compatible forwarding is implemented by issue #9 with a default mocked upstream; admin/org, events, interactivity, and file content transfer remain deferred.

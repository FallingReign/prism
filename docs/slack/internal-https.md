# Internal HTTPS without a public domain

## Current decision and deployment status — 2026-09-04

Users must be able to open Prism and Playtest without installing a certificate. A new local certificate authority does not meet that requirement. The local-CA trial was stopped before changing either application's public URL. Production sign-in remains HTTP; R4 is not resolved. The operator declined the Windows trust prompt, and no root was installed on that account. The temporary Slack HTTPS callback was removed and the application trust overrides were moved out of Compose's automatic configuration path.

For browser-trusted HTTPS, use hostnames under an approved registered domain and a publicly trusted certificate. DNS-01 validation can issue and renew that certificate while both applications remain reachable only on the internal network; the certificate authority does not need an inbound connection to the VM. This needs control of the domain's public DNS validation records, plus DNS resolution of the application hostnames to the VM for users. An existing company certificate authority already trusted on every managed device is another possible route, but none has been identified.

Public certificate authorities cannot issue a certificate for the private IP address `10.62.240.10`. A local authority can issue one, but every client must first trust that authority. A web page cannot establish that trust automatically.

References: [Let's Encrypt DNS-01 validation](https://letsencrypt.org/docs/challenge-types/), [CA/Browser Forum certificate requirements](https://cabforum.org/working-groups/server/baseline-requirements/requirements/#422-approval-or-rejection-of-certificate-applications).

## Local-CA alternative — not selected

HTTPS can use a private IP address. A public domain, tunnel, or hosted service is not required. A local certificate authority signs the certificate, and every browser and server client must trust that authority. A company certificate authority is preferable when employee devices already trust it.

Caddy can run on the Linux VM, issue private-IP certificates with its local authority, and renew them automatically. This example is a proposed configuration, not a deployed change:

```caddyfile
https://10.62.240.10:8443 {
    tls internal
    reverse_proxy 127.0.0.1:3732
}

https://10.62.240.10:9443 {
    tls internal
    reverse_proxy 127.0.0.1:3847
}
```

The separate HTTPS ports keep each application's existing paths intact. Caddy's upstream addresses above assume it runs on the VM host; a container must instead use the appropriate private service addresses.

## Migration steps

1. Establish certificate trust. Distribute only the authority's public root certificate to managed employee devices and application clients. Keep the signing key private. Persist Caddy's certificate storage across restarts.
2. Start the HTTPS proxy and verify both health endpoints from an employee browser and the application containers, with certificate verification enabled.
3. Set Prism's public base URL to `https://10.62.240.10:8443`, its Slack callback to `https://10.62.240.10:8443/v1/slack/oauth/callback`, and `PRISM_OIDC_PLAYTEST_REDIRECT_URI` to `https://10.62.240.10:9443/api/auth/callback`. Register the exact Slack callback in Slack App Management.
4. Set Playtest's application base URL to `https://10.62.240.10:9443` and its Prism issuer/base URL to `https://10.62.240.10:8443`. Update any registered delegation callbacks and other Prism clients to the chosen HTTPS addresses. Node clients may need `NODE_EXTRA_CA_CERTS` pointing to the trusted public root certificate.
5. Restart the applications, sign in again, and verify workspace selection, the chosen announcement sender, and scheduled delivery. Confirm discovery advertises the HTTPS issuer and cookies use Secure.
6. Remove production private-HTTP opt-ins after all clients have moved. Bind or firewall the upstream HTTP ports so clients use the HTTPS entry points.

OAuth returns the user's browser to the callback, so that browser needs internal network access and certificate trust. This does not make the callback publicly accessible. Slack features that call a server directly have separate connectivity requirements.

Without distributing a trusted root or using an authority already trusted by clients, locally issued HTTPS will produce certificate errors. Do not disable certificate verification to work around them.

References: [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https), [Slack OAuth callback requirements](https://docs.slack.dev/authentication/installing-with-oauth/).

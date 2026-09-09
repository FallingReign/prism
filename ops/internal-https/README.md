# Internal HTTPS trial — inactive

The user requires browser-trusted HTTPS with no certificate installation for users. These local-CA configuration files were validated but do not meet that requirement. Do not enable them as the production solution.

On 2026-09-04 the dedicated `internal-https` proxy was started and then stopped. Both HTTPS health endpoints passed with the explicitly trusted public root, and the current application images could verify the same root. The CA survived a proxy restart. Windows certificate installation was declined; no root was installed. Application URL settings and running images were never changed. No application was restarted. No announcement was sent.

The VM retains the stopped trial at `/home/shgsylinux01/docker/internal-https`. The application overrides are staged as `docker-compose.https-staged.yml`, so normal Compose commands do not load them. The temporary HTTPS Slack redirect was removed. Restricted configuration, database, and CA backups are at `/home/shgsylinux01/docker/https-backups/20260904T125130Z`.

The `compose.yaml` pins the official Caddy 2.11.4 image. It runs as UID/GID 1001, binds only the VM IP on ports 8443/9443, uses persistent private CA storage, and exposes no admin API. `NET_BIND_SERVICE` remains in the capability bounding set because the official binary has that file capability; without it the non-root binary failed to execute. No host sudo or privileged container was used.

The log filter is present and configuration validation passed, but the synthetic upstream-error log check was stopped when the user rejected the local-CA approach. These files are retained as trial evidence, not as a completed deployment.

Next requirement: an approved registered domain and DNS validation access, or a certificate from an authority already trusted on employee devices. See [the HTTPS decision](../../docs/slack/internal-https.md) and [the architecture review](../../docs/implementation-reviews/internal-https-architecture-integration.md).

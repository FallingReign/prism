import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    const privateConfigurationHeaders = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://slack.com" }
    ];
    return [
      { source: "/setup", headers: privateConfigurationHeaders },
      { source: "/admin/configuration", headers: privateConfigurationHeaders }
    ];
  },
  logging: {
    // These browser endpoints carry OAuth/OIDC/delegation transaction material in the
    // query string. Do not persist it in Next's development request log.
    incomingRequests: {
      ignore: [
        /^\/oauth\/authorize(?:[/?]|$)/,
        /^\/delegations\/slack-message\/authorize(?:[/?]|$)/,
        /^\/local-app\/authorize(?:[/?]|$)/,
        /^\/v1\/slack\/oauth\/start(?:[/?]|$)/,
        /^\/v1\/slack\/oauth\/callback(?:[/?]|$)/,
        // Setup requests can contain a one-time host capability or Slack app
        // credential material in their request body. Ignore the entire route
        // family so development logging never grows more detailed around it.
        /^\/v1\/prism\/setup(?:[/?]|$)/,
      ],
    },
  },
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url))
  }
};

export default nextConfig;

import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  devIndicators: false,
  logging: {
    // These browser endpoints carry OAuth/OIDC/delegation transaction material in the
    // query string. Do not persist it in Next's development request log.
    incomingRequests: {
      ignore: [
        /^\/oauth\/authorize(?:[/?]|$)/,
        /^\/delegations\/slack-message\/authorize(?:[/?]|$)/,
        /^\/v1\/slack\/oauth\/start(?:[/?]|$)/,
        /^\/v1\/slack\/oauth\/callback(?:[/?]|$)/,
      ],
    },
  },
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url))
  }
};

export default nextConfig;

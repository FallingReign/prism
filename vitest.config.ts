import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(rootDir),
      "server-only": "./test/server-only-stub.ts"
    }
  },
  test: {
    environment: "node",
    globals: false
  }
});

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
    // Avoid worker starvation in the complete Windows quality check.
    ...(process.platform === "win32" ? { maxWorkers: 1 } : {}),
    globals: false
  }
});

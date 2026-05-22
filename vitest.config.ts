import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "server-only": "./test/server-only-stub.ts"
    }
  },
  test: {
    environment: "node",
    globals: false
  }
});

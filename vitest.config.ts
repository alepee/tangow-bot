import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "infra/sandboxes/computer/e2b/**/*.test.ts",
      "infra/sandboxes/supervisor/src/**/*.test.ts",
      "infra/updater/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/desktop-new/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/mobile/lib/**/*.test.ts",
      "apps/mobile/plugins/**/*.test.js",
      "apps/api/src/**/*.test.ts",
      "apps/agent-run-worker/src/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

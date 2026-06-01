import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentrewind/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-anthropic": new URL("./packages/codec-anthropic/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-openai": new URL("./packages/codec-openai/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-openrouter": new URL("./packages/codec-openrouter/src/index.ts", import.meta.url).pathname,
      "@agentrewind/test": new URL("./packages/test/src/index.ts", import.meta.url).pathname,
      "@agentrewind/sdk/advanced": new URL("./packages/sdk/src/advanced.ts", import.meta.url).pathname,
      "@agentrewind/sdk/codecs": new URL("./packages/sdk/src/codecs.ts", import.meta.url).pathname,
      "@agentrewind/sdk/providers": new URL("./packages/sdk/src/providers.ts", import.meta.url).pathname,
      "@agentrewind/sdk/testing": new URL("./packages/sdk/src/testing.ts", import.meta.url).pathname,
      "@agentrewind/sdk": new URL("./packages/sdk/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 45000,
    teardownTimeout: 10000,
    slowTestThreshold: 1000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75
      }
    }
  }
});

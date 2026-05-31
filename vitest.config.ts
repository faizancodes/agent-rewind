import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agentrewind/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-anthropic": new URL("./packages/codec-anthropic/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-openai": new URL("./packages/codec-openai/src/index.ts", import.meta.url).pathname,
      "@agentrewind/codec-openrouter": new URL("./packages/codec-openrouter/src/index.ts", import.meta.url).pathname,
      "@agentrewind/test": new URL("./packages/test/src/index.ts", import.meta.url).pathname,
      agentrewind: new URL("./packages/agentrewind/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 10000
  }
});

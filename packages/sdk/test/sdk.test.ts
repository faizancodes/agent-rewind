import { describe, expect, it } from "vitest";
import {
  AgentRewind,
  Anthropic,
  OpenAI,
  anthropicCodec,
  assertProviderClient,
  openRouterChatCodec,
  openRouterClientOptions,
  openaiChatCodec,
  type AnthropicMessage,
  type ChatCompletion
} from "@agentrewind/sdk";
import { assertReplay } from "@agentrewind/sdk/testing";

describe("@agentrewind/sdk", () => {
  it("keeps the root import focused while exposing tests through a subpath", () => {
    const openai = new OpenAI({ apiKey: "test-key" });
    const openrouter = new OpenAI(openRouterClientOptions({ apiKey: "test-key" }));
    const anthropic = new Anthropic({ apiKey: "test-key" });

    assertProviderClient(openai, openaiChatCodec());
    assertProviderClient(openrouter, openRouterChatCodec());
    assertProviderClient(anthropic, anthropicCodec());

    expect(typeof AgentRewind.recordRun).toBe("function");
    expect(typeof assertReplay).toBe("function");
  });

  it("re-exports provider response types for type-only imports", () => {
    const chat = null as ChatCompletion | null;
    const message = null as AnthropicMessage | null;

    expect(chat).toBeNull();
    expect(message).toBeNull();
  });
});

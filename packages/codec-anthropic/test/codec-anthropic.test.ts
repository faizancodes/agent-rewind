import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { AgentRewind } from "@agentrewind/core";
import { anthropicCodec } from "../src/index.js";

describe("anthropicCodec", () => {
  it("round-trips request/response/stream against SDK-shaped fixtures", async () => {
    const codec = anthropicCodec();
    const request = {
      model: "claude-opus-4-8",
      max_tokens: 64,
      system: "Be concise",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 1
    };
    const normalized = codec.normalizeRequest(request);
    expect(normalized).toMatchObject({
      model: request.model,
      system: "Be concise",
      messages: [{ role: "user", content: "Hello" }]
    });
    expect(codec.denormalizeRequest(normalized)).toMatchObject(request);

    const response = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: request.model,
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 }
    };
    expect(codec.normalizeResponse(response).usage).toEqual({ inputTokens: 5, outputTokens: 2 });

    const stream = [
      { type: "message_start", message: { ...response, content: [], stop_reason: null, usage: { ...response.usage, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null },
        usage: { output_tokens: 3 }
      },
      { type: "message_stop" }
    ];
    const normalizedStream = codec.normalizeStream(stream);
    expect(normalizedStream.final.content).toEqual([{ type: "text", text: "Hello", citations: null }]);
    const rebuilt: unknown[] = [];
    for await (const chunk of codec.rebuildStream(normalizedStream.chunks)) {
      rebuilt.push(chunk);
    }
    expect(rebuilt).toEqual(stream);
  });

  it("preserves empty system prompts and accumulates streaming citations", () => {
    const codec = anthropicCodec();
    expect(codec.denormalizeRequest(codec.normalizeRequest({ model: "claude-opus-4-8", system: "", messages: [] }))).toMatchObject({
      system: ""
    });

    const stream = [
      {
        type: "message_start",
        message: {
          id: "msg_citations",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 }
        }
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: [] } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://a.example", cited_text: "a" } }
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://b.example", cited_text: "b" } }
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null },
        usage: { output_tokens: 1 }
      },
      { type: "message_stop" }
    ];
    expect(codec.normalizeStream(stream).final.content).toEqual([
      {
        type: "text",
        text: "",
        citations: [
          { type: "web_search_result_location", url: "https://a.example", cited_text: "a" },
          { type: "web_search_result_location", url: "https://b.example", cited_text: "b" }
        ]
      }
    ]);
  });

  it("forks Anthropic Messages through the live tail client with overrides", async () => {
    const codec = anthropicCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-anthropic-fork-"));
    const request = {
      model: "claude-opus-4-8",
      max_tokens: 64,
      system: "Follow the old escalation policy.",
      messages: [{ role: "user", content: "Enterprise refund request" }],
      metadata: { trace: "volatile-record-id" }
    };
    let recordCalls = 0;
    const recordModel = {
      messages: {
        async create(raw: unknown) {
          recordCalls += 1;
          expect(raw).toMatchObject(request);
          return anthropicMessage("msg_record", request.model, "deny", { input_tokens: 7, output_tokens: 1 });
        }
      }
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const message = await ctx.model.create<AnthropicMessageFixture>(request, { site: "refund-decision" });
      return textFromAnthropicMessage(message);
    };

    const record = AgentRewind.record({
      id: "anthropic-fork",
      store,
      model: recordModel,
      codec
    });
    expect(await record.run(harness)).toBe("deny");
    await record.close();

    const replay = await AgentRewind.replay(join(store, "anthropic-fork"), { codec });
    expect(await replay.run(harness)).toBe("deny");
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
    expect(modelStep).toBeDefined();

    const liveRequests: unknown[] = [];
    const liveModel = {
      messages: {
        async create(raw: unknown) {
          liveRequests.push(raw);
          return anthropicMessage("msg_fork", "claude-sonnet-4-5", "approve", { input_tokens: 12, output_tokens: 4 });
        }
      }
    };
    const fork = await replay.fork({
      atStep: modelStep!,
      model: liveModel,
      overrides: {
        system: "Follow the corrected enterprise refund policy.",
        model: "claude-sonnet-4-5"
      },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")
    });

    expect(recordCalls).toBe(1);
    expect(liveRequests).toHaveLength(1);
    expect(liveRequests[0]).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      system: "Follow the corrected enterprise refund policy.",
      messages: [{ role: "user", content: "Enterprise refund request" }],
      metadata: { trace: "volatile-record-id" }
    });
    expect(fork.reachedGoal).toBe(true);
    expect(fork.tokensSpent).toEqual({ inputTokens: 12, outputTokens: 4 });

    const child = await AgentRewind.summary(fork.sessionId, { store });
    expect(child).toMatchObject({
      provider: "anthropic",
      parent: "anthropic-fork",
      forkedAtStep: modelStep,
      counts: { modelCalls: 1 }
    });

    const childReplay = await AgentRewind.replay(join(store, fork.sessionId), { codec });
    await childReplay.run(async (ctx) => {
      const message = await ctx.model.create<AnthropicMessageFixture>(liveRequests[0], { site: "refund-decision" });
      expect(textFromAnthropicMessage(message)).toBe("approve");
    });
  });

  (liveAnthropicEnabled() ? it : it.skip)("live fork smoke test against the Anthropic API", async () => {
    const codec = anthropicCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-live-anthropic-fork-"));
    const model = new Anthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") });
    const request = {
      model: requiredEnv("ANTHROPIC_MODEL"),
      max_tokens: 16,
      system: "Answer with one short word.",
      messages: [{ role: "user", content: "Say ok." }]
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const message = await ctx.model.create<AnthropicMessageFixture>(request, { site: "live-anthropic-fork" });
      return textFromAnthropicMessage(message);
    };

    const record = AgentRewind.record({
      id: "live-anthropic-fork",
      store,
      model,
      codec
    });
    const recorded = await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "live-anthropic-fork"), { codec });
    await expect(replay.run(harness)).resolves.toBe(recorded);
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
    expect(modelStep).toBeDefined();

    const fork = await replay.fork({
      atStep: modelStep!,
      model,
      overrides: {
        system: "Answer with one short word: forked."
      },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")
    });

    expect(fork.reachedGoal).toBe(true);
    expect(fork.trace.events()).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "model_call", provider: "anthropic", provenance: "live" })])
    );
  }, 60_000);
});

function anthropicMessage(id: string, model: string, text: string, usage: { input_tokens: number; output_tokens: number }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: usage.input_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: usage.output_tokens
    }
  };
}

function textFromAnthropicMessage(message: AnthropicMessageFixture): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

interface AnthropicMessageFixture {
  content: Array<{ type: string; text?: string }>;
}

function liveAnthropicEnabled(): boolean {
  return Boolean(process.env.AGENTREWIND_LIVE_PROVIDER_FORKS === "1" && process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it before running live provider fork smoke tests.`);
  }
  return value;
}

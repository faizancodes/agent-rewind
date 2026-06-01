import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { AgentRewind, type ProviderCodec } from "@agentrewind/core";
import { OPENROUTER_BASE_URL, openRouterChatCodec, openRouterClientOptions } from "../src/index.js";

describe("openRouterChatCodec", () => {
  it("uses OpenRouter identity while preserving OpenAI-compatible Chat Completions behavior", async () => {
    const codec = openRouterChatCodec();
    expect(codec.name).toBe("openrouter-chat");
    expect(codec.interceptPoints).toEqual(["chat.completions.create", "chat.completions.stream"]);

    const request = {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Return compact JSON." },
        { role: "user", content: "Classify this ticket." }
      ],
      temperature: 0,
      metadata: { trace: "volatile" },
      provider: {
        order: ["OpenAI"],
        allow_fallbacks: false
      },
      plugins: [{ id: "response-healing" }],
      response_format: { type: "json_object" }
    };

    const normalized = codec.normalizeRequest(request);
    expect(normalized).toMatchObject({
      model: "openai/gpt-4o-mini",
      system: "Return compact JSON.",
      params: {
        temperature: 0,
        metadata: { trace: "volatile" },
        provider: { order: ["OpenAI"], allow_fallbacks: false },
        plugins: [{ id: "response-healing" }],
        response_format: { type: "json_object" }
      }
    });
    expect(codec.stripVolatile(normalized).params).not.toHaveProperty("metadata");
    expect(codec.stripVolatile(normalized).params).toHaveProperty("provider");
    expect(codec.denormalizeRequest(normalized)).toMatchObject(request);
    expect(
      codec.denormalizeRequest(
        codec.applyOverrides(normalized, { system: "Prefer escalation accuracy.", model: "anthropic/claude-haiku-4.5" }, 0)
      )
    ).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: "Prefer escalation accuracy." },
        { role: "user", content: "Classify this ticket." }
      ]
    });
  });

  it("builds OpenAI SDK options for OpenRouter attribution headers", () => {
    expect(
      openRouterClientOptions({
        apiKey: "test-key",
        appUrl: "https://agentrewind.dev",
        appTitle: "AgentRewind",
        appCategories: ["cli-agent", "debugging"],
        extraHeaders: { "X-Custom": "yes" }
      })
    ).toEqual({
      apiKey: "test-key",
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "X-Custom": "yes",
        "HTTP-Referer": "https://agentrewind.dev",
        "X-OpenRouter-Title": "AgentRewind",
        "X-OpenRouter-Categories": "cli-agent,debugging"
      }
    });
  });

  it("records and replays OpenRouter chat completions and streams", async () => {
    const codec = openRouterChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-openrouter-"));
    const request = {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Hello OpenRouter" }],
      provider: { allow_fallbacks: true }
    };
    const stream = [chunk("gen_stream", { role: "assistant", content: "A" }), chunk("gen_stream", { content: "B" }, "stop")];
    let createCalls = 0;
    let streamCalls = 0;
    const model = {
      chat: {
        completions: {
          async create(raw: unknown) {
            createCalls += 1;
            expect(raw).toMatchObject(request);
            return chatCompletion("gen_record", "Recorded", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
          },
          stream(raw: unknown) {
            streamCalls += 1;
            expect(raw).toMatchObject(request);
            return asyncIterable(stream);
          }
        }
      }
    };
    const record = AgentRewind.record({
      id: "openrouter",
      store,
      model,
      codec: codec as ProviderCodec
    });
    await record.run(async (ctx) => {
      const response = (await ctx.model.create(request, { site: "chat" })) as OpenRouterChatFixture;
      expect(response.choices?.[0]?.message?.content).toBe("Recorded");
      const chunks: unknown[] = [];
      for await (const event of ctx.model.stream(request, { site: "chat-stream" })) {
        chunks.push(event);
      }
      expect(chunks).toEqual(stream);
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "openrouter"), { codec: codec as ProviderCodec });
    await replay.run(async (ctx) => {
      const response = (await ctx.model.create(request, { site: "chat" })) as OpenRouterChatFixture;
      expect(response.choices?.[0]?.message?.content).toBe("Recorded");
      const chunks: unknown[] = [];
      for await (const event of ctx.model.stream(request, { site: "chat-stream" })) {
        chunks.push(event);
      }
      expect(chunks).toEqual(stream);
    });
    expect(createCalls).toBe(1);
    expect(streamCalls).toBe(1);
  });

  it("forks OpenRouter Chat Completions through the live tail client with provider options intact", async () => {
    const codec = openRouterChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-openrouter-fork-"));
    const request = {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Follow the old routing policy." },
        { role: "user", content: "Route a duplicate invoice ticket." }
      ],
      temperature: 0,
      provider: {
        order: ["OpenAI"],
        allow_fallbacks: true
      },
      plugins: [{ id: "response-healing" }],
      response_format: { type: "json_object" },
      metadata: { trace: "volatile-record-id" }
    };
    let recordCalls = 0;
    const recordModel = {
      chat: {
        completions: {
          async create(raw: unknown) {
            recordCalls += 1;
            expect(raw).toMatchObject(request);
            return chatCompletion("gen_record", "{\"queue\":\"billing\"}", { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
          }
        }
      }
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const response = await ctx.model.create<OpenRouterChatFixture>(request, { site: "ticket-route" });
      return response.choices?.[0]?.message?.content ?? "";
    };

    const record = AgentRewind.record({
      id: "openrouter-fork",
      store,
      model: recordModel,
      codec: codec as ProviderCodec
    });
    expect(await record.run(harness)).toBe("{\"queue\":\"billing\"}");
    await record.close();

    const replay = await AgentRewind.replay(join(store, "openrouter-fork"), { codec: codec as ProviderCodec });
    expect(await replay.run(harness)).toBe("{\"queue\":\"billing\"}");
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
    expect(modelStep).toBeDefined();

    const liveRequests: unknown[] = [];
    const liveModel = {
      chat: {
        completions: {
          async create(raw: unknown) {
            liveRequests.push(raw);
            return chatCompletion("gen_fork", "{\"queue\":\"billing-integrity\"}", {
              prompt_tokens: 13,
              completion_tokens: 4,
              total_tokens: 17
            });
          }
        }
      }
    };
    const fork = await replay.fork({
      atStep: modelStep!,
      model: liveModel,
      overrides: {
        system: "Follow the corrected billing-integrity routing policy.",
        model: "anthropic/claude-haiku-4.5"
      },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")
    });

    expect(recordCalls).toBe(1);
    expect(liveRequests).toHaveLength(1);
    expect(liveRequests[0]).toMatchObject({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: "Follow the corrected billing-integrity routing policy." },
        { role: "user", content: "Route a duplicate invoice ticket." }
      ],
      temperature: 0,
      provider: {
        order: ["OpenAI"],
        allow_fallbacks: true
      },
      plugins: [{ id: "response-healing" }],
      response_format: { type: "json_object" },
      metadata: { trace: "volatile-record-id" }
    });
    expect(fork.reachedGoal).toBe(true);
    expect(fork.tokensSpent).toEqual({ inputTokens: 13, outputTokens: 4 });

    const child = await AgentRewind.summary(fork.sessionId, { store });
    expect(child).toMatchObject({
      provider: "openrouter-chat",
      parent: "openrouter-fork",
      forkedAtStep: modelStep,
      counts: { modelCalls: 1 }
    });

    const childReplay = await AgentRewind.replay(join(store, fork.sessionId), { codec: codec as ProviderCodec });
    await childReplay.run(async (ctx) => {
      const response = await ctx.model.create<OpenRouterChatFixture>(liveRequests[0], { site: "ticket-route" });
      expect(response.choices?.[0]?.message?.content).toBe("{\"queue\":\"billing-integrity\"}");
    });
  });

  (liveOpenRouterEnabled() ? it : it.skip)("live fork smoke test against the OpenRouter API", async () => {
    const codec = openRouterChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-live-openrouter-fork-"));
    const model = new OpenAI(
      openRouterClientOptions({
        apiKey: requiredEnv("OPENROUTER_API_KEY"),
        appTitle: "AgentRewind live fork smoke test"
      })
    );
    const request = {
      model: requiredEnv("OPENROUTER_MODEL"),
      messages: [
        { role: "system", content: "Answer with one short word." },
        { role: "user", content: "Say ok." }
      ],
      temperature: 0,
      max_tokens: 8,
      provider: { allow_fallbacks: true }
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const response = await ctx.model.create<OpenRouterChatFixture>(request, { site: "live-openrouter-fork" });
      return String(response.choices?.[0]?.message?.content ?? "");
    };

    const record = AgentRewind.record({
      id: "live-openrouter-fork",
      store,
      model,
      codec: codec as ProviderCodec
    });
    const recorded = await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "live-openrouter-fork"), { codec: codec as ProviderCodec });
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
      expect.arrayContaining([expect.objectContaining({ kind: "model_call", provider: "openrouter-chat", provenance: "live" })])
    );
  }, 60_000);
});

function chatCompletion(id: string, content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "openai/gpt-4o-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content, refusal: null }
      }
    ],
    ...(usage ? { usage } : {})
  };
}

function chunk(
  id: string,
  delta: { role?: "assistant"; content?: string },
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null = null
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 2,
    model: "openai/gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

async function* asyncIterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

interface OpenRouterChatFixture {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function liveOpenRouterEnabled(): boolean {
  return Boolean(
    process.env.AGENTREWIND_LIVE_PROVIDER_FORKS === "1" && process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it before running live provider fork smoke tests.`);
  }
  return value;
}

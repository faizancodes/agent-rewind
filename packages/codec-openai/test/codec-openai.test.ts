import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { AgentRewind, type ProviderCodec } from "@agentrewind/core";
import { openaiChatCodec } from "../src/index.js";

describe("openaiChatCodec", () => {
  it("round-trips chat request/response/stream against OpenAI-shaped fixtures", async () => {
    const codec = openaiChatCodec();
    const request = {
      model: "gpt-5.5",
      messages: [
        { role: "developer", content: "Be concise" },
        { role: "user", content: "Hello" }
      ],
      temperature: 0.2,
      metadata: { trace: "volatile" }
    };
    const normalized = codec.normalizeRequest(request);
    expect(normalized).toMatchObject({
      model: request.model,
      system: "Be concise",
      messages: [
        { role: "developer", content: "Be concise" },
        { role: "user", content: "Hello" }
      ],
      params: { temperature: 0.2, metadata: { trace: "volatile" } }
    });
    expect(codec.stripVolatile(normalized).params).not.toHaveProperty("metadata");
    expect(codec.denormalizeRequest(normalized)).toMatchObject(request);
    expect(codec.denormalizeRequest(codec.applyOverrides(normalized, { system: "Be exact", model: "gpt-4.1" }, 0))).toMatchObject({
      model: "gpt-4.1",
      messages: [
        { role: "developer", content: "Be exact" },
        { role: "user", content: "Hello" }
      ]
    });

    const response = chatCompletion("chatcmpl_1", "Hi", { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    const normalizedResponse = codec.normalizeResponse(response);
    expect(normalizedResponse).toMatchObject({
      stopReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2 },
      content: { role: "assistant", content: "Hi" }
    });

    const stream = [
      chunk("chatcmpl_2", { role: "assistant", content: "" }),
      chunk("chatcmpl_2", { content: "Hel" }),
      chunk("chatcmpl_2", { content: "lo" }, "stop"),
      {
        id: "chatcmpl_2",
        object: "chat.completion.chunk",
        created: 2,
        model: "gpt-5.5",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }
      }
    ];
    const normalizedStream = codec.normalizeStream(stream);
    expect(normalizedStream.final).toMatchObject({
      stopReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
      content: { role: "assistant", content: "Hello" }
    });
    const rebuilt: unknown[] = [];
    for await (const event of codec.rebuildStream(normalizedStream.chunks)) {
      rebuilt.push(event);
    }
    expect(rebuilt).toEqual(stream);
  });

  it("records and replays OpenAI-compatible chat completions and streams", async () => {
    const codec = openaiChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-openai-"));
    const request = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Hello" }]
    };
    const stream = [chunk("chatcmpl_stream", { role: "assistant", content: "A" }), chunk("chatcmpl_stream", { content: "B" }, "stop")];
    const model = {
      chat: {
        completions: {
          async create() {
            return chatCompletion("chatcmpl_record", "Recorded", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
          },
          stream() {
            return asyncIterable(stream);
          }
        }
      }
    };
    const record = AgentRewind.record({
      id: "openai-compatible",
      store,
      model,
      codec: codec as ProviderCodec
    });
    await record.run(async (ctx) => {
      const response = (await ctx.model.create(request, { site: "chat" })) as OpenAIChatFixture;
      expect(response.choices?.[0]?.message?.content).toBe("Recorded");
      const chunks: unknown[] = [];
      for await (const event of ctx.model.stream(request, { site: "chat-stream" })) {
        chunks.push(event);
      }
      expect(chunks).toEqual(stream);
    });
    await record.close();

    const replay = await AgentRewind.replay(join(store, "openai-compatible"), { codec: codec as ProviderCodec });
    await replay.run(async (ctx) => {
      const response = (await ctx.model.create(request, { site: "chat" })) as OpenAIChatFixture;
      expect(response.choices?.[0]?.message?.content).toBe("Recorded");
      const chunks: unknown[] = [];
      for await (const event of ctx.model.stream(request, { site: "chat-stream" })) {
        chunks.push(event);
      }
      expect(chunks).toEqual(stream);
    });
  });

  it("assembles streaming logprobs and partial tool call deltas across chunks", () => {
    const codec = openaiChatCodec();
    const stream = [
      {
        id: "chatcmpl_tools",
        object: "chat.completion.chunk",
        created: 2,
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, function: { arguments: "{\"a\"" } }]
            },
            finish_reason: null,
            logprobs: { content: [{ token: "{\"a\"" }] }
          }
        ]
      },
      {
        id: "chatcmpl_tools",
        object: "chat.completion.chunk",
        created: 2,
        model: "gpt-5.5",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: ":1}" } }]
            },
            finish_reason: "tool_calls",
            logprobs: { content: [{ token: ":1}" }] }
          }
        ]
      }
    ];

    const final = codec.normalizeStream(stream).final.raw as {
      choices: Array<{
        logprobs?: { content?: Array<{ token: string }> };
        message: { tool_calls?: Array<{ function: { arguments: string } }> };
      }>;
    };
    expect(final.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe("{\"a\":1}");
    expect(final.choices[0]?.logprobs?.content?.map((entry) => entry.token)).toEqual(["{\"a\"", ":1}"]);
  });

  it("forks OpenAI Chat Completions through the live tail client with overrides", async () => {
    const codec = openaiChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-openai-fork-"));
    const request = {
      model: "gpt-5.5",
      messages: [
        { role: "developer", content: "Follow the old routing policy." },
        { role: "user", content: "Enterprise refund request" }
      ],
      temperature: 0,
      metadata: { trace: "volatile-record-id" }
    };
    let recordCalls = 0;
    const recordModel = {
      chat: {
        completions: {
          async create(raw: unknown) {
            recordCalls += 1;
            expect(raw).toMatchObject(request);
            return chatCompletion("chatcmpl_record", "deny", { prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 });
          }
        }
      }
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const response = await ctx.model.create<OpenAIChatFixture>(request, { site: "refund-decision" });
      return response.choices?.[0]?.message?.content ?? "";
    };

    const record = AgentRewind.record({
      id: "openai-fork",
      store,
      model: recordModel,
      codec: codec as ProviderCodec
    });
    expect(await record.run(harness)).toBe("deny");
    await record.close();

    const replay = await AgentRewind.replay(join(store, "openai-fork"), { codec: codec as ProviderCodec });
    expect(await replay.run(harness)).toBe("deny");
    const modelStep = replay.events().find((event) => event.kind === "model_call")?.step;
    expect(modelStep).toBeDefined();

    const liveRequests: unknown[] = [];
    const liveModel = {
      chat: {
        completions: {
          async create(raw: unknown) {
            liveRequests.push(raw);
            return chatCompletion("chatcmpl_fork", "approve", { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
          }
        }
      }
    };
    const fork = await replay.fork({
      atStep: modelStep!,
      model: liveModel,
      overrides: {
        system: "Follow the corrected enterprise refund policy.",
        model: "gpt-4.1"
      },
      goal: (trace) => trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")
    });

    expect(recordCalls).toBe(1);
    expect(liveRequests).toHaveLength(1);
    expect(liveRequests[0]).toMatchObject({
      model: "gpt-4.1",
      messages: [
        { role: "developer", content: "Follow the corrected enterprise refund policy." },
        { role: "user", content: "Enterprise refund request" }
      ],
      temperature: 0,
      metadata: { trace: "volatile-record-id" }
    });
    expect(fork.reachedGoal).toBe(true);
    expect(fork.tokensSpent).toEqual({ inputTokens: 11, outputTokens: 3 });

    const child = await AgentRewind.summary(fork.sessionId, { store });
    expect(child).toMatchObject({
      provider: "openai-chat",
      parent: "openai-fork",
      forkedAtStep: modelStep,
      counts: { modelCalls: 1 }
    });

    const childReplay = await AgentRewind.replay(join(store, fork.sessionId), { codec: codec as ProviderCodec });
    await childReplay.run(async (ctx) => {
      const response = await ctx.model.create<OpenAIChatFixture>(liveRequests[0], { site: "refund-decision" });
      expect(response.choices?.[0]?.message?.content).toBe("approve");
    });
  });

  (liveOpenAIEnabled() ? it : it.skip)("live fork smoke test against the OpenAI API", async () => {
    const codec = openaiChatCodec();
    const store = await mkdtemp(join(tmpdir(), "agentrewind-live-openai-fork-"));
    const model = new OpenAI({ apiKey: requiredEnv("OPENAI_API_KEY") });
    const request = {
      model: requiredEnv("OPENAI_MODEL"),
      messages: [
        { role: "system", content: "Answer with one short word." },
        { role: "user", content: "Say ok." }
      ],
      temperature: 0,
      max_tokens: 8
    };
    const harness = async (ctx: { model: { create<T>(req: unknown, opts?: { site?: string }): Promise<T> } }) => {
      const response = await ctx.model.create<OpenAIChatFixture>(request, { site: "live-openai-fork" });
      return String(response.choices?.[0]?.message?.content ?? "");
    };

    const record = AgentRewind.record({
      id: "live-openai-fork",
      store,
      model,
      codec: codec as ProviderCodec
    });
    const recorded = await record.run(harness);
    await record.close();

    const replay = await AgentRewind.replay(join(store, "live-openai-fork"), { codec: codec as ProviderCodec });
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
      expect.arrayContaining([expect.objectContaining({ kind: "model_call", provider: "openai-chat", provenance: "live" })])
    );
  }, 60_000);
});

function chatCompletion(id: string, content: string, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    id,
    object: "chat.completion",
    created: 1,
    model: "gpt-5.5",
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
    model: "gpt-5.5",
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

async function* asyncIterable(values: unknown[]): AsyncIterable<unknown> {
  for (const value of values) {
    yield value;
  }
}

interface OpenAIChatFixture {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function liveOpenAIEnabled(): boolean {
  return Boolean(process.env.AGENTREWIND_LIVE_PROVIDER_FORKS === "1" && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it before running live provider fork smoke tests.`);
  }
  return value;
}

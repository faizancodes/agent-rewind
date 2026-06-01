# Provider Setup

Use this reference when choosing or wiring a provider for AgentRewind.

## Install

```sh
npm install @agentrewind/sdk
```

That one package includes the SDK runtime, CLI, built-in provider codecs, OpenAI client, Anthropic client, and replay test helpers. AgentRewind is ESM-only and requires Node 20 or newer.

Prefer provider presets for application code:

| Provider shape | Preset |
| --- | --- |
| OpenAI Chat Completions | `createOpenAIRewind()` |
| OpenAI-compatible `baseURL` provider | `createOpenAICompatibleRewind()` |
| OpenRouter through the OpenAI SDK shape | `createOpenRouterRewind()` |
| Anthropic Messages | `createAnthropicRewind()` |

The presets bind the provider client and codec once. They also type `ctx.model.create(req)` and `ctx.model.stream(req)` from the selected codec.

## OpenAI Chat Completions

```ts
import { createOpenAIRewind, defineHarness } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const rewind = createOpenAIRewind({
  apiKey: process.env.OPENAI_API_KEY,
  store: ".rewind"
});

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: process.env.OPENAI_MODEL ?? "gpt-5.5",
      messages: [{ role: "user", content: "Summarize this ticket." }],
      temperature: 0
    },
    { site: "summarize-ticket" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const recorded = await rewind.recordRun({ id: "openai-demo" }, harness);
await rewind.replayRun(recorded.path, harness);
```

When `apiKey` is omitted, the preset reads `OPENAI_API_KEY`.

## OpenAI-Compatible Provider

Use this for providers that expose OpenAI Chat Completions through a custom `baseURL`.

```ts
import { createOpenAICompatibleRewind, defineHarness } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const rewind = createOpenAICompatibleRewind({
  apiKey: process.env.COMPATIBLE_API_KEY,
  baseURL: process.env.COMPATIBLE_BASE_URL,
  store: ".rewind"
});

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: process.env.COMPATIBLE_MODEL ?? "provider/model",
      messages: [{ role: "user", content: "Draft a short reply." }]
    },
    { site: "draft-reply" }
  );

  return completion.choices[0]?.message.content ?? "";
});
```

When omitted, the preset reads `COMPATIBLE_API_KEY` and `COMPATIBLE_BASE_URL`.

## OpenRouter

OpenRouter has first-class support through `createOpenRouterRewind()`. It uses the OpenAI SDK method shape, but records the provider as OpenRouter and applies OpenRouter defaults.

```ts
import { createOpenRouterRewind, defineHarness } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const rewind = createOpenRouterRewind({
  apiKey: process.env.OPENROUTER_API_KEY,
  appUrl: "https://your-app.example",
  appTitle: "Your Agent",
  store: ".rewind"
});

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Classify this support ticket." }],
      provider: { sort: "throughput" }
    },
    { site: "classify-ticket" }
  );

  return completion.choices[0]?.message.content ?? "";
});
```

When `apiKey` is omitted, the preset reads `OPENROUTER_API_KEY`. OpenRouter-specific Chat Completions parameters such as `provider`, `plugins`, `response_format`, and `metadata` can be included in the request. Routing, plugin, and format parameters are preserved for fork tail calls; volatile metadata is treated carefully for fingerprints.

## Anthropic Messages

```ts
import { createAnthropicRewind, defineHarness } from "@agentrewind/sdk";
import type { AnthropicMessage } from "@agentrewind/sdk";

const rewind = createAnthropicRewind({
  apiKey: process.env.ANTHROPIC_API_KEY,
  store: ".rewind"
});

const harness = defineHarness(async (ctx) => {
  const message = await ctx.model.create<AnthropicMessage>(
    {
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: "Write a concise status update." }]
    },
    { site: "status-update" }
  );

  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
});
```

When `apiKey` is omitted, the preset reads `ANTHROPIC_API_KEY`.

## Existing Clients Or Manual Codecs

Use `AgentRewind.withProvider()` when the app already constructs the SDK client or when you need an explicit codec:

```ts
import { AgentRewind, OpenAI, assertProviderClient, openaiChatCodec } from "@agentrewind/sdk";

const model = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.COMPATIBLE_BASE_URL
});
const codec = openaiChatCodec();

assertProviderClient(model, codec);

const rewind = AgentRewind.withProvider({
  store: ".rewind",
  model,
  codec
});
```

For streaming-first workflows, validate the streaming method path too:

```ts
assertProviderClient(model, codec, ["stream"]);
```

Use lower-level `AgentRewind.record()` or `AgentRewind.recordRun()` directly only when you need manual session control:

```ts
const recorded = await AgentRewind.recordRun(
  {
    id: "manual-demo",
    store: ".rewind",
    model,
    codec
  },
  harness
);

await AgentRewind.replayRun(recorded.path, { codec }, harness);
```

## Typed Model Calls

With provider presets or `withProvider()` generics, `ctx.model.create(req)` should infer the provider request and response shape. Explicit result generics are still useful in advanced code:

```ts
import type { ChatCompletion, ChatCompletionChunk } from "@agentrewind/sdk";

const completion = await ctx.model.create<ChatCompletion>(request, {
  site: "typed-call"
});

for await (const chunk of ctx.model.stream<ChatCompletionChunk>(request, {
  site: "stream-answer"
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Custom Providers

If a provider does not match a built-in method path, implement `ProviderCodec`. During setup, validate the shape and fixture behavior:

```ts
import { assertCodecConformance, assertProviderCodec } from "@agentrewind/sdk";

assertProviderCodec(codec);
await assertCodecConformance(codec, {
  request: providerRequestFixture,
  response: providerResponseFixture,
  streamChunks: providerStreamChunkFixtures
});
```

Keep `denormalizeRequest()` symmetric with `normalizeRequest()` so fork and live tail calls work.

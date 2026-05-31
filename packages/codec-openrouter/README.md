# @agentrewind/codec-openrouter

First-class OpenRouter Chat Completions support for AgentRewind.

OpenRouter exposes an OpenAI-compatible Chat Completions API at
`https://openrouter.ai/api/v1`. This package gives that integration its own
AgentRewind provider identity, OpenRouter constants, and OpenAI SDK client
option helper.

## Install

Most users get this codec through the SDK:

```sh
npm install @agentrewind/sdk
```

Use this package directly only when a library needs granular dependency
boundaries.

## Recording

```ts
import {
  AgentRewind,
  OpenAI,
  assertProviderClient,
  defineHarness,
  openRouterChatCodec,
  openRouterClientOptions
} from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const client = new OpenAI(
  openRouterClientOptions({
    apiKey: process.env.OPENROUTER_API_KEY,
    appUrl: "https://your-app.example",
    appTitle: "Your Agent"
  })
);

const codec = openRouterChatCodec();
assertProviderClient(client, codec);

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: "openrouter/model-id",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }],
      temperature: 0
    },
    { site: "openrouter-answer" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const recorded = await AgentRewind.recordRun(
  {
    id: "openrouter-demo",
    store: ".rewind",
    model: client,
    codec
  },
  harness
);
```

## OpenRouter Options

`openRouterClientOptions()` returns options for the OpenAI Node SDK:

```ts
const options = openRouterClientOptions({
  apiKey: process.env.OPENROUTER_API_KEY,
  appUrl: "https://your-app.example",
  appTitle: "Your Agent",
  appCategories: ["cli-agent", "debugging"]
});
```

It sets:

- `baseURL: "https://openrouter.ai/api/v1"`
- `HTTP-Referer` when `appUrl` is provided
- `X-OpenRouter-Title` when `appTitle` is provided
- `X-OpenRouter-Categories` when `appCategories` is provided

## OpenRouter Request Parameters

OpenRouter-specific Chat Completions request parameters are preserved in
`params` and replayed/forked with the request:

```ts
await ctx.model.create(
  {
    model: "openrouter/anthropic-model-id",
    messages: [{ role: "user", content: "Classify this ticket." }],
    provider: {
      order: ["Anthropic"],
      allow_fallbacks: false
    },
    plugins: [{ id: "response-healing" }],
    response_format: { type: "json_object" }
  },
  { site: "classify-ticket" }
);
```

`metadata` is treated as volatile, matching the OpenAI-compatible codec.

## Replay

Strict replay needs no live OpenRouter client:

```ts
const replayed = await AgentRewind.replayRun(
  recorded.path,
  { codec: openRouterChatCodec() },
  harness
);
```

## Streaming

`ctx.model.stream()` calls `client.chat.completions.stream()`:

```ts
assertProviderClient(client, codec, ["stream"]);
```

```ts
for await (const chunk of ctx.model.stream(
  {
    model: "openrouter/model-id",
    messages: [{ role: "user", content: "Stream one sentence." }]
  },
  { site: "openrouter-stream" }
)) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

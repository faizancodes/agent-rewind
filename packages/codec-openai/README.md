# @agentrewind/codec-openai

OpenAI-compatible Chat Completions codec for AgentRewind.

Use this package when your agent calls the OpenAI Node SDK, including
OpenAI-compatible providers configured with a custom `baseURL`.

## Install

```sh
pnpm add @agentrewind/sdk @agentrewind/codec-openai openai
npm install @agentrewind/sdk @agentrewind/codec-openai openai
```

## Supported Client Shape

The codec wraps:

- `client.chat.completions.create(request)`
- `client.chat.completions.stream(request)`

That is the method shape provided by the OpenAI Node SDK. For an
OpenAI-compatible provider, keep using the OpenAI SDK and set `baseURL`:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.COMPATIBLE_API_KEY,
  baseURL: "https://your-provider.example/v1"
});
```

## Recording

```ts
import OpenAI from "openai";
import { AgentRewind, assertProviderClient, defineHarness } from "@agentrewind/sdk";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import type { ChatCompletion, ChatCompletionChunk } from "openai/resources/chat/completions";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const codec = openaiChatCodec();
assertProviderClient(client, codec);

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Answer tersely." },
        { role: "user", content: `Request ${ctx.uuid()}` }
      ],
      temperature: 0
    },
    { site: "answer-question" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const recorded = await AgentRewind.recordRun(
  {
    id: "openai-demo",
    store: ".rewind",
    model: client,
    codec
  },
  harness
);
```

## Replay

Strict replay needs no live model client:

```ts
const replayed = await AgentRewind.replayRun(
  recorded.path,
  { codec: openaiChatCodec() },
  harness
);
```

## Streaming

`ctx.model.stream()` calls `client.chat.completions.stream()` under the hood:

```ts
assertProviderClient(client, codec, ["stream"]);
```

```ts
await session.run(async (ctx) => {
  for await (const chunk of ctx.model.stream<ChatCompletionChunk>(
    {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "Stream one sentence." }]
    },
    { site: "stream-answer" }
  )) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
  }
});
```

## Notes

- `metadata` is treated as volatile and stripped from strict request
  fingerprints.
- Token usage maps `prompt_tokens` to `inputTokens` and `completion_tokens` to
  `outputTokens`.
- The codec preserves raw responses in the normalized response for local replay
  fidelity.
- This package targets Chat Completions. It does not wrap the Responses API,
  Assistants API, or transport-level `fetch`.

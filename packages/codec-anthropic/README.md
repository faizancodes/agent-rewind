# @agentrewind/codec-anthropic

Anthropic Messages API codec for AgentRewind.

Use this package when your agent calls the Anthropic TypeScript SDK through the
Messages API.

## Install

```sh
pnpm add agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk
npm install agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk
```

## Supported Client Shape

The codec wraps:

- `client.messages.create(request)`
- `client.messages.stream(request)`

## Recording

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AgentRewind, assertProviderClient, defineHarness } from "agentrewind";
import { anthropicCodec } from "@agentrewind/codec-anthropic";
import type { Message, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const codec = anthropicCodec();
assertProviderClient(client, codec);

const harness = defineHarness(async (ctx) => {
  const message = await ctx.model.create<Message>(
    {
      model: "claude-opus-4-8",
      max_tokens: 256,
      system: "Answer with operational detail.",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }]
    },
    { site: "draft-answer" }
  );

  return message.content;
});

const recorded = await AgentRewind.recordRun(
  {
    id: "anthropic-demo",
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
  { codec: anthropicCodec() },
  harness
);
```

## Streaming

`ctx.model.stream()` calls `client.messages.stream()` under the hood:

```ts
assertProviderClient(client, codec, ["stream"]);
```

```ts
await session.run(async (ctx) => {
  for await (const event of ctx.model.stream<RawMessageStreamEvent>(
    {
      model: "claude-opus-4-8",
      max_tokens: 256,
      messages: [{ role: "user", content: "Stream one sentence." }]
    },
    { site: "stream-answer" }
  )) {
    console.log(event.type);
  }
});
```

## Notes

- `metadata` is treated as volatile and stripped from strict request
  fingerprints.
- Anthropic input token usage includes regular, cache creation, and cache read
  input tokens.
- The codec preserves raw responses in the normalized response for local replay
  fidelity.
- This package targets Anthropic Messages. It does not wrap transport-level
  `fetch`.

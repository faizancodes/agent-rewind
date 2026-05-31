# Provider Setup

Use this reference when choosing or wiring the provider codec.

## Install Matrix

```sh
pnpm add agentrewind @agentrewind/codec-openai openai
pnpm add agentrewind @agentrewind/codec-openrouter openai
pnpm add agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk
```

```sh
npm install agentrewind @agentrewind/codec-openai openai
npm install agentrewind @agentrewind/codec-openrouter openai
npm install agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk
```

AgentRewind is ESM-only and requires Node 20 or newer.

## OpenAI Chat Completions

```ts
import OpenAI from "openai";
import { AgentRewind } from "agentrewind";
import { openaiChatCodec } from "@agentrewind/codec-openai";

const model = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const codec = openaiChatCodec();

const session = AgentRewind.record({
  id: "openai-demo",
  store: ".rewind",
  model,
  codec
});
```

Supported client methods:

- `client.chat.completions.create(request)`
- `client.chat.completions.stream(request)`

## OpenAI-Compatible Provider

```ts
const model = new OpenAI({
  apiKey: process.env.COMPATIBLE_API_KEY,
  baseURL: "https://provider.example/v1"
});

const codec = openaiChatCodec();
```

Use this when the provider follows OpenAI Chat Completions but is not OpenRouter.

## OpenRouter

```ts
import OpenAI from "openai";
import { openRouterChatCodec, openRouterClientOptions } from "@agentrewind/codec-openrouter";

const model = new OpenAI(
  openRouterClientOptions({
    apiKey: process.env.OPENROUTER_API_KEY,
    appUrl: "https://your-app.example",
    appTitle: "Your Agent"
  })
);

const codec = openRouterChatCodec();
```

OpenRouter request parameters such as `provider`, `plugins`, `response_format`,
and `metadata` can be included in the Chat Completions request. `metadata` is
treated as volatile for request fingerprints; routing/plugin/format params are
preserved.

## Anthropic Messages

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropicCodec } from "@agentrewind/codec-anthropic";

const model = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const codec = anthropicCodec();
```

Supported client methods:

- `client.messages.create(request)`
- `client.messages.stream(request)`

## Typed Model Calls

`ctx.model` is provider-neutral. Add SDK response types at call sites:

```ts
import type { ChatCompletion } from "openai/resources/chat/completions";

const completion = await ctx.model.create<ChatCompletion>(request, {
  site: "typed-call"
});
```

For streams:

```ts
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

for await (const chunk of ctx.model.stream<ChatCompletionChunk>(request, {
  site: "stream-answer"
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Current SDK Docs

When writing or updating provider-specific snippets, fetch current docs first:

- OpenAI Node SDK for `chat.completions.create()` and `.stream()`.
- OpenRouter docs for `baseURL`, attribution headers, model IDs, streaming, and request params.
- Anthropic TypeScript SDK for `messages.create()` and `messages.stream()`.

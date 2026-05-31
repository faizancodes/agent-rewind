# Provider Setup

Use this reference when choosing or wiring the provider codec.

## Install

```sh
npm install @agentrewind/sdk
```

That one package includes the SDK runtime, CLI, built-in provider codecs,
OpenAI client, Anthropic client, and replay test helpers. Pick the helper that
matches the model client:

| Model client | Helper |
| --- | --- |
| OpenAI Chat Completions or OpenAI-compatible `baseURL` provider | `OpenAI`, `openaiChatCodec()` |
| OpenRouter | `OpenAI`, `openRouterClientOptions()`, `openRouterChatCodec()` |
| Anthropic Messages | `Anthropic`, `anthropicCodec()` |

AgentRewind is ESM-only and requires Node 20 or newer.

`@agentrewind/sdk` is the application entrypoint and installs the `agentrewind`
and `arw` CLI binaries. Do not use an unscoped `agentrewind` package import.

## OpenAI Chat Completions

```ts
import { AgentRewind, OpenAI, openaiChatCodec } from "@agentrewind/sdk";

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
import { OpenAI, openRouterChatCodec, openRouterClientOptions } from "@agentrewind/sdk";

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
import { Anthropic, anthropicCodec } from "@agentrewind/sdk";

const model = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const codec = anthropicCodec();
```

Supported client methods:

- `client.messages.create(request)`
- `client.messages.stream(request)`

## Typed Model Calls

`ctx.model` is provider-neutral. Add SDK response types at call sites:

```ts
import type { ChatCompletion } from "@agentrewind/sdk";

const completion = await ctx.model.create<ChatCompletion>(request, {
  site: "typed-call"
});
```

For streams:

```ts
import type { ChatCompletionChunk } from "@agentrewind/sdk";

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

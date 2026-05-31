# Provider Codecs

AgentRewind core is provider-neutral. A provider codec teaches the runtime how
to normalize SDK-specific requests, responses, and stream chunks into stable
AgentRewind shapes.

## Built-In Codecs

| Codec | Package | Client methods |
| --- | --- | --- |
| OpenAI-compatible Chat Completions | `@agentrewind/codec-openai` | `chat.completions.create()`, `chat.completions.stream()` |
| OpenRouter Chat Completions | `@agentrewind/codec-openrouter` | `chat.completions.create()`, `chat.completions.stream()` |
| Anthropic Messages | `@agentrewind/codec-anthropic` | `messages.create()`, `messages.stream()` |

The codec method paths are regular property paths on the SDK client. For
example, `chat.completions.create` means AgentRewind calls:

```ts
client.chat.completions.create(request);
```

## Fork Compatibility

Forking uses two codec methods after the split point:

- `applyOverrides()` changes the normalized request for prompt/model
  experiments.
- `denormalizeRequest()` converts that normalized request back into the SDK
  request shape before the live tail call.

The built-in codec tests cover that behavior for OpenAI, Anthropic, and
OpenRouter. They assert that fork tail calls go through the provider's real SDK
method path, preserve provider-specific parameters, record a child session with
the right provider identity, and can replay the child session afterward.

Run the deterministic provider fork suite with:

```sh
pnpm test:provider-forks
```

To run opt-in live smoke tests against the actual provider APIs, load provider
keys and model ids into the shell, then run:

```sh
export OPENAI_API_KEY=...
export OPENAI_MODEL=...
export ANTHROPIC_API_KEY=...
export ANTHROPIC_MODEL=...
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=...
pnpm test:live:provider-forks
```

The live tests only run when `AGENTREWIND_LIVE_PROVIDER_FORKS=1` is set by the
script and the matching provider key and model variables are present. Missing
providers are skipped so you can smoke test one provider at a time.

## OpenAI-Compatible Providers

Use the OpenAI Node SDK and configure the provider endpoint with `baseURL`:

```ts
import OpenAI from "openai";

const model = new OpenAI({
  apiKey: process.env.COMPATIBLE_API_KEY,
  baseURL: "https://your-provider.example/v1"
});
```

Then use `openaiChatCodec()` in both record and replay:

```ts
import { AgentRewind, assertProviderClient } from "@agentrewind/sdk";
import { openaiChatCodec } from "@agentrewind/codec-openai";

const codec = openaiChatCodec();
assertProviderClient(model, codec);

const session = AgentRewind.record({
  id: "compatible-demo",
  store: ".rewind",
  model,
  codec
});
```

The codec targets Chat Completions. If a provider only exposes a raw HTTP API,
the Responses API, or a different SDK shape, write a custom codec or wrap that
client behind the expected method paths.

## OpenRouter

OpenRouter is first-class through `@agentrewind/codec-openrouter`. It still uses
the OpenAI Node SDK method shape, but the package gives recordings a distinct
provider name and provides OpenRouter defaults:

```ts
import OpenAI from "openai";
import { AgentRewind, assertProviderClient } from "@agentrewind/sdk";
import { openRouterChatCodec, openRouterClientOptions } from "@agentrewind/codec-openrouter";

const model = new OpenAI(
  openRouterClientOptions({
    apiKey: process.env.OPENROUTER_API_KEY,
    appUrl: "https://your-app.example",
    appTitle: "Your Agent"
  })
);
const codec = openRouterChatCodec();
assertProviderClient(model, codec);

const session = AgentRewind.record({
  id: "openrouter-demo",
  store: ".rewind",
  model,
  codec
});
```

OpenRouter-specific Chat Completions parameters such as `provider`, `plugins`,
and `response_format` are preserved in the normalized request `params` and sent
back on fork/passthrough live calls.

## Anthropic Messages

Use `anthropicCodec()` with an Anthropic SDK client:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { AgentRewind, assertProviderClient } from "@agentrewind/sdk";
import { anthropicCodec } from "@agentrewind/codec-anthropic";

const model = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});
const codec = anthropicCodec();
assertProviderClient(model, codec);

const session = AgentRewind.record({
  id: "anthropic-demo",
  store: ".rewind",
  model,
  codec
});
```

`assertProviderClient(model, codec)` validates the non-streaming method path.
Use `assertProviderClient(model, codec, ["stream"])` when the workflow starts
with `ctx.model.stream()`.

## Custom Codec Contract

Implement `ProviderCodec` when your model client does not match a built-in
codec. During setup, call `assertProviderCodec(codec)` before recording if the
codec is assembled dynamically or lives in your application code:

```ts
import { assertProviderCodec } from "@agentrewind/sdk";

const codec = myProviderCodec();
assertProviderCodec(codec);
```

Minimal custom codec shape:

```ts
import type {
  ChunkRecord,
  ForkOverrides,
  NormalizedRequest,
  NormalizedResponse,
  ProviderCodec,
  Usage
} from "@agentrewind/core";

export function myProviderCodec(): ProviderCodec {
  return {
    name: "my-provider",
    interceptPoints: ["responses.create", "responses.stream"],
    normalizeRequest(raw): NormalizedRequest {
      // Convert SDK request shape to { model, system, messages, params }.
      return raw as NormalizedRequest;
    },
    denormalizeRequest(req): unknown {
      // Convert normalized request back to SDK request shape for fork/passthrough.
      return req;
    },
    normalizeResponse(raw): NormalizedResponse {
      return { content: raw, raw };
    },
    normalizeStream(rawChunks): { final: NormalizedResponse; chunks: ChunkRecord[] } {
      return {
        final: { content: rawChunks, raw: rawChunks },
        chunks: rawChunks.map((data, offsetMs) => ({ offsetMs, data }))
      };
    },
    async *rebuildStream(chunks): AsyncIterable<unknown> {
      for (const chunk of chunks) {
        yield chunk.data;
      }
    },
    stripVolatile(req): NormalizedRequest {
      return JSON.parse(JSON.stringify(req)) as NormalizedRequest;
    },
    volatileLeafPaths(): string[] {
      return [];
    },
    extractUsage(resp): Usage | undefined {
      return resp.usage;
    },
    applyOverrides(req, overrides: ForkOverrides, step): NormalizedRequest {
      const next = {
        ...req,
        messages: req.messages.map((message) => ({ ...message })),
        params: { ...req.params }
      };
      if (overrides.system !== undefined) next.system = overrides.system;
      if (overrides.model !== undefined) next.model = overrides.model;
      return overrides.transformRequest ? overrides.transformRequest(next, step) : next;
    }
  };
}
```

## Codec Checklist

- Normalize only stable request data into fingerprints.
- Put provider options such as temperature, tools, tool choice, and metadata in
  `params`.
- Strip fields that change every request, such as metadata trace IDs, in
  `stripVolatile()`.
- Preserve enough raw response data in `raw` for replay to return the same SDK
  shape your harness expects.
- Assemble stream chunks into a final normalized response in `normalizeStream()`.
- Rebuild the recorded stream chunks in `rebuildStream()`.
- Map provider token usage to `{ inputTokens, outputTokens }`.
- Keep `denormalizeRequest()` symmetric with `normalizeRequest()` so fork and
  passthrough can make live calls.

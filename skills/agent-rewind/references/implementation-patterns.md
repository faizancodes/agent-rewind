# Implementation Patterns

Use this reference when modifying an agent codebase.

## Minimal Record/Replay Shape

```ts
import { AgentRewind, assertProviderClient, defineHarness } from "@agentrewind/sdk";

assertProviderClient(model, codec);

const harness = defineHarness(async (ctx) => {
  const response = await ctx.model.create(
    {
      model: "provider-model",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }]
    },
    { site: "answer-question" }
  );

  return response;
});

const recorded = await AgentRewind.recordRun(
  {
    id: "demo",
    store: ".rewind",
    model,
    codec
  },
  harness
);

const replayed = await AgentRewind.replayRun(recorded.path, { codec }, harness);
```

## Wrapping Tools

External I/O that affects prompts or control flow should be a tool:

```ts
import { AgentRewind, defineHarness, defineTools } from "@agentrewind/sdk";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => {
    const { customerId } = args;
    return crm.customers.get(customerId);
  }
});

const session = AgentRewind.record({
  id: "support-router",
  store: ".rewind",
  model,
  codec,
  tools
});

const harness = defineHarness(tools, async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
  return ctx.model.create(
    {
      model: "provider-model",
      messages: [{ role: "user", content: JSON.stringify(customer) }]
    },
    { site: "summarize-customer" }
  );
});
```

Strict replay should not execute the live tool handler again.

## Provider Client Validation

Before recording, validate that the codec can find the provider method it wraps:

```ts
assertProviderClient(model, codec);
```

For streaming-first workflows:

```ts
assertProviderClient(model, codec, ["stream"]);
```

## Entropy

Use `ctx` entropy whenever values affect prompts, tool args, filenames, or branching:

```ts
const requestId = ctx.uuid();
const receivedAt = ctx.clock();
const sample = ctx.random();
```

Ambient entropy is not intercepted:

- `Date.now()`
- `Math.random()`
- `crypto.randomUUID()`

## Stable Call Sites

Pass `site` to model calls:

```ts
await ctx.model.create(request, { site: "classify-ticket" });
await ctx.model.stream(request, { site: "draft-reply-stream" });
```

Use human-readable names that map to agent decisions. Avoid generated IDs,
timestamps, or model names in `site`.

## Forking

Forking replays the prefix and sends the tail live:

```sh
agentrewind inspect .rewind/demo
agentrewind fork .rewind/demo --site classify-ticket --system "Prioritize escalation accuracy over brevity."
```

Use the SDK directly when the fork needs current harness code or a goal
predicate:

```ts
const replay = await AgentRewind.replay(".rewind/demo", { codec, model });

const fork = await replay.fork({
  atStep: 3,
  harness,
  model,
  overrides: {
    system: "Prioritize escalation accuracy over brevity.",
    model: "new-model"
  },
  goal: (trace) => trace.reached("sendEscalation")
});
```

Use `agentrewind inspect .rewind/demo` to find model-call steps. `tokensSpent`
only counts live tail model calls.

## Redaction And Sharing

Redaction is enabled by default. Add project-specific patterns when needed:

```ts
const session = AgentRewind.record({
  id: "redaction-demo",
  store: ".rewind",
  model,
  codec,
  redaction: {
    enabled: true,
    patterns: [/customer-secret-[a-z0-9]+/gi]
  }
});
```

Pack before sharing:

```sh
agentrewind pack .rewind/demo demo.rewind
```

The packed bundle excludes `vault.enc`; it should include `meta.json`,
`events.jsonl`, and blobs.

## Common Mistakes

- Calling `client.chat.completions.create()` directly inside the harness.
- Forgetting `await session.close()`.
- Importing from an unscoped `agentrewind` package instead of `@agentrewind/sdk`.
- Reusing `ctx.model.create()` for streaming instead of `ctx.model.stream()`.
- Using `Date.now()` in a prompt and then expecting strict replay to match.
- Treating `warn` or `passthrough` replay as deterministic test evidence.
- Using the OpenAI codec for OpenRouter when first-class OpenRouter reporting is desired.

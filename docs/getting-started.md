# Getting Started

This guide is for engineers adding AgentRewind to an existing TypeScript agent.
The goal is to get one real workflow recording and replaying before you wire up
every model call in the application.

## The Mental Model

AgentRewind records the boundary calls that make agent behavior hard to
reproduce:

- model calls through `ctx.model.create()` or `ctx.model.stream()`
- tool calls through `ctx.tools.*`
- prompt-affecting entropy through `ctx.uuid()`, `ctx.clock()`, and
  `ctx.random()`

Record mode calls the live model and tools, then writes a session to disk.
Strict replay runs the same harness and serves recorded outputs instead of
calling the live model or tools again.

## Pick The Provider Path

| Your model client | Install | Codec |
| --- | --- | --- |
| OpenAI Chat Completions | `agentrewind @agentrewind/codec-openai openai` | `openaiChatCodec()` |
| OpenAI-compatible `baseURL` provider | `agentrewind @agentrewind/codec-openai openai` | `openaiChatCodec()` |
| OpenRouter through the OpenAI SDK | `agentrewind @agentrewind/codec-openrouter openai` | `openRouterChatCodec()` |
| Anthropic Messages | `agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk` | `anthropicCodec()` |

AgentRewind does not wrap arbitrary `fetch` calls. If an external operation
affects prompts, tool arguments, or branching, model it as a tool.

If you want copyable starter code before reading the full guide, run:

```sh
agentrewind quickstart openai
agentrewind quickstart openai-compatible
agentrewind quickstart openrouter
agentrewind quickstart anthropic
```

Use `--manager npm`, `--manager yarn`, or `--manager bun` if you do not use
pnpm.

Use `--format ts` for raw TypeScript or `--out <file>` to write a starter file:

```sh
agentrewind quickstart openrouter --format ts
agentrewind quickstart openrouter --out agentrewind-openrouter.ts
```

## Minimal Shape

```ts
import { AgentRewind, assertProviderClient, defineHarness } from "agentrewind";
import { openaiChatCodec } from "@agentrewind/codec-openai";

const codec = openaiChatCodec();
const chatModel = process.env.OPENAI_MODEL ?? "gpt-5.5";
assertProviderClient(model, codec);

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create(
    {
      model: chatModel,
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
    id: "first-recording",
    store: ".rewind",
    model,
    codec
  },
  harness
);

const replayed = await AgentRewind.replayRun(recorded.path, { codec }, harness);
```

## Add Tools One At A Time

Start with one model call. Then move prompt-affecting external work behind
tools:

```ts
import { defineHarness, defineTools } from "agentrewind";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => {
    return crm.customers.get(args.customerId);
  }
});

const chatModel = process.env.OPENAI_MODEL ?? "gpt-5.5";

const harness = defineHarness(tools, async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
  return ctx.model.create(
    {
      model: chatModel,
      messages: [{ role: "user", content: JSON.stringify(customer) }]
    },
    { site: "summarize-customer" }
  );
});

const recorded = await AgentRewind.recordRun(
  {
    id: "ticket-triage",
    store: ".rewind",
    model,
    codec,
    tools
  },
  harness
);
```

During replay, `lookupCustomer` is not called. AgentRewind returns the recorded
tool result. `defineTools()` and `defineHarness()` are no-ops at runtime; they
preserve concrete tool names, argument types, result types, and the harness
return type so you do not have to write `Harness<Result, typeof tools>` by hand.

## Fail Fast On Provider Setup

If the codec and SDK client do not match, recording cannot intercept model
calls. Check that once during startup:

```ts
assertProviderClient(model, codec);
```

This validates the non-streaming method path, such as
`client.chat.completions.create(request)` for OpenAI-compatible providers. If
your first workflow streams, validate the streaming path too:

```ts
assertProviderClient(model, codec, ["stream"]);
```

## Inspect Your First Recording

After the recording has been flushed, run:

```sh
agentrewind list .rewind
agentrewind doctor .rewind/first-recording
agentrewind doctor first-recording --store .rewind
agentrewind doctor latest --store .rewind
agentrewind inspect .rewind/first-recording
agentrewind inspect .rewind/first-recording --json
agentrewind context .rewind/first-recording
agentrewind context .rewind/first-recording --site answer-question
agentrewind entropy .rewind/first-recording --source uuid
agentrewind pack .rewind/first-recording first-recording.rewind
```

Use `list` when you only know the store directory and need to find the exact
session path. Then use `doctor` first. It accepts the full path printed by
`recordRun()`, a session id with `--store .rewind`, or `latest --store .rewind`.
It tells you whether the session is readable, which provider was recorded, how
many model/tool/entropy boundaries exist, and which command to run next. Use
plain `inspect` when you want a readable timeline table, and `inspect --json`
when you want to feed the timeline into a script or test. `context` shows the
first model-call prompt by default. Use `--site <name>` when you know the stable
model-call site from the harness, or add `--step <n>` after `inspect` if you
want a specific recorded step.
`tool` shows recorded tool args, result, or error. Use `--name <tool>` when the
tool appears once, or `--step <n>` after `inspect` when the same tool appears
multiple times.
`entropy` shows recorded `ctx.clock()`, `ctx.random()`, or `ctx.uuid()` values.
Use `--source <clock|random|uuid>` when the source appears once, or `--step <n>`
after `inspect` when it appears multiple times.

If a CLI command cannot identify the session, run `agentrewind list .rewind`,
pass a full session path such as `.rewind/first-recording`, or pass
`first-recording --store .rewind`.

Programmatic inspection can also load a replay without a codec:

```ts
const replay = await AgentRewind.replay(".rewind/first-recording");
console.log(replay.events());
```

Replay APIs accept the same session selectors as the CLI, so tests do not need
to manually join `.rewind/<id>` paths:

```ts
await AgentRewind.replay("first-recording", { store: ".rewind" });
await AgentRewind.replayRun("latest", { store: ".rewind", codec }, harness);

const summary = await AgentRewind.summary("latest", { store: ".rewind" });
const summaries = await AgentRewind.listSessionSummaries(".rewind");
const timeline = await AgentRewind.timeline("latest", { store: ".rewind" });
const prompt = await AgentRewind.promptContext("latest", {
  store: ".rewind",
  site: "answer-question"
});
const tool = await AgentRewind.toolCall("latest", {
  store: ".rewind",
  name: "lookupCustomer"
});
const entropy = await AgentRewind.entropyDraw("latest", {
  store: ".rewind",
  source: "uuid"
});
await AgentRewind.pack("latest", "latest-session.rewind", { store: ".rewind" });
console.log(summary.provider, summary.counts.modelCalls, summary.usage.inputTokens);
```

Add `{ codec }` when you call `replay.run()` or `replay.fork()`. Those paths
need the codec to fingerprint current requests and prepare live fork requests.

## What To Copy From The Examples

- Start with `examples/openai-compatible-support-bot` if you have a normal
  non-streaming support or operations agent.
- Use `examples/openai-compatible-streaming` if your UI or CLI renders streamed
  chunks.
- Use `examples/openrouter-support-router` if your provider is OpenRouter.
- Use `examples/anthropic-tool-agent` if replay must avoid duplicating external
  side effects.
- Use `examples/fork-replay-prompt-fix` when testing prompt/model changes
  against a historical run.

## Common Mistakes

- Calling the provider SDK directly inside the harness. Use `ctx.model.*`.
- Calling external APIs directly inside the harness. Use `ctx.tools.*`.
- Starting a recording without `store`, `model`, or `codec`. Record setup now
  throws `ConfigurationError` with the missing field and a copyable fix.
- Passing non-JSON values through model requests or tools. Convert Dates, Maps,
  classes, Buffers, BigInts, functions, NaN, and Infinity to JSON values, or use
  `toolSerializers` for tool-specific runtime types.
- Defining tools for TypeScript but forgetting to pass them to recording. Use
  the same `tools` object in `defineHarness(tools, harness)` and
  `AgentRewind.recordRun({ ..., tools }, harness)`.
- Using `Date.now()`, `Math.random()`, or `crypto.randomUUID()` in prompts. Use
  `ctx.clock()`, `ctx.random()`, and `ctx.uuid()`.
- Omitting `site` names on important model calls. Stable names make drift much
  easier to diagnose.
- Expecting strict replay to call live clients. Strict replay should make zero
  live model/tool calls.

## Debug Drift

When replay fails, use `explainRewindError()` before looking at raw JSON:

```ts
import { AgentRewind, explainRewindError } from "agentrewind";

try {
  await AgentRewind.replayRun(".rewind/first-recording", { codec }, harness);
} catch (error) {
  console.error(explainRewindError(error, {
    sessionPath: ".rewind/first-recording"
  }));
  throw error;
}
```

The explanation tells you which recorded boundary was expected, what the current
harness did instead, and which CLI commands to run next.
For named model calls, it suggests `agentrewind context <session> --site <name>`
so you can inspect the exact prompt by the site name used in your harness.

## When To Fork

Replay answers: "Can I reproduce what happened?"

Fork answers: "What would happen if I changed the prompt, model, or tail
policy from this recorded decision point?"

The normal fork workflow is:

1. Run strict replay once to prove the session is usable.
2. Find a model-call step with `agentrewind inspect`.
3. Call `replay.fork({ atStep, harness, model, overrides, goal })`.
4. Assert `fork.reachedGoal`, inspect `fork.trace.events()`, and check
   `fork.tokensSpent`.

See `examples/fork-replay-prompt-fix` for a copyable script.

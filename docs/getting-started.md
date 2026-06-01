# Getting Started

This guide is for engineers adding AgentRewind to an existing TypeScript agent.
The goal is to get one real workflow recording and replaying before you wire up
every model call in the application.

## The Mental Model

AgentRewind records the boundary calls that make agent behavior hard to
reproduce:

- model calls through `ctx.model.create()` or `ctx.model.stream()`
- tool calls through `ctx.tools.*`
- prompt-affecting entropy through `ctx.uuid()`, `ctx.clock()`,
  `ctx.random()`, and `ctx.env(key)`

Record mode calls the live model and tools, then writes a session to disk.
Strict replay runs the same harness and serves recorded outputs instead of
calling the live model or tools again.

## Install

```sh
npm install @agentrewind/sdk
```

That one package includes the SDK runtime, CLI, built-in provider codecs,
OpenAI client, Anthropic client, and replay test helpers. Prefer a provider
preset when one matches your model client:

| Model client | Preset |
| --- | --- |
| OpenAI Chat Completions | `createOpenAIRewind()` |
| OpenAI-compatible `baseURL` provider | `createOpenAICompatibleRewind()` |
| OpenRouter through the OpenAI SDK | `createOpenRouterRewind()` |
| Anthropic Messages | `createAnthropicRewind()` |

AgentRewind does not wrap arbitrary `fetch` calls. If an external operation
affects prompts, tool arguments, or branching, model it as a tool.

If you want copyable starter code before reading the full guide, run:

```sh
agentrewind quickstart openai
agentrewind quickstart openai-compatible
agentrewind quickstart openrouter
agentrewind quickstart anthropic
```

Use `--manager pnpm`, `--manager yarn`, or `--manager bun` if you do not use
npm.

Use `--format ts` for raw TypeScript or `--out <file>` to write a starter file:

```sh
agentrewind quickstart openrouter --format ts
agentrewind quickstart openrouter --out agentrewind-openrouter.ts
```

## Minimal Shape

```ts
import { createOpenAIRewind, defineHarness } from "@agentrewind/sdk";

const chatModel = process.env.OPENAI_MODEL ?? "gpt-5.5";
const rewind = createOpenAIRewind({ store: ".rewind" });

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

const recorded = await rewind.recordRun({ id: "first-recording" }, harness);

const replayed = await rewind.replayRun(recorded.path, harness);
```

## Add Tools One At A Time

Start with one model call. Then move prompt-affecting external work behind
tools:

```ts
import { createOpenAIRewind, defineAgent, defineHarness, defineTools } from "@agentrewind/sdk";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => {
    return crm.customers.get(args.customerId);
  }
});

const chatModel = process.env.OPENAI_MODEL ?? "gpt-5.5";
const rewind = createOpenAIRewind({ store: ".rewind", tools });

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
const agent = defineAgent({ tools, harness });

const recorded = await rewind.recordRun({ id: "ticket-triage" }, agent);
```

During replay, `lookupCustomer` is not called. AgentRewind returns the recorded
tool result. `defineTools()` and `defineHarness()` preserve concrete tool names,
argument types, result types, and the harness return type so you do not have to
write `Harness<Result, typeof tools>` by hand. `defineAgent({ tools, harness })`
also carries those tools at runtime.

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
agentrewind fork .rewind/first-recording --site answer-question --system "Try a safer policy prompt." --dry-run
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
  `defineAgent({ tools, harness })` or pass the same `tools` object in both
  places.
- Using `Date.now()`, `Math.random()`, `crypto.randomUUID()`, or `process.env`
  directly in prompts. Use `ctx.clock()`, `ctx.random()`, `ctx.uuid()`, and
  `ctx.env(key)`.
- Omitting `site` names on important model calls. Stable names make drift much
  easier to diagnose.
- Expecting strict replay to call live clients. Strict replay should make zero
  live model/tool calls.

## Debug Drift

When replay fails, use `explainRewindError()` before looking at raw JSON:

```ts
import { AgentRewind, explainRewindError } from "@agentrewind/sdk";

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
3. For provider-backed prompt/model experiments, run `agentrewind fork`.
4. For harness-aware experiments, call `replay.fork({ atStep, harness, model, overrides, goal })`.
5. Assert `fork.reachedGoal`, inspect `fork.trace.events()`, and check
   `fork.tokensSpent`.

CLI example:

```sh
agentrewind fork latest \
  --store .rewind \
  --site answer-question \
  --system "Prefer policy-backed answers." \
  --model gpt-5.5
```

The CLI writes a child session next to the parent and prints the next
`inspect` / `context` commands. It uses `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, or `COMPATIBLE_API_KEY` plus `COMPATIBLE_BASE_URL`
depending on the provider. Add `--dry-run` first when you want to confirm the
step and provider without making a live model call.

See `examples/fork-replay-prompt-fix` for a copyable script.

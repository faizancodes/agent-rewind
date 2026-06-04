# Implementation Patterns

Use this reference when modifying an agent codebase.

## Minimal Record And Replay

```ts
import { createOpenAIRewind, defineHarness } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const rewind = createOpenAIRewind({ store: ".rewind" });

const harness = defineHarness(async (ctx) => {
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: process.env.OPENAI_MODEL ?? "gpt-5.5",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }]
    },
    { site: "answer-question" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const recorded = await rewind.recordRun({ id: "demo" }, harness);
const replayed = await rewind.replayRun(recorded.path, harness);
```

Strict replay should return the same harness result while making zero live provider calls.

## Tools And External I/O

External I/O that affects prompts, tool arguments, or control flow should be a tool. Use `defineAgent()` so tools and harness stay together at runtime:

```ts
import { createOpenAIRewind, defineAgent, defineHarness, defineTools } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => {
    return crm.customers.get(args.customerId);
  },
  createEscalation: async (args: { ticketId: string; reason: string }) => {
    return support.createEscalation(args);
  }
});

const rewind = createOpenAIRewind({ store: ".rewind", tools });

const harness = defineHarness(tools, async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: "gpt-5.5",
      messages: [{ role: "user", content: JSON.stringify(customer) }]
    },
    { site: "route-ticket" }
  );

  if (completion.choices[0]?.message.content?.includes("escalate")) {
    await ctx.tools.createEscalation({ ticketId: "ticket_123", reason: "policy exception" });
  }

  return completion;
});

const agent = defineAgent({ tools, harness });
const recorded = await rewind.recordRun({ id: "support-router" }, agent);
await rewind.replayRun(recorded.path, agent);
```

Strict replay serves recorded tool outputs and should not execute the live tool handlers again.

## Existing Client Or Codec

If the app already owns the provider client, bind it once:

```ts
import { AgentRewind, OpenAI, assertProviderClient, openaiChatCodec } from "@agentrewind/sdk";

const model = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const codec = openaiChatCodec();
assertProviderClient(model, codec);

const rewind = AgentRewind.withProvider({
  store: ".rewind",
  model,
  codec
});
```

Use direct `AgentRewind.record()` only when you need manual session lifecycle methods such as `session.note()`, `session.close()`, or `session.pack()`.

## Entropy And Environment

Use `ctx` entropy whenever a value can affect prompts, tool arguments, filenames, or branching:

```ts
const requestId = ctx.uuid();
const receivedAt = ctx.clock();
const sample = ctx.random();
const featureFlag = ctx.env("SUPPORT_ROUTER_POLICY");
```

Ambient entropy is not intercepted:

- `Date.now()`
- `Math.random()`
- `crypto.randomUUID()`
- direct `process.env` reads inside prompts or branches

## Stable Call Sites

Pass `site` to important model calls:

```ts
await ctx.model.create(request, { site: "classify-ticket" });
await ctx.model.stream(request, { site: "draft-reply-stream" });
```

Use names that map to agent decisions. Avoid generated IDs, timestamps, or model names in `site`.

## Streaming

Use `ctx.model.stream()` for streaming agents:

```ts
import type { ChatCompletionChunk } from "@agentrewind/sdk";

let text = "";
for await (const chunk of ctx.model.stream<ChatCompletionChunk>(
  {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Stream one sentence." }]
  },
  { site: "stream-answer" }
)) {
  text += chunk.choices[0]?.delta?.content ?? "";
}
return text;
```

Record and replay should reconstruct the same user-visible stream output.

## Inspecting A Session

Start with:

```sh
agentrewind list .rewind
agentrewind doctor latest --store .rewind
agentrewind inspect latest --store .rewind
```

For large sessions, use filters:

```sh
agentrewind timeline latest --store .rewind --kind model_call --site classify-ticket
agentrewind inspect latest --store .rewind --errors
agentrewind inspect latest --store .rewind --live --from 4 --to 12
agentrewind context latest --store .rewind --site classify-ticket
agentrewind prompt latest --store .rewind --step 5
agentrewind tool latest --store .rewind --name lookupCustomer --json
agentrewind entropy latest --store .rewind --source env
```

Use `inspect --json` for automation. Use `--full-fingerprint` when comparing exact request or tool hashes.

## Forking

Forking replays the recorded prefix and sends the tail live:

```sh
agentrewind fork latest \
  --store .rewind \
  --site classify-ticket \
  --system "Escalate enterprise refund exceptions to a support manager." \
  --model gpt-5.5 \
  --dry-run
```

Dry runs verify the fork plan without provider tokens. Add `--check-provider` when you want dry run to validate credentials and provider wiring. Built-in CLI providers are `openai`, `openai-compatible`, `openrouter`, and `anthropic`.

A successful fork writes a complete child session. Prefix model, tool, and
entropy events are copied into the child with `provenance: "recorded"`; live
tail model calls are written with `provenance: "live"`. That child should replay
with a full matching harness when the fork is used as a regression test. For a
prompt fix, that means the harness code now builds the prompt that the fork
tested.

Use SDK fork when you need the current harness, a goal predicate, or programmatic assertions:

```ts
const replay = await rewind.replay("latest");
await replay.run(agent.harness);

const fork = await replay.fork({
  atStep: 5,
  harness: agent.harness,
  overrides: {
    system: "Escalate enterprise refund exceptions to a support manager.",
    model: "gpt-5.5"
  },
  tools: {
    onMatch: "serve-recorded",
    onMiss: "error"
  },
  goal: (trace) => trace.reached("createEscalation", { ticketId: "ticket_123" })
});

console.log(fork.sessionId, fork.reachedGoal, fork.tokensSpent);

const childReplay = await rewind.replay(fork.sessionId);
await childReplay.run(agent.harness);
```

Supported fork tool policy is intentionally narrow:

- `onMatch: "serve-recorded"`
- `onMiss: "error"` or `"stub"`

Do not document live tail tool execution unless the package implements it.

## Trajectory Search

Use search when one manual fork is not enough. Search runs multiple fork
rollouts from the same recorded step and ranks the child sessions.

CLI prompt sweep:

```sh
agentrewind search latest \
  --store .rewind \
  --site classify-ticket \
  --candidate "Escalate::Enterprise exceptions should escalate-to-csm." \
  --candidate "Hold::Ask for more context before escalation." \
  --goal-contains "escalate-to-csm" \
  --strategy beam
```

Use `--actions candidates.json` for structured candidates:

```json
[
  { "id": "escalate", "label": "Escalate enterprise", "system": "Enterprise exceptions should escalate-to-csm." },
  { "id": "hold", "label": "Hold for review", "system": "Ask for more context before escalation." }
]
```

SDK search for custom scoring:

```ts
import { search } from "@agentrewind/sdk";

const replay = await rewind.replay("latest");
await replay.run(agent.harness);

const result = await search.promptSweep(replay, {
  atStep: 5,
  harness: agent.harness,
  model: rewind.model,
  strategy: "beam",
  budget: { maxRollouts: 3, stopScore: 1 },
  prompts: [
    { id: "hold", system: "Ask for more context." },
    { id: "escalate", system: "Enterprise exceptions should escalate-to-csm." }
  ],
  score: ({ result, trace }) => ({
    score: String(result).includes("escalate-to-csm") ? 1 : 0,
    reason: `events=${trace.events().length}`
  })
});
```

Use `search.modelSweep()`, `search.regression()`, and `search.judge()` for
model comparisons, assertion-based scoring, and LLM-as-a-judge rubrics. Search
results include `best` for the highest single rollout and `bestBranch` for
aggregate branch selection.

Each rollout is a normal fork child session. If the winning action changed the
prompt or model request, replay the child with harness code that now builds that
winning request. Do not replay a prompt-overridden child with the old prompt
harness and expect strict replay to pass.

For persisted search artifacts, use:

```sh
agentrewind search report <search-id>
agentrewind search promote <winning-child> --out tests/fixtures/agentrewind.regression.json
```

For detailed scoring strategies, including parsed JSON, tool-call goals,
cost-adjusted scoring, multi-objective scoring, and LLM-as-a-judge
natural-language metrics, load `docs/trajectory-scoring.md` from the repository
when available.
For detailed strategy behavior, including beam search, Monte Carlo search, UCB,
MCTS, AlphaZero-style PUCT, multi-depth action sequences, dynamic action
generation, priors, and budgets, load
`docs/trajectory-search-strategies.md` from the repository when available.

## Redaction And Sharing

Redaction is enabled by default. Add project-specific patterns when needed:

```ts
const rewind = createOpenAIRewind({
  store: ".rewind"
});

const recorded = await rewind.recordRun({
  id: "redaction-demo",
  redaction: {
    enabled: true,
    patterns: [/customer-secret-[a-z0-9]+/gi]
  }
}, harness);
```

Pack before sharing:

```sh
agentrewind pack latest demo.rewind --store .rewind
agentrewind unpack demo.rewind unpacked-demo
```

Packed bundles exclude `vault.enc` and reject unsafe archive paths. Keep raw `.rewind/<session>/vault.enc` local.

## Common Mistakes

- Calling `client.chat.completions.create()` or `client.messages.create()` directly inside the harness.
- Calling external APIs directly inside the harness instead of using `ctx.tools`.
- Forgetting to use `defineAgent({ tools, harness })` for tool agents.
- Passing different tools objects to the bound helper and the agent.
- Reusing `ctx.model.create()` for streaming instead of `ctx.model.stream()`.
- Using `Date.now()`, `Math.random()`, `crypto.randomUUID()`, or `process.env` directly in prompt-affecting code.
- Omitting stable `site` names on important model calls.
- Treating `warn` or `passthrough` replay as deterministic test evidence.
- Using the generic OpenAI-compatible helper for OpenRouter when first-class OpenRouter recording and fork behavior is desired.

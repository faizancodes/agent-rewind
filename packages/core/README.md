# @agentrewind/core

Dependency-free Node 20 ESM runtime for AgentRewind.

Most users should install the umbrella package, `@agentrewind/sdk`. Use
`@agentrewind/core` directly when you want the runtime without the CLI package
or bundled provider clients.

## API Surface

```ts
import { AgentRewind } from "@agentrewind/core";
```

Core exports:

- `AgentRewind.record()` for live recording.
- `AgentRewind.recordRun()` for the common record-once-and-close flow.
- `AgentRewind.replayRun()` for the common load-and-run replay flow.
- `AgentRewind.withProvider()` for binding `{ model, codec, store, tools }`
  once and reusing that setup for record/replay helpers.
- `AgentRewind.replay()` for strict, warning, or passthrough replay.
- `AgentRewind.listSessions()` and `AgentRewind.resolveSessionPath()` for
  finding sessions in a store without manually joining `.rewind/<id>` paths.
- `AgentRewind.summary()` and `AgentRewind.listSessionSummaries()` for provider,
  event count, model/tool step, redaction, and token-usage summaries without
  manually walking `events()`.
- `AgentRewind.timeline()` for the same compact rows returned by
  `agentrewind inspect --json`.
- `AgentRewind.promptContext()` and `AgentRewind.promptDiff()` for reading or
  diffing recorded prompts by model-call `site` or step.
- `AgentRewind.toolCall()` for reading recorded tool args, result, error,
  latency, and provenance by tool name or step.
- `AgentRewind.entropyDraw()` for reading recorded `ctx.clock()`,
  `ctx.random()`, `ctx.uuid()`, or `ctx.env()` values by source or step.
- `AgentRewind.pack()` and `AgentRewind.unpack()` for programmatic bundle
  creation/restoration; `pack()` accepts the same session selectors as replay.
- `assertProviderClient()` for failing fast when a codec does not match the SDK
  client shape.
- `assertProviderCodec()` and `assertCodecConformance()` for failing fast when
  a custom codec is incomplete or cannot normalize/store/rebuild fixtures.
- `Replay.fork()` for replay-prefix/live-tail forking that writes complete child
  sessions.
- `Replay.search()` for running and ranking multiple fork rollouts from the same
  recorded step.
- `defineTools()` for preserving tool argument/result types in `ctx.tools`.
- `defineHarness()` for preserving harness return types and tool-aware
  `ctx.tools` types without manual generic annotations.
- `defineAgent({ tools, harness })` for carrying tool handlers and harnesses
  together at runtime.
- Session store helpers for JSONL sessions, blobs, vaults, pack, and unpack.
- Fingerprinting, redaction, migration, token usage, typed errors, and
  `explainRewindError()` for readable drift diagnostics.

The main entrypoint intentionally returns the public `Session` and `Replay`
interfaces. Internal recorder/replayer classes are kept out of the common API so
editor autocomplete shows the methods application engineers are expected to use.

`AgentRewind.replay(session)` and `AgentRewind.replayRun(session, ...)` accept a
full session path, a session id with `{ store }`, `latest` with `{ store }`, or a
store directory when it contains exactly one session. `AgentRewind.replay()` can
be loaded without a codec when you only need inspection methods such as
`events()`, `contextAt()`, or `diffContext()`. Pass `{ codec }` before calling
`replay.run()` or `replay.fork()`; otherwise AgentRewind throws a
`ConfigurationError` with that fix in the explanation. Recording setup validates
the required `store`, `model`, and `codec` fields the same way, which gives
JavaScript users actionable setup errors.

Use `AgentRewind.summary(session, { store })` when a test or dashboard needs the
same high-level facts as `agentrewind doctor --json`:

```ts
const summary = await AgentRewind.summary("latest", { store: ".rewind" });
const summaries = await AgentRewind.listSessionSummaries(".rewind");
const timeline = await AgentRewind.timeline("latest", { store: ".rewind" });
console.log(summary.counts.modelCalls, summary.usage.inputTokens);
```

Use prompt inspection helpers when you know a stable model-call `site`:

```ts
const messages = await AgentRewind.promptContext("latest", {
  store: ".rewind",
  site: "draft-answer"
});
const diff = await AgentRewind.promptDiff("latest", {
  store: ".rewind",
  fromSite: "draft-answer",
  toSite: "final-answer"
});
const tool = await AgentRewind.toolCall("latest", {
  store: ".rewind",
  name: "lookupCustomer"
});
const entropy = await AgentRewind.entropyDraw("latest", {
  store: ".rewind",
  source: "uuid"
});
```

Programmatic packing also accepts selectors:

```ts
await AgentRewind.pack("latest", "latest-session.rewind", { store: ".rewind" });
await AgentRewind.unpack("latest-session.rewind", "unpacked-session");
```

## Harness Contract

Harness code must route external boundaries through `ctx`:

```ts
import { defineAgent, defineHarness, defineTools } from "@agentrewind/core";

const tools = defineTools({
  lookup: async (args: { id: string }) => ({ id: args.id, plan: "enterprise" as const })
});

const harness = defineHarness(tools, async (ctx) => {
  const id = ctx.uuid();
  const response = await ctx.model.create(request, { site: "decision" });
  const result = await ctx.tools.lookup({ id });
  return { response, result };
});
const agent = defineAgent({ tools, harness });
```

Use `ctx.clock()`, `ctx.random()`, `ctx.uuid()`, and `ctx.env(key)` instead of
ambient globals when those values affect prompts, tool args, or control flow.
Strict replay serves the recorded values instead of reading live environment
state.

If the harness calls `ctx.tools.someTool()` during recording but the session was
created without a matching tool handler, AgentRewind throws a
`ConfigurationError` that names the missing tool and lists the configured tools.
The usual fix is to use `defineAgent({ tools, harness })`, or pass the same
`tools` object to `defineHarness(tools, harness)` and the `tools` option on
`AgentRewind.record()` or `AgentRewind.recordRun()`.

Tool arguments, tool results, model requests, and normalized model responses
must be JSON-compatible. Use `toolSerializers` for tool values that need runtime
types such as `Date`, `Map`, classes, or `Buffer`; keep SDK-specific conversions
inside provider codecs.

## Error Diagnostics

```ts
import { AgentRewind, explainRewindError } from "@agentrewind/core";

try {
  await AgentRewind.replayRun(".rewind/demo", { codec }, harness);
} catch (error) {
  console.error(explainRewindError(error, {
    sessionPath: ".rewind/demo"
  }));
  throw error;
}
```

The formatter turns structured `RewindError.data` into expected/actual boundary
details, common checks, and useful CLI commands.

## Forking

Prefer `Replay.fork({ atStep, harness, model })` when you want the fork to run
your current agent code. If `harness` is omitted, fork reuses the last harness
passed to `Replay.run()` when one is available. If a replay is freshly loaded
and no harness has been run, fork falls back to a stored-event tail walk: prefix
boundary events are persisted into the child as `provenance: "recorded"`, tail
model calls go live through the supplied model client, and matching tail tools
are recorded into the child as `provenance: "recorded"`.

The resulting child is a normal replayable session. It contains the recorded
prefix plus the forked live/stub tail, so a child created from a model step
after a tool call can replay with a full matching harness instead of needing a
tail-only harness. If the fork changed a prompt or model request, replay the
child with the updated harness code that now produces that forked tail request.
`fork.tokensSpent` only counts live tail model calls.

`atStep` follows the same linearized boundary-event steps returned by
`events()` and printed by the CLI. Splitting inside concurrent work is
best-effort because each async lane keeps its own order and the cross-lane split
is reconstructed from recorded initiation steps.

## Trajectory Search

`Replay.search()` runs repeated forks from one recorded boundary and ranks the
child sessions with your scorer. Use it for small prompt/model sweeps or sampled
rollouts when a bad run has a measurable goal.

```ts
const replay = await AgentRewind.replay(".rewind/support-router", { codec });
await replay.run(harness);

const search = await replay.search({
  atStep: 2,
  harness,
  model,
  strategy: "beam",
  onRolloutError: "continue",
  budget: { maxRollouts: 3, stopScore: 1 },
  actions: [
    { id: "hold", overrides: { system: "Ask for more context." } },
    { id: "escalate", overrides: { system: "Enterprise exceptions escalate-to-csm." } }
  ],
  score: ({ result }) => ({
    score: String(result).includes("escalate-to-csm") ? 1 : 0,
    reason: String(result)
  })
});

console.log(search.searchPath); // .rewind/searches/<search-id>.json
```

Supported strategies are `beam`, `monte-carlo`, `ucb`, `mcts`, and
`alpha-zero`. `budget.maxRollouts`, `budget.maxDepth`, `budget.beamWidth`,
`budget.explorationWeight`, `budget.puctExploration`, `budget.maxTokens`, and
`budget.stopScore` bound provider spend. `concurrency`, `signal`, `retry`,
`rateLimit`, `onRollout`, `onNode`, and `onBest` give operational control for
longer searches. `best` is the highest single rollout; `bestBranch` can select
the strongest aggregate branch by `mean`, `lower-confidence-bound`, or
`pass-rate`. Each rollout is implemented with
`Replay.fork()`, so every candidate writes a normal child session with recorded
prefix events and live/stub tail events. Search validates that `atStep` is a
recorded boundary, records failed rollout nodes when `onRolloutError:
"continue"` is used, writes a manifest under `<store>/searches/`, and annotates
child session metadata with the search id, rollout, action sequence, and score.
Action diagnostics use stable action hashes, so dynamic actions that reuse the
same id but change prompt/model metadata do not collapse into one branch.
If an action changes the prompt or model request, replay the winning child with
harness code that now builds that forked request. See the repository guide
`docs/trajectory-scoring.md` for detailed scoring strategies, including
LLM-as-a-judge natural-language scoring. See
`docs/trajectory-search-strategies.md` for beam search, Monte Carlo search,
UCB, MCTS, AlphaZero-style PUCT, multi-depth action sequences, priors, and
budget tuning.

For common cases, import `search` and use `search.promptSweep()`,
`search.modelSweep()`, `search.regression()`, or `search.judge()` instead of
hand-building `actions` and `score` every time.

## Dependencies

`@agentrewind/core` intentionally has no runtime package dependencies. It uses
Node built-ins only.

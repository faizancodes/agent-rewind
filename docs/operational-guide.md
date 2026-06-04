# Operational Guide

This guide covers the habits that make AgentRewind recordings useful in real
projects.

## Name Boundary Calls

Pass a stable `site` for every model call that represents a meaningful decision:

```ts
await ctx.model.create(request, { site: "classify-ticket" });
await ctx.model.stream(request, { site: "draft-reply-stream" });
await ctx.tools.lookupCustomer({ id: customerId });
```

Tool names already act as call sites. Model `site` names help distinguish
multiple calls with similar requests and make CLI output readable.

The CLI can target those names directly:

```sh
agentrewind context .rewind/support-bot --site classify-ticket
agentrewind diff .rewind/support-bot --from-site draft-reply --to-site final-reply
```

## Route Entropy Through `ctx`

If a value can affect prompts, tool args, or branching, draw it through
AgentRewind:

```ts
const requestId = ctx.uuid();
const receivedAt = ctx.clock();
const sample = ctx.random();
```

Strict replay will serve the recorded values. Ambient `Date.now()`,
`Math.random()`, and `crypto.randomUUID()` are not intercepted.

## Model External I/O As Tools

Strict replay only controls model calls, tool calls, and `ctx` entropy. If your
harness reads a database, calls an HTTP API, or writes a file directly, that work
will happen again during replay. Wrap those operations as tools when their
inputs or outputs affect the agent trajectory.

## Keep Boundaries JSON-Shaped

Model requests, normalized model responses, tool arguments, tool results, and
tool stream chunks must be JSON-compatible after codec normalization or tool
serialization. Use `null`, strings, finite numbers, booleans, arrays, and plain
objects. Convert runtime objects such as `Date`, `Map`, classes, `Buffer`,
`BigInt`, `NaN`, `Infinity`, and functions before they reach AgentRewind.

For tool-specific runtime values, pass `toolSerializers` with `serialize()` and
`deserialize()` functions. For provider SDK objects, keep the conversion inside
the provider codec's `normalizeRequest()` and `normalizeResponse()`.

## Pick The Right Replay Mode

- `strict`: default. No live model/tool calls on replay. Use in tests and
  debugging.
- `warn`: prints drift data, then fails. Use when investigating a mismatch.
- `passthrough`: calls live model/tool handlers on drift. Use for manual
  exploration, not deterministic tests.

## Make Drift Actionable

Use `explainRewindError()` anywhere drift might appear in CI or logs:

```ts
import { AgentRewind, explainRewindError } from "@agentrewind/sdk";

try {
  await AgentRewind.replayRun(".rewind/support-bot", { codec }, harness);
} catch (error) {
  console.error(explainRewindError(error, {
    sessionPath: ".rewind/support-bot"
  }));
  throw error;
}
```

The formatted message summarizes expected vs actual boundaries and includes the
next CLI commands to run. When a named model call drifted, it points to
`agentrewind context <session> --site <name>` so the next command uses the same
logical site name as your harness. The SDK test helpers use the same formatter
when it turns drift into an assertion failure.

For manual investigation, start with the readable timeline:

```sh
agentrewind inspect .rewind/support-bot
```

For scripts and CI diagnostics, use the same data as JSON:

```sh
agentrewind inspect .rewind/support-bot --json
```

## Redaction And Sharing

Redaction is enabled by default. AgentRewind stores redacted events and keeps a
local encrypted vault so replay can restore secrets on the same machine.

Use `pack` before sharing a session:

```sh
agentrewind pack .rewind/support-bot support-bot.rewind
```

The `.rewind` bundle excludes the vault. The recipient can inspect and replay
the redacted trajectory, but original secret values are not included.

## CI Pattern

Record a golden trajectory locally, commit or upload the safe packed artifact
according to your project policy, and assert it in tests:

```ts
import { openaiChatCodec } from "@agentrewind/sdk";
import { fromSession } from "@agentrewind/sdk/testing";

test("support router trajectory is stable", async () => {
  const session = await fromSession("support-router", {
    store: "fixtures",
    codec: openaiChatCodec()
  });

  expect(session.replay.events().some((event) => event.kind === "model_call")).toBe(true);
  await session.assertReplay(supportRouterHarness);
});
```

For the common one-line case, use `assertReplay("latest", { store, codec },
harness)`. It accepts the same selectors as the runtime replay APIs and turns
drift into a Node `AssertionError` with AgentRewind's readable explanation.

Run the full workspace checks before publishing:

```sh
pnpm check
```

## Forking Workflow

Use fork when you want to replay everything before a decision and try a live
tail with new prompt or model settings.

For common provider-backed experiments, start with the CLI:

```sh
agentrewind inspect .rewind/support-bot
agentrewind fork .rewind/support-bot \
  --site classify-ticket \
  --system "Prioritize escalation accuracy over brevity." \
  --dry-run
agentrewind fork .rewind/support-bot \
  --site classify-ticket \
  --system "Prioritize escalation accuracy over brevity."
```

The fork command creates a child session and prints the follow-up `inspect` and
`context` commands. The child session contains the recorded prefix and the
forked tail, with provenance marking which boundaries were served from the
parent recording and which ones were live. It reads provider keys from
environment variables, so keep keys outside shell history by using env vars
instead of command-line flags.

Use the SDK when the fork needs current harness code or a goal predicate:

```ts
const replay = await AgentRewind.replay(".rewind/support-bot", {
  codec
});

const fork = await replay.fork({
  atStep: 3,
  harness,
  model,
  overrides: {
    system: "Prioritize escalation accuracy over brevity."
  },
  goal: (trace) => trace.reached("sendEscalation")
});
```

`fork.tokensSpent` only counts live tail model usage. The child session metadata
points back to the parent recording, and the child can be strictly replayed with
the full matching harness when the same recorded prefix tools and agent code
shape are available. For prompt/model fixes, that usually means the updated
harness code now builds the request that the fork tested.

## Trajectory Search Workflow

Use search when a single fork is not enough and you have a clear scoring rule.
Search runs multiple fork rollouts from the same recorded step and writes a
child session for each candidate.

CLI prompt sweep:

```sh
agentrewind search .rewind/support-bot \
  --site classify-ticket \
  --candidate "Escalate::Enterprise support exceptions should escalate-to-csm." \
  --candidate "Hold::Ask for more evidence before escalation." \
  --goal-contains "escalate-to-csm" \
  --strategy beam
```

For larger candidate sets, put them in JSON:

```json
[
  { "id": "escalate", "label": "Escalate enterprise exceptions", "system": "Enterprise exceptions should escalate-to-csm." },
  { "id": "hold", "label": "Hold for more context", "system": "Ask for more evidence before escalation." }
]
```

Then run:

```sh
agentrewind search .rewind/support-bot --site classify-ticket --actions candidates.json --goal-json '$.route=escalate-to-csm'
```

CLI scoring also supports `--goal-contains`, `--goal-regex`, `--goal-tool`, and
`--scorer ./score.mjs` for project-specific or LLM-as-a-judge checks.

Use `replay.search()` in tests when the scorer needs domain logic from the
harness result or child trace. Bound spend with `budget.maxRollouts`,
`budget.maxTokens`, and `budget.stopScore`. Search writes a durable manifest
under `<store>/searches/` and annotates child session metadata with the search
id, rollout, action sequence, and score/error. Once the best candidate is
selected, replay the child session with the fixed harness as the regression
test. For scoring recipes and LLM-as-a-judge guidance, read
[Trajectory search scoring strategies](trajectory-scoring.md). For beam,
Monte Carlo, UCB, MCTS, AlphaZero-style PUCT, multi-depth action generation,
priors, and budget tuning, read
[Trajectory search strategy guide](trajectory-search-strategies.md).

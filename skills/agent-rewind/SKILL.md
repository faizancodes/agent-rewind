---
name: agent-rewind
description: Add, modify, debug, verify, or publish AgentRewind deterministic record/replay/fork/search support in TypeScript LLM-agent codebases. Use this skill whenever the user mentions AgentRewind, @agentrewind/sdk, agent-rewind, replaying agent runs, recording LLM agent trajectories, forking prompts from a step, trajectory search, beam search, Monte Carlo, UCB, MCTS, AlphaZero-style PUCT over agent rollouts, wrapping model/tool calls, debugging drift, provider presets for OpenAI/OpenRouter/Anthropic, npm package verification, or creating tests/smoke tests for this package.
---

# AgentRewind

Use this skill to help engineers integrate AgentRewind into TypeScript agents and prove that record/replay/fork/search behavior works.

AgentRewind captures the external boundaries that make agents hard to debug:

- model calls through `ctx.model.create()` or `ctx.model.stream()`
- tool calls through `ctx.tools.*`
- prompt-affecting entropy through `ctx.uuid()`, `ctx.clock()`, `ctx.random()`, and `ctx.env(key)`

Strict replay should serve recorded boundary outputs and make zero live model or tool calls. Forking reuses a recorded prefix, then sends the tail live so prompt/model changes can be tested from the exact failed step. Trajectory search runs and ranks multiple fork rollouts from the same step. A forked child session must persist both pieces: recorded prefix boundaries with `provenance: "recorded"` and forked tail boundaries with live or stub provenance.

## Package Surface

Install one package for normal app use:

```sh
npm install @agentrewind/sdk
```

`@agentrewind/sdk` installs the runtime, CLI binaries (`agentrewind` and `arw`), built-in provider codecs, OpenAI client, Anthropic client, and replay test helpers. Use this root SDK export in application code. Use `@agentrewind/sdk/testing` for test helpers and `@agentrewind/sdk/advanced` for lower-level internals.

Granular packages still exist for library authors: `@agentrewind/core`, `@agentrewind/cli`, `@agentrewind/test`, `@agentrewind/codec-openai`, `@agentrewind/codec-openrouter`, and `@agentrewind/codec-anthropic`.

Do not import from an unscoped `agentrewind` package. `agentrewind` is the CLI command name.

## First Moves

1. Inspect the target repo before editing:
   - `package.json`
   - provider SDK usage: `rg "new OpenAI|Anthropic|chat\\.completions|messages\\.create|responses\\.create|baseURL|OPENROUTER"`
   - tool and external I/O boundaries
   - existing tests, build scripts, and CI scripts
2. Choose the simplest provider preset that matches the agent:
   - OpenAI Chat Completions: `createOpenAIRewind()`
   - generic OpenAI-compatible Chat Completions endpoint: `createOpenAICompatibleRewind()`
   - OpenRouter: `createOpenRouterRewind()`
   - Anthropic Messages: `createAnthropicRewind()`
3. Confirm model calls can move behind `ctx.model.create()` or `ctx.model.stream()`.
4. Move external work that affects prompts, tool arguments, or control flow behind `ctx.tools`.
5. Move prompt-affecting entropy behind `ctx.uuid()`, `ctx.clock()`, `ctx.random()`, and `ctx.env(key)`.
6. Add fake-client tests before suggesting live API tests.

For exact provider setup snippets, read `references/provider-setup.md`.
For implementation patterns, read `references/implementation-patterns.md`.
For verification and smoke-test strategy, read `references/verification.md`.
For trajectory-search scoring strategies, read the repository doc
`docs/trajectory-scoring.md` when available.
For trajectory-search strategy details, read the repository doc
`docs/trajectory-search-strategies.md` when available.
For common trajectory-search implementation, prefer `search.promptSweep()`,
`search.modelSweep()`, `search.regression()`, and `search.judge()` from
`@agentrewind/sdk` before hand-wiring actions and scorers.

## Default Integration Workflow

Use provider presets first. They bind the model client, codec, default store, tool handlers, and provider-specific TypeScript request/response types.

```ts
import { createOpenAIRewind, defineAgent, defineHarness, defineTools } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => crm.customers.get(args.customerId)
});

const rewind = createOpenAIRewind({ store: ".rewind", tools });

const harness = defineHarness(tools, async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: process.env.OPENAI_MODEL ?? "gpt-5.5",
      messages: [{ role: "user", content: JSON.stringify(customer) }],
      temperature: 0
    },
    { site: "summarize-customer" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const agent = defineAgent({ tools, harness });
const recorded = await rewind.recordRun({ id: "support-summary" }, agent);
const replayed = await rewind.replayRun(recorded.path, agent);
```

Use `defineAgent({ tools, harness })` when an agent has tools. It keeps the runtime tools and typed harness together so users do not pass tools in two places.

Use `AgentRewind.withProvider({ model, codec, store, tools })` when the app already constructs its provider client or uses a custom codec. Use low-level `AgentRewind.record()` / `AgentRewind.replay()` only when the integration needs manual session control.

## CLI Workflow

Useful commands after the first recording:

```sh
agentrewind list .rewind
agentrewind doctor latest --store .rewind
agentrewind inspect latest --store .rewind
agentrewind timeline latest --store .rewind --kind model_call --site summarize-customer
agentrewind context latest --store .rewind --site summarize-customer
agentrewind prompt latest --store .rewind --step 3
agentrewind tool latest --store .rewind --name lookupCustomer
agentrewind entropy latest --store .rewind --source uuid
agentrewind fork latest --store .rewind --site summarize-customer --system "Try the corrected policy prompt." --dry-run
agentrewind search latest --store .rewind --site summarize-customer --candidate "Escalate::Escalate enterprise exceptions." --goal-contains escalate --dry-run
agentrewind pack latest demo.rewind --store .rewind
```

Use `doctor` first when a session looks suspicious. Use `inspect`/`timeline` for step numbers and filters. Use `context`/`prompt` to read the exact recorded model prompt. Use `fork --dry-run` to verify one changed tail without spending provider tokens. Use `search --dry-run` to verify a candidate sweep before running multiple live rollouts. Add `--check-provider` when you explicitly want credential/client validation during the dry run.

## Engineering Rules

- Give every meaningful model call a stable `site`, such as `{ site: "classify-ticket" }`.
- Use `ctx.model.*`, `ctx.tools.*`, and `ctx.env()` inside harnesses instead of direct provider SDK, external API, or `process.env` reads when the value can affect prompts or branching.
- Keep provider setup outside the harness.
- Prefer provider presets and `defineAgent()` for normal app code.
- Use `assertProviderClient(model, codec)` only on manual provider wiring.
- Treat replay drift as useful signal. Do not hide it with permissive replay modes when building deterministic tests.
- Do not ask users to paste API keys. Use local env files outside the repo, such as `/tmp/agentrewind-smoke.env` or `/tmp/agentrewind-npm.env`.
- Keep `.rewind/*/vault.enc` local. Use `agentrewind pack` before sharing sessions.

## Provider Decision Tree

- OpenAI Chat Completions: `createOpenAIRewind()`.
- Generic OpenAI-compatible endpoint with `baseURL`: `createOpenAICompatibleRewind()`.
- OpenRouter: `createOpenRouterRewind()`.
- Anthropic Messages: `createAnthropicRewind()`.
- Existing provider client plus built-in codec: `AgentRewind.withProvider({ model, codec })`.
- OpenAI Responses API, Assistants API, raw `fetch`, or another SDK shape: no built-in codec wraps it yet. Implement a custom `ProviderCodec` or adapt the client behind a supported method path.

## Verification Checklist

Before saying an integration works, verify with evidence:

- TypeScript compiles.
- Unit tests pass.
- A fake-client record/replay test proves strict replay does not make a second live model call.
- Tool handlers are not called again during strict replay.
- Streaming is tested if the agent streams.
- Entropy values embedded in prompts are replayed, including `ctx.env()`.
- CLI inspection works on a recorded session: `doctor`, `inspect`/`timeline`, `context`/`prompt`, `tool`, `entropy`, `fork --dry-run`, `pack`, and `unpack`.
- Fork tests replay the child session with the full matching harness and prove prefix tools/entropy are served from the child recording. For prompt fixes, the matching harness should include the updated prompt code that the fork tested.
- Search tests rank multiple fork rollouts, respect rollout/token/stop-score budgets, and replay the winning child with the full matching harness.
- Redaction keeps key-shaped secrets out of `events.jsonl`; packed bundles exclude `vault.enc`.
- Optional live smoke tests run only from local env vars and never print secrets.

## When Modifying This Package Itself

If the user is editing the AgentRewind package rather than adopting it:

- Run the focused script for the changed area when possible: `pnpm test:unit`, `pnpm test:cli`, `pnpm test:providers`, or `pnpm test:coverage`.
- Run `pnpm check` before release-level claims.
- Run `pnpm release:check`, `pnpm package:smoke`, and `pnpm publish:dry-run` before publishing.
- After publishing, verify npm versions and run a clean install/import/bin smoke test.
- For provider changes, test deterministic codec fixtures and fork record/replay round trips.
- For OpenAI, Anthropic, or OpenRouter SDK syntax changes, fetch current provider docs first.

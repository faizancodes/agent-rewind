---
name: agent-rewind
description: Add, modify, debug, verify, or publish AgentRewind deterministic record/replay/fork support in TypeScript LLM-agent codebases. Use this skill whenever the user mentions AgentRewind, @agentrewind/sdk, agent-rewind, replaying agent runs, recording LLM agent trajectories, forking prompts from a step, wrapping model/tool calls, debugging drift, provider codecs for OpenAI/OpenRouter/Anthropic, npm package verification, or creating tests/smoke tests for this package.
---

# AgentRewind

Use this skill to help engineers integrate AgentRewind into TypeScript agents and verify that record/replay/fork behavior actually works.

AgentRewind captures model calls, tool calls, and entropy draws made through an `AgentContext`. Strict replay should serve recorded outputs and make zero live model/tool calls.

The published package family is:

- `@agentrewind/sdk`: normal application entrypoint. It installs and re-exports the runtime, CLI, built-in provider codecs, OpenAI and Anthropic clients, and replay test helpers.
- `@agentrewind/core`: dependency-free runtime.
- `@agentrewind/cli`: CLI implementation used by the SDK package.
- `@agentrewind/test`: replay regression helpers.
- `@agentrewind/codec-openai`, `@agentrewind/codec-openrouter`, `@agentrewind/codec-anthropic`: provider codecs.

Use `@agentrewind/sdk` for application imports. Use `agentrewind` only as the CLI command name, not as a package import.

## First Moves

1. Inspect the target repo before editing:
   - `package.json`
   - provider SDK usage (`rg "new OpenAI|Anthropic|chat\\.completions|messages\\.create|responses\\.create"`)
   - tool/external I/O boundaries
   - tests and dev scripts
2. Identify the provider path:
   - OpenAI Chat Completions or generic OpenAI-compatible: `openaiChatCodec()`
   - OpenRouter: `openRouterChatCodec()` and `openRouterClientOptions()`
   - Anthropic Messages: `anthropicCodec()`
   - Other SDK shape: custom `ProviderCodec`
3. Confirm model calls can be routed through `ctx.model.create()` or `ctx.model.stream()`.
4. Route external work that affects prompts/control flow through `ctx.tools`.
5. Route prompt-affecting entropy through `ctx.uuid()`, `ctx.clock()`, and `ctx.random()`.
6. Add or update tests with fake SDK-shaped clients before suggesting live API tests.

For exact provider setup snippets, read `references/provider-setup.md`.
For implementation patterns, read `references/implementation-patterns.md`.
For verification and smoke-test strategy, read `references/verification.md`.

## Integration Workflow

Use this sequence for most code changes:

1. Install `@agentrewind/sdk`.
2. Create the live SDK client outside the harness.
3. Select the codec once and reuse it for record/replay/fork.
4. Fail fast if the client and codec do not match:
   ```ts
   assertProviderClient(model, codec);
   ```
5. Define a harness:
   ```ts
   import { assertProviderClient, defineHarness, defineTools } from "@agentrewind/sdk";

   assertProviderClient(model, codec);

   const tools = defineTools({
     lookup: async (args: { id: string }) => externalSystem.lookup(args.id)
   });

   const harness = defineHarness(tools, async (ctx) => {
     const id = ctx.uuid();
     const data = await ctx.tools.lookup({ id });
     return ctx.model.create(requestFrom(data), { site: "decision-name" });
   });
   ```
6. Record:
   ```ts
   const recorded = await AgentRewind.recordRun(
     {
       id: "demo",
       store: ".rewind",
       model,
       codec,
       tools
     },
     harness
   );
   ```
7. Replay:
   ```ts
   await AgentRewind.replayRun(recorded.path, { codec }, harness);
   ```
8. Inspect:
   ```sh
   agentrewind inspect .rewind/demo
   agentrewind inspect .rewind/demo --json
   agentrewind context .rewind/demo
   agentrewind context .rewind/demo --site decision-name
   agentrewind diff .rewind/demo
   agentrewind fork .rewind/demo --site decision-name --system "Try the corrected prompt." --dry-run
   ```

## Engineering Rules

- Give every meaningful model call a stable `site`, e.g. `{ site: "classify-ticket" }`.
- Use CLI `--site`, `--from-site`, and `--to-site` when inspecting named model calls.
- Use `assertProviderClient(model, codec)` during setup so wrong SDK/codec pairs fail before recording.
- Import public runtime helpers from `@agentrewind/sdk` in applications unless there is a specific reason to depend on `@agentrewind/core` directly.
- Do not call provider SDK methods directly inside the harness.
- Do not import from an unscoped `agentrewind` package; that name is not the published SDK package.
- Do not use ambient `Date.now()`, `Math.random()`, or `crypto.randomUUID()` when values can affect prompts, tool args, or branching.
- Do not claim live provider compatibility unless a real-key smoke test was run.
- Do not ask users to paste API keys. Use a local env file outside the repo, such as `/tmp/agentrewind-smoke.env`.
- Treat replay drift as useful signal. Do not paper over it unless the user explicitly chooses `passthrough`.
- Keep `.rewind/*/vault.enc` local. Use `agentrewind pack` before sharing sessions.

## Provider Decision Tree

- If code uses `client.chat.completions.create()` with OpenAI: use `openaiChatCodec()`.
- If code uses OpenRouter: use `openRouterChatCodec()` and `openRouterClientOptions()`.
- If code uses another OpenAI-compatible endpoint via `baseURL`: use `openaiChatCodec()`.
- If code uses Anthropic `client.messages.create()`: use `anthropicCodec()`.
- If code uses OpenAI Responses API, Assistants API, raw `fetch`, or another SDK shape: explain that no built-in codec wraps it yet; implement a custom `ProviderCodec` or adapt the client behind supported method paths.

## Verification Checklist

Before saying the integration works, verify with evidence:

- TypeScript compiles.
- Tests pass.
- A fake-client record/replay test proves no second live call is made during strict replay.
- Streaming is tested if the agent streams.
- Tool handlers are not called during strict replay.
- Entropy values embedded in prompts are replayed.
- Redaction keeps key-shaped secrets out of `events.jsonl`.
- `agentrewind inspect/context/diff/fork/pack/unpack` works on a recorded session when CLI behavior is in scope.
- Use `agentrewind inspect --json` when an automation needs stable timeline fields.
- Optional live smoke tests run only from local env vars and never print secrets.
- If package exports or metadata changed, verify an installed consumer can import from `@agentrewind/sdk` and run `npx agentrewind --help`.

## When Modifying This Package Itself

If the user is editing AgentRewind rather than adopting it in another repo:

- Run `pnpm check` after changes.
- Run a built-artifact probe if package exports changed.
- Run `pnpm pack:packages` and `pnpm publish:dry-run` before publishing.
- After publishing, verify all public packages with `npm view <package> version` and run a clean npm install smoke test.
- For provider changes, test both normalization fixtures and AgentRewind record/replay round trips.
- For OpenAI, Anthropic, or OpenRouter SDK syntax, fetch current docs first.

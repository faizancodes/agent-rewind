# Verification

Use this reference when proving AgentRewind actually works in a target codebase.

## No-Key Fake Client Test

Prefer this before live provider tests. Fake clients should match the provider SDK method paths and count live calls:

```ts
import assert from "node:assert/strict";
import { AgentRewind, defineHarness, openaiChatCodec } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

let liveCalls = 0;

const model = {
  chat: {
    completions: {
      async create() {
        liveCalls += 1;
        return {
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              logprobs: null,
              message: { role: "assistant", content: "ok", refusal: null }
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        };
      }
    }
  }
};

const rewind = AgentRewind.withProvider({
  store: ".rewind-test",
  model,
  codec: openaiChatCodec()
});

const harness = defineHarness(async (ctx) => {
  const response = await ctx.model.create<ChatCompletion>(
    {
      model: "test-model",
      messages: [{ role: "user", content: `request ${ctx.uuid()}` }]
    },
    { site: "fake-model-call" }
  );
  return response.choices[0]?.message.content ?? "";
});

const recorded = await rewind.recordRun({ id: "fake-client" }, harness);
assert.equal(await rewind.replayRun(recorded.path, harness), "ok");
assert.equal(liveCalls, 1);
```

If `liveCalls` is `2`, replay made a live provider call and the integration is wrong.

## Tool Replay Test

For agents with tools, count live handler calls:

```ts
import { defineTools } from "@agentrewind/sdk";

let lookupCalls = 0;
const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => {
    lookupCalls += 1;
    return { id: args.customerId, tier: "enterprise" };
  }
});
```

Record and replay the same `defineAgent({ tools, harness })`, then assert the tool call count did not increase during replay.

## Streaming Test

For streaming agents, fake `chat.completions.stream()` or `messages.stream()`:

```ts
async function* asyncIterable(values: unknown[]) {
  for (const value of values) {
    yield value;
  }
}
```

Record stream chunks, replay them, and assert the reconstructed user-visible text is identical.

## Entropy And Env Test

If prompts or branches use entropy, include the value in a recorded request and replay it:

```ts
const flag = ctx.env("SUPPORT_ROUTER_POLICY") ?? "default";
const requestId = ctx.uuid();
```

Strict replay should use the recorded `ctx.env()` value, UUID, clock, and random draws, even if the live environment changes after recording.

## CLI Test

Run against a real recorded session:

```sh
agentrewind list .rewind
agentrewind doctor latest --store .rewind
agentrewind inspect latest --store .rewind
agentrewind timeline latest --store .rewind --kind model_call
agentrewind inspect latest --store .rewind --json
agentrewind context latest --store .rewind --site decision-name
agentrewind prompt latest --store .rewind --step 3
agentrewind diff latest --store .rewind
agentrewind tool latest --store .rewind --name lookupCustomer
agentrewind tool latest --store .rewind --name lookupCustomer --json
agentrewind entropy latest --store .rewind --source uuid
agentrewind fork latest --store .rewind --site decision-name --system "Try the corrected prompt." --dry-run
agentrewind search latest --store .rewind --site decision-name --candidate "Fixed::Try the corrected prompt." --goal-contains "expected" --dry-run
agentrewind search report <search-id> --store .rewind
agentrewind search promote <winning-child> --out /tmp/agentrewind-regression.json
agentrewind pack latest demo.rewind --store .rewind
agentrewind unpack demo.rewind unpacked-demo
test ! -e unpacked-demo/vault.enc
```

Use `--site`, `--from-site`, and `--to-site` for named model calls. Use strict numeric step values from `inspect` when a site repeats. For fork/search dry runs, add `--check-provider` only when you want the command to validate provider credentials and client setup.

For deterministic CI fork/search tests, point `--provider openai-compatible --base-url <local-test-server>` at a local OpenAI-compatible test endpoint and use `--api-key-env` with a throwaway env var.

## Live Smoke Env File

Do not ask users to paste keys into chat. Ask them to create a local env file outside the repo:

```sh
cat > /tmp/agentrewind-smoke.env <<'EOF'
OPENAI_API_KEY=...
OPENAI_MODEL=...
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-4o-mini
EOF

chmod 600 /tmp/agentrewind-smoke.env
```

For generic OpenAI-compatible providers:

```sh
cat >> /tmp/agentrewind-smoke.env <<'EOF'
COMPATIBLE_API_KEY=...
COMPATIBLE_BASE_URL=https://provider.example/v1
COMPATIBLE_MODEL=provider/model
EOF
```

Source the file inside the smoke-test command, sanitize printed errors, and remove temporary `.rewind` stores after the test.

## Live Smoke Assertions

For each provider smoke test:

- Provider setup succeeds before recording.
- Exactly one live model call happens during recording.
- Strict replay returns the same value.
- Strict replay does not make another live model call.
- Usage is present when the provider returns it.
- Fork dry run succeeds for the recorded model-call step.
- A live fork succeeds only when intentionally spending provider tokens.
- The forked child session contains recorded prefix boundaries plus live tail
  boundaries.
- The forked child replays with the full matching harness, and prefix tools are
  not called again. For prompt fixes, the matching harness includes the updated
  prompt code that the fork tested.
- Search ranks multiple candidates, respects budget settings, reports the best
  child, reports `bestBranch` for aggregate branch selection when relevant,
  writes a persisted report, and can promote the winning child into a regression
  fixture.
  child session, and the winning child replays with the full matching harness.
- The response prefix can be printed, but never print keys or full env.

For OpenRouter first-class support, test both create and stream when possible:

- `openRouterChatCodec().name === "openrouter-chat"`
- `openRouterClientOptions().baseURL === "https://openrouter.ai/api/v1"`
- live create records and replays
- live stream records and replays
- fork tail calls preserve OpenRouter request parameters

## Workspace Verification

When working in the AgentRewind repo itself, run focused checks first:

```sh
pnpm typecheck
pnpm test:unit
pnpm test:cli
pnpm test:providers
pnpm build
pnpm examples:run
```

Before release-level claims, run:

```sh
pnpm check
pnpm release:check
pnpm package:smoke
pnpm publish:dry-run
```

`pnpm check` already includes typecheck, tests, build, examples, and package smoke tests.

## Installed Package Smoke Test

For installed-package confidence, create a temporary consumer project and install local tarballs or the published package:

```sh
tmp="$(mktemp -d /tmp/agentrewind-install.XXXXXX)"
cd "$tmp"
npm init -y
npm install @agentrewind/sdk
node --input-type=module -e 'import { AgentRewind, createOpenAIRewind, createOpenRouterRewind, createAnthropicRewind } from "@agentrewind/sdk"; console.log(typeof AgentRewind.recordRun, typeof createOpenAIRewind, typeof createOpenRouterRewind, typeof createAnthropicRewind)'
npx agentrewind --version
npx agentrewind --help
```

## Published Package Verification

The public npm package family should resolve together:

```sh
npm view @agentrewind/sdk version
npm view @agentrewind/core version
npm view @agentrewind/cli version
npm view @agentrewind/test version
npm view @agentrewind/codec-openai version
npm view @agentrewind/codec-openrouter version
npm view @agentrewind/codec-anthropic version
```

If publishing needs an npm token, keep it outside the repo:

```sh
cat > /tmp/agentrewind-npm.env <<'EOF'
NPM_TOKEN=...
EOF
chmod 600 /tmp/agentrewind-npm.env
```

Source the token without printing it, write temporary npm config outside the repo, and remove that temporary npm config after publishing. Never write npm tokens into tracked files or chat.

# Verification

Use this reference when proving AgentRewind actually works in a target codebase.

## No-Key Fake Client Test

Prefer this before live provider tests. Fake clients should match SDK method
paths and count live calls:

```ts
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
```

Record, replay, then assert `liveCalls === 1`. If it is `2`, replay made a live
call and the integration is wrong.

## Streaming Test

For streaming agents, fake `chat.completions.stream()` or `messages.stream()`:

```ts
async function* asyncIterable(values: unknown[]) {
  for (const value of values) yield value;
}
```

Record stream chunks, replay them, and assert the reconstructed user-visible
text is identical.

## CLI Test

Run against a real recorded session:

```sh
agentrewind inspect .rewind/demo
agentrewind inspect .rewind/demo --json
agentrewind context .rewind/demo
agentrewind context .rewind/demo --site decision-name
agentrewind diff .rewind/demo
agentrewind pack .rewind/demo demo.rewind
agentrewind unpack demo.rewind unpacked-demo
test ! -e unpacked-demo/vault.enc
```

`context` defaults to the first model call and `diff` defaults to the first two
model calls. Use `--site`, `--from-site`, and `--to-site` when testing named
model calls. Use explicit model-call step numbers from `inspect` when a site is
repeated or you need a specific prompt comparison. Entropy and tool calls may
appear before model calls.

## Live Smoke Env File

Do not ask users to paste keys into chat. Ask them to create a local env file
outside the repo:

```sh
cat > /tmp/agentrewind-smoke.env <<'EOF'
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
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

Source the file inside the command, sanitize all printed errors, and remove
temporary `.rewind` stores after the smoke test.

## Live Smoke Assertions

For each provider smoke test:

- `assertProviderClient(model, codec)` passes before recording.
- Make exactly one live call during recording.
- Strict replay returns the same value.
- Strict replay does not make another live call.
- Usage is present when the provider returns it.
- The response text prefix can be printed, but never print keys or full env.

For OpenRouter first-class support, test both create and stream when possible:

- `openRouterChatCodec().name === "openrouter-chat"`
- `openRouterClientOptions().baseURL === "https://openrouter.ai/api/v1"`
- live create records/replays
- live stream records/replays

## Workspace Verification

When working in the AgentRewind repo itself, run:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm examples:run
pnpm check
```

If public exports or package metadata changed, also run release packaging checks:

```sh
pnpm pack:packages
pnpm publish:dry-run
```

For installed-package confidence, create a temporary consumer project and install
local tarballs or the published packages:

```sh
tmp="$(mktemp -d /tmp/agentrewind-install.XXXXXX)"
cd "$tmp"
npm init -y
npm install @agentrewind/sdk
node --input-type=module -e 'import { AgentRewind, OpenAI, Anthropic, openaiChatCodec, openRouterChatCodec, anthropicCodec, assertReplay } from "@agentrewind/sdk"; console.log(typeof AgentRewind.recordRun, typeof OpenAI, typeof Anthropic, typeof openaiChatCodec, typeof openRouterChatCodec, typeof anthropicCodec, typeof assertReplay)'
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

If publishing needs an npm token, keep it outside the repo, source it without
printing it, and remove temporary npm config files after publishing. Never write
npm tokens into tracked files or chat.

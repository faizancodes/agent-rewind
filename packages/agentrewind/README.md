# agentrewind

Umbrella package for AgentRewind.

This package re-exports the public `@agentrewind/core` API and installs the
`agentrewind` / `arw` CLI binaries.

Install it with the provider codec your agent needs:

```sh
pnpm add agentrewind @agentrewind/codec-openai openai
pnpm add agentrewind @agentrewind/codec-openrouter openai
pnpm add agentrewind @agentrewind/codec-anthropic @anthropic-ai/sdk
```

```ts
import OpenAI from "openai";
import { AgentRewind, assertProviderClient, defineHarness, defineTools } from "agentrewind";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import type { ChatCompletion } from "openai/resources/chat/completions";

const model = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const codec = openaiChatCodec();

assertProviderClient(model, codec);

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => ({ id: args.customerId })
});

const harness = defineHarness(tools, async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ customerId: "cus_123" });
  const completion = await ctx.model.create<ChatCompletion>(
    {
      model: "your-chat-model",
      messages: [{ role: "user", content: JSON.stringify(customer) }]
    },
    { site: "summarize-customer" }
  );

  return completion.choices[0]?.message.content ?? "";
});

const recorded = await AgentRewind.recordRun(
  {
    id: "support-summary",
    store: ".rewind",
    model,
    codec,
    tools
  },
  harness
);

const replayed = await AgentRewind.replayRun(recorded.path, { codec }, harness);

// Once sessions exist, replay APIs can resolve ids and `latest` from a store.
await AgentRewind.replayRun("latest", { store: ".rewind", codec }, harness);
const summary = await AgentRewind.summary("latest", { store: ".rewind" });
const summaries = await AgentRewind.listSessionSummaries(".rewind");
const timeline = await AgentRewind.timeline("latest", { store: ".rewind" });
const prompt = await AgentRewind.promptContext("latest", {
  store: ".rewind",
  site: "summarize-customer"
});
const toolCall = await AgentRewind.toolCall("latest", {
  store: ".rewind",
  name: "lookupCustomer"
});
const entropy = await AgentRewind.entropyDraw("latest", {
  store: ".rewind",
  source: "uuid"
});
await AgentRewind.pack("latest", "latest-session.rewind", { store: ".rewind" });
```

See the repository README for the full record, replay, fork, redaction, CLI,
and examples guide.

First useful CLI command before writing integration code:

```sh
agentrewind quickstart openai
agentrewind quickstart openai --out agentrewind-openai.ts
```

First useful CLI command after recording:

```sh
agentrewind list .rewind
agentrewind doctor .rewind/<session-id>
agentrewind doctor <session-id> --store .rewind
agentrewind doctor latest --store .rewind
agentrewind tool <session-id> --store .rewind --name lookupCustomer
agentrewind entropy <session-id> --store .rewind --source uuid
```

`doctor` validates the session and tells you which inspect/context/diff commands
to run next. The single-session CLI commands accept a full session path, a
session id with `--store`, or `latest --store .rewind`.

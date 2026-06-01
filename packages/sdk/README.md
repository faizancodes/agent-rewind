# @agentrewind/sdk

Single-install package for AgentRewind.

```sh
npm install @agentrewind/sdk
```

This package installs the runtime, `agentrewind` / `arw` CLI binaries, built-in
provider codecs, OpenAI and Anthropic clients, and replay test helpers. The root
export is for normal app code; use `@agentrewind/sdk/testing` for test helpers
and `@agentrewind/sdk/advanced` for lower-level internals.

```ts
import { AgentRewind, createOpenAIRewind, defineAgent, defineHarness, defineTools } from "@agentrewind/sdk";
import type { ChatCompletion } from "@agentrewind/sdk";

const tools = defineTools({
  lookupCustomer: async (args: { customerId: string }) => ({ id: args.customerId })
});
const rewind = createOpenAIRewind({ store: ".rewind", tools });

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
const agent = defineAgent({ tools, harness });

const recorded = await rewind.recordRun({ id: "support-summary" }, agent);

const replayed = await rewind.replayRun(recorded.path, agent);

// Once sessions exist, replay APIs can resolve ids and `latest` from a store.
await rewind.replayRun("latest", agent);
const summary = await AgentRewind.summary("latest", { store: ".rewind" });
const prompt = await AgentRewind.promptContext("latest", {
  store: ".rewind",
  site: "summarize-customer"
});
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

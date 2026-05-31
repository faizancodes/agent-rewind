# @agentrewind/test

Test helpers for asserting that a harness still replays from a recorded
AgentRewind session.

## Install

```sh
pnpm add -D @agentrewind/test
npm install --save-dev @agentrewind/test
```

## One-Shot Assertion

Use `assertReplay()` when the test only needs to prove that the current harness
still matches a stored recording:

```ts
import { defineHarness } from "@agentrewind/sdk";
import { assertReplay } from "@agentrewind/test";
import { openaiChatCodec } from "@agentrewind/codec-openai";

const harness = defineHarness(async (ctx) => {
  await ctx.model.create(
    {
      model: "gpt-5.5",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }]
    },
    { site: "decision" }
  );
});

await assertReplay("latest", { store: ".rewind", codec: openaiChatCodec() }, harness);
```

The session argument can be a full path, a session id with `{ store }`, `latest`
with `{ store }`, or a store directory that contains exactly one session.

## Inspect Then Assert

Use `fromSession()` when the test needs to inspect recorded events before
running the replay assertion:

```ts
import { defineHarness } from "@agentrewind/sdk";
import { fromSession } from "@agentrewind/test";
import { openaiChatCodec } from "@agentrewind/codec-openai";

const session = await fromSession("demo", {
  store: ".rewind",
  codec: openaiChatCodec()
});

const harness = defineHarness(async (ctx) => {
  await ctx.model.create(
    {
      model: "gpt-5.5",
      messages: [{ role: "user", content: `Request ${ctx.uuid()}` }]
    },
    { site: "decision" }
  );
});

expect(session.path).toBe(".rewind/demo");
expect(session.replay.events().some((event) => event.kind === "model_call")).toBe(true);
await session.assertReplay(harness);
```

`fromSession()` also exposes `assertSemanticTrajectory()` as a compatibility
alias for older tests. Prefer `assertReplay()` in new tests because the name
matches the behavior.

If replay drift occurs, the helpers convert the AgentRewind `DriftError` into a
Node `AssertionError`. The assertion message includes a human-readable
explanation with expected vs actual boundary details and useful CLI commands.
The structured drift data is attached as `actual`.

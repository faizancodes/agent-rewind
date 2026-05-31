# AgentRewind Examples

These examples are runnable without API keys, but they are written as real
agent workflows instead of toy API calls. Each fake model client has the same
method shape as the real SDK client that AgentRewind would wrap in production.

The point of every example is the same: run an agent once against live
boundaries, save what happened, then rerun the same agent without repeating
provider calls, tool calls, or side effects.

Run them after building the workspace:

```sh
pnpm build
pnpm examples:run
```

## How To Read These Examples

Start with the business problem in each file, then look for three things:

1. The `harness(ctx)` function is the agent workflow you want to make
   repeatable.
2. Calls through `ctx.model`, `ctx.tools`, `ctx.uuid()`, and `ctx.clock()` are
   replayable boundaries. Calls made outside `ctx` are normal JavaScript and are
   not recorded by AgentRewind.
3. The assertions after replay prove the workflow did not call the live model,
   external tools, or side-effecting services a second time.

In production, replace the fake clients with real OpenAI-compatible, OpenRouter,
or Anthropic SDK clients. Keep the harness structure the same.

The comments in the `.mjs` files are intentionally written for engineers who
are deciding what to copy into an application. Pay closest attention to comments
near `ctx.model`, `ctx.tools`, `ctx.clock()`, `ctx.uuid()`, `record.close()`,
`replay.run()`, and `replay.fork()`: those are the places where normal agent
code becomes replayable.

If you specifically want to understand forking, read
`fork-replay-prompt-fix/index.mjs` first. That file is the dedicated forking
replay example: it records a bad run, strictly replays it, then forks at the
model-call step so only the changed tail calls a live model.

The shortest mental model for a forked replay is:

- Replay the recorded prefix exactly as it happened.
- Stop at the recorded step you want to experiment with.
- Run the tail live with explicit changes, such as a new system prompt or model.
- Assert that the fork reached the behavior you wanted.

## `sample-agent`

Real-world use case: an on-call automation agent made the wrong incident-routing
decision, and you need to understand the prompt context, replay the failure, and
fork a prompt fix from the exact bad step.

This example shows the full lifecycle:

- Record the bad routing decision.
- Replay the same workflow without a live model.
- Inspect the model prompt at the bad step.
- Fork from that step with a stricter incident-commander system prompt.
- Assert the forked run reaches the desired escalation outcome.

Use this when you want to debug or improve a past agent decision without trying
to manually reconstruct the original inputs.

## `fork-replay-prompt-fix`

Real-world use case: a policy-review agent made the wrong refund decision, and
you want to test a prompt fix against the exact same historical policy snapshot
and customer request.

This is the clearest fork-specific example:

- Record the original bad decision.
- Replay it strictly without tools or a model.
- Fork from the recorded model-call step.
- Reuse the recorded prefix, including UUID and policy lookup.
- Send only the tail model call live with an overridden system instruction.
- Assert the fork reaches the corrected decision.

Use this when you need to evaluate prompt/model changes against a real recorded
agent run without rerunning earlier tools or manually rebuilding context.

## `openai-compatible-support-bot`

Real-world use case: a SaaS support triage agent reads customer/account data,
checks current incidents, and classifies a ticket through an OpenAI-compatible
Chat Completions provider.

This example shows why AgentRewind is useful for support agents:

- Tool calls such as account lookup and incident lookup are recorded.
- The OpenAI-compatible model call is recorded.
- Replay does not hit the tools or model again.
- API-key-shaped text in the ticket is redacted from `events.jsonl`.

Use this pattern for OpenAI, Azure OpenAI, local OpenAI-compatible gateways, or
hosted inference APIs that expose `client.chat.completions.create()`.

## `openai-compatible-streaming`

Real-world use case: an incident-management system streams a customer-facing
status page update as the model writes it.

This example shows how to record and replay streamed model output:

- The agent builds a prompt from an incident snapshot.
- The model response arrives as Chat Completions stream chunks.
- Replay rebuilds the same async stream from the session log.
- The app code consumes replayed chunks exactly like live chunks.

Use this pattern when your UI or CLI renders model output incrementally.

## `openrouter-support-router`

Real-world use case: a support platform uses OpenRouter to route high-priority
tickets through a chosen model/provider policy while keeping OpenRouter-specific
request options.

This example shows:

- OpenRouter uses the OpenAI SDK method path, but a first-class OpenRouter codec.
- `openRouterClientOptions()` configures the OpenRouter base URL and attribution
  headers for a real SDK client.
- OpenRouter-specific fields such as `provider`, `plugins`, and
  `response_format` survive record/replay.

Use this pattern when your agent depends on OpenRouter provider routing,
fallbacks, plugins, or OpenRouter model ids such as `provider/model-name`.

## `anthropic-tool-agent`

Real-world use case: a support-reply agent reads policy data, creates an
escalation record, and asks Anthropic Messages to draft the customer response.

This example shows side-effect-safe replay:

- The original run calls tools that simulate database/CRM side effects.
- The model response is recorded through the Anthropic codec.
- Strict replay omits the original tools and model client.
- The side-effecting tool is not run a second time during replay.

Use this pattern when replaying an agent should never duplicate tickets, refunds,
emails, Slack messages, or other external actions.

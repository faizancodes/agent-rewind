# Trajectory Search Scoring Strategies

Trajectory search is only useful when the scoring rule represents the thing you
actually care about. AgentRewind can fork candidate tails from the same recorded
step, but it does not know whether "best" means correct answer, safe behavior,
low cost, a specific tool call, or a better customer outcome. The scorer defines
that.

This guide explains how scoring works, when to use each scoring strategy, and
how to build a natural-language LLM-as-a-judge metric.

For beam search, Monte Carlo search, UCB, MCTS, AlphaZero-style PUCT, dynamic
action generation, action depth, priors, and budget tuning, read
[Trajectory search strategies](trajectory-search-strategies.md).

## Scoring Contract

The SDK scorer runs after each rollout:

```ts
const search = await replay.search({
  atStep,
  harness,
  model,
  actions,
  score: async (ctx) => {
    return {
      score: 1,
      reason: "Reached the expected route",
      metadata: { route: "escalate-to-csm" }
    };
  }
});
```

The return value can be either:

```ts
score: () => 1
```

or:

```ts
score: () => ({
  score: 1,
  reason: "Human-readable explanation",
  metadata: { any: "JSON-compatible details" }
})
```

Higher scores win. Scores can be any finite number. A common convention is:

- `1`: fully satisfies the goal.
- `0.5`: partially satisfies the goal.
- `0`: does not satisfy the goal.
- negative values: actively bad, unsafe, too costly, or invalid.

The scorer receives:

```ts
score({
  action,          // current candidate action
  actionSequence, // full sequence when maxDepth > 1
  depth,           // action-sequence depth
  rollout,         // 1-based rollout number
  fork,            // ForkResult
  trace,           // child trace
  result,          // harness return value, if a harness ran
  tokensSpent      // live tail token usage for this rollout
})
```

Use `result` when your harness returns a useful domain value. Use `trace` when
you need to inspect child events, model responses, tool calls, or provenance.
Use `tokensSpent` when cost should influence the score.

`metadata` should be JSON-compatible. AgentRewind sanitizes score metadata
before storing nodes and CLI reports so circular objects, functions, errors, and
non-finite numbers do not break report serialization.

## CLI Scoring

The CLI has a few practical built-in scoring metrics:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --candidate "Escalate::Enterprise exceptions should escalate-to-csm." \
  --candidate "Hold::Ask for more context." \
  --goal-contains "escalate-to-csm"
```

`--goal-contains <text>` scores each rollout as:

- `1` if the live model output contains `<text>`.
- `0` otherwise.

Other built-ins:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --actions candidates.json \
  --goal-regex "escalate-(to|for)-csm"
```

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --actions candidates.json \
  --goal-json '$.route=escalate-to-csm'
```

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --actions candidates.json \
  --goal-tool createEscalation
```

You can combine built-ins; all checks must pass for a score of `1`. For fully
custom scoring, including LLM-as-a-judge, pass an ESM scorer module:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --actions candidates.json \
  --scorer ./score-support-routing.mjs
```

The module exports `default function score(ctx)` or `export function score(ctx)`.
It receives the same scorer context as the SDK: `action`, `actionSequence`,
`fork`, `trace`, `result`, and `tokensSpent`.

Use built-in CLI scoring when the desired outcome is easy to identify from
model text, JSON, or tool calls. Use SDK scoring or `--scorer` when you need
policy rules, cost adjustment, multi-objective scoring, or LLM-as-a-judge.

## Strategy 1: Text Match

Use text matching when the target is literal and stable:

- route names such as `escalate-to-csm`
- status values such as `approved`
- short tags such as `needs-human-review`
- exact command names in a coding-agent response

```ts
score: ({ result }) => {
  const text = String(result).toLowerCase();
  return text.includes("escalate-to-csm") ? 1 : 0;
}
```

Text matching is fast, deterministic, cheap, and easy to understand. It is also
fragile. It can miss semantically correct answers that use different wording,
and it can pass outputs that mention the target while rejecting it.

Use it for smoke tests and narrow routing decisions. Do not use it as your only
metric for open-ended reasoning quality.

## Strategy 2: Parsed JSON Decision

Use parsed JSON scoring when your agent already returns structured output:

```ts
type Decision = {
  route: "hold" | "refund-approved" | "escalate-to-csm";
  confidence: number;
  reason: string;
};

score: ({ result }) => {
  const decision = JSON.parse(String(result)) as Decision;
  if (decision.route === "escalate-to-csm" && decision.confidence >= 0.8) {
    return { score: 1, reason: "Correct route with high confidence", metadata: decision };
  }
  if (decision.route === "refund-approved") {
    return { score: 0.5, reason: "Helpful but not the target route", metadata: decision };
  }
  return { score: 0, reason: `Wrong route: ${decision.route}`, metadata: decision };
}
```

This is usually better than text matching because it scores the value the agent
actually commits to. It also gives you useful `metadata` for test output and
debugging.

Recommended pattern:

1. Make the harness return a parsed domain object when possible.
2. Validate the object shape before scoring.
3. Penalize invalid JSON or missing fields.

```ts
score: ({ result }) => {
  try {
    const decision = JSON.parse(String(result)) as { route?: string };
    return decision.route === "escalate-to-csm"
      ? { score: 1, reason: "Correct route", metadata: decision }
      : { score: 0, reason: "Wrong route", metadata: decision };
  } catch {
    return { score: -1, reason: "Invalid JSON response" };
  }
}
```

## Strategy 3: Harness Result Scoring

The cleanest scoring strategy is to have the harness return the exact business
object you want to score:

```ts
const harness = async (ctx) => {
  const customer = await ctx.tools.lookupCustomer({ id: "cus_123" });
  const completion = await ctx.model.create(requestFor(customer), { site: "decision" });
  return parseDecision(completion);
};

const search = await replay.search({
  atStep,
  harness,
  model,
  actions,
  score: ({ result }) => {
    return result.route === "escalate-to-csm" ? 1 : 0;
  }
});
```

This keeps scoring close to product logic. It also avoids parsing raw model text
inside the scorer when your app already has parsing code.

Use this when:

- the agent workflow returns a domain result
- the application already validates model output
- you want CI tests to score application behavior, not only raw text

## Strategy 4: Tool-Call or Event Scoring

Sometimes the right answer is not a string. The agent might need to call the
right tool, avoid a risky tool, or stop before a side effect.

Use `trace.events()` for this:

```ts
score: ({ trace }) => {
  const events = trace.events();
  const createdEscalation = events.some(
    (event) => event.kind === "tool_call" && event.name === "createEscalation"
  );
  const sentRefund = events.some(
    (event) => event.kind === "tool_call" && event.name === "issueRefund"
  );

  if (sentRefund) return { score: -1, reason: "Issued refund when escalation was required" };
  if (createdEscalation) return { score: 1, reason: "Created escalation" };
  return { score: 0, reason: "No escalation tool call" };
}
```

Tool-call scoring is useful for agents that perform actions:

- coding agents applying a patch
- support agents creating escalations
- ops agents opening incidents
- finance agents issuing refunds
- browser agents submitting forms

Prefer this over text scoring when the actual business outcome is a tool call.

## Strategy 5: Regression-Test Scoring

Use regression scoring when the best child must satisfy a set of assertions.
This turns "find a better fork" into "find a fork that would pass CI."

```ts
score: ({ result, trace }) => {
  const errors: string[] = [];

  if (result.route !== "escalate-to-csm") {
    errors.push(`route=${result.route}`);
  }
  if (!trace.events().some((event) => event.kind === "model_call" && event.provenance === "live")) {
    errors.push("no live tail model call");
  }
  if (trace.events().some((event) => event.kind === "tool_call" && event.name === "issueRefund")) {
    errors.push("issued refund");
  }

  return {
    score: errors.length === 0 ? 1 : 0,
    reason: errors.length === 0 ? "All assertions passed" : errors.join("; ")
  };
}
```

This strategy is easy to turn into a permanent test:

1. Run search on a historical bad run.
2. Pick the winning child session.
3. Replay that child with the fixed harness.
4. Assert the same conditions in CI.

The SDK helper keeps this pattern concise:

```ts
import { search } from "@agentrewind/sdk";

const result = await search.regression(replay, {
  atStep,
  harness,
  model,
  actions,
  assertions: [
    ({ result }) => ({ pass: result.route === "escalate-to-csm", reason: `route=${result.route}` }),
    ({ trace }) => !trace.reached("issueRefund")
  ]
});
```

## Strategy 6: Cost-Adjusted Scoring

Sometimes two candidates both reach the goal, but one spends far more tokens.
Use cost-adjusted scoring when token spend matters.

```ts
score: ({ result, tokensSpent }) => {
  const reachedGoal = String(result).includes("escalate-to-csm");
  const totalTokens = tokensSpent.inputTokens + tokensSpent.outputTokens;
  const costPenalty = Math.min(totalTokens / 10_000, 0.25);

  return {
    score: reachedGoal ? 1 - costPenalty : 0,
    reason: reachedGoal
      ? `Reached goal with ${totalTokens} live tail tokens`
      : "Did not reach goal",
    metadata: { totalTokens, costPenalty }
  };
}
```

Cost-adjusted scores should not hide correctness failures. A cheap wrong answer
should still score below an expensive correct answer unless your use case
explicitly prioritizes cost over quality.

## Strategy 7: Multi-Objective Scoring

Multi-objective scoring combines multiple signals:

- correctness
- safety
- tool behavior
- cost
- verbosity
- latency proxies
- confidence

```ts
score: ({ result, trace, tokensSpent }) => {
  const text = String(result);
  const correct = text.includes("escalate-to-csm") ? 1 : 0;
  const safe = text.toLowerCase().includes("refund-approved") ? 0 : 1;
  const usedEscalationTool = trace.events().some(
    (event) => event.kind === "tool_call" && event.name === "createEscalation"
  )
    ? 1
    : 0;
  const totalTokens = tokensSpent.inputTokens + tokensSpent.outputTokens;
  const cost = Math.max(0, 1 - totalTokens / 20_000);

  const score = 0.55 * correct + 0.25 * safe + 0.15 * usedEscalationTool + 0.05 * cost;

  return {
    score,
    reason: `correct=${correct} safe=${safe} tool=${usedEscalationTool} cost=${cost.toFixed(2)}`,
    metadata: { correct, safe, usedEscalationTool, totalTokens }
  };
}
```

Keep multi-objective scoring explicit. Avoid hidden magic weights. If a
criterion is mandatory, make it a gate:

```ts
if (!safe) return { score: -1, reason: "Failed safety gate" };
```

Then score quality among the candidates that pass the gate.

## Strategy 8: Natural-Language LLM-as-a-Judge Scoring

Use LLM-as-a-judge scoring when the goal is too nuanced for text matching or
simple JSON checks. Examples:

- "The answer should be helpful but not overpromise."
- "The coding-agent fix should address the root cause, not only the symptom."
- "The support reply should be empathetic, accurate, and escalation-ready."
- "The agent should preserve user intent while following policy."
- "The explanation should cite the relevant tool facts and avoid unsupported
  claims."

The judge is a separate model call made by your scorer. It reads the candidate
output, compares it against a natural-language rubric, and returns a numeric
score plus a rationale.

Important: judge calls are live calls made by the scorer. They are not part of
the forked child session unless your own code records them separately. Store the
judge result in `metadata`, test logs, or an external evaluation artifact if you
need an audit trail.

### Natural-Language Metric Template

Define the metric before writing code:

```text
Metric: Support routing quality

Score 1.0:
- Correctly routes enterprise refund exceptions inside the 30-day exception
  window to escalate-to-csm.
- Uses the policy snapshot supplied in the prompt.
- Does not claim the refund is approved.
- Gives a concise reason suitable for an internal routing log.

Score 0.5:
- Recognizes that the ticket is enterprise-sensitive, but chooses an incomplete
  or ambiguous next step.
- Mentions escalation but does not clearly choose escalate-to-csm.

Score 0.0:
- Chooses hold, deny, refund-approved, or any route other than escalate-to-csm.
- Ignores the policy snapshot.
- Invents policy facts not present in the recorded context.

Safety gate:
- If the output says a refund was issued or approved, score -1.
```

This is better than saying "judge whether the output is good." A clear rubric
makes scores more stable and easier to review.

### LLM-as-a-Judge Helper

The SDK includes a provider-agnostic judge scorer. You provide the judge
function; AgentRewind handles rubric shape, structured judge output validation,
redaction, caching, JSON-safe metadata, and separate judge token/cost reporting.

```ts
import { search } from "@agentrewind/sdk";

const rubric = search.defineJudgeRubric({
  name: "support-routing-quality",
  goal: "Choose the route that best handles an enterprise refund exception.",
  criteria: [
    {
      id: "correct-route",
      description: "Routes enterprise refund exceptions to escalate-to-csm instead of hold or refund-approved."
    },
    {
      id: "uses-policy",
      description: "Uses the supplied policy snapshot and does not invent policy facts."
    }
  ],
  minScore: -1,
  maxScore: 1,
  passScore: 0.8
});

const cache = search.createMemoryJudgeCache();

const result = await search.judge(replay, {
  atStep: badStep,
  harness,
  model: rolloutModel,
  strategy: "beam",
  actions,
  rubric,
  cache,
  redact: (text) => text.replace(/cus_[A-Za-z0-9]+/g, "cus_[redacted]"),
  judge: async (input) => {
    const judged = await callYourJudgeModel(input);
    return {
      score: judged.score,
      reason: judged.reason,
      confidence: judged.confidence,
      criteria: judged.criteria,
      metadata: { judgeModel: "gpt-4o-mini" },
      usage: judged.usage
    };
  }
});

console.log(result.judgeUsage); // separate from result.tokensSpent
console.log(result.best?.scoreMetadata);
```

Cache hits do not add to `result.judgeUsage`. Rollout model spend remains in
`result.tokensSpent`; judge spend remains in `result.judgeUsage`.

### Manual LLM-as-a-Judge Example

This example uses the OpenAI Node SDK. The current SDK supports
`client.chat.completions.create()` for chat completions and also has parsing
helpers for structured outputs. This example uses `response_format:
{ type: "json_object" }` to avoid adding another dependency.

```ts
import OpenAI from "openai";

const judge = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function judgeSupportRouting(input: {
  candidateLabel: string;
  candidatePrompt: unknown;
  candidateOutput: unknown;
}): Promise<{ score: number; reason: string; confidence: number }> {
  const completion = await judge.chat.completions.create({
    model: process.env.OPENAI_JUDGE_MODEL ?? "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are grading support-routing agent outputs.",
          "Return only JSON with fields: score, reason, confidence.",
          "score must be a number from -1 to 1.",
          "confidence must be a number from 0 to 1.",
          "",
          "Rubric:",
          "1.0 = routes enterprise refund exceptions inside 30 days to escalate-to-csm, uses supplied policy facts, and does not approve a refund.",
          "0.5 = partially recognizes escalation need but the route is ambiguous or incomplete.",
          "0.0 = wrong route, ignores policy facts, or fails to make a useful decision.",
          "-1.0 = unsafe action, such as claiming refund approval or issuing refund."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify(input)
      }
    ]
  });

  const content = completion.choices[0]?.message.content ?? "{}";
  const parsed = JSON.parse(content) as { score?: unknown; reason?: unknown; confidence?: unknown };
  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : 0;
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;

  return {
    score: Math.max(-1, Math.min(1, score)),
    reason: typeof parsed.reason === "string" ? parsed.reason : "Judge returned no reason.",
    confidence: Math.max(0, Math.min(1, confidence))
  };
}
```

Use the judge inside `replay.search()`:

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model: rolloutModel,
  strategy: "beam",
  budget: { maxRollouts: 4, stopScore: 0.95 },
  actions,
  score: async ({ action, result, trace }) => {
    const candidatePrompt = trace
      .events()
      .find((event) => event.kind === "model_call" && event.provenance === "live")
      ?.request.messages;

    const judged = await judgeSupportRouting({
      candidateLabel: action.label ?? action.id ?? "unnamed",
      candidatePrompt,
      candidateOutput: result
    });

    return {
      score: judged.score,
      reason: judged.reason,
      metadata: {
        judge: "support-routing-quality",
        confidence: judged.confidence
      }
    };
  }
});
```

### When To Use LLM-as-a-Judge

Use it when:

- The output is natural language.
- Correctness depends on multiple qualitative criteria.
- You need to compare explanations, plans, or code-review quality.
- You can tolerate judge cost and judge variance.
- You have a clear rubric.

Avoid it when:

- A deterministic check can answer the question.
- The candidate output contains sensitive data you should not send to a judge.
- The judge model is the same weak point you are trying to evaluate.
- You need a hard compliance gate without human review or deterministic checks.

### LLM-as-a-Judge Reliability Rules

Use these guardrails:

1. Set judge temperature to `0` or as low as the provider supports.
2. Ask for structured JSON.
3. Clamp the returned score to the allowed range.
4. Include a short, explicit rubric.
5. Include the relevant recorded facts, not the entire session log.
6. Penalize unsafe outputs before asking for quality nuance.
7. Cache judge results when rerunning the same candidates.
8. Keep judge spend separate from rollout spend in reports.
9. Do not let the judge mutate application state.
10. Treat judge scores as evaluation evidence, not as a replacement for
    deterministic regression tests.

For high-stakes workflows, combine deterministic gates with judge scoring:

```ts
score: async ({ result }) => {
  if (String(result).includes("refund-approved")) {
    return { score: -1, reason: "Safety gate failed: refund approval claimed" };
  }

  const judged = await judgeSupportRouting({
    candidateLabel: "candidate",
    candidatePrompt: "omitted",
    candidateOutput: result
  });

  return judged.score >= 0.8
    ? { score: judged.score, reason: judged.reason, metadata: judged }
    : { score: 0, reason: `Judge below threshold: ${judged.reason}`, metadata: judged };
}
```

## Strategy 9: Pairwise Judge Ranking

A scalar judge score asks "how good is this candidate?" Pairwise judging asks
"which candidate is better?" Pairwise judging can be more stable for subjective
outputs, but it is more expensive because it compares candidates.

AgentRewind's scorer is called per rollout, so pairwise judging is not the
default shape. To approximate it:

1. Score each candidate with a scalar rubric.
2. Keep the top few candidates.
3. Run a separate pairwise evaluation over `search.nodes`.
4. Use the pairwise result to decide which child session to keep.

Pairwise ranking is useful for writing quality, coding-agent plans, and support
reply tone. It is usually unnecessary for routing, JSON decisions, or tool-call
goals.

## Strategy 10: Human Review Scoring

For some workflows, the best score is a human decision. You can use trajectory
search to produce candidate child sessions, then export `search.nodes` for a
review queue.

Use this when:

- the cost of a bad decision is high
- legal, medical, financial, or safety policy review is required
- the team is still designing the rubric

The human score can later become an automated deterministic or judge-based
metric once you understand what reviewers consistently care about.

## Choosing The Right Scoring Strategy

Use this decision table:

| Goal | Best first strategy |
| --- | --- |
| Output must contain a literal route/status | Text match |
| Agent returns structured JSON | Parsed JSON decision |
| App code already parses model output | Harness result scoring |
| Correctness is a side-effect/tool call | Tool-call or event scoring |
| Candidate must satisfy CI assertions | Regression-test scoring |
| Multiple candidates are correct but one is cheaper | Cost-adjusted scoring |
| Correctness, safety, and cost all matter | Multi-objective scoring |
| Output quality is subjective natural language | LLM-as-a-judge |
| Outputs are subjective and close in quality | Pairwise judge ranking |
| The rubric is not mature yet | Human review scoring |

Start deterministic. Add LLM-as-a-judge only when deterministic scoring cannot
capture the goal.

## Common Mistakes

- Scoring raw text when the app already has a parsed domain object.
- Giving high scores to unsafe outputs because they contain the target phrase.
- Letting cost penalties make wrong answers beat correct answers.
- Using an LLM judge without a rubric.
- Forgetting that judge calls are extra live calls outside the forked child
  session.
- Comparing candidates that used different recorded prefixes. Search should
  fork from the same `atStep` so comparisons are fair.
- Replaying a prompt-overridden child with the old harness. If a child contains
  the forked prompt request, the replay harness must now build that same request.

## What To Persist

The child session persists the recorded prefix and live tail events. Search also
writes `<store>/searches/<search-id>.json` by default. The manifest contains
scores, reasons, score metadata, errors, diagnostics, best-child details, and
the child session paths. Child `meta.json` files are annotated with the search
id, rollout, action sequence, score, and error when available.

You can still write your own artifact when you want a custom CI report:

```ts
await writeFile(
  "trajectory-search-result.json",
  JSON.stringify(
    {
      best: search.best,
      nodes: search.nodes,
      tokensSpent: search.tokensSpent,
      stoppedReason: search.stoppedReason
    },
    null,
    2
  )
);
```

That artifact is useful in CI because it tells reviewers why a child session was
selected, not only which child won.

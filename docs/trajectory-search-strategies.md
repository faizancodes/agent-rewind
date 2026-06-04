# Trajectory Search Strategies

Trajectory search answers:

> From this exact recorded step, which candidate tail should I try next?

Scoring answers:

> After a candidate tail ran, how good was it?

Keep those ideas separate. The search strategy controls which fork rollouts are
executed. The scoring function ranks the results. For scoring patterns, read
[Trajectory search scoring strategies](trajectory-scoring.md).

AgentRewind supports these search strategies:

- `beam`
- `monte-carlo`
- `ucb`
- `mcts`
- `alpha-zero`

All strategies produce normal forked child sessions. The difference is only how
AgentRewind chooses which candidate actions or action sequences to spend live
rollouts on.

## Core Mental Model

A trajectory search starts from a recorded session and a fork point:

```ts
const replay = await AgentRewind.replay(".rewind/support-router", { codec });
await replay.run(harness);

const search = await replay.search({
  atStep: badModelStep,
  harness,
  model,
  strategy: "beam",
  actions,
  score
});
```

Every rollout:

1. Starts from the same parent session.
2. Replays or copies the recorded prefix up to `atStep`.
3. Applies one action or an action sequence.
4. Runs the tail live through `fork`.
5. Writes a normal child session.
6. Calls your scorer.
7. Adds a node to `search.nodes`.

`atStep` must be an actual recorded boundary step. Passing an arbitrary number
is rejected so SDK searches cannot accidentally replay the wrong tail.

This is important: a deeper action sequence does not continue from a previous
child session. Each candidate sequence is composed, then forked from the same
recorded parent at the same `atStep`. That keeps candidates comparable because
they share the same historical prefix.

For example, a depth-2 sequence like:

```text
strict-policy -> stronger-model
```

does not mean:

```text
run child A, then fork child A
```

It means:

```text
fork the original parent once with both changes composed
```

That keeps search artifacts easier to replay and compare.

## Actions

An action is a candidate change to the forked tail:

```ts
const actions = [
  {
    id: "escalate",
    label: "Escalate enterprise exceptions",
    overrides: {
      system: "Enterprise exceptions inside 30 days should escalate-to-csm."
    }
  },
  {
    id: "model-swap",
    label: "Try a stronger model",
    overrides: {
      model: "gpt-5.5"
    }
  }
];
```

Actions can change:

- `overrides.system`
- `overrides.model`
- `overrides.transformRequest`
- `model`
- `tools`
- `prior`
- `metadata`

When an action sequence has multiple actions:

- the last `system` override wins
- the last `model` override wins
- `transformRequest` functions are chained in sequence order
- the last action-level `model` client wins
- the last action-level `tools` policy wins

Use action IDs that will still make sense in test output and child-session
reports.

Diagnostics also include stable `actionKey` values. AgentRewind generates these
from the action shape, so two dynamic actions can reuse `id: "retry"` without
being merged if their prompt/model metadata differs. Use `actionSequence` for
human-readable output and `actionKeys` / `key` when you need stable branch IDs.

### Priors

`prior` is used by `strategy: "alpha-zero"`:

```ts
const actions = [
  { id: "safe-default", prior: 0.2, overrides: { system: safePrompt } },
  { id: "policy-expert", prior: 0.8, overrides: { system: policyExpertPrompt } }
];
```

Priors are non-negative numbers. AgentRewind normalizes them among sibling
candidates at the same tree node. The semantics are explicit:

- If no sibling declares a prior, every sibling gets a uniform prior.
- If at least one sibling declares a prior, a missing prior counts as `0`. So
  `[{ prior: 0.8 }, {}]` normalizes to `[1.0, 0.0]` rather than handing the
  omitted action the larger weight.
- If the declared priors all sum to `0`, AgentRewind falls back to a uniform
  prior instead of dividing by zero.

Either give every candidate a prior or give none. Mixing a prior with omitted
siblings deprioritizes the omitted ones to `0`.

Use priors when you have a cheap policy signal, for example:

- a heuristic that says one prompt family is likely better
- a router model that suggests likely branches
- historical pass rates for candidates
- human preference weights

Do not treat priors as scores. A prior says "try this branch earlier." The
scorer still decides whether the resulting child run was actually good.

## Budget Controls

Search spend is controlled by `budget`:

```ts
budget: {
  maxRollouts: 10,
  maxDepth: 2,
  beamWidth: 3,
  explorationWeight: Math.SQRT2,
  puctExploration: 1.5,
  maxTokens: 20_000,
  stopScore: 1
}
```

The controls mean:

| Option | Meaning |
| --- | --- |
| `maxRollouts` | Maximum number of fork rollouts to execute. |
| `maxDepth` | Maximum length of an action sequence. Default is `1`. |
| `beamWidth` | Number of best nodes kept after each beam depth. Default is `3`. |
| `explorationWeight` | UCB/UCT exploration weight for `ucb` and `mcts`. Default is `Math.SQRT2`. |
| `puctExploration` | PUCT exploration weight for `alpha-zero`. Default is `1.5`. |
| `maxTokens` | Stop after live tail token usage reaches or exceeds this input+output token budget. |
| `stopScore` | Stop after a rollout score reaches or exceeds this score. |

`maxTokens` is a post-rollout guard. AgentRewind checks the current live-tail
token total before starting a rollout and again after the rollout finishes. A
single rollout can push the total over the budget because token usage is only
known after the provider response is recorded.

The result includes:

```ts
search.stoppedReason
```

Possible values:

- `maxRollouts`
- `maxDepth`
- `maxTokens`
- `stopScore`
- `noActions`

## Operational Controls

Longer searches can be controlled without wrapping the engine yourself:

```ts
const controller = new AbortController();

const result = await replay.search({
  atStep,
  harness,
  model,
  actions,
  score,
  strategy: "beam",
  concurrency: 4,
  signal: controller.signal,
  retry: { attempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 },
  rateLimit: { maxStarts: 5, intervalMs: 1_000 },
  onRollout: (event) => console.log(event.status, event.rollout),
  onBest: (node) => console.log("new best", node.score),
  onNode: (node) => console.log("node", node.id)
});
```

`concurrency` applies to independent beam expansions. Bandit and tree
strategies keep rollout selection sequential because each rollout updates the
statistics used to select the next branch.

Retries rerun the fork/scorer attempt. Use them for transient provider or judge
failures, not for side-effecting live tool policies. `AbortSignal` stops new
work and interrupts retry/rate-limit sleeps.

## Best Rollout vs Best Branch

`result.best` is the highest single rollout score. That is useful for
deterministic prompt sweeps, but stochastic candidates often need aggregate
selection:

```ts
const result = await replay.search({
  atStep,
  actions,
  score,
  strategy: "ucb",
  budget: { maxRollouts: 20 },
  bestBranchBy: "lower-confidence-bound",
  branchPassScore: 0.8
});
```

`result.bestBranch` can be selected by:

| Metric | Use when |
| --- | --- |
| `mean` | You want the highest average score across repeated rollouts. |
| `lower-confidence-bound` | You want a conservative branch that has enough evidence, not one lucky high score. |
| `pass-rate` | You care how often a branch clears `branchPassScore`. |

Each diagnostic branch includes `visits`, `valueSum`, `meanScore`, `minScore`,
`maxScore`, `variance`, `lowerConfidenceBound`, `passCount`, and `passRate`.

## Reports And Promotion

Search persists a report by default:

```ts
console.log(result.searchId);
console.log(result.searchPath); // .rewind/searches/<search-id>.json
```

Open it later from the CLI:

```sh
agentrewind search report <search-id>
agentrewind search report .rewind/searches/<search-id>.json --json
```

When a child is good enough to keep, promote it into a regression fixture:

```sh
agentrewind search promote .rewind/<winning-child> \
  --out tests/fixtures/support-router.regression.json
```

The fixture records the child session, parent search, fork point, action
sequence, stable action keys, and expected score/reason. Your CI test can load
that fixture and replay the child with the fixed harness.

## Defaults

SDK defaults:

```ts
strategy: "monte-carlo"
budget.maxDepth: 1
budget.beamWidth: 3
budget.explorationWeight: Math.SQRT2
budget.puctExploration: 1.5
budget.maxRollouts:
  // beam with a static action array
  actions.length
  // beam with dynamic actions
  10
  // monte-carlo, ucb, mcts, alpha-zero
  10
```

CLI defaults:

```sh
--strategy beam
--tool-miss error
```

The CLI defaults to `beam` because most command-line usage is a deterministic
prompt/model candidate sweep.

## Strategy: Beam Search

Beam search is best for a known list of candidates.

At each depth:

1. Expand the current frontier.
2. Run each candidate action from each frontier node.
3. Score each child node.
4. Sort by score.
5. Keep only the top `beamWidth` nodes for the next depth.

For `maxDepth: 1`, beam search is a deterministic sweep over candidates:

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "beam",
  budget: { maxRollouts: 3, stopScore: 1 },
  actions: [
    { id: "hold", overrides: { system: "Ask for more context." } },
    { id: "escalate", overrides: { system: "Escalate enterprise exceptions." } },
    { id: "refund", overrides: { system: "Prefer refunds for enterprise customers." } }
  ],
  score: ({ result }) => String(result).includes("escalate-to-csm") ? 1 : 0
});
```

Use beam when:

- you have a finite candidate list
- you want deterministic ordering
- you want a readable comparison table
- you want to stop as soon as a candidate reaches `stopScore`
- the candidate space is small enough to try directly

Avoid beam when:

- the candidate space is very large
- you need randomized exploration
- many candidates are near-duplicates and provider spend matters
- stochastic model outputs mean each candidate should be sampled repeatedly

### Beam With Depth

Depth lets you search sequences of actions. For example, depth 1 can choose a
prompt family and depth 2 can choose a model.

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "beam",
  budget: {
    maxDepth: 2,
    beamWidth: 2,
    maxRollouts: 8
  },
  actions: ({ depth }) => {
    if (depth === 1) {
      return [
        { id: "strict-policy", overrides: { system: "Follow the policy snapshot strictly." } },
        { id: "customer-first", overrides: { system: "Prefer customer-friendly escalation." } }
      ];
    }

    return [
      { id: "small-model", overrides: { model: "gpt-4o-mini" } },
      { id: "large-model", overrides: { model: "gpt-5.5" } }
    ];
  },
  score
});
```

The search tree might look like:

```text
root
|- strict-policy
|  |- strict-policy + small-model
|  `- strict-policy + large-model
`- customer-first
   |- customer-first + small-model
   `- customer-first + large-model
```

With `beamWidth: 2`, only the best two nodes at each depth remain on the
frontier for the next expansion.

## Strategy: Monte Carlo

Monte Carlo search samples action sequences randomly.

For each rollout:

1. Randomly choose a depth between `1` and `maxDepth`.
2. For each level, ask for candidate actions.
3. Randomly choose one candidate action.
4. Compose the sequence.
5. Fork, score, and record the child node.

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "monte-carlo",
  budget: {
    maxRollouts: 20,
    maxDepth: 3,
    stopScore: 0.95
  },
  actions: ({ depth, best }) => {
    if (depth === 1) return promptCandidates;
    if (depth === 2) return modelCandidates;
    return best?.score && best.score > 0.75 ? refinementCandidates : broadExplorationCandidates;
  },
  score
});
```

Use Monte Carlo when:

- the candidate space is too large for full beam expansion
- you want exploration rather than a deterministic sweep
- you have a dynamic action generator
- you want a quick sample before designing a focused beam search
- you want to run many cheap randomized prompt mutations

Avoid Monte Carlo when:

- the candidate list is small and direct comparison is cheaper
- reproducibility matters more than exploration
- you cannot tolerate random variance in test output
- you need to repeatedly sample high-performing candidates instead of random candidates

### Deterministic Monte Carlo In Tests

Pass a deterministic random source:

```ts
const randomValues = [0.1, 0.9, 0.3, 0.7];

const search = await replay.search({
  atStep: badStep,
  strategy: "monte-carlo",
  random: () => randomValues.shift() ?? 0,
  actions,
  score
});
```

Use this in tests when you want Monte Carlo behavior without flaky assertions.
The function must follow the `Math.random()` contract and return a finite number
`>= 0` and `< 1`; AgentRewind rejects out-of-range values instead of silently
changing the sampled action.

For multi-depth Monte Carlo, dynamic action generators receive a `parent` node
representing the sampled prefix so far. At depth 1 the parent is the public
`root` node. At depth 2 and beyond, `parent.actionSequence` is the current
sampled sequence before the next random action is chosen. That lets you generate
model candidates after a sampled prompt family, or refinement candidates after a
sampled tool policy.

## Strategy: UCB

UCB is a one-level multi-armed bandit search.

It treats every top-level action as an arm. It first tries unvisited actions,
then repeatedly chooses the arm with the highest upper-confidence score:

```text
meanScore + explorationWeight * sqrt(log(totalVisits) / armVisits)
```

In practical terms:

- high-scoring actions get more rollouts
- under-sampled actions receive exploration pressure
- `explorationWeight: 0` turns it into greedy repeated sampling after each arm
  has been tried once

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "ucb",
  budget: {
    maxRollouts: 12,
    explorationWeight: Math.SQRT2,
    stopScore: 1
  },
  actions: [
    { id: "baseline", overrides: { system: baselinePrompt } },
    { id: "escalate", overrides: { system: escalationPrompt } },
    { id: "refund", overrides: { system: refundPrompt } }
  ],
  score
});
```

Use UCB when:

- each candidate can produce variable results
- you want repeated samples of promising candidates
- you care about balancing exploration and exploitation
- you have a small to medium set of top-level actions
- you want a simple bandit instead of a deeper tree search

Avoid UCB when:

- each candidate only needs to run once
- action sequences matter more than repeated top-level sampling
- you need deterministic candidate ordering
- you need random exploration across a large combinatorial space

Important detail: AgentRewind's UCB strategy is depth-1. It spends rollouts
across the top-level action arms. If you need prompt-then-model or
prompt-then-tool-policy sequences, use `beam`, `mcts`, or `alpha-zero`.

## Strategy: MCTS

MCTS is a tree search using UCT selection.

It searches action sequences up to `maxDepth`. At a high level:

1. Start at the root.
2. Expand untried actions in order.
3. Once a node is fully expanded, select children with UCT:

   ```text
   meanScore + explorationWeight * sqrt(log(parentVisits) / childVisits)
   ```

4. Fork and score the selected action sequence.
5. Backpropagate the score through the tree.

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "mcts",
  budget: {
    maxRollouts: 24,
    maxDepth: 2,
    explorationWeight: 1.2,
    stopScore: 1
  },
  actions: ({ depth, parent }) => {
    if (depth === 1) {
      return [
        { id: "strict-policy", overrides: { system: strictPolicyPrompt } },
        { id: "escalation-policy", overrides: { system: escalationPolicyPrompt } }
      ];
    }

    if (parent?.actionSequence.some((action) => action.id === "escalation-policy")) {
      return [
        { id: "small-model", overrides: { model: "gpt-4o-mini" } },
        { id: "large-model", overrides: { model: "gpt-5.5" } }
      ];
    }

    return [
      { id: "default-model", overrides: { model: "gpt-4o-mini" } }
    ];
  },
  score
});
```

Use MCTS when:

- choices are sequential
- early actions change which later actions make sense
- you cannot afford full beam expansion
- you want the search to revisit promising branches
- you have a scorer that can evaluate partial or full trajectories consistently

Avoid MCTS when:

- your candidate list is small enough for beam
- you only need one-level repeated sampling, where UCB is simpler
- your scorer is noisy and you cannot afford enough rollouts to average it out
- your action generator is hard to audit

MCTS nodes include extra search statistics:

```ts
node.visits;
node.valueSum;
node.meanScore;
node.selectionScore;
node.selectionReason;
```

These are useful for debugging why the tree revisited a branch.

If a dynamic action generator returns no deeper actions for a branch, that branch
is a terminal leaf. MCTS marks it exhausted and re-simulates it as a leaf rather
than stopping the whole search, so the remaining budget still explores or
exploits the other branches.

## Strategy: AlphaZero-Style PUCT

`alpha-zero` is a PUCT-style tree search. It is not a full AlphaZero training
system: AgentRewind does not train a neural policy/value network or perform
self-play. It uses the same replay/fork/scoring loop as other strategies, but
tree selection uses action priors.

The PUCT score is:

```text
meanScore + puctExploration * prior * sqrt(parentVisits) / (1 + childVisits)
```

The effect is:

- high-prior branches are tried earlier
- strong observed scores still dominate over time
- low-prior branches can still be explored when budget allows

```ts
const search = await replay.search({
  atStep: badStep,
  harness,
  model,
  strategy: "alpha-zero",
  budget: {
    maxRollouts: 24,
    maxDepth: 2,
    puctExploration: 1.5,
    stopScore: 1
  },
  actions: ({ depth }) => {
    if (depth === 1) {
      return [
        { id: "safe-default", prior: 0.2, overrides: { system: safePrompt } },
        { id: "policy-expert", prior: 0.8, overrides: { system: policyExpertPrompt } }
      ];
    }

    return [
      { id: "cheap-model", prior: 0.7, overrides: { model: "gpt-4o-mini" } },
      { id: "strong-model", prior: 0.3, overrides: { model: "gpt-5.5" } }
    ];
  },
  score
});
```

Use AlphaZero-style PUCT when:

- you have useful priors
- a cheap router or heuristic can guide branch order
- you want tree search, but not blind tree search
- expensive branches should be tried only when they are likely to matter
- you want to combine human preference weights with observed rollout scores

Avoid AlphaZero-style PUCT when:

- you do not have meaningful priors
- priors are stale or biased enough to hide better branches
- you need deterministic full comparison
- you expect the first few rollouts to be treated as definitive

Practical prior sources:

- a classifier that predicts likely successful prompt family
- a small model that proposes branch probabilities
- historical CI pass rate for each candidate
- observed production frequency for each failure mode
- human-assigned confidence weights

When priors are weak, use `mcts` instead. When the tree is small, use `beam`.

## Dynamic Action Generators

`actions` can be a static array or a function:

```ts
actions: ({ strategy, depth, rollout, parent, best }) => {
  return candidates;
}
```

The context fields are:

| Field | Meaning |
| --- | --- |
| `strategy` | `"beam"`, `"monte-carlo"`, `"ucb"`, `"mcts"`, or `"alpha-zero"`. |
| `depth` | Current action-sequence depth being generated. |
| `rollout` | Number of completed rollouts so far. |
| `parent` | Parent node for beam/tree expansion. |
| `best` | Best scored node seen so far. |

For `monte-carlo`, `parent` is the current sampled prefix. For `beam`, `parent`
is the frontier node being expanded. For tree strategies, `parent` is the branch
node selected by UCT/PUCT.

For `mcts` and `alpha-zero`, `parent` is the actual last evaluated rollout node
for that branch (so `parent.score`, `parent.result`, `parent.sessionPath`, and
`parent.reason` are available) with the branch's aggregate `visits`,
`valueSum`, and `meanScore` merged in. The root expansion at depth 1 has no
parent rollout yet, so those result fields are absent there, exactly like beam.

Use dynamic actions when candidates depend on search state:

```ts
actions: ({ depth, parent, best }) => {
  if (depth === 1) {
    return [
      { id: "policy-strict", overrides: { system: strictPolicyPrompt } },
      { id: "policy-lenient", overrides: { system: lenientPolicyPrompt } }
    ];
  }

  if (parent?.action?.id === "policy-strict") {
    return [
      { id: "strict-small", overrides: { model: "gpt-4o-mini" } },
      { id: "strict-large", overrides: { model: "gpt-5.5" } }
    ];
  }

  if (best?.score !== undefined && best.score < 0.5) {
    return [
      { id: "more-context", overrides: { transformRequest: addPolicyContext } }
    ];
  }

  return [
    { id: "default-model", overrides: { model: "gpt-4o-mini" } }
  ];
}
```

Dynamic actions are powerful, but they make search harder to audit. Put useful
labels and metadata on generated actions.

## Search Result Shape

The result keeps a tree of attempted rollouts:

```ts
search.best;
search.nodes;
search.rollouts;
search.tokensSpent;
search.stoppedReason;
search.diagnostics;
```

Each non-root node includes:

```ts
{
  id,
  parentId,
  depth,
  rollout,
  action,
  actionSequence,
  sessionId,
  sessionPath,
  score,
  reason,
  scoreMetadata,
  result,
  tokensSpent,
  reachedGoal,
  divergedAtStep
}
```

Bandit/tree strategies may also include:

```ts
{
  visits,
  valueSum,
  meanScore,
  prior,
  selectionScore,
  selectionReason
}
```

`selectionScore` is always a finite number. Forced first-time exploration omits
`selectionScore` and reports `selectionReason: "unvisited"` instead of a
non-finite score, so the result stays JSON-safe. Computed selections report
`selectionReason: "ucb"` or `selectionReason: "puct"`.

### Diagnostics

`search.diagnostics` is a small JSON-safe summary of how rollouts spread across
attempted action sequences:

```ts
search.diagnostics; // { strategy, rollouts, branches }
search.diagnostics.branches; // sorted by mean score, then visits
```

Each branch entry is:

```ts
{
  actionSequence, // ["escalate-prompt", "strong-model"]
  key,            // "escalate-prompt > strong-model"
  depth,
  visits,         // rollouts that executed exactly this action sequence
  valueSum,
  meanScore
}
```

Use it to see which branches absorbed budget and how each one scored, without
walking `search.nodes` by hand.

Use `search.best?.sessionPath` to inspect or replay the winning child:

```ts
const childReplay = await AgentRewind.replay(search.best!.sessionPath!, { codec });
await childReplay.run(fixedHarness);
```

If the winning action changed the prompt or model request, replay the child with
the updated harness code that now builds that request.

### Persistence

Search writes a manifest by default:

```ts
search.searchId;
search.searchPath; // <store>/searches/<search-id>.json
```

The manifest contains attempted nodes, scores, reasons, score metadata, errors,
branch diagnostics, token usage, and the best child session. Each child
`meta.json` also gets a small `search` annotation with the search id, rollout,
node id, action sequence, and score/error. Pass `persist: false` for purely
in-memory tests, or `persist: { id, dir }` when you need a stable manifest path.

### Rollout Errors

By default, a fork or scorer error fails the whole search. Use
`onRolloutError: "continue"` when provider errors should produce error nodes
and allow the remaining candidates to run:

```ts
const search = await replay.search({
  atStep: badStep,
  actions,
  model,
  onRolloutError: "continue",
  score
});

console.log(search.nodes.filter((node) => node.error));
```

Errored nodes keep their action sequence and serialized error. If the fork had
already written a child session before the scorer failed, the node also includes
the child session path.

## Strategy Selection Table

| Situation | Use |
| --- | --- |
| You have 2-20 explicit prompt candidates | `beam` |
| You want deterministic CLI output | `beam` |
| You want to compare every candidate once | `beam` with `maxDepth: 1` |
| You want prompt-family then model-family full expansion | `beam` with `maxDepth: 2` |
| You have a large candidate space | `monte-carlo` |
| You want randomized exploration | `monte-carlo` |
| You want reproducible random sampling in tests | `monte-carlo` with `random` |
| You want repeated sampling of stochastic candidates | `ucb` |
| You want a one-level exploration/exploitation bandit | `ucb` |
| You want sequential planning without priors | `mcts` |
| You want tree search guided by priors | `alpha-zero` |
| You have meaningful policy weights | `alpha-zero` |
| You need adaptive candidate generation | `beam`, `mcts`, or `alpha-zero` with `actions(ctx)` |

## CLI Strategy Examples

Beam prompt sweep:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --strategy beam \
  --candidate "Escalate::Enterprise exceptions should escalate-to-csm." \
  --candidate "Hold::Ask for more context." \
  --goal-contains "escalate-to-csm"
```

Monte Carlo sampled search:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --strategy monte-carlo \
  --max-rollouts 10 \
  --max-depth 2 \
  --candidate "Escalate::Enterprise exceptions should escalate-to-csm." \
  --candidate "Refund::Prefer refund-approved for enterprise accounts." \
  --candidate "Hold::Ask for more context." \
  --goal-contains "escalate-to-csm"
```

UCB repeated candidate sampling:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --strategy ucb \
  --max-rollouts 12 \
  --exploration-weight 1.414 \
  --candidate "Escalate::Enterprise exceptions should escalate-to-csm." \
  --candidate "Refund::Prefer refund-approved for enterprise accounts." \
  --candidate "Hold::Ask for more context." \
  --goal-contains "escalate-to-csm"
```

AlphaZero-style PUCT with priors uses an actions file:

```json
[
  {
    "id": "policy-expert",
    "label": "Policy expert prompt",
    "system": "Enterprise exceptions should escalate-to-csm.",
    "model": "openai/gpt-4o-mini",
    "prior": 0.8
  },
  {
    "id": "safe-default",
    "label": "Safe default prompt",
    "system": "Ask for more context before escalation.",
    "model": "openai/gpt-4o-mini",
    "prior": 0.2
  }
]
```

Run it:

```sh
agentrewind search .rewind/support-router \
  --site classify-ticket \
  --actions candidates.json \
  --goal-contains "escalate-to-csm" \
  --strategy alpha-zero \
  --max-rollouts 8 \
  --puct-exploration 1.5
```

The CLI can score with `--goal-contains`, `--goal-regex`, `--goal-json
path=value`, `--goal-tool`, or `--scorer ./score.mjs`. For dynamic action
generation, use the SDK API.

## Fair Comparisons

Trajectory search is useful because every candidate starts from the same
recorded prefix. Preserve that fairness:

- use the same `atStep` for all candidates
- do not mutate global state inside scorers
- keep candidate actions explicit
- use stable `site` names in the harness
- keep tool policies consistent unless tool policy is the experiment
- separate rollout model spend from judge/scorer model spend
- replay the winning child before treating it as regression coverage

If candidate A saw a different policy snapshot, timestamp, UUID, or tool result
than candidate B, the comparison is no longer a clean trajectory search.

## Limitations

Current limitations:

- UCB is a depth-1 bandit over top-level actions.
- `alpha-zero` is PUCT-style search with priors, not full AlphaZero training,
  self-play, or learned value networks.
- `maxTokens` is a soft stop because token usage is known after a rollout.
- CLI search does not expose dynamic action generators.
- Search rollouts are sequential, not parallel.
- Search manifests persist scalar node metadata, but child sessions still store
  the actual recorded events separately.
- Search does not automatically run pairwise judges. Use `--scorer` or SDK
  scoring for LLM-as-a-judge.
- Deeper action sequences are composed and forked from the same parent session;
  they are not continuing from previous child sessions.

These limitations are deliberate for now. The current implementation prioritizes
debuggability, deterministic replay artifacts, and a simple mental model.

## Common Mistakes

- Using Monte Carlo for three candidates when beam would compare all of them.
- Using UCB when you actually need prompt-then-model sequences.
- Forgetting to set `maxRollouts` when `maxDepth` creates many combinations.
- Treating `maxTokens` as a hard budget.
- Using random Monte Carlo in CI without passing a deterministic `random`.
- Treating AlphaZero-style priors as final scores.
- Thinking `maxDepth: 2` means "continue from the first child session." It does
  not; it composes two actions and forks from the same parent.
- Hiding important differences inside unlabeled actions.
- Comparing candidates with different tool policies when tool policy is not the
  thing being tested.
- Declaring victory from `search.best` without replaying the winning child.

## Practical Defaults

Start with these:

```ts
// Small prompt sweep
strategy: "beam",
budget: { maxRollouts: actions.length, stopScore: 1 }
```

```ts
// Prompt + model sweep
strategy: "beam",
budget: { maxDepth: 2, beamWidth: 2, maxRollouts: 12, stopScore: 1 }
```

```ts
// Larger exploratory run
strategy: "monte-carlo",
budget: { maxRollouts: 20, maxDepth: 3, stopScore: 0.95 }
```

```ts
// Stochastic candidate sampling
strategy: "ucb",
budget: { maxRollouts: 12, explorationWeight: Math.SQRT2, stopScore: 1 }
```

```ts
// Sequential planning without priors
strategy: "mcts",
budget: { maxRollouts: 24, maxDepth: 2, explorationWeight: Math.SQRT2, stopScore: 1 }
```

```ts
// Sequential planning with priors
strategy: "alpha-zero",
budget: { maxRollouts: 24, maxDepth: 2, puctExploration: 1.5, stopScore: 1 }
```

Then tighten the candidate set and turn the winning child replay into a
deterministic regression test.

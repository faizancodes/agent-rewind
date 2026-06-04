# @agentrewind/cli

Command-line inspection and packaging tools for AgentRewind sessions.

The umbrella package `@agentrewind/sdk` installs the same binaries, so most users do
not need to install this package directly.

## Commands

```sh
agentrewind quickstart [openai|openai-compatible|openrouter|anthropic]
agentrewind quickstart openai --format ts
agentrewind quickstart openai --out agentrewind-openai.ts
agentrewind list [.rewind]
agentrewind list [.rewind] --json
agentrewind doctor <session>
agentrewind doctor <session-id> --store .rewind
agentrewind doctor latest --store .rewind
agentrewind inspect <session>
agentrewind timeline <session> --kind model_call --site <name>
agentrewind inspect <session> --json
agentrewind context <session>
agentrewind prompt <session> --site <name>
agentrewind context <session> --step <n>
agentrewind context <session> --site <name>
agentrewind context <session> --json
agentrewind diff <session>
agentrewind diff <session> --from <a> --to <b>
agentrewind diff <session> --from-site <a> --to-site <b>
agentrewind fork <session> --site <name> --system "Updated system prompt"
agentrewind fork latest --store .rewind --step <n> --model <model-id>
agentrewind search <session> --site <name> --candidate "Label::System prompt" --goal-contains <text>
agentrewind search <session> --site <name> --actions candidates.json --goal-json '$.route=escalate-to-csm'
agentrewind search <session> --site <name> --candidate "Label::System prompt" --scorer ./score.mjs
agentrewind search latest --store .rewind --step <n> --actions candidates.json --strategy beam
agentrewind tool <session>
agentrewind tool <session> --name <tool>
agentrewind tool <session> --step <n>
agentrewind tool <session> --json
agentrewind entropy <session>
agentrewind entropy <session> --source uuid
agentrewind entropy <session> --step <n>
agentrewind pack <session> <out.rewind>
agentrewind unpack <out.rewind> <dir>
```

Alias:

```sh
arw inspect <session>
```

## Notes

- `quickstart` prints install commands and a minimal TypeScript record/replay
  starter for the selected provider. Use `--manager pnpm`, `--manager yarn`, or
  `--manager bun` for a different install command. Use `--format ts` to print
  raw TypeScript, or `--out <file>` to write a starter file. Starters use
  `defineHarness()` so TypeScript infers the harness result without a manual
  generic annotation, and they validate required environment variables before
  recording. They also format validation, record, and replay failures with
  `explainRewindError()` and a known session path. `--out` refuses to overwrite
  existing files unless `--force` is passed.
- `list` shows the sessions inside a store such as `.rewind`, including each
  session id, provider, origin, model/tool/entropy counts, token usage, and full
  session path. Use it when you know the store directory but not the exact
  `.rewind/<session-id>` path. `ls` is an alias, and `--json` is available for
  scripts.
- Single-session commands (`doctor`, `inspect`, `context`, `diff`, and `pack`)
  accept a full session path, a session id with `--store`, the special selector
  `latest --store .rewind`, or a store directory when it contains exactly one
  session.
- `doctor` validates that the session can be read and prints a plain-language
  summary with provider, event counts, model/tool steps, redaction status, token
  usage, and suggested next commands. Use `--json` for automation.
- `inspect` prints a labeled timeline table with `step`, `kind`, `lane`,
  `site`, a short fingerprint, request detail, token usage, and flags such as
  `stream`, `error`, or `provenance=live`. `timeline` is an alias. Use
  `--kind`, `--site`, `--errors`, `--live`, `--from`, and `--to` to focus large
  sessions. Use `--full-fingerprint` when comparing exact request/tool hashes,
  `--json` for automation, or `--no-header` for compact TSV output.
- `context` and `diff` operate on model-call steps. By default, `context`
  prints a readable view of the first model call and `diff` compares the first
  two model calls. `prompt` is an alias for `context`; add `--json` for the raw
  recorded message array. Pass `--site`, `--from-site`, or `--to-site` when you
  know the stable `site` name from your harness. Pass `--step`, `--from`, or
  `--to` when you need a specific numeric step from `inspect`.
- `fork` starts at a recorded model-call step, reuses the recorded prefix, and
  sends the tail to a live provider client. Pick the fork point with `--site` or
  `--step`, change the live tail with `--system` and/or `--model`, and add
  `--dry-run` to verify the plan without spending provider tokens. Dry runs do
  not check credentials unless you add `--check-provider`. Built-in
  providers are `openai`, `openai-compatible`, `openrouter`, and `anthropic`.
  API keys are read from `OPENAI_API_KEY`, `COMPATIBLE_API_KEY`,
  `OPENROUTER_API_KEY`, or `ANTHROPIC_API_KEY`; generic compatible endpoints
  also need `COMPATIBLE_BASE_URL` or `--base-url`. Successful forks write a
  complete child session: recorded prefix boundaries keep
  `provenance=recorded`, live tail model calls get `provenance=live`, and the
  child can be inspected or replayed as one complete trajectory.
- `search` runs several fork rollouts from the same recorded model-call step and
  ranks them. Use repeated `--candidate "label::system prompt"` flags for quick
  prompt sweeps, or `--actions candidates.json` for structured candidates shaped
  like `{ "id": "escalate", "label": "Escalate", "system": "...", "model": "...", "prior": 0.8 }`.
  Score candidates with `--goal-contains <text>`, `--goal-regex <pattern>`,
  `--goal-json path=value` / `--goal-json $.path=value`,
  `--goal-tool <name>`, or `--scorer ./score.mjs`.
  A scorer module exports `default function score(ctx)` or `score(ctx)` and can
  implement project-specific checks or LLM-as-a-judge scoring. Use `--strategy
  beam` for deterministic candidate sweeps, `--strategy monte-carlo` for sampled
  rollouts, `--strategy ucb` for repeated bandit sampling, or `--strategy mcts`
  / `--strategy alpha-zero` for tree-search rollouts. Search uses the same
  provider flags as `fork`; each rollout writes a child session, writes a
  `<store>/searches/<search-id>.json` manifest, and prints the best child path.
  Add `--concurrency <n>` for independent beam expansions, `--retry-attempts
  <n>` for transient provider/scorer failures, `--rate-limit <n>` to cap
  rollout starts per second, and `--best-branch-by mean|lower-confidence-bound|pass-rate`
  when stochastic candidates should be selected by aggregate branch behavior
  instead of the single highest rollout.
  Use `agentrewind search report <search-id>` to reopen a persisted manifest and
  `agentrewind search promote <child>` to write a regression fixture from a
  winning child session.
  For SDK scoring patterns, read `docs/trajectory-scoring.md` in the repository. For strategy details,
  including `beam`, `monte-carlo`, `ucb`, `mcts`, `alpha-zero`, depth, priors,
  and budgets, read
  `docs/trajectory-search-strategies.md`.
- `tool` prints a readable recorded tool call by default. Add `--json` for
  `args`, `result`, `error`, stream chunks, latency, and provenance as JSON.
  Use `--name` when the tool appears once, or `--step` after `inspect` when a
  tool appears more than once.
- `entropy` prints a recorded `ctx.clock()`, `ctx.random()`, `ctx.uuid()`, or
  `ctx.env()` draw as JSON. Use `--source` when that source appears once, or
  `--step` after `inspect` when the same source appears more than once.
- `pack` excludes the local vault and prints a redaction summary before writing
  the `.rewind` bundle.
- Session read failures are formatted as AgentRewind errors. If a command cannot
  identify the session, run `agentrewind list .rewind`, pass a full session
  directory such as `.rewind/<session-id>`, or pass `<session-id> --store .rewind`.
- Recording and harness-aware replay/fork experiments are programmatic because
  they need your harness code.

#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicCodec } from "@agentrewind/codec-anthropic";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import { openRouterChatCodec, openRouterClientOptions } from "@agentrewind/codec-openrouter";
import { Command } from "commander";
import OpenAI from "openai";
import {
  AgentRewind,
  assertProviderClient,
  diffPromptContext,
  explainRewindError,
  listSessionSummaries,
  packSession,
  readEntropyDraw,
  readPromptContext,
  readSession,
  readSessionTimeline,
  readToolCall,
  RewindError,
  resolveSessionPath,
  summarizeSession as summarizeCoreSession,
  toJsonValue,
  unpackSession,
  type EntropyEvent,
  type ForkOverrides,
  type JsonValue,
  type ModelCallEvent,
  type NormalizedMessage,
  type ProviderCodec,
  type RewindEvent,
  type SessionSelectorOptions,
  type SessionSummary,
  type SessionTimelineRow,
  type ToolCallEvent,
  type TrajectoryBestBranchMetric,
  type TrajectorySearchAction,
  type TrajectorySearchNode,
  type TrajectorySearchResult,
  type TrajectorySearchScore,
  type TrajectorySearchScoreContext,
  type TrajectorySearchStrategy,
  type Usage
} from "@agentrewind/core";

const program = new Command();
const originalArgv = process.argv.slice();
type MaybePromise<T> = T | Promise<T>;
type CliSearchScorer = (ctx: TrajectorySearchScoreContext) => MaybePromise<number | TrajectorySearchScore>;

program.name("agentrewind").alias("arw").description("Inspect and package AgentRewind sessions").version("0.1.4");

program
  .command("quickstart")
  .argument("[provider]", "openai | openai-compatible | openrouter | anthropic")
  .option("--manager <name>", "package manager for install command: npm, pnpm, yarn, or bun", "npm")
  .option("--format <format>", "output format: markdown or ts")
  .option("--out <file>", "write a TypeScript starter file")
  .option("--force", "overwrite --out when it already exists")
  .description("Print a copyable starter for a provider")
  .action(async (provider: string | undefined, opts: { manager: string; format?: string; out?: string; force?: boolean }) => {
    const format = parseQuickstartFormat(opts.format, Boolean(opts.out));
    const output = formatQuickstart(provider, opts.manager, format);
    if (!opts.out) {
      console.log(output);
      return;
    }
    if (!provider) {
      throw new TypeError("quickstart --out requires a provider: openai, openai-compatible, openrouter, or anthropic.");
    }
    if (format !== "ts") {
      throw new TypeError("quickstart --out writes TypeScript starter files. Use --format ts or omit --format.");
    }
    await writeStarterFile(opts.out, output, Boolean(opts.force));
    const spec = quickstartSpec(parseQuickstartProvider(provider));
    const packageManager = parsePackageManager(opts.manager);
    console.log(`Wrote ${opts.out}`);
    console.log(`Install dependencies: ${installCommand(packageManager, spec.install)}`);
    console.log(`Set environment: ${spec.env.join(" ")}`);
  });

program
  .command("list")
  .alias("ls")
  .argument("[store]", "session store directory", ".rewind")
  .option("--json", "print machine-readable JSON")
  .description("List recorded sessions in a store")
  .action(async (store: string, opts: { json?: boolean }) => {
    const rows = await listStoreSessions(store);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(formatSessionList(store, rows));
  });

program
  .command("doctor")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--json", "print machine-readable JSON")
  .description("Validate a session and explain what it contains")
  .action(async (session: string, opts: SessionSelectorOptions & { json?: boolean }) => {
    const sessionPath = await resolveSessionSelector(session, opts);
    const stored = await readSession(sessionPath);
    const summary = summarizeDoctorSession(stored.meta, stored.events);
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(formatDoctor(sessionPath, summary));
  });

program
  .command("inspect")
  .alias("timeline")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--kind <kind>", "comma-separated event kinds to include", parseTimelineKinds)
  .option("--site <text>", "include only rows whose site contains this text")
  .option("--errors", "include only rows with recorded errors")
  .option("--live", "include only rows with live provenance")
  .option("--from <n>", "include rows at or after this step", parseInteger)
  .option("--to <n>", "include rows at or before this step", parseInteger)
  .option("--full-fingerprint", "show complete request/tool fingerprints")
  .option("--json", "print machine-readable JSON")
  .option("--no-header", "omit the table header")
  .description("Print an event timeline")
  .action(async (session: string, opts: SessionSelectorOptions & TimelineCliOptions & { json?: boolean; header?: boolean }) => {
    const rows = await readSessionTimeline(session, opts);
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (opts.header !== false) {
      console.log(formatTimelineHeader());
    }
    for (const row of rows) {
      console.log(formatTimeline(row));
    }
  });

program
  .command("context")
  .alias("prompt")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "model-call step; defaults to the first model call", parseInteger)
  .option("--site <name>", "model-call site; useful when you named ctx.model calls")
  .option("--json", "print machine-readable JSON")
  .description("Print prompt context at a model-call step")
  .action(async (session: string, opts: SessionSelectorOptions & { step?: number; site?: string; json?: boolean }) => {
    const context = await readPromptContext(session, opts);
    console.log(opts.json ? JSON.stringify(context, null, 2) : formatPromptContext(context));
  });

program
  .command("diff")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--from <n>", "from model-call step; defaults to the first model call", parseInteger)
  .option("--to <n>", "to model-call step; defaults to the next model call", parseInteger)
  .option("--from-site <name>", "from model-call site")
  .option("--to-site <name>", "to model-call site")
  .description("Print a prompt context diff")
  .action(async (session: string, opts: SessionSelectorOptions & { from?: number; to?: number; fromSite?: string; toSite?: string }) => {
    console.log(JSON.stringify(await diffPromptContext(session, opts), null, 2));
  });

program
  .command("fork")
  .argument("<session>", "session path, session id, store with one session, or latest")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "model-call step where the live tail begins", parseInteger)
  .option("--at <n>", "alias for --step", parseInteger)
  .option("--from-step <n>", "alias for --step", parseInteger)
  .option("--site <name>", "model-call site to fork from")
  .option("--provider <name>", "auto, openai, openai-compatible, openrouter, or anthropic", "auto")
  .option("--model <id>", "override the model id for live tail model calls")
  .option("--system <text>", "override the system prompt for live tail model calls")
  .option("--system-file <file>", "read the replacement system prompt from a file")
  .option("--api-key-env <name>", "environment variable containing the provider API key")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--base-url-env <name>", "environment variable containing the OpenAI-compatible base URL")
  .option("--app-url <url>", "OpenRouter attribution URL")
  .option("--app-title <title>", "OpenRouter attribution title")
  .option("--app-categories <list>", "comma-separated OpenRouter attribution categories")
  .option("--tool-miss <policy>", "tail tool miss policy: error or stub", "error")
  .option("--dry-run", "print the resolved fork plan without calling the provider")
  .option("--check-provider", "with --dry-run, validate provider credentials and client shape without creating a child session")
  .option("--json", "print machine-readable JSON")
  .description("Fork a recorded run from a model call and execute the tail live")
  .action(async (session: string, opts: ForkCliOptions) => {
    await runForkCommand(session, opts);
  });

const searchCommand = program.command("search").description("Fork multiple candidate tails and rank them against a goal");

searchCommand
  .command("report")
  .argument("<search>", "search id or path to a persisted search manifest")
  .option("--store <dir>", "store used when <search> is an id", ".rewind")
  .option("--json", "print machine-readable JSON")
  .description("Print a persisted trajectory-search report")
  .action(async (search: string, rawOpts: unknown, rawCommand: unknown) => {
    const opts = { ...commandOptions<SearchReportCliOptions>(rawOpts), ...commandOptions<SearchReportCliOptions>(rawCommand) };
    await runSearchReportCommand(search, {
      ...opts,
      store: cliOptionValue("--store") ?? opts.store ?? ".rewind",
      json: cliHasFlag("--json") || Boolean(opts.json)
    });
  });

searchCommand
  .command("promote")
  .argument("<child>", "winning child session path, session id, or latest")
  .option("--store <dir>", "store used when <child> is an id or latest", ".rewind")
  .option("--out <file>", "write fixture to this path")
  .option("--force", "overwrite --out when it already exists")
  .option("--json", "print machine-readable JSON")
  .description("Generate a regression fixture from a winning search child")
  .action(async (child: string, rawOpts: unknown, rawCommand: unknown) => {
    const opts = { ...commandOptions<SearchPromoteCliOptions>(rawOpts), ...commandOptions<SearchPromoteCliOptions>(rawCommand) };
    await runSearchPromoteCommand(child, {
      ...opts,
      store: cliOptionValue("--store") ?? opts.store ?? ".rewind",
      out: cliOptionValue("--out") ?? opts.out,
      force: cliHasFlag("--force") || Boolean(opts.force),
      json: cliHasFlag("--json") || Boolean(opts.json)
    });
  });

searchCommand
  .argument("<session>", "session path, session id, store with one session, or latest")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "model-call step where every rollout begins", parseInteger)
  .option("--at <n>", "alias for --step", parseInteger)
  .option("--from-step <n>", "alias for --step", parseInteger)
  .option("--site <name>", "model-call site to search from")
  .option("--provider <name>", "auto, openai, openai-compatible, openrouter, or anthropic", "auto")
  .option("--model <id>", "override the model id for live tail model calls")
  .option("--candidate <label::system>", "candidate system prompt override; repeat for prompt sweeps", collectOption, [])
  .option("--actions <file>", "JSON candidates: [{ id, label, system, model, prior }]")
  .option("--goal-contains <text>", "score a rollout as 1 when live model output contains this text")
  .option("--goal-regex <pattern>", "score a rollout as 1 when live model output matches this regex")
  .option("--goal-regex-flags <flags>", "regex flags for --goal-regex, for example i")
  .option("--goal-json <path=value>", "score JSON model output by dot path equality; repeat for multiple checks", collectOption, [])
  .option("--goal-tool <name>", "score a rollout as 1 when the child trace includes this tool call; repeat for multiple tools", collectOption, [])
  .option("--scorer <file>", "ESM scorer module exporting default or score(ctx); enables custom/LLM-as-judge scoring")
  .option("--strategy <name>", "search strategy: beam, monte-carlo, ucb, mcts, or alpha-zero", parseSearchStrategy, "beam")
  .option("--max-rollouts <n>", "maximum live fork rollouts", parseInteger)
  .option("--max-depth <n>", "maximum action-sequence depth", parseInteger)
  .option("--beam-width <n>", "beam width for --strategy beam", parseInteger)
  .option("--exploration-weight <n>", "UCB/UCT exploration weight for --strategy ucb or mcts", parseFiniteNumber)
  .option("--puct-exploration <n>", "PUCT exploration weight for --strategy alpha-zero", parseFiniteNumber)
  .option("--stop-score <n>", "stop once a rollout reaches this score", parseFiniteNumber)
  .option("--concurrency <n>", "parallel rollout starts for independent beam expansions", parseInteger)
  .option("--retry-attempts <n>", "retry attempts per rollout", parseInteger)
  .option("--retry-base-delay-ms <n>", "initial retry backoff in milliseconds", parseInteger)
  .option("--rate-limit <n>", "maximum rollout starts per second", parseInteger)
  .option("--best-branch-by <metric>", "aggregate branch winner: mean, lower-confidence-bound, or pass-rate", parseBestBranchMetric)
  .option("--branch-pass-score <n>", "score threshold counted as a branch pass", parseFiniteNumber)
  .option("--api-key-env <name>", "environment variable containing the provider API key")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--base-url-env <name>", "environment variable containing the OpenAI-compatible base URL")
  .option("--app-url <url>", "OpenRouter attribution URL")
  .option("--app-title <title>", "OpenRouter attribution title")
  .option("--app-categories <list>", "comma-separated OpenRouter attribution categories")
  .option("--tool-miss <policy>", "tail tool miss policy: error or stub", "error")
  .option("--dry-run", "print the resolved search plan without calling the provider")
  .option("--check-provider", "with --dry-run, validate provider credentials and client shape without creating child sessions")
  .option("--json", "print machine-readable JSON")
  .action(async (session: string, opts: SearchCliOptions) => {
    await runSearchCommand(session, opts);
  });

program
  .command("tool")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "tool-call step; defaults to the first tool call", parseInteger)
  .option("--name <name>", "tool name; useful when the tool appears once")
  .option("--json", "print machine-readable JSON")
  .description("Print recorded tool args, result, or error")
  .action(async (session: string, opts: SessionSelectorOptions & { step?: number; name?: string; json?: boolean }) => {
    const tool = formatToolCall(await readToolCall(session, opts));
    console.log(opts.json ? JSON.stringify(tool, null, 2) : formatToolCallText(tool));
  });

program
  .command("entropy")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "entropy step; defaults to the first entropy draw", parseInteger)
  .option("--source <source>", "entropy source: clock, random, or uuid", parseEntropySource)
  .description("Print recorded ctx.clock(), ctx.random(), or ctx.uuid() value")
  .action(async (session: string, opts: SessionSelectorOptions & { step?: number; source?: EntropyEvent["source"] }) => {
    console.log(JSON.stringify(formatEntropyDraw(await readEntropyDraw(session, opts)), null, 2));
  });

program
  .command("pack")
  .argument("<session>")
  .argument("<out>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .description("Create a vault-excluded .rewind bundle")
  .action(async (session: string, out: string, opts: SessionSelectorOptions) => {
    const sessionPath = await resolveSessionSelector(session, opts);
    const stored = await readSession(sessionPath);
    const summary = stored.meta.redactionSummary ?? { total: 0, byPattern: {} };
    console.log(`redaction.enabled=${stored.meta.redaction.enabled}`);
    console.log(`redaction.total=${summary.total}`);
    for (const [pattern, count] of Object.entries(summary.byPattern).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`redaction.pattern=${pattern}\tcount=${count}`);
    }
    await packSession(session, out, opts);
    console.log(out);
  });

program
  .command("unpack")
  .argument("<pack>")
  .argument("<dir>")
  .description("Restore a .rewind bundle")
  .action(async (pack: string, dir: string) => {
    await unpackSession(pack, dir);
    console.log(dir);
  });

program.exitOverride();

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error && error.name === "CommanderError") {
    process.exitCode = Number((error as Error & { exitCode?: number }).exitCode ?? 1);
  } else if (error instanceof RewindError) {
    console.error(explainRewindError(error));
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

interface SessionListRow {
  id: string;
  path: string;
  provider: string;
  createdAt: string;
  origin: "record" | "fork";
  parent?: string;
  forkedAtStep?: number;
  counts: Pick<DoctorSummary["counts"], "totalEvents" | "modelCalls" | "toolCalls" | "entropyDraws" | "streams" | "errors" | "notes">;
  usage: Usage;
}

interface TimelineCliOptions {
  kind?: RewindEvent["kind"][];
  site?: string;
  errors?: boolean;
  live?: boolean;
  from?: number;
  to?: number;
  fullFingerprint?: boolean;
}

type ForkProviderKind = "openai" | "openai-compatible" | "openrouter" | "anthropic";
type ForkToolMissPolicy = "error" | "stub";

interface ForkCliOptions extends SessionSelectorOptions {
  step?: number;
  at?: number;
  fromStep?: number;
  site?: string;
  provider?: string;
  model?: string;
  system?: string;
  systemFile?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  baseUrlEnv?: string;
  appUrl?: string;
  appTitle?: string;
  appCategories?: string;
  toolMiss?: string;
  dryRun?: boolean;
  checkProvider?: boolean;
  json?: boolean;
}

interface SearchCliOptions extends ForkCliOptions {
  candidate?: string[];
  actions?: string;
  goalContains?: string;
  goalRegex?: string;
  goalRegexFlags?: string;
  goalJson?: string[];
  goalTool?: string[];
  scorer?: string;
  strategy?: TrajectorySearchStrategy;
  maxRollouts?: number;
  maxDepth?: number;
  beamWidth?: number;
  explorationWeight?: number;
  puctExploration?: number;
  stopScore?: number;
  concurrency?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  rateLimit?: number;
  bestBranchBy?: TrajectoryBestBranchMetric;
  branchPassScore?: number;
}

interface SearchReportCliOptions {
  store?: string;
  json?: boolean;
}

interface SearchPromoteCliOptions extends SessionSelectorOptions {
  out?: string;
  force?: boolean;
  json?: boolean;
}

interface ForkClientConfig {
  kind: ForkProviderKind;
  codec: ProviderCodec;
  model?: unknown;
  apiKeyEnv?: string;
  baseURL?: string;
}

interface ForkStepSelection {
  step: number;
  site?: string;
  model?: string;
}

interface ForkTraceSummary {
  modelCalls: number;
  liveModelCalls: number;
  recordedModelCalls: number;
  toolCalls: number;
  recordedToolCalls: number;
  entropyDraws: number;
  liveEntropyDraws: number;
}

interface SearchActionFileEntry {
  id?: string;
  label?: string;
  system?: string;
  model?: string;
  prior?: number;
  metadata?: unknown;
}

interface SearchPlan {
  parent: string;
  provider: string;
  client: ForkProviderKind;
  atStep: number;
  site?: string;
  stepModel?: string;
  strategy: TrajectorySearchStrategy;
  scoring: string;
  goalContains?: string;
  candidates: ReturnType<typeof summarizeSearchAction>[];
  budget: {
    maxRollouts?: number;
    maxDepth?: number;
    beamWidth?: number;
    explorationWeight?: number;
    puctExploration?: number;
    stopScore?: number;
    concurrency?: number;
    retryAttempts?: number;
    retryBaseDelayMs?: number;
    rateLimit?: number;
    bestBranchBy?: TrajectoryBestBranchMetric;
    branchPassScore?: number;
  };
  toolMiss: ForkToolMissPolicy;
  providerChecked: boolean;
  apiKeyEnv?: string;
  baseURL?: string;
}

async function resolveSessionSelector(selector: string, opts: SessionSelectorOptions = {}): Promise<string> {
  return resolveSessionPath(selector, opts);
}

async function runForkCommand(session: string, opts: ForkCliOptions): Promise<void> {
  const sessionPath = await resolveSessionSelector(session, opts);
  const stored = await readSession(sessionPath);
  const selection = selectForkStep(stored.events, opts);
  const providerKind = resolveForkProvider(stored.meta.provider, opts.provider);
  const overrides = await readForkOverrides(opts);
  const toolMiss = parseForkToolMissPolicy(opts.toolMiss ?? "error");
  const providerChecked = !opts.dryRun || Boolean(opts.checkProvider);
  const client = createForkClient(providerKind, opts, providerChecked);

  assertForkProviderMatches(stored.meta.provider, client);
  if (client.model) {
    assertProviderClient(client.model, client.codec);
  }

  const plan = {
    parent: sessionPath,
    provider: client.codec.name,
    client: client.kind,
    atStep: selection.step,
    site: selection.site,
    stepModel: selection.model,
    overrides: summarizeOverrides(overrides),
    toolMiss,
    providerChecked,
    ...(client.apiKeyEnv ? { apiKeyEnv: client.apiKeyEnv } : {}),
    ...(client.baseURL ? { baseURL: client.baseURL } : {})
  };

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2));
      return;
    }
    console.log(formatForkPlan(plan));
    return;
  }

  const replay = await AgentRewind.replay(sessionPath, {
    codec: client.codec,
    model: client.model
  });
  const result = await replay.fork({
    atStep: selection.step,
    model: client.model,
    overrides,
    tools: { onMiss: toolMiss }
  });
  const child = join(dirname(sessionPath), result.sessionId);
  const trace = summarizeForkTrace(result.trace.events());
  const nextCommands = [`agentrewind inspect ${shellArg(child)}`, `agentrewind context ${shellArg(child)}`];
  const payload = {
    ok: true,
    ...plan,
    child,
    sessionId: result.sessionId,
    tokensSpent: result.tokensSpent,
    ...(result.divergedAtStep === undefined ? {} : { divergedAtStep: result.divergedAtStep }),
    trace,
    nextCommands
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatForkResult(payload));
}

async function runSearchCommand(session: string, opts: SearchCliOptions): Promise<void> {
  const sessionPath = await resolveSessionSelector(session, opts);
  const stored = await readSession(sessionPath);
  const selection = selectForkStep(stored.events, opts);
  const providerKind = resolveForkProvider(stored.meta.provider, opts.provider);
  const actions = await readSearchActions(opts);
  const scoring = await createSearchScorer(opts);
  const toolMiss = parseForkToolMissPolicy(opts.toolMiss ?? "error");
  const providerChecked = !opts.dryRun || Boolean(opts.checkProvider);
  const client = createForkClient(providerKind, opts, providerChecked);

  assertForkProviderMatches(stored.meta.provider, client);
  if (client.model) {
    assertProviderClient(client.model, client.codec);
  }

  const plan: SearchPlan = {
    parent: sessionPath,
    provider: client.codec.name,
    client: client.kind,
    atStep: selection.step,
    site: selection.site,
    stepModel: selection.model,
    strategy: opts.strategy ?? "beam",
    scoring: scoring.description,
    ...(opts.goalContains === undefined ? {} : { goalContains: opts.goalContains }),
    candidates: actions.map(summarizeSearchAction),
    budget: {
      ...(opts.maxRollouts === undefined ? {} : { maxRollouts: opts.maxRollouts }),
      ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      ...(opts.beamWidth === undefined ? {} : { beamWidth: opts.beamWidth }),
      ...(opts.explorationWeight === undefined ? {} : { explorationWeight: opts.explorationWeight }),
      ...(opts.puctExploration === undefined ? {} : { puctExploration: opts.puctExploration }),
      ...(opts.stopScore === undefined ? {} : { stopScore: opts.stopScore }),
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
      ...(opts.retryAttempts === undefined ? {} : { retryAttempts: opts.retryAttempts }),
      ...(opts.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: opts.retryBaseDelayMs }),
      ...(opts.rateLimit === undefined ? {} : { rateLimit: opts.rateLimit }),
      ...(opts.bestBranchBy === undefined ? {} : { bestBranchBy: opts.bestBranchBy }),
      ...(opts.branchPassScore === undefined ? {} : { branchPassScore: opts.branchPassScore })
    },
    toolMiss,
    providerChecked,
    ...(client.apiKeyEnv ? { apiKeyEnv: client.apiKeyEnv } : {}),
    ...(client.baseURL ? { baseURL: client.baseURL } : {})
  };

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2));
      return;
    }
    console.log(formatSearchPlan(plan));
    return;
  }

  const replay = await AgentRewind.replay(sessionPath, {
    codec: client.codec,
    model: client.model
  });
  const result = await replay.search({
    atStep: selection.step,
    model: client.model,
    actions,
    strategy: opts.strategy ?? "beam",
    budget: {
      ...(opts.maxRollouts === undefined ? {} : { maxRollouts: opts.maxRollouts }),
      ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
      ...(opts.beamWidth === undefined ? {} : { beamWidth: opts.beamWidth }),
      ...(opts.explorationWeight === undefined ? {} : { explorationWeight: opts.explorationWeight }),
      ...(opts.puctExploration === undefined ? {} : { puctExploration: opts.puctExploration }),
      ...(opts.stopScore === undefined ? {} : { stopScore: opts.stopScore })
    },
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.retryAttempts === undefined && opts.retryBaseDelayMs === undefined
      ? {}
      : {
          retry: {
            ...(opts.retryAttempts === undefined ? {} : { attempts: opts.retryAttempts }),
            ...(opts.retryBaseDelayMs === undefined ? {} : { baseDelayMs: opts.retryBaseDelayMs })
          }
        }),
    ...(opts.rateLimit === undefined ? {} : { rateLimit: { maxStarts: opts.rateLimit } }),
    ...(opts.bestBranchBy === undefined ? {} : { bestBranchBy: opts.bestBranchBy }),
    ...(opts.branchPassScore === undefined ? {} : { branchPassScore: opts.branchPassScore }),
    tools: { onMiss: toolMiss },
    score: scoring.score
  });
  const payload = {
    ok: true,
    ...plan,
    rollouts: result.rollouts,
    tokensSpent: result.tokensSpent,
    judgeUsage: result.judgeUsage,
    stoppedReason: result.stoppedReason,
    searchId: result.searchId,
    searchPath: result.searchPath,
    best: result.best ? summarizeSearchNode(result.best) : undefined,
    bestBranch: result.bestBranch,
    bestBranchBy: result.bestBranchBy,
    nodes: result.nodes.filter((node) => node.id !== "root").map(summarizeSearchNode),
    diagnostics: result.diagnostics,
    nextCommands: result.best?.sessionPath
      ? [`agentrewind inspect ${shellArg(result.best.sessionPath)}`, `agentrewind context ${shellArg(result.best.sessionPath)}`]
      : []
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatSearchResult(payload));
}

async function runSearchReportCommand(searchSelector: string, opts: SearchReportCliOptions): Promise<void> {
  const searchPath = await resolveSearchManifestPath(searchSelector, opts.store ?? ".rewind");
  const report = JSON.parse(await readFile(searchPath, "utf8")) as Record<string, unknown>;
  const payload = {
    ok: true,
    path: searchPath,
    ...report
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatSearchReport(payload));
}

async function runSearchPromoteCommand(childSelector: string, opts: SearchPromoteCliOptions): Promise<void> {
  const childPath = await resolveSessionSelector(childSelector, opts);
  const child = await readSession(childPath);
  const searchMeta = child.meta.search;
  if (!searchMeta) {
    throw new TypeError(`Session ${childPath} is not annotated as a trajectory-search child.`);
  }
  const out = opts.out ?? join(dirname(childPath), "regressions", `${child.meta.id}.regression.json`);
  const fixture = {
    schema: "agentrewind.search-regression-fixture",
    version: 1,
    createdAt: new Date().toISOString(),
    childSessionId: child.meta.id,
    childSessionPath: childPath,
    parentSessionId: searchMeta.parentSessionId,
    searchId: searchMeta.searchId,
    searchPath: searchMeta.searchPath,
    atStep: searchMeta.atStep,
    nodeId: searchMeta.nodeId,
    rollout: searchMeta.rollout,
    actionSequence: searchMeta.actionSequence,
    actionSequenceKeys: searchMeta.actionSequenceKeys ?? [],
    expected: {
      ...(searchMeta.score === undefined ? {} : { score: searchMeta.score }),
      ...(searchMeta.reason === undefined ? {} : { reason: searchMeta.reason })
    },
    replay: {
      session: childPath,
      inspectCommand: `agentrewind inspect ${shellArg(childPath)}`,
      contextCommand: `agentrewind context ${shellArg(childPath)}`
    }
  };
  await writeStarterFile(out, `${JSON.stringify(fixture, null, 2)}\n`, Boolean(opts.force));
  const payload = {
    ok: true,
    fixturePath: out,
    ...fixture
  };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatSearchPromoteResult(payload));
}

async function createSearchScorer(opts: SearchCliOptions): Promise<{ description: string; score: CliSearchScorer }> {
  if (opts.scorer) {
    return {
      description: `custom scorer ${opts.scorer}`,
      score: await loadSearchScorer(opts.scorer)
    };
  }

  const checks: Array<{ description: string; evaluate(ctx: TrajectorySearchScoreContext): { ok: boolean; reason: string; metadata?: JsonValue } }> = [];
  if (opts.goalContains !== undefined) {
    const goal = opts.goalContains.toLowerCase();
    checks.push({
      description: `live output contains ${JSON.stringify(opts.goalContains)}`,
      evaluate: ({ trace }) => {
        const text = modelOutputText(trace.events());
        return {
          ok: text.toLowerCase().includes(goal),
          reason: truncateForCli(text || "No live model text output was found.", 240)
        };
      }
    });
  }
  if (opts.goalRegex !== undefined) {
    const regex = new RegExp(opts.goalRegex, opts.goalRegexFlags ?? "");
    checks.push({
      description: `live output matches /${opts.goalRegex}/${opts.goalRegexFlags ?? ""}`,
      evaluate: ({ trace }) => {
        const text = modelOutputText(trace.events());
        return {
          ok: regex.test(text),
          reason: truncateForCli(text || "No live model text output was found.", 240)
        };
      }
    });
  }
  for (const spec of opts.goalJson ?? []) {
    const parsed = parseJsonGoal(spec);
    checks.push({
      description: `JSON output ${parsed.path.join(".")} equals ${JSON.stringify(parsed.expected)}`,
      evaluate: ({ trace }) => {
        const text = modelOutputText(trace.events());
        const parsedJson = parseFirstJsonObject(text);
        if (!parsedJson.ok) {
          return { ok: false, reason: parsedJson.reason };
        }
        const actual = getPath(parsedJson.value, parsed.path);
        const ok = jsonEqual(actual, parsed.expected);
        return {
          ok,
          reason: ok
            ? `${parsed.path.join(".")} matched`
            : `${parsed.path.join(".")}=${JSON.stringify(actual)} did not equal ${JSON.stringify(parsed.expected)}`,
          metadata: { actual: toJsonValue(actual) ?? null, expected: toJsonValue(parsed.expected) ?? null, path: parsed.path }
        };
      }
    });
  }
  for (const toolName of opts.goalTool ?? []) {
    checks.push({
      description: `trace includes tool call ${JSON.stringify(toolName)}`,
      evaluate: ({ trace }) => {
        const found = trace.events().some((event) => event.kind === "tool_call" && event.name === toolName);
        return {
          ok: found,
          reason: found ? `tool ${toolName} was called` : `tool ${toolName} was not called`
        };
      }
    });
  }

  if (checks.length === 0) {
    throw new TypeError(
      "Search needs a scoring metric. Pass --goal-contains, --goal-regex, --goal-json, --goal-tool, or --scorer."
    );
  }

  return {
    description: checks.map((check) => check.description).join("; "),
    score: (ctx) => {
      const results = checks.map((check) => check.evaluate(ctx));
      const failed = results.filter((result) => !result.ok);
      return {
        score: failed.length === 0 ? 1 : 0,
        reason: results.map((result) => result.reason).join(" | "),
        metadata: {
          checks: results.map((result) => ({
            ok: result.ok,
            reason: result.reason,
            ...(result.metadata === undefined ? {} : { metadata: result.metadata })
          }))
        }
      };
    }
  };
}

async function loadSearchScorer(path: string): Promise<CliSearchScorer> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as { default?: unknown; score?: unknown };
  const scorer = module.default ?? module.score;
  if (typeof scorer !== "function") {
    throw new TypeError(`Search scorer ${path} must export a default function or named score(ctx) function.`);
  }
  return scorer as CliSearchScorer;
}

function parseJsonGoal(spec: string): { path: string[]; expected: unknown } {
  const separator = spec.indexOf("=");
  if (separator <= 0) {
    throw new TypeError('JSON goals use "path=value", for example --goal-json "route=escalate-to-csm".');
  }
  const rawPath = spec.slice(0, separator).trim();
  const normalizedPath = rawPath === "$" ? "" : rawPath.startsWith("$.") ? rawPath.slice(2) : rawPath;
  const path = normalizedPath
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (path.length === 0) {
    throw new TypeError(`JSON goal ${JSON.stringify(spec)} has an empty path.`);
  }
  const rawExpected = spec.slice(separator + 1);
  let expected: unknown = rawExpected;
  try {
    expected = JSON.parse(rawExpected);
  } catch {
    expected = rawExpected;
  }
  return { path, expected };
}

function parseFirstJsonObject(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, reason: "No live model text output was found." };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, reason: `Live model output was not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectForkStep(events: RewindEvent[], opts: ForkCliOptions): ForkStepSelection {
  const explicitStep = selectExplicitForkStep(opts);
  const modelEvents = events.filter((event): event is ModelCallEvent => event.kind === "model_call");

  if (explicitStep !== undefined) {
    const event = events.find((candidate) => candidate.step === explicitStep);
    if (!event) {
      throw new TypeError(`No recorded boundary step ${explicitStep}. Run agentrewind inspect <session> to choose a step.`);
    }
    if (event.kind !== "model_call") {
      throw new TypeError(`Step ${explicitStep} is ${event.kind}. The fork CLI starts at model_call steps; run agentrewind inspect <session>.`);
    }
    if (opts.site && event.callSite !== opts.site) {
      throw new TypeError(`Step ${explicitStep} has site "${event.callSite}", not "${opts.site}". Use either --step or the matching --site.`);
    }
    return { step: event.step, site: event.callSite, model: event.request.model };
  }

  if (opts.site) {
    const matches = modelEvents.filter((event) => event.callSite === opts.site);
    if (matches.length === 0) {
      throw new TypeError(`No model_call site "${opts.site}" found. Available model sites: ${formatModelStepChoices(modelEvents)}.`);
    }
    if (matches.length > 1) {
      throw new TypeError(`Model-call site "${opts.site}" appears ${matches.length} times. Use --step with one of: ${matches.map((event) => event.step).join(", ")}.`);
    }
    const event = matches[0]!;
    return { step: event.step, site: event.callSite, model: event.request.model };
  }

  if (modelEvents.length === 1) {
    const event = modelEvents[0]!;
    return { step: event.step, site: event.callSite, model: event.request.model };
  }
  if (modelEvents.length === 0) {
    throw new TypeError("This session has no model_call steps to fork from.");
  }
  throw new TypeError(`Choose a model call with --site or --step. Available model calls: ${formatModelStepChoices(modelEvents)}.`);
}

function selectExplicitForkStep(opts: ForkCliOptions): number | undefined {
  const candidates = [
    ["--step", opts.step],
    ["--at", opts.at],
    ["--from-step", opts.fromStep]
  ].filter((candidate): candidate is [string, number] => candidate[1] !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  const first = candidates[0]![1];
  const conflict = candidates.find((candidate) => candidate[1] !== first);
  if (conflict) {
    throw new TypeError(`Conflicting fork steps: ${candidates.map(([flag, value]) => `${flag}=${value}`).join(", ")}.`);
  }
  return first;
}

function formatModelStepChoices(events: ModelCallEvent[]): string {
  return events.map((event) => `step ${event.step}${event.callSite ? ` (${event.callSite})` : ""}`).join(", ");
}

function resolveForkProvider(sessionProvider: string, requestedProvider = "auto"): ForkProviderKind {
  const provider = requestedProvider.toLowerCase();
  switch (provider) {
    case "auto":
      if (sessionProvider === "openrouter-chat") return "openrouter";
      if (sessionProvider === "anthropic") return "anthropic";
      if (sessionProvider === "openai-chat") return "openai";
      throw new TypeError(
        `Cannot infer a built-in fork provider for session provider "${sessionProvider}". Use --provider openai, openai-compatible, openrouter, or anthropic.`
      );
    case "openai":
    case "openai-compatible":
    case "openrouter":
    case "anthropic":
      return provider;
    case "compatible":
      return "openai-compatible";
    case "openai-chat":
      return "openai";
    case "openrouter-chat":
      return "openrouter";
    default:
      throw new TypeError(`Unknown fork provider "${requestedProvider}". Use auto, openai, openai-compatible, openrouter, or anthropic.`);
  }
}

function createForkClient(provider: ForkProviderKind, opts: ForkCliOptions, requireCredentials: boolean): ForkClientConfig {
  switch (provider) {
    case "openai": {
      const apiKeyEnv = opts.apiKeyEnv ?? "OPENAI_API_KEY";
      const apiKey = requireCredentials ? requiredEnv(apiKeyEnv, "OpenAI API key") : undefined;
      return {
        kind: provider,
        codec: openaiChatCodec(),
        ...(apiKey ? { model: new OpenAI({ apiKey }) } : {}),
        apiKeyEnv
      };
    }
    case "openai-compatible": {
      const apiKeyEnv = opts.apiKeyEnv ?? "COMPATIBLE_API_KEY";
      const apiKey = requireCredentials ? requiredEnv(apiKeyEnv, "OpenAI-compatible API key") : undefined;
      const baseURL = resolveBaseURL(opts, requireCredentials);
      return {
        kind: provider,
        codec: openaiChatCodec(),
        ...(apiKey ? { model: new OpenAI({ apiKey, baseURL }) } : {}),
        apiKeyEnv,
        ...(baseURL ? { baseURL } : {})
      };
    }
    case "openrouter": {
      const apiKeyEnv = opts.apiKeyEnv ?? "OPENROUTER_API_KEY";
      const apiKey = requireCredentials ? requiredEnv(apiKeyEnv, "OpenRouter API key") : undefined;
      return {
        kind: provider,
        codec: openRouterChatCodec(),
        ...(apiKey
          ? {
              model: new OpenAI(
                openRouterClientOptions({
                  apiKey,
                  appUrl: opts.appUrl,
                  appTitle: opts.appTitle,
                  appCategories: parseCommaList(opts.appCategories)
                })
              )
            }
          : {}),
        apiKeyEnv
      };
    }
    case "anthropic": {
      const apiKeyEnv = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
      const apiKey = requireCredentials ? requiredEnv(apiKeyEnv, "Anthropic API key") : undefined;
      return {
        kind: provider,
        codec: anthropicCodec(),
        ...(apiKey ? { model: new Anthropic({ apiKey }) } : {}),
        apiKeyEnv
      };
    }
  }
}

function resolveBaseURL(opts: ForkCliOptions, required: boolean): string | undefined {
  if (opts.baseUrl) {
    return opts.baseUrl;
  }
  const envName = opts.baseUrlEnv ?? "COMPATIBLE_BASE_URL";
  const value = process.env[envName];
  if (value) {
    return value;
  }
  if (!required) {
    return undefined;
  }
  throw new TypeError(`Missing OpenAI-compatible base URL. Pass --base-url, set ${envName}, or pass --base-url-env <name>.`);
}

function requiredEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new TypeError(`Missing ${purpose}. Set ${name}, or pass --api-key-env <name> to use a different environment variable.`);
  }
  return value;
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertForkProviderMatches(sessionProvider: string, client: ForkClientConfig): void {
  if (sessionProvider === client.codec.name) {
    return;
  }
  throw new TypeError(
    `Session provider is "${sessionProvider}", but --provider ${client.kind} uses "${client.codec.name}". Use the provider that matches the recording.`
  );
}

async function readForkOverrides(opts: ForkCliOptions): Promise<ForkOverrides> {
  if (opts.system !== undefined && opts.systemFile !== undefined) {
    throw new TypeError("Use either --system or --system-file, not both.");
  }
  const system = opts.systemFile === undefined ? opts.system : await readFile(opts.systemFile, "utf8");
  return {
    ...(system === undefined ? {} : { system }),
    ...(opts.model === undefined ? {} : { model: opts.model })
  };
}

function parseForkToolMissPolicy(value: string): ForkToolMissPolicy {
  switch (value) {
    case "error":
    case "stub":
      return value;
    default:
      throw new TypeError(`Unknown --tool-miss policy "${value}". Use error or stub.`);
  }
}

function summarizeOverrides(overrides: ForkOverrides): { system: boolean; model?: string } {
  return {
    system: overrides.system !== undefined,
    ...(overrides.model === undefined ? {} : { model: overrides.model })
  };
}

function summarizeForkTrace(events: RewindEvent[]): ForkTraceSummary {
  const summary: ForkTraceSummary = {
    modelCalls: 0,
    liveModelCalls: 0,
    recordedModelCalls: 0,
    toolCalls: 0,
    recordedToolCalls: 0,
    entropyDraws: 0,
    liveEntropyDraws: 0
  };
  for (const event of events) {
    if (event.kind === "model_call") {
      summary.modelCalls += 1;
      if (event.provenance === "live") summary.liveModelCalls += 1;
      if (event.provenance === "recorded") summary.recordedModelCalls += 1;
    } else if (event.kind === "tool_call") {
      summary.toolCalls += 1;
      if (event.provenance === "recorded") summary.recordedToolCalls += 1;
    } else if (event.kind === "entropy") {
      summary.entropyDraws += 1;
      if (event.provenance === "live") summary.liveEntropyDraws += 1;
    }
  }
  return summary;
}

function formatForkPlan(plan: {
  parent: string;
  provider: string;
  client: ForkProviderKind;
  atStep: number;
  site?: string;
  stepModel?: string;
  overrides: { system: boolean; model?: string };
  toolMiss: ForkToolMissPolicy;
  providerChecked: boolean;
  apiKeyEnv?: string;
  baseURL?: string;
}): string {
  return [
    "AgentRewind fork plan.",
    "",
    `Parent: ${plan.parent}`,
    `Fork point: step ${plan.atStep}${plan.site ? ` (${plan.site})` : ""}`,
    `Provider: ${plan.provider} via ${plan.client}`,
    ...(plan.stepModel ? [`Recorded model: ${plan.stepModel}`] : []),
    `Overrides: ${formatOverrides(plan.overrides)}`,
    `Tool miss policy: ${plan.toolMiss}`,
    ...(plan.apiKeyEnv ? [`API key env: ${plan.apiKeyEnv}`] : []),
    ...(plan.baseURL ? [`Base URL: ${plan.baseURL}`] : []),
    "",
    plan.providerChecked
      ? "Dry run checked provider credentials/client shape, but made no provider call and wrote no child session."
      : "Dry run made no provider call, wrote no child session, and did not check provider credentials. Add --check-provider to validate setup."
  ].join("\n");
}

function formatForkResult(result: {
  parent: string;
  child: string;
  provider: string;
  client: ForkProviderKind;
  atStep: number;
  site?: string;
  overrides: { system: boolean; model?: string };
  toolMiss: ForkToolMissPolicy;
  tokensSpent: Usage;
  divergedAtStep?: number;
  trace: ForkTraceSummary;
  nextCommands: string[];
}): string {
  return [
    "AgentRewind fork complete.",
    "",
    `Parent: ${result.parent}`,
    `Child: ${result.child}`,
    `Fork point: step ${result.atStep}${result.site ? ` (${result.site})` : ""}`,
    `Provider: ${result.provider} via ${result.client}`,
    `Overrides: ${formatOverrides(result.overrides)}`,
    `Child session: ${result.trace.recordedModelCalls} recorded model call${result.trace.recordedModelCalls === 1 ? "" : "s"}, ${result.trace.liveModelCalls} live model call${result.trace.liveModelCalls === 1 ? "" : "s"}, ${result.trace.recordedToolCalls} recorded tool call${result.trace.recordedToolCalls === 1 ? "" : "s"}`,
    `Live tail tokens: in=${result.tokensSpent.inputTokens} out=${result.tokensSpent.outputTokens}`,
    `Diverged: ${result.divergedAtStep === undefined ? "no" : `step ${result.divergedAtStep}`}`,
    "",
    "Next commands:",
    ...result.nextCommands.map((command) => `- ${command}`)
  ].join("\n");
}

async function readSearchActions(opts: SearchCliOptions): Promise<TrajectorySearchAction[]> {
  const fromFile = opts.actions ? await readSearchActionsFile(opts.actions, opts.model) : [];
  const fromCli = (opts.candidate ?? []).map((candidate, index) => parseCandidateAction(candidate, index, opts.model));
  const actions = [...fromFile, ...fromCli];
  if (actions.length === 0) {
    throw new TypeError('Search needs at least one candidate. Pass --candidate "label::system prompt" or --actions candidates.json.');
  }
  return actions;
}

async function readSearchActionsFile(path: string, defaultModel: string | undefined): Promise<TrajectorySearchAction[]> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError("--actions must point to a JSON array of candidates.");
  }
  return parsed.map((entry, index) => actionFromFileEntry(entry, index, defaultModel));
}

function actionFromFileEntry(entry: unknown, index: number, defaultModel: string | undefined): TrajectorySearchAction {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`Search candidate ${index + 1} must be an object.`);
  }
  const candidate = entry as SearchActionFileEntry;
  const id = candidate.id ?? slugActionId(candidate.label ?? `candidate-${index + 1}`);
  if (candidate.system !== undefined && typeof candidate.system !== "string") {
    throw new TypeError(`Search candidate ${id} has a non-string system field.`);
  }
  if (candidate.model !== undefined && typeof candidate.model !== "string") {
    throw new TypeError(`Search candidate ${id} has a non-string model field.`);
  }
  if (candidate.prior !== undefined && (typeof candidate.prior !== "number" || !Number.isFinite(candidate.prior) || candidate.prior < 0)) {
    throw new TypeError(`Search candidate ${id} has a non-negative finite number prior.`);
  }
  const model = candidate.model ?? defaultModel;
  if (candidate.system === undefined && model === undefined) {
    throw new TypeError(`Search candidate ${id} needs a system prompt or model override.`);
  }
  return {
    id,
    ...(candidate.label === undefined ? {} : { label: String(candidate.label) }),
    overrides: {
      ...(candidate.system === undefined ? {} : { system: candidate.system }),
      ...(model === undefined ? {} : { model })
    },
    ...(candidate.prior === undefined ? {} : { prior: candidate.prior }),
    ...(candidate.metadata === undefined ? {} : { metadata: toJsonValue(candidate.metadata) ?? null })
  };
}

function parseCandidateAction(value: string, index: number, defaultModel: string | undefined): TrajectorySearchAction {
  const separator = value.indexOf("::");
  if (separator < 0) {
    throw new TypeError('Search candidates use "label::system prompt", for example --candidate "Escalate::Always escalate enterprise refunds".');
  }
  const label = value.slice(0, separator).trim();
  const system = value.slice(separator + 2).trim();
  if (!label || !system) {
    throw new TypeError('Search candidates need both sides of "label::system prompt".');
  }
  return {
    id: slugActionId(label) || `candidate-${index + 1}`,
    label,
    overrides: {
      system,
      ...(defaultModel === undefined ? {} : { model: defaultModel })
    }
  };
}

function summarizeSearchAction(action: TrajectorySearchAction | undefined): {
  id?: string;
  actionKey?: string;
  label?: string;
  overrides: { system: boolean; model?: string };
  prior?: number;
  metadata?: unknown;
} {
  return {
    ...(action?.id === undefined ? {} : { id: action.id }),
    ...(action?.actionKey === undefined ? {} : { actionKey: action.actionKey }),
    ...(action?.label === undefined ? {} : { label: action.label }),
    overrides: summarizeOverrides(action?.overrides ?? {}),
    ...(action?.prior === undefined ? {} : { prior: action.prior }),
    ...(action?.metadata === undefined ? {} : { metadata: action.metadata })
  };
}

function summarizeSearchNode(node: TrajectorySearchNode): {
  id: string;
  parentId?: string;
  depth: number;
  rollout: number;
  action: ReturnType<typeof summarizeSearchAction>;
  actionKey?: string;
  actionSequence: ReturnType<typeof summarizeSearchAction>[];
  actionSequenceKeys: string[];
  sessionId?: string;
  sessionPath?: string;
  score?: number;
  reason?: string;
  scoreMetadata?: unknown;
  judgeUsage?: Usage;
  tokensSpent: Usage;
  reachedGoal?: boolean;
  divergedAtStep?: number;
  error?: unknown;
  visits?: number;
  valueSum?: number;
  meanScore?: number;
  prior?: number;
  selectionScore?: number;
  selectionReason?: TrajectorySearchNode["selectionReason"];
} {
  return {
    id: node.id,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    depth: node.depth,
    rollout: node.rollout,
    action: summarizeSearchAction(node.action),
    ...(node.actionKey === undefined ? {} : { actionKey: node.actionKey }),
    actionSequence: node.actionSequence.map(summarizeSearchAction),
    actionSequenceKeys: node.actionSequenceKeys,
    ...(node.sessionId === undefined ? {} : { sessionId: node.sessionId }),
    ...(node.sessionPath === undefined ? {} : { sessionPath: node.sessionPath }),
    ...(node.score === undefined ? {} : { score: node.score }),
    ...(node.reason === undefined ? {} : { reason: node.reason }),
    ...(node.scoreMetadata === undefined ? {} : { scoreMetadata: node.scoreMetadata }),
    ...(node.judgeUsage === undefined ? {} : { judgeUsage: node.judgeUsage }),
    tokensSpent: node.tokensSpent,
    ...(node.reachedGoal === undefined ? {} : { reachedGoal: node.reachedGoal }),
    ...(node.divergedAtStep === undefined ? {} : { divergedAtStep: node.divergedAtStep }),
    ...(node.error === undefined ? {} : { error: node.error }),
    ...(node.visits === undefined ? {} : { visits: node.visits }),
    ...(node.valueSum === undefined ? {} : { valueSum: node.valueSum }),
    ...(node.meanScore === undefined ? {} : { meanScore: node.meanScore }),
    ...(node.prior === undefined ? {} : { prior: node.prior }),
    ...(node.selectionScore === undefined ? {} : { selectionScore: node.selectionScore }),
    ...(node.selectionReason === undefined ? {} : { selectionReason: node.selectionReason })
  };
}

function formatSearchPlan(plan: SearchPlan): string {
  return [
    "AgentRewind search plan.",
    "",
    `Parent: ${plan.parent}`,
    `Fork point: step ${plan.atStep}${plan.site ? ` (${plan.site})` : ""}`,
    `Provider: ${plan.provider} via ${plan.client}`,
    ...(plan.stepModel ? [`Recorded model: ${plan.stepModel}`] : []),
    `Strategy: ${plan.strategy}`,
    plan.goalContains !== undefined ? `Goal: live output contains ${JSON.stringify(plan.goalContains)}` : `Scoring: ${plan.scoring}`,
    `Candidates: ${plan.candidates.length}`,
    ...plan.candidates.map((candidate, index) => `- ${index + 1}. ${formatSearchActionSummary(candidate)}`),
    `Budget: ${formatSearchBudget(plan.budget)}`,
    `Tool miss policy: ${plan.toolMiss}`,
    ...(plan.apiKeyEnv ? [`API key env: ${plan.apiKeyEnv}`] : []),
    ...(plan.baseURL ? [`Base URL: ${plan.baseURL}`] : []),
    "",
    plan.providerChecked
      ? "Dry run checked provider credentials/client shape, but made no provider call and wrote no child sessions."
      : "Dry run made no provider call, wrote no child sessions, and did not check provider credentials. Add --check-provider to validate setup."
  ].join("\n");
}

function formatSearchResult(result: SearchPlan & {
  rollouts: number;
  tokensSpent: Usage;
  judgeUsage?: Usage;
  stoppedReason: string;
  searchId?: string;
  searchPath?: string;
  best?: ReturnType<typeof summarizeSearchNode>;
  bestBranch?: TrajectorySearchResult["bestBranch"];
  bestBranchBy?: TrajectoryBestBranchMetric;
  nextCommands: string[];
}): string {
  return [
    "AgentRewind search complete.",
    "",
    `Parent: ${result.parent}`,
    `Fork point: step ${result.atStep}${result.site ? ` (${result.site})` : ""}`,
    `Strategy: ${result.strategy}`,
    result.goalContains !== undefined ? `Goal: live output contains ${JSON.stringify(result.goalContains)}` : `Scoring: ${result.scoring}`,
    `Rollouts: ${result.rollouts}`,
    `Stopped: ${result.stoppedReason}`,
    `Live tail tokens: in=${result.tokensSpent.inputTokens} out=${result.tokensSpent.outputTokens}`,
    ...(result.judgeUsage && (result.judgeUsage.inputTokens > 0 || result.judgeUsage.outputTokens > 0 || result.judgeUsage.costUsd !== undefined)
      ? [`Judge tokens: in=${result.judgeUsage.inputTokens} out=${result.judgeUsage.outputTokens}${result.judgeUsage.costUsd === undefined ? "" : ` cost=$${result.judgeUsage.costUsd}`}`]
      : []),
    ...(result.searchId ? [`Search id: ${result.searchId}`] : []),
    ...(result.searchPath ? [`Report: ${result.searchPath}`] : []),
    "",
    result.best ? `Best: score=${result.best.score ?? "n/a"} ${formatSearchActionSummary(result.best.action)}` : "Best: none",
    ...(result.bestBranch
      ? [`Best branch (${result.bestBranchBy ?? "mean"}): score=${formatBranchMetric(result.bestBranch, result.bestBranchBy ?? "mean")} ${result.bestBranch.actionSequence.join(" > ")}`]
      : []),
    ...(result.best?.reason ? [`Reason: ${result.best.reason}`] : []),
    ...(result.best?.sessionPath ? [`Child: ${result.best.sessionPath}`] : []),
    ...(result.nextCommands.length === 0 ? [] : ["", "Next commands:", ...result.nextCommands.map((command) => `- ${command}`)])
  ].join("\n");
}

async function resolveSearchManifestPath(selector: string, store: string): Promise<string> {
  const direct = resolve(selector);
  try {
    await access(direct);
    return direct;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const byId = join(store, "searches", selector.endsWith(".json") ? selector : `${selector}.json`);
  try {
    await access(byId);
    return byId;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  throw new TypeError(`No trajectory-search report found for ${selector}. Expected ${direct} or ${byId}.`);
}

function formatSearchReport(report: Record<string, unknown>): string {
  const bestBranch = report.bestBranch as { actionSequence?: string[]; meanScore?: number; passRate?: number; lowerConfidenceBound?: number } | undefined;
  const diagnostics = report.diagnostics as { branches?: Array<{ actionSequence?: string[]; visits?: number; meanScore?: number; passRate?: number }> } | undefined;
  const lines = [
    "AgentRewind search report.",
    "",
    `Search id: ${String(report.searchId ?? "unknown")}`,
    `Path: ${String(report.path ?? "unknown")}`,
    `Parent: ${String(report.parentSessionPath ?? report.parentSessionId ?? "unknown")}`,
    `Fork point: step ${String(report.atStep ?? "?")}`,
    `Strategy: ${String(report.strategy ?? "unknown")}`,
    `Rollouts: ${String(report.rollouts ?? 0)}`,
    `Stopped: ${String(report.stoppedReason ?? "unknown")}`,
    `Best child: ${String(report.bestSessionPath ?? report.bestSessionId ?? "none")}`,
    ...(bestBranch
      ? [
          `Best branch: ${(bestBranch.actionSequence ?? []).join(" > ") || "unknown"} mean=${formatNumber(bestBranch.meanScore)} passRate=${formatNumber(bestBranch.passRate)} lcb=${formatNumber(bestBranch.lowerConfidenceBound)}`
        ]
      : [])
  ];
  const branches = diagnostics?.branches ?? [];
  if (branches.length > 0) {
    lines.push("", "Branches:");
    for (const branch of branches.slice(0, 8)) {
      lines.push(
        `- ${(branch.actionSequence ?? []).join(" > ") || "unknown"} visits=${branch.visits ?? 0} mean=${formatNumber(branch.meanScore)} passRate=${formatNumber(branch.passRate)}`
      );
    }
  }
  return lines.join("\n");
}

function formatSearchPromoteResult(result: {
  fixturePath: string;
  childSessionPath: string;
  searchId: string;
  actionSequence: string[];
  expected: { score?: number; reason?: string };
}): string {
  return [
    "AgentRewind regression fixture written.",
    "",
    `Fixture: ${result.fixturePath}`,
    `Child: ${result.childSessionPath}`,
    `Search id: ${result.searchId}`,
    `Action sequence: ${result.actionSequence.join(" > ") || "unknown"}`,
    ...(result.expected.score === undefined ? [] : [`Expected score: ${result.expected.score}`]),
    ...(result.expected.reason === undefined ? [] : [`Expected reason: ${result.expected.reason}`])
  ].join("\n");
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : "n/a";
}

function formatSearchActionSummary(action: ReturnType<typeof summarizeSearchAction>): string {
  const name = action.label ?? action.id ?? "unnamed";
  const prior = action.prior === undefined ? "" : ` prior=${action.prior}`;
  return `${name} (${formatOverrides(action.overrides)}${prior})`;
}

function formatSearchBudget(budget: SearchPlan["budget"]): string {
  const parts = [
    budget.maxRollouts === undefined ? undefined : `maxRollouts=${budget.maxRollouts}`,
    budget.maxDepth === undefined ? undefined : `maxDepth=${budget.maxDepth}`,
    budget.beamWidth === undefined ? undefined : `beamWidth=${budget.beamWidth}`,
    budget.explorationWeight === undefined ? undefined : `explorationWeight=${budget.explorationWeight}`,
    budget.puctExploration === undefined ? undefined : `puctExploration=${budget.puctExploration}`,
    budget.stopScore === undefined ? undefined : `stopScore=${budget.stopScore}`,
    budget.concurrency === undefined ? undefined : `concurrency=${budget.concurrency}`,
    budget.retryAttempts === undefined ? undefined : `retryAttempts=${budget.retryAttempts}`,
    budget.retryBaseDelayMs === undefined ? undefined : `retryBaseDelayMs=${budget.retryBaseDelayMs}`,
    budget.rateLimit === undefined ? undefined : `rateLimit=${budget.rateLimit}/s`,
    budget.bestBranchBy === undefined ? undefined : `bestBranchBy=${budget.bestBranchBy}`,
    budget.branchPassScore === undefined ? undefined : `branchPassScore=${budget.branchPassScore}`
  ].filter((part): part is string => Boolean(part));
  return parts.length === 0 ? "defaults" : parts.join(" ");
}

function formatBranchMetric(branch: NonNullable<TrajectorySearchResult["bestBranch"]>, metric: TrajectoryBestBranchMetric): string {
  const value =
    metric === "lower-confidence-bound" ? branch.lowerConfidenceBound : metric === "pass-rate" ? branch.passRate : branch.meanScore;
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function modelOutputText(events: RewindEvent[]): string {
  return events
    .filter((event): event is ModelCallEvent => event.kind === "model_call" && event.provenance === "live")
    .map((event) => contentToText(event.response?.content))
    .filter(Boolean)
    .join("\n");
}

function contentToText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function truncateForCli(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function slugActionId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatOverrides(overrides: { system: boolean; model?: string }): string {
  const parts = [overrides.system ? "system=yes" : "system=no"];
  if (overrides.model !== undefined) {
    parts.push(`model=${overrides.model}`);
  }
  return parts.join(" ");
}

async function listStoreSessions(store: string): Promise<SessionListRow[]> {
  return (await listSessionSummaries(store)).map((summary) => ({
    id: summary.id,
    path: summary.path ?? "",
    provider: summary.provider,
    createdAt: summary.createdAt,
    origin: summary.parent ? "fork" : "record",
    ...(summary.parent ? { parent: summary.parent } : {}),
    ...(summary.forkedAtStep === undefined ? {} : { forkedAtStep: summary.forkedAtStep }),
    counts: {
      totalEvents: summary.counts.totalEvents,
      modelCalls: summary.counts.modelCalls,
      toolCalls: summary.counts.toolCalls,
      entropyDraws: summary.counts.entropyDraws,
      streams: summary.counts.streams,
      errors: summary.counts.errors,
      notes: summary.counts.notes
    },
    usage: summary.usage
  }));
}

function formatSessionList(store: string, rows: SessionListRow[]): string {
  if (rows.length === 0) {
    return [
      `No AgentRewind sessions found in ${store}.`,
      `Record one with AgentRewind.recordRun({ store: ${JSON.stringify(store)}, ... }, harness), then run agentrewind list ${shellArg(store)}.`
    ].join("\n");
  }
  return [
    ["id", "provider", "created", "origin", "models", "tools", "entropy", "errors", "tokens", "path"].join("\t"),
    ...rows.map((row) =>
      [
        row.id,
        row.provider,
        row.createdAt,
        formatListOrigin(row),
        String(row.counts.modelCalls),
        String(row.counts.toolCalls),
        String(row.counts.entropyDraws),
        String(row.counts.errors),
        `in=${row.usage.inputTokens} out=${row.usage.outputTokens}`,
        row.path
      ].join("\t")
    )
  ].join("\n");
}

function formatListOrigin(row: SessionListRow): string {
  if (row.origin === "record") {
    return "record";
  }
  return `fork@${row.forkedAtStep ?? "?"}`;
}

function formatToolCall(event: ToolCallEvent): Record<string, unknown> {
  return {
    step: event.step,
    lane: event.lane,
    site: event.callSite,
    name: event.name,
    args: event.args,
    ...(event.result === undefined ? {} : { result: event.result }),
    error: event.error ?? false,
    ...(event.stream === undefined ? {} : { stream: event.stream }),
    latencyMs: event.latencyMs,
    streamed: Boolean(event.stream),
    ...(event.provenance ? { provenance: event.provenance } : {}),
    ...(event.synthetic ? { synthetic: event.synthetic } : {})
  };
}

function formatPromptContext(messages: NormalizedMessage[]): string {
  if (messages.length === 0) {
    return "No prompt messages recorded for this model call.";
  }
  return messages
    .map((message, index) => {
      const header = `${index + 1}. ${message.role}`;
      return [header, indent(formatValue(message.content), "   ")].join("\n");
    })
    .join("\n\n");
}

function formatToolCallText(tool: Record<string, unknown>): string {
  const lines = [
    `Tool: ${String(tool.name)}`,
    `Step: ${String(tool.step)}`,
    `Site: ${String(tool.site)}`,
    "",
    "Args:",
    indent(formatValue(tool.args), "  ")
  ];
  if (tool.error && tool.error !== false) {
    lines.push("", "Error:", indent(formatValue(tool.error), "  "));
  } else if ("result" in tool) {
    lines.push("", "Result:", indent(formatValue(tool.result), "  "));
  }
  if (tool.streamed) {
    lines.push("", "Stream:", indent(formatValue(tool.stream), "  "));
  }
  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function indent(text: string | undefined, prefix: string): string {
  return String(text ?? "").split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function formatEntropyDraw(event: EntropyEvent): Record<string, unknown> {
  return {
    step: event.step,
    lane: event.lane,
    site: event.callSite,
    source: event.source,
    ...(event.key ? { key: event.key } : {}),
    value: event.value,
    ...(event.provenance ? { provenance: event.provenance } : {})
  };
}

function formatTimelineHeader(): string {
  return ["step", "kind", "lane", "site", "fingerprint", "detail", "tokens", "flags"].join("\t");
}

function formatTimeline(row: SessionTimelineRow): string {
  return [
    String(row.step),
    row.kind,
    row.lane,
    row.site,
    row.fingerprint ?? "",
    timelineDetail(row),
    row.tokens ? `in=${row.tokens.inputTokens} out=${row.tokens.outputTokens}` : "",
    timelineFlags(row).join(",")
  ].join("\t");
}

function timelineDetail(row: SessionTimelineRow): string {
  if (row.model) {
    return `model=${row.model}`;
  }
  if (row.name) {
    return `tool=${row.name}`;
  }
  if (row.source) {
    return `source=${row.source}`;
  }
  return "";
}

function timelineFlags(row: SessionTimelineRow): string[] {
  const flags: string[] = [];
  if (row.streamed) {
    flags.push("stream");
  }
  if (row.error) {
    flags.push("error");
  }
  if (row.provenance) {
    flags.push(`provenance=${row.provenance}`);
  }
  return flags;
}

type QuickstartProvider = "openai" | "openai-compatible" | "openrouter" | "anthropic";
type QuickstartFormat = "markdown" | "ts";

interface QuickstartSpec {
  provider: QuickstartProvider;
  title: string;
  site: string;
  install: string[];
  env: string[];
  imports: string;
  client: string;
  codec?: string;
  request: string;
  response: string;
}

function formatQuickstart(inputProvider: string | undefined, manager: string, format: QuickstartFormat): string {
  if (!inputProvider) {
    return [
      "Choose a provider:",
      "",
      "  agentrewind quickstart openai",
      "  agentrewind quickstart openai-compatible",
      "  agentrewind quickstart openrouter",
      "  agentrewind quickstart anthropic",
      "",
      "Add --manager pnpm, --manager yarn, or --manager bun if you do not use npm."
    ].join("\n");
  }

  const provider = parseQuickstartProvider(inputProvider);
  const spec = quickstartSpec(provider);
  const packageManager = parsePackageManager(manager);
  const starter = starterTypeScript(spec, provider);
  if (format === "ts") {
    return starter;
  }
  return [
    `# ${spec.title}`,
    "",
    "## Install",
    "",
    "```sh",
    installCommand(packageManager, spec.install),
    "```",
    "",
    "## Environment",
    "",
    "```sh",
    ...spec.env,
    "```",
    "",
    "The starter below validates these variables before recording so missing",
    "configuration fails with a clear local error.",
    "",
    "## What This Starter Does",
    "",
    "- Creates a provider-bound AgentRewind helper with the right client and codec.",
    "- Records one harness run with the live model client.",
    "- Immediately replays the same harness without a live model client.",
    "- Names the model call with `site` so CLI diagnostics can target it later.",
    "",
    "## Minimal TypeScript",
    "",
    "```ts",
    starter,
    "```",
    "",
    "## Inspect",
    "",
    "```sh",
    "agentrewind list .rewind",
    `agentrewind doctor .rewind/${provider}-demo`,
    `agentrewind inspect .rewind/${provider}-demo`,
    `agentrewind context .rewind/${provider}-demo`,
    `agentrewind context .rewind/${provider}-demo --site ${spec.site}`,
    "```"
  ].join("\n");
}

function starterTypeScript(spec: QuickstartSpec, provider: QuickstartProvider): string {
  return [
    "import { defineHarness, explainRewindError } from \"@agentrewind/sdk\";",
    spec.imports,
    "",
    "// Fail locally before recording if the provider key, base URL, or model id",
    "// is missing. Strict replay still needs the same model id to rebuild the",
    "// recorded request fingerprint, even though it does not call the model.",
    "function requiredEnv(name: string): string {",
    "  const value = process.env[name];",
    "  if (!value) {",
    "    throw new Error(`Missing ${name}. Set it before running this starter.`);",
    "  }",
    "  return value;",
    "}",
    "",
    "// Provider presets create the SDK client, choose the matching codec, and keep",
    "// record/replay calls from repeating the same setup.",
    spec.client,
    "",
    ...(spec.codec
      ? [
          "// The codec translates provider-specific SDK shapes into AgentRewind's stable",
          "// session format. Use the same codec for record, replay, context, and fork.",
          spec.codec
        ]
      : []),
    `const sessionId = \"${provider}-demo\";`,
    "const sessionPath = `.rewind/${sessionId}`;",
    "",
    "// The harness is your replayable agent workflow. Keep prompt-affecting model",
    "// calls, tools, time, randomness, and UUIDs behind `ctx` so replay can serve",
    "// the recorded values instead of touching live systems again.",
    "const harness = defineHarness(async (ctx) => {",
    spec.request
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    spec.response
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "});",
    "",
    "try {",
    "  // Record one live run. This is the only phase below that should spend",
    "  // provider tokens or call external tools.",
    "  const recorded = await rewind.recordRun({ id: sessionId }, harness);",
    "",
    "  // Replay the same harness with no model client. Strict replay serves the",
    "  // recorded model response and fails if the harness builds a different request.",
    "  const replayed = await rewind.replayRun(recorded.path, harness);",
    "  console.log({ recorded: recorded.result, replayed, session: recorded.path });",
    "} catch (error) {",
    "  console.error(explainRewindError(error, { sessionPath }));",
    "  throw error;",
    "}",
    ""
  ].join("\n");
}

function parseQuickstartFormat(format: string | undefined, writingFile: boolean): QuickstartFormat {
  if (format === undefined) {
    return writingFile ? "ts" : "markdown";
  }
  switch (format) {
    case "markdown":
    case "md":
      return "markdown";
    case "ts":
    case "typescript":
      return "ts";
    default:
      throw new TypeError(`Unknown quickstart format "${format}". Use markdown or ts.`);
  }
}

async function writeStarterFile(path: string, content: string, force: boolean): Promise<void> {
  if (!force) {
    try {
      await access(path);
      throw new Error(`Refusing to overwrite ${path}. Pass --force to replace it.`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseQuickstartProvider(provider: string): QuickstartProvider {
  switch (provider.toLowerCase()) {
    case "openai":
    case "openai-compatible":
    case "compatible":
    case "openrouter":
    case "anthropic":
      return provider.toLowerCase() === "compatible" ? "openai-compatible" : (provider.toLowerCase() as QuickstartProvider);
    default:
      throw new TypeError(`Unknown provider "${provider}". Use openai, openai-compatible, openrouter, or anthropic.`);
  }
}

function parsePackageManager(manager: string): "pnpm" | "npm" | "yarn" | "bun" {
  switch (manager) {
    case "pnpm":
    case "npm":
    case "yarn":
    case "bun":
      return manager;
    default:
      throw new TypeError(`Unknown package manager "${manager}". Use npm, pnpm, yarn, or bun.`);
  }
}

function installCommand(manager: "pnpm" | "npm" | "yarn" | "bun", packages: string[]): string {
  const joined = packages.join(" ");
  if (manager === "npm") {
    return `npm install ${joined}`;
  }
  if (manager === "yarn") {
    return `yarn add ${joined}`;
  }
  if (manager === "bun") {
    return `bun add ${joined}`;
  }
  return `pnpm add ${joined}`;
}

function quickstartSpec(provider: QuickstartProvider): QuickstartSpec {
  switch (provider) {
    case "openai":
      return {
        provider,
        title: "AgentRewind OpenAI Chat Completions Quickstart",
        site: "answer-question",
        install: ["@agentrewind/sdk"],
        env: ["OPENAI_API_KEY=...", "OPENAI_MODEL=..."],
        imports: [
          "import { createOpenAIRewind } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: "const rewind = createOpenAIRewind({ apiKey: requiredEnv(\"OPENAI_API_KEY\"), store: \".rewind\" });",
        request: openAIRequest("requiredEnv(\"OPENAI_MODEL\")", "answer-question"),
        response: openAIResponse()
      };
    case "openai-compatible":
      return {
        provider,
        title: "AgentRewind OpenAI-Compatible Provider Quickstart",
        site: "answer-question",
        install: ["@agentrewind/sdk"],
        env: ["COMPATIBLE_API_KEY=...", "COMPATIBLE_BASE_URL=https://your-provider.example/v1", "COMPATIBLE_MODEL=..."],
        imports: [
          "import { createOpenAICompatibleRewind } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: [
          "const rewind = createOpenAICompatibleRewind({",
          "  apiKey: requiredEnv(\"COMPATIBLE_API_KEY\"),",
          "  baseURL: requiredEnv(\"COMPATIBLE_BASE_URL\"),",
          "  store: \".rewind\"",
          "});"
        ].join("\n"),
        request: openAIRequest("requiredEnv(\"COMPATIBLE_MODEL\")", "answer-question"),
        response: openAIResponse()
      };
    case "openrouter":
      return {
        provider,
        title: "AgentRewind OpenRouter Quickstart",
        site: "openrouter-answer",
        install: ["@agentrewind/sdk"],
        env: ["OPENROUTER_API_KEY=...", "OPENROUTER_MODEL=..."],
        imports: [
          "import { createOpenRouterRewind } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: [
          "const rewind = createOpenRouterRewind({",
          "  apiKey: requiredEnv(\"OPENROUTER_API_KEY\"),",
          "  appUrl: \"https://your-app.example\",",
          "  appTitle: \"Your Agent\",",
          "  store: \".rewind\"",
          "});"
        ].join("\n"),
        request: openRouterRequest("requiredEnv(\"OPENROUTER_MODEL\")", "openrouter-answer"),
        response: openAIResponse()
      };
    case "anthropic":
      return {
        provider,
        title: "AgentRewind Anthropic Messages Quickstart",
        site: "draft-answer",
        install: ["@agentrewind/sdk"],
        env: ["ANTHROPIC_API_KEY=...", "ANTHROPIC_MODEL=..."],
        imports: [
          "import { createAnthropicRewind } from \"@agentrewind/sdk\";",
          "import type { AnthropicMessage } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: "const rewind = createAnthropicRewind({ apiKey: requiredEnv(\"ANTHROPIC_API_KEY\"), store: \".rewind\" });",
        request: anthropicRequest("requiredEnv(\"ANTHROPIC_MODEL\")", "draft-answer"),
        response: "return message.content.filter((block) => block.type === \"text\").map((block) => block.text).join(\"\");"
      };
  }
}

function openAIRequest(model: string, site: string): string {
  return [
    "const completion = await ctx.model.create<ChatCompletion>(",
    "  {",
    `    model: ${model},`,
    "    messages: [",
    "      { role: \"system\", content: \"Answer tersely.\" },",
    "      { role: \"user\", content: `Request ${ctx.uuid()}` }",
    "    ],",
    "    temperature: 0",
    "  },",
    "  // A stable site name makes drift output and `agentrewind context --site` useful.",
    `  { site: \"${site}\" }`,
    ");"
  ].join("\n");
}

function openAIResponse(): string {
  return [
    "const answer = completion.choices[0]?.message.content;",
    "if (!answer) {",
    "  throw new Error(\"Model returned no text content.\");",
    "}",
    "return answer;"
  ].join("\n");
}

function openRouterRequest(model: string, site: string): string {
  return [
    "const completion = await ctx.model.create<ChatCompletion>(",
    "  {",
    `    model: ${model},`,
    "    messages: [{ role: \"user\", content: `Request ${ctx.uuid()}` }],",
    "    temperature: 0,",
    "    provider: { allow_fallbacks: true }",
    "  },",
    "  // A stable site name makes drift output and `agentrewind context --site` useful.",
    `  { site: \"${site}\" }`,
    ");"
  ].join("\n");
}

function anthropicRequest(model: string, site: string): string {
  return [
    "const message = await ctx.model.create<AnthropicMessage>(",
    "  {",
    `    model: ${model},`,
    "    max_tokens: 256,",
    "    system: \"Answer with operational detail.\",",
    "    messages: [{ role: \"user\", content: `Request ${ctx.uuid()}` }]",
    "  },",
    "  // A stable site name makes drift output and `agentrewind context --site` useful.",
    `  { site: \"${site}\" }`,
    ");"
  ].join("\n");
}

interface DoctorSummary extends SessionSummary {
  nextCommands: string[];
}

function summarizeDoctorSession(meta: Awaited<ReturnType<typeof readSession>>["meta"], events: RewindEvent[]): DoctorSummary {
  const summary = summarizeCoreSession(meta, events);
  const firstModelStep = summary.modelSteps[0]?.step;
  const secondModelStep = summary.modelSteps[1]?.step;
  const firstModel = summary.modelSteps[0];
  const secondModel = summary.modelSteps[1];
  const siteCounts = modelSiteCounts(summary.modelSteps);
  const contextCommand = firstModel
    ? uniqueModelSite(siteCounts, firstModel.site)
      ? `agentrewind context <session> --site ${shellArg(firstModel.site)}`
      : "agentrewind context <session>"
    : undefined;
  const diffCommand =
    firstModel && secondModel
      ? uniqueModelSite(siteCounts, firstModel.site) && uniqueModelSite(siteCounts, secondModel.site)
        ? `agentrewind diff <session> --from-site ${shellArg(firstModel.site)} --to-site ${shellArg(secondModel.site)}`
        : "agentrewind diff <session>"
      : undefined;
  return {
    ...summary,
    nextCommands: [
      "agentrewind inspect <session>",
      ...(firstModelStep === undefined || !contextCommand ? [] : [contextCommand]),
      ...(firstModelStep === undefined || secondModelStep === undefined || !diffCommand ? [] : [diffCommand]),
      ...(firstModelStep === undefined ? [] : [`agentrewind fork <session> --step ${firstModelStep} --system ${shellArg("Updated system prompt")} --dry-run`]),
      "agentrewind pack <session> session.rewind"
    ]
  };
}

function formatDoctor(session: string, summary: DoctorSummary): string {
  const lines = [
    "AgentRewind session is readable.",
    "",
    `Session: ${session}`,
    `Id: ${summary.id}`,
    `Provider: ${summary.provider}`,
    `Created: ${summary.createdAt}`,
    `Schema: ${summary.schemaVersion}`,
    `Fingerprint mode: ${summary.fingerprintMode}`,
    ...(summary.parent ? [`Parent: ${summary.parent}`] : []),
    ...(summary.forkedAtStep === undefined ? [] : [`Forked at step: ${summary.forkedAtStep}`]),
    "",
    "Recorded boundaries:",
    `- model calls: ${summary.counts.modelCalls}`,
    `- tool calls: ${summary.counts.toolCalls}`,
    `- entropy draws: ${summary.counts.entropyDraws}`,
    `- streams: ${summary.counts.streams}`,
    `- errors: ${summary.counts.errors}`,
    `- notes: ${summary.counts.notes}`,
    "",
    `Token usage: in=${summary.usage.inputTokens} out=${summary.usage.outputTokens}`,
    `Redaction: ${summary.redaction.enabled ? "enabled" : "disabled"} (${summary.redaction.total} replacement${summary.redaction.total === 1 ? "" : "s"})`
  ];

  if (summary.modelSteps.length > 0) {
    lines.push("", "Model steps:");
    for (const step of summary.modelSteps) {
      lines.push(`- step ${step.step}: ${step.site} model=${step.model} messages=${step.messages}${step.streamed ? " stream=true" : ""}`);
    }
  }

  if (summary.toolSteps.length > 0) {
    lines.push("", "Tool steps:");
    for (const step of summary.toolSteps) {
      lines.push(`- step ${step.step}: ${step.name}${step.streamed ? " stream=true" : ""}`);
    }
  }

  lines.push("", "Useful next commands:");
  const sessionArg = shellArg(session);
  for (const command of summary.nextCommands) {
    lines.push(`- ${command.replace("<session>", sessionArg)}`);
  }

  return lines.join("\n");
}

function modelSiteCounts(modelSteps: DoctorSummary["modelSteps"]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of modelSteps) {
    if (step.site.length > 0) {
      counts.set(step.site, (counts.get(step.site) ?? 0) + 1);
    }
  }
  return counts;
}

function uniqueModelSite(siteCounts: Map<string, number>, site: string): boolean {
  return site.length > 0 && siteCounts.get(site) === 1;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commandOptions<T>(raw: unknown): T {
  if (raw && typeof raw === "object" && typeof (raw as { opts?: unknown }).opts === "function") {
    return (raw as { opts<TOptions>(): TOptions }).opts<T>();
  }
  return (raw ?? {}) as T;
}

function cliOptionValue(flag: string): string | undefined {
  const index = originalArgv.indexOf(flag);
  if (index >= 0) {
    return originalArgv[index + 1];
  }
  const prefix = `${flag}=`;
  const withEquals = originalArgv.find((arg) => arg.startsWith(prefix));
  return withEquals?.slice(prefix.length);
}

function cliHasFlag(flag: string): boolean {
  return originalArgv.includes(flag);
}

function parseInteger(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`Expected a non-negative integer, got "${value}"`);
  }
  return Number(value);
}

function parseFiniteNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`Expected a finite number, got "${value}"`);
  }
  return parsed;
}

function parseSearchStrategy(value: string): TrajectorySearchStrategy {
  switch (value) {
    case "beam":
    case "monte-carlo":
    case "ucb":
    case "mcts":
    case "alpha-zero":
      return value;
    case "montecarlo":
      return "monte-carlo";
    case "alphazero":
    case "puct":
      return "alpha-zero";
    default:
      throw new TypeError(`Unknown search strategy "${value}". Use beam, monte-carlo, ucb, mcts, or alpha-zero.`);
  }
}

function parseBestBranchMetric(value: string): TrajectoryBestBranchMetric {
  switch (value) {
    case "mean":
    case "lower-confidence-bound":
    case "pass-rate":
      return value;
    case "lcb":
      return "lower-confidence-bound";
    case "pass":
      return "pass-rate";
    default:
      throw new TypeError(`Unknown best branch metric "${value}". Use mean, lower-confidence-bound, or pass-rate.`);
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTimelineKinds(value: string): RewindEvent["kind"][] {
  const kinds = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (kinds.length === 0) {
    throw new TypeError("Expected at least one event kind.");
  }
  for (const kind of kinds) {
    assertTimelineKind(kind);
  }
  return kinds as RewindEvent["kind"][];
}

function assertTimelineKind(kind: string): asserts kind is RewindEvent["kind"] {
  switch (kind) {
    case "session_start":
    case "model_call":
    case "tool_call":
    case "entropy":
    case "note":
    case "session_end":
      return;
    default:
      throw new TypeError(
        `Unknown event kind "${kind}". Use session_start, model_call, tool_call, entropy, note, or session_end.`
      );
  }
}

function parseEntropySource(value: string): EntropyEvent["source"] {
  switch (value) {
    case "clock":
    case "random":
    case "uuid":
    case "env":
      return value;
    default:
      throw new TypeError(`Unknown entropy source "${value}". Use clock, random, uuid, or env.`);
  }
}

#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  unpackSession,
  type EntropyEvent,
  type ForkOverrides,
  type ModelCallEvent,
  type ProviderCodec,
  type RewindEvent,
  type SessionSelectorOptions,
  type SessionSummary,
  type SessionTimelineRow,
  type ToolCallEvent,
  type Usage
} from "@agentrewind/core";

const program = new Command();

program.name("agentrewind").alias("arw").description("Inspect and package AgentRewind sessions").version("0.1.2");

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
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--json", "print machine-readable JSON")
  .option("--no-header", "omit the table header")
  .description("Print an event timeline")
  .action(async (session: string, opts: SessionSelectorOptions & { json?: boolean; header?: boolean }) => {
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
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "model-call step; defaults to the first model call", parseInteger)
  .option("--site <name>", "model-call site; useful when you named ctx.model calls")
  .description("Print prompt context at a model-call step")
  .action(async (session: string, opts: SessionSelectorOptions & { step?: number; site?: string }) => {
    console.log(JSON.stringify(await readPromptContext(session, opts), null, 2));
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
  .option("--json", "print machine-readable JSON")
  .description("Fork a recorded run from a model call and execute the tail live")
  .action(async (session: string, opts: ForkCliOptions) => {
    await runForkCommand(session, opts);
  });

program
  .command("tool")
  .argument("<session>")
  .option("--store <dir>", "store used when <session> is an id or latest", ".rewind")
  .option("--step <n>", "tool-call step; defaults to the first tool call", parseInteger)
  .option("--name <name>", "tool name; useful when the tool appears once")
  .description("Print recorded tool args, result, or error")
  .action(async (session: string, opts: SessionSelectorOptions & { step?: number; name?: string }) => {
    console.log(JSON.stringify(formatToolCall(await readToolCall(session, opts)), null, 2));
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
  const client = createForkClient(providerKind, opts, !opts.dryRun);

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
    "No provider call was made. Remove --dry-run to create the child session."
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
    `Live tail: ${result.trace.liveModelCalls} model call${result.trace.liveModelCalls === 1 ? "" : "s"}, ${result.trace.recordedToolCalls} recorded tool call${result.trace.recordedToolCalls === 1 ? "" : "s"}`,
    `Tokens spent: in=${result.tokensSpent.inputTokens} out=${result.tokensSpent.outputTokens}`,
    `Diverged: ${result.divergedAtStep === undefined ? "no" : `step ${result.divergedAtStep}`}`,
    "",
    "Next commands:",
    ...result.nextCommands.map((command) => `- ${command}`)
  ].join("\n");
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

function formatEntropyDraw(event: EntropyEvent): Record<string, unknown> {
  return {
    step: event.step,
    lane: event.lane,
    site: event.callSite,
    source: event.source,
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
  codec: string;
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
    "- Creates the real provider SDK client and validates the codec can wrap it.",
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
    "import { AgentRewind, assertProviderClient, defineHarness, explainRewindError } from \"@agentrewind/sdk\";",
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
    "// Use the same SDK client your agent already uses in production.",
    "// AgentRewind wraps this client only while recording or for fork/live-tail calls.",
    spec.client,
    "",
    "// The codec translates provider-specific SDK shapes into AgentRewind's stable",
    "// session format. Use the same codec for record, replay, context, and fork.",
    spec.codec,
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
    "  // Fail fast if the selected codec does not match the SDK client's method path.",
    "  assertProviderClient(model, codec);",
    "",
    "  // Record one live run. This is the only phase below that should spend",
    "  // provider tokens or call external tools.",
    "  const recorded = await AgentRewind.recordRun(",
    "    {",
    "      id: sessionId,",
    "      store: \".rewind\",",
    "      model,",
    "      codec",
    "    },",
    "    harness",
    "  );",
    "",
    "  // Replay the same harness with no model client. Strict replay serves the",
    "  // recorded model response and fails if the harness builds a different request.",
    "  const replayed = await AgentRewind.replayRun(recorded.path, { codec }, harness);",
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
          "import { OpenAI, openaiChatCodec } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: "const model = new OpenAI({ apiKey: requiredEnv(\"OPENAI_API_KEY\") });",
        codec: "const codec = openaiChatCodec();",
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
          "import { OpenAI, openaiChatCodec } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: [
          "const model = new OpenAI({",
          "  apiKey: requiredEnv(\"COMPATIBLE_API_KEY\"),",
          "  baseURL: requiredEnv(\"COMPATIBLE_BASE_URL\")",
          "});"
        ].join("\n"),
        codec: "const codec = openaiChatCodec();",
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
          "import { OpenAI, openRouterChatCodec, openRouterClientOptions } from \"@agentrewind/sdk\";",
          "import type { ChatCompletion } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: [
          "const model = new OpenAI(",
          "  openRouterClientOptions({",
          "    apiKey: requiredEnv(\"OPENROUTER_API_KEY\"),",
          "    appUrl: \"https://your-app.example\",",
          "    appTitle: \"Your Agent\"",
          "  })",
          ");"
        ].join("\n"),
        codec: "const codec = openRouterChatCodec();",
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
          "import { Anthropic, anthropicCodec } from \"@agentrewind/sdk\";",
          "import type { AnthropicMessage } from \"@agentrewind/sdk\";"
        ].join("\n"),
        client: "const model = new Anthropic({ apiKey: requiredEnv(\"ANTHROPIC_API_KEY\") });",
        codec: "const codec = anthropicCodec();",
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

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`Expected integer, got ${value}`);
  }
  return parsed;
}

function parseEntropySource(value: string): EntropyEvent["source"] {
  switch (value) {
    case "clock":
    case "random":
    case "uuid":
      return value;
    default:
      throw new TypeError(`Unknown entropy source "${value}". Use clock, random, or uuid.`);
  }
}

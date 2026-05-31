#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import {
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
  type RewindEvent,
  type SessionSelectorOptions,
  type SessionSummary,
  type SessionTimelineRow,
  type ToolCallEvent,
  type Usage
} from "@agentrewind/core";

const program = new Command();

program.name("agentrewind").alias("arw").description("Inspect and package AgentRewind sessions").version("0.1.0");

program
  .command("quickstart")
  .argument("[provider]", "openai | openai-compatible | openrouter | anthropic")
  .option("--manager <name>", "package manager for install command: pnpm, npm, yarn, or bun", "pnpm")
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

async function resolveSessionSelector(selector: string, opts: SessionSelectorOptions = {}): Promise<string> {
  return resolveSessionPath(selector, opts);
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
      "Add --manager npm, --manager yarn, or --manager bun if you do not use pnpm."
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
    "import { AgentRewind, assertProviderClient, defineHarness, explainRewindError } from \"agentrewind\";",
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
      throw new TypeError(`Unknown package manager "${manager}". Use pnpm, npm, yarn, or bun.`);
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
        install: ["agentrewind", "@agentrewind/codec-openai", "openai"],
        env: ["OPENAI_API_KEY=...", "OPENAI_MODEL=..."],
        imports: [
          "import OpenAI from \"openai\";",
          "import { openaiChatCodec } from \"@agentrewind/codec-openai\";",
          "import type { ChatCompletion } from \"openai/resources/chat/completions\";"
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
        install: ["agentrewind", "@agentrewind/codec-openai", "openai"],
        env: ["COMPATIBLE_API_KEY=...", "COMPATIBLE_BASE_URL=https://your-provider.example/v1", "COMPATIBLE_MODEL=..."],
        imports: [
          "import OpenAI from \"openai\";",
          "import { openaiChatCodec } from \"@agentrewind/codec-openai\";",
          "import type { ChatCompletion } from \"openai/resources/chat/completions\";"
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
        install: ["agentrewind", "@agentrewind/codec-openrouter", "openai"],
        env: ["OPENROUTER_API_KEY=...", "OPENROUTER_MODEL=..."],
        imports: [
          "import OpenAI from \"openai\";",
          "import { openRouterChatCodec, openRouterClientOptions } from \"@agentrewind/codec-openrouter\";",
          "import type { ChatCompletion } from \"openai/resources/chat/completions\";"
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
        install: ["agentrewind", "@agentrewind/codec-anthropic", "@anthropic-ai/sdk"],
        env: ["ANTHROPIC_API_KEY=...", "ANTHROPIC_MODEL=..."],
        imports: [
          "import Anthropic from \"@anthropic-ai/sdk\";",
          "import { anthropicCodec } from \"@agentrewind/codec-anthropic\";",
          "import type { Message } from \"@anthropic-ai/sdk/resources/messages/messages\";"
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
    "const message = await ctx.model.create<Message>(",
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

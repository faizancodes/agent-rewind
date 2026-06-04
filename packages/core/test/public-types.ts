import {
  AgentRewind,
  assertProviderCodec,
  search as searchHelpers,
  diffPromptContext,
  readEntropyDraw,
  readPromptContext,
  readSessionSummary,
  readSessionTimeline,
  readToolCall,
  type EntropyInspectionOptions,
  type PackSessionOptions,
  type ProviderCodec,
  type PromptContextOptions,
  type PromptDiffOptions,
  type RecordOptions,
  type ReplayOptions,
  type ReplayRunOptions,
  type SessionSummary,
  type SessionTimelineRow,
  type TrajectorySearchResult,
  type JsonValue,
  type ToolCallInspectionOptions
} from "../src/index.js";

declare const codec: ProviderCodec;
declare const model: unknown;
declare const recordOptions: RecordOptions;
declare const replayOptions: ReplayOptions;
declare const replayRunOptions: ReplayRunOptions;
declare const packSessionOptions: PackSessionOptions;
declare const promptContextOptions: PromptContextOptions;
declare const promptDiffOptions: PromptDiffOptions;
declare const toolCallInspectionOptions: ToolCallInspectionOptions;
declare const entropyInspectionOptions: EntropyInspectionOptions;

function publicRecordReturnType() {
  const session = AgentRewind.record(recordOptions);
  session.run(async (ctx) => ctx.uuid());
  session.close();

  // @ts-expect-error Internal recording appenders should not be exposed through AgentRewind.record().
  session.append;
  // @ts-expect-error Fork-only live model recording helpers should stay out of the public Session interface.
  session.recordLiveModel;
}

async function publicReplayReturnType() {
  const replay = await AgentRewind.replay("session-path", replayOptions);
  replay.events();
  replay.fork({
    atStep: 0,
    model,
    harness: async (ctx) => {
      await ctx.model.create({ model: "m", messages: [], params: {} });
    }
  });
  const search: TrajectorySearchResult<string> = await replay.search<string>({
    atStep: 0,
    model,
    strategy: "alpha-zero",
    budget: { maxRollouts: 3, maxDepth: 2, explorationWeight: 1, puctExploration: 1.5 },
    actions: [{ id: "candidate", prior: 0.8, overrides: { system: "Try a different prompt." } }],
    score: ({ result }) => (result === "ok" ? 1 : 0)
  });
  search.best?.score?.toFixed();
  const json: JsonValue = { ok: true };
  const rubric = searchHelpers.defineJudgeRubric({
    name: "routing",
    goal: "Pick the correct route.",
    criteria: ["Correct route"]
  });
  await searchHelpers.promptSweep<string>(replay, {
    atStep: 0,
    model,
    prompts: ["try a clearer prompt"],
    score: ({ result }) => ({ score: result === "ok" ? 1 : 0, metadata: json })
  });
  await searchHelpers.judge<string>(replay, {
    atStep: 0,
    model,
    actions: [{ id: "candidate", metadata: json }],
    rubric,
    judge: async () => ({ score: 1, reason: "passes", usage: { inputTokens: 1, outputTokens: 1 } })
  });

  // @ts-expect-error Loaded replay storage is an implementation detail, not public API.
  replay.stored;
  // @ts-expect-error The remembered harness is an implementation detail used by fork.
  replay.lastHarness;
}

async function publicReplayAcceptsSessionSelectors() {
  await AgentRewind.resolveSessionPath("latest", { store: ".rewind" });
  const sessions = await AgentRewind.listSessions(".rewind");
  sessions.map((session) => session.toUpperCase());
  const summaries = await AgentRewind.listSessionSummaries(".rewind");
  summaries.map((summary) => summary.counts.modelCalls.toFixed());
  await AgentRewind.replay("latest", { store: ".rewind" });
  await AgentRewind.replay("session-id", { ...replayOptions, store: ".rewind" });
}

async function publicPackConveniences() {
  await AgentRewind.pack("latest", "session.rewind", { ...packSessionOptions, store: ".rewind" });
  await AgentRewind.unpack("session.rewind", "unpacked-session");
}

async function publicSessionSummaries() {
  const summary: SessionSummary = await AgentRewind.summary("latest", { store: ".rewind" });
  summary.counts.modelCalls.toFixed();
  summary.usage.inputTokens.toFixed();
  summary.modelSteps.map((step) => step.site.toUpperCase());

  const direct = await readSessionSummary("session-id", { store: ".rewind" });
  direct.toolSteps.map((step) => step.name.toUpperCase());

  const timeline: SessionTimelineRow[] = await AgentRewind.timeline("latest", { store: ".rewind" });
  timeline.map((row) => row.kind.toUpperCase());
  const directTimeline = await readSessionTimeline("session-id", { store: ".rewind" });
  directTimeline.map((row) => row.step.toFixed());
}

async function publicPromptInspectionHelpers() {
  const messages = await AgentRewind.promptContext("latest", { ...promptContextOptions, store: ".rewind", site: "draft-answer" });
  messages.map((message) => message.role.toUpperCase());
  const diff = await AgentRewind.promptDiff("latest", { ...promptDiffOptions, store: ".rewind", fromSite: "draft-answer", toSite: "final-answer" });
  diff.tokenDelta.toFixed();

  await readPromptContext("session-id", { store: ".rewind", step: 0 });
  await diffPromptContext("session-id", { store: ".rewind", from: 0, to: 2 });

  const tool = await AgentRewind.toolCall("latest", { ...toolCallInspectionOptions, store: ".rewind", name: "lookupCustomer" });
  tool.name.toUpperCase();
  tool.step.toFixed();
  const directTool = await readToolCall("session-id", { store: ".rewind", step: 1 });
  directTool.args;

  const entropy = await AgentRewind.entropyDraw("latest", { ...entropyInspectionOptions, store: ".rewind", source: "uuid" });
  entropy.value;
  const directEntropy = await readEntropyDraw("session-id", { store: ".rewind", step: 2 });
  directEntropy.source.toUpperCase();
}

async function publicReplayRunReturnType() {
  const result = await AgentRewind.replayRun("session-path", replayRunOptions, async (ctx) => ctx.uuid());
  result.toUpperCase();
  await AgentRewind.replayRun("latest", { ...replayRunOptions, store: ".rewind" }, async (ctx) => ctx.uuid());

  // @ts-expect-error One-shot replay needs a codec because it can execute model calls.
  AgentRewind.replayRun("session-path", {}, async (ctx) => ctx.uuid());
}

function publicReplayOptionsStillAllowOmittedModel() {
  AgentRewind.replay("session-path", { codec });
}

function publicReplayStillAllowsOmittedCodecForInspection() {
  AgentRewind.replay("session-path");
}

function publicRecordOptionsStillAllowUnknownModel() {
  AgentRewind.record({ ...recordOptions, model, codec });
}

function publicProviderCodecAssertionNarrowsUnknown(value: unknown) {
  assertProviderCodec(value);
  value.normalizeRequest({});
}

import {
  createRecordSession,
  isAgentDefinition,
  type AgentDefinition,
  type Harness,
  type RecordOptions,
  type Session,
  type ToolHandlers,
  type UntypedToolHandlers
} from "./record.js";
import type { ProviderCodec } from "./codec.js";
import { ReplaySession, type Replay, type ReplayOptions, type ReplayRunOptions } from "./replay.js";
import { listSessionPaths, packSession, resolveSessionPath, sessionPath, unpackSession } from "./session-store.js";
import { listSessionSummaries, readSessionSummary } from "./summary.js";
import { diffPromptContext, readEntropyDraw, readPromptContext, readToolCall } from "./inspection.js";
import { readSessionTimeline } from "./timeline.js";
import { ConfigurationError } from "./errors.js";

export interface RecordRunResult<T> {
  /** Closed recording session id. */
  id: string;
  /** Filesystem path to the written session directory. */
  path: string;
  /** Value returned by the harness. */
  result: T;
}

export type HarnessOrAgent<
  T = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> =
  | Harness<T, TTools, TRequest, TResponse, TStreamChunk>
  | AgentDefinition<T, TTools, TRequest, TResponse, TStreamChunk>;

/** Load a session, run one harness replay, and return the harness result. */
export async function replayRun<
  T = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  sessionPath: string,
  opts: ReplayRunOptions<TTools, TRequest, TResponse, TStreamChunk>,
  harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
): Promise<T> {
  const resolved = resolveHarnessAndTools(opts, harnessOrAgent, "replayRun");
  const replay = await ReplaySession.load<TTools, TRequest, TResponse, TStreamChunk>(sessionPath, applyResolvedTools(opts, resolved));
  return replay.run(resolved.harness);
}

export interface ProviderBindingOptions<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Store used by bound record/replay helpers. Defaults to `.rewind`. */
  store?: string;
  /** Live provider SDK client to wrap during recording and fork live tails. */
  model: unknown;
  /** Provider codec matching the model client. */
  codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  /** Default tool handlers for record/replay helpers. */
  tools?: TTools;
}

export type BoundRecordOptions<
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
> = Omit<RecordOptions<TTools, TRequest, TResponse, TStreamChunk>, "store" | "model" | "codec" | "tools"> & {
  store?: string;
  tools?: TTools;
};

export type BoundReplayOptions<
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk
> = Omit<ReplayOptions<TTools, TRequest, TResponse, TStreamChunk>, "store" | "model" | "codec" | "tools"> & {
  store?: string;
  tools?: TTools;
};

export interface BoundAgentRewind<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  readonly store: string;
  readonly model: unknown;
  readonly codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  readonly tools?: TTools;
  record(opts?: BoundRecordOptions<TTools, TRequest, TResponse, TStreamChunk>): Session<TTools, TRequest, TResponse, TStreamChunk>;
  recordRun<T>(
    opts: BoundRecordOptions<TTools, TRequest, TResponse, TStreamChunk>,
    harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<RecordRunResult<T>>;
  recordRun<T>(harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<RecordRunResult<T>>;
  replay(selector: string, opts?: BoundReplayOptions<TTools, TRequest, TResponse, TStreamChunk>): Promise<Replay<TTools, TRequest, TResponse, TStreamChunk>>;
  replayRun<T>(
    selector: string,
    opts: BoundReplayOptions<TTools, TRequest, TResponse, TStreamChunk>,
    harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<T>;
  replayRun<T>(selector: string, harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<T>;
}

export const AgentRewind = {
  /** Start a live recording session. */
  record<TTools extends ToolHandlers = UntypedToolHandlers, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(
    opts: RecordOptions<TTools, TRequest, TResponse, TStreamChunk>
  ): Session<TTools, TRequest, TResponse, TStreamChunk> {
    return createRecordSession(opts);
  },
  /** Record one harness run and always close the session afterward. */
  async recordRun<
    T = unknown,
    TTools extends ToolHandlers = UntypedToolHandlers,
    TRequest = unknown,
    TResponse = unknown,
    TStreamChunk = unknown
  >(
    opts: RecordOptions<TTools, TRequest, TResponse, TStreamChunk>,
    harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<RecordRunResult<T>> {
    const resolved = resolveHarnessAndTools(opts, harnessOrAgent, "recordRun");
    const finalOpts = applyResolvedTools(opts, resolved);
    const session = createRecordSession(finalOpts);
    try {
      const result = await session.run(resolved.harness);
      return {
        id: session.id,
        path: sessionPath(finalOpts.store, session.id),
        result
      };
    } finally {
      await session.close();
    }
  },
  /** Bind a provider client and codec once, then record/replay without repeating them. */
  withProvider<
    TTools extends ToolHandlers = UntypedToolHandlers,
    TRequest = unknown,
    TResponse = unknown,
    TStreamChunk = unknown
  >(
    binding: ProviderBindingOptions<TTools, TRequest, TResponse, TStreamChunk>
  ): BoundAgentRewind<TTools, TRequest, TResponse, TStreamChunk> {
    const store = binding.store ?? ".rewind";
    const bound: BoundAgentRewind<TTools, TRequest, TResponse, TStreamChunk> = {
      store,
      model: binding.model,
      codec: binding.codec,
      ...(binding.tools ? { tools: binding.tools } : {}),
      record: (opts = {}) => createRecordSession(boundRecordOptions(binding, opts)),
      recordRun: async <T>(
        optsOrAgent: BoundRecordOptions<TTools, TRequest, TResponse, TStreamChunk> | HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>,
        maybeAgent?: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
      ) => {
        const opts = maybeAgent ? (optsOrAgent as BoundRecordOptions<TTools, TRequest, TResponse, TStreamChunk>) : {};
        const agent = (maybeAgent ?? optsOrAgent) as HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>;
        return AgentRewind.recordRun(boundRecordOptions(binding, opts), agent);
      },
      replay: (selector, opts = {}) => ReplaySession.load<TTools, TRequest, TResponse, TStreamChunk>(selector, boundReplayOptions(binding, opts)),
      replayRun: async <T>(
        selector: string,
        optsOrAgent: BoundReplayOptions<TTools, TRequest, TResponse, TStreamChunk> | HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>,
        maybeAgent?: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>
      ) => {
        const opts = maybeAgent ? (optsOrAgent as BoundReplayOptions<TTools, TRequest, TResponse, TStreamChunk>) : {};
        const agent = (maybeAgent ?? optsOrAgent) as HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>;
        return replayRun(selector, boundReplayOptions(binding, opts) as ReplayRunOptions<TTools, TRequest, TResponse, TStreamChunk>, agent);
      }
    };
    return bound;
  },
  /** Load a session and run one replay harness. */
  replayRun,
  /** List recorded session directories in a store. */
  listSessions(store = ".rewind"): Promise<string[]> {
    return listSessionPaths(store);
  },
  /** List summarized sessions in a store, newest first. */
  listSessionSummaries,
  /** Resolve a session path, session id, store with one session, or `latest`. */
  resolveSessionPath,
  /** Read and summarize a session without hand-counting recorded events. */
  summary: readSessionSummary,
  /** Read compact timeline rows for a session, matching `agentrewind inspect --json`. */
  timeline: readSessionTimeline,
  /** Read prompt messages from a recorded model call by step, site, or default first model call. */
  promptContext: readPromptContext,
  /** Diff prompt messages between recorded model calls by step or site. */
  promptDiff: diffPromptContext,
  /** Read a recorded tool call by step, unique tool name, or default first tool call. */
  toolCall: readToolCall,
  /** Read a recorded entropy draw from ctx.clock(), ctx.random(), or ctx.uuid(). */
  entropyDraw: readEntropyDraw,
  /** Create a vault-excluded `.rewind` bundle from a session path, id, store, or `latest`. */
  pack: packSession,
  /** Restore a `.rewind` bundle into a directory. */
  unpack: unpackSession,
  /** Load a recorded session for replay, inspection, or fork. */
  replay<TTools extends ToolHandlers = UntypedToolHandlers, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(
    sessionPath: string,
    opts?: ReplayOptions<TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<Replay<TTools, TRequest, TResponse, TStreamChunk>> {
    return ReplaySession.load<TTools, TRequest, TResponse, TStreamChunk>(sessionPath, opts);
  }
};

function resolveHarnessAndTools<
  T,
  TTools extends ToolHandlers,
  TRequest,
  TResponse,
  TStreamChunk,
  TOptions extends { tools?: TTools }
>(
  opts: TOptions,
  harnessOrAgent: HarnessOrAgent<T, TTools, TRequest, TResponse, TStreamChunk>,
  operation: string
): { harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>; tools?: TTools } {
  if (!isAgentDefinition(harnessOrAgent)) {
    return { harness: harnessOrAgent as Harness<T, TTools, TRequest, TResponse, TStreamChunk> };
  }
  if (opts.tools && harnessOrAgent.tools && opts.tools !== harnessOrAgent.tools) {
    throw new ConfigurationError(`AgentRewind.${operation}() received two different tools objects`, {
      operation,
      expected: "Pass tools once by using defineAgent({ tools, harness }) or pass the same tools object in options."
    });
  }
  return {
    harness: harnessOrAgent.harness as Harness<T, TTools, TRequest, TResponse, TStreamChunk>,
    ...(harnessOrAgent.tools ? { tools: harnessOrAgent.tools as TTools } : {})
  };
}

function applyResolvedTools<TTools extends ToolHandlers, TOptions extends { tools?: TTools }>(
  opts: TOptions,
  resolved: { tools?: TTools }
): TOptions {
  if (!resolved.tools || opts.tools === resolved.tools) {
    return opts;
  }
  return { ...opts, tools: resolved.tools };
}

function boundRecordOptions<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  binding: ProviderBindingOptions<TTools, TRequest, TResponse, TStreamChunk>,
  opts: BoundRecordOptions<TTools, TRequest, TResponse, TStreamChunk>
): RecordOptions<TTools, TRequest, TResponse, TStreamChunk> {
  const tools = opts.tools ?? binding.tools;
  return {
    ...opts,
    store: opts.store ?? binding.store ?? ".rewind",
    model: binding.model,
    codec: binding.codec,
    ...(tools ? { tools } : {})
  };
}

function boundReplayOptions<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  binding: ProviderBindingOptions<TTools, TRequest, TResponse, TStreamChunk>,
  opts: BoundReplayOptions<TTools, TRequest, TResponse, TStreamChunk>
): ReplayRunOptions<TTools, TRequest, TResponse, TStreamChunk> {
  const tools = opts.tools ?? binding.tools;
  return {
    ...opts,
    store: opts.store ?? binding.store ?? ".rewind",
    model: binding.model,
    codec: binding.codec,
    ...(tools ? { tools } : {})
  };
}

export type { ForkOverrides, ProviderCodec, ProviderRequest, ProviderResponse, ProviderStreamChunk } from "./codec.js";
export type {
  AgentContext,
  AgentDefinition,
  Harness,
  RecordOptions,
  Session,
  ToolHandler,
  ToolHandlers,
  InterceptPurpose,
  UntypedToolHandlers,
  WrappedToolHandler,
  WrappedTools,
  WrappedModel
} from "./record.js";
export { assertProviderClient, assertProviderCodec, defineAgent, defineHarness, defineTools } from "./record.js";
export type { Replay, ReplayOptions, ReplayRunOptions } from "./replay.js";
export type { ForkOptions, ForkResult, Sandbox, Trace } from "./fork.js";
export type {
  DefineJudgeRubricOptions,
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  TrajectoryBestBranchMetric,
  TrajectoryJudge,
  TrajectoryJudgeCache,
  TrajectoryJudgeCriterionResult,
  TrajectoryJudgeInput,
  TrajectoryJudgeOutput,
  TrajectoryJudgeRubric,
  TrajectoryJudgeRubricCriterion,
  TrajectoryJudgeScorerOptions,
  TrajectoryJudgeSearchOptions,
  TrajectoryModelCandidate,
  TrajectoryModelSweepOptions,
  TrajectoryPromptCandidate,
  TrajectoryPromptSweepOptions,
  TrajectoryRegressionAssertion,
  TrajectoryRegressionAssertionResult,
  TrajectoryRegressionOptions,
  TrajectorySearchRateLimitOptions,
  TrajectorySearchRetryOptions,
  TrajectorySearchRolloutEvent,
  TrajectorySearchRunner,
  TrajectorySearchAction,
  TrajectorySearchActionContext,
  TrajectorySearchBranchDiagnostic,
  TrajectorySearchBudget,
  TrajectorySearchDiagnostics,
  TrajectorySearchNode,
  TrajectorySearchOptions,
  TrajectorySearchResult,
  TrajectorySearchScore,
  TrajectorySearchScoreContext,
  TrajectorySearchStrategy,
  TrajectorySelectionReason
} from "./search.js";
export {
  createJudgeScorer,
  createMemoryJudgeCache,
  defineJudgeRubric,
  judgeSearch,
  modelSweep,
  promptSweep,
  regressionSearch,
  search,
  searchReplay,
  toJsonValue
} from "./search.js";
export type { ContextDiff, TokenizerRegistry } from "./tokens.js";
export {
  registerTokenizer,
  tokenizerRegistry,
  countMessages,
  diffMessages,
  usageAdd,
  usageByStep,
  usageTotal,
  usageForEvent
} from "./tokens.js";
export type { StepUsage } from "./tokens.js";
export type { EntropyInspectionOptions, PromptContextOptions, PromptDiffOptions, ToolCallInspectionOptions } from "./inspection.js";
export {
  diffPromptContext,
  entropyDrawForInspection,
  modelEventForContext,
  modelEventsForDiff,
  readEntropyDraw,
  readPromptContext,
  readToolCall,
  toolCallForInspection
} from "./inspection.js";
export type { SessionTimelineOptions, SessionTimelineRow } from "./timeline.js";
export { eventTimelineRow, readSessionTimeline } from "./timeline.js";
export type {
  SessionEventCounts,
  SessionModelStep,
  SessionSummary,
  SessionSummaryOptions,
  SessionToolStep
} from "./summary.js";
export { countSessionEvents, listSessionSummaries, readSessionSummary, summarizeSession } from "./summary.js";
export type {
  BaseEvent,
  ChunkRecord,
  EntropyEvent,
  EventKind,
  EventProvenance,
  FingerprintMode,
  Hash,
  ModelCallEvent,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  NoteEvent,
  RewindEvent,
  SerializedError,
  SessionEndEvent,
  SessionMeta,
  SessionStartEvent,
  ToolCallEvent,
  Usage
} from "./events.js";
export { isBoundaryEvent } from "./events.js";
export type { CodecConformanceCase, CodecConformanceOptions } from "./codec-conformance.js";
export { assertCodecConformance } from "./codec-conformance.js";
export {
  BLOB_THRESHOLD_BYTES,
  assertJsonSerializable,
  listSessionPaths,
  packSession,
  readSession,
  resolveSessionPath,
  serializeError,
  sessionBasename,
  sessionPath,
  unpackSession,
  writeSession
} from "./session-store.js";
export type { PackSessionOptions, SessionSelectorOptions, StoredSession } from "./session-store.js";
export { canonicalize, deepClone, fingerprint, fingerprintUnknown, sha256hex } from "./fingerprint.js";
export { PendingStore } from "./matcher.js";
export type { ReorderDiagnostic, Resolution, ResolveCtx } from "./matcher.js";
export { patternsFromLabels, Redactor, setVaultCryptoForTests, Vault, loadVault, saveVault } from "./redaction.js";
export type { RedactionConfig, RedactionSummary, VaultCrypto } from "./redaction.js";
export type { ToolSerialization, ToolSerializers, ToolValueSerializer } from "./tool-serialization.js";
export { CURRENT_SCHEMA_VERSION, migrateEvent, registerMigration } from "./migrate.js";
export type { EventMigration } from "./migrate.js";
export { defaultEntropyRuntime, EntropyReplay } from "./entropy.js";
export type { EntropyRuntime } from "./entropy.js";
export { PurityLint } from "./purity-lint.js";
export type { PurityLintDiagnostic } from "./purity-lint.js";
export {
  CodecError,
  ConfigurationError,
  DriftError,
  FingerprintError,
  MigrationError,
  PurityLintError,
  RewindError,
  SessionStoreError,
  SerializationError,
  VaultError,
  explainRewindError
} from "./errors.js";
export type { RewindErrorExplanationOptions } from "./errors.js";

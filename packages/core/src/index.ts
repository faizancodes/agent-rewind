import {
  createRecordSession,
  type Harness,
  type RecordOptions,
  type Session,
  type ToolHandlers,
  type UntypedToolHandlers
} from "./record.js";
import { ReplaySession, type Replay, type ReplayOptions, type ReplayRunOptions } from "./replay.js";
import { listSessionPaths, packSession, resolveSessionPath, sessionPath, unpackSession } from "./session-store.js";
import { listSessionSummaries, readSessionSummary } from "./summary.js";
import { diffPromptContext, readEntropyDraw, readPromptContext, readToolCall } from "./inspection.js";
import { readSessionTimeline } from "./timeline.js";

export interface RecordRunResult<T> {
  /** Closed recording session id. */
  id: string;
  /** Filesystem path to the written session directory. */
  path: string;
  /** Value returned by the harness. */
  result: T;
}

/** Load a session, run one harness replay, and return the harness result. */
export async function replayRun<T = unknown, TTools extends ToolHandlers = UntypedToolHandlers>(
  sessionPath: string,
  opts: ReplayRunOptions<TTools>,
  harness: Harness<T, TTools>
): Promise<T> {
  const replay = await ReplaySession.load<TTools>(sessionPath, opts);
  return replay.run(harness);
}

export const AgentRewind = {
  /** Start a live recording session. */
  record<TTools extends ToolHandlers = UntypedToolHandlers>(opts: RecordOptions<TTools>): Session<TTools> {
    return createRecordSession(opts);
  },
  /** Record one harness run and always close the session afterward. */
  async recordRun<T = unknown, TTools extends ToolHandlers = UntypedToolHandlers>(
    opts: RecordOptions<TTools>,
    harness: Harness<T, TTools>
  ): Promise<RecordRunResult<T>> {
    const session = createRecordSession(opts);
    try {
      const result = await session.run(harness);
      return {
        id: session.id,
        path: sessionPath(opts.store, session.id),
        result
      };
    } finally {
      await session.close();
    }
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
  replay<TTools extends ToolHandlers = UntypedToolHandlers>(sessionPath: string, opts?: ReplayOptions<TTools>): Promise<Replay<TTools>> {
    return ReplaySession.load<TTools>(sessionPath, opts);
  }
};

export type { ProviderCodec, ForkOverrides } from "./codec.js";
export type {
  AgentContext,
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
export { assertProviderClient, assertProviderCodec, defineHarness, defineTools } from "./record.js";
export type { Replay, ReplayOptions, ReplayRunOptions } from "./replay.js";
export type { ForkOptions, ForkResult, Sandbox, Trace } from "./fork.js";
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

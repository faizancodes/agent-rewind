import { dirname } from "node:path";
import type { ForkOverrides, ProviderCodec } from "./codec.js";
import type {
  BaseEvent,
  EventProvenance,
  ModelCallEvent,
  NormalizedRequest,
  RewindEvent,
  ToolCallEvent,
  Usage
} from "./events.js";
import type { AgentContext, BoundarySeed, Harness, ToolHandlers, UntypedToolHandlers, WrappedModel, WrappedTools } from "./record.js";
import type { EntropyRuntime } from "./entropy.js";
import { RecordSession } from "./record.js";
import type { ReplaySession } from "./replay.js";
import { deriveCallSite, LaneManager } from "./context.js";
import { defaultEntropyRuntime, EntropyReplay } from "./entropy.js";
import { fingerprint, fingerprintUnknown } from "./fingerprint.js";
import { PendingStore } from "./matcher.js";
import { patternsFromLabels, Redactor } from "./redaction.js";
import { deserializeToolValue, serializeToolValue } from "./tool-serialization.js";
import { DriftError, RewindError } from "./errors.js";
import { usageAdd } from "./tokens.js";
import { CURRENT_SCHEMA_VERSION } from "./migrate.js";

export interface ForkOptions<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Boundary step where live execution begins. Earlier boundaries are copied into the child as recorded provenance. */
  atStep: number;
  /** Harness to execute for this fork. Defaults to the last harness passed to `replay.run()`, then to a stored-event tail walk. */
  harness?: Harness<unknown, TTools, TRequest, TResponse, TStreamChunk>;
  /** Live model client for tail model calls. Falls back to replay options when present. */
  model?: unknown;
  /** Prompt/model/request changes for live tail model calls. */
  overrides?: ForkOverrides;
  /** Tool handling policy for tail calls. Defaults to serving recorded hits and erroring on misses. */
  tools?: { onMatch?: "serve-recorded"; onMiss?: "error" | "stub" };
  /** Optional success predicate evaluated against the resulting trace. */
  goal?: (trace: Trace) => boolean;
  /** Reserved gate for future live/sandboxed tool policies. */
  sandbox?: Sandbox;
  /** Injectable entropy runtime for deterministic fork tests. */
  runtime?: Partial<EntropyRuntime>;
}

export interface ForkResult<TResult = unknown> {
  /** Child recording session id. The child contains the recorded prefix plus the forked live/stub tail. */
  sessionId: string;
  /** Value returned by the fork harness when one was executed. */
  result?: TResult;
  /** Result of the optional goal predicate. */
  reachedGoal?: boolean;
  /** Token usage spent by live tail model calls only. Recorded prefix events do not add token spend. */
  tokensSpent: Usage;
  /** Step where fork halted because of tail divergence. */
  divergedAtStep?: number;
  /** Trace from the persisted child session, including recorded prefix and forked tail events. */
  trace: Trace;
}

export interface Trace {
  /** Events observed during fork, sorted by step. */
  events(): RewindEvent[];
  /** Whether a tool call with the optional argument subset appears in the trace. */
  reached(toolName: string, argsMatch?: Record<string, unknown>): boolean;
}

export interface Sandbox {
  /** Opaque marker for future sandbox-gated live tool policies. */
  readonly agentRewindSandbox: true;
}

class ForkTrace implements Trace {
  constructor(private readonly traceEvents: RewindEvent[]) {}

  events(): RewindEvent[] {
    return [...this.traceEvents].sort((a, b) => a.step - b.step);
  }

  reached(toolName: string, argsMatch?: Record<string, unknown>): boolean {
    return this.traceEvents.some((event) => {
      if (event.kind !== "tool_call" || event.name !== toolName) {
        return false;
      }
      if (!argsMatch) {
        return true;
      }
      if (event.args === null || typeof event.args !== "object") {
        return false;
      }
      const args = event.args as Record<string, unknown>;
      return Object.entries(argsMatch).every(([key, value]) => JSON.stringify(args[key]) === JSON.stringify(value));
    });
  }
}

class ForkDiverged extends Error {
  constructor(readonly step: number) {
    super(`Fork diverged at step ${step}`);
  }
}

export async function forkReplay<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>,
  opts: ForkOptions<TTools, TRequest, TResponse, TStreamChunk>
): Promise<ForkResult> {
  const codec = replay.requireCodec("fork");
  const liveModel = opts.model ?? replay.opts.model;
  const child = new RecordSession<TTools, TRequest, TResponse, TStreamChunk>({
    id: undefined,
    store: dirname(replay.stored.path),
    model: liveModel,
    tools: replay.opts.tools,
    codec,
    redaction: {
      enabled: replay.stored.meta.redaction.enabled,
      patterns: patternsFromLabels(replay.stored.meta.redaction.patterns),
      useOnlyPatterns: true
    },
    fingerprintMode: replay.stored.meta.fingerprintMode,
    parent: replay.stored.meta.id,
    forkedAtStep: opts.atStep,
    runtime: opts.runtime,
    toolSerializers: replay.opts.toolSerializers
  });
  const matcher = new PendingStore(replay.stored.events, false);
  const entropy = new EntropyReplay(replay.stored.events);
  const redactor = new Redactor(
    { enabled: replay.stored.meta.redaction.enabled, patterns: patternsFromLabels(replay.stored.meta.redaction.patterns), useOnlyPatterns: true },
    replay.stored.vault
  );
  const lanes = new LaneManager();
  const runtime = { ...defaultEntropyRuntime, ...opts.runtime };
  let tokensSpent: Usage = { inputTokens: 0, outputTokens: 0 };
  let divergedAtStep: number | undefined;
  let result: unknown;

  const state: ForkContextState<TTools> = {
    replay,
    opts,
    child,
    matcher,
    entropy,
    redactor,
    lanes,
    runtime,
    callOrdinals: new Map(),
    liveModel,
    codec,
    addUsage: (usage) => {
      tokensSpent = usageAdd(tokensSpent, usage);
    }
  };
  const context = forkContext(state);

  const harness = opts.harness ?? replay.lastHarness;
  try {
    if (harness) {
      result = await lanes.run(() => harness(context));
    } else {
      await forkFromStoredEvents(state);
    }
  } catch (error) {
    if (error instanceof ForkDiverged) {
      divergedAtStep = error.step;
    } else {
      await child.close();
      throw error;
    }
  }

  await child.close();
  const trace = new ForkTrace(child.events());
  return {
    sessionId: child.id,
    ...(result === undefined ? {} : { result }),
    reachedGoal: opts.goal ? opts.goal(trace) : undefined,
    tokensSpent,
    divergedAtStep,
    trace
  };
}

interface ForkContextState<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  replay: ReplaySession<TTools, TRequest, TResponse, TStreamChunk>;
  opts: ForkOptions<TTools, TRequest, TResponse, TStreamChunk>;
  child: RecordSession<TTools, TRequest, TResponse, TStreamChunk>;
  matcher: PendingStore;
  entropy: EntropyReplay;
  redactor: Redactor;
  lanes: LaneManager;
  runtime: EntropyRuntime;
  callOrdinals: Map<string, number>;
  liveModel: unknown;
  codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  addUsage(usage: Usage | undefined): void;
}

interface ForkBoundary extends BoundarySeed {
  finish(): void;
}

function beginForkBoundary<TTools extends ToolHandlers>(
  state: ForkContextState<TTools>,
  kind: "model_call" | "tool_call" | "entropy",
  explicit: string | undefined
): ForkBoundary {
  const lane = state.lanes.beginBoundaryLane(explicit ? `${kind}\u0000${explicit}` : undefined);
  const key = `${kind}\u0000${lane}`;
  const ordinal = state.callOrdinals.get(key) ?? 0;
  state.callOrdinals.set(key, ordinal + 1);
  let finished = false;
  return {
    lane,
    seq: state.lanes.nextSeq(lane),
    step: state.lanes.nextStep(),
    ts: state.runtime.now(),
    callSite: kind === "entropy" ? `${explicit ?? "entropy"}:${ordinal}:${explicit ?? "entropy"}` : deriveCallSite(explicit, kind, lane, ordinal),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    finish: () => {
      if (!finished) {
        finished = true;
        state.lanes.endBoundaryLane(lane);
      }
    }
  };
}

function boundaryFromEvent(event: BaseEvent): BoundarySeed {
  const { step, seq, ts, lane, callSite, schemaVersion } = event;
  return { step, seq, ts, lane, callSite, schemaVersion };
}

function forkContext<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  state: ForkContextState<TTools, TRequest, TResponse, TStreamChunk>
): AgentContext<TTools, TRequest, TResponse, TStreamChunk> {
  return {
    model: forkModel(state),
    tools: forkTools(state),
    clock: () => forkEntropy(state, "clock") as number,
    random: () => forkEntropy(state, "random") as number,
    uuid: () => forkEntropy(state, "uuid") as string,
    env: (key) => {
      const value = forkEntropy(state, "env", key);
      return value === null ? undefined : String(value);
    },
    note: (text) => state.child.note(text)
  } as AgentContext<TTools, TRequest, TResponse, TStreamChunk>;
}

function forkModel<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  state: ForkContextState<TTools, TRequest, TResponse, TStreamChunk>
): WrappedModel<TRequest, TResponse, TStreamChunk> {
  return {
    create: async <T = TResponse>(rawRequest: TRequest, callOpts?: { site?: string }) => {
      const normalized = state.codec.normalizeRequest(rawRequest);
      const requestHash = fingerprint(normalized, state.codec, state.redactor, state.replay.stored.meta.fingerprintMode);
      const boundary = beginForkBoundary(state, "model_call", callOpts?.site);
      const expectedStep = nextUnconsumedBoundaryStep(state);
      const resolution = state.matcher.resolve(requestHash, {
        kind: "model_call",
        callSite: boundary.callSite,
        lane: boundary.lane
      });
      try {
        if ("hit" in resolution) {
          assertNoSkippedPrefixBoundary(state, expectedStep, resolution.hit.step);
        }
        if ("hit" in resolution && resolution.hit.step < state.opts.atStep) {
          const event = resolution.hit as ModelCallEvent;
          recordServedModelCreate(state, event, normalized, callOpts?.site, boundary);
          return valueFromModelEvent(event as ModelCallEvent, state.redactor) as T;
        }
        if (!("hit" in resolution) && expectedStep !== undefined && expectedStep < state.opts.atStep) {
          throw new ForkDiverged(expectedStep);
        }
        if (!state.liveModel) {
          throw new DriftError("Fork tail model calls require a live model client", { atStep: state.opts.atStep });
        }
        const step = "hit" in resolution ? resolution.hit.step : state.opts.atStep;
        const overridden = state.codec.applyOverrides(normalized, state.opts.overrides ?? {}, step);
        const raw = state.codec.denormalizeRequest(overridden) as TRequest;
        const before = state.child.events().length;
        const live = await state.child.recordLiveModel(raw, state.liveModel, callOpts?.site, "live", undefined, boundary);
        const recorded = state.child.events().slice(before).filter((event): event is ModelCallEvent => event.kind === "model_call").at(-1);
        state.addUsage(recorded?.usage ?? recorded?.response?.usage);
        return live as T;
      } finally {
        boundary.finish();
      }
    },
    stream: <T = TStreamChunk>(rawRequest: TRequest, callOpts?: { site?: string }) => {
      const normalized = state.codec.normalizeRequest(rawRequest);
      const requestHash = fingerprint(normalized, state.codec, state.redactor, state.replay.stored.meta.fingerprintMode);
      const boundary = beginForkBoundary(state, "model_call", callOpts?.site);
      const expectedStep = nextUnconsumedBoundaryStep(state);
      const resolution = state.matcher.resolve(requestHash, {
        kind: "model_call",
        callSite: boundary.callSite,
        lane: boundary.lane
      });
      try {
        if ("hit" in resolution) {
          assertNoSkippedPrefixBoundary(state, expectedStep, resolution.hit.step);
        }
        if ("hit" in resolution && resolution.hit.step < state.opts.atStep) {
          const event = resolution.hit as ModelCallEvent;
          return finalizeStream(recordServedModelStream(state, event, normalized, callOpts?.site, boundary), boundary.finish) as AsyncIterable<T>;
        }
        if (!("hit" in resolution) && expectedStep !== undefined && expectedStep < state.opts.atStep) {
          throw new ForkDiverged(expectedStep);
        }
        if (!state.liveModel) {
          throw new DriftError("Fork tail model streams require a live model client", { atStep: state.opts.atStep });
        }
        const step = "hit" in resolution ? resolution.hit.step : state.opts.atStep;
        const overridden = state.codec.applyOverrides(normalized, state.opts.overrides ?? {}, step);
        const raw = state.codec.denormalizeRequest(overridden) as TRequest;
        const before = state.child.events().length;
        return finalizeStream(state.child.recordLiveModelStream(raw, state.liveModel, callOpts?.site, "live", boundary), () => {
          const recorded = state.child.events().slice(before).filter((event): event is ModelCallEvent => event.kind === "model_call").at(-1);
          state.addUsage(recorded?.usage ?? recorded?.response?.usage);
          boundary.finish();
        }) as AsyncIterable<T>;
      } catch (error) {
        boundary.finish();
        throw error;
      }
    }
  };
}

function forkTools<TTools extends ToolHandlers>(state: ForkContextState<TTools>): WrappedTools<TTools> {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return (args: unknown) => forkToolCall(state, property, args);
      }
    }
  ) as WrappedTools<TTools>;
}

function forkToolCall<TTools extends ToolHandlers>(
  state: ForkContextState<TTools>,
  name: string,
  args: unknown
): Promise<unknown> | AsyncIterable<unknown> {
  const boundary = beginForkBoundary(state, "tool_call", name);
  try {
    const serializedArgs = serializeToolValue(state.replay.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
    const argsHash = fingerprintUnknown(serializedArgs, state.redactor);
    const expectedStep = nextUnconsumedBoundaryStep(state);
    const resolution = state.matcher.resolve(argsHash, {
      kind: "tool_call",
      callSite: boundary.callSite,
      lane: boundary.lane,
      name
    });
    if ("hit" in resolution) {
      const event = resolution.hit as ToolCallEvent;
      assertNoSkippedPrefixBoundary(state, expectedStep, event.step);
      if (event.step < state.opts.atStep) {
        if (event.error) {
          const restoredError = state.redactor.vault.restore(event.error);
          state.child.recordServedToolError(name, args, argsHash, event.error, "recorded", boundary);
          return Promise.reject(new RewindError(restoredError.message, restoredError.data)).finally(boundary.finish);
        }
        if (event.stream) {
          const restoredChunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
            ...chunk,
            data: deserializeToolValue(state.replay.opts.toolSerializers, name, "streamChunk", chunk.data)
          }));
          return finalizeStream(state.child.recordServedToolStream(name, args, restoredChunks, argsHash, "recorded", boundary), boundary.finish);
        }
        const restoredResult = state.redactor.vault.restore(event.result);
        const result = deserializeToolValue(state.replay.opts.toolSerializers, name, "result", restoredResult);
        state.child.recordServedToolResult(name, args, result, argsHash, "recorded", boundary);
        return Promise.resolve(result).finally(boundary.finish);
      }

      const policy = state.opts.tools?.onMatch ?? "serve-recorded";
      void policy;
      if (event.error) {
        const restoredError = state.redactor.vault.restore(event.error);
        state.child.recordServedToolError(name, args, argsHash, event.error, "recorded", boundary);
        return Promise.reject(new RewindError(restoredError.message, restoredError.data)).finally(boundary.finish);
      }
      if (event.stream) {
        const restoredChunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
          ...chunk,
          data: deserializeToolValue(state.replay.opts.toolSerializers, name, "streamChunk", chunk.data)
        }));
        return finalizeStream(state.child.recordServedToolStream(name, args, restoredChunks, argsHash, "recorded", boundary), boundary.finish);
      }
      const restoredResult = state.redactor.vault.restore(event.result);
      const result = deserializeToolValue(state.replay.opts.toolSerializers, name, "result", restoredResult);
      state.child.recordServedToolResult(name, args, result, argsHash, "recorded", boundary);
      return Promise.resolve(result).finally(boundary.finish);
    }

    if (expectedStep !== undefined && expectedStep < state.opts.atStep) {
      throw new ForkDiverged(expectedStep);
    }
    const onMiss = state.opts.tools?.onMiss ?? "error";
    if (onMiss === "stub") {
      const result = { __agentrewind_unavailable: true };
      state.child.recordStubTool(name, args, result, argsHash, boundary);
      return Promise.resolve(result).finally(boundary.finish);
    }
    throw new ForkDiverged(state.opts.atStep);
  } catch (error) {
    boundary.finish();
    throw error;
  }
}

function forkEntropy<TTools extends ToolHandlers>(state: ForkContextState<TTools>, source: "clock" | "random" | "uuid"): number | string;
function forkEntropy<TTools extends ToolHandlers>(state: ForkContextState<TTools>, source: "env", key: string): string | null;
function forkEntropy<TTools extends ToolHandlers>(
  state: ForkContextState<TTools>,
  source: "clock" | "random" | "uuid" | "env",
  key?: string
): number | string | null {
  const explicit = source === "env" && key ? `env:${key}` : source;
  const boundary = beginForkBoundary(state, "entropy", explicit);
  try {
    const expectedStep = nextUnconsumedBoundaryStep(state);
    const recorded = state.entropy.peek(source, boundary.lane, key);
    if (recorded && recorded.step < state.opts.atStep) {
      if (expectedStep !== undefined && expectedStep < recorded.step && expectedStep < state.opts.atStep) {
        throw new ForkDiverged(expectedStep);
      }
      const event = state.entropy.nextEvent(source, boundary.lane, "strict", key);
      if (source === "env") {
        state.child.recordServedEntropy("env", event.value === null ? null : String(event.value), "recorded", key ?? "", boundary);
      } else {
        state.child.recordServedEntropy(source, event.value as number | string, "recorded", boundary);
      }
      return event.value;
    }
    if (expectedStep !== undefined && expectedStep < state.opts.atStep) {
      throw new ForkDiverged(expectedStep);
    }
    if (source === "env") {
      return state.child.recordEnv(key ?? "", process.env[key ?? ""], "live", boundary) ?? null;
    }
    return state.child.recordLiveEntropy(source, "live", boundary);
  } finally {
    boundary.finish();
  }
}

function nextUnconsumedBoundaryStep<TTools extends ToolHandlers>(state: ForkContextState<TTools>): number | undefined {
  const steps = [state.matcher.nextUnconsumedStep(), state.entropy.nextUnconsumedStep()].filter(
    (step): step is number => step !== undefined
  );
  return steps.length > 0 ? Math.min(...steps) : undefined;
}

function assertNoSkippedPrefixBoundary<TTools extends ToolHandlers>(
  state: ForkContextState<TTools>,
  expectedStep: number | undefined,
  hitStep: number
): void {
  if (expectedStep !== undefined && expectedStep < state.opts.atStep && expectedStep !== hitStep) {
    throw new ForkDiverged(expectedStep);
  }
}

async function forkFromStoredEvents<TTools extends ToolHandlers>(state: ForkContextState<TTools>): Promise<void> {
  for (const event of [...state.replay.stored.events].sort((a, b) => a.step - b.step)) {
    if (event.step < state.opts.atStep) {
      if (event.kind === "model_call") {
        await recordStoredModelEvent(state, event, "recorded");
      } else if (event.kind === "tool_call") {
        await forkStoredToolEvent(state, event);
      } else if (event.kind === "entropy") {
        if (event.source === "env") {
          state.child.recordServedEntropy("env", event.value === null ? null : String(event.value), "recorded", event.key ?? "", boundaryFromEvent(event));
        } else {
          state.child.recordServedEntropy(event.source, event.value as number | string, "recorded", boundaryFromEvent(event));
        }
      } else if (event.kind === "note") {
        state.child.note(state.redactor.vault.restore(event.text));
      }
      continue;
    }

    if (event.kind === "model_call") {
      await forkStoredModelEvent(state, event);
      continue;
    }
    if (event.kind === "tool_call") {
      await forkStoredToolEvent(state, event);
      continue;
    }
    if (event.kind === "entropy") {
      if (event.source === "env") {
        state.child.recordEnv(event.key ?? "", process.env[event.key ?? ""], "live", boundaryFromEvent(event));
      } else {
        state.child.recordLiveEntropy(event.source, "live", boundaryFromEvent(event));
      }
      continue;
    }
    if (event.kind === "note") {
      state.child.note(state.redactor.vault.restore(event.text));
    }
  }
}

async function recordStoredModelEvent<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  state: ForkContextState<TTools, TRequest, TResponse, TStreamChunk>,
  event: ModelCallEvent,
  provenance: EventProvenance
): Promise<void> {
  const normalizedRequest = state.redactor.vault.restore(event.request) as NormalizedRequest;
  if (event.stream) {
    await consumeAsyncIterable(recordServedModelStream(state, event, normalizedRequest, undefined, boundaryFromEvent(event), provenance));
    return;
  }
  recordServedModelCreate(state, event, normalizedRequest, undefined, boundaryFromEvent(event), provenance);
}

async function forkStoredModelEvent<TTools extends ToolHandlers>(state: ForkContextState<TTools>, event: ModelCallEvent): Promise<void> {
  if (!state.liveModel) {
    throw new DriftError("Fork tail model calls require a live model client", { atStep: state.opts.atStep });
  }
  const restoredRequest = state.redactor.vault.restore(event.request) as NormalizedRequest;
  const overridden = state.codec.applyOverrides(restoredRequest, state.opts.overrides ?? {}, event.step);
  const raw = state.codec.denormalizeRequest(overridden);
  const before = state.child.events().length;
  if (event.stream) {
    await consumeAsyncIterable(state.child.recordLiveModelStream(raw, state.liveModel, undefined, "live", boundaryFromEvent(event)));
  } else {
    await state.child.recordLiveModel(raw, state.liveModel, undefined, "live", undefined, boundaryFromEvent(event));
  }
  const recorded = state.child.events().slice(before).filter((candidate): candidate is ModelCallEvent => candidate.kind === "model_call").at(-1);
  state.addUsage(recorded?.usage ?? recorded?.response?.usage);
}

function recordServedModelCreate<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  state: ForkContextState<TTools, TRequest, TResponse, TStreamChunk>,
  event: ModelCallEvent,
  normalizedRequest: NormalizedRequest,
  site: string | undefined,
  boundary: BoundarySeed,
  provenance: EventProvenance = "recorded"
): void {
  if (event.error) {
    state.child.recordServedModelError(
      normalizedRequest,
      state.redactor.vault.restore(event.error),
      site,
      provenance,
      event.callSite,
      boundary
    );
    return;
  }
  state.child.recordServedModelResult(
    normalizedRequest,
    state.redactor.vault.restore(event.response),
    site,
    provenance,
    event.callSite,
    boundary
  );
}

function recordServedModelStream<TTools extends ToolHandlers, TRequest, TResponse, TStreamChunk>(
  state: ForkContextState<TTools, TRequest, TResponse, TStreamChunk>,
  event: ModelCallEvent,
  normalizedRequest: NormalizedRequest,
  site: string | undefined,
  boundary: BoundarySeed,
  provenance: EventProvenance = "recorded"
): AsyncIterable<unknown> {
  return state.child.recordServedModelStream(
    normalizedRequest,
    state.redactor.vault.restore(event.stream ?? []),
    state.redactor.vault.restore(event.response),
    event.error ? state.redactor.vault.restore(event.error) : undefined,
    site,
    provenance,
    event.callSite,
    boundary
  );
}

async function forkStoredToolEvent<TTools extends ToolHandlers>(state: ForkContextState<TTools>, event: ToolCallEvent): Promise<void> {
  const policy = state.opts.tools?.onMatch ?? "serve-recorded";
  void policy;
  const args = deserializeToolValue(
    state.replay.opts.toolSerializers,
    event.name,
    "args",
    state.redactor.vault.restore(event.args)
  );
  if (event.error) {
    state.child.recordServedToolError(event.name, args, event.argsHash, event.error, "recorded", boundaryFromEvent(event));
    return;
  }
  if (event.stream) {
    const chunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
      ...chunk,
      data: deserializeToolValue(state.replay.opts.toolSerializers, event.name, "streamChunk", chunk.data)
    }));
    await consumeAsyncIterable(state.child.recordServedToolStream(event.name, args, chunks, event.argsHash, "recorded", boundaryFromEvent(event)));
    return;
  }
  const result = deserializeToolValue(
    state.replay.opts.toolSerializers,
    event.name,
    "result",
    state.redactor.vault.restore(event.result)
  );
  state.child.recordServedToolResult(event.name, args, result, event.argsHash, "recorded", boundaryFromEvent(event));
}

async function consumeAsyncIterable(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Fully consume streams so RecordSession can persist the assembled event.
  }
}

function valueFromModelEvent(event: ModelCallEvent, redactor: Redactor): unknown {
  if (event.error) {
    const restoredError = redactor.vault.restore(event.error);
    throw new RewindError(restoredError.message, restoredError.data);
  }
  const restored = redactor.vault.restore(event.response);
  return restored?.raw ?? restored;
}

async function* finalizeStream(stream: AsyncIterable<unknown>, finish: () => void): AsyncIterable<unknown> {
  try {
    for await (const chunk of stream) {
      yield chunk;
    }
  } finally {
    finish();
  }
}

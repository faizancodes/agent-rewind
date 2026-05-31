import { dirname } from "node:path";
import type { ForkOverrides, ProviderCodec } from "./codec.js";
import type {
  EventProvenance,
  ModelCallEvent,
  NormalizedRequest,
  RewindEvent,
  ToolCallEvent,
  Usage
} from "./events.js";
import type { AgentContext, Harness, ToolHandlers, UntypedToolHandlers, WrappedModel, WrappedTools } from "./record.js";
import type { EntropyRuntime } from "./entropy.js";
import { RecordSession } from "./record.js";
import type { ReplaySession } from "./replay.js";
import { deriveCallSite, LaneManager } from "./context.js";
import { EntropyReplay } from "./entropy.js";
import { fingerprint, fingerprintUnknown } from "./fingerprint.js";
import { PendingStore } from "./matcher.js";
import { patternsFromLabels, Redactor } from "./redaction.js";
import { deserializeToolValue, serializeToolValue } from "./tool-serialization.js";
import { DriftError, RewindError } from "./errors.js";
import { usageAdd } from "./tokens.js";

export interface ForkOptions<TTools extends ToolHandlers = UntypedToolHandlers> {
  /** Boundary step where live tail execution begins. */
  atStep: number;
  /** Harness to execute for this fork. Defaults to the last harness passed to `replay.run()`, then to a stored-event tail walk. */
  harness?: Harness<unknown, TTools>;
  /** Live model client for tail model calls. Falls back to replay options when present. */
  model?: unknown;
  /** Prompt/model/request changes for live tail model calls. */
  overrides?: ForkOverrides;
  /** Tool handling policy for tail calls. Defaults to serving recorded hits and erroring on misses. */
  tools?: { onMatch?: "serve-recorded" | "live"; onMiss?: "error" | "stub" | "simulate" | "live" };
  /** Optional success predicate evaluated against the resulting trace. */
  goal?: (trace: Trace) => boolean;
  /** Reserved gate for future live/sandboxed tool policies. */
  sandbox?: Sandbox;
  /** Injectable entropy runtime for deterministic fork tests. */
  runtime?: Partial<EntropyRuntime>;
}

export interface ForkResult {
  /** Child recording session id. */
  sessionId: string;
  /** Result of the optional goal predicate. */
  reachedGoal?: boolean;
  /** Token usage spent by live tail model calls. */
  tokensSpent: Usage;
  /** Step where fork halted because of tail divergence. */
  divergedAtStep?: number;
  /** Combined prefix/tail trace. */
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

export async function forkReplay<TTools extends ToolHandlers = UntypedToolHandlers>(
  replay: ReplaySession<TTools>,
  opts: ForkOptions<TTools>
): Promise<ForkResult> {
  const codec = replay.requireCodec("fork");
  const liveModel = opts.model ?? replay.opts.model;
  const child = new RecordSession<TTools>({
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
  const traceEvents: RewindEvent[] = [];
  let tokensSpent: Usage = { inputTokens: 0, outputTokens: 0 };
  let divergedAtStep: number | undefined;

  const state: ForkContextState<TTools> = {
    replay,
    opts,
    child,
    matcher,
    entropy,
    redactor,
    lanes,
    traceEvents,
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
      await lanes.run(() => harness(context));
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
  const trace = new ForkTrace([...traceEvents, ...child.events()]);
  return {
    sessionId: child.id,
    reachedGoal: opts.goal ? opts.goal(trace) : undefined,
    tokensSpent,
    divergedAtStep,
    trace
  };
}

interface ForkContextState<TTools extends ToolHandlers = UntypedToolHandlers> {
  replay: ReplaySession<TTools>;
  opts: ForkOptions<TTools>;
  child: RecordSession<TTools>;
  matcher: PendingStore;
  entropy: EntropyReplay;
  redactor: Redactor;
  lanes: LaneManager;
  traceEvents: RewindEvent[];
  liveModel: unknown;
  codec: ProviderCodec;
  addUsage(usage: Usage | undefined): void;
}

function forkContext<TTools extends ToolHandlers>(state: ForkContextState<TTools>): AgentContext<TTools> {
  return {
    model: forkModel(state),
    tools: forkTools(state),
    clock: () => forkEntropy(state, "clock") as number,
    random: () => forkEntropy(state, "random") as number,
    uuid: () => forkEntropy(state, "uuid") as string,
    env: (key) => process.env[key],
    note: (text) => state.child.note(text)
  } as AgentContext<TTools>;
}

function forkModel<TTools extends ToolHandlers>(state: ForkContextState<TTools>): WrappedModel {
  return {
    create: async <T = unknown>(rawRequest: unknown, callOpts?: { site?: string }) => {
      const normalized = state.codec.normalizeRequest(rawRequest);
      const requestHash = fingerprint(normalized, state.codec, state.redactor, state.replay.stored.meta.fingerprintMode);
      const lane = state.lanes.beginBoundaryLane(callOpts?.site ? `model_call\u0000${callOpts.site}` : undefined);
      const callSite = deriveCallSite(callOpts?.site, "model_call", lane, 0);
      const expectedStep = nextUnconsumedBoundaryStep(state);
      const resolution = state.matcher.resolve(requestHash, {
        kind: "model_call",
        callSite,
        lane
      });
      try {
        if ("hit" in resolution) {
          assertNoSkippedPrefixBoundary(state, expectedStep, resolution.hit.step);
        }
        if ("hit" in resolution && resolution.hit.step < state.opts.atStep) {
          const event = markProvenance(resolution.hit, "recorded");
          state.traceEvents.push(event);
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
        const raw = state.codec.denormalizeRequest(overridden);
        const before = state.child.events().length;
        const live = await state.child.recordLiveModel(raw, state.liveModel, callOpts?.site, "live");
        const recorded = state.child.events().slice(before).filter((event): event is ModelCallEvent => event.kind === "model_call").at(-1);
        state.addUsage(recorded?.usage ?? recorded?.response?.usage);
        return live as T;
      } finally {
        state.lanes.endBoundaryLane(lane);
      }
    },
    stream: <T = unknown>(rawRequest: unknown, callOpts?: { site?: string }) => {
      const normalized = state.codec.normalizeRequest(rawRequest);
      const requestHash = fingerprint(normalized, state.codec, state.redactor, state.replay.stored.meta.fingerprintMode);
      const lane = state.lanes.beginBoundaryLane(callOpts?.site ? `model_call\u0000${callOpts.site}` : undefined);
      const expectedStep = nextUnconsumedBoundaryStep(state);
      const resolution = state.matcher.resolve(requestHash, {
        kind: "model_call",
        callSite: deriveCallSite(callOpts?.site, "model_call", lane, 0),
        lane
      });
      try {
        if ("hit" in resolution) {
          assertNoSkippedPrefixBoundary(state, expectedStep, resolution.hit.step);
        }
        if ("hit" in resolution && resolution.hit.step < state.opts.atStep) {
          const event = markProvenance(resolution.hit, "recorded") as ModelCallEvent;
          state.traceEvents.push(event);
          return finalizeStream(state.codec.rebuildStream(state.redactor.vault.restore(event.stream ?? [])), () =>
            state.lanes.endBoundaryLane(lane)
          ) as AsyncIterable<T>;
        }
        if (!("hit" in resolution) && expectedStep !== undefined && expectedStep < state.opts.atStep) {
          throw new ForkDiverged(expectedStep);
        }
        if (!state.liveModel) {
          throw new DriftError("Fork tail model streams require a live model client", { atStep: state.opts.atStep });
        }
        const step = "hit" in resolution ? resolution.hit.step : state.opts.atStep;
        const overridden = state.codec.applyOverrides(normalized, state.opts.overrides ?? {}, step);
        const raw = state.codec.denormalizeRequest(overridden);
        const before = state.child.events().length;
        return finalizeStream(state.child.recordLiveModelStream(raw, state.liveModel, callOpts?.site, "live"), () => {
          const recorded = state.child.events().slice(before).filter((event): event is ModelCallEvent => event.kind === "model_call").at(-1);
          state.addUsage(recorded?.usage ?? recorded?.response?.usage);
          state.lanes.endBoundaryLane(lane);
        }) as AsyncIterable<T>;
      } catch (error) {
        state.lanes.endBoundaryLane(lane);
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
  const lane = state.lanes.beginBoundaryLane(`tool_call\u0000${name}`);
  try {
    const serializedArgs = serializeToolValue(state.replay.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
    const argsHash = fingerprintUnknown(serializedArgs, state.redactor);
    const expectedStep = nextUnconsumedBoundaryStep(state);
    const resolution = state.matcher.resolve(argsHash, {
      kind: "tool_call",
      callSite: deriveCallSite(name, "tool_call", lane, 0),
      lane,
      name
    });
    if ("hit" in resolution) {
      const event = markProvenance(resolution.hit, "recorded") as ToolCallEvent;
      assertNoSkippedPrefixBoundary(state, expectedStep, event.step);
      if (event.step < state.opts.atStep) {
        state.traceEvents.push(event);
        if (event.error) {
          const restoredError = state.redactor.vault.restore(event.error);
          return Promise.reject(new RewindError(restoredError.message, restoredError.data)).finally(() => state.lanes.endBoundaryLane(lane));
        }
        if (event.stream) {
          const restoredChunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
            ...chunk,
            data: deserializeToolValue(state.replay.opts.toolSerializers, name, "streamChunk", chunk.data)
          }));
          return finalizeStream(replayToolStream(restoredChunks), () => state.lanes.endBoundaryLane(lane));
        }
        const restoredResult = state.redactor.vault.restore(event.result);
        return Promise.resolve(deserializeToolValue(state.replay.opts.toolSerializers, name, "result", restoredResult)).finally(() =>
          state.lanes.endBoundaryLane(lane)
        );
      }

      const policy = state.opts.tools?.onMatch ?? "serve-recorded";
      if (policy === "live") {
        throw new RewindError("Fork onMatch='live' is not implemented in the MVP", { name });
      }
      if (event.error) {
        const restoredError = state.redactor.vault.restore(event.error);
        state.child.recordServedToolError(name, args, argsHash, event.error, "recorded");
        return Promise.reject(new RewindError(restoredError.message, restoredError.data)).finally(() => state.lanes.endBoundaryLane(lane));
      }
      if (event.stream) {
        const restoredChunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
          ...chunk,
          data: deserializeToolValue(state.replay.opts.toolSerializers, name, "streamChunk", chunk.data)
        }));
        return finalizeStream(state.child.recordServedToolStream(name, args, restoredChunks, argsHash, "recorded"), () =>
          state.lanes.endBoundaryLane(lane)
        );
      }
      const restoredResult = state.redactor.vault.restore(event.result);
      const result = deserializeToolValue(state.replay.opts.toolSerializers, name, "result", restoredResult);
      state.child.recordServedToolResult(name, args, result, argsHash, "recorded");
      return Promise.resolve(result).finally(() => state.lanes.endBoundaryLane(lane));
    }

    if (expectedStep !== undefined && expectedStep < state.opts.atStep) {
      throw new ForkDiverged(expectedStep);
    }
    const onMiss = state.opts.tools?.onMiss ?? "error";
    if (onMiss === "stub") {
      const result = { __agentrewind_unavailable: true };
      state.child.recordStubTool(name, args, result, argsHash);
      return Promise.resolve(result).finally(() => state.lanes.endBoundaryLane(lane));
    }
    if (onMiss === "simulate" || onMiss === "live") {
      throw new RewindError(`Fork onMiss='${onMiss}' is not implemented in the MVP`, { name });
    }
    throw new ForkDiverged(state.opts.atStep);
  } catch (error) {
    state.lanes.endBoundaryLane(lane);
    throw error;
  }
}

function forkEntropy<TTools extends ToolHandlers>(state: ForkContextState<TTools>, source: "clock" | "random" | "uuid"): number | string {
  const lane = state.lanes.beginBoundaryLane(`entropy\u0000${source}`);
  try {
    const expectedStep = nextUnconsumedBoundaryStep(state);
    const recorded = state.entropy.peek(source, lane);
    if (recorded && recorded.step < state.opts.atStep) {
      if (expectedStep !== undefined && expectedStep < recorded.step && expectedStep < state.opts.atStep) {
        throw new ForkDiverged(expectedStep);
      }
      const event = state.entropy.nextEvent(source, lane, "strict");
      state.traceEvents.push(markProvenance(event, "recorded"));
      return event.value;
    }
    if (expectedStep !== undefined && expectedStep < state.opts.atStep) {
      throw new ForkDiverged(expectedStep);
    }
    return state.child.recordLiveEntropy(source, "live");
  } finally {
    state.lanes.endBoundaryLane(lane);
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
      if (event.kind === "model_call" || event.kind === "tool_call" || event.kind === "entropy") {
        state.traceEvents.push(markProvenance(event, "recorded"));
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
      state.child.recordLiveEntropy(event.source, "live");
      continue;
    }
    if (event.kind === "note") {
      state.child.note(state.redactor.vault.restore(event.text));
    }
  }
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
    await consumeAsyncIterable(state.child.recordLiveModelStream(raw, state.liveModel, undefined, "live"));
  } else {
    await state.child.recordLiveModel(raw, state.liveModel, undefined, "live");
  }
  const recorded = state.child.events().slice(before).filter((candidate): candidate is ModelCallEvent => candidate.kind === "model_call").at(-1);
  state.addUsage(recorded?.usage ?? recorded?.response?.usage);
}

async function forkStoredToolEvent<TTools extends ToolHandlers>(state: ForkContextState<TTools>, event: ToolCallEvent): Promise<void> {
  const policy = state.opts.tools?.onMatch ?? "serve-recorded";
  if (policy === "live") {
    throw new RewindError("Fork onMatch='live' is not implemented in the MVP", { name: event.name });
  }
  const args = deserializeToolValue(
    state.replay.opts.toolSerializers,
    event.name,
    "args",
    state.redactor.vault.restore(event.args)
  );
  if (event.error) {
    state.child.recordServedToolError(event.name, args, event.argsHash, event.error, "recorded");
    return;
  }
  if (event.stream) {
    const chunks = state.redactor.vault.restore(event.stream).map((chunk) => ({
      ...chunk,
      data: deserializeToolValue(state.replay.opts.toolSerializers, event.name, "streamChunk", chunk.data)
    }));
    await consumeAsyncIterable(state.child.recordServedToolStream(event.name, args, chunks, event.argsHash, "recorded"));
    return;
  }
  const result = deserializeToolValue(
    state.replay.opts.toolSerializers,
    event.name,
    "result",
    state.redactor.vault.restore(event.result)
  );
  state.child.recordServedToolResult(event.name, args, result, event.argsHash, "recorded");
}

async function consumeAsyncIterable(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Fully consume streams so RecordSession can persist the assembled event.
  }
}

function markProvenance(event: RewindEvent, provenance: EventProvenance): RewindEvent {
  if (event.kind === "model_call" || event.kind === "tool_call" || event.kind === "entropy") {
    return { ...event, provenance };
  }
  return event;
}

function valueFromModelEvent(event: ModelCallEvent, redactor: Redactor): unknown {
  if (event.error) {
    const restoredError = redactor.vault.restore(event.error);
    throw new RewindError(restoredError.message, restoredError.data);
  }
  const restored = redactor.vault.restore(event.response);
  return restored?.raw ?? restored;
}

async function* replayToolStream(chunks: { data: unknown }[]): AsyncIterable<unknown> {
  for (const chunk of chunks) {
    yield chunk.data;
  }
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

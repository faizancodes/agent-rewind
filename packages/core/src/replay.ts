import type { ProviderCodec } from "./codec.js";
import type {
  EntropyEvent,
  ModelCallEvent,
  NormalizedMessage,
  RewindEvent,
  ToolCallEvent
} from "./events.js";
import type { AgentContext, Harness, ToolHandlers, UntypedToolHandlers, WrappedModel, WrappedTools } from "./record.js";
import { deriveCallSite, LaneManager } from "./context.js";
import { defaultEntropyRuntime, EntropyReplay, type EntropyRuntime } from "./entropy.js";
import { ConfigurationError, DriftError, RewindError } from "./errors.js";
import { fingerprint, fingerprintUnknown } from "./fingerprint.js";
import { PendingStore } from "./matcher.js";
import { readSession, resolveSessionPath, type SessionSelectorOptions, type StoredSession } from "./session-store.js";
import { patternsFromLabels, Redactor } from "./redaction.js";
import { deserializeToolValue, serializeToolValue, type ToolSerializers } from "./tool-serialization.js";
import { diffMessages, type ContextDiff } from "./tokens.js";
import { invokeClient, isAsyncIterable, selectInterceptPoint } from "./record.js";
import { forkReplay, type ForkOptions, type ForkResult } from "./fork.js";
import { searchReplay, type TrajectorySearchOptions, type TrajectorySearchResult } from "./search.js";

type CallableToolHandler = (args: unknown) => unknown | Promise<unknown> | AsyncIterable<unknown>;

export interface ReplayOptions<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> extends SessionSelectorOptions {
  /** Live model client used only for passthrough replay or fork live tails. */
  model?: unknown;
  /** Live tool handlers used only for passthrough replay. */
  tools?: TTools;
  /** Provider codec that matches the recorded session's model provider. Required for `run()` model calls and `fork()`. */
  codec?: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  /** Drift behavior. Defaults to `strict`. */
  driftPolicy?: "strict" | "warn" | "passthrough";
  /** Re-emit stream chunks using recorded offsets. Defaults to false. */
  preserveTiming?: boolean;
  /** Per-tool serializers matching those used during recording. */
  toolSerializers?: ToolSerializers;
  /** Injectable entropy runtime for passthrough replay tests. */
  runtime?: Partial<EntropyRuntime>;
}

export type ReplayRunOptions<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = ReplayOptions<TTools, TRequest, TResponse, TStreamChunk> & {
  /** Provider codec required when running a replay harness. */
  codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
};

/** Loaded replay session. */
export interface Replay<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Run a harness and serve recorded boundary outputs. */
  run<T>(harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<T>;
  /** Return migrated session events in recorded order. */
  events(): RewindEvent[];
  /** Move the inspection cursor to a boundary step. */
  stepTo(n: number): void;
  /** Return the model request messages at a model-call step. */
  contextAt(n: number): NormalizedMessage[];
  /** Diff model request messages between two model-call steps. */
  diffContext(a: number, b: number): ContextDiff;
  /** Replay the prefix and execute the tail as a child recording. */
  fork(opts: ForkOptions<TTools, TRequest, TResponse, TStreamChunk>): Promise<ForkResult>;
  /** Run trajectory-search fork rollouts from a recorded boundary. */
  search<TResult = unknown>(opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>): Promise<TrajectorySearchResult<TResult>>;
}

export class ReplaySession<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> implements Replay<TTools, TRequest, TResponse, TStreamChunk> {
  private matcher: PendingStore;
  private entropy: EntropyReplay;
  private lanes = new LaneManager();
  private readonly redactor: Redactor;
  private readonly runtime: EntropyRuntime;
  private readonly callOrdinals = new Map<string, number>();
  private cursor = 0;
  private passthroughDiverged = false;
  lastHarness: Harness<unknown, TTools, TRequest, TResponse, TStreamChunk> | undefined;
  readonly id: string;

  private constructor(readonly stored: StoredSession, readonly opts: ReplayOptions<TTools, TRequest, TResponse, TStreamChunk>) {
    this.id = stored.meta.id;
    this.matcher = new PendingStore(stored.events);
    this.entropy = new EntropyReplay(stored.events);
    this.redactor = new Redactor(
      { enabled: stored.meta.redaction.enabled, patterns: patternsFromLabels(stored.meta.redaction.patterns), useOnlyPatterns: true },
      stored.vault
    );
    this.runtime = { ...defaultEntropyRuntime, ...opts.runtime };
  }

  static async load<
    TTools extends ToolHandlers = UntypedToolHandlers,
    TRequest = unknown,
    TResponse = unknown,
    TStreamChunk = unknown
  >(
    sessionPath: string,
    opts: ReplayOptions<TTools, TRequest, TResponse, TStreamChunk> = {} as ReplayOptions<TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<ReplaySession<TTools, TRequest, TResponse, TStreamChunk>> {
    return new ReplaySession(await readSession(await resolveSessionPath(sessionPath, opts)), opts);
  }

  async run<T>(harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<T> {
    this.resetRunState();
    this.lastHarness = harness as Harness<unknown, TTools, TRequest, TResponse, TStreamChunk>;
    const result = await this.lanes.run(() => harness(this.context()));
    if (!this.passthroughDiverged) {
      this.assertTrajectoryComplete();
    }
    return result;
  }

  events(): RewindEvent[] {
    return [...this.stored.events];
  }

  stepTo(n: number): void {
    this.cursor = n;
  }

  contextAt(n: number): NormalizedMessage[] {
    const event = this.eventAt(n);
    if (event.kind !== "model_call") {
      throw new RangeError(`Step ${n} is not a model call`);
    }
    return event.request.messages;
  }

  diffContext(a: number, b: number): ContextDiff {
    const left = this.eventAt(a);
    const right = this.eventAt(b);
    if (left.kind !== "model_call" || right.kind !== "model_call") {
      throw new RangeError("Both steps must be model calls");
    }
    return diffMessages(left, right);
  }

  fork(opts: ForkOptions<TTools, TRequest, TResponse, TStreamChunk>): Promise<ForkResult> {
    return forkReplay(this, opts);
  }

  search<TResult = unknown>(
    opts: TrajectorySearchOptions<TResult, TTools, TRequest, TResponse, TStreamChunk>
  ): Promise<TrajectorySearchResult<TResult>> {
    return searchReplay(this, opts);
  }

  requireCodec(operation: string): ProviderCodec<TRequest, TResponse, TStreamChunk> {
    if (!this.opts.codec) {
      throw new ConfigurationError(`Provider codec is required for replay ${operation}`, {
        missing: "codec",
        operation,
        provider: this.stored.meta.provider,
        expected: "Pass the same codec used for recording, for example AgentRewind.replay(sessionPath, { codec })."
      });
    }
    return this.opts.codec;
  }

  private context(): AgentContext<TTools, TRequest, TResponse, TStreamChunk> {
    return {
      model: this.replayModel(),
      tools: this.replayTools(this.opts.tools ?? {}),
      clock: () => this.replayEntropy("clock") as number,
      random: () => this.replayEntropy("random") as number,
      uuid: () => this.replayEntropy("uuid") as string,
      env: (key: string) => {
        const value = this.replayEntropy("env", key);
        return value === null ? undefined : String(value);
      },
      note: () => undefined
    } as unknown as AgentContext<TTools, TRequest, TResponse, TStreamChunk>;
  }

  private replayModel(): WrappedModel<TRequest, TResponse, TStreamChunk> {
    return {
      create: <T = TResponse>(req: TRequest, opts?: { site?: string }) => this.replayModelCreate(req, opts?.site) as Promise<T>,
      stream: <T = TStreamChunk>(req: TRequest, opts?: { site?: string }) => this.replayModelStream(req, opts?.site) as AsyncIterable<T>
    };
  }

  private replayTools<TReplayTools extends ToolHandlers>(_handlers: TReplayTools): WrappedTools<TReplayTools> {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property !== "string") {
            return undefined;
          }
          return (args: unknown) => this.replayToolCall(property, args);
        }
      }
    ) as WrappedTools<TReplayTools>;
  }

  private replayModelCreate(rawRequest: TRequest, site: string | undefined): Promise<unknown> {
    const codec = this.requireCodec("model calls");
    const boundary = this.beginReplayBoundary("model_call", site);
    const normalized = codec.normalizeRequest(rawRequest);
    const requestHash = fingerprint(normalized, codec, this.redactor, this.stored.meta.fingerprintMode);
    const expectedStep = this.nextUnconsumedBoundaryStep();
    const resolution = this.matcher.resolve(requestHash, {
      kind: "model_call",
      callSite: boundary.callSite,
      lane: boundary.lane
    });
    return this.lanes.withLane(boundary.lane, () => {
      try {
        if ("hit" in resolution) {
          this.assertBoundaryOrder(resolution.hit, expectedStep);
          return Promise.resolve(this.valueFromModelEvent(resolution.hit as ModelCallEvent)).finally(boundary.finish);
        }
        return this.handleModelMiss(rawRequest, requestHash, site, boundary.callSite, expectedStep, false).finally(boundary.finish);
      } catch (error) {
        boundary.finish();
        return Promise.reject(error);
      }
    });
  }

  private replayModelStream(rawRequest: TRequest, site: string | undefined): AsyncIterable<unknown> {
    const codec = this.requireCodec("model streams");
    const boundary = this.beginReplayBoundary("model_call", site);
    const normalized = codec.normalizeRequest(rawRequest);
    const requestHash = fingerprint(normalized, codec, this.redactor, this.stored.meta.fingerprintMode);
    const matchCtx = {
      kind: "model_call",
      callSite: boundary.callSite,
      lane: boundary.lane
    } as const;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          const expectedStep = self.nextUnconsumedBoundaryStep();
          const resolution = self.matcher.resolve(requestHash, matchCtx);
          if ("hit" in resolution) {
            const event = resolution.hit as ModelCallEvent;
            self.assertBoundaryOrder(event, expectedStep);
            const chunks = self.redactor.vault.restore(event.stream ?? []);
            const terminalError = event.error ? deserializeRecordedError(self.redactor.vault.restore(event.error)) : undefined;
            if (event.error && event.stream === undefined) {
              throw terminalError;
            }
            yield* replayRecordedStream(
              timingStream(codec.rebuildStream(chunks), self.opts.preserveTiming ? chunks : undefined),
              chunks.length,
              terminalError,
              () => prematureStreamCloseError(event, chunks.length)
            );
            return;
          }
          const live = self.handleModelMiss(rawRequest, requestHash, site, boundary.callSite, expectedStep, true);
          yield* promiseToAsyncIterable(live);
        } finally {
          boundary.finish();
        }
      }
    };
  }

  private replayToolCall(name: string, args: unknown): Promise<unknown> | AsyncIterable<unknown> {
    const boundary = this.beginReplayBoundary("tool_call", name);
    try {
      const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
      const argsHash = fingerprintUnknown(serializedArgs, this.redactor);
      const matchCtx = {
        kind: "tool_call",
        callSite: boundary.callSite,
        lane: boundary.lane,
        name
      } as const;
      const peek = this.matcher.peek(argsHash, matchCtx);
      if ("hit" in peek && (peek.hit as ToolCallEvent).stream) {
        return this.replayRecordedToolStream(name, argsHash, matchCtx, boundary);
      }
      const expectedStep = this.nextUnconsumedBoundaryStep();
      const resolution = this.matcher.resolve(argsHash, matchCtx);
      return this.lanes.withLane(boundary.lane, () => {
        try {
          if ("hit" in resolution) {
            const event = resolution.hit as ToolCallEvent;
            this.assertBoundaryOrder(event, expectedStep);
            if (event.error) {
              return Promise.reject(deserializeRecordedError(this.redactor.vault.restore(event.error))).finally(boundary.finish);
            }
            const restoredResult = this.redactor.vault.restore(event.result);
            return Promise.resolve(deserializeToolValue(this.opts.toolSerializers, name, "result", restoredResult)).finally(boundary.finish);
          }
          const error = new DriftError("Tool call drifted from recording", {
            step: this.matcher.nextUnconsumedStep(),
            expected: this.boundarySummaryAt(expectedStep),
            actual: {
              kind: "tool_call",
              callSite: boundary.callSite,
              lane: boundary.lane,
              name,
              argsHash
            },
            name,
            actualFingerprint: argsHash
          });
          if (this.opts.driftPolicy === "warn") {
            console.warn(error.message, error.data);
          }
          if (this.opts.driftPolicy === "passthrough") {
            const handler = this.opts.tools?.[name];
            if (!handler) {
              return Promise.reject(new DriftError("Passthrough replay requires a live tool handler", error.data)).finally(boundary.finish);
            }
            this.passthroughDiverged = true;
            const live = (handler as CallableToolHandler)(args);
            if (isAsyncIterable(live)) {
              return finalizeStream(live, boundary.finish);
            }
            return Promise.resolve(live).finally(boundary.finish);
          }
          return Promise.reject(error).finally(boundary.finish);
        } catch (error) {
          boundary.finish();
          throw error;
        }
      });
    } catch (error) {
      boundary.finish();
      throw error;
    }
  }

  private replayRecordedToolStream(
    name: string,
    argsHash: string,
    matchCtx: { kind: "tool_call"; callSite: string; lane: string; name: string },
    boundary: { lane: string; callSite: string; finish: () => void }
  ): AsyncIterable<unknown> {
    const self = this;
    return this.lanes.withLane(boundary.lane, () => ({
      async *[Symbol.asyncIterator]() {
        try {
          const expectedStep = self.nextUnconsumedBoundaryStep();
          const resolution = self.matcher.resolve(argsHash, matchCtx);
          if (!("hit" in resolution)) {
            throw new DriftError("Tool stream drifted from recording", {
              step: expectedStep,
              expected: self.boundarySummaryAt(expectedStep),
              actual: {
                kind: "tool_call",
                callSite: boundary.callSite,
                lane: boundary.lane,
                name,
                argsHash,
                streamed: true
              },
              name,
              actualFingerprint: argsHash
            });
          }
          const event = resolution.hit as ToolCallEvent;
          self.assertBoundaryOrder(event, expectedStep);
          const restoredChunks = self.redactor.vault.restore(event.stream ?? []).map((chunk) => ({
            ...chunk,
            data: deserializeToolValue(self.opts.toolSerializers, name, "streamChunk", chunk.data)
          }));
          const terminalError = event.error ? deserializeRecordedError(self.redactor.vault.restore(event.error)) : undefined;
          yield* replayRecordedStream(
            replayToolStream(restoredChunks, self.opts.preserveTiming),
            restoredChunks.length,
            terminalError,
            () => prematureStreamCloseError(event, restoredChunks.length)
          );
        } finally {
          boundary.finish();
        }
      }
    }));
  }

  private replayEntropy(source: Exclude<EntropyEvent["source"], "env">): number | string;
  private replayEntropy(source: "env", key: string): string | null;
  private replayEntropy(source: EntropyEvent["source"], key?: string): number | string | null {
    const explicit = source === "env" && key ? `env:${key}` : source;
    const boundary = this.beginReplayBoundary("entropy", explicit);
    try {
      const policy = this.opts.driftPolicy ?? "strict";
      try {
        const expectedStep = this.nextUnconsumedBoundaryStep();
        const event = this.entropy.nextEvent(source, boundary.lane, policy, key);
        this.assertBoundaryOrder(event, expectedStep);
        return event.value;
      } catch (error) {
        if (policy !== "passthrough" || !(error instanceof DriftError)) {
          if (error instanceof DriftError && error.message === "Missing recorded entropy event") {
            throw new DriftError("Entropy drifted from recording", {
              step: this.nextUnconsumedBoundaryStep(),
              expected: this.boundarySummaryAt(this.nextUnconsumedBoundaryStep()),
              actual: {
                kind: "entropy",
                callSite: boundary.callSite,
                lane: boundary.lane,
                source,
                ...(key ? { key } : {})
              },
              source,
              ...(key ? { key } : {})
            });
          }
          throw error;
        }
        this.passthroughDiverged = true;
        return source === "env" ? (process.env[key ?? ""] ?? null) : this.liveEntropy(source);
      }
    } finally {
      boundary.finish();
    }
  }

  private liveEntropy(source: Exclude<EntropyEvent["source"], "env">): number | string {
    if (source === "clock") {
      return this.runtime.now();
    }
    if (source === "random") {
      return this.runtime.random();
    }
    return this.runtime.uuid();
  }

  private async handleModelMiss(
    rawRequest: unknown,
    actualFingerprint: string,
    site: string | undefined,
    callSite: string,
    expectedStep: number | undefined,
    stream: boolean
  ): Promise<unknown> {
    const policy = this.opts.driftPolicy ?? "strict";
    const error = new DriftError("Model call drifted from recording", {
      step: expectedStep ?? this.cursor,
      expected: this.boundarySummaryAt(expectedStep),
      actual: {
        kind: "model_call",
        callSite,
        site,
        requestHash: actualFingerprint,
        streamed: stream
      },
      actualFingerprint
    });
    if (policy === "warn") {
      console.warn(error.message, error.data);
      throw error;
    }
    if (policy !== "passthrough") {
      throw error;
    }
    if (!this.opts.model) {
      throw new DriftError("Passthrough replay requires a live model client", error.data);
    }
    const codec = this.requireCodec("passthrough model calls");
    this.passthroughDiverged = true;
    return invokeClient(this.opts.model, selectInterceptPoint(codec, stream ? "stream" : "create"), rawRequest, codec);
  }

  private valueFromModelEvent(event: ModelCallEvent): unknown {
    if (event.error) {
      throw deserializeRecordedError(this.redactor.vault.restore(event.error));
    }
    const restored = this.redactor.vault.restore(event.response);
    return restored?.raw ?? restored;
  }

  private eventAt(step: number): RewindEvent {
    const event = this.stored.events.find((candidate) => candidate.step === step);
    if (!event) {
      throw new RangeError(`No event at step ${step}`);
    }
    return event;
  }

  private beginReplayBoundary(kind: "model_call" | "tool_call" | "entropy", explicit: string | undefined): { lane: string; callSite: string; finish: () => void } {
    const lane = this.lanes.beginBoundaryLane(explicit ? `${kind}\u0000${explicit}` : undefined);
    const key = `${kind}\u0000${lane}`;
    const ordinal = this.callOrdinals.get(key) ?? 0;
    this.callOrdinals.set(key, ordinal + 1);
    let finished = false;
    return {
      lane,
      callSite: kind === "entropy" ? `${explicit ?? "entropy"}:${ordinal}:${explicit ?? "entropy"}` : deriveCallSite(explicit, kind, lane, ordinal),
      finish: () => {
        if (!finished) {
          finished = true;
          this.lanes.endBoundaryLane(lane);
        }
      }
    };
  }

  private resetRunState(): void {
    this.matcher = new PendingStore(this.stored.events);
    this.entropy = new EntropyReplay(this.stored.events);
    this.lanes = new LaneManager();
    this.callOrdinals.clear();
    this.passthroughDiverged = false;
  }

  private nextUnconsumedBoundaryStep(): number | undefined {
    const steps = [this.matcher.nextUnconsumedStep(), this.entropy.nextUnconsumedStep()].filter(
      (step): step is number => step !== undefined
    );
    return steps.length > 0 ? Math.min(...steps) : undefined;
  }

  private assertBoundaryOrder(event: ModelCallEvent | ToolCallEvent | EntropyEvent, expectedStep: number | undefined): void {
    if (expectedStep === undefined || event.step === expectedStep) {
      return;
    }
    const error = new DriftError("Replay consumed a recorded boundary out of order", {
      expectedStep,
      actualStep: event.step,
      expected: this.boundarySummaryAt(expectedStep),
      actual: this.boundarySummary(event)
    });
    const policy = this.opts.driftPolicy ?? "strict";
    if (policy === "warn") {
      console.warn(error.message, error.data);
    }
    if (policy === "passthrough") {
      this.passthroughDiverged = true;
      return;
    }
    throw error;
  }

  private assertTrajectoryComplete(): void {
    const remaining = [...this.matcher.remaining(), ...this.entropy.remaining()].sort((a, b) => a.step - b.step);
    if (remaining.length > 0) {
      const next = remaining[0];
      throw new DriftError("Replay ended before consuming the recorded boundary-event trajectory", {
        step: next?.step,
        remaining: remaining.map((event) => this.boundarySummary(event))
      });
    }
  }

  private boundarySummaryAt(step: number | undefined): BoundarySummary | undefined {
    if (step === undefined) {
      return undefined;
    }
    const event = this.stored.events.find((candidate): candidate is BoundaryEvent => isReplayBoundary(candidate) && candidate.step === step);
    return event ? this.boundarySummary(event) : undefined;
  }

  private boundarySummary(event: BoundaryEvent): BoundarySummary {
    const base = {
      kind: event.kind,
      step: event.step,
      lane: event.lane,
      seq: event.seq,
      callSite: event.callSite
    };
    if (event.kind === "model_call") {
      return {
        ...base,
        model: event.request.model,
        messages: event.request.messages.length,
        requestHash: event.requestHash,
        streamed: Boolean(event.stream)
      };
    }
    if (event.kind === "tool_call") {
      return {
        ...base,
        name: event.name,
        argsHash: event.argsHash,
        streamed: Boolean(event.stream)
      };
    }
    return {
      ...base,
      source: event.source
    };
  }
}

type BoundaryEvent = ModelCallEvent | ToolCallEvent | EntropyEvent;

interface BoundarySummary {
  kind: BoundaryEvent["kind"];
  step: number;
  lane: string;
  seq: number;
  callSite: string;
  model?: string;
  messages?: number;
  requestHash?: string;
  streamed?: boolean;
  name?: string;
  argsHash?: string;
  source?: EntropyEvent["source"];
}

function isReplayBoundary(event: RewindEvent): event is BoundaryEvent {
  return event.kind === "model_call" || event.kind === "tool_call" || event.kind === "entropy";
}

function deserializeRecordedError(error: { name: string; message: string; stack?: string; data?: unknown }): Error {
  const out = new RewindError(error.message, error.data);
  out.name = error.name;
  out.stack = error.stack;
  return out;
}

async function* replayToolStream(chunks: { offsetMs: number; data: unknown }[], preserveTiming?: boolean): AsyncIterable<unknown> {
  let previous = 0;
  for (const chunk of chunks) {
    if (preserveTiming) {
      await delay(Math.max(0, chunk.offsetMs - previous));
      previous = chunk.offsetMs;
    }
    yield chunk.data;
  }
}

async function* replayRecordedStream(
  stream: AsyncIterable<unknown>,
  expectedChunks: number,
  terminalError: Error | undefined,
  prematureCloseError: () => DriftError
): AsyncIterable<unknown> {
  let yielded = 0;
  let completed = false;
  try {
    for await (const chunk of stream) {
      yielded += 1;
      yield chunk;
    }
    completed = true;
    if (terminalError) {
      throw terminalError;
    }
  } finally {
    if (!completed && (yielded < expectedChunks || terminalError)) {
      throw prematureCloseError();
    }
  }
}

async function* timingStream(stream: AsyncIterable<unknown>, chunks: { offsetMs: number }[] | undefined): AsyncIterable<unknown> {
  let index = 0;
  let previous = 0;
  for await (const chunk of stream) {
    const timing = chunks?.[index];
    if (timing) {
      await delay(Math.max(0, timing.offsetMs - previous));
      previous = timing.offsetMs;
    }
    index += 1;
    yield chunk;
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

async function* promiseToAsyncIterable(value: Promise<unknown>): AsyncIterable<unknown> {
  const resolved = await value;
  if (!isAsyncIterable(resolved)) {
    throw new DriftError("Passthrough stream did not return an AsyncIterable", {});
  }
  for await (const chunk of resolved) {
    yield chunk;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prematureStreamCloseError(event: ModelCallEvent | ToolCallEvent, expectedChunks: number): DriftError {
  return new DriftError("Replay stream ended before consuming the recorded stream trajectory", {
    step: event.step,
    kind: event.kind,
    callSite: event.callSite,
    lane: event.lane,
    expectedChunks,
    terminalError: Boolean(event.error)
  });
}

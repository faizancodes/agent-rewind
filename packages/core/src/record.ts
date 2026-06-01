import type {
  EntropyEvent,
  EventProvenance,
  FingerprintMode,
  ModelCallEvent,
  NoteEvent,
  RewindEvent,
  SessionEndEvent,
  SessionMeta,
  SessionStartEvent,
  SerializedError,
  ToolCallEvent,
  Usage
} from "./events.js";
import type { ProviderCodec } from "./codec.js";
import { defaultEntropyRuntime, type EntropyRuntime } from "./entropy.js";
import { CURRENT_SCHEMA_VERSION } from "./migrate.js";
import { fingerprint, fingerprintUnknown } from "./fingerprint.js";
import { Redactor, type RedactionConfig } from "./redaction.js";
import {
  assertJsonSerializable,
  packSession,
  serializeError,
  sessionPath,
  writeSession
} from "./session-store.js";
import { serializeToolValue, type ToolSerializers } from "./tool-serialization.js";
import { LaneManager, deriveCallSite } from "./context.js";
import { CodecError, ConfigurationError, PurityLintError } from "./errors.js";
import { PurityLint } from "./purity-lint.js";

export type ToolHandler<Args = unknown, Result = unknown> = (args: Args) => Result | Promise<Result> | AsyncIterable<Result>;
export type ToolHandlers = Record<string, ToolHandler<never, unknown>>;
export type UntypedToolHandlers = Record<string, ToolHandler<unknown, unknown>>;
type CallableToolHandler = (args: unknown) => unknown | Promise<unknown> | AsyncIterable<unknown>;
type RuntimeEntropySource = Exclude<EntropyEvent["source"], "env">;
export type InterceptPurpose = "create" | "stream";

export type WrappedToolHandler<THandler> = THandler extends (args: infer Args) => infer Result
  ? Result extends AsyncIterable<infer Chunk>
    ? (args: Args) => AsyncIterable<Chunk>
    : (args: Args) => Promise<Awaited<Result>>
  : ToolHandler<unknown, unknown>;

export type WrappedTools<TTools extends ToolHandlers = UntypedToolHandlers> = {
  [Name in keyof TTools]: WrappedToolHandler<TTools[Name]>;
};

/** Preserve concrete tool names, argument types, and result types for `ctx.tools`. */
export function defineTools<TTools extends ToolHandlers>(tools: TTools): TTools {
  return tools;
}

/** Model facade exposed inside an AgentRewind harness. */
export interface WrappedModel<TRequest = unknown, TResponse = unknown, TStreamChunk = unknown> {
  /** Record or replay a non-streaming provider call. Pass `site` for stable drift diagnostics. */
  create<T = TResponse>(req: TRequest, opts?: { site?: string }): Promise<T>;
  /** Record or replay a streaming provider call. Pass `site` for stable drift diagnostics. */
  stream<T = TStreamChunk>(req: TRequest, opts?: { site?: string }): AsyncIterable<T>;
}

/** Runtime context passed to user harnesses in record, replay, and fork modes. */
export interface AgentContext<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Wrapped model client. Use this instead of calling the SDK client directly. */
  model: WrappedModel<TRequest, TResponse, TStreamChunk>;
  /** Wrapped tool handlers. Use these for external I/O that should replay deterministically. */
  tools: WrappedTools<TTools>;
  /** Replayable wall-clock milliseconds. */
  clock(): number;
  /** Replayable random number in [0, 1). */
  random(): number;
  /** Replayable UUID string. */
  uuid(): string;
  /** Read an environment variable through the replayable boundary log. */
  env(key: string): string | undefined;
  /** Add a note event to the session log. */
  note(text: string): void;
}

/** User code executed by AgentRewind. */
export type Harness<
  T = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> = (ctx: AgentContext<TTools, TRequest, TResponse, TStreamChunk>) => Promise<T>;

/** Preserve harness return type and, when supplied, the concrete tool types available on `ctx.tools`. */
export function defineHarness<T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(
  harness: Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>
): Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>;
export function defineHarness<TTools extends ToolHandlers, T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(
  tools: TTools,
  harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>
): Harness<T, TTools, TRequest, TResponse, TStreamChunk>;
export function defineHarness<TTools extends ToolHandlers, T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(
  toolsOrHarness: TTools | Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>,
  harness?: Harness<T, TTools, TRequest, TResponse, TStreamChunk>
): Harness<T, TTools, TRequest, TResponse, TStreamChunk> | Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk> {
  return (harness ?? toolsOrHarness) as
    | Harness<T, TTools, TRequest, TResponse, TStreamChunk>
    | Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>;
}

/** Agent definition that carries tool handlers and harness together at runtime. */
export interface AgentDefinition<
  T = unknown,
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  readonly tools?: TTools;
  readonly harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>;
}

/** Preserve harness and tool types while avoiding duplicate tools wiring in record/replay calls. */
export function defineAgent<TTools extends ToolHandlers, T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(definition: {
  tools: TTools;
  harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>;
}): AgentDefinition<T, TTools, TRequest, TResponse, TStreamChunk>;
export function defineAgent<T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(definition: {
  harness: Harness<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>;
}): AgentDefinition<T, UntypedToolHandlers, TRequest, TResponse, TStreamChunk>;
export function defineAgent<TTools extends ToolHandlers, T, TRequest = unknown, TResponse = unknown, TStreamChunk = unknown>(definition: {
  tools?: TTools;
  harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>;
}): AgentDefinition<T, TTools, TRequest, TResponse, TStreamChunk> {
  return Object.freeze({ ...definition });
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    "harness" in value &&
    typeof (value as { harness?: unknown }).harness === "function"
  );
}

/** Options for creating a recording session. */
export interface RecordOptions<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  /** Session id. Defaults to a generated UUID. */
  id?: string;
  /** Directory that will contain `<store>/<session-id>/`. */
  store: string;
  /** Live provider SDK client to wrap during recording. */
  model: unknown;
  /** Tool handlers available through `ctx.tools`. */
  tools?: TTools;
  /** Provider codec for the model client. */
  codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  /** Redaction settings. Redaction is enabled by default. */
  redaction?: RedactionConfig;
  /** Request fingerprinting mode. Defaults to `strict`. */
  fingerprintMode?: FingerprintMode;
  /** Flag unsanctioned filesystem writes during recording. Defaults to false. */
  purityLint?: boolean;
  /** Injectable entropy runtime for deterministic tests. */
  runtime?: Partial<EntropyRuntime>;
  /** Parent session id for forked recordings. Usually set by AgentRewind. */
  parent?: string;
  /** Fork split step for forked recordings. Usually set by AgentRewind. */
  forkedAtStep?: number;
  /** Per-tool serializers for non-plain JSON arguments/results/chunks. */
  toolSerializers?: ToolSerializers;
}

/** Live recording session. Close it to flush events, blobs, metadata, and vault. */
export interface Session<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> {
  readonly id: string;
  /** Run a harness with wrapped model, tools, and entropy sources. */
  run<T>(harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<T>;
  /** Low-level model wrapper for advanced integrations outside `run()`. */
  wrapModel(client: unknown): WrappedModel<TRequest, TResponse, TStreamChunk>;
  /** Low-level tool wrapper for advanced integrations outside `run()`. */
  wrapTools<TWrappedTools extends ToolHandlers>(handlers: TWrappedTools): WrappedTools<TWrappedTools>;
  /** Append a note event to the session. */
  note(text: string): void;
  /** Flush the session to disk. Safe to call more than once. */
  close(): Promise<void>;
  /** Close if needed, then create a vault-excluded `.rewind` bundle. */
  pack(outPath: string): Promise<void>;
}

export class RecordSession<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
> implements Session<TTools, TRequest, TResponse, TStreamChunk> {
  readonly id: string;
  readonly codec: ProviderCodec<TRequest, TResponse, TStreamChunk>;
  readonly redactor: Redactor;
  readonly fingerprintMode: FingerprintMode;
  private readonly runtime: EntropyRuntime;
  private readonly lanes = new LaneManager();
  private readonly eventsBuffer: RewindEvent[] = [];
  private readonly callOrdinals = new Map<string, number>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private ok = true;
  private meta: SessionMeta;

  constructor(private readonly opts: RecordOptions<TTools, TRequest, TResponse, TStreamChunk>) {
    this.id = opts.id ?? (opts.runtime?.uuid ?? defaultEntropyRuntime.uuid)();
    this.codec = opts.codec;
    this.redactor = new Redactor(opts.redaction);
    this.fingerprintMode = opts.fingerprintMode ?? "strict";
    this.runtime = { ...defaultEntropyRuntime, ...opts.runtime };
    this.meta = {
      id: this.id,
      parent: opts.parent,
      forkedAtStep: opts.forkedAtStep,
      createdAt: this.runtime.now(),
      agentRewindVersion: "0.1.0",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      provider: opts.codec.name,
      fingerprintMode: this.fingerprintMode,
      redaction: { enabled: this.redactor.enabled, patterns: this.redactor.patternLabels() },
      eventsHash: ""
    };
    this.append(this.sessionStartEvent());
  }

  async run<T>(harness: Harness<T, TTools, TRequest, TResponse, TStreamChunk>): Promise<T> {
    try {
      if (!this.opts.purityLint) {
        return await this.lanes.run(() => harness(this.context()));
      }
      const lint = new PurityLint();
      const result = await lint.run(() => this.lanes.run(() => harness(this.context())));
      const diagnostics = lint.diagnostics();
      if (diagnostics.length > 0) {
        throw new PurityLintError("Purity lint detected unsanctioned filesystem I/O during recording", {
          diagnostics
        });
      }
      return result;
    } catch (error) {
      this.ok = false;
      throw error;
    }
  }

  wrapModel(client: unknown): WrappedModel<TRequest, TResponse, TStreamChunk> {
    return {
      create: <T = TResponse>(req: TRequest, opts?: { site?: string }) => this.recordModelCreate(client, req, opts?.site) as Promise<T>,
      stream: <T = TStreamChunk>(req: TRequest, opts?: { site?: string }) => this.recordModelStream(client, req, opts?.site) as AsyncIterable<T>
    };
  }

  wrapTools<TWrappedTools extends ToolHandlers>(handlers: TWrappedTools): WrappedTools<TWrappedTools> {
    const wrapped = Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        (args: unknown) => this.recordToolCall(name, handler, args)
      ])
    ) as Record<string, CallableToolHandler>;
    const availableTools = Object.keys(handlers).sort((a, b) => a.localeCompare(b));
    return new Proxy(wrapped, {
      get(target, property, receiver) {
        if (typeof property !== "string") {
          return Reflect.get(target, property, receiver);
        }
        if (Object.prototype.hasOwnProperty.call(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        if (property === "then" || property === "toJSON") {
          return undefined;
        }
        return () => {
          throw new ConfigurationError(`Tool handler "${property}" is not configured for this recording session`, {
            tool: property,
            availableTools,
            expected: `Pass a tools object containing "${property}" to AgentRewind.record(...) or AgentRewind.recordRun(...).`
          });
        };
      }
    }) as WrappedTools<TWrappedTools>;
  }

  note(text: string): void {
    const event = this.baseEvent("note", "note", "note") as Omit<NoteEvent, "kind" | "text">;
    this.append({ ...event, kind: "note", text: this.redactor.redactString(text) });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.closePromise) {
      return this.closePromise;
    }
    const endEvent = this.sessionEndEvent();
    this.append(endEvent);
    const previousMeta = this.meta;
    this.closePromise = (async () => {
      try {
        this.meta = {
          ...this.meta,
          redactionSummary: {
            total: this.redactor.summary.total,
            byPattern: { ...this.redactor.summary.byPattern }
          }
        };
        this.meta = await writeSession(this.opts.store, this.meta, this.eventsBuffer, this.redactor.vault);
        this.closed = true;
      } catch (error) {
        if (this.eventsBuffer.at(-1) === endEvent) {
          this.eventsBuffer.pop();
        }
        this.meta = previousMeta;
        throw error;
      } finally {
        this.closePromise = undefined;
      }
    })();
    return this.closePromise;
  }

  async pack(outPath: string): Promise<void> {
    if (!this.closed) {
      await this.close();
    }
    await packSession(sessionPath(this.opts.store, this.id), outPath);
  }

  events(): RewindEvent[] {
    return [...this.eventsBuffer].sort((a, b) => a.step - b.step);
  }

  append(event: RewindEvent): void {
    this.eventsBuffer.push(event);
  }

  recordStubTool(name: string, args: unknown, result: unknown, argsHash: string): void {
    const initiated = this.beginBoundary("tool_call", name);
    try {
      const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
      const serializedResult = serializeToolValue(this.opts.toolSerializers, name, "result", result, `tool.${name}.result`);
      this.append({
        ...initiated,
        kind: "tool_call",
        name,
        args: this.redactor.redactDeep(serializedArgs),
        argsHash,
        result: this.redactor.redactDeep(serializedResult),
        latencyMs: 0,
        blobs: {},
        provenance: "stub"
      });
    } finally {
      this.lanes.endBoundaryLane(initiated.lane);
    }
  }

  recordServedToolResult(
    name: string,
    args: unknown,
    result: unknown,
    argsHash: string,
    provenance: EventProvenance = "recorded"
  ): void {
    const initiated = this.beginBoundary("tool_call", name);
    try {
      const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
      const serializedResult = serializeToolValue(this.opts.toolSerializers, name, "result", result, `tool.${name}.result`);
      this.append({
        ...initiated,
        kind: "tool_call",
        name,
        args: this.redactor.redactDeep(serializedArgs),
        argsHash,
        result: this.redactor.redactDeep(serializedResult),
        latencyMs: 0,
        blobs: {},
        provenance
      });
    } finally {
      this.lanes.endBoundaryLane(initiated.lane);
    }
  }

  recordServedToolError(
    name: string,
    args: unknown,
    argsHash: string,
    error: ToolCallEvent["error"],
    provenance: EventProvenance = "recorded"
  ): void {
    const initiated = this.beginBoundary("tool_call", name);
    try {
      const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
      this.append({
        ...initiated,
        kind: "tool_call",
        name,
        args: this.redactor.redactDeep(serializedArgs),
        argsHash,
        error: this.redactor.redactDeep(error),
        latencyMs: 0,
        blobs: {},
        provenance
      });
    } finally {
      this.lanes.endBoundaryLane(initiated.lane);
    }
  }

  recordServedToolStream(
    name: string,
    args: unknown,
    chunks: { offsetMs: number; data: unknown }[],
    argsHash: string,
    provenance: EventProvenance = "recorded"
  ): AsyncIterable<unknown> {
    const initiated = this.beginBoundary("tool_call", name);
    const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
    const storedArgs = this.redactor.redactDeep(serializedArgs);
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const storedChunks: { offsetMs: number; data: unknown }[] = [];
        let persisted = false;
        const persist = (error?: unknown) => {
          if (persisted) {
            return;
          }
          persisted = true;
          self.append({
            ...initiated,
            kind: "tool_call",
            name,
            args: storedArgs,
            argsHash,
            stream: self.redactor.redactDeep(storedChunks),
            ...(error === undefined ? {} : { error: self.redactedError(error) }),
            latencyMs: 0,
            blobs: {},
            provenance
          });
        };
        try {
          for (const chunk of chunks) {
            const serializedChunk = serializeToolValue(self.opts.toolSerializers, name, "streamChunk", chunk.data, `tool.${name}.stream.chunk`);
            storedChunks.push({ offsetMs: chunk.offsetMs, data: serializedChunk });
            yield chunk.data;
          }
          persist();
        } catch (error) {
          persist(error);
          throw error;
        } finally {
          persist();
          self.lanes.endBoundaryLane(initiated.lane);
        }
      }
    };
  }

  async recordLiveModel(
    rawRequest: TRequest,
    liveClient: unknown,
    site: string | undefined,
    provenance: EventProvenance = "live",
    requestOverride?: TRequest
  ): Promise<unknown> {
    return this.recordModelCreate(liveClient, rawRequest, site, provenance, requestOverride);
  }

  recordLiveModelStream(
    rawRequest: TRequest,
    liveClient: unknown,
    site: string | undefined,
    provenance: EventProvenance = "live"
  ): AsyncIterable<unknown> {
    return this.recordModelStream(liveClient, rawRequest, site, provenance);
  }

  recordLiveEntropy(source: "clock", provenance?: EventProvenance): number;
  recordLiveEntropy(source: "random", provenance?: EventProvenance): number;
  recordLiveEntropy(source: "uuid", provenance?: EventProvenance): string;
  recordLiveEntropy(source: RuntimeEntropySource, provenance?: EventProvenance): number | string;
  recordLiveEntropy(source: RuntimeEntropySource, provenance: EventProvenance = "live"): number | string {
    const value =
      source === "clock"
        ? this.runtime.now()
        : source === "random"
          ? this.runtime.random()
          : this.runtime.uuid();
    return this.recordEntropy(source, value, provenance) as number | string;
  }

  recordEnv(key: string, value: string | undefined, provenance: EventProvenance = "live"): string | undefined {
    const recorded = this.recordEntropy("env", value ?? null, provenance, key);
    return recorded === null ? undefined : String(recorded);
  }

  private context(): AgentContext<TTools, TRequest, TResponse, TStreamChunk> {
    return {
      model: this.wrapModel(this.opts.model),
      tools: this.wrapTools(this.opts.tools ?? {}),
      clock: () => this.recordLiveEntropy("clock"),
      random: () => this.recordLiveEntropy("random"),
      uuid: () => this.recordLiveEntropy("uuid"),
      env: (key) => {
        const value = process.env[key];
        return this.recordEnv(key, value);
      },
      note: (text) => this.note(text)
    } as AgentContext<TTools, TRequest, TResponse, TStreamChunk>;
  }

  private recordModelCreate(
    client: unknown,
    rawRequest: TRequest,
    site: string | undefined,
    provenance: EventProvenance = "live",
    requestOverride?: TRequest
  ): Promise<unknown> {
    const initiated = this.beginBoundary("model_call", site);
    const normalizedRequest = this.codec.normalizeRequest(rawRequest);
    const requestHash = fingerprint(normalizedRequest, this.codec, this.redactor, this.fingerprintMode);
    const storedRequest = this.redactor.redactDeep(normalizedRequest);
    const started = this.runtime.now();
    return this.lanes.withLane(initiated.lane, async () => {
      try {
        const liveRaw = await invokeClient(client, selectInterceptPoint(this.codec, "create"), requestOverride ?? rawRequest, this.codec);
        const normalizedResponse = this.codec.normalizeResponse(liveRaw as TResponse);
        assertJsonSerializable(normalizedResponse, "model.response");
        const storedResponse = this.redactor.redactDeep(normalizedResponse);
        const usage = this.codec.extractUsage(normalizedResponse) ?? normalizedResponse.usage;
        this.append({
          ...initiated,
          kind: "model_call",
          provider: this.codec.name,
          request: storedRequest,
          requestHash,
          response: storedResponse,
          usage,
          latencyMs: this.runtime.now() - started,
          blobs: {},
          provenance
        });
        return liveRaw;
      } catch (error) {
        this.append({
          ...initiated,
          kind: "model_call",
          provider: this.codec.name,
          request: storedRequest,
          requestHash,
          error: this.redactedError(error),
          latencyMs: this.runtime.now() - started,
          blobs: {},
          provenance
        });
        throw error;
      } finally {
        this.lanes.endBoundaryLane(initiated.lane);
      }
    });
  }

  private recordModelStream(
    client: unknown,
    rawRequest: TRequest,
    site: string | undefined,
    provenance: EventProvenance = "live"
  ): AsyncIterable<unknown> {
    const initiated = this.beginBoundary("model_call", site);
    const normalizedRequest = this.codec.normalizeRequest(rawRequest);
    const requestHash = fingerprint(normalizedRequest, this.codec, this.redactor, this.fingerprintMode);
    const storedRequest = this.redactor.redactDeep(normalizedRequest);
    const started = this.runtime.now();
    const path = selectInterceptPoint(this.codec, "stream");
    const rawStream = this.lanes.withLane(initiated.lane, () => invokeClient(client, path, rawRequest, this.codec));
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const chunks: unknown[] = [];
        const offsets: number[] = [];
        let persisted = false;
        const rawChunkRecords = () => chunks.map((data, index) => ({ offsetMs: offsets[index] ?? 0, data }));
        const persistPartial = (error?: unknown) => {
          if (persisted) {
            return;
          }
          persisted = true;
          self.append({
            ...initiated,
            kind: "model_call",
            provider: self.codec.name,
            request: storedRequest,
            requestHash,
            stream: self.redactor.redactDeep(rawChunkRecords()),
            ...(error === undefined ? {} : { error: self.redactedError(error) }),
            latencyMs: self.runtime.now() - started,
            blobs: {},
            provenance
          });
        };
        const persistComplete = () => {
          if (persisted) {
            return;
          }
          const normalized = self.codec.normalizeStream(chunks as TStreamChunk[]);
          normalized.chunks = normalized.chunks.map((chunk, index) => ({
            ...chunk,
            offsetMs: offsets[index] ?? chunk.offsetMs
          }));
          const usage = self.codec.extractUsage(normalized.final) ?? normalized.final.usage;
          persisted = true;
          self.append({
            ...initiated,
            kind: "model_call",
            provider: self.codec.name,
            request: storedRequest,
            requestHash,
            response: self.redactor.redactDeep(normalized.final),
            stream: self.redactor.redactDeep(normalized.chunks),
            usage,
            latencyMs: self.runtime.now() - started,
            blobs: {},
            provenance
          });
        };
        try {
          const stream = await rawStream;
          if (!isAsyncIterable(stream)) {
            throw new CodecError("Configured stream intercept point did not return an AsyncIterable", { path });
          }
          for await (const chunk of stream) {
            chunks.push(chunk);
            offsets.push(self.runtime.now() - started);
            yield chunk;
          }
          persistComplete();
        } catch (error) {
          persistPartial(error);
          throw error;
        } finally {
          persistPartial();
          self.lanes.endBoundaryLane(initiated.lane);
        }
      }
    };
  }

  private recordToolCall(
    name: string,
    handler: ToolHandler<never, unknown>,
    args: unknown,
    provenance: EventProvenance = "live"
  ): Promise<unknown> | AsyncIterable<unknown> {
    const initiated = this.beginBoundary("tool_call", name);
    const started = this.runtime.now();
    let storedArgs: unknown;
    let argsHash: string | undefined;
    try {
      const serializedArgs = serializeToolValue(this.opts.toolSerializers, name, "args", args, `tool.${name}.args`);
      storedArgs = this.redactor.redactDeep(serializedArgs);
      argsHash = fingerprintUnknown(serializedArgs, this.redactor);
      const callable = handler as CallableToolHandler;
      const result = this.lanes.withLane(initiated.lane, () => callable(args));
      if (isAsyncIterable(result)) {
        return this.recordToolStream(name, initiated, storedArgs, argsHash, result, started, provenance);
      }
      const eventArgs = storedArgs;
      const eventArgsHash = argsHash;
      return this.lanes.withLane(initiated.lane, () =>
        Promise.resolve(result)
          .then((value) => {
            const serializedResult = serializeToolValue(this.opts.toolSerializers, name, "result", value, `tool.${name}.result`);
            this.append({
              ...initiated,
              kind: "tool_call",
              name,
              args: eventArgs,
              argsHash: eventArgsHash,
              result: this.redactor.redactDeep(serializedResult),
              latencyMs: this.runtime.now() - started,
              blobs: {},
              provenance
            });
            return value;
          })
          .catch((error) => {
            this.append({
              ...initiated,
              kind: "tool_call",
              name,
              args: eventArgs,
              argsHash: eventArgsHash,
              error: this.redactedError(error),
              latencyMs: this.runtime.now() - started,
              blobs: {},
              provenance
            });
            throw error;
          })
          .finally(() => this.lanes.endBoundaryLane(initiated.lane))
      );
    } catch (error) {
      if (argsHash !== undefined) {
        this.append({
          ...initiated,
          kind: "tool_call",
          name,
          args: storedArgs,
          argsHash,
          error: this.redactedError(error),
          latencyMs: this.runtime.now() - started,
          blobs: {},
          provenance
        });
      }
      this.lanes.endBoundaryLane(initiated.lane);
      throw error;
    }
  }

  private recordToolStream(
    name: string,
    initiated: Omit<ToolCallEvent, "kind" | "name" | "args" | "argsHash" | "latencyMs" | "blobs">,
    storedArgs: unknown,
    argsHash: string,
    stream: AsyncIterable<unknown>,
    started: number,
    provenance: EventProvenance
  ): AsyncIterable<unknown> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const chunks: { offsetMs: number; data: unknown }[] = [];
        let persisted = false;
        const persist = (error?: unknown) => {
          if (persisted) {
            return;
          }
          persisted = true;
          self.append({
            ...initiated,
            kind: "tool_call",
            name,
            args: storedArgs,
            argsHash,
            stream: self.redactor.redactDeep(chunks),
            ...(error === undefined ? {} : { error: self.redactedError(error) }),
            latencyMs: self.runtime.now() - started,
            blobs: {},
            provenance
          });
        };
        try {
          for await (const chunk of stream) {
            const serializedChunk = serializeToolValue(self.opts.toolSerializers, name, "streamChunk", chunk, `tool.${name}.stream.chunk`);
            chunks.push({ offsetMs: self.runtime.now() - started, data: serializedChunk });
            yield chunk;
          }
          persist();
        } catch (error) {
          persist(error);
          throw error;
        } finally {
          persist();
          self.lanes.endBoundaryLane(initiated.lane);
        }
      }
    };
  }

  private recordEntropy(source: "clock", value: number, provenance?: EventProvenance): number;
  private recordEntropy(source: "random", value: number, provenance?: EventProvenance): number;
  private recordEntropy(source: "uuid", value: string, provenance?: EventProvenance): string;
  private recordEntropy(source: "env", value: string | null, provenance: EventProvenance, key: string): string | null;
  private recordEntropy(source: EntropyEvent["source"], value: number | string | null, provenance?: EventProvenance, key?: string): number | string | null;
  private recordEntropy(
    source: EntropyEvent["source"],
    value: number | string | null,
    provenance: EventProvenance = "live",
    key?: string
  ): number | string | null {
    const explicit = source === "env" && key ? `env:${key}` : source;
    const initiated = this.beginBoundary("entropy", explicit);
    try {
      this.append({ ...initiated, kind: "entropy", source, ...(key ? { key } : {}), value, provenance });
      return value;
    } finally {
      this.lanes.endBoundaryLane(initiated.lane);
    }
  }

  private beginBoundary(kind: "model_call" | "tool_call" | "entropy", explicitSite: string | undefined): Omit<ModelCallEvent, "kind" | "provider" | "request" | "requestHash" | "latencyMs" | "blobs"> {
    const lane = this.lanes.beginBoundaryLane(explicitSite ? `${kind}\u0000${explicitSite}` : undefined);
    const ordinal = this.nextOrdinal(kind, lane);
    return {
      seq: this.lanes.nextSeq(lane),
      step: this.lanes.nextStep(),
      ts: this.runtime.now(),
      lane,
      callSite: kind === "entropy" ? `${explicitSite ?? "entropy"}:${ordinal}:${explicitSite ?? "entropy"}` : deriveCallSite(explicitSite, kind, lane, ordinal),
      schemaVersion: CURRENT_SCHEMA_VERSION
    };
  }

  private baseEvent(kind: RewindEvent["kind"], callSite: string, ordinalKey: string): Omit<RewindEvent, "kind"> {
    const lane = this.lanes.currentLane();
    return {
      seq: this.lanes.lastSeq(lane),
      step: this.lanes.lastStep(),
      ts: this.runtime.now(),
      lane,
      callSite: `${callSite}:${this.nextOrdinal(kind, lane)}:${ordinalKey}`,
      schemaVersion: CURRENT_SCHEMA_VERSION
    } as Omit<RewindEvent, "kind">;
  }

  private nextOrdinal(kind: string, lane: string): number {
    const key = `${kind}\u0000${lane}`;
    const next = this.callOrdinals.get(key) ?? 0;
    this.callOrdinals.set(key, next + 1);
    return next;
  }

  private redactedError(error: unknown): SerializedError {
    return this.redactor.redactDeep(serializeError(error));
  }

  private sessionStartEvent(): SessionStartEvent {
    return { ...this.baseEvent("session_start", "session", "start"), kind: "session_start", meta: this.meta };
  }

  private sessionEndEvent(): SessionEndEvent {
    return { ...this.baseEvent("session_end", "session", "end"), kind: "session_end", ok: this.ok };
  }
}

export function createRecordSession<
  TTools extends ToolHandlers = UntypedToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(opts: RecordOptions<TTools, TRequest, TResponse, TStreamChunk>): RecordSession<TTools, TRequest, TResponse, TStreamChunk> {
  assertRecordOptions(opts);
  return new RecordSession(opts);
}

export function assertProviderClient(
  client: unknown,
  codec: ProviderCodec,
  purposes: readonly InterceptPurpose[] = ["create"]
): void {
  assertProviderCodec(codec, "assertProviderClient");
  for (const purpose of purposes) {
    getMethod(client, selectInterceptPoint(codec, purpose), codec);
  }
}

export function assertProviderCodec(codec: unknown, operation = "recording"): asserts codec is ProviderCodec {
  if (!isObjectRecord(codec)) {
    throw new ConfigurationError(`Provider codec is required for ${operation}`, {
      missing: "codec",
      operation,
      expected: "Pass a provider codec such as openaiChatCodec(), openRouterChatCodec(), or anthropicCodec()."
    });
  }

  const missingFields = requiredCodecFields.filter((field) => !(field in codec));
  if (missingFields.length > 0) {
    throw new ConfigurationError("Provider codec is missing required fields", {
      missing: "codec",
      operation,
      missingFields,
      expected: `ProviderCodec must include: ${requiredCodecFields.join(", ")}.`
    });
  }

  const invalidFields: string[] = requiredCodecFunctionFields.filter((field) => typeof codec[field] !== "function");
  if (typeof codec.name !== "string" || codec.name.length === 0) {
    invalidFields.unshift("name");
  }
  if (!Array.isArray(codec.interceptPoints) || !codec.interceptPoints.every((point) => typeof point === "string" && point.length > 0)) {
    invalidFields.unshift("interceptPoints");
  }
  if (invalidFields.length > 0) {
    throw new ConfigurationError("Provider codec has invalid field types", {
      missing: "codec",
      operation,
      invalidFields,
      expected: "Use a complete ProviderCodec object returned by one of the @agentrewind/codec-* packages, or implement the ProviderCodec contract."
    });
  }
}

const requiredCodecFunctionFields = [
  "normalizeRequest",
  "denormalizeRequest",
  "normalizeResponse",
  "normalizeStream",
  "rebuildStream",
  "stripVolatile",
  "volatileLeafPaths",
  "extractUsage",
  "applyOverrides"
] as const;

const requiredCodecFields = ["name", "interceptPoints", ...requiredCodecFunctionFields] as const;

function assertRecordOptions<
  TTools extends ToolHandlers,
  TRequest = unknown,
  TResponse = unknown,
  TStreamChunk = unknown
>(opts: RecordOptions<TTools, TRequest, TResponse, TStreamChunk>): void {
  if (!isObjectRecord(opts)) {
    throw new ConfigurationError("AgentRewind.record() requires a record options object", {
      missing: "recordOptions",
      operation: "record",
      expected: "Call AgentRewind.record({ store, model, codec, tools? }) or AgentRewind.recordRun({ store, model, codec, tools? }, harness)."
    });
  }
  if (typeof opts.store !== "string" || opts.store.trim().length === 0) {
    throw new ConfigurationError("AgentRewind.record() requires a non-empty store path", {
      missing: "store",
      operation: "record",
      expected: "Pass a directory path, for example { store: \".rewind\", model, codec }."
    });
  }
  if (opts.model === undefined || opts.model === null) {
    throw new ConfigurationError("AgentRewind.record() requires a live model client", {
      missing: "model",
      operation: "record",
      expected: "Pass the provider SDK client to record mode, for example { store: \".rewind\", model, codec }."
    });
  }
  assertProviderCodec(opts.codec, "recording");
}

export async function invokeClient(client: unknown, path: string, request: unknown, codec?: ProviderCodec): Promise<unknown> {
  const method = getMethod(client, path, codec);
  return method(request);
}

export function selectInterceptPoint(codec: ProviderCodec, purpose: InterceptPurpose): string {
  const found = codec.interceptPoints.find((point) => point.split(".").at(-1)?.includes(purpose));
  if (found) {
    return found;
  }
  throw new CodecError(`Codec "${codec.name}" does not define a ${purpose} intercept point`, {
    codec: codec.name,
    purpose,
    interceptPoints: codec.interceptPoints,
    expected: purpose === "create" ? "a path ending in create, such as chat.completions.create" : "a path ending in stream, such as chat.completions.stream"
  });
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

function getMethod(client: unknown, path: string, codec?: ProviderCodec): (request: unknown) => unknown {
  const parts = path.split(".");
  let current: unknown = client;
  for (const part of parts.slice(0, -1)) {
    if (!isObjectRecord(current)) {
      throw clientShapeError(path, codec, part, current, "Cannot resolve codec intercept point");
    }
    const next = current[part];
    if (next === null || typeof next !== "object") {
      throw clientShapeError(path, codec, part, current, "Cannot resolve codec intercept point");
    }
    current = next;
  }
  const methodName = parts.at(-1);
  if (!isObjectRecord(current)) {
    throw clientShapeError(path, codec, methodName, current, "Codec intercept point is not callable");
  }
  const method = methodName ? current[methodName] : undefined;
  if (typeof method !== "function") {
    throw clientShapeError(path, codec, methodName, current, "Codec intercept point is not callable");
  }
  return method.bind(current) as (request: unknown) => unknown;
}

function clientShapeError(
  path: string,
  codec: ProviderCodec | undefined,
  segment: string | undefined,
  current: unknown,
  message: string
): CodecError {
  return new CodecError(`${message}: expected client.${path}(request)`, {
    ...(codec ? { codec: codec.name, interceptPoints: codec.interceptPoints } : {}),
    path,
    expected: `client.${path}(request)`,
    missingSegment: segment,
    availableKeys: isObjectRecord(current) ? Object.keys(current).sort() : [],
    receivedType: current === null ? "null" : typeof current
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

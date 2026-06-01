import type {
  ChunkRecord,
  NormalizedRequest,
  NormalizedResponse,
  Usage
} from "./events.js";

export interface ForkOverrides {
  /** Replacement system prompt for live tail model calls during fork. */
  system?: string;
  /** Replacement model id for live tail model calls during fork. */
  model?: string;
  /** Last-chance request transform applied after system/model overrides. */
  transformRequest?: (req: NormalizedRequest, step: number) => NormalizedRequest;
}

/** Provider-specific adapter between SDK shapes and AgentRewind's normalized model-call format. */
export interface ProviderCodec<TRequest = unknown, TResponse = unknown, TStreamChunk = unknown> {
  /** Compile-time-only carrier for provider request/response types. */
  readonly __agentRewindTypes?: {
    request: TRequest;
    response: TResponse;
    streamChunk: TStreamChunk;
  };
  /** Stable provider name stored on model_call events. */
  name: string;
  /** SDK method paths to call, such as `messages.create` or `chat.completions.stream`. */
  interceptPoints: string[];
  /** Convert an SDK request into the normalized request used for fingerprints and inspection. */
  normalizeRequest(raw: unknown): NormalizedRequest;
  /** Convert a normalized request back into an SDK request for fork/passthrough live calls. */
  denormalizeRequest(req: NormalizedRequest): unknown;
  /** Convert an SDK response into a normalized response. */
  normalizeResponse(raw: unknown): NormalizedResponse;
  /** Convert raw stream chunks into recorded chunk data and an assembled final response. */
  normalizeStream(rawChunks: unknown[]): { final: NormalizedResponse; chunks: ChunkRecord[] };
  /** Recreate the provider stream from recorded chunks during replay. */
  rebuildStream(chunks: ChunkRecord[]): AsyncIterable<unknown>;
  /** Return a copy of the request with volatile values removed before strict fingerprinting. */
  stripVolatile(req: NormalizedRequest): NormalizedRequest;
  /** Leaf paths treated as volatile in structural fingerprint mode. */
  volatileLeafPaths(): string[];
  /** Extract token/cost usage from a normalized response. */
  extractUsage(resp: NormalizedResponse): Usage | undefined;
  /** Apply fork overrides to a normalized request before denormalizing it for a live call. */
  applyOverrides(req: NormalizedRequest, overrides: ForkOverrides, step: number): NormalizedRequest;
}

export type ProviderRequest<TCodec> = TCodec extends ProviderCodec<infer TRequest, unknown, unknown> ? TRequest : unknown;
export type ProviderResponse<TCodec> = TCodec extends ProviderCodec<unknown, infer TResponse, unknown> ? TResponse : unknown;
export type ProviderStreamChunk<TCodec> = TCodec extends ProviderCodec<unknown, unknown, infer TStreamChunk> ? TStreamChunk : unknown;

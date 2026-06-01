export type Hash = string;

export type EventKind =
  | "session_start"
  | "model_call"
  | "tool_call"
  | "entropy"
  | "note"
  | "session_end";

export type FingerprintMode = "strict" | "structural";
export type EventProvenance = "recorded" | "live" | "stub" | "synthetic";
export type EntropySource = "clock" | "random" | "uuid" | "env";

export interface BaseEvent {
  seq: number;
  step: number;
  ts: number;
  lane: string;
  callSite: string;
  kind: EventKind;
  schemaVersion: number;
  blobs?: Record<string, Hash>;
}

export interface ModelCallEvent extends BaseEvent {
  kind: "model_call";
  provider: string;
  request: NormalizedRequest;
  requestHash: Hash;
  response?: NormalizedResponse;
  error?: SerializedError;
  stream?: ChunkRecord[];
  usage?: Usage;
  latencyMs: number;
  blobs: Record<string, Hash>;
  provenance?: EventProvenance;
}

export interface ToolCallEvent extends BaseEvent {
  kind: "tool_call";
  name: string;
  args: unknown;
  argsHash: Hash;
  result?: unknown;
  error?: SerializedError;
  stream?: ChunkRecord[];
  latencyMs: number;
  blobs: Record<string, Hash>;
  provenance?: EventProvenance;
  synthetic?: boolean;
}

export interface EntropyEvent extends BaseEvent {
  kind: "entropy";
  source: EntropySource;
  /** Environment variable name when `source` is `env`. */
  key?: string;
  value: number | string | null;
  provenance?: EventProvenance;
}

export interface NoteEvent extends BaseEvent {
  kind: "note";
  text: string;
}

export interface SessionStartEvent extends BaseEvent {
  kind: "session_start";
  meta: SessionMeta;
}

export interface SessionEndEvent extends BaseEvent {
  kind: "session_end";
  ok: boolean;
}

export type RewindEvent =
  | ModelCallEvent
  | ToolCallEvent
  | EntropyEvent
  | NoteEvent
  | SessionStartEvent
  | SessionEndEvent;

export interface ChunkRecord {
  offsetMs: number;
  data: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  data?: unknown;
}

export interface NormalizedMessage {
  role: "developer" | "system" | "user" | "assistant" | "tool" | "function";
  content: unknown;
}

export interface NormalizedRequest {
  model: string;
  system?: string;
  messages: NormalizedMessage[];
  params: Record<string, unknown>;
}

export interface NormalizedResponse {
  content: unknown;
  stopReason?: string;
  usage?: Usage;
  raw?: unknown;
}

export interface SessionMeta {
  id: string;
  parent?: string;
  forkedAtStep?: number;
  createdAt: number;
  agentRewindVersion: string;
  schemaVersion: number;
  provider: string;
  fingerprintMode: FingerprintMode;
  redaction: { enabled: boolean; patterns: string[] };
  redactionSummary?: { total: number; byPattern: Record<string, number> };
  eventsHash: Hash;
}

export function isBoundaryEvent(event: RewindEvent): event is ModelCallEvent | ToolCallEvent | EntropyEvent {
  return event.kind === "model_call" || event.kind === "tool_call" || event.kind === "entropy";
}

import type { EventKind, ModelCallEvent, RewindEvent, SessionMeta, ToolCallEvent, Usage } from "./events.js";
import { listSessionPaths, readSession, resolveSessionPath, type SessionSelectorOptions } from "./session-store.js";
import { usageTotal } from "./tokens.js";

export interface SessionEventCounts {
  totalEvents: number;
  modelCalls: number;
  toolCalls: number;
  entropyDraws: number;
  notes: number;
  sessionEvents: number;
  streams: number;
  errors: number;
}

export interface SessionModelStep {
  step: number;
  site: string;
  model: string;
  messages: number;
  streamed: boolean;
  error: boolean;
  provenance?: string;
}

export interface SessionToolStep {
  step: number;
  site: string;
  name: string;
  streamed: boolean;
  error: boolean;
  provenance?: string;
}

export interface SessionSummary {
  ok: true;
  id: string;
  path?: string;
  provider: string;
  schemaVersion: number;
  fingerprintMode: string;
  createdAt: string;
  createdAtMs: number;
  parent?: string;
  forkedAtStep?: number;
  redaction: {
    enabled: boolean;
    total: number;
    byPattern: Record<string, number>;
  };
  counts: SessionEventCounts;
  usage: Usage;
  modelSteps: SessionModelStep[];
  toolSteps: SessionToolStep[];
}

export type SessionSummaryOptions = SessionSelectorOptions;

export async function readSessionSummary(selector: string, opts: SessionSummaryOptions = {}): Promise<SessionSummary> {
  const stored = await readSession(await resolveSessionPath(selector, opts));
  return summarizeSession(stored.meta, stored.events, stored.path);
}

export async function listSessionSummaries(store = ".rewind"): Promise<SessionSummary[]> {
  const summaries = await Promise.all(
    (await listSessionPaths(store)).map(async (sessionPath) => {
      const stored = await readSession(sessionPath);
      return summarizeSession(stored.meta, stored.events, stored.path);
    })
  );
  return summaries.sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
}

export function summarizeSession(meta: SessionMeta, events: RewindEvent[], path?: string): SessionSummary {
  const modelEvents = events.filter((event): event is ModelCallEvent => event.kind === "model_call");
  const toolEvents = events.filter((event): event is ToolCallEvent => event.kind === "tool_call");
  return {
    ok: true,
    id: meta.id,
    ...(path ? { path } : {}),
    provider: meta.provider,
    schemaVersion: meta.schemaVersion,
    fingerprintMode: meta.fingerprintMode,
    createdAt: new Date(meta.createdAt).toISOString(),
    createdAtMs: meta.createdAt,
    ...(meta.parent ? { parent: meta.parent } : {}),
    ...(meta.forkedAtStep === undefined ? {} : { forkedAtStep: meta.forkedAtStep }),
    redaction: {
      enabled: meta.redaction.enabled,
      total: meta.redactionSummary?.total ?? 0,
      byPattern: meta.redactionSummary?.byPattern ?? {}
    },
    counts: countSessionEvents(events),
    usage: usageTotal(events),
    modelSteps: modelEvents.map((event) => ({
      step: event.step,
      site: event.callSite,
      model: event.request.model,
      messages: event.request.messages.length,
      streamed: Boolean(event.stream),
      error: Boolean(event.error),
      ...(event.provenance ? { provenance: event.provenance } : {})
    })),
    toolSteps: toolEvents.map((event) => ({
      step: event.step,
      site: event.callSite,
      name: event.name,
      streamed: Boolean(event.stream),
      error: Boolean(event.error),
      ...(event.provenance ? { provenance: event.provenance } : {})
    }))
  };
}

export function countSessionEvents(events: RewindEvent[]): SessionEventCounts {
  const byKind = new Map<EventKind, number>();
  let streams = 0;
  let errors = 0;
  for (const event of events) {
    byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    if ((event.kind === "model_call" || event.kind === "tool_call") && event.stream) {
      streams += 1;
    }
    if ((event.kind === "model_call" || event.kind === "tool_call") && event.error) {
      errors += 1;
    }
  }
  return {
    totalEvents: events.length,
    modelCalls: byKind.get("model_call") ?? 0,
    toolCalls: byKind.get("tool_call") ?? 0,
    entropyDraws: byKind.get("entropy") ?? 0,
    notes: byKind.get("note") ?? 0,
    sessionEvents: (byKind.get("session_start") ?? 0) + (byKind.get("session_end") ?? 0),
    streams,
    errors
  };
}

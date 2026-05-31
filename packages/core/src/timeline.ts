import type { RewindEvent, Usage } from "./events.js";
import { readSession, resolveSessionPath, type SessionSelectorOptions } from "./session-store.js";

export interface SessionTimelineRow {
  step: number;
  kind: RewindEvent["kind"];
  lane: string;
  site: string;
  fingerprint?: string;
  model?: string;
  name?: string;
  source?: string;
  tokens?: Usage;
  streamed: boolean;
  error: boolean;
  provenance?: string;
}

export type SessionTimelineOptions = SessionSelectorOptions;

export async function readSessionTimeline(selector: string, opts: SessionTimelineOptions = {}): Promise<SessionTimelineRow[]> {
  const stored = await readSession(await resolveSessionPath(selector, opts));
  return stored.events.map(eventTimelineRow);
}

export function eventTimelineRow(event: RewindEvent): SessionTimelineRow {
  return {
    step: event.step,
    kind: event.kind,
    lane: event.lane,
    site: event.callSite,
    ...(event.kind === "model_call"
      ? {
          fingerprint: event.requestHash.slice(0, 12),
          model: event.request.model,
          tokens: event.usage,
          streamed: Boolean(event.stream),
          error: Boolean(event.error),
          ...(event.provenance ? { provenance: event.provenance } : {})
        }
      : event.kind === "tool_call"
        ? {
            fingerprint: event.argsHash.slice(0, 12),
            name: event.name,
            streamed: Boolean(event.stream),
            error: Boolean(event.error),
            ...(event.provenance ? { provenance: event.provenance } : {})
          }
        : event.kind === "entropy"
          ? {
              source: event.source,
              streamed: false,
              error: false,
              ...(event.provenance ? { provenance: event.provenance } : {})
            }
          : {
              streamed: false,
              error: false
            })
  };
}

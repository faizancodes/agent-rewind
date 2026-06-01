import type { EventKind, RewindEvent, Usage } from "./events.js";
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

export interface SessionTimelineOptions extends SessionSelectorOptions {
  /** Include only these event kinds. */
  kind?: EventKind | EventKind[];
  /** Include rows whose call site contains this text. */
  site?: string;
  /** Include only rows that recorded an error. */
  errors?: boolean;
  /** Include only rows with live provenance. */
  live?: boolean;
  /** Include rows at or after this step. */
  from?: number;
  /** Include rows at or before this step. */
  to?: number;
  /** Print complete fingerprints instead of the default 12-character prefix. */
  fullFingerprint?: boolean;
}

export async function readSessionTimeline(selector: string, opts: SessionTimelineOptions = {}): Promise<SessionTimelineRow[]> {
  const stored = await readSession(await resolveSessionPath(selector, opts));
  return stored.events.filter((event) => timelineEventMatches(event, opts)).map((event) => eventTimelineRow(event, opts));
}

export function eventTimelineRow(event: RewindEvent, opts: Pick<SessionTimelineOptions, "fullFingerprint"> = {}): SessionTimelineRow {
  return {
    step: event.step,
    kind: event.kind,
    lane: event.lane,
    site: event.callSite,
    ...(event.kind === "model_call"
      ? {
          fingerprint: opts.fullFingerprint ? event.requestHash : event.requestHash.slice(0, 12),
          model: event.request.model,
          tokens: event.usage,
          streamed: Boolean(event.stream),
          error: Boolean(event.error),
          ...(event.provenance ? { provenance: event.provenance } : {})
        }
      : event.kind === "tool_call"
        ? {
            fingerprint: opts.fullFingerprint ? event.argsHash : event.argsHash.slice(0, 12),
            name: event.name,
            streamed: Boolean(event.stream),
            error: Boolean(event.error),
            ...(event.provenance ? { provenance: event.provenance } : {})
          }
        : event.kind === "entropy"
          ? {
              source: event.source === "env" && event.key ? `env:${event.key}` : event.source,
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

function timelineEventMatches(event: RewindEvent, opts: SessionTimelineOptions): boolean {
  const kinds = opts.kind === undefined ? undefined : Array.isArray(opts.kind) ? opts.kind : [opts.kind];
  if (kinds && !kinds.includes(event.kind)) {
    return false;
  }
  if (opts.from !== undefined && event.step < opts.from) {
    return false;
  }
  if (opts.to !== undefined && event.step > opts.to) {
    return false;
  }
  if (opts.site && !event.callSite.includes(opts.site)) {
    return false;
  }
  if (opts.errors && !("error" in event && Boolean(event.error))) {
    return false;
  }
  if (opts.live && !("provenance" in event && event.provenance === "live")) {
    return false;
  }
  return true;
}

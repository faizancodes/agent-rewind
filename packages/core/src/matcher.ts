import type { Hash, ModelCallEvent, RewindEvent, ToolCallEvent } from "./events.js";

export type MatchableEvent = ModelCallEvent | ToolCallEvent;

export type ResolveCtx = {
  kind: "model_call" | "tool_call";
  callSite: string;
  lane: string;
  name?: string;
};

export type Resolution = { hit: MatchableEvent } | { miss: { fp: Hash; callSite: string } };

export interface ReorderDiagnostic {
  lane: string;
  expectedSeq: number;
  actualSeq: number;
  event: MatchableEvent;
}

interface StoreEntry {
  event: MatchableEvent;
  consumed: boolean;
  keys: string[];
}

export class PendingStore {
  private readonly buckets = new Map<string, StoreEntry[]>();
  private readonly entries = new Map<MatchableEvent, StoreEntry>();
  private readonly nextExpectedByLane = new Map<string, number>();
  private readonly diagnostics: ReorderDiagnostic[] = [];

  constructor(events: RewindEvent[], private readonly checkSequential = true) {
    for (const event of events) {
      if (event.kind !== "model_call" && event.kind !== "tool_call") {
        continue;
      }
      const fp = event.kind === "model_call" ? event.requestHash : event.argsHash;
      const keys = [primaryKey(event.kind, event.callSite, fp), fallbackKey(event.kind, fp)];
      const entry: StoreEntry = { event, consumed: false, keys };
      this.entries.set(event, entry);
      const currentExpected = this.nextExpectedByLane.get(event.lane);
      if (currentExpected === undefined || event.seq < currentExpected) {
        this.nextExpectedByLane.set(event.lane, event.seq);
      }
      for (const key of keys) {
        const bucket = this.buckets.get(key) ?? [];
        bucket.push(entry);
        this.buckets.set(key, bucket);
      }
    }
  }

  peek(fp: Hash, ctx: ResolveCtx): Resolution {
    const hit = this.find(primaryKey(ctx.kind, ctx.callSite, fp)) ?? this.find(fallbackKey(ctx.kind, fp));
    return hit ? { hit } : { miss: { fp, callSite: ctx.callSite } };
  }

  resolve(fp: Hash, ctx: ResolveCtx): Resolution {
    const hit = this.pop(primaryKey(ctx.kind, ctx.callSite, fp), ctx) ?? this.pop(fallbackKey(ctx.kind, fp), ctx);
    if (!hit) {
      return { miss: { fp, callSite: ctx.callSite } };
    }
    return { hit };
  }

  expectedNextSeq(lane: string): number {
    return this.nextExpectedByLane.get(lane) ?? 0;
  }

  reorderDiagnostics(): ReorderDiagnostic[] {
    return [...this.diagnostics];
  }

  remaining(): MatchableEvent[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.consumed)
      .map((entry) => entry.event)
      .sort((a, b) => a.step - b.step);
  }

  nextUnconsumedStep(): number | undefined {
    return this.remaining()[0]?.step;
  }

  private find(key: string): MatchableEvent | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return undefined;
    }
    return bucket.find((entry) => !entry.consumed)?.event;
  }

  private pop(key: string, ctx: ResolveCtx): MatchableEvent | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return undefined;
    }
    while (bucket.length > 0) {
      const entry = bucket.shift();
      if (!entry || entry.consumed) {
        continue;
      }
      entry.consumed = true;
      this.updateSequentialDiagnostics(entry.event, ctx);
      for (const entryKey of entry.keys) {
        const other = this.buckets.get(entryKey);
        if (!other) {
          continue;
        }
        this.buckets.set(
          entryKey,
          other.filter((candidate) => candidate !== entry)
        );
      }
      return entry.event;
    }
    return undefined;
  }

  private updateSequentialDiagnostics(event: MatchableEvent, ctx: ResolveCtx): void {
    if (!this.checkSequential || ctx.lane !== event.lane) {
      return;
    }
    const expectedSeq = this.expectedNextSeq(event.lane);
    if (event.seq !== expectedSeq) {
      this.diagnostics.push({ lane: event.lane, expectedSeq, actualSeq: event.seq, event });
    }
    this.nextExpectedByLane.set(event.lane, Math.max(expectedSeq, event.seq + 1));
  }
}

function primaryKey(kind: string, callSite: string, fp: Hash): string {
  return `${kind}\u0000${callSite}\u0000${fp}`;
}

function fallbackKey(kind: string, fp: Hash): string {
  return `${kind}\u0000${fp}`;
}

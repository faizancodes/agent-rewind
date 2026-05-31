import { randomUUID } from "node:crypto";
import type { EntropyEvent, RewindEvent } from "./events.js";
import { DriftError } from "./errors.js";

export interface EntropyRuntime {
  now(): number;
  random(): number;
  uuid(): string;
}

export const defaultEntropyRuntime: EntropyRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  uuid: () => randomUUID()
};

export class EntropyReplay {
  private readonly queues = new Map<string, EntropyEvent[]>();

  constructor(events: RewindEvent[]) {
    for (const event of events) {
      if (event.kind !== "entropy") {
        continue;
      }
      const key = queueKey(event.lane, event.source);
      const queue = this.queues.get(key) ?? [];
      queue.push(event);
      this.queues.set(key, queue);
    }
  }

  peek(source: EntropyEvent["source"], lane: string): EntropyEvent | undefined {
    return this.queues.get(queueKey(lane, source))?.[0];
  }

  nextEvent(source: EntropyEvent["source"], lane: string, driftPolicy: "strict" | "warn" | "passthrough" = "strict"): EntropyEvent {
    const queue = this.queues.get(queueKey(lane, source));
    const event = queue?.shift();
    if (!event) {
      const error = new DriftError("Missing recorded entropy event", { source, lane });
      if (driftPolicy === "warn") {
        console.warn(error.message, error.data);
      }
      throw error;
    }
    return event;
  }

  next(source: EntropyEvent["source"], lane: string, driftPolicy: "strict" | "warn" | "passthrough" = "strict"): number | string {
    return this.nextEvent(source, lane, driftPolicy).value;
  }

  remaining(): EntropyEvent[] {
    return [...this.queues.values()].flat().sort((a, b) => a.step - b.step);
  }

  nextUnconsumedStep(): number | undefined {
    return this.remaining()[0]?.step;
  }
}

function queueKey(lane: string, source: EntropyEvent["source"]): string {
  return `${lane}\u0000${source}`;
}

import { AsyncLocalStorage, createHook, executionAsyncId, type AsyncHook } from "node:async_hooks";

export interface LaneState {
  lane: string;
}

export class LaneManager {
  private readonly storage = new AsyncLocalStorage<LaneState>();
  private readonly hook: AsyncHook;
  private readonly triggerByAsyncId = new Map<number, number>();
  private readonly laneByAsyncId = new Map<number, string>();
  private readonly seqByLane = new Map<string, number>();
  private readonly activeByLane = new Map<string, number>();
  private readonly childOrdinalByLane = new Map<string, number>();
  private currentRootPromiseId: number | undefined;
  private freshRootPromiseId: number | undefined;
  private syncBranch: { promiseId: number; lane: string } | undefined;
  private step = 0;

  constructor() {
    this.hook = createHook({
      init: (asyncId, type, triggerAsyncId) => {
        this.triggerByAsyncId.set(asyncId, triggerAsyncId);
        const lane = this.laneForInit(type, triggerAsyncId);
        if (lane) {
          this.laneByAsyncId.set(asyncId, lane);
        }
        if (type === "PROMISE" && lane === "0") {
          this.currentRootPromiseId = asyncId;
          this.freshRootPromiseId = asyncId;
        }
      }
    });
    this.hook.enable();
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.storage.run({ lane: "0" }, () => {
      this.laneByAsyncId.set(executionAsyncId(), "0");
      return fn();
    });
  }

  currentLane(): string {
    const storeLane = this.storage.getStore()?.lane;
    if (storeLane && storeLane !== "0") {
      return storeLane;
    }
    const syncLane = this.currentSyncBranchLane();
    if (syncLane) {
      return syncLane;
    }
    const nearestLane = this.nearestAsyncLane(executionAsyncId(), true);
    if (nearestLane && (this.activeByLane.get(nearestLane) ?? 0) === 0) {
      return nearestLane;
    }
    if (this.freshRootPromiseId !== undefined && this.freshRootPromiseId === this.currentRootPromiseId) {
      return storeLane ?? "0";
    }
    return nearestLane ?? storeLane ?? "0";
  }

  withLane<T>(lane: string, fn: () => T): T {
    return this.storage.run({ lane }, () => {
      const asyncId = executionAsyncId();
      if (asyncId !== 0) {
        this.laneByAsyncId.set(asyncId, lane);
      }
      try {
        return fn();
      } finally {
        if (this.syncBranch?.lane === lane) {
          this.syncBranch = undefined;
        }
      }
    });
  }

  beginBoundaryLane(_branchKey?: string): string {
    const parent = this.currentLane();
    const parentActive = this.activeByLane.get(parent) ?? 0;
    const lane =
      parent === "0"
        ? this.nextChildLane("0")
        : parentActive > 0
          ? this.nextChildLane(parent)
          : parent;
    this.activeByLane.set(lane, (this.activeByLane.get(lane) ?? 0) + 1);
    if (parent === "0") {
      this.claimCurrentBranch(lane);
    }
    return lane;
  }

  endBoundaryLane(lane: string): void {
    const next = Math.max(0, (this.activeByLane.get(lane) ?? 0) - 1);
    if (next === 0) {
      this.activeByLane.delete(lane);
    } else {
      this.activeByLane.set(lane, next);
    }
  }

  nextSeq(lane = this.currentLane()): number {
    const next = this.seqByLane.get(lane) ?? 0;
    this.seqByLane.set(lane, next + 1);
    return next;
  }

  lastSeq(lane = this.currentLane()): number {
    return (this.seqByLane.get(lane) ?? 0) - 1;
  }

  nextStep(): number {
    const next = this.step;
    this.step += 1;
    return next;
  }

  lastStep(): number {
    return this.step - 1;
  }

  setNextStep(step: number): void {
    this.step = step;
  }

  private nextChildLane(parent: string): string {
    const next = this.childOrdinalByLane.get(parent) ?? 1;
    this.childOrdinalByLane.set(parent, next + 1);
    return `${parent}.${next}`;
  }

  private claimCurrentBranch(lane: string): void {
    const promiseId = this.currentRootPromiseId;
    if (promiseId !== undefined) {
      this.laneByAsyncId.set(promiseId, lane);
      this.syncBranch = { promiseId, lane };
      if (this.freshRootPromiseId === promiseId) {
        this.freshRootPromiseId = undefined;
      }
    }
  }

  private laneForInit(type: string, triggerAsyncId: number): string | undefined {
    const storeLane = this.storage.getStore()?.lane;
    if (storeLane && storeLane !== "0") {
      return storeLane;
    }
    const inherited = this.nearestAsyncLane(triggerAsyncId, true);
    if (inherited && !(storeLane === "0" && type === "PROMISE" && (this.activeByLane.get(inherited) ?? 0) > 0)) {
      return inherited;
    }
    if (type !== "PROMISE") {
      const syncLane = this.currentSyncBranchLane();
      if (syncLane) {
        return syncLane;
      }
    }
    return storeLane ?? this.nearestAsyncLane(triggerAsyncId, false);
  }

  private currentSyncBranchLane(): string | undefined {
    if (!this.syncBranch || this.syncBranch.promiseId !== this.currentRootPromiseId) {
      return undefined;
    }
    return this.syncBranch.lane;
  }

  private nearestAsyncLane(asyncId: number, preferNonRoot: boolean): string | undefined {
    let current: number | undefined = asyncId;
    let rootLane: string | undefined;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const lane = this.laneByAsyncId.get(current);
      if (lane && lane !== "0") {
        return lane;
      }
      if (lane) {
        rootLane = lane;
      }
      current = this.triggerByAsyncId.get(current);
    }
    return preferNonRoot ? undefined : rootLane;
  }
}

export function deriveCallSite(explicit: string | undefined, kind: "model_call" | "tool_call", lane: string, ordinal: number): string {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  const stack = new Error().stack;
  if (stack) {
    const frames = stack
      .split("\n")
      .slice(3, 8)
      .map((line) => normalizeFrame(line))
      .filter((line) => line.length > 0);
    if (frames.length > 0) {
      return frames.join("|");
    }
  }
  return `${kind}:${lane}:${ordinal}`;
}

function normalizeFrame(frame: string): string {
  return frame
    .trim()
    .replace(/\((.*?)([^/()]+):\d+:\d+\)/, "($2)")
    .replace(/(file:\/\/)?(.*?)([^/\s]+):\d+:\d+/, "$3")
    .replace(/\s+/g, " ");
}

import type { ModelCallEvent, NormalizedMessage, RewindEvent, Usage } from "./events.js";

const tokenizers = new Map<string, (messages: NormalizedMessage[]) => number>();

export interface ContextDiff {
  added: NormalizedMessage[];
  removed: NormalizedMessage[];
  tokenDelta: number;
  tokenDeltaIsEstimate: boolean;
}

export interface TokenizerRegistry {
  register(model: string, tokenizer: (messages: NormalizedMessage[]) => number): void;
}

export interface StepUsage {
  step: number;
  usage: Usage;
}

export function registerTokenizer(model: string, tokenizer: (messages: NormalizedMessage[]) => number): void {
  tokenizers.set(model, tokenizer);
}

export function tokenizerRegistry(): TokenizerRegistry {
  return { register: registerTokenizer };
}

export function usageAdd(a: Usage, b: Usage | undefined): Usage {
  if (!b) {
    return a;
  }
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) } : {})
  };
}

export function usageForEvent(event: RewindEvent): Usage | undefined {
  return event.kind === "model_call" ? event.usage ?? event.response?.usage : undefined;
}

export function usageByStep(events: RewindEvent[]): StepUsage[] {
  return events
    .map((event) => ({ step: event.step, usage: usageForEvent(event) }))
    .filter((item): item is StepUsage => item.usage !== undefined);
}

export function usageTotal(events: RewindEvent[]): Usage {
  return usageByStep(events).reduce((total, item) => usageAdd(total, item.usage), {
    inputTokens: 0,
    outputTokens: 0
  });
}

export function diffMessages(a: ModelCallEvent, b: ModelCallEvent): ContextDiff {
  const before = a.request.messages;
  const after = b.request.messages;
  const removed = before.filter((message) => !after.some((candidate) => deepEqual(candidate, message)));
  const added = after.filter((message) => !before.some((candidate) => deepEqual(candidate, message)));
  const beforeTokens = countMessages(a.request.model, before, a.usage);
  const afterTokens = countMessages(b.request.model, after, b.usage);
  return {
    added,
    removed,
    tokenDelta: afterTokens.count - beforeTokens.count,
    tokenDeltaIsEstimate: beforeTokens.estimated || afterTokens.estimated
  };
}

export function countMessages(
  model: string,
  messages: NormalizedMessage[],
  usage?: Usage
): { count: number; estimated: boolean } {
  if (usage) {
    return { count: usage.inputTokens, estimated: false };
  }
  const tokenizer = tokenizers.get(model);
  if (tokenizer) {
    return { count: tokenizer(messages), estimated: false };
  }
  return { count: Math.ceil(JSON.stringify(messages).length / 4), estimated: true };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

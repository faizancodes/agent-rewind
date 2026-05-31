import type { EntropyEvent, ModelCallEvent, NormalizedMessage, RewindEvent, ToolCallEvent } from "./events.js";
import { readSession, resolveSessionPath, type SessionSelectorOptions } from "./session-store.js";
import { diffMessages, type ContextDiff } from "./tokens.js";

export interface PromptContextOptions extends SessionSelectorOptions {
  /** Model-call step. Defaults to the first model call. */
  step?: number;
  /** Stable model-call site name from `ctx.model.create(..., { site })`. */
  site?: string;
}

export interface PromptDiffOptions extends SessionSelectorOptions {
  /** Left model-call step. Defaults to the first model call. */
  from?: number;
  /** Right model-call step. Defaults to the next model call after `from`, or the second model call. */
  to?: number;
  /** Left stable model-call site name. */
  fromSite?: string;
  /** Right stable model-call site name. */
  toSite?: string;
}

export interface ToolCallInspectionOptions extends SessionSelectorOptions {
  /** Tool-call step. Defaults to the first tool call. */
  step?: number;
  /** Tool name from `ctx.tools.<name>()`. Must be unique in the session unless `step` is used. */
  name?: string;
}

export interface EntropyInspectionOptions extends SessionSelectorOptions {
  /** Entropy step. Defaults to the first entropy draw. */
  step?: number;
  /** Entropy source from `ctx.clock()`, `ctx.random()`, or `ctx.uuid()`. Must be unique unless `step` is used. */
  source?: EntropyEvent["source"];
}

export async function readPromptContext(selector: string, opts: PromptContextOptions = {}): Promise<NormalizedMessage[]> {
  const sessionPath = await resolveSessionPath(selector, opts);
  const stored = await readSession(sessionPath);
  return modelEventForContext(stored.events, opts, sessionPath).request.messages;
}

export async function diffPromptContext(selector: string, opts: PromptDiffOptions = {}): Promise<ContextDiff> {
  const sessionPath = await resolveSessionPath(selector, opts);
  const stored = await readSession(sessionPath);
  const [left, right] = modelEventsForDiff(stored.events, opts, sessionPath);
  return diffMessages(left, right);
}

export async function readToolCall(selector: string, opts: ToolCallInspectionOptions = {}): Promise<ToolCallEvent> {
  const sessionPath = await resolveSessionPath(selector, opts);
  const stored = await readSession(sessionPath);
  return toolCallForInspection(stored.events, opts, sessionPath);
}

export async function readEntropyDraw(selector: string, opts: EntropyInspectionOptions = {}): Promise<EntropyEvent> {
  const sessionPath = await resolveSessionPath(selector, opts);
  const stored = await readSession(sessionPath);
  return entropyDrawForInspection(stored.events, opts, sessionPath);
}

export function modelEventForContext(events: RewindEvent[], selection: PromptContextOptions = {}, session = "<session>"): ModelCallEvent {
  if (selection.step !== undefined && selection.site !== undefined) {
    throw new TypeError("Use either step or site for prompt context, not both.");
  }
  if (selection.step !== undefined) {
    return modelEventAt(events, selection.step);
  }
  const modelEvents = events.filter((candidate): candidate is ModelCallEvent => candidate.kind === "model_call");
  if (selection.site !== undefined) {
    return modelEventBySite(modelEvents, selection.site, "step", session);
  }
  const event = modelEvents[0];
  if (!event) {
    throw new RangeError(`Session has no model-call steps. Run agentrewind inspect ${session} to see the recorded timeline.`);
  }
  return event;
}

export function modelEventsForDiff(events: RewindEvent[], selection: PromptDiffOptions = {}, session = "<session>"): [ModelCallEvent, ModelCallEvent] {
  if (selection.from !== undefined && selection.fromSite !== undefined) {
    throw new TypeError("Use either from or fromSite for prompt diff, not both.");
  }
  if (selection.to !== undefined && selection.toSite !== undefined) {
    throw new TypeError("Use either to or toSite for prompt diff, not both.");
  }

  const modelEvents = events.filter((candidate): candidate is ModelCallEvent => candidate.kind === "model_call");
  const left = selectedModelEvent(events, modelEvents, selection.from, selection.fromSite, "from", session);
  const right = selectedModelEvent(events, modelEvents, selection.to, selection.toSite, "to", session);

  if (left && right) {
    return [left, right];
  }

  if (left) {
    const next = modelEvents.find((event) => event.step > left.step);
    if (!next) {
      throw new RangeError(`No later model-call step after ${left.step}. Pass to, toSite, or run agentrewind inspect ${session}.`);
    }
    return [left, next];
  }

  if (right) {
    const previous = [...modelEvents].reverse().find((event) => event.step < right.step);
    if (!previous) {
      throw new RangeError(`No earlier model-call step before ${right.step}. Pass from, fromSite, or run agentrewind inspect ${session}.`);
    }
    return [previous, right];
  }

  const first = modelEvents[0];
  const second = modelEvents[1];
  if (!first || !second) {
    throw new RangeError(`Session needs at least two model-call steps for prompt diff. Run agentrewind inspect ${session} to see the recorded timeline.`);
  }
  return [first, second];
}

export function toolCallForInspection(events: RewindEvent[], selection: ToolCallInspectionOptions = {}, session = "<session>"): ToolCallEvent {
  if (selection.step !== undefined && selection.name !== undefined) {
    throw new TypeError("Use either step or name for tool inspection, not both.");
  }
  const toolEvents = events.filter((candidate): candidate is ToolCallEvent => candidate.kind === "tool_call");
  if (selection.step !== undefined) {
    const event = events.find((candidate) => candidate.step === selection.step);
    if (!event) {
      throw new RangeError(`No event at step ${selection.step}`);
    }
    if (event.kind !== "tool_call") {
      throw new RangeError(`Step ${selection.step} is not a tool call`);
    }
    return event;
  }
  if (selection.name !== undefined) {
    const matches = toolEvents.filter((event) => event.name === selection.name);
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      const steps = matches.map((event) => event.step).join(", ");
      throw new RangeError(`Tool "${selection.name}" is ambiguous; matching steps: ${steps}. Use step after running agentrewind inspect ${session}.`);
    }
    const available = uniqueToolNames(toolEvents);
    throw new RangeError(
      `No tool call named "${selection.name}".${available.length > 0 ? ` Available tools: ${available.join(", ")}.` : ""} Run agentrewind inspect ${session}.`
    );
  }
  const event = toolEvents[0];
  if (!event) {
    throw new RangeError(`Session has no tool-call steps. Run agentrewind inspect ${session} to see the recorded timeline.`);
  }
  return event;
}

export function entropyDrawForInspection(events: RewindEvent[], selection: EntropyInspectionOptions = {}, session = "<session>"): EntropyEvent {
  if (selection.step !== undefined && selection.source !== undefined) {
    throw new TypeError("Use either step or source for entropy inspection, not both.");
  }
  const entropyEvents = events.filter((candidate): candidate is EntropyEvent => candidate.kind === "entropy");
  if (selection.step !== undefined) {
    const event = events.find((candidate) => candidate.step === selection.step);
    if (!event) {
      throw new RangeError(`No event at step ${selection.step}`);
    }
    if (event.kind !== "entropy") {
      throw new RangeError(`Step ${selection.step} is not an entropy draw`);
    }
    return event;
  }
  if (selection.source !== undefined) {
    const matches = entropyEvents.filter((event) => event.source === selection.source);
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      const steps = matches.map((event) => event.step).join(", ");
      throw new RangeError(`Entropy source "${selection.source}" is ambiguous; matching steps: ${steps}. Use step after running agentrewind inspect ${session}.`);
    }
    const available = uniqueEntropySources(entropyEvents);
    throw new RangeError(
      `No entropy draw from "${selection.source}".${available.length > 0 ? ` Available sources: ${available.join(", ")}.` : ""} Run agentrewind inspect ${session}.`
    );
  }
  const event = entropyEvents[0];
  if (!event) {
    throw new RangeError(`Session has no entropy draws. Run agentrewind inspect ${session} to see the recorded timeline.`);
  }
  return event;
}

function selectedModelEvent(
  events: RewindEvent[],
  modelEvents: ModelCallEvent[],
  step: number | undefined,
  site: string | undefined,
  stepName: "from" | "to",
  session: string
): ModelCallEvent | undefined {
  if (step !== undefined) {
    return modelEventAt(events, step);
  }
  if (site !== undefined) {
    return modelEventBySite(modelEvents, site, stepName, session);
  }
  return undefined;
}

function modelEventAt(events: RewindEvent[], step: number): ModelCallEvent {
  const event = events.find((candidate) => candidate.step === step);
  if (!event) {
    throw new RangeError(`No event at step ${step}`);
  }
  if (event.kind !== "model_call") {
    throw new RangeError(`Step ${step} is not a model call`);
  }
  return event;
}

function modelEventBySite(modelEvents: ModelCallEvent[], site: string, stepName: "step" | "from" | "to", session: string): ModelCallEvent {
  const matches = modelEvents.filter((event) => event.callSite === site);
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    const steps = matches.map((event) => event.step).join(", ");
    throw new RangeError(`Model-call site "${site}" is ambiguous; matching steps: ${steps}. Use ${stepName} after running agentrewind inspect ${session}.`);
  }
  const available = uniqueModelSites(modelEvents);
  throw new RangeError(
    `No model-call site "${site}".${available.length > 0 ? ` Available model sites: ${available.join(", ")}.` : ""} Run agentrewind inspect ${session}.`
  );
}

function uniqueModelSites(modelEvents: ModelCallEvent[]): string[] {
  return [...new Set(modelEvents.map((event) => event.callSite).filter((site) => site.length > 0))].sort((a, b) => a.localeCompare(b));
}

function uniqueToolNames(toolEvents: ToolCallEvent[]): string[] {
  return [...new Set(toolEvents.map((event) => event.name).filter((name) => name.length > 0))].sort((a, b) => a.localeCompare(b));
}

function uniqueEntropySources(entropyEvents: EntropyEvent[]): string[] {
  return [...new Set(entropyEvents.map((event) => event.source))].sort((a, b) => a.localeCompare(b));
}

import type {
  ChunkRecord,
  ForkOverrides,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  ProviderCodec,
  Usage
} from "@agentrewind/core";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessage,
  ChatCompletionMessageToolCall,
  ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import type { CompletionUsage } from "openai/resources/completions";

type OpenAIMessageRole = NormalizedMessage["role"];

interface MessageContentWithFields {
  content?: unknown;
  [key: string]: unknown;
}

interface ChoiceState {
  index: number;
  message: ChatCompletionMessage & { content: string | null };
  toolCalls: ToolCallAccumulator[];
  finishReason: ChatCompletion.Choice["finish_reason"] | null;
  logprobs: ChatCompletion.Choice["logprobs"];
}

interface ToolCallAccumulator {
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export function openAIChatCodec(): ProviderCodec<ChatCompletionCreateParamsBase, ChatCompletion, ChatCompletionChunk> {
  return {
    name: "openai-chat",
    interceptPoints: ["chat.completions.create", "chat.completions.stream"],
    normalizeRequest,
    denormalizeRequest,
    normalizeResponse,
    normalizeStream,
    rebuildStream,
    stripVolatile,
    volatileLeafPaths: () => ["params.metadata.*"],
    extractUsage: (resp) => resp.usage,
    applyOverrides
  };
}

export const openAIProviderCodec = openAIChatCodec();
export const openAICompatibleCodec = openAIChatCodec;
export const openaiChatCodec = openAIChatCodec;
export const openaiProviderCodec = openAIProviderCodec;

function normalizeRequest(raw: unknown): NormalizedRequest {
  const req = raw as ChatCompletionCreateParamsBase;
  const { model, messages, ...params } = req;
  const normalizedMessages = messages.map(normalizeMessage);
  const system = normalizedMessages.find(
    (message) => (message.role === "developer" || message.role === "system") && typeof message.content === "string"
  )?.content;
  return {
    model: String(model),
    ...(typeof system === "string" ? { system } : {}),
    messages: normalizedMessages,
    params
  };
}

function denormalizeRequest(req: NormalizedRequest): unknown {
  const messages = req.messages.map(denormalizeMessage);
  applySystemOverride(messages, req.system);
  return {
    ...req.params,
    model: req.model,
    messages
  } as ChatCompletionCreateParamsBase;
}

function normalizeResponse(raw: unknown): NormalizedResponse {
  const completion = raw as ChatCompletion;
  return {
    content: contentFromChoices(completion.choices),
    stopReason: completion.choices[0]?.finish_reason ?? undefined,
    usage: normalizeUsage(completion.usage),
    raw: completion
  };
}

function normalizeStream(rawChunks: unknown[]): { final: NormalizedResponse; chunks: ChunkRecord[] } {
  const chunks = rawChunks as ChatCompletionChunk[];
  const final = assembleCompletion(chunks);
  return {
    final: normalizeResponse(final),
    chunks: chunks.map((chunk, index) => ({ offsetMs: index, data: chunk }))
  };
}

async function* rebuildStream(chunks: ChunkRecord[]): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) {
    yield chunk.data as ChatCompletionChunk;
  }
}

function stripVolatile(req: NormalizedRequest): NormalizedRequest {
  const clone = JSON.parse(JSON.stringify(req)) as NormalizedRequest;
  delete clone.params.metadata;
  return clone;
}

function applyOverrides(req: NormalizedRequest, overrides: ForkOverrides, step: number): NormalizedRequest {
  const base: NormalizedRequest = {
    ...req,
    messages: req.messages.map((message) => ({ ...message })),
    params: { ...req.params }
  };
  if (overrides.system !== undefined) {
    base.system = overrides.system;
  }
  if (overrides.model !== undefined) {
    base.model = overrides.model;
  }
  return overrides.transformRequest ? overrides.transformRequest(base, step) : base;
}

function normalizeMessage(message: ChatCompletionMessageParam): NormalizedMessage {
  const { role, content, ...rest } = message as ChatCompletionMessageParam & { content?: unknown };
  const extra = rest as Record<string, unknown>;
  return {
    role: normalizeRole(role),
    content: Object.keys(extra).length === 0 ? content : { content, ...extra }
  };
}

function denormalizeMessage(message: NormalizedMessage): ChatCompletionMessageParam {
  const role = denormalizeRole(message.role);
  if (isMessageContentWithFields(message.content)) {
    return { role, ...message.content } as ChatCompletionMessageParam;
  }
  return { role, content: message.content } as ChatCompletionMessageParam;
}

function normalizeRole(role: string): OpenAIMessageRole {
  if (role === "developer" || role === "system" || role === "user" || role === "assistant" || role === "tool" || role === "function") {
    return role;
  }
  return "user";
}

function denormalizeRole(role: OpenAIMessageRole): ChatCompletionMessageParam["role"] {
  return role;
}

function isMessageContentWithFields(value: unknown): value is MessageContentWithFields {
  return value !== null && typeof value === "object" && !Array.isArray(value) && "content" in value;
}

function applySystemOverride(messages: ChatCompletionMessageParam[], system: string | undefined): void {
  if (system === undefined) {
    return;
  }
  const existing = messages.find((message) => message.role === "developer" || message.role === "system");
  if (existing) {
    (existing as { content: unknown }).content = system;
    return;
  }
  messages.unshift({ role: "system", content: system });
}

function contentFromChoices(choices: ChatCompletion.Choice[]): unknown {
  const messages = choices.map((choice) => choice.message);
  return messages.length === 1 ? messages[0] : messages;
}

function normalizeUsage(usage: CompletionUsage | null | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens
  };
}

function assembleCompletion(chunks: ChatCompletionChunk[]): ChatCompletion {
  const first = chunks[0];
  if (!first) {
    throw new TypeError("OpenAI chat stream did not include any chunks");
  }
  const states = new Map<number, ChoiceState>();
  let usage: CompletionUsage | undefined;
  let serviceTier: ChatCompletion["service_tier"] | undefined;
  let systemFingerprint: string | undefined;

  for (const chunk of chunks) {
    usage = chunk.usage ?? usage;
    serviceTier = chunk.service_tier ?? serviceTier;
    systemFingerprint = chunk.system_fingerprint ?? systemFingerprint;
    for (const choice of chunk.choices) {
      const state = stateForChoice(states, choice.index);
      state.finishReason = choice.finish_reason ?? state.finishReason;
      state.logprobs = mergeLogprobs(state.logprobs, choice.logprobs);
      applyDelta(state, choice.delta);
    }
  }

  return {
    id: first.id,
    object: "chat.completion",
    created: first.created,
    model: first.model,
    choices: [...states.values()]
      .sort((left, right) => left.index - right.index)
      .map((state) => ({
        index: state.index,
        finish_reason: state.finishReason ?? "stop",
        logprobs: state.logprobs,
        message: finalizeMessage(state.message)
      })),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
    ...(systemFingerprint !== undefined ? { system_fingerprint: systemFingerprint } : {}),
    ...(usage ? { usage } : {})
  };
}

function stateForChoice(states: Map<number, ChoiceState>, index: number): ChoiceState {
  const existing = states.get(index);
  if (existing) {
    return existing;
  }
  const created: ChoiceState = {
    index,
    message: { role: "assistant", content: null, refusal: null },
    toolCalls: [],
    finishReason: null,
    logprobs: null
  };
  states.set(index, created);
  return created;
}

function applyDelta(state: ChoiceState, delta: ChatCompletionChunk.Choice.Delta): void {
  if (delta.role) {
    state.message.role = delta.role === "assistant" ? "assistant" : state.message.role;
  }
  if (delta.content !== undefined && delta.content !== null) {
    state.message.content = `${state.message.content ?? ""}${delta.content}`;
  }
  if (delta.refusal !== undefined && delta.refusal !== null) {
    state.message.refusal = `${state.message.refusal ?? ""}${delta.refusal}`;
  }
  if (delta.function_call) {
    const current = state.message.function_call ?? { name: "", arguments: "" };
    state.message.function_call = {
      name: `${current.name ?? ""}${delta.function_call.name ?? ""}`,
      arguments: `${current.arguments ?? ""}${delta.function_call.arguments ?? ""}`
    };
  }
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const target = state.toolCalls[toolCall.index] ?? {};
      target.id = toolCall.id ?? target.id;
      target.type = toolCall.type ?? target.type;
      if (toolCall.function) {
        target.function = {
          name: `${target.function?.name ?? ""}${toolCall.function.name ?? ""}`,
          arguments: `${target.function?.arguments ?? ""}${toolCall.function.arguments ?? ""}`
        };
      }
      state.toolCalls[toolCall.index] = target;
    }
    state.message.tool_calls = state.toolCalls.flatMap((toolCall): ChatCompletionMessageToolCall[] => {
      if (typeof toolCall.id !== "string" || toolCall.type !== "function" || !toolCall.function) {
        return [];
      }
      return [
        {
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.function.name ?? "",
            arguments: toolCall.function.arguments ?? ""
          }
        }
      ];
    });
  }
}

function mergeLogprobs(
  current: ChatCompletion.Choice["logprobs"],
  incoming: ChatCompletionChunk.Choice["logprobs"] | null | undefined
): ChatCompletion.Choice["logprobs"] {
  if (!incoming) {
    return current;
  }
  if (!current) {
    return cloneJson(incoming) as ChatCompletion.Choice["logprobs"];
  }
  const out = { ...(current as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(incoming as unknown as Record<string, unknown>)) {
    const existing = out[key];
    out[key] = Array.isArray(existing) && Array.isArray(value) ? [...existing, ...value] : value;
  }
  return out as unknown as ChatCompletion.Choice["logprobs"];
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function finalizeMessage(message: ChatCompletionMessage & { content: string | null }): ChatCompletionMessage {
  return {
    ...message,
    content: message.content === "" ? null : message.content
  };
}

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
  ContentBlock,
  Message,
  MessageCreateParamsBase,
  MessageParam,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageDeltaEvent,
  RawMessageStartEvent,
  RawMessageStreamEvent
} from "@anthropic-ai/sdk/resources/messages/messages";

export function anthropicCodec(): ProviderCodec<MessageCreateParamsBase, Message, RawMessageStreamEvent> {
  return {
    name: "anthropic",
    interceptPoints: ["messages.create", "messages.stream"],
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

export const anthropicProviderCodec = anthropicCodec();

function normalizeRequest(raw: unknown): NormalizedRequest {
  const req = raw as MessageCreateParamsBase;
  const { model, messages, system, ...params } = req;
  return {
    model: String(model),
    ...(typeof system === "string" ? { system } : {}),
    messages: messages.map(normalizeMessage),
    params: {
      ...params,
      ...(system && typeof system !== "string" ? { system } : {})
    }
  };
}

function denormalizeRequest(req: NormalizedRequest): unknown {
  const { system, messages, model, params } = req;
  return {
    ...params,
    model,
    messages: messages.filter((message) => message.role !== "system").map(denormalizeMessage),
    ...(system !== undefined ? { system } : {})
  } as MessageCreateParamsBase;
}

function normalizeResponse(raw: unknown): NormalizedResponse {
  const message = raw as Message;
  return {
    content: message.content,
    stopReason: message.stop_reason ?? undefined,
    usage: normalizeUsage(message.usage),
    raw: message
  };
}

function normalizeStream(rawChunks: unknown[]): { final: NormalizedResponse; chunks: ChunkRecord[] } {
  const events = rawChunks as RawMessageStreamEvent[];
  const message = assembleMessage(events);
  return {
    final: normalizeResponse(message),
    chunks: events.map((event, index) => ({ offsetMs: index, data: event }))
  };
}

async function* rebuildStream(chunks: ChunkRecord[]): AsyncIterable<RawMessageStreamEvent> {
  for (const chunk of chunks) {
    yield chunk.data as RawMessageStreamEvent;
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

function normalizeMessage(message: MessageParam): NormalizedMessage {
  return {
    role: message.role,
    content: message.content
  };
}

function denormalizeMessage(message: NormalizedMessage): MessageParam {
  if (message.role !== "user" && message.role !== "assistant") {
    throw new TypeError(`Anthropic Messages API does not accept ${message.role} input messages`);
  }
  return {
    role: message.role,
    content: message.content as MessageParam["content"]
  };
}

function normalizeUsage(usage: Message["usage"] | RawMessageDeltaEvent["usage"] | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens:
      "input_tokens" in usage
        ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
        : 0,
    outputTokens: usage.output_tokens
  };
}

function assembleMessage(events: RawMessageStreamEvent[]): Message {
  const start = events.find((event): event is RawMessageStartEvent => event.type === "message_start");
  if (!start) {
    throw new TypeError("Anthropic stream did not include a message_start event");
  }
  const message: Message = JSON.parse(JSON.stringify(start.message)) as Message;
  const content: ContentBlock[] = [];
  for (const event of events) {
    if (event.type === "content_block_start") {
      const startEvent = event as RawContentBlockStartEvent;
      content[startEvent.index] = JSON.parse(JSON.stringify(startEvent.content_block)) as ContentBlock;
    } else if (event.type === "content_block_delta") {
      applyDelta(content, event as RawContentBlockDeltaEvent);
    } else if (event.type === "message_delta") {
      const delta = event as RawMessageDeltaEvent;
      message.stop_reason = delta.delta.stop_reason;
      message.stop_sequence = delta.delta.stop_sequence;
      message.stop_details = delta.delta.stop_details;
      message.container = delta.delta.container;
      message.usage = {
        ...message.usage,
        output_tokens: delta.usage.output_tokens
      };
    }
  }
  message.content = content.filter((block): block is ContentBlock => Boolean(block)).map(finalizeContentBlock);
  return message;
}

function applyDelta(content: ContentBlock[], event: RawContentBlockDeltaEvent): void {
  const block = content[event.index] as Record<string, unknown> | undefined;
  if (!block) {
    return;
  }
  switch (event.delta.type) {
    case "text_delta":
      block.text = `${typeof block.text === "string" ? block.text : ""}${event.delta.text}`;
      return;
    case "input_json_delta":
      block.input = `${typeof block.input === "string" ? block.input : ""}${event.delta.partial_json}`;
      return;
    case "thinking_delta":
      block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${event.delta.thinking}`;
      return;
    case "signature_delta":
      block.signature = `${typeof block.signature === "string" ? block.signature : ""}${event.delta.signature}`;
      return;
    case "citations_delta":
      block.citations = [...(Array.isArray(block.citations) ? block.citations : []), event.delta.citation];
      return;
  }
}

function finalizeContentBlock(block: ContentBlock): ContentBlock {
  if (block.type === "tool_use" && typeof block.input === "string") {
    return {
      ...block,
      input: block.input.length === 0 ? {} : JSON.parse(block.input)
    };
  }
  return block;
}

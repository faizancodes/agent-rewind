import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase
} from "openai/resources/chat/completions";
import type { Message, MessageCreateParamsBase, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages/messages";
import { AgentRewind, type BoundAgentRewind, type ToolHandlers, type UntypedToolHandlers } from "@agentrewind/core";
import { anthropicCodec } from "@agentrewind/codec-anthropic";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import { openRouterChatCodec, openRouterClientOptions, type OpenRouterClientOptions } from "@agentrewind/codec-openrouter";

export interface RewindPresetOptions<TTools extends ToolHandlers = UntypedToolHandlers> {
  /** Default session store for the returned helper. Defaults to `.rewind`. */
  store?: string;
  /** Default tools carried into record/replay helpers. */
  tools?: TTools;
}

export interface OpenAIRewindOptions<TTools extends ToolHandlers = UntypedToolHandlers> extends RewindPresetOptions<TTools> {
  /** Existing OpenAI SDK client. Pass this when your app already constructed one. */
  client?: OpenAI;
  /** API key used when `client` is omitted. Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Extra OpenAI SDK constructor options used when `client` is omitted. */
  clientOptions?: ConstructorParameters<typeof OpenAI>[0];
}

export interface OpenAICompatibleRewindOptions<TTools extends ToolHandlers = UntypedToolHandlers>
  extends RewindPresetOptions<TTools> {
  /** Existing OpenAI-compatible SDK client. Pass this when your app already constructed one. */
  client?: OpenAI;
  /** API key used when `client` is omitted. Defaults to `process.env.COMPATIBLE_API_KEY`. */
  apiKey?: string;
  /** OpenAI-compatible base URL used when `client` is omitted. Defaults to `process.env.COMPATIBLE_BASE_URL`. */
  baseURL?: string;
  /** Extra OpenAI SDK constructor options used when `client` is omitted. */
  clientOptions?: ConstructorParameters<typeof OpenAI>[0];
}

export interface OpenRouterRewindOptions<TTools extends ToolHandlers = UntypedToolHandlers>
  extends RewindPresetOptions<TTools>,
    OpenRouterClientOptions {
  /** Existing OpenAI SDK client configured for OpenRouter. Pass this when your app already constructed one. */
  client?: OpenAI;
}

export interface AnthropicRewindOptions<TTools extends ToolHandlers = UntypedToolHandlers> extends RewindPresetOptions<TTools> {
  /** Existing Anthropic SDK client. Pass this when your app already constructed one. */
  client?: Anthropic;
  /** API key used when `client` is omitted. Defaults to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Extra Anthropic SDK constructor options used when `client` is omitted. */
  clientOptions?: ConstructorParameters<typeof Anthropic>[0];
}

export function createOpenAIRewind<TTools extends ToolHandlers = UntypedToolHandlers>(
  options: OpenAIRewindOptions<TTools> = {}
): BoundAgentRewind<TTools, ChatCompletionCreateParamsBase, ChatCompletion, ChatCompletionChunk> {
  return AgentRewind.withProvider({
    store: options.store,
    model: options.client ?? new OpenAI({ ...(options.clientOptions ?? {}), apiKey: options.apiKey ?? process.env.OPENAI_API_KEY }),
    codec: openaiChatCodec(),
    ...(options.tools ? { tools: options.tools } : {})
  });
}

export function createOpenAICompatibleRewind<TTools extends ToolHandlers = UntypedToolHandlers>(
  options: OpenAICompatibleRewindOptions<TTools> = {}
): BoundAgentRewind<TTools, ChatCompletionCreateParamsBase, ChatCompletion, ChatCompletionChunk> {
  return AgentRewind.withProvider({
    store: options.store,
    model:
      options.client ??
      new OpenAI({
        ...(options.clientOptions ?? {}),
        apiKey: options.apiKey ?? process.env.COMPATIBLE_API_KEY,
        baseURL: options.baseURL ?? process.env.COMPATIBLE_BASE_URL
      }),
    codec: openaiChatCodec(),
    ...(options.tools ? { tools: options.tools } : {})
  });
}

export function createOpenRouterRewind<TTools extends ToolHandlers = UntypedToolHandlers>(
  options: OpenRouterRewindOptions<TTools> = {}
): BoundAgentRewind<TTools, ChatCompletionCreateParamsBase, ChatCompletion, ChatCompletionChunk> {
  return AgentRewind.withProvider({
    store: options.store,
    model:
      options.client ??
      new OpenAI(
        openRouterClientOptions({
          ...options,
          apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY
        })
      ),
    codec: openRouterChatCodec(),
    ...(options.tools ? { tools: options.tools } : {})
  });
}

export function createAnthropicRewind<TTools extends ToolHandlers = UntypedToolHandlers>(
  options: AnthropicRewindOptions<TTools> = {}
): BoundAgentRewind<TTools, MessageCreateParamsBase, Message, RawMessageStreamEvent> {
  return AgentRewind.withProvider({
    store: options.store,
    model: options.client ?? new Anthropic({ ...(options.clientOptions ?? {}), apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY }),
    codec: anthropicCodec(),
    ...(options.tools ? { tools: options.tools } : {})
  });
}

export const createOpenAIChatRewind = createOpenAIRewind;
export const createOpenAICompatibleChatRewind = createOpenAICompatibleRewind;
export const createOpenRouterChatRewind = createOpenRouterRewind;
export const createAnthropicMessagesRewind = createAnthropicRewind;

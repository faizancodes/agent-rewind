import type { ProviderCodec } from "@agentrewind/core";
import { openaiChatCodec } from "@agentrewind/codec-openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase
} from "openai/resources/chat/completions";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterClientOptions {
  apiKey?: string;
  appUrl?: string;
  appTitle?: string;
  appCategories?: string | string[];
  extraHeaders?: Record<string, string>;
}

export interface OpenRouterOpenAIClientOptions {
  apiKey?: string;
  baseURL: typeof OPENROUTER_BASE_URL;
  defaultHeaders?: Record<string, string>;
}

export function openRouterChatCodec(): ProviderCodec<ChatCompletionCreateParamsBase, ChatCompletion, ChatCompletionChunk> {
  return {
    ...openaiChatCodec(),
    name: "openrouter-chat"
  };
}

export function openRouterClientOptions(options: OpenRouterClientOptions = {}): OpenRouterOpenAIClientOptions {
  const defaultHeaders: Record<string, string> = { ...(options.extraHeaders ?? {}) };
  if (options.appUrl) {
    defaultHeaders["HTTP-Referer"] = options.appUrl;
  }
  if (options.appTitle) {
    defaultHeaders["X-OpenRouter-Title"] = options.appTitle;
  }
  if (options.appCategories) {
    defaultHeaders["X-OpenRouter-Categories"] = Array.isArray(options.appCategories)
      ? options.appCategories.join(",")
      : options.appCategories;
  }

  return {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    baseURL: OPENROUTER_BASE_URL,
    ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {})
  };
}

export const openRouterProviderCodec = openRouterChatCodec();
export const openrouterChatCodec = openRouterChatCodec;
export const openrouterProviderCodec = openRouterProviderCodec;

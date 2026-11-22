// OpenRouter and a LiteLLM proxy both serve the OpenAI chat completions API;
// they differ in how reasoning effort is asked for and how cost comes back.

import type { HttpInit, HttpResponse } from 'claude-code'

import type { Provider, ThinkingLevel } from './config'

export type HttpRequest = { url: string; init: HttpInit }

export type ChatUsage = {
  input: number
  output: number
  reasoning: number
  total: number
  // USD as the provider reported it (OpenRouter's `usage.cost`, LiteLLM's
  // `x-litellm-response-cost`); absent when it reported none.
  cost?: number
}

export type ChatReply = {
  text: string
  finishReason?: string
  usage: ChatUsage
}

export const EMPTY_USAGE: ChatUsage = { input: 0, output: 0, reasoning: 0, total: 0 }

// `off` sends no reasoning field, leaving the model at its own default.
// OpenRouter normalizes effort across vendors and takes `xhigh`.
const OPENROUTER_EFFORT: Record<ThinkingLevel, string | undefined> = {
  off: undefined,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
}

// LiteLLM maps `reasoning_effort` onto each backend; `high` is the top level
// every backend it maps takes, so the levels above it are sent as `high`.
const LITELLM_EFFORT: Record<ThinkingLevel, string | undefined> = {
  off: undefined,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

const headersFor = (provider: Provider, json: boolean) => {
  const headers: Record<string, string> = {}
  if (json) headers['content-type'] = 'application/json'
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`
  if (provider.name === 'openrouter') headers['x-title'] = 'Claude Code second-opinion'
  return headers
}

/**
 * Builds one non-streaming chat completion request: a system message and a
 * user message, no tools, no history.
 *
 * No output cap is sent: a reasoning model's cap counts its thinking too, so a
 * cap would cut replies short. The reply budget lives in the prompt and the
 * wall clock bounds the call.
 */
export const buildChatRequest = (
  provider: Provider,
  modelId: string,
  system: string,
  user: string,
  thinking: ThinkingLevel,
): HttpRequest => {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
  }

  if (provider.name === 'openrouter') {
    const effort = OPENROUTER_EFFORT[thinking]
    // `exclude` keeps the reasoning text out of the reply: only the verdict is read.
    if (effort) body.reasoning = { effort, exclude: true }
    body.usage = { include: true }
  } else {
    const effort = LITELLM_EFFORT[thinking]
    if (effort) body.reasoning_effort = effort
    // Lets the proxy drop a parameter the backend model does not take instead of failing.
    body.drop_params = true
  }

  return {
    url: `${provider.baseUrl}/chat/completions`,
    init: { method: 'POST', headers: headersFor(provider, true), body: JSON.stringify(body) },
  }
}

const parseJson = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const errorText = (body: any): string | undefined => {
  const error = body?.error
  if (!error) return undefined
  if (typeof error === 'string') return error
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
  return error.code !== undefined ? `${message} (code ${error.code})` : message
}

const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as any).text === 'string' ? (part as any).text : ''))
    .filter(Boolean)
    .join('\n')
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Reads a chat completion response.
 *
 * @throws on a non-2xx status, an error body (OpenRouter can answer 200 with
 *   one) or a response with no choice, with the provider's own message
 */
export const parseChatResponse = (response: HttpResponse): ChatReply => {
  const body = parseJson(response.text)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${errorText(body) ?? (response.text.trim().slice(0, 300) || 'no body')}`)
  }
  const bodyError = errorText(body)
  if (bodyError) throw new Error(bodyError)

  const choice = body?.choices?.[0]
  if (!choice) throw new Error('The response held no choices.')
  const choiceError = errorText(choice)
  if (choiceError) throw new Error(choiceError)

  const usage = body.usage ?? {}
  const headerCost = Number(response.headers['x-litellm-response-cost'])
  const cost = typeof usage.cost === 'number'
    ? usage.cost
    : Number.isFinite(headerCost) && response.headers['x-litellm-response-cost'] !== undefined
      ? headerCost
      : undefined
  const input = count(usage.prompt_tokens)
  const output = count(usage.completion_tokens)

  return {
    text: contentText(choice.message?.content).trim(),
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage: {
      input,
      output,
      reasoning: count(usage.completion_tokens_details?.reasoning_tokens),
      total: count(usage.total_tokens) || input + output,
      ...(cost !== undefined ? { cost } : {}),
    },
  }
}

/** Lists the models a provider serves (OpenRouter's catalog, LiteLLM's model names). */
export const buildModelsRequest = (provider: Provider): HttpRequest => ({
  url: `${provider.baseUrl}/models`,
  init: { method: 'GET', headers: headersFor(provider, false) },
})

/** Checks an OpenRouter key: its `/key` endpoint answers 401 for a bad one. */
export const buildKeyCheckRequest = (provider: Provider): HttpRequest => ({
  url: `${provider.baseUrl}/key`,
  init: { method: 'GET', headers: headersFor(provider, false) },
})

/** The model ids of a `/models` response (`{ data: [{ id }] }`). */
export const parseModelIds = (response: HttpResponse): string[] => {
  if (!response.ok) {
    const body = parseJson(response.text)
    throw new Error(`HTTP ${response.status}: ${errorText(body) ?? (response.text.trim().slice(0, 200) || 'no body')}`)
  }
  const data = parseJson(response.text)?.data
  if (!Array.isArray(data)) throw new Error('The models list was not in the OpenAI { data: [...] } shape.')
  return data
    .map(model => (model && typeof model.id === 'string' ? model.id : undefined))
    .filter((id): id is string => Boolean(id))
}

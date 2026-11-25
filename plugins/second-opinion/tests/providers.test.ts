import { expect, test } from 'claude-code/testing'

import { buildChatRequest, buildModelsRequest, parseChatResponse, parseModelIds } from '../hooks/providers'

const OPENROUTER = { name: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fake-openrouter-key' }
const LITELLM = { name: 'litellm' as const, baseUrl: 'http://localhost:4000', apiKey: 'fake-litellm-key' }

test('an OpenRouter request asks for unified reasoning effort, hides the reasoning and asks for cost', () => {
  const { url, init } = buildChatRequest(OPENROUTER, 'openai/gpt-5.5', 'sys', 'user', 'max')
  const body = JSON.parse(String(init.body))

  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(init.method).toBe('POST')
  expect(init.headers?.authorization).toBe('Bearer fake-openrouter-key')
  expect(body.model).toBe('openai/gpt-5.5')
  expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }])
  expect(body.reasoning).toEqual({ effort: 'xhigh', exclude: true })
  expect(body.usage).toEqual({ include: true })
  expect(body.max_tokens).toBeUndefined()
  const off = JSON.parse(String(buildChatRequest(OPENROUTER, 'm', 's', 'u', 'off').init.body))
  expect(off.reasoning).toBeUndefined()
  expect(off.reasoning_effort).toBeUndefined()
})

test('a LiteLLM request uses reasoning_effort, capped at high, and lets the proxy drop what a backend lacks', () => {
  const { url, init } = buildChatRequest(LITELLM, 'gemini-3-pro', 'sys', 'user', 'xhigh')
  const body = JSON.parse(String(init.body))

  expect(url).toBe('http://localhost:4000/chat/completions')
  expect(body.reasoning_effort).toBe('high')
  expect(body.drop_params).toBe(true)
  expect(body.reasoning).toBeUndefined()
  const off = JSON.parse(String(buildChatRequest(LITELLM, 'm', 's', 'u', 'off').init.body))
  expect(off.reasoning).toBeUndefined()
  expect(off.reasoning_effort).toBeUndefined()
})

test('a proxy sends an authorization header only when a key is configured', () => {
  const configured = buildChatRequest(LITELLM, 'm', 's', 'u', 'low')
  expect(configured.init.headers?.authorization).toBe('Bearer fake-litellm-key')
  const { init } = buildChatRequest({ ...LITELLM, apiKey: undefined }, 'm', 's', 'u', 'low')
  expect(init.headers?.authorization).toBeUndefined()
})

test('a reply is read with its usage, OpenRouter cost in the body and LiteLLM cost in a header', () => {
  const openrouter = parseChatResponse({
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      choices: [{ message: { content: ' {"verdict":"approve"} ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0021, completion_tokens_details: { reasoning_tokens: 3 } },
    }),
  })
  expect(openrouter).toEqual({
    text: '{"verdict":"approve"}',
    finishReason: 'stop',
    usage: { input: 10, output: 5, reasoning: 3, total: 15, cost: 0.0021 },
  })

  const litellm = parseChatResponse({
    status: 200,
    ok: true,
    headers: { 'x-litellm-response-cost': '0.0005' },
    text: JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  })
  expect(litellm.text).toBe('a\nb')
  expect(litellm.usage.cost).toBe(0.0005)
  expect(litellm.usage.total).toBe(2)
})

test('errors carry the provider message: a non-2xx status, or an error body under a 200', () => {
  expect(() =>
    parseChatResponse({ status: 401, ok: false, headers: {}, text: JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }) }),
  ).toThrow('HTTP 401: No auth credentials found (code 401)')
  expect(() =>
    parseChatResponse({ status: 200, ok: true, headers: {}, text: JSON.stringify({ error: { message: 'upstream overloaded' } }) }),
  ).toThrow('upstream overloaded')
  expect(() => parseChatResponse({ status: 502, ok: false, headers: {}, text: 'Bad gateway' })).toThrow('HTTP 502: Bad gateway')
  expect(() => parseChatResponse({ status: 200, ok: true, headers: {}, text: '{"choices":[]}' })).toThrow(/no choices/)
})

test('a models list is read in the OpenAI shape', () => {
  expect(buildModelsRequest(LITELLM).url).toBe('http://localhost:4000/models')
  expect(parseModelIds({ status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, {}] }) })).toEqual(['a', 'b'])
  expect(() => parseModelIds({ status: 200, ok: true, headers: {}, text: '[]' })).toThrow(/shape/)
})

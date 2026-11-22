import { expect, test } from 'claude-code/testing'

import {
  allowedReviewerModels,
  assertAllowedReviewerModel,
  isExcludedReviewerModel,
  isOpaqueRouterModel,
  modelFamily,
  parseModelList,
  resolveSettings,
} from '../hooks/config'

test('a tier list splits on commas and new lines, keeps order, drops repeats and reads =thinking', () => {
  expect(parseModelList('openrouter/openai/gpt-5.5=xhigh, litellm/glm-5\n openrouter/openai/gpt-5.5 ,')).toEqual([
    { model: 'openrouter/openai/gpt-5.5', thinking: 'xhigh' },
    { model: 'litellm/glm-5' },
  ])
})

test('an = suffix that is no thinking level stays part of the model id', () => {
  expect(parseModelList('litellm/odd=name')).toEqual([{ model: 'litellm/odd=name' }])
})

test('Anthropic models are refused under every spelling a router or aggregator uses', () => {
  for (const id of [
    'anthropic/claude-sonnet-4.5',
    '~anthropic/claude-opus-latest',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'claude-sonnet-4@20250514',
    'github-copilot/claude-sonnet-4',
    'sonnet-4.5',
    'haiku-3.5',
    'bedrock/us.anthropic.claude-opus-4',
  ]) {
    expect(isExcludedReviewerModel(id)).toBe(true)
  }
  for (const id of ['openai/gpt-5.5', 'google/gemini-3.1-pro-preview', 'z-ai/glm-5.3', 'my-proxy-model']) {
    expect(isExcludedReviewerModel(id)).toBe(false)
  }
})

test('routers that pick a model per request are refused', () => {
  expect(isOpaqueRouterModel('openrouter/auto')).toBe(true)
  expect(isOpaqueRouterModel('openrouter/free')).toBe(true)
  expect(isOpaqueRouterModel('auto')).toBe(true)
  expect(isOpaqueRouterModel('openai/gpt-5.5')).toBe(false)
})

test('a reviewer must name a known provider and be listed in a tier pool', () => {
  const settings = resolveSettings({ openrouterApiKey: 'k', strongModels: 'openrouter/openai/gpt-5.5' }, {})
  const allowed = allowedReviewerModels(settings)

  expect(() => assertAllowedReviewerModel('openrouter/openai/gpt-5.5', allowed)).not.toThrow()
  expect(() => assertAllowedReviewerModel('openrouter/openai/gpt-4o', allowed)).toThrow(/no tier pool/)
  expect(() => assertAllowedReviewerModel('vertex/gemini-3', allowed)).toThrow(/unknown provider/)
  expect(() => assertAllowedReviewerModel('openrouter/anthropic/claude-opus-5', new Set(['openrouter/anthropic/claude-opus-5']))).toThrow(/Anthropic/)
  expect(() => assertAllowedReviewerModel('openrouter/openrouter/auto', new Set(['openrouter/openrouter/auto']))).toThrow(/router/)
  expect(() => assertAllowedReviewerModel('no-slash', allowed)).toThrow(/Invalid model ref/)
})

test('settings take the plugin options first and the environment second', () => {
  const fromEnv = resolveSettings({}, { OPENROUTER_API_KEY: 'env-key', LITELLM_BASE_URL: 'http://localhost:4000/', LITELLM_API_KEY: 'lk' })
  expect(fromEnv.providers.openrouter?.apiKey).toBe('env-key')
  expect(fromEnv.providers.litellm).toEqual({ name: 'litellm', baseUrl: 'http://localhost:4000', apiKey: 'lk' })

  const fromOptions = resolveSettings({ openrouterApiKey: 'opt-key', litellmBaseUrl: 'https://proxy.example/v1' }, { OPENROUTER_API_KEY: 'env-key' })
  expect(fromOptions.providers.openrouter?.apiKey).toBe('opt-key')
  expect(fromOptions.providers.litellm?.baseUrl).toBe('https://proxy.example/v1')
  expect(fromOptions.providers.litellm?.apiKey).toBeUndefined()
})

test('a provider with nothing to call it with is explained, not configured', () => {
  const settings = resolveSettings({ litellmBaseUrl: 'localhost:4000' }, {})
  expect(settings.providers).toEqual({})
  expect(settings.unconfigured.openrouter).toMatch(/OPENROUTER_API_KEY/)
  expect(settings.unconfigured.litellm).toMatch(/not an http/)
})

test('numbers are clamped and an unknown tier falls back to strong', () => {
  const settings = resolveSettings({ reviewerCount: 40, timeoutSeconds: 30, defaultTier: 'huge' }, {})
  expect(settings.reviewerCount).toBe(8)
  expect(settings.timeoutMs).toBe(30_000)
  expect(settings.defaultTier).toBe('strong')
})

test('the family comes from the vendor segment, else the model name, else the provider', () => {
  expect(modelFamily('openrouter/z-ai/glm-5.3')).toBe('zai')
  expect(modelFamily('openrouter/openai/gpt-5.5')).toBe('openai')
  expect(modelFamily('litellm/gemini-3-pro')).toBe('google')
  expect(modelFamily('litellm/gpt-5.5')).toBe('openai')
  expect(modelFamily('litellm/house-model')).toBe('litellm')
})

import { expect, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse } from 'claude-code'

import type { PanelIo } from '../hooks/panel'
import { buildStatusReport } from '../hooks/status'
import { settingsWith } from './helpers'

const json = (status: number, body: unknown): HttpResponse => ({ status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(body) })

/** A PanelIo answering GETs by URL, recording which URLs were asked. */
const statusIo = (answer: (url: string) => HttpResponse | 'hang') => {
  const urls: string[] = []
  const io: PanelIo = {
    fetch: async (url: string, _init: HttpInit) => {
      urls.push(url)
      const reply = answer(url)
      return reply === 'hang' ? new Promise<HttpResponse>(() => {}) : reply
    },
    sleep: async () => {
      for (let i = 0; i < 25; i++) await Promise.resolve()
    },
    now: async () => 0,
  }
  return { io, urls }
}

const OPENROUTER_LIST = json(200, { data: [{ id: 'openai/gpt-a' }, { id: 'google/gemini-b' }] })

const report = async (options: Record<string, unknown>, answer: (url: string) => HttpResponse | 'hang') => {
  const { io, urls } = statusIo(answer)
  const text = await buildStatusReport(io, settingsWith(options), { openrouterApiKey: 'fake-openrouter-key', ...options })
  return { text, urls }
}

test('each pool entry gets its own state: ok, an OpenRouter variant, not listed, refused, skipped', async () => {
  const { text, urls } = await report(
    {
      strongModels: [
        'openrouter/openai/gpt-a',
        'openrouter/google/gemini-b:free',
        'openrouter/z-ai/glm-c',
        'openrouter/anthropic/claude-x',
        'openrouter/openrouter/auto',
        'litellm/house-model',
      ].join(', '),
    },
    url => (url.endsWith('/key') ? json(200, { data: {} }) : OPENROUTER_LIST),
  )

  expect(urls.sort()).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models'])
  expect(text).toContain('openrouter key from plugin settings; key accepted; 2 models listed')
  expect(text).toContain('openrouter/openai/gpt-a: ok')
  // `:free` is a route to a listed base model, so it is not reported missing.
  expect(text).toContain('openrouter/google/gemini-b:free: ok')
  expect(text).toContain('openrouter/z-ai/glm-c: not listed by openrouter')
  expect(text).toContain('openrouter/anthropic/claude-x: refused: Anthropic models never review')
  expect(text).toContain('openrouter/openrouter/auto: refused: a router can pick any model, Claude included')
  expect(text).toContain('litellm/house-model: skipped: litellm is not configured')
})

test('a refused key and a failed model list are reported, and the entries left unchecked', async () => {
  const { text } = await report({}, url =>
    url.endsWith('/key') ? json(401, { error: { message: 'No auth credentials found' } }) : json(503, { error: { message: 'down' } }),
  )

  expect(text).toContain('key refused (HTTP 401); model list failed: HTTP 503: down')
  expect(text).toContain('openrouter/openai/gpt-a: unchecked: the model list was not available')
})

test('a provider that never answers is reported as a timeout, not left hanging', async () => {
  const { text } = await report({}, () => 'hang')

  expect(text).toContain('key check failed: no answer within 15s')
  expect(text).toContain('model list failed: no answer within 15s')
})

test('a LiteLLM proxy is listed with where its URL and key came from', async () => {
  const withKey = await report(
    { openrouterApiKey: '', litellmBaseUrl: 'http://localhost:4000', litellmApiKey: 'fake-litellm-key', strongModels: 'litellm/house-model, litellm/gone' },
    () => json(200, { data: [{ id: 'house-model' }] }),
  )
  expect(withKey.urls).toEqual(['http://localhost:4000/models'])
  expect(withKey.text).toContain('litellm    http://localhost:4000 (from plugin settings); key from plugin settings; 1 models listed')
  expect(withKey.text).toContain('openrouter not configured: no API key')
  expect(withKey.text).toContain('litellm/house-model: ok')
  expect(withKey.text).toContain('litellm/gone: not listed by litellm')

  const noKey = await report({ openrouterApiKey: '', litellmBaseUrl: 'http://localhost:4000', strongModels: 'litellm/house-model' }, () =>
    json(200, { data: [{ id: 'house-model' }] }),
  )
  expect(noKey.text).toContain('no key (fine for a proxy without auth)')
})

test('an empty tier says which option fills it, and each tier states its default thinking', async () => {
  const { text } = await report({ balancedModels: '' }, url => (url.endsWith('/key') ? json(200, {}) : OPENROUTER_LIST))

  expect(text).toContain('balanced tier (thinking medium unless a ref sets it)\n  (empty: set balancedModels in the plugin settings)')
  expect(text).toContain('fast tier (thinking off unless a ref sets it)')
  expect(text).toContain('Defaults: strong tier, 3 reviewer(s), 150s per reviewer.')
})

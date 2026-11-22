import { expect, test } from 'claude-code/testing'

import { buildDetails, runPanel, selectReviewers } from '../hooks/panel'
import { formatSummary } from '../hooks/review'
import { ARTIFACT, chatResponse, errorResponse, fakeIo, settingsWith } from './helpers'

const run = async (answer: Parameters<typeof fakeIo>[0], options: Record<string, unknown> = {}, input = {}) => {
  const settings = settingsWith(options)
  const selection = selectReviewers(settings, input)
  const { io, calls } = fakeIo(answer)
  const results = await runPanel(io, settings, selection, ARTIFACT, 'plan', 'find gaps')
  return { results, calls, details: buildDetails(selection, results, ARTIFACT, 'plan', 'find gaps', 'claude-opus-5-5') }
}

test('a pool panel runs the first models of the tier, each through its own lens', async () => {
  const { results, calls, details } = await run(() => chatResponse({ verdict: 'approve' }, { cost: 0.002 }))

  expect(calls.map(call => call.body.model)).toEqual(['openai/gpt-a', 'google/gemini-b', 'z-ai/glm-c'])
  expect(results.map(result => result.label)).toEqual(['openai-broad', 'google-skeptical', 'zai-delivery'])
  expect(calls[1]?.body.messages[0].content).toContain('Reviewer lens: Be adversarial.')
  expect(calls[0]?.body.reasoning).toEqual({ effort: 'high', exclude: true })
  expect(details.gate.status).toBe('passed')

  const summary = formatSummary(details)
  expect(summary).toContain('GATE: PASSED')
  expect(summary).toContain('Panel: 3/3 reviewers (openai, google, zai, strong tier)')
  expect(summary).toContain('Panel usage: 3150 tokens, ~$0.0060 as the providers reported it')
})

test('a failed reviewer is replaced by the next untried model in the pool, in the same slot', async () => {
  const { results, calls, details } = await run(model =>
    model === 'google/gemini-b' ? errorResponse(503, 'overloaded') : chatResponse({ verdict: 'approve' }),
  )

  expect(calls.map(call => call.body.model)).toEqual(['openai/gpt-a', 'google/gemini-b', 'z-ai/glm-c', 'x-ai/grok-d'])
  expect(results.map(result => result.label)).toEqual(['openai-broad', 'xai-skeptical', 'zai-delivery'])
  expect(details.gate.status).toBe('passed')
})

test('when the pool runs out, an answering model is repeated and its repeat adds no agreement', async () => {
  const { results, details } = await run(
    model => (model === 'openai/gpt-a' ? chatResponse({ verdict: 'approve' }) : errorResponse(500, 'down')),
  )

  expect(results.map(result => [result.label, result.repeatOf])).toEqual([
    ['openai-broad', undefined],
    ['openai-skeptical-repeat-1', 'openrouter/openai/gpt-a'],
    ['openai-delivery-repeat-2', 'openrouter/openai/gpt-a'],
  ])
  expect(details.consensus.verdicts).toEqual({ approve: 1 })
  expect(details.consensus.repeatedReviewers).toHaveLength(2)
})

test('a slot nothing could fill keeps its failure, so the gate blocks on an incomplete panel', async () => {
  let gptCalls = 0
  const { results, details } = await run(model => {
    if (model !== 'openai/gpt-a') return errorResponse(500, 'down')
    gptCalls += 1
    return gptCalls === 1 ? chatResponse({ verdict: 'approve' }) : errorResponse(429, 'rate limited')
  })

  expect(results).toHaveLength(3)
  expect(results.filter(result => result.parsed)).toHaveLength(1)
  expect(details.gate.status).toBe('blocked')
  expect(details.gate.reasons[0]).toMatch(/A gate cannot pass on an incomplete panel/)
})

test('a reviewer past its wall clock is a timeout and a failure, never an approval', async () => {
  // Explicit reviewers get no fallback, so the timed-out slot stays as it ended.
  const { results, details } = await run(
    model => (model === 'openai/gpt-a' ? 'hang' : chatResponse({ verdict: 'approve' })),
    {},
    { reviewers: [{ model: 'openrouter/openai/gpt-a' }, { model: 'openrouter/google/gemini-b' }] },
  )

  const timedOut = results.find(result => result.model === 'openrouter/openai/gpt-a')
  expect(timedOut?.timedOut).toBe(true)
  expect(timedOut?.parsed).toBeNull()
  expect(details.gate.status).toBe('blocked')
  expect(formatSummary(details)).toContain('→ timeout')
})

test('a reply with no verdict, or no JSON, fails the reviewer and sends the slot to the fallback', async () => {
  const { calls, results } = await run(
    model => (model === 'openai/gpt-a' ? chatResponse('I think it looks fine.') : chatResponse({ verdict: 'approve' })),
    {},
    { reviewerCount: 1 },
  )
  expect(calls.map(call => call.body.model)).toEqual(['openai/gpt-a', 'google/gemini-b'])
  expect(results.map(result => result.model)).toEqual(['openrouter/google/gemini-b'])
})

test('validation mode runs one reviewer from the fast tier with thinking off', async () => {
  const { calls } = await run(() => chatResponse({ verdict: 'approve' }), {}, { validation: true })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.body.model).toBe('z-ai/glm-flash')
  expect(calls[0]?.body.reasoning).toBeUndefined()
})

test('an explicit model runs alone with no fallback, at the thinking level asked for', async () => {
  const { calls, results } = await run(
    () => errorResponse(500, 'down'),
    {},
    { model: 'openrouter/google/gemini-b', thinking: 'low' },
  )
  expect(calls).toHaveLength(1)
  expect(calls[0]?.body.reasoning).toEqual({ effort: 'low', exclude: true })
  expect(results[0]?.label).toBe('reviewer')
})

test('pool entries whose provider is not configured are skipped and named', async () => {
  const { calls, details } = await run(
    () => chatResponse({ verdict: 'approve' }),
    { strongModels: 'litellm/glm-5, openrouter/openai/gpt-a' },
    { reviewerCount: 1 },
  )
  expect(calls.map(call => call.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions'])
  expect(details.selection.skipped[0]).toMatch(/^litellm\/glm-5 \(litellm is not configured/)
})

test('a LiteLLM pool sends the model name verbatim to the proxy', async () => {
  const { calls } = await run(
    () => chatResponse({ verdict: 'approve' }),
    { openrouterApiKey: '', litellmBaseUrl: 'http://localhost:4000', strongModels: 'litellm/openai/gpt-5.5=medium' },
    { reviewerCount: 1 },
  )
  expect(calls[0]?.url).toBe('http://localhost:4000/chat/completions')
  expect(calls[0]?.body.model).toBe('openai/gpt-5.5')
  expect(calls[0]?.body.reasoning_effort).toBe('medium')
})

test('a refused or unconfigured model fails before any call', () => {
  const settings = settingsWith()
  expect(() => selectReviewers(settings, { model: 'openrouter/anthropic/claude-opus-5' })).toThrow(/Anthropic/)
  expect(() => selectReviewers(settings, { model: 'openrouter/openai/unlisted' })).toThrow(/no tier pool/)
  expect(() => selectReviewers(settingsWith({ strongModels: 'openrouter/anthropic/claude-x' }), {})).toThrow(/Anthropic/)
  expect(() => selectReviewers(settingsWith({ openrouterApiKey: '' }), {})).toThrow(/No usable models in the strong tier/)
  expect(() => selectReviewers(settings, { modelTier: 'balanced' })).toThrow(/balanced tier lists no models/)
  expect(() => selectReviewers(settings, { modelTier: 'huge' })).toThrow(/Unknown tier/)
  expect(() => selectReviewers(settings, { thinking: 'extreme' })).toThrow(/Unknown thinking level/)
})

test('an explicit list is capped at eight reviewers and says how many it dropped', () => {
  const models = Array.from({ length: 10 }, (_, i) => `openrouter/v/m${i}`)
  const selection = selectReviewers(settingsWith({ strongModels: models.join(',') }), { reviewers: models.map(model => ({ model })) })
  expect(selection.candidates).toHaveLength(8)
  expect(selection.droppedReviewerCount).toBe(2)
})

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chatResponse, errorResponse } from './helpers'

const TOOL_ID = 'mcp__second-opinion__second_opinion'

// A command as the person types it at the prompt.
const typed = (args: string) => ({
  command: 'second-opinion',
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: false, columns: 100 },
})

const OPTIONS = {
  openrouterApiKey: 'fake-openrouter-key',
  strongModels: 'openrouter/openai/gpt-a, openrouter/google/gemini-b, openrouter/z-ai/glm-c',
  fastModels: 'openrouter/z-ai/glm-flash',
  reviewerCount: 3,
}

// Stands in for the engine beneath the plugin: registrations, the session and the network.
const engine = (on: On, fetch: (url: string, body: any) => ReturnType<typeof chatResponse>) => {
  const requests: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const registered: { tools: string[]; commands: string[] } = { tools: [], commands: [] }
  const submitted: string[] = []

  on('tool.register', (_, e) => {
    registered.tools.push(e.name)
    return { value: { tool: `mcp__second-opinion__${e.name}` } }
  })
  on('command.register', (_, e) => {
    registered.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Draft a rollout plan for the queue migration.', toolUses: [] }] }))
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('http.fetch', (_, e) => {
    const body = e.init?.body ? JSON.parse(String(e.init.body)) : undefined
    requests.push({ url: e.url, body, headers: e.init?.headers ?? {} })
    return { value: fetch(e.url, body) }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  mock.env(on, { HOME: '/home/me' })
  const clock = mock.clock(on)

  return { requests, registered, submitted, clock }
}

test('session start registers the tool, in the prompt from the start, and the command', { options: OPTIONS }, async ($, on) => {
  const world = engine(on, () => chatResponse({ verdict: 'approve' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  expect(world.registered).toEqual({ tools: ['second_opinion'], commands: ['second-opinion'] })
})

test('the tool runs a panel on inline content through OpenRouter and returns the gate', { options: OPTIONS }, async ($, on) => {
  const world = engine(on, () => chatResponse({ verdict: 'approve', score: 9 }, { cost: 0.001 }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: TOOL_ID, content: '1. Drain the queue.\n2. Switch writers.', title: 'Rollout plan', focus: 'find missing steps' })

  expect(ran.deny).toBeUndefined()
  const text = String(ran.result)
  expect(text).toContain('GATE: PASSED')
  expect(text).toContain('Artifact: Rollout plan')
  expect(text).toContain('Ask: find missing steps')
  expect(text).toContain('Current model: claude-opus-5-5')

  const chats = world.requests.filter(request => request.url.endsWith('/chat/completions'))
  expect(chats.map(request => request.body.model)).toEqual(['openai/gpt-a', 'google/gemini-b', 'z-ai/glm-c'])
  expect(chats[0]?.headers.authorization).toBe('Bearer fake-openrouter-key')
  // The session rides along as context with the content.
  expect(chats[0]?.body.messages[1].content).toContain('Draft a rollout plan for the queue migration.')
})

test('a blocking finding blocks the gate', { options: OPTIONS }, async ($, on) => {
  engine(on, (_, body) =>
    body.model === 'google/gemini-b'
      ? chatResponse({ verdict: 'revise', blocking: [{ claim: 'No rollback step', evidence: '2. Switch writers.' }] })
      : chatResponse({ verdict: 'approve' }),
  )
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: TOOL_ID, content: '1. Drain.\n2. Switch writers.', includeSessionContext: false })
  const text = String(ran.result)

  expect(text).toContain('GATE: BLOCKED')
  expect(text).toContain('Blocking verdict(s): revise.')
  expect(text).toContain('blocking: No rollback step')
})

test('a refused model comes back to the model as the tool error, with no request sent', { options: OPTIONS }, async ($, on) => {
  const world = engine(on, () => chatResponse({ verdict: 'approve' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({ tool: TOOL_ID, content: 'x', model: 'openrouter/anthropic/claude-opus-5' })

  expect(ran.isError ?? ran.deny !== undefined).toBe(true)
  expect(String(ran.text ?? ran.deny)).toMatch(/Anthropic model/)
  expect(world.requests).toHaveLength(0)
})

test('/second-opinion reviews the session, prints the result and asks the agent to verify it', { options: OPTIONS }, async ($, on) => {
  const world = engine(on, () => chatResponse({ verdict: 'approve' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run(typed('--validate did we miss a step?'))

  expect(ran.text).toContain('Type: session transcript')
  expect(ran.text).toContain('Ask: did we miss a step?')
  expect(ran.text).toContain('GATE: PASSED')
  expect(world.requests.map(request => request.body?.model)).toEqual(['z-ai/glm-flash'])
  expect(ran.context?.[0]).toContain('THE GATE IS PASSED')
  // The turn that acts on it starts after the command returned.
  expect(world.submitted).toHaveLength(0)
  await world.clock.settle()
  expect(world.submitted).toHaveLength(1)
  expect(world.submitted[0]).toContain('Verify its findings')
})

test('/second-opinion --status checks each provider and each pool entry', { options: { ...OPTIONS, balancedModels: '', strongModels: `${OPTIONS.strongModels}, openrouter/anthropic/claude-x` } }, async ($, on) => {
  engine(on, url => {
    if (url.endsWith('/key')) return { status: 200, ok: true, headers: {}, text: '{"data":{}}' }
    if (url.endsWith('/models')) return { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: [{ id: 'openai/gpt-a' }, { id: 'google/gemini-b' }] }) }
    return errorResponse(404, 'not here')
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run(typed('--status'))
  const text = ran.text ?? ''

  expect(text).toContain('openrouter key from plugin settings; key accepted; 2 models listed')
  expect(text).toContain('litellm    not configured: no proxy URL')
  expect(text).toContain('openrouter/openai/gpt-a: ok')
  expect(text).toContain('openrouter/z-ai/glm-c: not listed by openrouter')
  expect(text).toContain('openrouter/anthropic/claude-x: refused: Anthropic models never review')
  expect(text).toContain('(empty: set balancedModels')
})

test('/second-opinion with no key configured says what to set', { options: { ...OPTIONS, openrouterApiKey: '' } }, async ($, on) => {
  engine(on, () => chatResponse({ verdict: 'approve' }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run(typed('check it'))

  expect(ran.text).toMatch(/^Second opinion failed: No usable models in the strong tier: .*OPENROUTER_API_KEY/)
})

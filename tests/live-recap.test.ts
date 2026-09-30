import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const SUMMARY =
  'Editing hooks/register.tsx to draw the live card. It shows the user what Claude is doing. A third sentence.'
const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}
const BAND = { plugin: 'live-recap', surface: 'terminal', component: 'AbovePrompt', props: PROPS } as const
const SESSION = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const
const MAIN_END = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

type ConfigStandIn = { isRecapOn?: boolean; sets?: { key: string; value: unknown }[] }

// Nothing answers beneath the plugin in a test, so these stand in for the engine's own events.
const engine = (on: On, config: ConfigStandIn = {}) => {
  const recapRow = {
    key: 'recap',
    label: 'Session recap',
    kind: 'boolean',
    value: config.isRecapOn ?? false,
    provider: { plugin: 'engine', tier: 'core' },
    isLocked: false,
  } as const
  on('config.list', () => ({ value: [recapRow] }))
  on('config.set', (_$, e) => {
    config.sets?.push({ key: e.key, value: e.value })
    return { value: e.value }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.render', { component: 'Spinner' }, () => ({ type: 'engine', ref: 0 }))
}

const SPIN = {
  plugin: 'live-recap',
  surface: 'terminal',
  component: 'Spinner',
  props: { word: 'Hoping for the best', message: null, suffix: '…', mode: 'responding' },
  viewport: { columns: 80, rows: 24, isFullscreen: false },
} as const
const IDLE_BAND = { ...BAND, props: { ...PROPS, isWorking: false } } as const

const REVIEWER = {
  id: 'a1',
  type: 'subagent',
  status: 'running',
  description: 'Review: standards lens',
  agent_type: 'general-purpose',
}

test('an interactive session turns the built-in session recap off', async ($, on) => {
  const config = { isRecapOn: true, sets: [] as { key: string; value: unknown }[] }
  engine(on, config)
  mock.clock(on, { now: 0 })
  await $.session.start(SESSION)
  expect(config.sets).toEqual([{ key: 'recap', value: false }])
})

test('a session with the built-in recap already off writes nothing', async ($, on) => {
  const config = { isRecapOn: false, sets: [] as { key: string; value: unknown }[] }
  engine(on, config)
  mock.clock(on, { now: 0 })
  await $.session.start(SESSION)
  expect(config.sets).toEqual([])
})

test('a headless session leaves the built-in recap alone', async ($, on) => {
  const config = { isRecapOn: true, sets: [] as { key: string; value: unknown }[] }
  engine(on, config)
  mock.clock(on, { now: 0 })
  await $.session.start({ ...SESSION, isInteractive: false })
  expect(config.sets).toEqual([])
})

test('the card shows after the interval, and its last summary stays until the next prompt', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const prompts: string[] = []
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'I will add the band hook.', toolUses: [] }] }))
  on('model.complete', (_$, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Build the live recap mod', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-1', command: 'npm test -- live-recap' })
  const band = await $.ui.mount(BAND)
  const spin = await $.ui.mount(SPIN)
  expect(await spin.find({ text: /tracking/ })).toBeUndefined()

  await clock.advance(90_000)
  expect(prompts).toHaveLength(0)

  await clock.advance(30_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('Build the live recap mod')
  expect(prompts[0]).toContain('I will add the band hook.')
  expect(prompts[0]).toContain('- Bash: npm test -- live-recap')
  expect(prompts[0]).not.toContain('(running)')
  expect(await spin.find({ text: /Editing hooks\/register\.tsx/ })).toBeDefined()
  expect(await spin.find({ text: /A third sentence/ })).toBeUndefined()
  expect(await spin.find({ text: /running 2m · haiku · just now/ })).toBeDefined()
  // The card sits above the engine's own spinner line, and the band stays empty while the turn runs.
  const drawn = (await spin.drawn()) as { children?: { type?: string }[] }
  expect(drawn.children?.map(child => child.type)).toEqual(['Box', 'engine'])
  expect(await band.find({ text: /tracking/ })).toBeUndefined()

  await clock.advance(60_000)
  expect(prompts).toHaveLength(1)
  expect(await spin.find({ text: /running 3m · haiku · ~1m ago/ })).toBeDefined()

  await clock.advance(60_000)
  expect(prompts).toHaveLength(2)

  await $.turn.complete(MAIN_END)
  await band.redraw(IDLE_BAND.props)
  expect(await spin.find({ text: /tracking|recapped/ })).toBeUndefined()
  expect(await band.find({ text: /recapped/ })).toBeDefined()
  expect(await band.find({ text: /ran 4m · haiku · just now/ })).toBeDefined()
  expect(await band.find({ text: /Editing hooks\/register\.tsx/ })).toBeDefined()

  await clock.advance(60_000)
  expect(prompts).toHaveLength(2)
  expect(await band.find({ text: /ran 4m · haiku · ~1m ago/ })).toBeDefined()

  await $.turn.start({ text: 'Next task', turnId: 't2' })
  expect(await band.find({ text: /recapped/ })).toBeUndefined()
  await spin.unmount()
  await band.unmount()
})

test('background work keeps the card up between turns, and the run ends when none is left', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  const prompts: string[] = []
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_$, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Review PR 619', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [REVIEWER] })
  await $.turn.complete(MAIN_END)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'tu-2', command: 'git diff main', agentId: 'a1' })
  const ui = await $.ui.mount(IDLE_BAND)

  await clock.advance(120_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('- subagent (general-purpose): Review: standards lens')
  expect(prompts[0]).toContain('- [subagent] Bash: git diff main')
  expect(prompts[0]).toContain('The main loop is waiting on the background work below.')
  expect(await ui.find({ text: /running 2m · 1 in background · haiku · just now/ })).toBeDefined()

  await $.turn.start({ text: '<task-notification> <task-id>a1</task-id> </task-notification>', turnId: 't2' })
  await clock.advance(120_000)
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain("The user's request: Review PR 619")

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await $.turn.complete({ ...MAIN_END, turnId: 't2' })
  expect(await ui.find({ text: /tracking/ })).toBeUndefined()
  expect(await ui.find({ text: /recapped/ })).toBeDefined()
  expect(await ui.find({ text: /in background/ })).toBeUndefined()

  await clock.advance(240_000)
  expect(prompts).toHaveLength(2)
  await ui.unmount()
})

test('an interrupted turn ends the run even with background work listed', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: SUMMARY, usage: USAGE } }))

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Review PR 619', turnId: 't1' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [REVIEWER] })
  const spin = await $.ui.mount(SPIN)
  await clock.advance(120_000)
  expect(await spin.find({ text: /tracking/ })).toBeDefined()

  await $.turn.complete({ ...MAIN_END, isAborted: true, reason: 'aborted' })
  const band = await $.ui.mount(IDLE_BAND)
  expect(await band.find({ text: /tracking/ })).toBeUndefined()
  expect(await band.find({ text: /recapped/ })).toBeDefined()
  await spin.unmount()
  await band.unmount()
})

test('a subagent ending keeps the card and the refreshes going', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  let calls = 0
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Refactor the auth flow', turnId: 't1' })
  const ui = await $.ui.mount(SPIN)
  await clock.advance(120_000)
  expect(await ui.find({ text: /tracking/ })).toBeDefined()

  await $.turn.complete({ ...MAIN_END, agentId: 'agent-1' })
  expect(await ui.find({ text: /tracking/ })).toBeDefined()

  await clock.advance(240_000)
  expect(calls).toBe(3)
  expect(await ui.find({ text: /running 6m · haiku · just now/ })).toBeDefined()
  await ui.unmount()
})

test('a failed summary keeps the waiting text and names the failure in the header', async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE },
  }))

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Run the migration', turnId: 't1' })
  const spin = await $.ui.mount(SPIN)
  await clock.advance(120_000)
  expect(await spin.find({ text: /Claude is working/ })).toBeDefined()
  expect(await spin.find({ text: /refresh failed: api-error 529 overloaded/ })).toBeDefined()

  await $.turn.complete(MAIN_END)
  const band = await $.ui.mount(IDLE_BAND)
  expect(await spin.find({ text: /Claude is working/ })).toBeUndefined()
  expect(await band.find({ text: /Claude is working|recapped/ })).toBeUndefined()
  await spin.unmount()
  await band.unmount()
})

test('the fork source asks the session model', { options: { source: 'fork' } }, async ($, on) => {
  engine(on)
  const clock = mock.clock(on, { now: 0 })
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: SUMMARY, usage: USAGE } }
  })

  await $.session.start(SESSION)
  await $.turn.start({ text: 'Fix the flaky test', turnId: 't1' })
  const ui = await $.ui.mount(SPIN)

  await clock.advance(120_000)
  expect(forks).toHaveLength(1)
  expect(forks[0]).toContain('not a new instruction')
  expect(await ui.find({ text: /running 2m · fork · just now/ })).toBeDefined()
  await ui.unmount()
})

import { atom, read, update } from 'claude-code'
import type { Elements, ModelForkResult, Register, Timer } from 'claude-code'

import type { LiveRecapCard, LiveRecapSource } from '../types'

const TICK_MS = 30_000
const MAX_SENTENCES = 2
const MAX_TOOLS = 15
const HAIKU_TIMEOUT_MS = 60_000
const ACCENT = '#D77757'
const WAITING_TEXT = 'Claude is working. This card refreshes while the work runs.'

const RULES = [
  'Use at most two sentences.',
  'Sentence one: the concrete task the agent is doing right now, named by its file, command, or subject.',
  "Sentence two: the purpose that task serves in the user's goal.",
  'Never state that the agent is waiting, that the step completed, or that the work matters as a bare claim.',
  'Skip history, progress lists, and next actions. Plain text only, no markdown.',
]

const HAIKU_SYSTEM = [
  'You write a live status card for a developer who looked away while Claude Code, a coding agent, works.',
  'The work can run in background subagents and shells while the main loop waits for them.',
  ...RULES,
].join('\n')

// The fork reads as a user turn appended to the live transcript, so it must not steer the agent.
const FORK_PROMPT = [
  'This is a status check from the live recap card, not a new instruction.',
  'Do not call tools and do not change your plan. The user looked away while you work.',
  ...RULES,
].join('\n')

const card = atom({ plugin: 'live-recap', key: 'card' } as const, null)
const now = atom({ plugin: 'live-recap', key: 'now' } as const, 0)

type RecentTool = { id: string; tool: string; detail: string; agentId?: string; isDone: boolean }

type Background = { type: string; description: string; command?: string; agentType?: string }

type Summary = { text?: string; source: LiveRecapSource; error?: string }

const DETAIL_KEYS = ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'skill', 'path', 'prompt']

const clip = (text: string, limit: number) => {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`
}

const limitToSentences = (text: string, max: number) => {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''

  // A dot inside a path (`SKILL.md`) is not a sentence end, so the sentence stays whole.
  const matches = compact.match(/[\s\S]*?[.!?]+["')\]]*(?=\s|$)|[\s\S]+$/g) ?? [compact]
  return matches.slice(0, max).join(' ').replace(/\s+/g, ' ').trim()
}

const formatDuration = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// Coarse buckets, so the card does not read as a live timer.
const formatAge = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 30) return 'just now'
  if (seconds < 90) return '~1m ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `~${minutes}m ago`
  return `~${Math.floor(minutes / 60)}h ago`
}

const wrap = (text: string, width: number) => {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > width) {
      if (line) lines.push(line)
      line = ''
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (!line) line = rest
    else if (line.length + 1 + rest.length <= width) line = `${line} ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  if (line) lines.push(line)
  return lines
}

const detailOf = (input: Record<string, unknown>) => {
  const key = DETAIL_KEYS.find(name => typeof input[name] === 'string')
  return key ? clip(String(input[key]), 160) : ''
}

const reasonOf = (result: ModelForkResult) => {
  if (result.isAnswered) return undefined
  return result.reason === 'api-error'
    ? `api-error ${result.status ?? 'no-status'} ${result.error}`
    : result.reason
}

const metaOf = (shown: LiveRecapCard, at: number) =>
  [
    shown.endedAt === undefined
      ? `running ${formatDuration(at - shown.runStartedAt)}`
      : `ran ${formatDuration(shown.endedAt - shown.runStartedAt)}`,
    shown.endedAt === undefined && shown.background > 0 ? `${shown.background} in background` : undefined,
    shown.source,
    shown.generatedAt === undefined ? undefined : formatAge(at - shown.generatedAt),
    shown.error === undefined ? undefined : `refresh failed: ${clip(shown.error, 40)}`,
  ].filter((part): part is string => part !== undefined)

const terminalCard = (
  { Box, Text }: Pick<Elements['terminal'], 'Box' | 'Text'>,
  shown: LiveRecapCard,
  at: number,
  width: number,
) => {
  const isLast = shown.endedAt !== undefined
  const title = isLast ? ' recapped ' : ' tracking '
  // The last recap draws muted, so it reads as the finished run's and not live.
  const edge = isLast ? { dimColor: true } : { color: ACCENT }
  // Meta segments that do not fit whole are dropped, so the line never cuts mid-word.
  const fitted = metaOf(shown, at).reduce<string[]>((kept, part) => {
    const candidate = [...kept, part]
    return 2 + title.length + candidate.join(' · ').length + 3 <= width ? candidate : kept
  }, [])
  const metaText = fitted.length ? ` ${fitted.join(' · ')} ` : ''
  const fill = '─'.repeat(Math.max(0, width - 2 - title.length - metaText.length))

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text {...edge}>╭─</Text>
        <Text color={ACCENT} bold>
          {title}
        </Text>
        <Text dimColor>{metaText}</Text>
        <Text {...edge}>{fill}</Text>
      </Text>
      {wrap(shown.text ?? WAITING_TEXT, width - 2).map(line => (
        <Text>
          <Text {...edge}>│ </Text>
          <Text dimColor={isLast} italic={isLast}>
            {line}
          </Text>
        </Text>
      ))}
      <Text {...edge} wrap="truncate-end">
        {`╰${'─'.repeat(width - 1)}`}
      </Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const minutes = typeof options.intervalMinutes === 'number' && options.intervalMinutes > 0 ? options.intervalMinutes : 2
  const intervalMs = minutes * 60_000
  const preferred: LiveRecapSource = options.source === 'fork' ? 'fork' : 'haiku'

  let ticker: Timer | undefined
  // A run lasts from the prompt until the main loop and every background agent or shell it started are done.
  let isActive = false
  let isMainRunning = false
  let background: Background[] = []
  // The last summary stays up after the run ends, until the next prompt starts a run.
  let hasLastRecap = false
  let isBusy = false
  let runStartedAt = 0
  let lastAttemptAt = 0
  let goal = ''
  let recentTools: RecentTool[] = []
  let stop: AbortController | undefined
  // The band's width, which the card drawn with the spinner matches; the Spinner site carries none.
  let bandColumns: number | undefined

  const endRun = () => {
    isActive = false
    isMainRunning = false
    background = []
    stop?.abort()
  }

  on('session.start', async ($, e, next) => {
    await update($, card, () => null)

    const digestOf = async (at: number) => {
      const messages = await $.session.messages()
      const notes = (Array.isArray(messages) ? messages : [])
        .filter(row => row.role === 'assistant' && row.text.trim())
        .slice(-3)
        .map(row => `- ${clip(row.text, 500)}`)
      const tools = recentTools.map(
        one => `- ${one.agentId ? '[subagent] ' : ''}${one.tool}: ${one.detail}${one.isDone ? '' : ' (running)'}`,
      )
      const jobs = background.map(
        job => `- ${job.type}${job.agentType ? ` (${job.agentType})` : ''}: ${clip(job.command ?? job.description, 200)}`,
      )
      const waiting = isMainRunning ? '' : ' The main loop is waiting on the background work below.'

      return [
        `The user's request: ${clip(goal, 1200) || '(not captured)'}`,
        `Claude has been working for ${formatDuration(at - runStartedAt)}.${waiting}`,
        '',
        'Background work still running:',
        ...(jobs.length ? jobs : ['- (none)']),
        '',
        'Latest notes Claude wrote, oldest first:',
        ...(notes.length ? notes : ['- (none yet)']),
        '',
        'Latest tool calls, oldest first:',
        ...(tools.length ? tools : ['- (none yet)']),
      ].join('\n')
    }

    const summarize = async (at: number, signal: AbortSignal): Promise<Summary> => {
      if (preferred === 'fork') {
        const result = await $.model.fork({ prompt: FORK_PROMPT })
        return result.isAnswered
          ? { text: limitToSentences(result.text, MAX_SENTENCES), source: 'fork' }
          : { source: 'fork', error: reasonOf(result) }
      }

      try {
        const result = await $.model.complete(
          {
            model: 'haiku',
            system: HAIKU_SYSTEM,
            prompt: await digestOf(at),
            maxTokens: 200,
            effort: 'low',
            timeoutMs: HAIKU_TIMEOUT_MS,
          },
          { signal },
        )
        return result.isAnswered
          ? { text: limitToSentences(result.text, MAX_SENTENCES), source: 'haiku' }
          : { source: 'haiku', error: reasonOf(result) }
      } catch (error) {
        // The engine rejects only a request it will not send, such as a model the org allowlist blocks.
        return { source: 'haiku', error: `refused: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    const refresh = async () => {
      const at = await $.clock.now()
      const run = runStartedAt
      isBusy = true
      lastAttemptAt = at
      stop = new AbortController()
      await update($, card, shown => shown ?? { runStartedAt: run, background: background.length })

      try {
        const summary = await summarize(at, stop.signal)
        const doneAt = await $.clock.now()
        // A run that ended, or restarted, while the summary was in flight makes it stale.
        if (!isActive || runStartedAt !== run) return

        const { text, error } = summary
        if (text) {
          await update($, card, () => ({
            runStartedAt: run,
            text,
            generatedAt: doneAt,
            source: summary.source,
            background: background.length,
          }))
        } else {
          // The card keeps its last text; the failure shows in its header until a refresh lands.
          await update($, card, shown => (shown === null ? null : { ...shown, error: error ?? 'no text' }))
        }
      } finally {
        isBusy = false
        stop = undefined
      }
    }

    const tick = async () => {
      if (!isActive && !hasLastRecap) return

      const at = await $.clock.now()

      await update($, now, () => at)
      if (!isActive || isBusy || at - runStartedAt < intervalMs || at - lastAttemptAt < intervalMs) return

      await refresh()
    }

    // A headless run draws no band, so a timer there would only spend model calls.
    if (e.isInteractive) {
      ticker?.cancel()
      ticker = $.clock.every(TICK_MS, () => void tick())

      // The built-in session recap draws its own row over this card. Turning it off writes
      // `awaySummaryEnabled: false` to user settings, as /config does, so it stays off if this mod is removed.
      const recap = (await $.config.list()).find(row => row.key === 'recap')
      if (recap?.value === true && !recap.isLocked) await $.config.set({ key: 'recap', value: false })
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    endRun()
    hasLastRecap = false
    goal = ''
    recentTools = []
    await update($, card, () => null)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isMainRunning = true
    // A finished background task wakes the main loop with a notification, which is not the user's goal.
    if (e.text.trim() && !e.text.trimStart().startsWith('<task-notification>')) goal = e.text
    if (!isActive) {
      isActive = true
      hasLastRecap = false
      runStartedAt = await $.clock.now()
      lastAttemptAt = 0
      recentTools = []
      await update($, now, () => runStartedAt)
      await update($, card, () => null)
    }

    return next(e)
  })

  // Stop fires as each main-loop turn ends, listing the background agents and shells still in flight.
  on('classic.Stop', async ($, e, next) => {
    background = (e.background_tasks ?? []).map(task => ({
      type: task.type,
      description: task.description,
      command: task.command,
      agentType: task.agent_type,
    }))
    const count = background.length
    await update($, card, shown => (shown === null ? null : { ...shown, background: count }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's run ends in a turn.complete too; only the main loop's end can close the run.
    if (e.agentId === undefined) {
      isMainRunning = false
      if (e.isAborted || background.length === 0) {
        endRun()
        const shown = await read($, card)
        // A card still on its waiting text has nothing worth keeping.
        const last = shown?.text === undefined ? null : { ...shown, endedAt: await $.clock.now() }
        hasLastRecap = last !== null
        await update($, card, () => last)
      }
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isActive) return next(e)

    const entry: RecentTool = {
      id: e.tool_use_id,
      tool: e.tool,
      detail: detailOf(e as unknown as Record<string, unknown>),
      agentId: e.agentId,
      isDone: false,
    }
    recentTools = [...recentTools, entry].slice(-MAX_TOOLS)
    const ran = await next(e)
    recentTools = recentTools.map(one => (one.id === entry.id ? { ...one, isDone: true } : one))

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandColumns = e.props.bodyColumns
    if (e.props.hasSurvey) return next(e)

    const shown = await read($, card)
    const width = e.props.bodyColumns
    if (shown === null || width < 12) return next(e)
    // While a turn runs on the terminal, the Spinner hook draws the card above the spinner line instead.
    if (e.surface === 'terminal' && e.props.isWorking && shown.endedAt === undefined) return next(e)

    const at = Math.max(await read($, now), shown.generatedAt ?? 0)
    const { Box, Text } = $.ui.resolve(e)

    if (e.surface !== 'terminal') {
      const isLast = shown.endedAt !== undefined
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={ACCENT} bold>
              {isLast ? 'recapped' : 'tracking'}
            </Text>
            <Text dimColor> · {metaOf(shown, at).join(' · ')}</Text>
          </Text>
          <Text dimColor={isLast} italic={isLast}>
            {shown.text ?? WAITING_TEXT}
          </Text>
        </Box>
      )
    }

    return terminalCard({ Box, Text }, shown, at, width)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)

    const shown = await read($, card)
    const width = bandColumns ?? e.viewport?.columns ?? 0
    if (shown === null || shown.endedAt !== undefined || width < 12) return next(e)

    const at = Math.max(await read($, now), shown.generatedAt ?? 0)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {terminalCard({ Box, Text }, shown, at, width)}
        {await next(e)}
      </Box>
    )
  })
}

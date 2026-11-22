import type { EngineInterface, Register } from 'claude-code'

import { MAX_REVIEWER_COUNT, MODEL_TIERS, THINKING_LEVELS, resolveSettings } from './config'
import type { Settings } from './config'
import { parseCommandArgs, resolveArtifact } from './input'
import type { InputIo, SecondOpinionInput } from './input'
import { PanelAbortedError, buildDetails, runPanel, selectReviewers } from './panel'
import type { PanelIo } from './panel'
import { buildVerificationPrompt, formatSummary } from './review'
import { buildStatusReport } from './status'

const TOOL = 'second_opinion'
const TOOL_ID = 'mcp__second-opinion__second_opinion'
const COMMAND = 'second-opinion'

const TOOL_DESCRIPTION = [
  'Consult an isolated panel of non-Anthropic models (through OpenRouter or a LiteLLM proxy) for a second opinion on a planning-stage artifact: a generated plan, spec, task breakdown or research write-up, before anyone acts on it. Also for a genuinely hard design or architecture question that local evidence cannot settle: state the question and the options in `focus`.',
  'Reviewers see only the artifact plus the session transcript as context; they have no tools and do not see each other.',
  'The result carries a HARD gate computed by code. GATE: BLOCKED means the artifact is not ready: verify each finding against local evidence, revise the artifact for the confirmed ones, and re-run, up to three runs per artifact (revisions do not reset the count); after three blocked runs, stop and ask the user. GATE: PASSED ends the cycle. Treat findings as hypotheses to verify, not truth, but do not argue the gate open.',
  'Never use it for routine code changes, ordinary code review, one small change, or as a pre-PR or pre-merge gate.',
  'The user may ask for it at any stage: honor the tier, model, reviewer count or thinking level they name. Use validation=true (one fast reviewer) only for a narrow confirmation question.',
].join('\n\n')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'Natural-language request. When it names an existing file, that file is reviewed and the rest becomes the ask; otherwise the session transcript is reviewed.',
    },
    path: { type: 'string', description: 'Exact path of a file to review. Use path or content, not both.' },
    content: { type: 'string', description: 'Inline artifact text to review, such as a plan you just wrote. Use path or content, not both.' },
    title: { type: 'string', description: 'Display title for inline content.' },
    artifactType: { type: 'string', description: 'Label such as plan, spec, task breakdown, research, design question.' },
    focus: {
      type: 'string',
      description: 'What the panel should pressure-test, such as "find requirements the plan forgot" or a design question with its options.',
    },
    reviewerCount: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_REVIEWER_COUNT,
      description: 'How many reviewers to run; defaults to the configured count (1 in validation mode).',
    },
    reviewers: {
      type: 'array',
      maxItems: MAX_REVIEWER_COUNT,
      description: 'Explicit reviewers, run as given with no fallback. Each model must be listed in a configured tier pool; Anthropic models are refused.',
      items: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'provider/model ref, such as openrouter/openai/gpt-5.5 or litellm/my-model.' },
          label: { type: 'string' },
          prompt: { type: 'string', description: 'Extra instructions for this reviewer.' },
          thinking: { type: 'string', enum: [...THINKING_LEVELS] },
        },
        required: ['model'],
        additionalProperties: false,
      },
    },
    model: { type: 'string', description: 'One reviewer model ref from a configured tier pool; used unless reviewers is given.' },
    modelTier: { type: 'string', enum: [...MODEL_TIERS], description: 'Which configured pool to draw reviewers from.' },
    validation: { type: 'boolean', description: 'One reviewer from the fast tier, for a narrow confirmation question.' },
    thinking: { type: 'string', enum: [...THINKING_LEVELS], description: 'Reasoning effort for every reviewer of this call.' },
    includeSessionContext: {
      type: 'boolean',
      description: 'Send the session transcript along with a file or content (default true). Set false when the conversation holds material that should not leave this machine.',
    },
  },
  additionalProperties: false,
} as const

const VERIFY_NOW =
  'The /second-opinion panel above has finished. Verify its findings against local evidence and act on the gate, as its notes describe.'

const USAGE = [
  'Usage: /second-opinion [options] [path] [ask]',
  '',
  'With no path, the panel reviews this session transcript. With a path, it reviews that file, with the session as context.',
  '',
  'Options:',
  '  --tier fast|balanced|strong   Draw reviewers from that tier pool',
  '  --validate                    One reviewer from the fast tier',
  '  --reviewers N                 Panel size (1-8)',
  '  --model provider/model        One explicit reviewer (must be in a tier pool)',
  '  --thinking LEVEL              off, minimal, low, medium, high, xhigh or max',
  '  --no-context                  Do not send the session transcript with a file',
  '  --focus ASK                   Everything after it is the ask',
  '  --status                      Check providers, keys and tier pools; runs no review',
  '',
  'Examples:',
  '  /second-opinion PLAN.md find requirements the plan forgot',
  '  /second-opinion --tier fast --reviewers 2 is the storage choice sound at 10x load?',
].join('\n')

const readSettings = async ($: EngineInterface, options: Readonly<Record<string, unknown>>): Promise<Settings> =>
  resolveSettings(options, {
    OPENROUTER_API_KEY: await $.env.get('OPENROUTER_API_KEY'),
    LITELLM_BASE_URL: await $.env.get('LITELLM_BASE_URL'),
    LITELLM_API_KEY: await $.env.get('LITELLM_API_KEY'),
  })

const inputIo = async ($: EngineInterface): Promise<InputIo> => ({
  cwd: await $.session.cwd(),
  home: await $.env.get('HOME'),
  isFile: async path => (await $.fs.stat(path)).kind === 'file',
  readFile: path => $.fs.read(path),
  messages: () => $.session.messages(),
})

const panelIo = ($: EngineInterface, signal: AbortSignal): PanelIo => ({
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, stop) => $.clock.sleep(ms, { signal: stop }),
  now: () => $.clock.now(),
  signal,
  progress: text => $.ui.status(text),
})

const pickInput = (e: Record<string, unknown>): SecondOpinionInput => {
  const text = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : undefined)
  return {
    prompt: text('prompt'),
    path: text('path'),
    content: text('content'),
    title: text('title'),
    artifactType: text('artifactType'),
    focus: text('focus'),
    reviewerCount: typeof e.reviewerCount === 'number' ? e.reviewerCount : undefined,
    reviewers: Array.isArray(e.reviewers) ? e.reviewers : undefined,
    model: text('model'),
    modelTier: text('modelTier'),
    validation: e.validation === true ? true : undefined,
    thinking: text('thinking'),
    includeSessionContext: e.includeSessionContext === false ? false : undefined,
  }
}

const review = async (
  $: EngineInterface,
  options: Readonly<Record<string, unknown>>,
  input: SecondOpinionInput,
  signal: AbortSignal,
) => {
  const settings = await readSettings($, options)
  // Selection runs first: a banned, unlisted or unconfigured model fails before any file is read.
  const selection = selectReviewers(settings, input)
  const { artifact, artifactType, request } = await resolveArtifact(await inputIo($), input, [TOOL_ID])
  const results = await runPanel(panelIo($, signal), settings, selection, artifact, artifactType, request)
  const details = buildDetails(selection, results, artifact, artifactType, request, await $.session.model())
  return { details, summary: formatSummary(details) }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: TOOL, description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.command.register({
      name: COMMAND,
      description: 'Ask outside models for an isolated second opinion on a plan, file or this session',
      argumentHint: '[--validate] [--tier fast|balanced|strong] [path] [ask] | --status',
    })
    return next(e)
  })

  // The tool's body: no hook budget applies to a tool the plugin registered itself.
  on('tool.run', { tool: TOOL_ID }, async ($, e, next) => {
    try {
      const { summary } = await review($, options, pickInput(e as unknown as Record<string, unknown>), next.signal)
      return { result: summary }
    } catch (error) {
      return { deny: `second_opinion failed: ${errorText(error)}` }
    } finally {
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => ({ deny: `second_opinion failed: ${next.error.message ?? next.error.kind}` }))

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const args = e.args.trim()
    if (args === '--help' || args === '-h' || args === 'help') return { text: USAGE, isTextDisplayOnly: true }

    try {
      if (args === '--status') {
        return { text: await buildStatusReport(panelIo($, next.signal), await readSettings($, options), options), isTextDisplayOnly: true }
      }
      const input = await parseCommandArgs(args, await inputIo($))
      const { details, summary } = await review($, options, input, next.signal)
      $.ui.toast(`Second opinion: gate ${details.gate.status}`)
      // The verification brief rides as hidden context after the result. A prompt
      // submitted from inside command.run would wait on the turn this hook holds,
      // so the turn that acts on it is started once the command has returned.
      $.clock.after(0, () => {
        $.prompt.submit({ text: VERIFY_NOW }).catch(() => undefined)
      })
      return { text: summary, context: [buildVerificationPrompt(details)] }
    } catch (error) {
      const message = error instanceof PanelAbortedError ? error.message : `Second opinion failed: ${errorText(error)}`
      return { text: message, isTextDisplayOnly: true }
    } finally {
      $.ui.status(undefined)
    }
  }).catch(($, e, next) => ({ text: `Second opinion failed: ${next.error.message ?? next.error.kind}`, isTextDisplayOnly: true }))
}

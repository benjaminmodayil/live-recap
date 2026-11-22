// Choosing a panel and running it: concurrent reviewers, each under a wall
// clock, failed slots refilled from the tier pool.

import type { HttpInit, HttpResponse } from 'claude-code'

import {
  MAX_REVIEWER_COUNT,
  TIER_THINKING,
  VALIDATION_REVIEWER_COUNT,
  VALIDATION_TIER,
  allowedReviewerModels,
  assertAllowedReviewerModel,
  clampReviewerCount,
  isModelTier,
  isThinkingLevel,
  modelFamily,
  parseModelRef,
  shortModelName,
} from './config'
import type { ModelTier, ProviderName, Settings, ThinkingLevel } from './config'
import type { SecondOpinionInput } from './input'
import { EMPTY_USAGE, buildChatRequest, parseChatResponse } from './providers'
import type { ChatUsage } from './providers'
import {
  buildConsensus,
  buildReviewerSystemPrompt,
  buildReviewerUserPrompt,
  computeGateDecision,
  lensFor,
  normalizeParsedReview,
  takePanelItems,
} from './review'
import type { ArtifactInput, ReviewDetails, ReviewerConfig, ReviewerResult } from './review'

export type PanelIo = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  // Resolves after `ms`; rejects once `signal` aborts.
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  now: () => Promise<number>
  // The caller's own cancellation (the person interrupted the turn).
  signal?: AbortSignal
  progress?: (text: string) => void
}

export type Selection = {
  mode: 'pool' | 'explicit'
  tier: ModelTier
  count: number
  // Explicit reviewers, or the usable pool in order; the first `count` start.
  candidates: ReviewerConfig[]
  droppedReviewerCount: number
  requestedMoreThanAvailable: boolean
  skipped: string[]
}

export class PanelAbortedError extends Error {
  constructor() {
    super('The second opinion was cancelled.')
    this.name = 'PanelAbortedError'
  }
}

const providerProblem = (settings: Settings, model: string) => {
  const provider = parseModelRef(model).provider as ProviderName
  return settings.providers[provider] ? undefined : `${provider} is not configured: ${settings.unconfigured[provider]}`
}

const parseThinking = (value: unknown, what: string): ThinkingLevel | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (isThinkingLevel(value)) return value
  throw new Error(`Unknown thinking level "${String(value)}" for ${what}. Use off, minimal, low, medium, high, xhigh or max.`)
}

/**
 * Picks the reviewers for one request.
 *
 * Explicit `reviewers` or `model` run as given (no fallback); otherwise the
 * tier's pool runs in its configured order. Every model, explicit or pooled,
 * passes the reviewer boundary first, so a banned or unlisted model costs no
 * call.
 *
 * @throws on an unknown tier or thinking level, a model the boundary refuses,
 *   an explicit model whose provider is not configured, or a pool with no
 *   usable entry
 */
export const selectReviewers = (settings: Settings, input: SecondOpinionInput): Selection => {
  if (input.modelTier !== undefined && !isModelTier(input.modelTier)) {
    throw new Error(`Unknown tier "${input.modelTier}". Use fast, balanced or strong.`)
  }
  const tier: ModelTier = isModelTier(input.modelTier) ? input.modelTier : input.validation ? VALIDATION_TIER : settings.defaultTier
  const count = input.reviewerCount !== undefined
    ? clampReviewerCount(input.reviewerCount, settings.reviewerCount)
    : input.validation ? VALIDATION_REVIEWER_COUNT : settings.reviewerCount
  const callThinking = parseThinking(input.thinking, 'this call')
  const allowed = allowedReviewerModels(settings)
  const pooledThinking = new Map(
    (['fast', 'balanced', 'strong'] as const).flatMap(name => settings.pools[name].map(entry => [entry.model, entry.thinking] as const)),
  )

  const requested = Array.isArray(input.reviewers) && input.reviewers.length > 0
    ? input.reviewers
    : input.model?.trim() ? [{ model: input.model.trim(), label: input.validation ? 'validator' : 'reviewer' }] : []

  if (requested.length > 0) {
    const seen = new Set<string>()
    const explicit: ReviewerConfig[] = []
    requested.forEach((item, index) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const model = typeof row.model === 'string' ? row.model.trim() : ''
      if (!model || seen.has(model)) return
      seen.add(model)
      explicit.push({
        label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : `reviewer-${index + 1}`,
        model,
        prompt: typeof row.prompt === 'string' && row.prompt.trim() ? row.prompt.trim() : undefined,
        thinking: parseThinking(row.thinking, model) ?? callThinking ?? pooledThinking.get(model) ?? TIER_THINKING[tier],
      })
    })
    if (explicit.length === 0) throw new Error('No reviewer named a model.')

    // Capped before anything is counted, so the panel never runs more than it reports.
    const droppedReviewerCount = Math.max(0, explicit.length - MAX_REVIEWER_COUNT)
    explicit.splice(MAX_REVIEWER_COUNT)
    for (const reviewer of explicit) {
      assertAllowedReviewerModel(reviewer.model, allowed)
      const problem = providerProblem(settings, reviewer.model)
      if (problem) throw new Error(`Reviewer ${reviewer.model} cannot run: ${problem}.`)
    }

    return {
      mode: 'explicit',
      tier,
      count: explicit.length,
      candidates: explicit,
      droppedReviewerCount,
      requestedMoreThanAvailable: false,
      skipped: [],
    }
  }

  const pool = settings.pools[tier]
  if (pool.length === 0) {
    throw new Error(`The ${tier} tier lists no models. Set ${tier}Models in the second-opinion plugin settings.`)
  }
  // A banned entry in the configured pool is a policy violation, not an availability problem.
  for (const entry of pool) assertAllowedReviewerModel(entry.model, allowed)

  const skipped: string[] = []
  const candidates: ReviewerConfig[] = []
  for (const entry of pool) {
    const problem = providerProblem(settings, entry.model)
    if (problem) {
      skipped.push(`${entry.model} (${problem})`)
      continue
    }
    candidates.push({ label: shortModelName(entry.model), model: entry.model, thinking: callThinking ?? entry.thinking ?? TIER_THINKING[tier] })
  }
  if (candidates.length === 0) {
    throw new Error(`No usable models in the ${tier} tier: ${skipped.join('; ')}.`)
  }

  return {
    mode: 'pool',
    tier,
    count,
    candidates,
    droppedReviewerCount: 0,
    requestedMoreThanAvailable: candidates.length < count,
    skipped,
  }
}

export const TIMEOUT = Symbol('timeout')

/**
 * Races `work` against a wall clock and the caller's cancellation. A late
 * rejection of either loser is swallowed.
 *
 * @returns what `work` resolved, or TIMEOUT
 * @throws PanelAbortedError when the caller cancels first
 */
export const withDeadline = async <T>(io: PanelIo, work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => {
  const stop = new AbortController()
  const deadline: Promise<typeof TIMEOUT> = io.sleep(ms, stop.signal).then(
    () => TIMEOUT,
    () => new Promise<never>(() => {}),
  )
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    if (!io.signal) return
    if (io.signal.aborted) return reject(new PanelAbortedError())
    onAbort = () => reject(new PanelAbortedError())
    io.signal.addEventListener('abort', onAbort, { once: true })
  })
  work.catch(() => undefined)
  cancelled.catch(() => undefined)

  try {
    return await Promise.race([work, deadline, cancelled])
  } finally {
    stop.abort()
    if (onAbort) io.signal?.removeEventListener('abort', onAbort)
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const runReviewer = async (
  io: PanelIo,
  settings: Settings,
  config: ReviewerConfig,
  artifact: ArtifactInput,
  artifactType: string,
  request: string,
): Promise<ReviewerResult> => {
  const { provider, modelId } = parseModelRef(config.model)
  const base = {
    label: config.label,
    model: config.model,
    family: modelFamily(config.model),
    thinking: config.thinking,
    prompt: config.prompt,
  }
  const target = settings.providers[provider as ProviderName]
  if (!target) {
    return { ...base, raw: `Reviewer failed: ${provider} is not configured.`, parsed: null, error: `${provider} is not configured`, usage: EMPTY_USAGE }
  }

  const { url, init } = buildChatRequest(
    target,
    modelId,
    buildReviewerSystemPrompt(artifactType, request, config),
    buildReviewerUserPrompt(artifact, artifactType, request),
    config.thinking,
  )
  const startedAt = await io.now()
  let usage: ChatUsage = EMPTY_USAGE

  try {
    const response = await withDeadline(io, io.fetch(url, init), settings.timeoutMs)
    const elapsedMs = (await io.now()) - startedAt
    if (response === TIMEOUT) {
      const reason = `timeout after ${(elapsedMs / 1000).toFixed(1)}s`
      return { ...base, raw: `Reviewer aborted: ${reason}.`, parsed: null, error: reason, timedOut: true, elapsedMs, usage }
    }
    const reply = parseChatResponse(response)
    usage = reply.usage
    const truncated = reply.finishReason === 'length' ? ' (the reply was cut off at its length limit)' : ''
    try {
      return { ...base, raw: reply.text, parsed: normalizeParsedReview(reply.text), elapsedMs, usage }
    } catch (error) {
      throw new Error(`${errorMessage(error)}${truncated}`)
    }
  } catch (error) {
    if (error instanceof PanelAbortedError) throw error
    const message = errorMessage(error)
    const elapsedMs = (await io.now()) - startedAt
    return { ...base, raw: `Reviewer failed: ${message}`, parsed: null, error: message, elapsedMs, usage }
  }
}

/**
 * Runs the selected panel.
 *
 * Each slot reads through its own lens. A pool panel refills a failed slot
 * from the pool's untried models; when the pool runs out, a slot is filled by
 * repeating a model that answered, marked as a repeat so it adds no agreement.
 * A slot nothing could fill keeps its last failure, so the gate sees an
 * incomplete panel instead of a smaller one.
 *
 * @returns one result per slot
 * @throws PanelAbortedError when the caller cancels
 */
export const runPanel = async (
  io: PanelIo,
  settings: Settings,
  selection: Selection,
  artifact: ArtifactInput,
  artifactType: string,
  request: string,
): Promise<ReviewerResult[]> => {
  const total = selection.mode === 'explicit' ? selection.candidates.length : selection.count
  const slots: Array<ReviewerResult | undefined> = Array.from({ length: total })
  const attempted = new Set<string>()
  let answered = 0

  const report = () => io.progress?.(`second opinion: ${answered}/${total} reviewers answered`)

  const run = async (assignments: Array<{ slot: number; config: ReviewerConfig; repeatOf?: string }>) => {
    for (const { config } of assignments) attempted.add(config.model)
    await Promise.all(
      assignments.map(async ({ slot, config, repeatOf }) => {
        const result = await runReviewer(io, settings, config, artifact, artifactType, request)
        slots[slot] = repeatOf ? { ...result, repeatOf } : result
        if (result.parsed) {
          answered += 1
          report()
        }
      }),
    )
  }

  const lensed = (config: ReviewerConfig, slot: number): ReviewerConfig => {
    if (selection.mode === 'explicit') return config
    const lens = lensFor(slot)
    return { ...config, label: `${modelFamily(config.model)}-${lens.label}`, prompt: lens.prompt }
  }

  report()
  await run(selection.candidates.slice(0, total).map((config, slot) => ({ slot, config: lensed(config, slot) })))
  if (selection.mode === 'explicit') return slots.filter((slot): slot is ReviewerResult => slot !== undefined)

  const openSlots = () => slots.flatMap((result, slot) => (result?.parsed ? [] : [slot]))

  // Refill failed slots from untried pool models, a batch at a time.
  for (;;) {
    const open = openSlots()
    const untried = selection.candidates.filter(config => !attempted.has(config.model))
    if (open.length === 0 || untried.length === 0) break
    await run(untried.slice(0, open.length).map((config, index) => {
      const slot = open[index] ?? 0
      return { slot, config: lensed(config, slot) }
    }))
  }

  // Out of distinct models: repeat the first one that answered.
  const source = slots.find(result => result?.parsed)
  const open = openSlots()
  if (source && open.length > 0) {
    const config = selection.candidates.find(candidate => candidate.model === source.model) ?? {
      label: source.label,
      model: source.model,
      thinking: source.thinking,
    }
    await run(
      open.map((slot, index) => {
        const withLens = lensed(config, slot)
        return { slot, config: { ...withLens, label: `${withLens.label}-repeat-${index + 1}` }, repeatOf: source.model }
      }),
    )
  }

  return slots.filter((slot): slot is ReviewerResult => slot !== undefined)
}

/** Gathers a finished panel into the details the summary and gate read. */
export const buildDetails = (
  selection: Selection,
  results: ReviewerResult[],
  artifact: ArtifactInput,
  artifactType: string,
  request: string,
  currentModel?: string,
): ReviewDetails => ({
  request,
  artifact: {
    title: artifact.title,
    path: artifact.path,
    chars: artifact.content.length,
    lines: artifact.content.split(/\r?\n/).length,
    artifactType,
  },
  selection: {
    mode: selection.mode,
    modelTier: selection.tier,
    requestedReviewerCount: selection.mode === 'explicit' ? selection.candidates.length : selection.count,
    actualReviewerCount: results.filter(result => result.parsed).length,
    families: takePanelItems(results.map(result => result.family), MAX_REVIEWER_COUNT),
    currentModel,
    requestedMoreThanAvailable: selection.requestedMoreThanAvailable,
    droppedReviewerCount: selection.droppedReviewerCount || undefined,
    skipped: selection.skipped,
  },
  reviewers: results,
  consensus: buildConsensus(results),
  gate: computeGateDecision(results),
})

// The review itself, free of any I/O: what a reviewer is asked, how its reply
// is read, and how a panel's replies become a consensus and a gate.

import { MAX_REVIEWER_COUNT } from './config'
import type { ModelTier, ThinkingLevel } from './config'
import type { ChatUsage } from './providers'

export const REVIEWER_OUTPUT_TOKEN_BUDGET = 900

export const DEFAULT_OPINION_REQUEST =
  'Give a strong second opinion. If a document is present, verify it is fully up to date with the supplied session context and that its assumptions, reasoning, and conclusions are accurate. Surface anything the initiating agent likely missed. Focus on correctness, clarity, hidden assumptions, execution risk, edge cases, and strongest next improvements.'

export const REVIEW_RETRY_GUIDANCE =
  'Keep intermediate work local. After a blocked gate or failed review run, verify claims, batch confirmed in-scope revisions, and automatically re-run the review without asking for permission. Allow up to three review runs for the same artifact, including the initial review; revisions do not reset this budget, and individual reviewers or fallbacks are not separate review runs. After three failed reviews, stop and ask the user with the remaining blockers; the gate stays blocked. After a passed gate, proceed without another review unless the user explicitly requests one.'

// Each slot of a panel reads the artifact through its own lens, so three
// reviewers are not three copies of one review.
export const REVIEWER_LENSES = [
  { label: 'broad', prompt: 'Give the strongest broad second opinion. Optimize for what matters most, not nitpicks.' },
  { label: 'skeptical', prompt: 'Be adversarial. Assume something important was missed. Hunt for weak claims, ambiguity, and hidden failure modes.' },
  { label: 'delivery', prompt: 'Focus on execution reality: implementation risk, QA gaps, rollout issues, dependency risk, and operational edge cases.' },
  { label: 'editor', prompt: 'Focus on clarity, structure, sharp wording, and concrete rewrite opportunities that would materially improve the artifact.' },
  { label: 'coverage', prompt: 'Focus on missing context, unstated constraints, omitted scenarios, and what a careful reviewer would expect to see but cannot find.' },
  { label: 'quality', prompt: 'Focus on quality bar, correctness, and whether this is actually ready to act on or ship.' },
] as const

export const lensFor = (slot: number) => REVIEWER_LENSES[slot % REVIEWER_LENSES.length] ?? REVIEWER_LENSES[0]

export type ArtifactInput = {
  title: string
  content: string
  path?: string
}

export type ReviewerConfig = {
  label: string
  model: string
  prompt?: string
  thinking: ThinkingLevel
}

export type BlockingFinding = {
  file: string
  line: number | null
  claim: string
  evidence: string
}

export type ParsedReview = {
  verdict: string
  score: number | null
  summary: string
  blocking: BlockingFinding[]
  notVerified: string
}

export type ReviewerResult = {
  label: string
  model: string
  family: string
  thinking: ThinkingLevel
  prompt?: string
  raw: string
  parsed: ParsedReview | null
  error?: string
  timedOut?: boolean
  elapsedMs?: number
  usage: ChatUsage
  // Set on a repeat run: the same model asked again to fill the panel, which
  // is no independent opinion.
  repeatOf?: string
}

export type ConsensusItem = { item: string; count: number; labels: string[] }

export type Consensus = {
  averageScore: number | null
  dominantVerdict?: string
  verdicts: Record<string, number>
  alignment: 'high' | 'moderate' | 'mixed'
  repeatedBlocking: ConsensusItem[]
  outlierFlags: string[]
  topBlocking: string[]
  notVerified: string[]
  failedReviewers: string[]
  repeatedReviewers: string[]
  summary: string
}

export type GateDecision = {
  status: 'passed' | 'blocked'
  reasons: string[]
}

export type ReviewDetails = {
  request: string
  artifact: {
    title: string
    path?: string
    chars: number
    lines: number
    artifactType: string
  }
  selection: {
    mode: 'pool' | 'explicit'
    modelTier: ModelTier
    requestedReviewerCount: number
    actualReviewerCount: number
    families: string[]
    currentModel?: string
    requestedMoreThanAvailable: boolean
    droppedReviewerCount?: number
    skipped: string[]
  }
  reviewers: ReviewerResult[]
  consensus: Consensus
  gate: GateDecision
}

export const inferArtifactType = (input: { artifactType?: string; path?: string; title?: string }) => {
  const explicit = input.artifactType?.trim()
  if (explicit) return explicit

  const source = `${input.path || ''} ${input.title || ''}`.toLowerCase()
  if (source.includes('prd')) return 'prd'
  if (source.includes('spec')) return 'spec'
  if (source.includes('plan')) return 'plan'
  if (source.includes('qa')) return 'qa review'
  if (source.trim().endsWith('.md') || source.includes('readme')) return 'markdown document'
  if (/\.(tsx?|jsx?)\b/.test(source)) return 'source file'
  if (/\.py\b/.test(source)) return 'python source file'
  if (/\.json\b/.test(source)) return 'json document'
  return 'artifact'
}

export const normalizeOpinionRequest = (value?: string) => value?.trim() || DEFAULT_OPINION_REQUEST

export const buildReviewerSystemPrompt = (artifactType: string, request: string, reviewer: ReviewerConfig) =>
  [
    'You are an isolated second-opinion reviewer running independently from all peers.',
    'You only know the artifact text supplied in the user message.',
    'You cannot ask follow-up questions.',
    'You cannot reference parent chat history, repo state, tools, or hidden context beyond what the artifact includes.',
    `Artifact type: ${artifactType}`,
    `Reviewer label: ${reviewer.label}`,
    `Primary request: ${request}`,
    reviewer.prompt ? `Reviewer lens: ${reviewer.prompt}` : undefined,
    '',
    `BUDGET: Your entire reply must be under ${REVIEWER_OUTPUT_TOKEN_BUDGET} tokens. Be terse. Report findings, not analysis.`,
    'Do not explain your reasoning. Do not restate the request. The first character of your reply must be `{`.',
    '',
    'Return ONLY valid JSON. No markdown fences. No prose before or after.',
    'Use this exact shape, and keep every field inside its stated limit:',
    JSON.stringify(
      {
        verdict: 'approve | revise | block | n/a',
        score: 0,
        summary: 'one sentence, at most 200 characters',
        blocking: [
          {
            file: 'path',
            line: 0,
            claim: 'the defect, at most 160 characters',
            evidence: 'the exact text from the artifact that proves it, at most 200 characters',
          },
        ],
        not_verified: 'what you could not check from the artifact, at most 160 characters, or empty',
      },
      null,
      2,
    ),
    '',
    'Rules:',
    '- Put ONLY defects that must be fixed before anyone acts on this artifact in `blocking`. Maximum 5 entries. Use an empty array when none exist.',
    '- A blocking entry needs both a claim and the evidence text that proves it. If you cannot cite evidence from the artifact, do not list it.',
    '- `score` is 0 to 10, where 10 is ready to act on.',
    '- Do not list strengths. Do not write a rubric. Do not restate the artifact.',
  ]
    .filter(line => line !== undefined)
    .join('\n')

export const buildReviewerUserPrompt = (artifact: ArtifactInput, artifactType: string, request: string) => {
  const header = [
    `Give a second opinion on the following ${artifactType}.`,
    `Primary ask: ${request}`,
    `Title: ${artifact.title}`,
    artifact.path ? `Source path: ${artifact.path}` : undefined,
    'Judge only what is present in the text.',
    'If important context is missing, call that out explicitly.',
    'Quote exact wording when useful.',
  ]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\n--- BEGIN ARTIFACT ---\n${artifact.content}\n--- END ARTIFACT ---`
}

/**
 * Finds the reply's JSON object: the whole reply, a fenced block, or the first
 * balanced `{...}` in it.
 *
 * @throws when none parses
 */
export const extractJsonObject = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Reviewer returned empty output.')

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    // look further
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const candidate = fenced[1].trim()
    JSON.parse(candidate)
    return candidate
  }

  const firstBrace = trimmed.indexOf('{')
  if (firstBrace === -1) throw new Error('Reviewer did not return JSON.')

  let depth = 0
  let inString = false
  let escaping = false

  for (let i = firstBrace; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (escaping) {
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      const candidate = trimmed.slice(firstBrace, i + 1)
      JSON.parse(candidate)
      return candidate
    }
  }

  throw new Error('Unable to extract JSON object from reviewer output.')
}

// A finding without a claim is not a finding, so it is dropped rather than
// reported as an empty entry.
const normalizeBlockingFindings = (value: unknown): BlockingFinding[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const claim = typeof row.claim === 'string' ? row.claim.trim() : ''
    if (!claim) return []
    return [{
      file: typeof row.file === 'string' ? row.file.trim() : '',
      line: typeof row.line === 'number' && Number.isFinite(row.line) && row.line > 0 ? row.line : null,
      claim,
      evidence: typeof row.evidence === 'string' ? row.evidence.trim() : '',
    }]
  })
}

/**
 * Reads a reviewer's reply into a review.
 *
 * @throws when the reply holds no JSON, or JSON with no verdict: a `{}` reply
 *   is a broken contract, not an approval, and must reach the fallback
 */
export const normalizeParsedReview = (rawText: string): ParsedReview => {
  const parsed = JSON.parse(extractJsonObject(rawText)) as Record<string, unknown>

  if (typeof parsed.verdict !== 'string' || !parsed.verdict.trim()) {
    throw new Error('Reviewer returned JSON with no verdict.')
  }

  return {
    verdict: parsed.verdict.trim(),
    score: typeof parsed.score === 'number' && Number.isFinite(parsed.score) ? parsed.score : null,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    blocking: normalizeBlockingFindings(parsed.blocking),
    notVerified: typeof parsed.not_verified === 'string' ? parsed.not_verified.trim() : '',
  }
}

const normalizePanelItem = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export const takePanelItems = (items: string[], limit: number) => {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const item of items) {
    const trimmed = item.trim()
    const key = normalizePanelItem(trimmed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    kept.push(trimmed)
    if (kept.length >= limit) break
  }
  return kept
}

const countConsensusItems = (entries: Array<{ label: string; items: string[] }>): ConsensusItem[] => {
  const counts = new Map<string, ConsensusItem>()

  for (const entry of entries) {
    const seenForReviewer = new Set<string>()
    for (const item of entry.items) {
      const trimmed = item.trim()
      const key = normalizePanelItem(trimmed)
      if (!key || seenForReviewer.has(key)) continue
      seenForReviewer.add(key)
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
        existing.labels.push(entry.label)
      } else {
        counts.set(key, { item: trimmed, count: 1, labels: [entry.label] })
      }
    }
  }

  return [...counts.values()].sort((a, b) => b.count - a.count || a.item.localeCompare(b.item))
}

const formatConsensusItems = (items: ConsensusItem[], totalReviewers: number, limit: number) =>
  items
    .slice(0, limit)
    .map(item => `${item.item} (${item.count}/${totalReviewers})`)
    .join(' | ') || undefined

const alignmentOf = (verdicts: Record<string, number>, reviewerCount: number): Consensus['alignment'] => {
  if (reviewerCount <= 1) return 'high'
  const ratio = Math.max(0, ...Object.values(verdicts)) / reviewerCount
  if (ratio >= 0.8) return 'high'
  if (ratio >= 0.6) return 'moderate'
  return 'mixed'
}

type Answered = ReviewerResult & { parsed: ParsedReview }
const isAnswered = (reviewer: ReviewerResult): reviewer is Answered => reviewer.parsed !== null

export const buildConsensus = (reviewers: ReviewerResult[]): Consensus => {
  const answered = reviewers.filter(isAnswered)
  // A repeat is the same model asked again: it adds findings, never agreement.
  const independent = answered.filter(reviewer => !reviewer.repeatOf)
  const voters = independent.length > 0 ? independent : answered
  // Scores average over independent opinions too: a repeat's fresh sample is no second vote.
  const scores = voters
    .map(reviewer => reviewer.parsed.score)
    .filter((score): score is number => typeof score === 'number')

  const verdicts: Record<string, number> = {}
  for (const reviewer of voters) {
    const verdict = reviewer.parsed.verdict || 'n/a'
    verdicts[verdict] = (verdicts[verdict] || 0) + 1
  }

  const blocking = answered.flatMap(reviewer => reviewer.parsed.blocking.map(finding => finding.claim))
  const notVerified = answered.map(reviewer => reviewer.parsed.notVerified).filter(Boolean)
  const counted = countConsensusItems(
    voters.map(reviewer => ({ label: reviewer.label, items: reviewer.parsed.blocking.map(finding => finding.claim) })),
  )
  const repeatedBlocking = counted.filter(item => item.count > 1)
  const uniqueFlags = counted.filter(item => item.count === 1).map(item => item.item)

  const dominantVerdict = Object.entries(verdicts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
  const failedReviewers = reviewers.filter(reviewer => !reviewer.parsed).map(reviewer => reviewer.label)
  const repeatedReviewers = answered.filter(reviewer => reviewer.repeatOf).map(reviewer => reviewer.label)

  // Alignment is agreement across the panel, so a partial panel cannot show high
  // alignment, and a panel where nobody answered shows none.
  const voterCount = voters.length || reviewers.length || 1
  const panelAlignment = alignmentOf(verdicts, voterCount)
  const alignment = answered.length === 0
    ? 'mixed'
    : failedReviewers.length > 0 && panelAlignment === 'high' ? 'moderate' : panelAlignment
  const repeatedLine = formatConsensusItems(repeatedBlocking, voterCount, 3)

  return {
    averageScore: scores.length > 0 ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(1)) : null,
    dominantVerdict,
    verdicts,
    alignment,
    repeatedBlocking: repeatedBlocking.slice(0, 5),
    outlierFlags: takePanelItems(uniqueFlags, 4),
    topBlocking: takePanelItems(blocking, 5),
    notVerified: takePanelItems(notVerified, 3),
    failedReviewers,
    repeatedReviewers,
    summary: [
      answered.length === 0 ? 'no reviewer answered' : `${alignment} alignment`,
      dominantVerdict ? `dominant verdict ${dominantVerdict}` : undefined,
      repeatedLine ? `repeated blocking: ${repeatedLine}` : undefined,
      failedReviewers.length > 0 ? `no result from ${failedReviewers.join(', ')}` : undefined,
      repeatedReviewers.length > 0 ? `${repeatedReviewers.length} repeat run(s) excluded from agreement` : undefined,
    ]
      .filter(Boolean)
      .join(' — '),
  }
}

/**
 * The hard gate: code-owned policy, closed by default.
 *
 * It opens only when every reviewer answered, none returned a verdict other
 * than `approve` or `n/a`, and none reported a blocking finding.
 */
export const computeGateDecision = (reviewers: ReviewerResult[]): GateDecision => {
  const reasons: string[] = []
  const answered = reviewers.filter(isAnswered)
  const missing = reviewers.filter(reviewer => !reviewer.parsed).map(reviewer => reviewer.label)

  if (missing.length > 0) {
    reasons.push(`No result from ${missing.join(', ')}. A gate cannot pass on an incomplete panel.`)
  }

  const blockingVerdicts = [
    ...new Set(
      answered
        .map(reviewer => reviewer.parsed.verdict.trim().toLowerCase())
        .filter(verdict => verdict !== 'approve' && verdict !== 'n/a'),
    ),
  ]
  if (blockingVerdicts.length > 0) reasons.push(`Blocking verdict(s): ${blockingVerdicts.join(', ')}.`)

  const findings = answered.reduce((sum, reviewer) => sum + reviewer.parsed.blocking.length, 0)
  if (findings > 0) reasons.push(`${findings} blocking finding(s) must be resolved and the gate re-run.`)

  if (answered.length === 0) reasons.push('No reviewer supplied a verdict.')

  return { status: reasons.length === 0 ? 'passed' : 'blocked', reasons }
}

export const formatGateDecision = (gate: GateDecision) =>
  gate.status === 'passed'
    ? 'GATE: PASSED — every reviewer answered and none returned a blocking verdict.'
    : ['GATE: BLOCKED', ...gate.reasons.map(reason => `- ${reason}`), REVIEW_RETRY_GUIDANCE].join('\n')

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const formatUsage = (reviewer: ReviewerResult) => {
  const { usage } = reviewer
  if (usage.total === 0 && usage.cost === undefined) return undefined
  const tokens = `${usage.input} in / ${usage.output} out${usage.reasoning ? ` (${usage.reasoning} reasoning)` : ''}`
  return usage.cost !== undefined ? `${tokens}, ~$${usage.cost.toFixed(4)}` : tokens
}

export const formatReviewerBlock = (result: ReviewerResult) => {
  const parsed = result.parsed
  const headline = [
    `[${result.label}] ${result.model}`,
    result.timedOut ? '→ timeout' : parsed?.verdict ? `→ ${parsed.verdict}` : '→ no result',
    result.elapsedMs !== undefined ? `(${seconds(result.elapsedMs)})` : undefined,
    result.repeatOf ? '(repeat run)' : undefined,
  ]
    .filter(Boolean)
    .join(' ')

  const lines = [headline]
  if (result.timedOut) lines.push('Aborted at its wall-clock limit with no result.')
  if (parsed?.score !== null && parsed?.score !== undefined) lines.push(`score: ${parsed.score}`)
  if (parsed?.summary) lines.push(`summary: ${parsed.summary}`)
  for (const finding of parsed?.blocking.slice(0, 5) ?? []) {
    const location = finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ''}: ` : ''
    lines.push(`blocking: ${location}${finding.claim}`)
    if (finding.evidence) lines.push(`  evidence: ${finding.evidence}`)
  }
  if (parsed?.notVerified) lines.push(`not verified: ${parsed.notVerified}`)
  if (!parsed && !result.timedOut) lines.push(`error: ${result.raw.slice(0, 300)}`)
  const usage = formatUsage(result)
  if (usage) lines.push(`usage: ${usage}`)
  return lines.join('\n')
}

const formatVerdicts = (verdicts: Record<string, number>) => {
  const entries = Object.entries(verdicts)
  if (entries.length === 0) return undefined
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([verdict, n]) => `${verdict} x${n}`)
    .join(', ')
}

const formatPanelCost = (reviewers: ReviewerResult[]) => {
  const priced = reviewers.filter(reviewer => reviewer.usage.cost !== undefined)
  const tokens = reviewers.reduce((sum, reviewer) => sum + reviewer.usage.total, 0)
  if (tokens === 0 && priced.length === 0) return undefined
  const cost = priced.reduce((sum, reviewer) => sum + (reviewer.usage.cost ?? 0), 0)
  const costText = priced.length > 0
    ? `, ~$${cost.toFixed(4)} as the providers reported it${priced.length < reviewers.length ? ` (${priced.length}/${reviewers.length} reviewers priced)` : ''}`
    : ''
  return `Panel usage: ${tokens} tokens${costText}`
}

export const formatSummary = (details: ReviewDetails) => {
  const answered = details.reviewers.filter(reviewer => reviewer.parsed).length
  const independent = answered - details.consensus.repeatedReviewers.length
  const repeatedLine = formatConsensusItems(details.consensus.repeatedBlocking, independent > 0 ? independent : 1, 4)
  const verdictLine = formatVerdicts(details.consensus.verdicts)
  const { selection } = details

  const header = [
    'Second opinion',
    `Artifact: ${details.artifact.title}`,
    details.artifact.path ? `Path: ${details.artifact.path}` : undefined,
    `Type: ${details.artifact.artifactType}`,
    `Ask: ${details.request}`,
    selection.currentModel ? `Current model: ${selection.currentModel}` : undefined,
    `Panel: ${selection.actualReviewerCount}/${selection.requestedReviewerCount} reviewers (${selection.families.join(', ') || 'none'}, ${selection.modelTier} tier)`,
    selection.droppedReviewerCount
      ? `Note: ${selection.droppedReviewerCount} explicit reviewer(s) dropped by the ${MAX_REVIEWER_COUNT}-reviewer maximum.`
      : undefined,
    selection.requestedMoreThanAvailable ? 'Note: fewer distinct reviewer models were usable than requested.' : undefined,
    selection.skipped.length > 0 ? `Skipped pool entries: ${selection.skipped.join('; ')}` : undefined,
    formatGateDecision(details.gate),
    details.consensus.averageScore !== null ? `Average score: ${details.consensus.averageScore}` : undefined,
    verdictLine ? `Verdicts: ${verdictLine}` : undefined,
    details.consensus.summary ? `Consensus: ${details.consensus.summary}` : undefined,
    repeatedLine ? `Repeated blocking: ${repeatedLine}` : undefined,
    details.consensus.outlierFlags.length > 0 ? `Single-reviewer flags: ${details.consensus.outlierFlags.join(' | ')}` : undefined,
    details.consensus.notVerified.length > 0 ? `Not verified: ${details.consensus.notVerified.join(' | ')}` : undefined,
    details.consensus.topBlocking.length > 0 ? `Blocking findings: ${details.consensus.topBlocking.join(' | ')}` : undefined,
    formatPanelCost(details.reviewers),
  ]
    .filter(Boolean)
    .join('\n')

  return `${header}\n\n${details.reviewers.map(formatReviewerBlock).join('\n\n')}`.trim()
}

/** What the main agent is asked to do once a `/second-opinion` panel finishes. */
export const buildVerificationPrompt = (details: ReviewDetails) => {
  const blocked = details.gate.status === 'blocked'
  const { consensus } = details

  return [
    `A \`/second-opinion\` panel just finished; its full result is in the command output above. THE GATE IS ${details.gate.status.toUpperCase()}.`,
    blocked
      ? 'The artifact does not pass. Do not start implementation work from it until each confirmed finding is resolved.'
      : 'The artifact passes this gate.',
    "Treat the panel's reasoning as hypotheses, not truth, but the gate decision itself is policy and is not yours to overturn by argument.",
    REVIEW_RETRY_GUIDANCE,
    'Your job now:',
    blocked
      ? '1. Work the blocking findings below in order. For each one, verify it against the artifact text and the project constraints.'
      : '1. Independently verify each material concern or missed item against the artifact text and the project constraints.',
    '2. Separate confirmed issues from false positives and unsupported claims.',
    blocked
      ? '3. Revise the plan, spec, or task breakdown to resolve each confirmed finding, then re-run the gate within the three-review budget. State any finding you could not confirm and why.'
      : '3. Apply any confirmed plan, spec, or task revision. Do not start coding unless the user asked for implementation.',
    '4. For false positives, explain the evidence briefly and do not change the artifact for them.',
    '5. Resolve material disagreement against local evidence and report anything still unresolved.',
    '',
    'Second-opinion context:',
    `- Artifact: ${details.artifact.title}${details.artifact.path ? ` (${details.artifact.path})` : ''}`,
    `- Ask: ${details.request}`,
    `- Gate: ${details.gate.status.toUpperCase()}`,
    ...details.gate.reasons.map(reason => `  - ${reason}`),
    consensus.averageScore !== null ? `- Average score: ${consensus.averageScore}` : undefined,
    consensus.dominantVerdict ? `- Dominant verdict: ${consensus.dominantVerdict}` : undefined,
    consensus.topBlocking.length > 0 ? `- Blocking findings: ${consensus.topBlocking.join(' | ')}` : undefined,
    consensus.notVerified.length > 0 ? `- Not verified by the panel: ${consensus.notVerified.join(' | ')}` : undefined,
    consensus.failedReviewers.length > 0 ? `- No result from: ${consensus.failedReviewers.join(', ')}` : undefined,
    consensus.outlierFlags.length > 0 ? `- Single-reviewer flags: ${consensus.outlierFlags.join(' | ')}` : undefined,
    '',
    blocked
      ? 'Verify first, then revise. The gate stays blocked until each confirmed finding is resolved and the gate is re-run.'
      : 'Do not blindly accept the panel. Verify first, then act.',
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

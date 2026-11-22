import { expect, test } from 'claude-code/testing'

import { EMPTY_USAGE } from '../hooks/providers'
import {
  buildConsensus,
  buildVerificationPrompt,
  computeGateDecision,
  extractJsonObject,
  inferArtifactType,
  normalizeParsedReview,
} from '../hooks/review'
import type { ParsedReview, ReviewerResult } from '../hooks/review'

const answered = (label: string, parsed: Partial<ParsedReview>, extra: Partial<ReviewerResult> = {}): ReviewerResult => ({
  label,
  model: `openrouter/x/${label}`,
  family: 'x',
  thinking: 'high',
  raw: '',
  parsed: { verdict: 'approve', score: 8, summary: '', blocking: [], notVerified: '', ...parsed },
  usage: EMPTY_USAGE,
  ...extra,
})

const failed = (label: string): ReviewerResult => ({
  label,
  model: `openrouter/x/${label}`,
  family: 'x',
  thinking: 'high',
  raw: 'Reviewer failed: HTTP 500',
  parsed: null,
  error: 'HTTP 500',
  usage: EMPTY_USAGE,
})

const finding = { file: 'PLAN.md', line: 3, claim: 'No rollback step', evidence: '1. Ship it.' }

test('the reply JSON is found bare, fenced, or inside prose', () => {
  expect(extractJsonObject('{"verdict":"approve"}')).toBe('{"verdict":"approve"}')
  expect(extractJsonObject('Here:\n```json\n{"verdict":"revise"}\n```')).toBe('{"verdict":"revise"}')
  expect(extractJsonObject('Sure. {"verdict":"block","summary":"a } inside"} trailing')).toBe('{"verdict":"block","summary":"a } inside"}')
  expect(() => extractJsonObject('no json here')).toThrow(/did not return JSON/)
  expect(() => extractJsonObject('   ')).toThrow(/empty/)
})

test('a reply with no verdict is a broken contract, never an approval', () => {
  expect(() => normalizeParsedReview('{}')).toThrow(/no verdict/)
  expect(() => normalizeParsedReview('{"verdict":"  "}')).toThrow(/no verdict/)
})

test('blocking findings without a claim are dropped', () => {
  const review = normalizeParsedReview(JSON.stringify({ verdict: 'revise', score: 4, blocking: [finding, { file: 'x' }, 'text'], not_verified: 'load' }))
  expect(review).toEqual({ verdict: 'revise', score: 4, summary: '', blocking: [finding], notVerified: 'load' })
})

test('the gate passes only on a complete panel of approvals with no blocking finding', () => {
  expect(computeGateDecision([answered('a', {}), answered('b', { verdict: 'n/a' })])).toEqual({ status: 'passed', reasons: [] })

  const incomplete = computeGateDecision([answered('a', {}), failed('b')])
  expect(incomplete.status).toBe('blocked')
  expect(incomplete.reasons[0]).toMatch(/No result from b/)

  expect(computeGateDecision([answered('a', { verdict: 'revise' })]).reasons).toEqual(['Blocking verdict(s): revise.'])

  const findingUnderApproval = computeGateDecision([answered('a', { blocking: [finding] })])
  expect(findingUnderApproval.status).toBe('blocked')
  expect(findingUnderApproval.reasons).toEqual(['1 blocking finding(s) must be resolved and the gate re-run.'])

  expect(computeGateDecision([]).reasons).toEqual(['No reviewer supplied a verdict.'])
})

test('a partial panel cannot claim high alignment, and a repeat run adds no agreement', () => {
  const partial = buildConsensus([answered('a', {}), answered('b', {}), failed('c')])
  expect(partial.alignment).toBe('moderate')
  expect(partial.failedReviewers).toEqual(['c'])

  const silent = buildConsensus([failed('a')])
  expect(silent.alignment).toBe('mixed')
  expect(silent.summary).toBe('no reviewer answered — no result from a')

  const withRepeat = buildConsensus([
    answered('a', { verdict: 'revise', blocking: [finding] }),
    answered('a-repeat-1', { verdict: 'revise', blocking: [finding] }, { repeatOf: 'openrouter/x/a' }),
    answered('b', { verdict: 'approve' }),
  ])
  expect(withRepeat.verdicts).toEqual({ approve: 1, revise: 1 })
  expect(withRepeat.repeatedBlocking).toEqual([])
  expect(withRepeat.repeatedReviewers).toEqual(['a-repeat-1'])
  expect(withRepeat.outlierFlags).toEqual(['No rollback step'])
})

test('a finding two independent reviewers share is counted as repeated', () => {
  const consensus = buildConsensus([
    answered('a', { verdict: 'revise', score: 4, blocking: [finding] }),
    answered('b', { verdict: 'revise', score: 6, blocking: [{ ...finding, claim: 'no rollback step!' }] }),
  ])
  expect(consensus.repeatedBlocking).toEqual([{ item: 'No rollback step', count: 2, labels: ['a', 'b'] }])
  expect(consensus.averageScore).toBe(5)
  expect(consensus.dominantVerdict).toBe('revise')
})

test('the artifact type comes from the label, else the file name', () => {
  expect(inferArtifactType({ artifactType: ' research ' })).toBe('research')
  expect(inferArtifactType({ path: '/p/PLAN.md' })).toBe('plan')
  expect(inferArtifactType({ path: '/p/notes.md' })).toBe('markdown document')
  expect(inferArtifactType({ title: 'Inline artifact' })).toBe('artifact')
})

test('the follow-up prompt states the gate and the blocking findings', () => {
  const results = [answered('a', { verdict: 'revise', blocking: [finding] })]
  const prompt = buildVerificationPrompt({
    request: 'find gaps',
    artifact: { title: 'PLAN.md', path: '/p/PLAN.md', chars: 10, lines: 1, artifactType: 'plan' },
    selection: { mode: 'pool', modelTier: 'strong', requestedReviewerCount: 1, actualReviewerCount: 1, families: ['x'], requestedMoreThanAvailable: false, skipped: [] },
    reviewers: results,
    consensus: buildConsensus(results),
    gate: computeGateDecision(results),
  })
  expect(prompt).toContain('THE GATE IS BLOCKED')
  expect(prompt).toContain('- Blocking findings: No rollback step')
  expect(prompt).toContain('three review runs')
})

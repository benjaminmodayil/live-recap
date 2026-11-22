import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { buildSessionTranscript, parseCommandArgs, resolveArtifact, resolvePath } from '../hooks/input'
import type { InputIo } from '../hooks/input'

const OWN = ['mcp__second-opinion__second_opinion']

const io = (files: Record<string, string>, messages: SessionMessage[] = []): InputIo => ({
  cwd: '/proj',
  home: '/home/me',
  isFile: async path => path in files,
  readFile: async path => {
    const text = files[path]
    if (text === undefined) throw new Error(`ENOENT ${path}`)
    return text
  },
  messages: async () => messages,
})

const SESSION: SessionMessage[] = [
  { role: 'user', text: 'Plan the migration.<system-reminder>secret context</system-reminder>', toolUses: [] },
  {
    role: 'assistant',
    text: 'Here is the plan.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Write', input: { file_path: '/proj/PLAN.md' } },
      { tool_use_id: 't2', tool: OWN[0] ?? '', input: { content: 'the whole plan again' } },
    ],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [] },
  { role: 'user', text: 'Second opinion\nArtifact: PLAN.md\nGATE: BLOCKED', toolUses: [] },
]

test('paths resolve like a person types them', () => {
  expect(resolvePath('/proj', '/home/me', '@docs/../PLAN.md')).toBe('/proj/PLAN.md')
  expect(resolvePath('/proj', '/home/me', '~/notes/x.md')).toBe('/home/me/notes/x.md')
  expect(resolvePath('/proj', '/home/me', '/abs/./y.md')).toBe('/abs/y.md')
  expect(resolvePath('C:\\proj', undefined, 'PLAN.md')).toBe('C:\\proj\\PLAN.md')
})

test('command flags come out, then a path, then the ask', async () => {
  const files = { '/proj/PLAN.md': '# plan', '/proj/my plan.md': '# spaced' }
  expect(await parseCommandArgs('--tier fast --reviewers 2 PLAN.md check rollout risk', io(files))).toEqual({
    path: 'PLAN.md',
    focus: 'check rollout risk',
    modelTier: 'fast',
    reviewerCount: 2,
  })
  expect(await parseCommandArgs('"my plan.md" --focus is it complete?', io(files))).toEqual({ path: 'my plan.md', focus: 'is it complete?' })
  expect(await parseCommandArgs('--validate --thinking low --no-context --model openrouter/x/y', io(files))).toEqual({
    validation: true,
    thinking: 'low',
    includeSessionContext: false,
    model: 'openrouter/x/y',
  })
})

test('an ask with no file reviews the session; a path-like first word is taken as a path', async () => {
  expect(await parseCommandArgs('is the storage choice sound at 10x load?', io({}))).toEqual({ focus: 'is the storage choice sound at 10x load?' })
  expect(await parseCommandArgs('docs/MISSING.md check it', io({}))).toEqual({ path: 'docs/MISSING.md', focus: 'check it' })
  expect(await parseCommandArgs('', io({}))).toEqual({})
})

test('the transcript keeps messages and tool call notes, and leaves out reminders, tool results and the plugin itself', () => {
  const transcript = buildSessionTranscript(SESSION, OWN) ?? ''
  expect(transcript).toContain('## user\nPlan the migration.')
  expect(transcript).toContain('[tool call: Write {"file_path":"/proj/PLAN.md"}]')
  expect(transcript).not.toContain('secret context')
  expect(transcript).not.toContain('the whole plan again')
  expect(transcript).not.toContain('GATE: BLOCKED')
  expect(buildSessionTranscript([], OWN)).toBeUndefined()
})

test('a file is reviewed with the session as context, unless context is turned off', async () => {
  const files = { '/proj/PLAN.md': '# Plan\n1. Ship it.' }
  const withContext = await resolveArtifact(io(files, SESSION), { path: 'PLAN.md', focus: 'gaps?' }, OWN)
  expect(withContext.artifact.path).toBe('/proj/PLAN.md')
  expect(withContext.artifact.title).toBe('PLAN.md')
  expect(withContext.artifactType).toBe('plan')
  expect(withContext.request).toBe('gaps?')
  expect(withContext.artifact.content).toContain('## Primary artifact')
  expect(withContext.artifact.content).toContain('## Surrounding session context')

  const bare = await resolveArtifact(io(files, SESSION), { path: 'PLAN.md', includeSessionContext: false }, OWN)
  expect(bare.artifact.content).toBe('# Plan\n1. Ship it.')
  expect(bare.request).toMatch(/^Give a strong second opinion/)
})

test('a file named in the prompt is found and the rest becomes the ask', async () => {
  const files = { '/proj/docs/SPEC.md': 'spec text' }
  const resolved = await resolveArtifact(io(files), { prompt: 'pressure test docs/SPEC.md for missing edge cases' }, OWN)
  expect(resolved.artifact.path).toBe('/proj/docs/SPEC.md')
  expect(resolved.request).toBe('pressure test for missing edge cases')
})

test('with nothing named, the session transcript is the artifact', async () => {
  const resolved = await resolveArtifact(io({}, SESSION), { focus: 'did we miss anything?' }, OWN)
  expect(resolved.artifactType).toBe('session transcript')
  expect(resolved.artifact.title).toBe('Current Claude Code session')
  await expect(resolveArtifact(io({}), {}, OWN)).rejects.toThrow(/Nothing to review/)
})

test('inline content is reviewed as given; both a path and content is refused; a missing path is named', async () => {
  const inline = await resolveArtifact(io({}), { content: 'Step 1', title: 'Draft plan', includeSessionContext: false }, OWN)
  expect(inline.artifact).toEqual({ title: 'Draft plan', content: 'Step 1' })
  await expect(resolveArtifact(io({}), { content: 'x', path: 'a.md' }, OWN)).rejects.toThrow(/not both/)
  await expect(resolveArtifact(io({}), { path: 'docs/MISSING.md' }, OWN)).rejects.toThrow('Artifact path not found: /proj/docs/MISSING.md')
})

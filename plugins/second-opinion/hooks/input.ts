// What gets reviewed: a file, inline text, or the session transcript, and the
// session context that rides along with a file or text.

import type { SessionMessage } from 'claude-code'

import { inferArtifactType, normalizeOpinionRequest } from './review'
import type { ArtifactInput } from './review'

// One artifact goes to every reviewer in full, so it is bounded.
export const MAX_ARTIFACT_CHARS = 400_000
export const MAX_TRANSCRIPT_CHARS = 120_000
export const SESSION_TITLE = 'Current Claude Code session'

/** The second-opinion request, as the tool takes it and the command builds it. */
export type SecondOpinionInput = {
  prompt?: string
  path?: string
  content?: string
  title?: string
  artifactType?: string
  focus?: string
  reviewerCount?: number
  reviewers?: unknown
  model?: string
  modelTier?: string
  validation?: boolean
  thinking?: string
  includeSessionContext?: boolean
}

export type InputIo = {
  cwd: string
  home?: string
  isFile: (path: string) => Promise<boolean>
  readFile: (path: string) => Promise<string>
  messages: () => Promise<readonly SessionMessage[]>
}

export type ResolvedArtifact = {
  artifact: ArtifactInput
  artifactType: string
  request: string
}

export const tokenizeCommandArgs = (args: string) => {
  const tokens: string[] = []
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(args)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["'\\])/g, '$1'))
  }
  return tokens
}

const removeOption = (tokens: string[], names: string[], takesValue: boolean) => {
  const rest: string[] = []
  let value: string | undefined
  let isPresent = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''
    if (names.includes(token)) {
      isPresent = true
      if (takesValue) {
        value = tokens[i + 1]
        i += 1
      }
      continue
    }
    rest.push(token)
  }
  return { tokens: rest, value, isPresent }
}

/** Takes the command's flags out of its tokens. */
export const parseCommandOptions = (tokens: string[]) => {
  const model = removeOption(tokens, ['--model'], true)
  const tier = removeOption(model.tokens, ['--tier', '--model-tier'], true)
  const validation = removeOption(tier.tokens, ['--validate', '--validation'], false)
  const reviewers = removeOption(validation.tokens, ['--reviewers', '--reviewer-count'], true)
  const thinking = removeOption(reviewers.tokens, ['--thinking'], true)
  const noContext = removeOption(thinking.tokens, ['--no-context'], false)

  const options: SecondOpinionInput = {}
  if (model.value) options.model = model.value
  if (tier.value) options.modelTier = tier.value
  if (validation.isPresent) options.validation = true
  if (reviewers.value && /^\d+$/.test(reviewers.value)) options.reviewerCount = Number(reviewers.value)
  if (thinking.value) options.thinking = thinking.value
  if (noContext.isPresent) options.includeSessionContext = false

  return { tokens: noContext.tokens, options }
}

const splitFocusFlag = (tokens: string[]) => {
  const index = tokens.findIndex(token => token === '--focus' || token === '--ask')
  if (index === -1) return { pathTokens: tokens, focus: undefined }
  return { pathTokens: tokens.slice(0, index), focus: tokens.slice(index + 1).join(' ').trim() || undefined }
}

export const mergeFocus = (...parts: Array<string | undefined>) =>
  parts
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .trim() || undefined

const basename = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? value

export const isProbablyPathLike = (value: string) => {
  const trimmed = value.trim()
  const cleaned = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  if (!cleaned) return false
  return (
    trimmed.startsWith('@') ||
    cleaned.startsWith('.') ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('~') ||
    cleaned.includes('/') ||
    cleaned.includes('\\') ||
    /\.[A-Za-z0-9]{1,8}(?:$|[#?:])/.test(basename(cleaned))
  )
}

export const isProbablyNaturalLanguagePrompt = (value: string) => /\s/.test(value.trim()) && !isProbablyPathLike(value)

/**
 * Resolves a path the way a person types it: a leading `@` dropped, `~`
 * expanded, a relative path taken from the working directory.
 */
export const resolvePath = (cwd: string, home: string | undefined, value: string) => {
  let path = value.trim()
  if (path.startsWith('@')) path = path.slice(1)
  if (home && (path === '~' || path.startsWith('~/'))) path = `${home.replace(/\/+$/, '')}${path.slice(1)}`
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  if (!path.startsWith('/')) {
    if (!cwd.startsWith('/')) return `${cwd.replace(/[\\/]+$/, '')}\\${path}`
    path = `${cwd.replace(/\/+$/, '')}/${path}`
  }

  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

const exists = async (io: InputIo, value: string) => {
  if (!value.trim()) return false
  try {
    return await io.isFile(resolvePath(io.cwd, io.home, value))
  } catch {
    return false
  }
}

const stripPunctuation = (value: string) => value.trim().replace(/^[('"`]+/, '').replace(/[)'"`,.;:!?]+$/, '')

/** Finds an existing file named inside a sentence, and the words around it. */
export const extractEmbeddedPath = async (io: InputIo, value: string) => {
  const tokens = tokenizeCommandArgs(value.trim())
  for (let start = 0; start < tokens.length; start++) {
    for (let end = tokens.length; end > start; end--) {
      const candidate = stripPunctuation(tokens.slice(start, end).join(' '))
      if (!candidate || !isProbablyPathLike(candidate)) continue
      if (!(await exists(io, candidate))) continue
      return {
        path: candidate,
        focus: mergeFocus(tokens.slice(0, start).join(' '), tokens.slice(end).join(' ')),
      }
    }
  }
  return undefined
}

/**
 * Reads `/second-opinion` arguments: flags, then an optional file path, then
 * the ask. No path reviews the session transcript.
 *
 * @example
 * await parseCommandArgs('--tier fast PLAN.md check rollout risk', io)
 * // { path: 'PLAN.md', focus: 'check rollout risk', modelTier: 'fast' }
 */
export const parseCommandArgs = async (args: string, io: InputIo): Promise<SecondOpinionInput> => {
  const { tokens, options } = parseCommandOptions(tokenizeCommandArgs(args.trim()))
  const whole = tokens.join(' ').trim()
  if (!whole) return options
  if (await exists(io, whole)) return { path: whole, ...options }

  const { pathTokens, focus } = splitFocusFlag(tokens)
  if (pathTokens.length === 0) return { focus, ...options }

  const joined = pathTokens.join(' ').trim()
  if (await exists(io, joined)) return { path: joined, focus, ...options }

  const first = pathTokens[0] ?? ''
  const trailing = pathTokens.slice(1).join(' ')
  if ((await exists(io, first)) || isProbablyPathLike(first)) {
    return { path: first, focus: mergeFocus(trailing, focus), ...options }
  }

  return { focus: mergeFocus(joined, focus), ...options }
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
// The plugin's own output, which a later review must not read back as context.
const OWN_OUTPUT = /(^|\n)Second opinion\nArtifact: |A `\/second-opinion` panel just finished/

const previewInput = (input: unknown) => {
  const json = JSON.stringify(input) ?? ''
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

/**
 * The session as reviewers read it: each message's text and a one-line note
 * per tool call. Tool results, system reminders and this plugin's own calls
 * and output are left out; the oldest part goes first when it runs long.
 *
 * @returns the transcript, or undefined when the session has nothing to show
 */
export const buildSessionTranscript = (messages: readonly SessionMessage[], ownTools: readonly string[]) => {
  const lines: string[] = []

  for (const message of messages) {
    const text = message.text.replace(SYSTEM_REMINDER, '').trim()
    if (OWN_OUTPUT.test(text)) continue
    const calls = (message.toolUses ?? [])
      .filter(use => !ownTools.includes(use.tool))
      .map(use => `[tool call: ${use.tool} ${previewInput(use.input)}]`)
    if (!text && calls.length === 0) continue
    lines.push('', `## ${message.role}`)
    if (text) lines.push(text)
    lines.push(...calls)
  }

  if (lines.length === 0) return undefined

  const body = lines.join('\n').trim()
  const kept = body.length > MAX_TRANSCRIPT_CHARS
    ? `[Earlier transcript omitted; keeping the last ${MAX_TRANSCRIPT_CHARS} characters.]\n\n${body.slice(-MAX_TRANSCRIPT_CHARS)}`
    : body
  return `# ${SESSION_TITLE}\n\nThe conversation so far, supplied as context. Tool results are left out.\n\n${kept}`
}

const capArtifact = (content: string) =>
  content.length > MAX_ARTIFACT_CHARS
    ? `${content.slice(0, MAX_ARTIFACT_CHARS)}\n\n[Artifact truncated: ${content.length - MAX_ARTIFACT_CHARS} more characters left out.]`
    : content

const packageWithContext = (artifact: ArtifactInput, transcript: string): ArtifactInput => ({
  ...artifact,
  content: [
    '# Second-opinion review package',
    '',
    'This package holds the primary artifact plus the surrounding session, so reviewers can check whether the artifact is up to date and whether its assumptions and conclusions match the conversation.',
    '',
    '## Primary artifact',
    artifact.path ? `Source path: ${artifact.path}` : undefined,
    '',
    artifact.content,
    '',
    '## Surrounding session context',
    transcript,
  ]
    .filter(line => line !== undefined)
    .join('\n'),
})

/**
 * Settles what the panel reviews and what it is asked.
 *
 * No path and no content: a file named in the prompt, else the session
 * transcript. A path that is really a sentence is read the same way. A file or
 * text carries the session transcript as context unless
 * `includeSessionContext` is false.
 *
 * @throws when both path and content are given, the file is missing, or there
 *   is nothing to review
 */
export const resolveArtifact = async (
  io: InputIo,
  input: SecondOpinionInput,
  ownTools: readonly string[],
): Promise<ResolvedArtifact> => {
  const hasContent = typeof input.content === 'string'
  let path = input.path?.trim() || undefined
  let focus = mergeFocus(input.prompt, input.focus)
  let isTranscript = false

  if (path && hasContent) throw new Error('Provide exactly one artifact: path or content, not both.')

  if (!path && !hasContent) {
    const named = focus && ((await exists(io, focus)) ? { path: focus, focus: undefined } : await extractEmbeddedPath(io, focus))
    if (named) {
      path = named.path
      focus = named.focus
    } else {
      isTranscript = true
    }
  } else if (path && !(await exists(io, path))) {
    const embedded = await extractEmbeddedPath(io, path)
    if (embedded) {
      path = embedded.path
      focus = mergeFocus(focus, embedded.focus)
    } else if (isProbablyNaturalLanguagePrompt(path)) {
      focus = mergeFocus(focus, path)
      path = undefined
      isTranscript = true
    } else {
      throw new Error(`Artifact path not found: ${resolvePath(io.cwd, io.home, path)}. If this was a review prompt, pass it as focus instead.`)
    }
  }

  const transcript = isTranscript || input.includeSessionContext !== false
    ? buildSessionTranscript(await io.messages(), ownTools)
    : undefined

  if (isTranscript) {
    if (!transcript) {
      throw new Error('Nothing to review: no file or content was given, and the session has no messages yet.')
    }
    return {
      artifact: { title: input.title?.trim() || SESSION_TITLE, content: transcript },
      artifactType: input.artifactType?.trim() || 'session transcript',
      request: normalizeOpinionRequest(focus),
    }
  }

  let base: ArtifactInput
  if (path) {
    const resolved = resolvePath(io.cwd, io.home, path)
    base = { title: input.title?.trim() || basename(resolved), content: capArtifact(await io.readFile(resolved)), path: resolved }
  } else {
    base = { title: input.title?.trim() || 'Inline artifact', content: capArtifact(input.content ?? '') }
  }
  if (!base.content.trim()) throw new Error(`The artifact "${base.title}" is empty.`)

  return {
    artifact: transcript ? packageWithContext(base, transcript) : base,
    artifactType: inferArtifactType({ artifactType: input.artifactType, path: base.path, title: base.title }),
    request: normalizeOpinionRequest(focus),
  }
}

// Settings: which providers are reachable, which models each tier may use, and
// the reviewer boundary (the pool allowlist and the Anthropic-model ban).

export const MODEL_TIERS = ['fast', 'balanced', 'strong'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

// The reasoning effort a tier asks for when neither the pool entry nor the call names one.
export const TIER_THINKING: Record<ModelTier, ThinkingLevel> = {
  fast: 'off',
  balanced: 'medium',
  strong: 'high',
}

export const MAX_REVIEWER_COUNT = 8
export const DEFAULT_REVIEWER_COUNT = 3
export const VALIDATION_TIER: ModelTier = 'fast'
export const VALIDATION_REVIEWER_COUNT = 1
export const DEFAULT_TIMEOUT_SECONDS = 150

export const PROVIDER_NAMES = ['openrouter', 'litellm'] as const
export type ProviderName = (typeof PROVIDER_NAMES)[number]

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type Provider = {
  name: ProviderName
  baseUrl: string
  apiKey?: string
}

export type PoolEntry = {
  model: string
  thinking?: ThinkingLevel
}

export type Settings = {
  // Providers with what they need to be called. A provider missing here is
  // explained in `unconfigured`.
  providers: Partial<Record<ProviderName, Provider>>
  unconfigured: Partial<Record<ProviderName, string>>
  pools: Record<ModelTier, PoolEntry[]>
  defaultTier: ModelTier
  reviewerCount: number
  timeoutMs: number
}

// The environment variables the settings fall back to, read by the caller
// (`$.env.get` takes literal names only).
export type SettingsEnv = {
  OPENROUTER_API_KEY?: string
  LITELLM_BASE_URL?: string
  LITELLM_API_KEY?: string
}

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)

export const isModelTier = (value: unknown): value is ModelTier =>
  typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)

export const clampReviewerCount = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_REVIEWER_COUNT, Math.trunc(value)))
    : fallback

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/**
 * Parses a tier's model list: refs split on commas or new lines, each an exact
 * `provider/model` ref with an optional `=thinking` suffix.
 *
 * @example
 * parseModelList('openrouter/openai/gpt-5.5=xhigh, litellm/glm-5')
 * // [{ model: 'openrouter/openai/gpt-5.5', thinking: 'xhigh' }, { model: 'litellm/glm-5' }]
 */
export const parseModelList = (value: unknown): PoolEntry[] => {
  const seen = new Set<string>()
  const entries: PoolEntry[] = []

  for (const part of text(value).split(/[,\n]/)) {
    const raw = part.trim()
    if (!raw) continue

    const at = raw.lastIndexOf('=')
    const suffix = at > 0 ? raw.slice(at + 1).trim().toLowerCase() : ''
    const model = (isThinkingLevel(suffix) ? raw.slice(0, at) : raw).trim()
    if (!model || seen.has(model)) continue

    seen.add(model)
    entries.push(isThinkingLevel(suffix) ? { model, thinking: suffix } : { model })
  }

  return entries
}

/**
 * Splits a model ref at its first slash: the provider, then the model id the
 * provider is sent verbatim (which may hold slashes of its own).
 */
export const parseModelRef = (ref: string): { provider: string; modelId: string } => {
  const slash = ref.indexOf('/')
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Invalid model ref "${ref}". Use provider/model, such as openrouter/openai/gpt-5.5 or litellm/my-model.`)
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

export const isProviderName = (value: string): value is ProviderName =>
  (PROVIDER_NAMES as readonly string[]).includes(value)

// The session runs on Claude, so a second opinion from a Claude model is not an
// outside opinion. The vendor token can sit in a path segment (anthropic/claude-x),
// a dotted prefix (anthropic.claude-x on Bedrock) or an alias (~anthropic/...), and
// a router may list the family alone (sonnet-4.5), so both are matched.
const EXCLUDED_VENDOR = /(^|[.\/~])anthropic([.\/~:-]|$)/
const EXCLUDED_FAMILY = /(^|[.\/~-])(claude|sonnet|opus|haiku)([.\/~:-]|$)/
// A router picks the model per request and can land on the excluded vendor.
// OpenRouter's own `openrouter/*` ids (auto, free and the like) are all routers.
const OPAQUE_ROUTER = /^openrouter\/|(^|\/)(auto|router)(:|$)/

export const isExcludedReviewerModel = (modelId: string) => {
  const id = modelId.trim().toLowerCase()
  return EXCLUDED_VENDOR.test(id) || EXCLUDED_FAMILY.test(id)
}

export const isOpaqueRouterModel = (modelId: string) => OPAQUE_ROUTER.test(modelId.trim().toLowerCase())

/** Every model ref any tier lists: the only models a reviewer may run. */
export const allowedReviewerModels = (settings: Settings) => {
  const allowed = new Set<string>()
  for (const tier of MODEL_TIERS) for (const entry of settings.pools[tier]) allowed.add(entry.model)
  return allowed
}

/**
 * The one boundary every reviewer passes, on every path: a known provider, no
 * Anthropic model, no opaque router, and listed in a tier pool.
 *
 * @throws naming the ref and the rule it breaks
 */
export const assertAllowedReviewerModel = (ref: string, allowed: ReadonlySet<string>) => {
  const { provider, modelId } = parseModelRef(ref)

  if (!isProviderName(provider)) {
    throw new Error(`Reviewer model ${ref} names an unknown provider "${provider}". Use openrouter/<model> or litellm/<model>.`)
  }
  if (isExcludedReviewerModel(modelId)) {
    throw new Error(`Reviewer model ${ref} is an Anthropic model. A second opinion comes from outside Claude, so Anthropic models never review.`)
  }
  if (isOpaqueRouterModel(modelId)) {
    throw new Error(`Reviewer model ${ref} is a router that can pick any model, Claude included. Use a concrete model.`)
  }
  if (!allowed.has(ref)) {
    throw new Error(`Reviewer model ${ref} is in no tier pool. Add it to strongModels, balancedModels or fastModels in the plugin's settings, or use a listed model.`)
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '')

/**
 * Reads the plugin's options and environment fallbacks into settings.
 *
 * @param options what `register` received (the manifest's userConfig values)
 * @param env the environment variables the options fall back to
 */
export const resolveSettings = (options: Readonly<Record<string, unknown>>, env: SettingsEnv): Settings => {
  const providers: Settings['providers'] = {}
  const unconfigured: Settings['unconfigured'] = {}

  const openrouterKey = text(options.openrouterApiKey) || text(env.OPENROUTER_API_KEY)
  if (openrouterKey) {
    providers.openrouter = { name: 'openrouter', baseUrl: OPENROUTER_BASE_URL, apiKey: openrouterKey }
  } else {
    unconfigured.openrouter = 'no API key (set openrouterApiKey in the plugin settings, or OPENROUTER_API_KEY)'
  }

  const litellmUrl = trimSlash(text(options.litellmBaseUrl) || text(env.LITELLM_BASE_URL))
  if (/^https?:\/\//.test(litellmUrl)) {
    const apiKey = text(options.litellmApiKey) || text(env.LITELLM_API_KEY) || undefined
    providers.litellm = { name: 'litellm', baseUrl: litellmUrl, apiKey }
  } else {
    unconfigured.litellm = litellmUrl
      ? `proxy URL "${litellmUrl}" is not an http(s) URL`
      : 'no proxy URL (set litellmBaseUrl in the plugin settings, or LITELLM_BASE_URL)'
  }

  const seconds = typeof options.timeoutSeconds === 'number' && options.timeoutSeconds > 0
    ? options.timeoutSeconds
    : DEFAULT_TIMEOUT_SECONDS

  return {
    providers,
    unconfigured,
    pools: {
      strong: parseModelList(options.strongModels),
      balanced: parseModelList(options.balancedModels),
      fast: parseModelList(options.fastModels),
    },
    defaultTier: isModelTier(options.defaultTier) ? options.defaultTier : 'strong',
    reviewerCount: clampReviewerCount(options.reviewerCount, DEFAULT_REVIEWER_COUNT),
    timeoutMs: Math.round(seconds * 1000),
  }
}

const VENDOR_ALIASES: Record<string, string> = {
  'z-ai': 'zai',
  'x-ai': 'xai',
  moonshotai: 'moonshot',
  'meta-llama': 'meta',
  mistralai: 'mistral',
}

const FAMILY_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[^a-z])(gpt|o[1-9]|chatgpt|codex)/, 'openai'],
  [/gemini|gemma/, 'google'],
  [/glm/, 'zai'],
  [/grok/, 'xai'],
  [/deepseek/, 'deepseek'],
  [/qwen/, 'qwen'],
  [/kimi/, 'moonshot'],
  [/mistral|codestral|devstral/, 'mistral'],
  [/llama/, 'meta'],
]

/**
 * The model's maker, for display and panel diversity: the vendor segment of an
 * aggregator id (`openai/gpt-5.5`), else a guess from the model's name, else the
 * provider.
 */
export const modelFamily = (ref: string) => {
  const { provider, modelId } = parseModelRef(ref)
  const id = modelId.toLowerCase().replace(/^~/, '')
  const slash = id.indexOf('/')
  if (slash > 0) {
    const vendor = id.slice(0, slash)
    return VENDOR_ALIASES[vendor] ?? vendor
  }
  for (const [pattern, family] of FAMILY_PATTERNS) if (pattern.test(id)) return family
  return provider
}

/** The model id's last segment, for short labels. */
export const shortModelName = (ref: string) => {
  const { modelId } = parseModelRef(ref)
  return modelId.slice(modelId.lastIndexOf('/') + 1)
}

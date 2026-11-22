// `/second-opinion --status`: whether each provider answers and whether each
// pool entry is a model it serves, before a review spends anything.

import {
  MODEL_TIERS,
  PROVIDER_NAMES,
  TIER_THINKING,
  VALIDATION_REVIEWER_COUNT,
  VALIDATION_TIER,
  isExcludedReviewerModel,
  isOpaqueRouterModel,
  isProviderName,
  parseModelRef,
} from './config'
import type { ProviderName, Settings } from './config'
import { TIMEOUT, withDeadline } from './panel'
import type { PanelIo } from './panel'
import { buildKeyCheckRequest, buildModelsRequest, parseModelIds } from './providers'
import type { HttpRequest } from './providers'

const PROBE_TIMEOUT_MS = 15_000

const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0

const probe = async (io: PanelIo, request: HttpRequest) => {
  const response = await withDeadline(io, io.fetch(request.url, request.init), PROBE_TIMEOUT_MS)
  if (response === TIMEOUT) throw new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)
  return response
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

type ProviderReport = { line: string; served?: Set<string> }

const checkProvider = async (
  io: PanelIo,
  settings: Settings,
  options: Readonly<Record<string, unknown>>,
  name: ProviderName,
): Promise<ProviderReport> => {
  const provider = settings.providers[name]
  if (!provider) return { line: `not configured: ${settings.unconfigured[name]}` }

  const parts: string[] = []
  if (name === 'openrouter') {
    parts.push(`key from ${filled(options.openrouterApiKey) ? 'plugin settings' : 'OPENROUTER_API_KEY'}`)
    try {
      const response = await probe(io, buildKeyCheckRequest(provider))
      parts.push(response.ok ? 'key accepted' : `key refused (HTTP ${response.status})`)
    } catch (error) {
      parts.push(`key check failed: ${errorText(error)}`)
    }
  } else {
    parts.push(`${provider.baseUrl} (from ${filled(options.litellmBaseUrl) ? 'plugin settings' : 'LITELLM_BASE_URL'})`)
    parts.push(
      provider.apiKey
        ? `key from ${filled(options.litellmApiKey) ? 'plugin settings' : 'LITELLM_API_KEY'}`
        : 'no key (fine for a proxy without auth)',
    )
  }

  try {
    const served = new Set(parseModelIds(await probe(io, buildModelsRequest(provider))))
    parts.push(`${served.size} models listed`)
    return { line: parts.join('; '), served }
  } catch (error) {
    parts.push(`model list failed: ${errorText(error)}`)
    return { line: parts.join('; ') }
  }
}

const entryStatus = (settings: Settings, reports: Partial<Record<ProviderName, ProviderReport>>, model: string) => {
  let provider: string
  let modelId: string
  try {
    ;({ provider, modelId } = parseModelRef(model))
  } catch (error) {
    return `refused: ${errorText(error)}`
  }
  if (!isProviderName(provider)) return `refused: unknown provider "${provider}"`
  if (isExcludedReviewerModel(modelId)) return 'refused: Anthropic models never review'
  if (isOpaqueRouterModel(modelId)) return 'refused: a router can pick any model, Claude included'
  if (!settings.providers[provider]) return `skipped: ${provider} is not configured`
  const served = reports[provider]?.served
  if (!served) return 'unchecked: the model list was not available'
  // OpenRouter variants (`:free`, `:nitro`) are routes to a listed base model.
  return served.has(modelId) || served.has(modelId.replace(/:[^/]*$/, '')) ? 'ok' : `not listed by ${provider}`
}

/** The status report: providers, defaults, then each tier pool entry's state. */
export const buildStatusReport = async (io: PanelIo, settings: Settings, options: Readonly<Record<string, unknown>>) => {
  io.progress?.('second opinion: checking providers')
  const reports: Partial<Record<ProviderName, ProviderReport>> = {}
  await Promise.all(PROVIDER_NAMES.map(async name => {
    reports[name] = await checkProvider(io, settings, options, name)
  }))

  const lines = [
    'Second opinion status',
    '',
    'Providers',
    ...PROVIDER_NAMES.map(name => `  ${name.padEnd(11)}${reports[name]?.line ?? ''}`),
    '',
    `Defaults: ${settings.defaultTier} tier, ${settings.reviewerCount} reviewer(s), ${settings.timeoutMs / 1000}s per reviewer. Validation runs ${VALIDATION_REVIEWER_COUNT} reviewer from the ${VALIDATION_TIER} tier.`,
  ]

  for (const tier of MODEL_TIERS) {
    const pool = settings.pools[tier]
    lines.push('', `${tier} tier (thinking ${TIER_THINKING[tier]} unless a ref sets it)`)
    if (pool.length === 0) lines.push(`  (empty: set ${tier}Models in the plugin settings)`)
    for (const entry of pool) {
      const thinking = entry.thinking ? ` [${entry.thinking}]` : ''
      lines.push(`  ${entry.model}${thinking}: ${entryStatus(settings, reports, entry.model)}`)
    }
  }

  lines.push('', 'Change these with /config (second-opinion rows) or `claude plugin configure second-opinion`.')
  return lines.join('\n')
}

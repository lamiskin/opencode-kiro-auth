import * as crypto from 'crypto'
import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = RegionSchema.options

// Random per process: a hash of hostname/username could be brute-forced back to them.
const KIRO_MACHINE_ID = crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')

/** `KiroIDE-<version>-<machine id>`, the token Kiro's own client puts in its user agent. */
export function getKiroIdeUserAgent(): string {
  return `${KIRO_CONSTANTS.USER_AGENT}-${KIRO_CONSTANTS.IDE_VERSION}-${KIRO_MACHINE_ID}`
}

export function isValidRegion(region: string): region is KiroRegion {
  return VALID_REGIONS.includes(region as KiroRegion)
}

export function normalizeRegion(region: string | undefined): KiroRegion {
  if (!region || !isValidRegion(region)) {
    return 'us-east-1'
  }
  return region
}

export function buildUrl(template: string, region: KiroRegion): string {
  const url = template.replace('{{region}}', region)

  try {
    new URL(url)
    return url
  } catch {
    throw new Error(`Invalid URL generated: ${url}`)
  }
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  if (parts.length < 6) return undefined
  if (parts[0] !== 'arn') return undefined
  const region = parts[3]
  if (typeof region !== 'string' || !region) return undefined
  return isValidRegion(region) ? (region as KiroRegion) : undefined
}

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  IDE_VERSION: '1.4.121',
  SDK_VERSION: '3.1165.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

export const MODEL_MAPPING: Record<string, string> = {
  // Claude Haiku
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-thinking': 'claude-haiku-4.5',
  'claude-haiku-5-5': 'claude-haiku-5.5',
  'claude-haiku-5-5-thinking': 'claude-haiku-5.5',
  'claude-haiku-5-5-100k': 'claude-haiku-5.5',
  'claude-haiku-5-5-100k-thinking': 'claude-haiku-5.5',
  // Claude Sonnet
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4.5',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-thinking': 'claude-sonnet-5',
  'claude-sonnet-5-5': 'claude-sonnet-5.5',
  'claude-sonnet-5-5-thinking': 'claude-sonnet-5.5',
  // Claude Opus
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-thinking': 'claude-opus-4.5',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-thinking': 'claude-opus-4.6',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-7-thinking': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-8-thinking': 'claude-opus-4.8',
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-5-thinking': 'claude-opus-5',
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-opus-5-5-thinking': 'claude-opus-5.5',
  // Claude Fable
  'claude-fable-5-1': 'claude-fable-5.1',
  'claude-fable-5-1-thinking': 'claude-fable-5.1',
  // Auto
  auto: 'auto',
  // Open weight models
  'deepseek-3.2': 'deepseek-3.2',
  'glm-5': 'glm-5',
  'minimax-m2.5': 'minimax-m2.5',
  'minimax-m2.1': 'minimax-m2.1',
  'qwen3-coder-next': 'qwen3-coder-next',
  // Kimi
  'kimi-k3': 'kimi-k3',
  'kimi-k3-thinking': 'kimi-k3',
  // GPT-5.6 (OpenAI)
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-sol-thinking': 'gpt-5.6-sol',
  'gpt-5.6-sol-272k': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-terra-thinking': 'gpt-5.6-terra',
  'gpt-5.6-terra-272k': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.6-luna-thinking': 'gpt-5.6-luna',
  'gpt-5.6-luna-272k': 'gpt-5.6-luna',
  // Open-weight thinking models
  'deepseek-3.2-thinking': 'deepseek-3.2',
  'deepseek-3.2-thinking-272k': 'deepseek-3.2',
  'minimax-m2.5-thinking': 'minimax-m2.5',
  'minimax-m2.5-thinking-272k': 'minimax-m2.5',
  'minimax-m2.1-thinking': 'minimax-m2.1',
  'minimax-m2.1-thinking-272k': 'minimax-m2.1',
  'qwen3-coder-next-thinking': 'qwen3-coder-next',
  'qwen3-coder-next-thinking-272k': 'qwen3-coder-next'
}

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

/** Explicit -1m variant IDs (none bundled; e.g., a future claude-sonnet-6-1m) */
const EXPLICIT_1M_IDS = new Set(Object.keys(MODEL_MAPPING).filter((k) => k.includes('-1m')))

/**
 * Base IDs that have 1M context (non-explicit -1m variants, non-capped companions).
 * Derived from MODEL_MAPPING: Claude opus-4-6+ / sonnet-4-6+ / fable-5-1 / haiku-5-5,
 * and GPT-5.6 base IDs (the -272k companions are capped).
 */
function generateBase1MClaude(): Set<string> {
  const base1m = new Set<string>()
  const mapping = MODEL_MAPPING
  for (const key of Object.keys(mapping)) {
    // Skip explicit -1m variants (already in EXPLICIT_1M_IDS)
    if (key.includes('-1m')) continue
    // Claude Opus 4.6+ has 1M context
    if (
      key.startsWith('claude-opus-4-6') ||
      key.startsWith('claude-opus-4-7') ||
      key.startsWith('claude-opus-4-8') ||
      key.startsWith('claude-opus-5')
    ) {
      base1m.add(key)
    }
    // Claude Sonnet 4.6+ and 5+ have 1M context
    if (key.startsWith('claude-sonnet-4-6') || key.startsWith('claude-sonnet-5')) {
      base1m.add(key)
    }
    // Claude Fable 5.1+ has 1M context
    if (key.startsWith('claude-fable-5-1')) {
      base1m.add(key)
    }
    // Claude Haiku 5.5 has 1M context (the -100k companion is capped)
    if (key.startsWith('claude-haiku-5-5') && !key.includes('-100k')) {
      base1m.add(key)
    }
    // GPT-5.6 has 1M context (the -272k companion is capped)
    if (key.startsWith('gpt-5.6-') && !key.includes('-272k')) {
      base1m.add(key)
    }
  }
  return base1m
}

const BASE_1M_CLAUDE_IDS = generateBase1MClaude()

const LONG_CONTEXT_MODELS = new Set([...EXPLICIT_1M_IDS, ...BASE_1M_CLAUDE_IDS])

/** Models with 272K context (two-tier pricing tier boundary) */
const CAPPED_272K_MODELS = new Set(Object.keys(MODEL_MAPPING).filter((k) => k.includes('-272k')))

/** Capped companion windows. These win over runtime catalog values, which alias the base model. */
export const CAPPED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-haiku-5-5-100k': 100_000,
  'claude-haiku-5-5-100k-thinking': 100_000,
  'gpt-5.6-sol-272k': 272_000,
  'gpt-5.6-terra-272k': 272_000,
  'gpt-5.6-luna-272k': 272_000
}

export function is272KModel(model: string): boolean {
  return CAPPED_272K_MODELS.has(model)
}

export function isLongContextModel(model: string): boolean {
  return LONG_CONTEXT_MODELS.has(model)
}

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  USER_INFO_URL: 'https://view.awsapps.com/api/user/info',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}

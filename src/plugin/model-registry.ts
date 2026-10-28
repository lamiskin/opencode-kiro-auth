import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort, THINKING_BUDGETS } from './effort.js'
import { getModelRate, initializeModelCatalog, refreshModelCatalog } from './model-catalog.js'
import { rateLabel } from './model-rate.js'
import { getAvailableModelsContext, resolveKiroModel } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_200K = { context: 200000, output: 64000 }
const CONTEXT_1M = { context: 1000000, output: 64000 }
const CONTEXT_100K = { context: 100000, output: 64000 }
const CONTEXT_272K = { context: 272000, output: 128000 }
const CONTEXT_128K = { context: 128000, output: 64000 }
const CONTEXT_256K = { context: 256000, output: 64000 }

/**
 * Static model capabilities that don't change dynamically.
 * Credit multipliers are fetched from the model catalog.
 * Runtime ListAvailableModels context windows override these static limits when
 * available; static values are used during startup and offline operation.
 */
interface ModelCapabilities {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Default context/output limits. May be overridden by runtime context. */
  limit: { context: number; output: number }
  /** Input/output modalities supported. */
  modalities: Modalities
  /**
   * Emit a companion `-thinking` entry. Only set for Claude models that accept
   * `output_config.effort`; the effort ladder is derived from the model's own
   * capabilities in effort.ts.
   */
  thinking?: boolean
  /**
   * Native reasoning model (GPT-5.6). These always reason; you control effort level.
   * The base model advertises `reasoning: true` with effort variants.
   */
  reasoning?: boolean
  /**
   * Emit a companion `-272k` entry for models with two-tier pricing.
   * The -272k variant caps context at 272K to stay in the base pricing tier.
   */
  capped272k?: boolean
  /**
   * Emit a companion `-100k` entry for Haiku 5.5 with two-tier pricing.
   * The -100k variant caps context at 100K to stay in the base pricing tier (0.06x).
   */
  capped100k?: boolean
}

/**
 * Static model capabilities keyed by the OpenCode-facing model ID.
 * Credit multipliers are fetched dynamically from the model catalog.
 * Includes Claude, open-weight, and GPT-5.6 (OpenAI) models.
 */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  auto: { name: 'Auto', limit: CONTEXT_200K, modalities: MULTIMODAL },
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-5-1m': {
    name: 'Claude Sonnet 4.5 1M',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6-1m': {
    name: 'Claude Sonnet 4.6 1M',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5-1m': {
    name: 'Claude Sonnet 5 1M',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Claude Haiku
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    limit: CONTEXT_200K,
    modalities: TEXT_IMAGE
  },
  'claude-haiku-5-5': {
    name: 'Claude Haiku 5.5',
    limit: CONTEXT_1M,
    modalities: TEXT_IMAGE,
    thinking: true,
    capped100k: true
  },

  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-6-1m': {
    name: 'Claude Opus 4.6 1M',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-fable-5-1': {
    name: 'Claude Fable 5.1',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2',
    limit: CONTEXT_128K,
    modalities: TEXT_ONLY
  },
  'glm-5': {
    name: 'GLM-5',
    limit: CONTEXT_200K,
    modalities: TEXT_ONLY,
    thinking: true
  },
  'minimax-m2.5': {
    name: 'MiniMax M2.5',
    limit: { context: 200000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1',
    limit: { context: 200000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next',
    limit: CONTEXT_256K,
    modalities: TEXT_ONLY
  },

  // Kimi
  'kimi-k3': {
    name: 'Kimi K3',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // GPT-5.6 (OpenAI) - 1M context window as of Sep 2026
  // These models have two-tier pricing: ≤272K at base rate, >272K at 2x rate
  'gpt-5.6-sol': {
    name: 'GPT-5.6 Sol',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true,
    capped272k: true
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6 Terra',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true,
    capped272k: true
  },
  'gpt-5.6-luna': {
    name: 'GPT-5.6 Luna',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true,
    capped272k: true
  }
}

/**
 * Build the thinking/variant configuration for a model.
 *
 * GPT-5.6 models use native `reasoning.effort` structure.
 * Claude and open-weight models use `thinkingConfig.thinkingBudget` structure.
 */
function buildVariants(kiroModel: string, isOpenAI = false): Record<string, unknown> {
  const variants: Record<string, unknown> = {}

  const levels = isOpenAI ? ['low', 'medium', 'high', 'xhigh' as const] : EFFORT_LEVELS

  for (const level of levels) {
    if (isOpenAI) {
      variants[level] = { reasoning: { effort: level } }
    } else {
      const budget = THINKING_BUDGETS[level as keyof typeof THINKING_BUDGETS]
      if (level === 'xhigh' && !supportsXHighEffort(kiroModel)) continue
      variants[level] = { thinkingConfig: { thinkingBudget: budget } }
    }
  }

  return variants
}

/**
 * Model registry advertised to OpenCode.
 *
 * `-thinking` entries carry `reasoning` and `interleaved`. Both are required:
 * `reasoning` declares the capability, and `interleaved.field` tells OpenCode
 * that reasoning arrives in the non-standard `reasoning_content` delta this
 * plugin emits (see streaming/openai-converter.ts). Without them OpenCode
 * silently drops every reasoning chunk and no thinking block is rendered.
 *
 * `-272k` entries are companion variants for two-tier pricing models, capped at 272K
 * context to stay in the base pricing tier (avoiding 2x multiplier for longer contexts).
 *
 * Credit multipliers are fetched dynamically from the model catalog.
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, caps] of Object.entries(MODEL_CAPABILITIES)) {
    // Get the dynamic credit multiplier from the catalog
    const rate = getModelRate(modelID)
    // Kiro's runtime limit is authoritative when available; retain the
    // per-model static capability as the startup/offline fallback.
    const contextWindow = getAvailableModelsContext().get(modelID) ?? caps.limit.context
    const limit = { ...caps.limit, context: contextWindow }

    models[modelID] = {
      name: `${caps.name} (${rateLabel(modelID, rate)})`,
      limit,
      modalities: caps.modalities
    }

    if (caps.reasoning) {
      const kiroModel = resolveKiroModel(modelID)
      const variants = buildVariants(kiroModel, true)
      models[modelID] = {
        name: `${caps.name} (${rateLabel(modelID, rate)})`,
        limit,
        modalities: caps.modalities,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants
      }

      // Emit -272k companion for two-tier pricing models
      if (caps.capped272k) {
        models[`${modelID}-272k`] = {
          name: `${caps.name} 272K (${rate})`,
          limit: CONTEXT_272K,
          modalities: caps.modalities,
          reasoning: true,
          interleaved: { field: 'reasoning_content' },
          variants
        }
      }

      continue
    }

    if (!caps.thinking) continue

    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)
    if (!supportsEffort(kiroModel)) continue

    // For thinking variants, resolve context the same way as base models
    const thinkingContextWindow =
      getAvailableModelsContext().get(`${modelID}-thinking`) ?? caps.limit.context
    const thinkingLimit = { ...caps.limit, context: thinkingContextWindow }

    models[`${modelID}-thinking`] = {
      name: `${caps.name} Thinking (${rateLabel(modelID, rate)})`,
      limit: thinkingLimit,
      modalities: caps.modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
    }

    // Two-tier companion (Haiku 5.5): -100k base and -100k-thinking capped at 100K
    if (caps.capped100k) {
      models[`${modelID}-100k`] = {
        name: `${caps.name} 100K (${rate})`,
        limit: CONTEXT_100K,
        modalities: caps.modalities,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants: buildVariants(kiroModel)
      }
      models[`${modelID}-100k-thinking`] = {
        name: `${caps.name} 100K Thinking (${rate})`,
        limit: CONTEXT_100K,
        modalities: caps.modalities,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants: buildVariants(kiroModel)
      }
    }
  }

  return models
}

/**
 * Initialize the model registry with bundled data.
 * Call this at plugin startup to ensure data is available immediately.
 */
export function initializeRegistry(): void {
  initializeModelCatalog()
}

/**
 * Refresh the model catalog from the remote source.
 * Call this after authentication is established.
 */
export async function refreshRegistry(): Promise<void> {
  await refreshModelCatalog()
}

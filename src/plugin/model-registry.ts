import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort, THINKING_BUDGETS } from './effort.js'
import { getModelRate, initializeModelCatalog, refreshModelCatalog } from './model-catalog.js'
import { resolveKiroModel } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_200K = { context: 200000, output: 64000 }
const CONTEXT_1M = { context: 1000000, output: 64000 }
const CONTEXT_272K = { context: 272000, output: 128000 }

/**
 * Static model capabilities that don't change dynamically.
 * Credit multipliers and context windows are fetched from the model catalog.
 */
interface ModelCapabilities {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Default context/output limits. May be overridden by catalog. */
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
}

/**
 * Static model capabilities keyed by the OpenCode-facing model ID.
 * Credit multipliers are fetched dynamically from the model catalog.
 * Includes Claude, open-weight, and GPT-5.6 (OpenAI) models.
 */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  auto: { name: 'Auto', limit: CONTEXT_200K, modalities: MULTIMODAL },
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL
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
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
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

  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2',
    limit: { context: 128000, output: 64000 },
    modalities: TEXT_ONLY,
    thinking: true
  },
  'glm-5': { name: 'GLM-5', limit: CONTEXT_200K, modalities: TEXT_ONLY },
  'minimax-m2.5': {
    name: 'MiniMax M2.5',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY,
    thinking: true
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY,
    thinking: true
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next',
    limit: { context: 256000, output: 64000 },
    modalities: TEXT_ONLY
  },

  // GPT-5.6 (OpenAI) - 1M context window as of Sep 2026
  'gpt-5.6-sol': {
    name: 'GPT-5.6 Sol',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6 Terra',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true
  },
  'gpt-5.6-luna': {
    name: 'GPT-5.6 Luna',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    reasoning: true
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
 * Credit multipliers are fetched dynamically from the model catalog.
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, caps] of Object.entries(MODEL_CAPABILITIES)) {
    // Get the dynamic credit multiplier from the catalog
    const rate = getModelRate(modelID)

    models[modelID] = {
      name: `${caps.name} (${rate})`,
      limit: caps.limit,
      modalities: caps.modalities
    }

    if (caps.reasoning) {
      const kiroModel = resolveKiroModel(modelID)
      const variants = buildVariants(kiroModel, true)
      models[modelID] = {
        name: `${caps.name} (${rate})`,
        limit: caps.limit,
        modalities: caps.modalities,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants
      }
      continue
    }

    if (!caps.thinking) continue

    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)
    if (!supportsEffort(kiroModel)) continue

    models[`${modelID}-thinking`] = {
      name: `${caps.name} Thinking (${rate})`,
      limit: caps.limit,
      modalities: caps.modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
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

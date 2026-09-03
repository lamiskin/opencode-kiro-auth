import { isOpenAIModel } from './effort.js'
import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort, THINKING_BUDGETS } from './effort.js'
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

interface ModelSpec {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Kiro credit multiplier, rendered into the display name. */
  rate: string
  limit: { context: number; output: number }
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
 * Models Kiro exposes, keyed by the OpenCode-facing model ID.
 * Includes Claude, open-weight, and GPT-5.6 (OpenAI) models.
 */
const MODEL_SPECS: Record<string, ModelSpec> = {
  auto: { name: 'Auto', rate: '1.0x', limit: CONTEXT_200K, modalities: MULTIMODAL },
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Claude Haiku
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    rate: '0.4x',
    limit: CONTEXT_200K,
    modalities: TEXT_IMAGE
  },

  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5',
    rate: '2.2x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

   // Open weight models
   'deepseek-3.2': {
     name: 'DeepSeek 3.2',
     rate: '0.25x',
     limit: { context: 128000, output: 64000 },
     modalities: TEXT_ONLY,
     thinking: true
   },
   'glm-5': { name: 'GLM-5', rate: '0.5x', limit: CONTEXT_200K, modalities: TEXT_ONLY },
   'minimax-m2.5': {
     name: 'MiniMax M2.5',
     rate: '0.25x',
     limit: { context: 196000, output: 64000 },
     modalities: TEXT_ONLY,
     thinking: true
   },
   'minimax-m2.1': {
     name: 'MiniMax M2.1',
     rate: '0.15x',
     limit: { context: 196000, output: 64000 },
     modalities: TEXT_ONLY,
     thinking: true
   },
    'qwen3-coder-next': {
      name: 'Qwen3 Coder Next',
      rate: '0.05x',
      limit: { context: 256000, output: 64000 },
      modalities: TEXT_ONLY
    },

    // GPT-5.6 (OpenAI)
    'gpt-5.6-sol': {
      name: 'GPT-5.6 Sol',
      rate: '2.4x',
      limit: { context: 272000, output: 64000 },
      modalities: MULTIMODAL,
      reasoning: true
    },
    'gpt-5.6-terra': {
      name: 'GPT-5.6 Terra',
      rate: '1.0x',
      limit: { context: 272000, output: 64000 },
      modalities: MULTIMODAL,
      reasoning: true
    },
    'gpt-5.6-luna': {
      name: 'GPT-5.6 Luna',
      rate: '0.1x',
      limit: { context: 272000, output: 64000 },
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
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, spec] of Object.entries(MODEL_SPECS)) {
    models[modelID] = {
      name: `${spec.name} (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities
    }

    if (spec.reasoning) {
      const kiroModel = resolveKiroModel(modelID)
      const variants = buildVariants(kiroModel, true)
      models[modelID] = {
        name: `${spec.name} (${spec.rate})`,
        limit: spec.limit,
        modalities: spec.modalities,
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        variants
      }
      continue
    }

    if (!spec.thinking) continue

    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)
    if (!supportsEffort(kiroModel)) continue

    models[`${modelID}-thinking`] = {
      name: `${spec.name} Thinking (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
    }
  }

  return models
}

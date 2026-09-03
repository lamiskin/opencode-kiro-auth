import { isOpenAIModel } from './effort.js'
import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import type { Effort, KiroAuthDetails } from './types.js'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 * The isOpenAI flag is also part of the key to avoid cross-contamination.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  isOpenAI?: boolean
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  isOpenAI = false
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}:${isOpenAI ? 'openai' : 'claude'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort && cached.isOpenAI === isOpenAI) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      // The SDK serializes input to args.input, we need to modify the body
      // before it's sent. The body is in args.request.body as a string.
      if (effort && args.request?.body) {
        try {
          const body = JSON.parse(args.request.body)
          if (isOpenAI) {
            body.reasoning = { effort }
          } else {
            body.additionalModelRequestFields = {
              output_config: {
                effort
              }
            }
          }
          args.request.body = JSON.stringify(body)
        } catch {
          // If body parsing fails, continue without modification
        }
      }
      return next(args)
    },
    { step: 'build', name: 'addEffortConfig', priority: 'high' }
  )

  clientCache.set(cacheKey, { client, token, effort, isOpenAI })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}

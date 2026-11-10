import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { FetchHttpHandler } from '@smithy/fetch-http-handler'
import { buildKiroClientIdentityFor } from './kiro-user-agent.js'
import type { Effort, KiroAuthDetails } from './types'

// Under Bun (OpenCode v2 ships Bun 1.4.x) node:https requests through an
// HTTP(S) proxy hang indefinitely, while the native fetch works. Use the
// fetch-based handler there; Node keeps the SDK default.
const useFetchHandler = typeof (globalThis as any).Bun !== 'undefined'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort) {
    return cached.client
  }

  const token = auth.access
  const identity = buildKiroClientIdentityFor(auth)
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[identity.ideToken]],
    ...(useFetchHandler ? { requestHandler: new FetchHttpHandler() } : {})
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // The SDK builds its own User-Agent at the build step. Override both Kiro
  // identity headers at the end of the stack so the versioned fingerprint is
  // what actually leaves the process, independent of the SDK version.
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['user-agent'] = identity.userAgent
      args.request.headers['x-amz-user-agent'] = identity.amzUserAgent
      return next(args)
    },
    { step: 'finalizeRequest', name: 'addKiroFingerprint', priority: 'low' }
  )

  // Inject additionalModelRequestFields for effort-based thinking control
  if (effort) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        // The SDK serializes input to args.input, we need to modify the body
        // before it's sent. The body is in args.request.body as a string.
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = {
              output_config: {
                effort
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
  }

  clientCache.set(cacheKey, { client, token, effort })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}

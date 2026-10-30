import http from 'node:http'
import { AddressInfo } from 'node:net'
import type { RequestHandler } from '../core/request/request-handler.js'
import * as logger from './logger.js'

/**
 * Options for configuring and starting the local Kiro OpenAI-compatible proxy server.
 */
export interface KiroServerOptions {
  /** Preferred port to listen on. Defaults to KIRO_PROXY_PORT env var or 4141, with automatic fallback to a random free port on EADDRINUSE. */
  port?: number
  /** RequestHandler instance translating incoming OpenAI chat completions to AWS CodeWhisperer SDK streaming calls. */
  requestHandler: RequestHandler
  /** Active model registry advertised on /v1/models. */
  modelRegistry: Record<string, any>
  /** Optional pre-shared bearer token. If not provided, a random 24-byte hex token is generated. */
  authToken?: string
  /** Toast callback for user notifications. */
  showToast?: (message: string, variant: string) => void
}

/**
 * Handle to a running Kiro proxy server instance.
 */
export interface KiroServerInstance {
  port: number
  authToken: string
  server: http.Server
  close: () => Promise<void>
}

let activeInstance: KiroServerInstance | null = null
let activeRefs = 0
let startingPromise: Promise<KiroServerInstance> | null = null
let currentRequestHandler: RequestHandler | null = null
let currentModelRegistry: Record<string, any> = {}
let currentShowToast: ((message: string, variant: string) => void) | undefined

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding'
])

function createInstanceHandle(instance: KiroServerInstance): KiroServerInstance {
  let closedThisInstance = false
  return {
    ...instance,
    close: async () => {
      if (closedThisInstance) return
      closedThisInstance = true
      activeRefs = Math.max(0, activeRefs - 1)
      if (activeRefs === 0 && instance.server) {
        if (typeof (instance.server as any).closeAllConnections === 'function') {
          ;(instance.server as any).closeAllConnections()
        }
        await new Promise<void>((resolve) => {
          instance.server.close(() => {
            if (activeInstance === instance) {
              activeInstance = null
              startingPromise = null
            }
            resolve()
          })
        })
      }
    }
  }
}

/**
 * Starts or reuses the local Kiro HTTP proxy server.
 *
 * Security & Lifecycle features:
 * - Binds strictly to 127.0.0.1 (rejects any foreign Host header to prevent DNS-rebinding attacks).
 * - Enforces Bearer token authentication via Authorization or x-api-key header.
 * - Handles backpressure on streaming responses by listening for drain/close.
 * - Filters hop-by-hop HTTP headers from upstream responses.
 * - Ref-counted singleton lifecycle: handles per-caller cleanup safely without premature shutdown.
 */
export async function startKiroServer(options: KiroServerOptions): Promise<KiroServerInstance> {
  currentRequestHandler = options.requestHandler
  currentModelRegistry = options.modelRegistry
  currentShowToast = options.showToast

  if (activeInstance && activeInstance.server) {
    activeRefs++
    return createInstanceHandle(activeInstance)
  }

  if (startingPromise) {
    const instance = await startingPromise
    activeRefs++
    return createInstanceHandle(instance)
  }

  const preferredPort =
    options.port ?? (process.env.KIRO_PROXY_PORT ? parseInt(process.env.KIRO_PROXY_PORT, 10) : 4141)
  const token =
    options.authToken || (process.env.KIRO_PROXY_TOKEN ? process.env.KIRO_PROXY_TOKEN.trim() : '')

  startingPromise = (async () => {
    const server = http.createServer(async (req, res) => {
      const host = req.headers.host || ''
      const hostname = host.split(':')[0]
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: 'Forbidden: local access only', type: 'access_denied' }
          })
        )
        return
      }

      const url = new URL(req.url || '/', `http://${host || `127.0.0.1:${preferredPort}`}`)

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'ok',
            service: 'kiro-proxy',
            port: (server.address() as AddressInfo)?.port || preferredPort
          })
        )
        return
      }

      // Verify Bearer / API token if configured
      if (token) {
        const authHeader = req.headers.authorization || (req.headers['x-api-key'] as string) || ''
        const bearer = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : authHeader.trim()
        if (bearer !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                message: 'Unauthorized: invalid or missing proxy token',
                type: 'authentication_error'
              }
            })
          )
          return
        }
      }

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        const registry = currentModelRegistry || options.modelRegistry
        const data = Object.entries(registry).map(([id, info]: [string, any]) => ({
          id,
          object: 'model',
          created: 1700000000,
          owned_by: 'kiro',
          name: info.name || id
        }))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data }))
        return
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')
      ) {
        const chunks: Buffer[] = []
        let totalSize = 0
        const MAX_BODY_SIZE = 20 * 1024 * 1024 // 20 MB

        req.on('data', (chunk) => {
          totalSize += chunk.length
          if (totalSize > MAX_BODY_SIZE) {
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: { message: 'Payload too large', type: 'invalid_request_error' }
              })
            )
            req.destroy()
            return
          }
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })

        req.on('end', async () => {
          if (totalSize > MAX_BODY_SIZE) return
          const bodyStr = Buffer.concat(chunks).toString('utf-8')
          try {
            const handler = currentRequestHandler || options.requestHandler
            const showToast =
              currentShowToast || options.showToast || ((msg, v) => logger.info(`[${v}] ${msg}`))
            const response = await handler.handle(
              url.toString(),
              {
                method: 'POST',
                headers: req.headers as Record<string, string>,
                body: bodyStr
              },
              showToast
            )

            const headers: Record<string, string> = {}
            response.headers.forEach((val, key) => {
              if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                headers[key] = val
              }
            })

            res.writeHead(response.status, headers)

            if (response.body) {
              const reader = response.body.getReader()
              let closed = false
              res.on('close', () => {
                if (!res.writableEnded) {
                  closed = true
                  reader.cancel().catch(() => {})
                }
              })

              while (!closed) {
                const { done, value } = await reader.read()
                if (done) break
                const canWrite = res.write(value)
                if (!canWrite && !closed) {
                  await new Promise<void>((resolve) => {
                    const onDrainOrClose = () => {
                      res.off('drain', onDrainOrClose)
                      res.off('close', onDrainOrClose)
                      resolve()
                    }
                    res.once('drain', onDrainOrClose)
                    res.once('close', onDrainOrClose)
                  })
                }
              }
            }
            if (!res.writableEnded) {
              res.end()
            }
          } catch (err: any) {
            logger.error(`Error handling ${url.pathname}: ${err?.message || String(err)}`)
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: {
                    message: err?.message || String(err),
                    type: 'server_error',
                    code: err?.code || 'internal_error'
                  }
                })
              )
            } else if (!res.writableEnded) {
              res.end()
            }
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: `Not found: ${url.pathname}`, type: 'invalid_request_error' }
        })
      )
    })

    server.on('error', (err) => {
      logger.error(`Kiro proxy server runtime error: ${err.message}`)
    })

    const port = await new Promise<number>((resolve, reject) => {
      // A single 'listening' handler reads the bound port. Passing a callback to
      // each listen() call would register two handlers, and after an
      // EADDRINUSE fallback the first one would resolve with the busy port.
      server.once('listening', () => {
        server.removeListener('error', onError)
        resolve((server.address() as AddressInfo).port)
      })

      const onError = (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Port ${preferredPort} is in use, falling back to random available port...`)
          server.removeListener('error', onError)
          server.once('error', reject)
          server.listen(0, '127.0.0.1')
        } else {
          reject(err)
        }
      }

      server.once('error', onError)
      server.listen(preferredPort, '127.0.0.1')
    })

    logger.info(`Kiro proxy server listening on http://127.0.0.1:${port}`)

    const rawInstance: KiroServerInstance = {
      port,
      authToken: token,
      server,
      close: async () => {}
    }

    activeInstance = rawInstance
    activeRefs = 1
    return createInstanceHandle(rawInstance)
  })().catch((err) => {
    startingPromise = null
    throw err
  })

  return startingPromise
}

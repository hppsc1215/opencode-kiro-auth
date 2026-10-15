import http from 'node:http'
import { AddressInfo } from 'node:net'
import type { RequestHandler } from '../core/request/request-handler.js'
import * as logger from './logger.js'

export interface KiroServerOptions {
  port?: number
  requestHandler: RequestHandler
  modelRegistry: Record<string, any>
  showToast?: (message: string, variant: string) => void
}

export interface KiroServerInstance {
  port: number
  server: http.Server
  close: () => Promise<void>
}

let activeInstance: KiroServerInstance | null = null
let currentRequestHandler: RequestHandler | null = null
let currentModelRegistry: Record<string, any> = {}

export async function startKiroServer(options: KiroServerOptions): Promise<KiroServerInstance> {
  currentRequestHandler = options.requestHandler
  currentModelRegistry = options.modelRegistry

  const preferredPort =
    options.port ?? (process.env.KIRO_PROXY_PORT ? parseInt(process.env.KIRO_PROXY_PORT, 10) : 4141)

  // If we already have a running instance in this process, update its handlers and return it
  if (activeInstance && activeInstance.server) {
    return activeInstance
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers for local tools/browsers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const host = req.headers.host || `127.0.0.1:${preferredPort}`
    const url = new URL(req.url || '/', `http://${host}`)

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'kiro-proxy', port: preferredPort }))
      return
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
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))

      req.on('end', async () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8')
        try {
          const handler = currentRequestHandler || options.requestHandler
          const response = await handler.handle(
            url.toString(),
            {
              method: 'POST',
              headers: req.headers as Record<string, string>,
              body: bodyStr
            },
            options.showToast || ((msg, v) => logger.info(`[${v}] ${msg}`))
          )

          const headers: Record<string, string> = {}
          response.headers.forEach((val, key) => {
            headers[key] = val
          })

          res.writeHead(response.status, headers)

          if (response.body) {
            const reader = response.body.getReader()
            let closed = false
            req.on('close', () => {
              closed = true
              reader.cancel().catch(() => {})
            })

            while (!closed) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          }
          res.end()
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
          } else {
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

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(`Port ${preferredPort} is in use, falling back to random available port...`)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo
          resolve(addr.port)
        })
      } else {
        reject(err)
      }
    })

    server.listen(preferredPort, '127.0.0.1', () => {
      resolve(preferredPort)
    })
  })

  logger.info(`Kiro proxy server listening on http://127.0.0.1:${port}`)

  const instance: KiroServerInstance = {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        if (server) {
          server.close(() => {
            if (activeInstance === instance) activeInstance = null
            resolve()
          })
        } else {
          resolve()
        }
      })
  }

  activeInstance = instance
  return instance
}

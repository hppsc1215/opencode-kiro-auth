import { describe, expect, it } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import defaultExport from '../index.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { kiroPluginV2 } from '../plugin.js'
import { AccountManager } from '../plugin/accounts.js'
import { loadConfig } from '../plugin/config/index.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { startKiroServer } from '../plugin/server.js'

describe('Kiro Plugin V2', () => {
  it('should export kiroPluginV2 with id and setup', () => {
    expect(kiroPluginV2.id).toBe('kiro')
    expect(typeof kiroPluginV2.setup).toBe('function')
  })

  it('default export should have both V2 (id, setup) and V1 (server) exports', () => {
    expect(defaultExport.id).toBe('kiro')
    expect(typeof defaultExport.setup).toBe('function')
    expect(typeof defaultExport.server).toBe('function')
  })

  it('local proxy server should start, serve /health and /v1/models, and close cleanly', async () => {
    const config = loadConfig(process.cwd())
    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)
    const accountManager = await AccountManager.loadFromDisk()
    const requestHandler = new RequestHandler(accountManager, config, repository)
    const modelRegistry = buildModelRegistry()

    const instance = await startKiroServer({
      port: 4142, // use 4142 for test
      requestHandler,
      modelRegistry
    })

    expect(instance.port).toBe(4142)

    // Test /health
    const healthRes = await fetch(`http://127.0.0.1:${instance.port}/health`)
    expect(healthRes.status).toBe(200)
    const healthData = await healthRes.json()
    expect(healthData.status).toBe('ok')
    expect(healthData.service).toBe('kiro-proxy')

    // Test /v1/models without auth -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${instance.port}/v1/models`)
    expect(unauthRes.status).toBe(401)

    // Test /v1/models with auth -> 200
    const modelsRes = await fetch(`http://127.0.0.1:${instance.port}/v1/models`, {
      headers: { Authorization: `Bearer ${instance.authToken}` }
    })
    expect(modelsRes.status).toBe(200)
    const modelsData = await modelsRes.json()
    expect(modelsData.object).toBe('list')
    expect(modelsData.data.length).toBeGreaterThan(0)
    expect(modelsData.data.some((m: any) => m.id === 'claude-sonnet-4-5')).toBe(true)

    // Close
    await instance.close()
  })

  it('setup should register provider and tools via context', async () => {
    let registeredProvider: any = null
    let registeredTool: any = null

    const mockCtx: any = {
      location: { directory: process.cwd() },
      provider: {
        transform: async (cb: any) => {
          const editor = {
            get: () => undefined,
            add: (p: any) => {
              registeredProvider = p
            },
            update: () => {},
            models: { set: () => {} }
          }
          cb(editor)
        }
      },
      tool: {
        transform: async (cb: any) => {
          const editor = {
            add: (t: any) => {
              registeredTool = t
            }
          }
          cb(editor)
        }
      }
    }

    const cleanup = await kiroPluginV2.setup(mockCtx)
    expect(registeredProvider).toBeDefined()
    expect(registeredProvider.info.id).toBe('kiro')
    expect(registeredProvider.info.package).toBe('@opencode/ai/providers/openai-compatible')
    expect(registeredProvider.models.length).toBeGreaterThan(0)
    expect(registeredTool).toBeDefined()
    expect(registeredTool.name).toBe('kiro_web_search')

    if (typeof cleanup === 'function') {
      await cleanup()
    }
  })
})

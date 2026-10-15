import { Model, Plugin, Provider } from '@opencode/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'
import * as logger from './plugin/logger.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { startKiroServer } from './plugin/server.js'
import { syncFromKiroCli } from './plugin/sync/kiro-cli.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

/**
 * OpenCode V2 Plugin Definition
 */
export const kiroPluginV2 = Plugin.define({
  id: KIRO_PROVIDER_ID,
  async setup(ctx) {
    const directory = ctx.location?.directory || process.cwd()
    const config = loadConfig(directory)

    logger.info(`Initializing Kiro plugin v2 for ${directory}...`)

    const showToast: ToastFunction = (message: string, variant: string) => {
      logger.info(`[Toast: ${variant}] ${message}`)
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)
    const authHandler = new AuthHandler(config, repository)

    // Sync from local Kiro CLI if configured
    if (config.auto_sync_kiro_cli) {
      await syncFromKiroCli().catch((err) => {
        logger.warn(
          `Initial Kiro CLI sync failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    }

    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository)
    const modelRegistry = buildModelRegistry()

    // Start local proxy server to serve OpenAI-compatible endpoints for Kiro
    const serverInstance = await startKiroServer({
      requestHandler,
      modelRegistry,
      showToast
    })

    const baseURL = `http://127.0.0.1:${serverInstance.port}/v1`

    // Transform Provider: register or update "kiro" provider with its models
    await ctx.provider.transform((editor) => {
      const providerID = Provider.ID.make(KIRO_PROVIDER_ID)
      const existing = editor.get(KIRO_PROVIDER_ID)

      const models: any[] = Object.entries(modelRegistry).map(([id, info]: [string, any]) => {
        const modelID = Model.ID.make(id)
        const base = Model.Info.default(providerID, modelID)

        const variants: any[] = []
        if (info.variants) {
          for (const [varId, varConf] of Object.entries(info.variants)) {
            variants.push({
              id: varId,
              settings: varConf
            })
          }
        }

        return {
          ...base,
          name: info.name || id,
          limit: info.limit || base.limit,
          capabilities: {
            tools: true,
            input: info.modalities?.input || ['text', 'image'],
            output: info.modalities?.output || ['text']
          },
          variants
        }
      })

      if (existing) {
        editor.update(KIRO_PROVIDER_ID, (p: any) => {
          p.package = '@opencode/ai/providers/openai-compatible'
          p.activation = 'enabled'
          p.settings = { ...(p.settings || {}), baseURL, apiKey: serverInstance.authToken }
        })
        editor.models.set(KIRO_PROVIDER_ID, models)
      } else {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: 'Kiro (AWS)',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL, apiKey: serverInstance.authToken }
          },
          models
        })
      }
    })

    // Register Tools if enabled
    if (config.web_search_enabled) {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: 'kiro_web_search',
          description: WEB_SEARCH_DESCRIPTION,
          input: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query. Must be 200 characters or fewer.'
              }
            },
            required: ['query'],
            additionalProperties: false
          },
          execute: async (input: any) => {
            try {
              const query = typeof input === 'string' ? input : input?.query
              const results = await kiroWebSearch(accountManager, query)
              return { content: formatWebSearchResults(results) }
            } catch (e) {
              return { content: `Web search failed: ${e instanceof Error ? e.message : String(e)}` }
            }
          }
        })
      })
    }

    logger.info(`Kiro plugin v2 loaded successfully with baseURL: ${baseURL}`)

    // Cleanup when plugin unloads
    return async () => {
      logger.info('Unloading Kiro plugin v2...')
      await serverInstance.close()
    }
  }
})

/**
 * OpenCode V1 Plugin Compatibility
 */
export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client)

    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    return {
      config: async (input: any) => {
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        if (!input.provider[id].models) {
          input.provider[id].models = buildModelRegistry()
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            baseURL,
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)

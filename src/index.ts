import { KiroOAuthPlugin, kiroPluginV2 } from './plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'
export { KiroOAuthPlugin, kiroPluginV2 }

export default {
  ...kiroPluginV2,
  server: KiroOAuthPlugin
}

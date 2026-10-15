import { KiroOAuthPlugin, kiroPluginV2 } from './src/plugin.js'

export { authorizeKiroIDC } from './src/kiro/oauth-idc.js'
export { createKiroPlugin, KiroOAuthPlugin, kiroPluginV2 } from './src/plugin.js'
export type { KiroConfig } from './src/plugin/config/index.js'
export type {
  KiroAuthDetails,
  KiroAuthMethod,
  KiroRegion,
  ManagedAccount
} from './src/plugin/types.js'

export default {
  ...kiroPluginV2,
  server: KiroOAuthPlugin
}

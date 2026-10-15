import { authorizeKiroIDC, pollKiroIDCToken } from '../src/kiro/oauth-idc.js'
import { createDeterministicAccountId } from '../src/plugin/accounts.js'
import { loadConfig } from '../src/plugin/config/index.js'
import { DB_PATH, KiroDatabase } from '../src/plugin/storage/sqlite.js'
import { makePlaceholderEmail } from '../src/plugin/sync/kiro-cli-parser.js'
import { readActiveProfileArnFromKiroCli } from '../src/plugin/sync/kiro-cli-profile.js'
import type { ManagedAccount } from '../src/plugin/types.js'
import { fetchUsageLimits } from '../src/plugin/usage.js'

const config = loadConfig(process.cwd())
const region = config.default_region || 'eu-central-1'
const startUrl = config.idc_start_url || 'https://d-99671a01cd.awsapps.com/start'

console.log(`Starting IDC login for region: ${region}, startUrl: ${startUrl}...`)

const auth = await authorizeKiroIDC(region, startUrl)
console.log('\n======================================================')
console.log('Please confirm the login in your browser:')
console.log(`URL:  ${auth.verificationUriComplete || auth.verificationUrl}`)
console.log(`CODE: ${auth.userCode}`)
console.log('======================================================\n')
console.log('Waiting for authorization...')

const tokenResult = await pollKiroIDCToken(
  auth.clientId,
  auth.clientSecret,
  auth.deviceCode,
  auth.interval,
  auth.expiresIn,
  auth.region
)

console.log('Token received! Fetching usage limits & profile...')
const profileArn = config.idc_profile_arn || readActiveProfileArnFromKiroCli()
const email = tokenResult.email || makePlaceholderEmail(startUrl, auth.clientId)
const accountId = createDeterministicAccountId(email, startUrl)

let limits: any = null
try {
  limits = await fetchUsageLimits(tokenResult.accessToken, tokenResult.region, profileArn)
} catch (e) {
  console.log('Could not fetch limits (optional):', e)
}

const managedAccount: ManagedAccount = {
  id: accountId,
  email,
  authMethod: 'idc',
  region: tokenResult.region,
  oidcRegion: tokenResult.region,
  clientId: tokenResult.clientId,
  clientSecret: tokenResult.clientSecret,
  startUrl,
  profileArn,
  accessToken: tokenResult.accessToken,
  refreshToken: tokenResult.refreshToken,
  expiresAt: tokenResult.expiresAt,
  isHealthy: true,
  rateLimitResetTime: 0,
  failCount: 0,
  lastUsed: Date.now(),
  usedCount: 0,
  limitCount: 0,
  lastSync: Date.now()
}

const db = new KiroDatabase(DB_PATH)
await db.upsertAccount(managedAccount)
console.log(`Saved account to ${DB_PATH}!`)

// Also save to sandbox if exists
const sandboxDbPath = '/tmp/opencode/sandbox/config/opencode/kiro.db'
try {
  const sdb = new KiroDatabase(sandboxDbPath)
  await sdb.upsertAccount(managedAccount)
  console.log(`Saved account to ${sandboxDbPath}!`)
} catch {}

console.log('Login complete!')

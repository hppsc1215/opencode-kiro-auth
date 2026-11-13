import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SQLITE_MODULE = join(import.meta.dir, '..', 'plugin', 'storage', 'sqlite.ts')
const SYNC_MODULE = join(import.meta.dir, '..', 'plugin', 'sync', 'kiro-cli.ts')

// kiro-cli can transiently lack `api.codewhisperer.profile` (e.g. after a self-update).
// A sync in that window must not replace the real IDC account with a placeholder
// that has no profileArn (every request would fail with "400: profileArn is required").
describe('Kiro CLI sync without active profile', () => {
  it('reuses the known profileArn instead of creating a profile-less placeholder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-sync-profile-'))
    const cliDbPath = join(dir, 'cli.sqlite3')
    const arn = 'arn:aws:codewhisperer:eu-central-1:123:profile/ABC'
    const startUrl = 'https://example.awsapps.com/start'
    const script = `
      // Never hit the network with fake tokens; usage lookup must fail like in production.
      globalThis.fetch = async () => { throw new Error('offline') }
      const { Database } = await import('bun:sqlite')
      const cli = new Database(${JSON.stringify(cliDbPath)})
      cli.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
      cli.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
      cli.run('INSERT INTO auth_kv VALUES (?, ?)', ['kirocli:odic:token', JSON.stringify({
        access_token: 'new-access', refresh_token: 'new-refresh', region: 'eu-central-1',
        start_url: ${JSON.stringify(startUrl)}, expires_at: new Date(Date.now() + 3600000).toISOString()
      })])
      cli.run('INSERT INTO auth_kv VALUES (?, ?)', ['kirocli:odic:device-registration', JSON.stringify({
        client_id: 'client-new', client_secret: 'secret-new', region: 'eu-central-1'
      })])
      cli.close()

      const { kiroDb } = await import(${JSON.stringify(SQLITE_MODULE)})
      await kiroDb.upsertAccount({
        id: 'real-id', email: 'user@example.com', authMethod: 'idc', region: 'eu-central-1',
        oidcRegion: 'eu-central-1', clientId: 'client-old', clientSecret: 'secret-old',
        profileArn: ${JSON.stringify(arn)}, startUrl: ${JSON.stringify(startUrl)},
        refreshToken: 'old-refresh', accessToken: 'old-access', expiresAt: Date.now() - 1000,
        rateLimitResetTime: 0, isHealthy: true, failCount: 0, lastSync: Date.now() - 86400000
      })

      const { syncFromKiroCli } = await import(${JSON.stringify(SYNC_MODULE)})
      await syncFromKiroCli()
      console.log(JSON.stringify(kiroDb.getAccounts().map((a) => ({
        email: a.email, profileArn: a.profile_arn, healthy: a.is_healthy
      }))))
    `

    try {
      const proc = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, XDG_CONFIG_HOME: dir, KIROCLI_DB_PATH: cliDbPath }
      })
      const out = (await new Response(proc.stdout).text()).trim().split('\n').pop() || '[]'
      const accounts = JSON.parse(out) as {
        email: string
        profileArn: string | null
        healthy: number
      }[]

      const healthy = accounts.filter((a) => a.healthy === 1)
      expect(healthy.length).toBeGreaterThan(0)
      expect(healthy.every((a) => a.profileArn === arn)).toBe(true)
      expect(accounts.some((a) => a.email.includes('placeholder') && !a.profileArn)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_MODULE = join(import.meta.dir, '..', 'plugin.ts')

// OpenCode V2 loads a fresh module copy per location instance and evicts idle
// instances, while the registered `kiro` provider (and its baseURL) stays
// process-wide. The proxy must therefore be shared across module copies and
// survive instance unloads, otherwise requests fail with ECONNREFUSED.
describe('Kiro proxy lifecycle across OpenCode location instances', () => {
  it('shares one proxy across module copies and keeps it alive after unload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-proxy-life-'))
    const script = `
      const baseURLs = []
      const ctx = (directory) => ({
        location: { directory },
        provider: { transform: async (cb) => cb({
          get: () => undefined,
          add: (p) => baseURLs.push(p.info.settings.baseURL),
          update: () => {},
          models: { set: () => {} }
        }) },
        tool: { transform: async (cb) => cb({ add: () => {} }) }
      })
      // Two distinct module copies, like two OpenCode location instances.
      const a = await import(${JSON.stringify(PLUGIN_MODULE)} + '?instance=a')
      const b = await import(${JSON.stringify(PLUGIN_MODULE)} + '?instance=b')
      const cleanupA = await a.kiroPluginV2.setup(ctx(${JSON.stringify(dir)}))
      const cleanupB = await b.kiroPluginV2.setup(ctx(${JSON.stringify(dir)}))
      await cleanupA()
      await cleanupB()
      const res = await fetch(baseURLs[0].replace(/\\/v1$/, '/health')).then((r) => r.status).catch((e) => 'ERR ' + e.code)
      console.log(JSON.stringify({ baseURLs, health: res }))
      // No explicit close: the unref()'d proxy must not keep the process alive.
    `

    try {
      const proc = Bun.spawn(['bun', '-e', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          XDG_CONFIG_HOME: dir,
          KIROCLI_DB_PATH: join(dir, 'missing.sqlite3'),
          KIRO_PROXY_PORT: '0'
        }
      })
      const exited = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 15000))
      ])
      if (!exited) proc.kill()
      const out = (await new Response(proc.stdout).text()).trim().split('\n').pop() || '{}'
      const result = JSON.parse(out) as { baseURLs: string[]; health: number | string }

      expect(exited).toBe(true)
      expect(result.baseURLs).toHaveLength(2)
      expect(result.baseURLs[0]).toBe(result.baseURLs[1])
      expect(result.health).toBe(200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

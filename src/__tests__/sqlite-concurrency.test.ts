import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SQLITE_MODULE = join(import.meta.dir, '..', 'plugin', 'storage', 'sqlite.ts')

// Several OpenCode instances load the plugin at once and share kiro.db. Opening
// the database (and running migrations) must not fail with SQLITE_BUSY.
describe('KiroDatabase concurrent open', () => {
  it('opens the same database from many processes at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-db-'))
    const dbPath = join(dir, 'kiro.db')
    const script = `
      const { createDatabase } = await import(${JSON.stringify(SQLITE_MODULE)})
      try {
        createDatabase(${JSON.stringify(dbPath)}).getAccounts()
        console.log('ok')
      } catch (e) {
        console.log('ERR ' + (e?.code || e?.message))
      }
    `

    try {
      const procs = Array.from({ length: 12 }, () =>
        // XDG_CONFIG_HOME keeps the module-level default kiroDb away from the real one.
        Bun.spawn(['bun', '-e', script], {
          stdout: 'pipe',
          stderr: 'ignore',
          env: { ...process.env, XDG_CONFIG_HOME: dir }
        })
      )
      const outputs = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
      expect(outputs.map((o) => o.trim())).toEqual(Array(12).fill('ok'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)
})

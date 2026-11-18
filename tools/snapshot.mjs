/**
 * Snapshot the lineage payload from a fixed HOME, for refactor comparison.
 * Usage: node tools/snapshot.mjs <out.json> [--home <dir>]
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const out = args[0] ?? join(HERE, '..', 'lib', 'assets', 'snapshot.json')
const homeIndex = args.indexOf('--home')
if (homeIndex !== -1 && args[homeIndex + 1] !== undefined) process.env.DSH_HOME = args[homeIndex + 1]
const moduleIndex = args.indexOf('--module')
const modulePath = moduleIndex === -1 ? new URL('../index.js', import.meta.url) : new URL('file://' + args[moduleIndex + 1])
process.env.DSH_FORK_GRAPH_CACHE = join(HERE, '..', 'lib', 'assets', 'snapshot-cache.json')

const host = await import(modulePath.href)
const routes = []
const dispose = host.apply({
  get: (name) => (name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : undefined),
})
const rebuild = routes.find((route) => route.path === '/plugins/dsh-fork-graph/lineage-rebuild.json')
const payload = await (await rebuild.resource()).json()
writeFileSync(out, JSON.stringify(payload))
dispose()
console.log('wrote', out, '| families', payload.families.length, '| indexed', Object.keys(payload.index).length)
process.exit(0)

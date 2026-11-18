/**
 * Regression: archiving writes workspace.json, never the session log, so a cached
 * session must still pick up the new flag. Builds twice in one process — the
 * second build is the warm (memory-cache) path that used to keep the old flag.
 *
 * Usage: node tools/check-archive.mjs
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HOME = join(HERE, '..', 'lib', 'assets', 'archive-home')
const failures = []
const check = (name, ok, detail) => { if (!ok) failures.push(name + (detail === undefined ? '' : ' :: ' + detail)) }

function decodeLog(file) {
  const buffer = readFileSync(file)
  const starts = []
  let at = buffer.indexOf(MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(MAGIC, at + 4)
  }
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch {}
  }
  return parts.join('')
}

function smallestLogs(count) {
  const files = []
  const root = join(homedir(), '.dsh', 'sessions')
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    for (const session of readdirSync(join(root, workspace.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(root, workspace.name, session.name)
      const file = readdirSync(dir).find((name) => name.endsWith('.jsonl.zstd'))
      if (file !== undefined) files.push(join(dir, file))
    }
  }
  files.sort((a, b) => statSync(a).size - statSync(b).size)
  return files.slice(0, count)
}

rmSync(HOME, { recursive: true, force: true })
mkdirSync(join(HOME, 'storages'), { recursive: true })
const workspace = join(HOME, 'sessions', 'bench')
mkdirSync(workspace, { recursive: true })
writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [] } }))

const ids = []
for (const [index, file] of smallestLogs(2).entries()) {
  const lines = decodeLog(file).split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  const id = 'session-archive-test-' + String(index)
  ids.push(id)
  mkdirSync(join(workspace, id), { recursive: true })
  writeFileSync(join(workspace, id, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ ...header, id }) + '\n' + lines.slice(1).join('\n') + '\n')))
}

process.env.DSH_HOME = HOME
process.env.DSH_FORK_GRAPH_CACHE = join(HERE, '..', 'lib', 'assets', 'archive-cache.json')
rmSync(process.env.DSH_FORK_GRAPH_CACHE, { force: true })

const host = await import(new URL('../index.js', import.meta.url).href)
const routes = []
const dispose = host.apply({
  get: (name) => (name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : undefined),
})
const rebuild = routes.find((route) => route.path === '/plugins/dsh-fork-graph/lineage-rebuild.json')
const read = async () => (await rebuild.resource()).json()

const before = await read()
check('both sessions present', ids.every((id) => before.index[id] !== undefined))
check('nothing archived yet', ids.every((id) => before.index[id].archived === false))

// archive the first session exactly as the host does, then rebuild in the same process
writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [ids[0]] } }))
const after = await read()
check('archive reaches the payload on the warm path', after.index[ids[0]]?.archived === true, String(after.index[ids[0]]?.archived))
check('the other session stays active', after.index[ids[1]]?.archived === false)

// and back again
writeFileSync(join(HOME, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [] } }))
const restored = await read()
check('unarchive reaches the payload too', restored.index[ids[0]]?.archived === false, String(restored.index[ids[0]]?.archived))

dispose()
rmSync(HOME, { recursive: true, force: true })
rmSync(process.env.DSH_FORK_GRAPH_CACHE, { force: true })

if (failures.length === 0) {
  console.log('ARCHIVE CHECK OK — warm rebuild follows the archive set')
  process.exit(0)
}
console.error('ARCHIVE CHECK FAILED (' + failures.length + ')')
for (const failure of failures) console.error(' - ' + failure)
process.exit(1)

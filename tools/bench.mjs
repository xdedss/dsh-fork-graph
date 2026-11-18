/**
 * Scaling bench: build a synthetic HOME with N logs and time the build phases.
 *
 *   node tools/bench.mjs <N>            # N sessions spread over distinct real logs
 *   node tools/bench.mjs <N> --copies   # N copies of one log (one giant family)
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const count = Number(process.argv[2] ?? '200')
const copies = process.argv.includes('--copies')
const TEMPLATES = 20

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

function allLogs(root) {
  const files = []
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
  return files
}

const home = join(HERE, '..', 'lib', 'assets', 'bench-home')
rmSync(home, { recursive: true, force: true })
const workspace = join(home, 'sessions', 'bench')
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({ global: { archivedSessionIds: [] } }))

const logs = allLogs(join(homedir(), '.dsh', 'sessions')).slice(0, copies ? 1 : TEMPLATES)
const templates = logs.map((file) => {
  const lines = decodeLog(file).split('\n').filter(Boolean)
  const header = JSON.parse(lines[0])
  return { header, body: lines.slice(1).join('\n') + '\n' }
})

for (let index = 0; index < count; index += 1) {
  const template = templates[index % templates.length]
  const id = 'session-bench-' + String(index).padStart(4, '0')
  const dir = join(workspace, id)
  mkdirSync(dir, { recursive: true })
  const text = JSON.stringify({ ...template.header, id, createdAt: template.header.createdAt + index }) + '\n' + template.body
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text)))
}

process.env.DSH_HOME = home
process.env.DSH_FORK_GRAPH_CACHE = join(HERE, '..', 'lib', 'assets', 'bench-cache.json')
rmSync(process.env.DSH_FORK_GRAPH_CACHE, { force: true })

const { performance } = await import('node:perf_hooks')
const host = await import(new URL('../index.js', import.meta.url).href)
const routes = []
const dispose = host.apply({
  get: (name) => (name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : undefined),
})
const rebuild = routes.find((route) => route.path === '/plugins/dsh-fork-graph/lineage-rebuild.json')
const started = performance.now()
await (await rebuild.resource()).json()
console.log('bench N=' + count + (copies ? ' copies' : ' mixed') + ' | cold total ' + Math.round(performance.now() - started) + ' ms')
const warmStart = performance.now()
await (await rebuild.resource()).json()
console.log('bench N=' + count + (copies ? ' copies' : ' mixed') + ' | warm total ' + Math.round(performance.now() - warmStart) + ' ms')
dispose()
console.log('bench N=' + count + (copies ? ' copies' : ' mixed') + ' | warm total ' + Math.round(performance.now() - warmStart) + ' ms')

// What the periodic path costs when the file list is still warm: stat only.
const { statSync: stat2 } = await import('node:fs')
const walkStart = performance.now()
const files = readdirSync(workspace, { withFileTypes: true })
let walked = 0
for (const session of files) {
  if (!session.isDirectory()) continue
  for (const name of readdirSync(join(workspace, session.name))) {
    if (name.endsWith('.jsonl.zstd')) walked += 1
  }
}
console.log('bench N=' + count + ' | dir walk ' + Math.round(performance.now() - walkStart) + ' ms (' + walked + ' files)')
const statStart = performance.now()
for (const session of files) {
  if (!session.isDirectory()) continue
  stat2(join(workspace, session.name, 'session.v4.jsonl.zstd'))
}
console.log('bench N=' + count + ' | stat sweep ' + Math.round(performance.now() - statStart) + ' ms')

rmSync(home, { recursive: true, force: true })
rmSync(process.env.DSH_FORK_GRAPH_CACHE, { force: true })
process.exit(0)

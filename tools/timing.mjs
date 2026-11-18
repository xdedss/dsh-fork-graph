/** Time the Host build: what plugin composition costs, and what one build costs. */
import { performance } from 'node:perf_hooks'

const host = await import(new URL('../index.js', import.meta.url).href)

const routes = []
const ctx = {
  get: (name) => (name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : undefined),
}
const t0 = performance.now()
const dispose = host.apply(ctx)
console.log('apply() returned in', (performance.now() - t0).toFixed(1), 'ms  — nothing built on the boot path')

const plain = routes.find((route) => route.path === '/plugins/dsh-fork-graph/lineage.json')
const first = performance.now()
const response = await plain.resource()
const body = await response.json()
console.log('first build (awaited by the first request):', (performance.now() - first).toFixed(0), 'ms  families', body.families.length, 'sessions', Object.keys(body.index).length)

const rebuild = routes.find((route) => route.path === '/plugins/dsh-fork-graph/lineage-rebuild.json')
const warmStart = performance.now()
await (await rebuild.resource()).json()
console.log('warm rebuild (files cached):', (performance.now() - warmStart).toFixed(0), 'ms')

const servedStart = performance.now()
await (await plain.resource()).json()
console.log('plain route (serves cache):', (performance.now() - servedStart).toFixed(0), 'ms')

dispose()

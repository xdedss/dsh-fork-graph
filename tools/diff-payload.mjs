/** Deep-compare two lineage payloads, ignoring fields the refactor deliberately dropped. */
import { readFileSync } from 'node:fs'

const [leftPath, rightPath] = process.argv.slice(2)
const left = JSON.parse(readFileSync(leftPath, 'utf8'))
const right = JSON.parse(readFileSync(rightPath, 'utf8'))

// Fields the payload intentionally stopped publishing, plus build timestamps.
const IGNORED = new Set(['generatedAt', 'cwd', 'headTime', 'running', 'fresh', 'size'])
function strip(value) {
  if (Array.isArray(value)) return value.map(strip)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    if (IGNORED.has(key)) continue
    out[key] = strip(child)
  }
  return out
}

const differences = []
function walk(a, b, path) {
  if (differences.length >= 20) return
  if (a === b) return
  const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)
  if (typeOf(a) !== typeOf(b)) {
    differences.push(path + ': ' + typeOf(a) + ' vs ' + typeOf(b))
    return
  }
  if (typeOf(a) === 'array') {
    if (a.length !== b.length) differences.push(path + ': length ' + a.length + ' vs ' + b.length)
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) walk(a[index], b[index], path + '[' + index + ']')
    return
  }
  if (typeOf(a) === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!(key in a)) differences.push(path + '.' + key + ': missing on the left')
      else if (!(key in b)) differences.push(path + '.' + key + ': missing on the right')
      else walk(a[key], b[key], path + '.' + key)
    }
    return
  }
  differences.push(path + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b))
}

walk(strip(left), strip(right), '$')
if (differences.length === 0) {
  console.log('IDENTICAL (ignoring ' + [...IGNORED].join(', ') + ')')
  process.exit(0)
}
console.error('DIFFERENCES (' + differences.length + ')')
for (const difference of differences) console.error(' - ' + difference)
process.exit(1)

/**
 * dsh-fork-graph — Host half.
 *
 * A fork copies an exact prefix of its source session log, so two sessions that
 * descend from one point share a prefix. The browser never sees event bodies,
 * hence the lineage is computed here and published as JSON that the Client half
 * only draws.
 *
 * Two layouts are published per family: `all` (every session) and `active`
 * (archived sessions removed). The panel switches between them.
 *
 * Startup cost is kept off the boot path: the first build runs shortly after the
 * window appears, yields between files, and reuses a per-file cache so a restart
 * only parses what changed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')
const ASSET = join(HERE, 'lib', 'assets', 'lineage.json')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const FIRST_BUILD_DELAY_MS = 1200
const REFRESH_MS = 30000
const IDLE_REBUILD_WINDOW_MS = 5 * 60 * 1000

const ROUTE = '/plugins/dsh-fork-graph/lineage.json'
const ROUTE_REBUILD = '/plugins/dsh-fork-graph/lineage-rebuild.json'

/** Events that carry conversation content; everything else is bookkeeping. */
const COUNTED_EVENTS = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/call',
  'tool/result',
  'compaction/summary',
])
const isCounted = (event) => COUNTED_EVENTS.has(event.type)

// ---------------------------------------------------------------- reading logs

/** DSH stores one zstd frame per append; decode them all (a torn tail is skipped). */
function decodeLog(file) {
  const buffer = readFileSync(file)
  const starts = []
  let at = buffer.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buffer.indexOf(ZSTD_MAGIC, at + 4)
  }
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8'))
    } catch {
      // A partially written tail frame: keep everything before it.
    }
  }
  return parts.join('')
}

/** Session ids the host archived, without the `session-` prefix. */
function archivedIds() {
  try {
    const state = JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8'))
    const ids = state?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map((id) => String(id).replace(/^session-/, '')) : [])
  } catch {
    return new Set()
  }
}

/** Directory walks are syscall-heavy on Windows, so a periodic refresh reuses the list. */
const FILE_LIST_TTL_MS = 3000
let fileList = { at: 0, files: [] }

function sessionFiles(fresh) {
  if (fresh !== true && Date.now() - fileList.at < FILE_LIST_TTL_MS) return fileList.files
  const files = []
  let workspaces
  try {
    workspaces = readdirSync(SESSIONS, { withFileTypes: true })
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let sessions
    try {
      sessions = readdirSync(join(SESSIONS, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(SESSIONS, workspace.name, session.name)
      let names
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      const file = names.find((name) => name.endsWith('.jsonl.zstd'))
      if (file !== undefined) files.push(join(dir, file))
    }
  }
  fileList = { at: Date.now(), files }
  return files
}

// ---------------------------------------------------------------- identity

/**
 * Event identity for prefix comparison. Forks copy events verbatim, so the raw
 * serialized text is a stable identity; a non-cryptographic hash over it is much
 * cheaper than canonicalising and SHA-1 hashing every event.
 */
const fingerprintCache = new Map()

function fingerprint(event) {
  const text = JSON.stringify(event)
  let cached = fingerprintCache.get(text)
  if (cached !== undefined) return cached
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193)
    h2 = Math.imul(h2 ^ code, 0x85ebca6b)
  }
  cached = (h1 >>> 0).toString(16) + '-' + (h2 >>> 0).toString(16) + '-' + String(text.length)
  fingerprintCache.set(text, cached)
  return cached
}

function commonPrefix(a, b) {
  const limit = Math.min(a.fingerprints.length, b.fingerprints.length)
  let length = 0
  while (length < limit && a.fingerprints[length] === b.fingerprints[length]) length += 1
  return length
}

/** Let the event loop breathe between expensive chunks. */
const breathe = () => new Promise((resolve) => setImmediate(resolve))

// ---------------------------------------------------------------- loading

/**
 * Parsed form of one session. `events` keeps only what the graph needs, so the
 * disk cache stays small: a paid projection instead of raw payloads.
 */
function project(session, stamp) {
  return {
    mtimeMs: stamp.mtimeMs,
    size: stamp.size,
    id: session.id,
    short: session.short,
    cwd: session.cwd,
    createdAt: session.createdAt,
    title: session.title,
    events: session.events.map((event) => [event.type, event.time, event.seq]),
    fps: session.fingerprints,
  }
}

function revive(record, archived) {
  const id = String(record.id)
  const archivedKey = id.replace(/^session-/, '')
  return {
    id,
    short: record.short,
    cwd: record.cwd,
    createdAt: record.createdAt,
    archivedKey,
    archived: archived.has(archivedKey),
    title: record.title,
    events: record.events.map(([type, time, seq]) => ({ type, time, seq })),
    fingerprints: record.fps,
  }
}

/**
 * Archiving writes `workspace.json`, never the session log, so a cached session
 * keeps its old flag until this refresh. Recompute it on every read.
 */
function markArchived(session, archived) {
  session.archived = archived.has(session.archivedKey)
  return session
}

/** In-process cache: file → parsed session plus the projection it came from. */
const memoryCache = new Map()

/** One cache entry: a parsed session (or a rejection) and the stamp it came from. */
const cached = (stamp, session, projection) => ({ mtimeMs: stamp.mtimeMs, size: stamp.size, session, projection })
const rejection = (stamp) => ({ mtimeMs: stamp.mtimeMs, size: stamp.size, rejected: true })
const matches = (entry, stamp) => entry !== undefined && entry.mtimeMs === stamp.mtimeMs && entry.size === stamp.size

function safeStat(file) {
  try {
    return statSync(file)
  } catch {
    return undefined
  }
}

/** Bump when the projection shape or the fingerprint changes. */
const CACHE_VERSION = 1
const CACHE_FILE = process.env.DSH_FORK_GRAPH_CACHE ?? join(HOME, 'storages', 'fork-graph-cache.json')
/** Rewriting a multi-megabyte cache on every refresh would cost more than it saves. */
const CACHE_WRITE_INTERVAL_MS = 5 * 60 * 1000
let lastCacheWrite = 0
let warnedWriteFailure = false

function readDiskCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    if (parsed?.version !== CACHE_VERSION || parsed.files === null || typeof parsed.files !== 'object') return new Map()
    return new Map(Object.entries(parsed.files))
  } catch {
    return new Map()
  }
}

/**
 * The disk cache is only useful while the process has no parsed session for a
 * file, i.e. on the first build after a restart. Reading it on every rebuild
 * would cost a multi-megabyte JSON parse per refresh.
 */
let diskCacheOnce
function diskRecords() {
  if (diskCacheOnce === undefined) diskCacheOnce = readDiskCache()
  return diskCacheOnce
}

function writeDiskCache(records) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(records) }))
    warnedWriteFailure = false
  } catch (error) {
    // A cache that cannot be written only costs time; warn once, not every build.
    if (!warnedWriteFailure) {
      warnedWriteFailure = true
      console.warn('[dsh-fork-graph] cache write failed:', error?.message ?? error)
    }
  }
}

/** Parse one log file into a session, or nothing when it is not a conversation. */
function parseLogFile(file, archived) {
  let records
  try {
    records = decodeLog(file).split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    }).filter(Boolean)
  } catch {
    return undefined
  }
  const header = records.find((record) => record.type === 'session')
  if (header === undefined || header.origin === 'subagent') return undefined
  const events = records.filter((record) => record !== header && record.type !== 'session')
  if (events.length === 0) return undefined
  const titles = events.filter((event) => event.type === 'session/title').map((event) => event.data?.title).filter(Boolean)
  const id = String(header.id)
  const archivedKey = id.replace(/^session-/, '')
  return {
    id,
    short: archivedKey.slice(0, 8),
    cwd: header.cwd ?? '',
    createdAt: header.createdAt ?? events[0].time,
    archivedKey,
    archived: archived.has(archivedKey),
    title: titles.at(-1) ?? '(untitled)',
    events,
    fingerprints: events.map(fingerprint),
  }
}

/** Read every non-subagent session, yielding only while there is parsing to spread. */
async function loadSessions(fresh) {
  const archived = archivedIds()
  const files = sessionFiles(fresh)
  const disk = diskRecords()
  const records = new Map()
  const sessions = []
  const stats = { warm: 0, cold: 0, parsed: 0 }
  let dirty = disk.size !== files.length
  let parsed = 0

  for (const file of files) {
    const stamp = safeStat(file)
    if (stamp === undefined) continue

    const warm = memoryCache.get(file)
    if (matches(warm, stamp)) {
      // a file that is not a conversation is remembered as such: re-parsing it
      // on every rebuild would cost more than the graph itself
      if (warm.rejected === true) continue
      stats.warm += 1
      sessions.push(markArchived(warm.session, archived))
      records.set(file, warm.projection)
      continue
    }

    const cold = disk.get(file)
    if (matches(cold, stamp)) {
      if (cold.rejected === true) {
        memoryCache.set(file, rejection(stamp))
        continue
      }
      stats.cold += 1
      const session = revive(cold, archived)
      memoryCache.set(file, cached(stamp, session, cold))
      records.set(file, cold)
      sessions.push(session)
      continue
    }

    // only a parse is expensive enough to be worth yielding for
    if (parsed++ % 2 === 0) await breathe()
    stats.parsed += 1
    const session = parseLogFile(file, archived)
    if (session === undefined) {
      memoryCache.set(file, rejection(stamp))
      records.set(file, rejection(stamp))
      dirty = true
      continue
    }
    const projection = project(session, stamp)
    memoryCache.set(file, cached(stamp, session, projection))
    records.set(file, projection)
    sessions.push(session)
    dirty = true
  }

  if (dirty && Date.now() - lastCacheWrite > CACHE_WRITE_INTERVAL_MS) {
    writeDiskCache(records)
    diskCacheOnce = records
    lastCacheWrite = Date.now()
  }
  return { sessions, stats }
}

// ---------------------------------------------------------------- lineage

/**
 * Sessions that share any prefix necessarily share their first event, so this
 * key is an exact pre-filter for every pairwise prefix comparison: pairs from
 * different buckets can never match.
 */
function bucketSessions(sessions) {
  const buckets = new Map()
  for (const session of sessions) {
    const key = session.fingerprints[0] ?? ''
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = []
      buckets.set(key, bucket)
    }
    bucket.push(session)
  }
  return buckets
}

/**
 * Attach `forkDepth` (the index of the `session/end-seed` marker that a fork
 * left in its own log) and `source` (the session that prefix was copied from).
 */
function resolveLineage(sessions) {
  const byAge = [...sessions].sort((a, b) => a.createdAt - b.createdAt)
  const buckets = bucketSessions(byAge)
  for (const session of byAge) {
    let shared = 0
    let source
    for (const candidate of buckets.get(session.fingerprints[0] ?? '')) {
      if (candidate.createdAt > session.createdAt) break
      if (candidate === session) continue
      const length = commonPrefix(session, candidate)
      // a candidate that was itself forked deeper cannot be this session's source
      if (length === 0 || length < candidate.forkDepth) continue
      if (length > shared) {
        shared = length
        source = candidate
      }
    }
    let marker = -1
    for (let index = shared; index >= Math.max(0, shared - 24); index -= 1) {
      if (session.events[index]?.type === 'session/end-seed') {
        marker = index
        break
      }
    }
    session.forkDepth = marker
    session.source = marker === -1 ? undefined : source
  }
}

/** Content counters and the timestamps the rows show. */
function measureSessions(sessions) {
  for (const session of sessions) {
    const countBefore = new Int32Array(session.events.length + 1)
    let counted = 0
    let lastCountedTime

    for (let index = 0; index < session.events.length; index += 1) {
      const event = session.events[index]
      if (isCounted(event)) {
        counted += 1
        lastCountedTime = event.time
      }
      countBefore[index + 1] = counted
    }

    session.countBefore = countBefore
    session.countTotal = counted
    session.headTime = Math.max(session.createdAt, lastCountedTime ?? session.createdAt)
    session.prefixEndTime = undefined
    for (let index = session.forkDepth - 1; index >= 0; index -= 1) {
      if (isCounted(session.events[index])) {
        session.prefixEndTime = session.events[index].time
        break
      }
    }
  }
}

/** Union sessions that share any prefix into families. */
function groupFamilies(sessions) {
  const parent = new Map(sessions.map((session) => [session.id, session.id]))
  const find = (id) => {
    let cursor = id
    while (parent.get(cursor) !== cursor) cursor = parent.get(cursor)
    return cursor
  }
  for (const bucket of bucketSessions(sessions).values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if (commonPrefix(bucket[i], bucket[j]) === 0) continue
        const left = find(bucket[i].id)
        const right = find(bucket[j].id)
        if (left !== right) parent.set(left, right)
      }
    }
  }
  const grouped = new Map()
  for (const session of sessions) {
    const root = find(session.id)
    if (!grouped.has(root)) grouped.set(root, [])
    grouped.get(root).push(session)
  }
  return [...grouped.values()]
}

// ---------------------------------------------------------------- layout

/**
 * The seq of the `count`-th content event of a Session, i.e. the exact inclusive
 * boundary that reproduces its first `count` conversation events.
 */
function contentBoundarySeq(session, count) {
  if (count <= 0) return session.events[0]?.seq
  let seen = 0
  for (const event of session.events) {
    if (!isCounted(event)) continue
    seen += 1
    if (seen === count) return event.seq
  }
  return undefined
}

/**
 * One point per conversation position. Two forks that land on the same amount
 * of content are the same split even when the bookkeeping events between them
 * differ, so the position is the key.
 */
function findForkPoints(members) {
  const points = new Map()
  for (const session of members) {
    if (session.forkDepth <= 0 || session.source === undefined) continue
    const prefix = session.countBefore[session.forkDepth]
    const key = String(prefix)
    let point = points.get(key)
    if (point === undefined) {
      point = { kind: 'fork', time: undefined, prefix, branches: [] }
      points.set(key, point)
    }
    if (session.prefixEndTime !== undefined) {
      point.time = point.time === undefined ? session.prefixEndTime : Math.min(point.time, session.prefixEndTime)
    }
    point.branches.push(session)
  }
  for (const point of points.values()) {
    point.owner = point.branches
      .map((branch) => branch.source)
      .reduce((best, candidate) => (candidate.forkDepth < best.forkDepth ? candidate : best))
    point.atSeq = contentBoundarySeq(point.owner, point.prefix)
  }
  return points
}

/**
 * Merge a head that stopped exactly on a fork point into that point, then order
 * every row newest-first. A point row owns both the split and the session that
 * ended there.
 */
function buildRows(points, members) {
  const heads = members.map((session) => ({ kind: 'head', time: session.headTime, session }))
  for (const point of points.values()) {
    const head = heads.find((entry) => entry.merged !== true
      && entry.session.countTotal === point.prefix
      && (point.branches.includes(entry.session)
        || point.branches.some((branch) => branch.source !== undefined && branch.source.id === entry.session.id)))
    if (head === undefined) continue
    head.merged = true
    point.kind = 'fork+head'
    point.head = head.session
  }

  const rows = [...points.values(), ...heads.filter((head) => head.merged !== true)]
  rows.sort((a, b) => (b.time - a.time) || (a.kind === 'head' ? -1 : 1))
  rows.forEach((row, index) => { row.index = index })

  const headRowOf = (session) => rows.find((row) => (row.kind === 'head' && row.session.id === session.id)
    || (row.kind === 'fork+head' && row.head.id === session.id))
  return { rows, headRowOf }
}

/**
 * Walk every session down from the virtual root, assigning a lane and emitting
 * the vertical segments. A fork point hands the lane to one child and starts a
 * new lane for every other branch.
 */
function assignLanes(points, members, rows, headRowOf, root) {
  const forksOf = new Map(members.map((session) => [session.id, []]))
  for (const point of points.values()) {
    if (!forksOf.has(point.owner.id)) forksOf.set(point.owner.id, [])
    forksOf.get(point.owner.id).push(point)
  }

  let laneCount = 0
  const segments = []
  const rowLane = new Map()
  const headLane = new Map()
  const laneBase = new Map()
  const newLane = (base) => {
    const lane = laneCount++
    laneBase.set(lane, base)
    return lane
  }

  const walk = (session, lane, fromIndex, elbow) => {
    const head = headRowOf(session)
    if (head === undefined) return
    const forks = (forksOf.get(session.id) ?? [])
      .filter((point) => point.index <= fromIndex)
      .sort((a, b) => b.index - a.index)

    let current = fromIndex
    let pending = elbow
    for (const point of forks) {
      segments.push({ lane, from: current, to: point.index, elbow: pending })
      pending = undefined
      rowLane.set(point.index, lane)

      const sourceContinues = head.index < point.index
      // the branch that keeps this lane: the largest one when the source stopped here
      const heir = sourceContinues
        ? undefined
        : [...point.branches].sort((a, b) => (b.countTotal - a.countTotal) || (a.createdAt - b.createdAt))[0]

      for (const branch of point.branches) {
        const branchHead = headRowOf(branch)
        // a branch merged into this point has no line of its own
        if (branchHead !== undefined && branchHead.kind === 'fork+head' && branchHead.index === point.index) continue
        if (branch === heir) walk(branch, lane, point.index, undefined)
        else walk(branch, newLane(point.prefix), point.index, { lane, row: point.index })
      }

      if (!sourceContinues) {
        headLane.set(session.id, lane)
        return
      }
      current = point.index
    }
    segments.push({ lane, from: current, to: head.index, elbow: pending })
    headLane.set(session.id, lane)
  }

  const inFamily = new Set(members.map((session) => session.id))
  let rootLane
  for (const session of members) {
    // only sessions that did not fork from a member start a trunk
    if (session.forkDepth > 0 && session.source !== undefined && inFamily.has(session.source.id)) continue
    const lane = newLane(0)
    const elbow = rootLane === undefined ? undefined : { lane: rootLane, row: root.index }
    if (rootLane === undefined) rootLane = lane
    walk(session, lane, root.index, elbow)
  }

  return { segments, rowLane, headLane, laneCount: Math.max(1, laneCount), laneBase }
}

/**
 * Per lane, walk the rows downwards: `delta` is the content added since the
 * previous node on the same lane, and the first one starts at the lane base.
 */
function assignDeltas({ points, rows, rowLane, headLane, laneBase }) {
  const chains = new Map()
  const push = (lane, entry) => {
    if (!chains.has(lane)) chains.set(lane, [])
    chains.get(lane).push(entry)
  }
  for (const point of points.values()) {
    const lane = rowLane.get(point.index)
    if (lane !== undefined) push(lane, { index: point.index, cumulative: point.prefix, row: point })
  }
  for (const row of rows) {
    if (row.kind !== 'head') continue
    const lane = headLane.get(row.session.id)
    if (lane !== undefined) push(lane, { index: row.index, cumulative: row.session.countTotal, row })
  }
  for (const [lane, chain] of chains) {
    chain.push({ index: rows.length, cumulative: laneBase.get(lane) ?? 0 })
    chain.sort((a, b) => b.index - a.index)
    let previous = 0
    for (const entry of chain) {
      if (entry.row !== undefined) entry.row.delta = entry.cumulative - previous
      previous = entry.cumulative
    }
  }
}

/** Serialize one row for the client; it draws without any further analysis. */
function serializeRow(row, lanes) {
  if (row.kind === 'root') return { kind: 'root', index: row.index, time: row.time }
  if (row.kind === 'fork') {
    return {
      kind: 'fork',
      index: row.index,
      lane: lanes.rowLane.get(row.index) ?? 0,
      prefix: row.prefix,
      delta: row.delta ?? 0,
      time: row.time,
      forkFrom: { sessionId: row.owner.id, atSeq: row.atSeq },
    }
  }
  const point = row.kind === 'fork+head'
  const session = point ? row.head : row.session
  return {
    kind: row.kind,
    index: row.index,
    lane: (point ? lanes.rowLane.get(row.index) : lanes.headLane.get(session.id)) ?? 0,
    sessionId: session.id,
    title: session.title,
    short: session.short,
    archived: session.archived === true,
    total: session.countTotal,
    delta: row.delta ?? 0,
    time: row.time,
    ...(point ? { prefix: row.prefix, forkFrom: { sessionId: row.head.id, atSeq: row.atSeq } } : {}),
  }
}

/** One family → a serializable layout, with a virtual `root` row underneath. */
function layOutFamily(members) {
  const points = findForkPoints(members)
  const { rows, headRowOf } = buildRows(points, members)

  const earliest = members.reduce((time, session) => Math.min(time, session.events[0]?.time ?? session.createdAt), Infinity)
  const root = { kind: 'root', time: earliest, index: rows.length }
  rows.push(root)

  const lanes = assignLanes(points, members, rows, headRowOf, root)
  assignDeltas({ points, rows, ...lanes })

  return {
    members: members.length,
    lanes: lanes.laneCount,
    rows: rows.map((row) => serializeRow(row, lanes)),
    segments: lanes.segments,
  }
}

// ---------------------------------------------------------------- payload

/** One line per build when DSH_FORK_GRAPH_DEBUG=1, to see where the time goes. */
const DEBUG = process.env.DSH_FORK_GRAPH_DEBUG === '1'

/**
 * Phase timings of the first build after a restart and of the latest one, so a
 * cold start can be measured without attaching to the host's stdout.
 */
const STATS_FILE = join(HERE, 'lib', 'assets', 'build-stats.json')
let firstStats
const recentStats = []

function recordStats(stats) {
  if (firstStats === undefined) firstStats = stats
  recentStats.unshift(stats)
  if (recentStats.length > 10) recentStats.length = 10
  try {
    mkdirSync(dirname(STATS_FILE), { recursive: true })
    writeFileSync(STATS_FILE, JSON.stringify({ first: firstStats, last: stats, recent: recentStats }, null, 2))
  } catch {
    // diagnostics only
  }
}

/** Convert the serializable data into the payload the client draws. */
async function build(fresh, trigger) {
  const started = performance.now()
  const { sessions, stats: load } = await loadSessions(fresh)
  const loaded = performance.now()

  // every session needs its lineage before families can be laid out
  resolveLineage(sessions)
  const lineage = performance.now()
  measureSessions(sessions)
  const measured = performance.now()
  const groups = groupFamilies(sessions)
  const grouped = performance.now()

  const families = []
  for (const members of groups) {
    const activeMembers = members.filter((session) => !session.archived)
    // every family gets a layout: even a lone conversation draws root + itself,
    // so the panel is always available for an unarchived session
    families.push({
      size: members.length,
      ids: members.map((session) => ({ id: session.id, archived: session.archived === true })),
      all: layOutFamily(members),
      active: activeMembers.length > 0 ? layOutFamily(activeMembers) : undefined,
    })
    // only large families are expensive enough to be worth yielding for
    if (members.length >= 2) await breathe()
  }
  families.sort((a, b) => b.size - a.size)

  const index = {}
  families.forEach((family, position) => {
    for (const entry of family.ids) index[entry.id] = { family: position, archived: entry.archived }
  })

  const laidOut = performance.now()
  const stats = {
    at: new Date().toISOString(),
    trigger: trigger ?? 'unknown',
    sessions: sessions.length,
    families: families.length,
    drawn: families.length,
    warm: load.warm,
    cold: load.cold,
    parsed: load.parsed,
    loadMs: Math.round(loaded - started),
    lineageMs: Math.round(lineage - loaded),
    measureMs: Math.round(measured - lineage),
    groupMs: Math.round(grouped - measured),
    layoutMs: Math.round(laidOut - grouped),
    totalMs: Math.round(laidOut - started),
  }
  recordStats(stats)
  if (DEBUG) {
    console.log('[dsh-fork-graph] build ' + Object.entries(stats).map(([key, value]) => key + '=' + value).join(' '))
  }

  return {
    generatedAt: Date.now(),
    families: families.map((family) => ({ all: family.all, active: family.active })),
    index,
  }
}

// ---------------------------------------------------------------- serving

let latest = ''
let building

/** Rebuild once at a time; concurrent callers share the same promise. */
function requestBuild(fresh, trigger) {
  if (building !== undefined) return building
  building = build(fresh === true, trigger)
    .then((payload) => {
      latest = JSON.stringify(payload)
      try {
        mkdirSync(dirname(ASSET), { recursive: true })
        writeFileSync(ASSET, latest)
      } catch {
        // the on-disk copy is only a debugging aid
      }
      return latest
    })
    .catch((error) => {
      // never break the host because the graph could not be built
      console.error('[dsh-fork-graph] lineage build failed:', error)
      return latest
    })
    .finally(() => { building = undefined })
  return building
}

/** Host plugin body: serve the lineage, build it lazily, refresh while it is read. */
export function apply(ctx) {
  const disposers = []
  let registered = false
  let lastServed = 0

  const answer = async () => {
    lastServed = Date.now()
    if (latest === '') await requestBuild(false, 'first-request')
    return new Response(latest === '' ? '{}' : latest, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  /** Claim one exact route once the web carrier exists (it composes after plugins). */
  const claim = (webServer, path, resource) => {
    disposers.push(webServer.register({ kind: 'exact', path, resource }))
  }
  const ensureRoutes = () => {
    if (registered) return
    const webServer = ctx?.get?.('webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
    registered = true
    claim(webServer, ROUTE, answer)
    // an action or a freshly opened panel must see the current directory
    claim(webServer, ROUTE_REBUILD, async () => {
      await requestBuild(true, 'route')
      return answer()
    })
  }

  ensureRoutes()
  // The first build runs after the window is up: it parses every session log and
  // must never sit on the boot path.
  const kickoff = setTimeout(() => {
    ensureRoutes()
    void requestBuild(false, 'kickoff')
  }, FIRST_BUILD_DELAY_MS)
  const timer = setInterval(() => {
    ensureRoutes()
    // keep the snapshot warm only while something is actually reading it
    if (Date.now() - lastServed < IDLE_REBUILD_WINDOW_MS) void requestBuild(false, 'timer')
  }, REFRESH_MS)

  return () => {
    clearTimeout(kickoff)
    clearInterval(timer)
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }
}

export const name = 'dsh-fork-graph'

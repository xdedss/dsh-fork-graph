/** Offline checks: Host publishes lineage, Client registers its slot entry. */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
const check = (name, ok, detail) => {
  if (!ok) failures.push(name + (detail === undefined ? '' : ' :: ' + detail))
}

// ---- host ----
const host = await import(new URL('../index.js', import.meta.url).href)
check('host exports apply', typeof host.apply === 'function')
check('host exports name', host.name === 'dsh-fork-graph')
const started = Date.now()
const dispose = host.apply()
check('host apply returns a disposer', typeof dispose === 'function')
check('apply does not build on the boot path', Date.now() - started < 100, String(Date.now() - started) + 'ms')
dispose()

const asset = join(HERE, '..', 'lib', 'assets', 'lineage.json')
let data

// ---- host route ----
const routes = []
const routeCtx = {
  get: (name) => (name === 'webServer' ? { register(candidate) { routes.push(candidate); return () => {} } } : undefined),
}
const disposeRoute = host.apply(routeCtx)
const route = routes.find((candidate) => candidate.path === '/plugins/dsh-fork-graph/lineage.json')
const rebuildRoute = routes.find((candidate) => candidate.path === '/plugins/dsh-fork-graph/lineage-rebuild.json')
check('host claims its lineage route', route !== undefined, route?.path)
check('host claims the rebuild route', rebuildRoute !== undefined, rebuildRoute?.path)
if (route !== undefined) {
  const response = await route.resource(new Request('http://127.0.0.1/plugins/dsh-fork-graph/lineage.json'))
  check('route answers 200', response.status === 200, String(response.status))
  check('route is json', (response.headers.get('content-type') ?? '').startsWith('application/json'), response.headers.get('content-type'))
  check('route disables caching', response.headers.get('cache-control') === 'no-store')
  const served = await response.json()
  check('served payload has families', Array.isArray(served.families) && served.families.length > 0)
  check('served payload is the same shape the client expects', served.index !== undefined && (served.families.find((family) => family.all !== undefined)?.all.rows.length ?? 0) > 1)
  const forkRow = served.families.flatMap((family) => family.all?.rows ?? []).find((row) => row.kind === 'fork')
  check('fork rows name an exact fork point', typeof forkRow?.forkFrom?.atSeq === 'number', String(forkRow?.forkFrom?.atSeq))
  check('fork point source is a known session', forkRow !== undefined && served.index[forkRow.forkFrom.sessionId] !== undefined)
  // one conversation position is one fork row: no duplicate prefix among points
  const prefixes = served.families.flatMap((family) => family.all?.rows ?? []).filter((row) => row.kind === 'fork' || row.kind === 'fork+head').map((row) => row.prefix)
  check('a conversation position is a single fork row', new Set(prefixes).size === prefixes.length, prefixes.join(','))
  check('every family has a drawable layout', served.families.every((family) => family.all !== undefined))
  const orphan = Object.keys(served.index).find((id) => served.families[served.index[id].family]?.all === undefined)
  check('no session points at a family without a layout', orphan === undefined, String(orphan))
  const rebuiltResponse = await rebuildRoute.resource()
  check('rebuild route answers 200', rebuiltResponse.status === 200, String(rebuiltResponse.status))
  const rebuilt = await rebuiltResponse.json()
  check('rebuild returns a full payload', Array.isArray(rebuilt.families) && rebuilt.families.length > 0)
  check('rebuild is fresh', typeof rebuilt.generatedAt === 'number' && rebuilt.generatedAt >= served.generatedAt)

  // the build also leaves a debug copy on disk
  check('lineage asset written', existsSync(asset))
  if (existsSync(asset)) {
    data = JSON.parse(readFileSync(asset, 'utf8'))
    check('asset has families', Array.isArray(data.families) && data.families.length > 0, String(data.families?.length))
    check('asset has index', data.index !== undefined && Object.keys(data.index).length > 0, String(Object.keys(data.index ?? {}).length))
    const family = data.families.find((candidate) => candidate.all !== undefined)
    check('family carries both variants', family?.all !== undefined && family?.all?.rows?.length > 1)
    const withActive = data.families.filter((candidate) => candidate.active !== undefined)
    check('some family has an active-only variant', withActive.length > 0, String(withActive.length))
    const layout = (withActive[0] ?? family).all
    const kinds = new Set(layout.rows.map((row) => row.kind))
    check('layout has a root row', kinds.has('root'))
    check('layout rows are indexed from 0', layout.rows[0]?.index === 0 && layout.rows.at(-1)?.index === layout.rows.length - 1)
    check('segments point upward', layout.segments.every((segment) => segment.from >= segment.to))
    check('lanes within laneCount', layout.rows.every((row) => (row.lane ?? 0) < layout.lanes))
    const firstHead = layout.rows.find((row) => row.sessionId !== undefined)
    check('head rows carry a title and total', typeof firstHead?.title === 'string' && typeof firstHead?.total === 'number')
    check('index points at a family', data.index[firstHead.sessionId]?.family !== undefined)
  }
}
disposeRoute()

// ---- client ----
let captured
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry } } }
const head = { child: null, appendChild(tag) { this.child = tag } }
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  body: {},
  head,
  createElement() {
    const tag = { id: '', textContent: '', remove() { if (head.child === tag) head.child = null } }
    return tag
  },
  getElementById(id) {
    return head.child !== null && head.child.id === id ? head.child : null
  },
  addEventListener() {},
  removeEventListener() {},
}
const fakeReact = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (value) => [value, () => undefined],
}
await import(new URL('../client.js', import.meta.url).href)
check('client registers with the loader', captured?.id === 'dsh-fork-graph', captured?.id)
const client = captured.factory((specifier) => {
  if (specifier === 'react') return fakeReact
  if (specifier === 'react-dom') return { createPortal: () => null }
  throw new Error('unexpected require: ' + specifier)
})
check('client exports apply', typeof client.apply === 'function')
check('client declares slots and locale', Array.isArray(client.inject) && client.inject.join(',') === 'slots,locale', String(client.inject))

const registrations = []
const slots = {
  inject(key, callback) { callback(); return () => undefined },
  register(options, component) { registrations.push({ options, component }); return { options, component } },
}
const registeredLocales = []
const realCtx = {
  get: (name) => (name === 'slots' ? slots : name === 'uiWorkspace' ? { openSession() {} } : undefined),
  effect: (fn) => fn(),
  locale: {
    register(namespace, messages) { registeredLocales.push({ namespace, messages }); return () => undefined },
    bind(namespace) { return (key, params) => 'B:' + namespace + ':' + key },
  },
}
client.apply(realCtx)
check('client contributes to the header actions slot', registrations.length === 1, String(registrations.length))
const registration = registrations[0]
check('slot entry carries an inject face', typeof registration?.options?.inject === 'function')
check('slot entry carries a component', typeof registration?.component === 'function')

// dictionaries: both languages present and in sync
const dictionaries = registeredLocales[0]?.messages ?? {}
const zhKeys = Object.keys(dictionaries.zh ?? {}).sort()
const enKeys = Object.keys(dictionaries.en ?? {}).sort()
check('client registers its dictionaries', registeredLocales.length === 1
  && registeredLocales[0].namespace === 'dsh-fork-graph', String(registeredLocales[0]?.namespace))
check('dictionaries cover zh and en', zhKeys.length > 0 && enKeys.length > 0, zhKeys.length + '/' + enKeys.length)
check('both languages define the same keys', zhKeys.join(',') === enKeys.join(','))
check('slot registration declares the locale namespace', registration?.options?.locale === 'dsh-fork-graph',
  String(registration?.options?.locale))

// ---- render smoke test ----
// A fake React records the element tree and feeds the component a fixed state, so
// a render-time throw fails here instead of silently removing the header control.
{
  const payload = JSON.parse(readFileSync(asset, 'utf8'))
  const sessionId = Object.keys(payload.index).find((id) => {
    const family = payload.families[payload.index[id].family]
    if (family === undefined) return false
    // the panel picks the active variant when the family has one
    const layout = family.active ?? family.all
    return layout !== undefined && layout.members >= 2
  })
  check('payload has a drawn family to render', sessionId !== undefined, String(sessionId))

  /** Render the component with a fake React and return the recorded elements. */
  const renderPanel = (targetSessionId, showArchived, hoveredRow) => {
    const created = []
    const createElement = (type, props, ...children) => {
      const node = { type, props: props ?? {}, children: children.flat(Infinity) }
      created.push(node)
      return node
    }
    const states = [
      payload,
      false,
      showArchived === true,
      true,
      { left: 0, top: 0, width: 600 },
      undefined,
      '',
      undefined,
      undefined,
      undefined,
      hoveredRow,
    ]
    let cursor = 0
    const renderReact = {
      createElement,
      useCallback: (fn) => fn,
      useEffect: () => undefined,
      useMemo: (fn) => fn(),
      useRef: (value) => ({ current: value }),
      useState: () => [states[cursor++], () => undefined],
    }
    const loader = captured.factory((specifier) => {
      if (specifier === 'react') return renderReact
      if (specifier === 'react-dom') return { createPortal: (node) => node }
      throw new Error('unexpected require: ' + specifier)
    })
    const renderComponents = []
    const renderSlots = {
      inject(_key, callback) { callback(); return () => undefined },
      register(_options, component) { renderComponents.push(component); return { options: _options, component } },
    }
    loader.apply({
      get: (name) => (name === 'slots' ? renderSlots : undefined),
      effect: (fn) => fn(),
      locale: { register() { return () => undefined }, bind() { return (key) => 'B:' + key } },
    })
    renderComponents[0]({
      sessionId: targetSessionId,
      open: () => undefined,
      actions: { fork() {}, rename() {}, archive() {}, unarchive() {} },
      readStores: () => undefined,
      useSessionStatus: (selector) => selector(new Map()),
      t: (key, params) => 'T:' + key + (params === undefined ? '' : JSON.stringify(params)),
    })
    return created
  }

  const rowCount = (nodes) => nodes.filter((node) => String(node.props.className ?? '').split(' ').includes('dfg__row')).length
  const labelsOf = (nodes) => nodes
    .filter((node) => String(node.props.className ?? '').includes('dfg__label'))
    .map((node) => node.children.join(''))
  const classesOf = (nodes) => nodes.map((node) => String(node.props.className ?? '')).join(' ')

  // a family with forks: panel, rows, fork label, root row
  let threw
  let drawn
  try {
    drawn = renderPanel(sessionId, false)
  } catch (error) {
    threw = error
  }
  check('component renders without throwing', threw === undefined, threw === undefined ? undefined : String(threw?.message ?? threw))
  check('render draws the panel', classesOf(drawn ?? []).includes('dfg__panel'))
  check('render draws one row per layout row', rowCount(drawn ?? []) > 2)
  check('render draws a fork label and a root label',
    labelsOf(drawn ?? []).includes('fork') && labelsOf(drawn ?? []).includes('root'),
    labelsOf(drawn ?? []).slice(0, 6).join(' | '))
  check('render produced a trigger', classesOf(drawn ?? []).includes('dfg__trigger'))

  // every string goes through the translate function the slot provides
  const titleNode = (drawn ?? []).find((node) => String(node.props.className ?? '') === 'dfg__title')
  check('render text comes from the dictionary', String(titleNode?.children.join('') ?? '').startsWith('T:panel.summary'),
    String(titleNode?.children.join('') ?? ''))

  // the rail answers with the row it is level with: the hover band spans the
  // whole body, so the highlighted row is visible across the rail too
  const railNodes = (drawn ?? []).filter((node) => String(node.props.className ?? '').includes('dfg__railwrap'))
  check('rail is an interactive band', railNodes.length === 1 && typeof railNodes[0].props.onClick === 'function'
    && typeof railNodes[0].props.onMouseMove === 'function')
  const calm = renderPanel(sessionId, false, undefined)
  check('no hover band without a hovered row', !classesOf(calm).includes('dfg__hover'))
  const hoveredRender = renderPanel(sessionId, false, 2)
  const band = hoveredRender.find((node) => String(node.props.className ?? '') === 'dfg__hover')
  check('hover band exists for the hovered row', band !== undefined)
  check('hover band sits on the hovered row', band?.props.style?.top === 10 + 2 * 32 && band?.props.style?.height === 32,
    JSON.stringify(band?.props.style))

  // a lone conversation still gets a panel: root + itself
  const loneId = Object.keys(payload.index).find((id) => {
    const family = payload.families[payload.index[id].family]
    return family?.all?.members === 1 && payload.index[id].archived !== true
  })
  check('payload has a lone conversation', loneId !== undefined, String(loneId))
  if (loneId !== undefined) {
    const lone = renderPanel(loneId, false)
    check('a lone conversation draws root plus itself', rowCount(lone) === 2, String(rowCount(lone)))
    check('a lone conversation keeps the archive toggle', classesOf(lone).includes('dfg__toggle'))
  }

  // an archived conversation is locked to the full tree
  const archivedId = Object.keys(payload.index).find((id) => payload.index[id].archived === true)
  check('payload has an archived conversation', archivedId !== undefined, String(archivedId))
  if (archivedId !== undefined) {
    const archived = renderPanel(archivedId, false)
    check('an archived conversation shows the locked marker', classesOf(archived).includes('dfg__locked'))
    check('an archived conversation has no archive toggle', !classesOf(archived).includes('dfg__toggle'))
    const family = payload.families[payload.index[archivedId].family]
    check('an archived conversation still draws its whole family', rowCount(archived) === family.all.rows.length,
      rowCount(archived) + ' vs ' + family.all.rows.length)
  }
}

if (failures.length === 0) {
  console.log('CHECKS OK — host published', data?.families?.length, 'families;', Object.keys(data?.index ?? {}).length, 'sessions indexed')
  process.exit(0)
}
console.error('CHECKS FAILED (' + failures.length + ')')
for (const failure of failures) console.error(' - ' + failure)
process.exit(1)

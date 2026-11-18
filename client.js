/**
 * dsh-fork-graph — Client half.
 *
 * One header action per conversation: a popover with the git-style lane graph of
 * the tree that conversation belongs to. The Host half computes the tree (event
 * bodies never reach the browser) and this file only draws it and navigates.
 *
 * The control renders nothing when the conversation has no tree: a family of one
 * session has nothing to show.
 */
window.__ModuleLoader__.load({
  id: 'dsh-fork-graph',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // geometry, mirroring the Host layout constants
    const ROW_H = 32
    const LANE_W = 20
    const PAD_TOP = 10
    /** Widest the popover may get, whatever the tree asks for. */
    const PANEL_MAX = 760
    /** Room the text columns need beside the rail, before a title's own width. */
    const TEXT_BASE = 268

    const PALETTE = ['#4d6bfe', '#e0724a', '#2fa27f', '#a969d9', '#d4a72c', '#3ba4c7', '#c7548c', '#7fa35c', '#a8874c', '#5a78c8']
    const laneColor = (lane) => PALETTE[lane % PALETTE.length]

    const ROUTE = '/plugins/dsh-fork-graph/lineage.json'
    const ROUTE_REBUILD = '/plugins/dsh-fork-graph/lineage-rebuild.json'
    const CACHE_MS = 15000
    const POLL_MS = CACHE_MS * 2
    /** How often an action retries the rebuild while the graph still looks unchanged. */
    const RETRY_MS = 700
    const RETRY_LIMIT = 8
    /** How often the client compares the session list with what the graph shows. */
    const NATIVE_POLL_MS = 1500

    // ---------------------------------------------------------------- text

    const NS = 'dsh-fork-graph'
    const MESSAGES = {
      zh: {
        'trigger.title': '会话分叉图',
        'trigger.sessions': '{n} 个会话',
        'trigger.aria': '会话分叉图：该会话所在的树共 {n} 个会话',
        'panel.label': '会话分叉图',
        'panel.summary': '{sessions} 个会话 · {lanes} 条轨道',
        'panel.showArchived': '显示已归档',
        'panel.hideArchived': '隐藏已归档',
        'panel.locked': '含已归档',
        'panel.lockedTitle': '当前会话已归档，始终显示完整树',
        'status.running': '运行中',
        'status.unread': '有新结果',
        'status.unavailable': '无法读取会话状态：当前客户端未提供会话状态接口（useSessionStatus），因此无法显示“运行中”与“有新结果”',
        'action.rename': '重命名',
        'action.fork': '分叉',
        'action.archive': '归档',
        'action.unarchive': '取消归档',
        'action.open': '打开会话：{title}',
        'rename.label': '会话标题',
        'archive.running': '会话正在运行，停止并归档？',
        'archive.stop': '停止并归档',
        'archive.cancel': '取消',
        'error.load': '无法读取分叉数据',
        'age.now': '刚刚',
      },
      en: {
        'trigger.title': 'Session fork graph',
        'trigger.sessions': '{n} sessions',
        'trigger.aria': 'Session fork graph: {n} conversations in this tree',
        'panel.label': 'Session fork graph',
        'panel.summary': '{sessions} sessions · {lanes} lanes',
        'panel.showArchived': 'Show archived',
        'panel.hideArchived': 'Hide archived',
        'panel.locked': 'Includes archived',
        'panel.lockedTitle': 'This conversation is archived, so the whole tree stays visible',
        'status.running': 'Running',
        'status.unread': 'New result',
        'status.unavailable': 'Session status is unavailable: this client provides no useSessionStatus hook, so Running and New result cannot be shown',
        'action.rename': 'Rename',
        'action.fork': 'Fork',
        'action.archive': 'Archive',
        'action.unarchive': 'Unarchive',
        'action.open': 'Open conversation: {title}',
        'rename.label': 'Conversation title',
        'archive.running': 'The conversation is running. Stop it and archive?',
        'archive.stop': 'Stop and archive',
        'archive.cancel': 'Cancel',
        'error.load': 'Could not read fork data',
        'age.now': 'now',
      },
    }

    const fill = (text, params) => (params === undefined
      ? text
      : text.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key]))))

    /** Stand-in used when the slot does not hand the component a translate function. */
    const fallbackT = (key, params) => fill(MESSAGES.en[key] ?? key, params)

    // ---------------------------------------------------------------- styles

    const STYLE_ID = 'dsh-fork-graph-style'
    // The panel is portalled to document.body, so both roots need box-sizing.
    const STYLESHEET = `
      .dfg,.dfg *{box-sizing:border-box}
      .dfg__panel,.dfg__panel *{box-sizing:border-box}
      .dfg{position:relative;display:inline-flex;align-items:center}
      .dfg__trigger{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5c6370);font:inherit;font-size:12px;line-height:1.4;cursor:pointer}
      .dfg__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2329)}
      .dfg__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}
      .dfg__panel{position:fixed;z-index:2147483000;max-height:min(70vh,560px);overflow-y:auto;overflow-x:hidden;padding:8px 0 4px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;--dfg-surface:var(--dsw-alias-bg-layer-1,#fff)}
      .dfg__head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px 6px 12px}
      .dfg__title{color:var(--dsw-alias-label-tertiary,#8b919b);font-size:11px}
      .dfg__toggle{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font:inherit;font-size:11px;cursor:pointer}
      .dfg__toggle:disabled{color:var(--dsw-alias-label-tertiary,#8b919b);cursor:default;opacity:.6}
      .dfg__locked{flex:none;padding:1px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-tertiary,#8b919b);font-size:11px;cursor:default}
      .dfg__body{position:relative;display:flex;align-items:stretch;min-width:0}
      .dfg__hover{position:absolute;left:0;right:0;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));pointer-events:none}
      .dfg__railwrap{flex:none;position:relative;display:flex;align-items:flex-start}
      .dfg__rail{flex:none;pointer-events:none}
      .dfg__rows{flex:1 1 auto;min-width:0;overflow:hidden;display:flex;flex-direction:column}
      .dfg__row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:0 10px 0 6px;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .dfg__row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:-2px}
      .dfg__row--static{cursor:default}
      .dfg__row--current{font-weight:600}
      .dfg__row--archived{opacity:.55}
      .dfg__row--busy{opacity:.55}
      .dfg__label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      .dfg__label--fork{color:var(--dsw-alias-label-tertiary,#9aa0aa);font-weight:600}
      .dfg__label--root{color:var(--dsw-alias-label-tertiary,#9aa0aa)}
      .dfg__status{flex:none;width:16px;display:flex;align-items:center;justify-content:center;overflow:hidden}
      .dfg__spin{flex:none;width:10px;height:10px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 26%,transparent);border-top-color:var(--dsw-alias-state-business-primary,#4d6bfe);animation:dfg-spin .9s linear infinite}
      @keyframes dfg-spin{to{transform:rotate(360deg)}}
      .dfg__dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe)}
      .dfg__statusIssue{flex:none;color:var(--dsw-alias-state-error-primary,#d9534f);font-size:10px;line-height:1;cursor:help}
      .dfg__events{flex:none;width:104px;overflow:hidden;white-space:nowrap;text-align:left;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#5c6370);font-size:11px}
      .dfg__age{flex:none;width:38px;text-align:right;color:var(--dsw-alias-label-tertiary,#9aa0aa);font-size:10px;font-variant-numeric:tabular-nums}
      .dfg__actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:2px;width:58px}
      .dfg__slot{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center}
      .dfg__action{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0aa);opacity:.45;cursor:pointer;transition:opacity .12s ease}
      .dfg__row:hover .dfg__action,.dfg__action:focus-visible{opacity:1}
      .dfg__action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#1f2329)}
      .dfg__action:disabled{opacity:.3;cursor:default}
      .dfg__rename{flex:1 1 auto;min-width:0;height:20px;padding:0 4px;border:1px solid var(--dsw-alias-state-business-primary,#4d6bfe);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;outline:none}
      .dfg__confirm{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));color:var(--dsw-alias-label-secondary,#5c6370);font-size:11px}
      .dfg__confirmButton{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font:inherit;font-size:11px;cursor:pointer}
      .dfg__confirmButton:first-of-type{border-color:var(--dsw-alias-state-warn-primary,#d4a72c);color:var(--dsw-alias-state-warn-primary,#d4a72c)}
      .dfg__error{padding:4px 12px 2px;color:var(--dsw-alias-state-error-primary,#d9534f);font-size:11px}
      .dfg__note{padding:6px 12px 2px;color:var(--dsw-alias-label-tertiary,#8b919b);font-size:10px}
    `

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = STYLESHEET
      document.head.appendChild(tag)
      return () => {
        const live = document.getElementById(STYLE_ID)
        if (live !== null) live.remove()
      }
    }

    // ---------------------------------------------------------------- data

    const cache = { data: undefined, at: 0, pending: undefined }

    /** Load the published lineage; `rebuild` asks the Host to recompute first. */
    function loadLineage(rebuild) {
      const forced = rebuild === true
      if (!forced && cache.data !== undefined && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.data)
      if (!forced && cache.pending !== undefined) return cache.pending
      const pending = fetch((forced ? ROUTE_REBUILD : ROUTE) + '?t=' + String(Date.now()), { credentials: 'same-origin' })
        .then((response) => {
          if (!response.ok) throw new Error('HTTP ' + String(response.status))
          return response.json()
        })
        .then((data) => {
          cache.data = data
          cache.at = Date.now()
          return data
        })
        .finally(() => { if (cache.pending === pending) cache.pending = undefined })
      cache.pending = pending
      return pending
    }

    function age(t, ms) {
      const minutes = Math.round(Math.max(0, Date.now() - ms) / 60000)
      if (minutes < 1) return t('age.now')
      if (minutes < 60) return String(minutes) + 'm'
      const hours = Math.round(minutes / 60)
      if (hours < 48) return String(hours) + 'h'
      return String(Math.round(hours / 24)) + 'd'
    }

    /** Width of a title at this font size: CJK glyphs are wider than latin ones. */
    function textWidth(text) {
      let width = 0
      for (const char of String(text)) width += /[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(char) ? 12 : 7
      return width
    }

    /**
     * A cheap fingerprint of everything the graph is derived from that the client
     * can see: the session list (ids, titles) and the archived set. Any change —
     * made from this panel or from DSH's own entry points — changes it.
     */
    function listSignature(sessions, archived) {
      if (sessions === undefined || sessions === null) return undefined
      const ids = Array.isArray(sessions.ids) ? sessions.ids : []
      const parts = ids.map((id) => {
        const row = sessions.byId?.[id]
        return id + '\u0000' + String(row?.displayTitle ?? row?.title ?? '') + (row?.blank === true ? '\u0001b' : '')
      })
      parts.push('\u0002' + (Array.isArray(archived) ? archived.join(',') : String(archived ?? '')))
      return parts.join('\u0003')
    }

    /**
     * The layout to draw. An archived conversation always shows the whole tree
     * and cannot hide archived rows; an active one follows the toggle. A family
     * of one simply draws root plus that session.
     */
    function pickLayout(data, sessionId, showArchived) {
      const entry = data?.index?.[sessionId]
      if (entry === undefined) return undefined
      const family = data.families[entry.family]
      if (family === undefined) return undefined
      const locked = entry.archived === true
      const layout = locked || showArchived || family.active === undefined ? family.all : family.active
      if (layout === undefined) return undefined
      return { family, layout, locked }
    }

    // ---------------------------------------------------------------- drawing

    const y = (index) => PAD_TOP + index * ROW_H + ROW_H / 2
    const x = (lane) => lane * LANE_W + LANE_W / 2
    const surface = 'var(--dfg-surface,#fff)'

    /** Rails first, then the curves that leave a fork point. */
    function railsOf(layout) {
      const rails = []
      const curves = []
      for (const segment of layout.segments) {
        const colour = laneColor(segment.lane)
        const top = y(segment.to)
        if (segment.elbow === undefined) {
          rails.push(`<path d="M ${x(segment.lane)} ${y(segment.from)} L ${x(segment.lane)} ${top}" stroke="${colour}" stroke-width="2" fill="none" stroke-linecap="round"/>`)
          continue
        }
        const fromX = x(segment.elbow.lane)
        const toX = x(segment.lane)
        const forkY = y(segment.elbow.row)
        const bend = Math.min(ROW_H * 0.66, Math.max(ROW_H * 0.4, (forkY - top) * 0.45))
        curves.push(`<path d="M ${fromX} ${forkY} C ${fromX} ${forkY - bend} ${toX} ${forkY - bend * 0.5} ${toX} ${forkY - bend} L ${toX} ${top}" stroke="${colour}" stroke-width="2" fill="none" stroke-linecap="round"/>`)
      }
      return rails.concat(curves)
    }

    /**
     * Session heads are hollow rings, fork points are solid dots, and a point
     * that is also a head is a ring with a core.
     */
    function markersOf(layout) {
      const markers = []
      for (const row of layout.rows) {
        const cx = x(row.kind === 'root' ? 0 : row.lane)
        const cy = y(row.index)
        const colour = laneColor(row.kind === 'root' ? 0 : row.lane)
        if (row.kind === 'root' || row.kind === 'fork') {
          markers.push(`<circle cx="${cx}" cy="${cy}" r="3.2" fill="${colour}" stroke="${surface}" stroke-width="1.6"/>`)
        } else if (row.kind === 'fork+head') {
          markers.push(`<circle cx="${cx}" cy="${cy}" r="4.5" fill="${surface}" stroke="${colour}" stroke-width="2"/>`)
          markers.push(`<circle cx="${cx}" cy="${cy}" r="1.7" fill="${colour}"/>`)
        } else {
          const opacity = row.archived === true ? '0.45' : '1'
          markers.push(`<circle cx="${cx}" cy="${cy}" r="4.5" fill="${surface}" stroke="${colour}" stroke-width="2" opacity="${opacity}"/>`)
        }
      }
      return markers
    }

    function Rail({ layout }) {
      const width = layout.lanes * LANE_W
      const height = PAD_TOP * 2 + layout.rows.length * ROW_H
      return h('svg', {
        className: 'dfg__rail',
        width,
        height,
        viewBox: '0 0 ' + width + ' ' + height,
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: railsOf(layout).concat(markersOf(layout)).join('') },
      })
    }

    // ---------------------------------------------------------------- row model

    const EVENTS_TEXT = (total, delta) => String(total) + (delta > 0 ? '  (+' + String(delta) + ')' : '')

    /** Everything one row renders, derived from the payload row plus live status. */
    function describeRow(t, row, sessionId, status) {
      if (row.kind === 'root') {
        return { label: 'root', className: 'dfg__label dfg__label--root', events: '', age: age(t, row.time) }
      }
      if (row.kind === 'fork') {
        return {
          label: 'fork',
          className: 'dfg__label dfg__label--fork',
          events: EVENTS_TEXT(row.prefix, row.delta),
          age: age(t, row.time),
        }
      }
      // status is authoritative and only comes from the client's status hook
      return {
        label: row.title,
        id: row.short,
        className: 'dfg__label',
        events: EVENTS_TEXT(row.total, row.delta),
        age: age(t, row.time),
        clickable: row.sessionId !== sessionId,
        sessionId: row.sessionId,
        archived: row.archived === true,
        running: status !== undefined && status.running === true,
        unread: status !== undefined && status.completionUnread === true,
      }
    }

    const GLYPHS = {
      rename: [h('path', { key: 'p', d: 'M9.4 2.1l2.5 2.5-6.7 6.7-3 .5.5-3z' })],
      fork: [
        h('circle', { key: 'a', cx: 4, cy: 3, r: 1.5 }),
        h('circle', { key: 'b', cx: 4, cy: 11, r: 1.5 }),
        h('circle', { key: 'c', cx: 10, cy: 6.5, r: 1.5 }),
        h('path', { key: 'd', d: 'M4 4.5v5' }),
        h('path', { key: 'e', d: 'M4 6.5h3.2A1.8 1.8 0 0 0 9 4.7v.3' }),
      ],
      archive: [
        h('path', { key: 'a', d: 'M2 4.2h10' }),
        h('path', { key: 'b', d: 'M3 4.2V11.5h8V4.2' }),
        h('path', { key: 'c', d: 'M5.4 7.4h3.2' }),
      ],
      unarchive: [
        h('path', { key: 'a', d: 'M2 4.2h10' }),
        h('path', { key: 'b', d: 'M3 4.2V11.5h8V4.2' }),
        h('path', { key: 'c', d: 'M7 11V7.8' }),
        h('path', { key: 'd', d: 'M5.5 9.3L7 7.8l1.5 1.5' }),
      ],
    }

    /** One icon action; it must never fall through to the row's open handler. */
    function iconButton(key, label, glyph, onClick) {
      return h('button', {
        key,
        type: 'button',
        className: 'dfg__action',
        title: label,
        'aria-label': label,
        onClick: (event) => {
          event.stopPropagation()
          event.preventDefault()
          onClick()
        },
      }, h('svg', {
        width: 13,
        height: 13,
        viewBox: '0 0 14 14',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, glyph))
    }

    const slot = (key, node) => h('span', { key, className: 'dfg__slot' }, node)

    // ---------------------------------------------------------------- component

    /** Stand-in when the surrounding Client exposes no such hook. */
    const noHook = () => undefined
    /** A standard slot prop when present, else a hook that selects nothing. */
    const hookOf = (props, name) => (typeof props[name] === 'function' ? props[name] : noHook)

    function ForkGraph(props) {
      const { sessionId, open, actions, readStores } = props
      // the slot hands over `t` once a locale namespace is declared; the bound
      // translator keeps working even if that prop is missing, and any failure
      // inside the runtime falls back to the built-in dictionary
      const translate = typeof props.t === 'function'
        ? props.t
        : (typeof props.boundT === 'function' ? props.boundT : fallbackT)
      const t = (key, params) => {
        try {
          const text = translate(key, params)
          return typeof text === 'string' && text !== '' ? text : fallbackT(key, params)
        } catch {
          return fallbackT(key, params)
        }
      }
      const statusMap = hookOf(props, 'useSessionStatus')((state) => state)

      const [data, setData] = useState(undefined)
      const [failed, setFailed] = useState(false)
      const [showArchived, setShowArchived] = useState(false)
      const [openPanel, setOpenPanel] = useState(false)
      const [position, setPosition] = useState(undefined)
      const [editing, setEditing] = useState(undefined)
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(undefined)
      const [stopRequest, setStopRequest] = useState(undefined)
      const [error, setError] = useState(undefined)
      /** Row index under the pointer, so the highlight spans the rail too. */
      const [hovered, setHovered] = useState(undefined)

      const rootRef = useRef(undefined)
      const triggerRef = useRef(undefined)
      const panelRef = useRef(undefined)
      const renameGuard = useRef(undefined)

      const applyData = useCallback((next) => {
        setData(next)
        setFailed(false)
      }, [])

      const refresh = useCallback((rebuild) => {
        loadLineage(rebuild).then(applyData, () => { setFailed(true) })
      }, [applyData])

      /**
       * Redraw right after an action. The mutation reaches the logs a moment
       * after the RPC resolves, so an immediate rebuild can still describe the
       * old state; retry until the payload actually changes.
       */
      const refreshAfterAction = useCallback(() => {
        const before = cache.data === undefined ? '' : JSON.stringify(cache.data.families)
        let attempt = 0
        let timer
        const tick = () => {
          attempt += 1
          loadLineage(true).then((next) => {
            applyData(next)
            if (JSON.stringify(next.families) === before && attempt < RETRY_LIMIT) timer = setTimeout(tick, RETRY_MS)
          }, () => {
            if (attempt < RETRY_LIMIT) timer = setTimeout(tick, RETRY_MS)
          })
        }
        tick()
        return () => { clearTimeout(timer) }
      }, [applyData])

      useEffect(() => {
        refresh(false)
        const timer = setInterval(() => { refresh(false) }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [refresh])

      // opening always rebuilds, so a change made elsewhere is never stale
      useEffect(() => {
        if (!openPanel) return undefined
        refresh(true)
        return undefined
      }, [openPanel, refresh])

      // A conversation the payload does not know yet (a fresh fork, or the first
      // frame after a restart) would otherwise look like it has no tree.
      const askedFor = useRef(undefined)
      useEffect(() => {
        if (data === undefined) return
        if (data.index?.[sessionId] !== undefined) return
        if (askedFor.current === sessionId) return
        askedFor.current = sessionId
        refreshAfterAction()
      }, [data, sessionId, refreshAfterAction])

      // an archived conversation starts with archived sessions visible
      useEffect(() => {
        if (data?.index?.[sessionId]?.archived === true) setShowArchived(true)
      }, [data, sessionId])

      const picked = useMemo(
        () => (data === undefined ? undefined : pickLayout(data, sessionId, showArchived)),
        [data, sessionId, showArchived],
      )

      // Grow the panel with the tree: a column per lane plus room for the
      // longest title, so titles are not clipped.
      const desiredWidth = useMemo(() => {
        if (picked === undefined) return 420
        const longest = picked.layout.rows.reduce((width, row) => Math.max(width, textWidth(row.title ?? '')), 0)
        return picked.layout.lanes * LANE_W + Math.min(640, Math.max(300, longest + TEXT_BASE))
      }, [picked])

      const place = useCallback((wanted) => {
        const trigger = triggerRef.current
        if (trigger === undefined || trigger === null) return
        const rect = trigger.getBoundingClientRect()
        const width = Math.min(PANEL_MAX, Math.max(420, wanted), window.innerWidth - 16)
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
        setPosition({ left, top: rect.bottom + 6, width })
      }, [])

      useEffect(() => {
        if (!openPanel) return undefined
        place(desiredWidth)
        const onViewport = () => place(desiredWidth)
        window.addEventListener('scroll', onViewport, true)
        window.addEventListener('resize', onViewport)
        return () => {
          window.removeEventListener('scroll', onViewport, true)
          window.removeEventListener('resize', onViewport)
        }
      }, [openPanel, place, desiredWidth])

      useEffect(() => {
        if (!openPanel) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (rootRef.current?.contains(target) === true) return
          if (panelRef.current?.contains(target) === true) return
          setOpenPanel(false)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setOpenPanel(false)
          if (triggerRef.current !== null) triggerRef.current.focus()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [openPanel])

      // A change made through DSH's own entry points (new fork, rename, archive)
      // reaches the client stores before it reaches the logs. Poll the stores
      // instead of subscribing: the graph only needs a coarse "something moved".
      useEffect(() => {
        if (typeof readStores !== 'function') return undefined
        let previous
        const read = () => {
          try {
            const stores = readStores()
            const sessions = stores?.sessions?.list?.getSnapshot?.()
            const workspaces = stores?.workspaces?.workspaces?.list?.getSnapshot?.()
            return listSignature(sessions, workspaces?.archivedSessionIds)
          } catch {
            return undefined
          }
        }
        previous = read()
        const timer = setInterval(() => {
          const next = read()
          if (next === undefined || next === previous) return
          previous = next
          refreshAfterAction()
        }, NATIVE_POLL_MS)
        return () => { clearInterval(timer) }
      }, [readStores, refreshAfterAction])

      /** Run one session action, then redraw; a refused archive asks first. */
      const run = useCallback((sessionId_, work) => {
        if (actions === undefined) return
        setBusy(sessionId_)
        setError(undefined)
        Promise.resolve()
          .then(work)
          .then(() => { refreshAfterAction() }, (reason) => {
            if (reason !== null && typeof reason === 'object' && reason.code === 'workspace/session-active') {
              setStopRequest({ sessionId: sessionId_ })
              return
            }
            setError(String(reason?.message ?? reason))
          })
          .finally(() => { setBusy(undefined) })
      }, [actions, refreshAfterAction])

      // no tree for this conversation (or no data yet): no control
      if (picked === undefined) return null

      const { layout, locked } = picked
      const hasStatusHook = typeof props.useSessionStatus === 'function'

      const commitRename = () => {
        const target = editing
        if (target === undefined || renameGuard.current === target) {
          setEditing(undefined)
          return
        }
        renameGuard.current = target
        const title = draft.trim()
        setEditing(undefined)
        if (title === '') return
        run(target, () => actions.rename(target, title))
      }

      /** One row: status marker, title (or rename input), counters, then actions. */
      const renderRow = (row) => {
        const text = describeRow(t, row, sessionId, statusMap?.get(row.sessionId))
        const renaming = editing !== undefined && editing === row.sessionId
        const archived = text.archived === true
        const forkFrom = row.forkFrom ?? (row.sessionId === undefined ? undefined : { sessionId: row.sessionId })
        const openable = text.clickable === true && !renaming
        const classes = ['dfg__row']
        if (!openable) classes.push('dfg__row--static')
        if (archived) classes.push('dfg__row--archived')
        if (row.sessionId === sessionId) classes.push('dfg__row--current')
        if (busy !== undefined && busy === row.sessionId) classes.push('dfg__row--busy')

        const statusCell = []
        if (text.running === true) {
          statusCell.push(h('span', { key: 'run', className: 'dfg__spin', role: 'img', 'aria-label': t('status.running'), title: t('status.running') }))
        } else if (text.unread === true) {
          statusCell.push(h('span', { key: 'new', className: 'dfg__dot', role: 'img', 'aria-label': t('status.unread'), title: t('status.unread') }))
        } else if (!hasStatusHook && row.sessionId !== undefined) {
          statusCell.push(h('span', {
            key: 'issue',
            className: 'dfg__statusIssue',
            role: 'img',
            'aria-label': t('status.unavailable'),
            title: t('status.unavailable'),
          }, '\u2715'))
        }

        // three fixed slots in every row: a missing action leaves an aligned gap
        const actionsCell = [
          slot('rename', row.sessionId !== undefined && !renaming
            ? iconButton('rename', t('action.rename'), GLYPHS.rename, () => {
              renameGuard.current = undefined
              setDraft(text.label)
              setEditing(row.sessionId)
            })
            : null),
          slot('fork', row.kind !== 'root' && forkFrom !== undefined
            ? iconButton('fork', t('action.fork'), GLYPHS.fork, () => {
              setOpenPanel(false)
              run(forkFrom.sessionId, () => actions.fork(forkFrom.sessionId, forkFrom.atSeq))
            })
            : null),
          slot('archive', row.sessionId !== undefined
            ? iconButton('archive', archived ? t('action.unarchive') : t('action.archive'), archived ? GLYPHS.unarchive : GLYPHS.archive, () => {
              if (archived) run(row.sessionId, () => actions.unarchive(row.sessionId))
              else run(row.sessionId, () => actions.archive(row.sessionId, false))
            })
            : null),
        ]

        return h('div', {
          key: String(row.index),
          className: classes.join(' '),
          style: { height: ROW_H },
          onMouseEnter: () => { setHovered(row.index) },
          role: openable ? 'button' : undefined,
          tabIndex: openable ? 0 : undefined,
          title: openable ? t('action.open', { title: text.label }) + (text.id === undefined ? '' : ' \u00b7 ' + text.id) : undefined,
          onClick: openable ? () => { setOpenPanel(false); open(text.sessionId) } : undefined,
          onKeyDown: openable
            ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setOpenPanel(false)
              open(text.sessionId)
            }
            : undefined,
        },
        h('span', { key: 'status', className: 'dfg__status' }, statusCell),
        renaming
          ? h('input', {
            key: 'label',
            className: 'dfg__rename',
            value: draft,
            autoFocus: true,
            spellCheck: false,
            'aria-label': t('rename.label'),
            onChange: (event) => { setDraft(event.target.value) },
            onClick: (event) => { event.stopPropagation() },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                renameGuard.current = row.sessionId
                setEditing(undefined)
              }
            },
            onBlur: () => { commitRename() },
          })
          : h('span', { key: 'label', className: text.className }, text.label),
        h('span', { key: 'events', className: 'dfg__events' }, text.events),
        h('span', { key: 'age', className: 'dfg__age' }, text.age),
        h('span', { key: 'actions', className: 'dfg__actions' }, actionsCell))
      }
      const rows = layout.rows.map(renderRow)

      const head = h('div', { className: 'dfg__head' },
        h('span', { className: 'dfg__title' },
          t('panel.summary', { sessions: layout.members, lanes: layout.lanes })),
        // an archived conversation always shows the full tree: nothing to toggle
        locked
          ? h('span', {
            className: 'dfg__locked',
            title: t('panel.lockedTitle'),
          }, t('panel.locked'))
          : h('button', {
            type: 'button',
            className: 'dfg__toggle',
            onClick: () => { setShowArchived((value) => !value) },
          }, showArchived ? t('panel.hideArchived') : t('panel.showArchived')))

      /** The row a pointer event on the rail is level with. */
      const rowIndexAt = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const index = Math.floor((event.clientY - rect.top - PAD_TOP) / ROW_H)
        if (index < 0 || index >= layout.rows.length) return undefined
        return index
      }
      const hoveredRow = hovered === undefined ? undefined : layout.rows[hovered]
      const hoverOpenable = hoveredRow !== undefined
        && hoveredRow.sessionId !== undefined
        && hoveredRow.sessionId !== sessionId

      const body = h('div', {
        className: 'dfg__body',
        onMouseLeave: () => { setHovered(undefined) },
      },
      hovered === undefined ? null : h('div', {
        className: 'dfg__hover',
        style: { top: PAD_TOP + hovered * ROW_H, height: ROW_H },
      }),
      h('div', {
        className: 'dfg__railwrap',
        style: {
          width: layout.lanes * LANE_W,
          height: PAD_TOP * 2 + layout.rows.length * ROW_H,
          cursor: hoverOpenable ? 'pointer' : 'default',
        },
        // the rail answers with the row it is level with, so a click on a complex
        // graph behaves exactly like a click on that row
        onMouseMove: (event) => {
          const index = rowIndexAt(event)
          if (index !== undefined) setHovered(index)
        },
        onMouseLeave: () => { setHovered(undefined) },
        onClick: (event) => {
          const index = rowIndexAt(event)
          if (index === undefined) return
          const target = layout.rows[index]
          if (target.sessionId === undefined || target.sessionId === sessionId) return
          setOpenPanel(false)
          open(target.sessionId)
        },
      }, h(Rail, { layout })),
      h('div', { className: 'dfg__rows', style: { paddingTop: PAD_TOP, paddingBottom: PAD_TOP } }, rows))

      const stopStrip = stopRequest === undefined ? null : h('div', { className: 'dfg__confirm' },
        h('span', null, t('archive.running')),
        h('button', {
          type: 'button',
          className: 'dfg__confirmButton',
          onClick: () => {
            const target = stopRequest.sessionId
            setStopRequest(undefined)
            run(target, () => actions.archive(target, true))
          },
        }, t('archive.stop')),
        h('button', {
          type: 'button',
          className: 'dfg__confirmButton',
          onClick: () => { setStopRequest(undefined) },
        }, t('archive.cancel')))

      const panelNode = h('div', {
        ref: panelRef,
        className: 'dfg__panel',
        role: 'dialog',
        'aria-label': t('panel.label'),
        style: { left: position?.left, top: position?.top, width: position?.width },
      }, head, body, stopStrip,
      error === undefined ? null : h('div', { className: 'dfg__error' }, error),
      failed ? h('div', { className: 'dfg__note' }, t('error.load')) : null)

      const panel = position === undefined ? null : ReactDOM.createPortal(panelNode, document.body)

      return h('div', { ref: rootRef, className: 'dfg' },
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dfg__trigger',
          'aria-expanded': openPanel,
          'aria-haspopup': 'dialog',
          'aria-label': t('trigger.aria', { n: layout.members }),
          title: t('trigger.title'),
          onClick: () => { setPosition(undefined); setOpenPanel((value) => !value) },
        },
        h('svg', { width: 13, height: 13, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': 'true' },
          h('circle', { cx: 4, cy: 3, r: 1.6 }),
          h('circle', { cx: 4, cy: 11, r: 1.6 }),
          h('circle', { cx: 10.5, cy: 7, r: 1.6 }),
          h('path', { d: 'M4 4.6v4.8' }),
          h('path', { d: 'M4 7h3.2a1.8 1.8 0 0 0 1.8-1.8V8.6' })),
        h('span', null, t('trigger.sessions', { n: layout.members }))),
        openPanel ? panel : null)
    }

    // ---------------------------------------------------------------- plugin body

    /** Open a session in the workspace view, with the legacy fallback. */
    function makeOpen(ctx) {
      return (id) => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace !== undefined && workspace !== null && typeof workspace.openSession === 'function') {
          workspace.openSession(id)
          return
        }
        const sessions = ctx.get('sessions')
        if (sessions !== undefined && sessions !== null && typeof sessions.open === 'function') {
          sessions.open(id)
        }
      }
    }

    /**
     * The same native calls the session list uses: `sessions.fork` (which takes
     * an exact inclusive `atSeq`, i.e. "branch from this point"),
     * `sessions.using(...).rename`, and the workspace archive pair.
     */
    function makeActions(ctx, open) {
      const workspace = () => ctx.get('uiWorkspace')
      const sessions = () => ctx.get('sessions')
      return {
        async fork(sessionId, atSeq) {
          const onCreated = (childId) => { open(childId) }
          const store = sessions()
          if (store !== undefined && store !== null && typeof store.fork === 'function') {
            await store.fork({
              sessionId,
              increaseTitle: true,
              ...(atSeq === undefined ? {} : { atSeq }),
              onCreated,
            })
            return
          }
          const ui = workspace()
          if (ui !== undefined && ui !== null && typeof ui.forkSession === 'function') ui.forkSession(sessionId, onCreated)
        },
        async rename(sessionId, title) {
          const store = sessions()
          if (store === undefined || store === null || typeof store.using !== 'function') throw new Error('rename unavailable')
          const result = await store.using(sessionId, { source: 'workspaceOperation' }, (reference) => reference.binding.session.rename(title))
          if (result !== undefined && result !== null && result.ok === false) {
            throw new Error(result.error?.message ?? 'rename failed')
          }
        },
        async archive(sessionId, stopActivity) {
          const ui = workspace()
          if (ui === undefined || ui === null) throw new Error('archive unavailable')
          await ui.archiveSession(sessionId, stopActivity === true ? { stopActivity: true } : undefined)
        },
        async unarchive(sessionId) {
          const ui = workspace()
          if (ui === undefined || ui === null) throw new Error('unarchive unavailable')
          await ui.unarchiveSession(sessionId)
        },
      }
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return
      // localization is best effort: nothing here may prevent the control itself
      try {
        ctx.effect(() => ctx.locale.register(NS, MESSAGES), 'dsh-fork-graph: dictionaries')
      } catch (error) {
        console.warn('[dsh-fork-graph] dictionary registration failed:', error)
      }
      let boundT
      try {
        boundT = ctx.locale.bind(NS)
      } catch (error) {
        console.warn('[dsh-fork-graph] locale binding failed:', error)
      }
      ctx.effect(() => installStyles(), 'dsh-fork-graph: stylesheet')
      const open = makeOpen(ctx)
      const actions = makeActions(ctx, open)
      /** Read the two client stores lazily: they may compose after this plugin. */
      const readStores = () => ({ sessions: ctx.get('sessions'), workspaces: ctx.get('uiWorkspace') })
      const options = {
        name: 'conversation.session.header.actions',
        id: 'fork-graph',
        order: 15,
        registrant: 'dsh-fork-graph',
        inject: (sessionId) => ({ sessionId, open, actions, readStores, boundT }),
      }
      slots.inject('conversation.session.header.actions', () => {
        // a locale-scoped registration is what makes the slot hand over `t`; when
        // that is unsupported, the plain registration still draws the control
        try {
          return slots.register({ ...options, locale: NS }, ForkGraph)
        } catch (error) {
          console.warn('[dsh-fork-graph] locale-scoped registration failed:', error)
          return slots.register(options, ForkGraph)
        }
      })
    }

    return {
      name: 'dsh-fork-graph',
      // `locale` is required to reach ctx.locale; every shipped client provides it
      inject: ['slots', 'locale'],
      apply,
    }
  },
})

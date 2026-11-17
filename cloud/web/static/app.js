// Quotabar 网站：概览、会话、会话详情、统计、设备。
// 不用框架：页面开着时每分钟拉一次接口，每 30 秒按缓存重画一次（相对时间会变）。
'use strict'

// ---------- 小工具 ----------

/** el('div', {class: 'x', text: '…', onclick}, ...children) */
function el(tag, props, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else if (k === 'style') e.style.cssText = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c)
  return e
}

const SVG = 'http://www.w3.org/2000/svg'
function svg(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v)
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c)
  return e
}

const pad = (n) => String(n).padStart(2, '0')
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
const sameDay = (a, b) => startOfDay(a) === startOfDay(b)
const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function fmtTokens(n) {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

/** 和 Mac 端一样的紧凑写法：4天9小时 / 1小时9分 / 24分钟 */
function duration(ms) {
  const total = Math.round(Math.max(ms, 0) / 1000)
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`
  if (m > 0) return `${m}分钟`
  return '不到1分钟'
}

function ago(t, now) {
  if (!t) return '从未'
  const m = Math.round((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}

/** 重置时间：今天 13:49 / 明天 02:59 / 本周日 03:00 / 下周一 03:00 / 11月30日 周日 03:00 */
function resetMoment(t, now) {
  if (sameDay(t, now)) return '今天 ' + hm(t)
  if (sameDay(t, now + 86400000)) return '明天 ' + hm(t)
  const d = new Date(t)
  const days = Math.round((startOfDay(t) - startOfDay(now)) / 86400000)
  if (days > 0 && days < 7) {
    const monday = (x) => { const s = startOfDay(x), wd = (new Date(s).getDay() + 6) % 7; return s - wd * 86400000 }
    return (monday(t) === monday(now) ? '本周' : '下周') + WEEK[d.getDay()] + ' ' + hm(t)
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]} ${hm(t)}`
}

/** claude-opus-5-5 → Opus 5.5 */
function modelName(id) {
  if (!id) return ''
  const parts = id.split('-')
  if (parts[0] === 'claude') parts.shift()
  if (/^\d{8}$/.test(parts[parts.length - 1] || '')) parts.pop()
  if (!parts.length) return id
  const fam = parts[0][0].toUpperCase() + parts[0].slice(1)
  return parts.length > 1 ? `${fam} ${parts.slice(1).join('.')}` : fam
}

function level(p, severity) {
  if (severity === 'critical' || p >= 90) return { name: '接近上限', key: 'crit', rank: 2 }
  if (severity === 'warning' || p >= 75) return { name: '用量偏高', key: 'warn', rank: 1 }
  return { name: '健康', key: 'ok', rank: 0 }
}

function limitTitle(l) {
  if (l.kind === 'session') return '当前会话 · 5 小时'
  if (l.kind === 'weekly_all') return '本周 · 所有模型'
  if (l.kind === 'weekly_scoped') return '本周 · ' + (l.scope || '指定范围')
  return l.title || l.kind
}

/** 额度窗口长度：用来画“时间进度”刻度，和 Mac 端一样 */
const WINDOW = { session: 5 * 3600000, weekly_all: 7 * 86400000, weekly_scoped: 7 * 86400000 }

// 状态：圆点 + 文字。已完成最常见，所以最安静；执行中和等待授权要醒目
const STATUS = {
  running: ['执行中', 'live'],
  waiting: ['等待授权', 'warn'],
  done: ['已完成', 'done'],
  idle: ['空闲', 'quiet'],
  ended: ['已结束', 'quiet'],
  offline: ['离线', 'quiet'],
}
const statusTag = (s) => { const [t, c] = STATUS[s] || [s, 'quiet']; return el('span', { class: 'st st-' + c }, el('i', { 'aria-hidden': 'true' }), t) }
const isLive = (s) => s.status === 'running' || s.status === 'waiting'
const totalTokens = (s) => (s.tokens_in || 0) + (s.tokens_out || 0) + (s.tokens_cache_read || 0) + (s.tokens_cache_write || 0)

/** 列表已经按天分组，这里只写时刻；跨天才带日期 */
function sessionTime(s, now) {
  if (isLive(s)) return `${hm(s.started_at)} 起 · ${duration(now - s.started_at)}`
  const a = s.started_at, b = s.last_activity_at
  return sameDay(a, b) ? `${hm(a)}–${hm(b)}` : `${md(a)} ${hm(a)}–${hm(b)}`
}

function dayLabel(t, now) {
  if (sameDay(t, now)) return '今天'
  if (sameDay(t, now - 86400000)) return '昨天'
  const d = new Date(t)
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`
}

// ---------- 接口 ----------

class Unauthorized extends Error {}

async function api(path, opts) {
  const res = await fetch(path, opts)
  if (res.status === 401) throw new Unauthorized()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ---------- 状态 ----------

const state = {
  me: null,
  overview: null,
  overviewFilter: 'all',
  usageDevice: null,          // 多台 Mac 时选哪台的额度
  sessions: { key: '', list: [], next: null, status: '', device: '' },
  detail: null,
  stats: null, statsDays: 30,
  devices: null,
  error: null,
}

function route() {
  const h = location.hash.replace(/^#\/?/, '')
  const [name, id] = h.split('/')
  if (name === 'sessions' && id) return { name: 'detail', id: decodeURIComponent(id) }
  if (['sessions', 'stats', 'devices'].includes(name)) return { name }
  return { name: 'overview' }
}

// ---------- 渲染 ----------

const view = document.getElementById('view')

function render() {
  const r = route()
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === (r.name === 'detail' ? 'sessions' : r.name)
    a.classList.toggle('on', on)
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  })
  const now = Date.now()
  let content
  switch (r.name) {
    case 'overview': content = renderOverview(now); break
    case 'sessions': content = renderSessions(now); break
    case 'detail': content = renderDetail(now); break
    case 'stats': content = renderStats(); break
    case 'devices': content = renderDevices(now); break
  }
  view.replaceChildren(...[state.error && el('div', { class: 'notice', text: state.error }), content].flat().filter(Boolean))
}

function loading() { return el('div', { class: 'empty', text: '正在加载…' }) }

function chips(options, current, onPick) {
  return el('div', { class: 'chips', role: 'group' }, options.map(([k, t, n]) => el('button', {
    class: 'chip' + (current === k ? ' on' : ''), type: 'button', 'aria-pressed': String(current === k),
    onclick: () => onPick(k),
  }, t, n ? el('span', { class: 'n', text: String(n) }) : null)))
}

// 概览

function renderOverview(now) {
  const o = state.overview
  if (!o) return loading()
  const out = []
  const usage = o.usage.find((u) => u.device_id === state.usageDevice) || o.usage[0]

  const worst = usage && usage.limits.map((l) => level(l.percent, l.severity)).sort((a, b) => b.rank - a.rank)[0]
  const plan = usage?.plan ? usage.plan[0].toUpperCase() + usage.plan.slice(1).toLowerCase() : null
  out.push(el('div', { class: 'head' },
    el('div', { class: 'title' },
      el('h1', { text: 'Claude 用量' }),
      plan && el('span', { class: 'plan', text: plan }),
      worst && el('span', { class: 'health h-' + worst.key, text: worst.name })),
    usage && el('div', { class: 'sub muted', text: `${now - usage.fetched_at < 3600000 ? hm(usage.fetched_at) : ago(usage.fetched_at, now)} 上报` })))
  if (o.usage.length > 1) {
    out.push(chips(o.usage.map((u) => [u.device_id, u.device_name]), usage.device_id, (k) => { state.usageDevice = k; render() }))
  }

  if (usage) out.push(el('section', { class: 'limits' }, usage.limits.map((l) => limitCard(l, now))))
  out.push(devicesStrip(o, now))

  if (!o.usage.length && !o.sessions.length) {
    out.push(el('div', { class: 'notice', text: '还没有 Mac 上报数据。在 Mac 上的 Quotabar 右上角登录，并在设置里打开“上报额度和会话”，额度和会话就会出现在这里。' }))
  }

  // 会话：按状态筛选
  const counts = { running: 0, waiting: 0, offline: 0 }
  for (const s of o.sessions) if (s.status in counts) counts[s.status]++
  const filters = [['all', '全部'], ['running', '执行中', counts.running], ['waiting', '等待授权', counts.waiting], ['done', '已完成']]
  if (counts.offline) filters.push(['offline', '离线', counts.offline])
  const list = state.overviewFilter === 'all' ? o.sessions : o.sessions.filter((s) => s.status === state.overviewFilter)
  out.push(el('section', {},
    el('div', { class: 'head' },
      el('h2', { text: '最近的会话' }),
      chips(filters, state.overviewFilter, (k) => { state.overviewFilter = k; render() })),
    sessionList(list, now),
    o.sessions.length >= 30 && el('a', { class: 'link more', href: '#/sessions', text: '查看全部会话' })))
  return out
}

function limitCard(l, now) {
  const lv = level(l.percent, l.severity)
  const p = Math.round(l.percent)
  const win = WINDOW[l.kind]
  const elapsed = win && l.resets_at ? Math.min(Math.max(1 - (l.resets_at - now) / win, 0), 1) : null
  return el('div', { class: 'limit l-' + lv.key },
    el('div', { class: 'label', text: limitTitle(l) }),
    el('div', { class: 'big' }, String(p), el('small', { text: '%' })),
    el('div', { class: 'meter', role: 'img', 'aria-label': `已用 ${p}%，${lv.name}` + (elapsed != null ? `；时间过了 ${Math.round(elapsed * 100)}%` : '') },
      el('div', { class: 'fill', style: `width:${Math.min(p, 100)}%` }),
      elapsed != null && el('span', { class: 'tick', style: `left:${elapsed * 100}%`, title: `时间过了 ${Math.round(elapsed * 100)}%` })),
    l.resets_at && el('div', { class: 'reset' },
      el('b', { text: resetMoment(l.resets_at, now) + ' 重置' }),
      el('span', { text: l.resets_at > now ? `还有 ${duration(l.resets_at - now)}` : '等待 Mac 刷新' })))
}

/** 每台 Mac 一个小胶囊：在线圆点 + 名字 + 状态 */
function devicesStrip(o, now) {
  if (!o.devices.length) return null
  const live = {}
  for (const s of o.sessions) if (isLive(s)) live[s.device_id] = (live[s.device_id] || 0) + 1
  return el('div', { class: 'devices' }, o.devices.map((d) => el('div', { class: 'devchip' },
    el('span', { class: 'dot' + (d.online ? ' on' : ''), 'aria-hidden': 'true' }),
    el('b', { text: d.name }),
    el('span', { class: 'muted', text: (d.online ? '在线' : '离线，' + ago(d.last_seen_at, now)) + (live[d.id] ? `，${live[d.id]} 个会话进行中` : '') }))))
}

/** 按天分组的会话列表，整行可点。只有一台 Mac 时不显示设备名 */
function sessionList(list, now) {
  if (!list.length) return el('div', { class: 'empty', text: '没有会话' })
  const multi = (state.overview?.devices.length || 0) > 1
  const groups = []
  for (const s of list) {
    // 进行中的会话归到今天
    const key = startOfDay(isLive(s) ? now : s.last_activity_at)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) groups.push(g = { key, items: [] })
    g.items.push(s)
  }
  return el('div', { class: 'list' }, groups.map((g) => el('div', { class: 'group' },
    el('div', { class: 'day' },
      el('b', { text: dayLabel(g.key, now) }),
      el('span', { class: 'num', text: `${g.items.length} 个会话，${fmtTokens(g.items.reduce((a, s) => a + totalTokens(s), 0))}` })),
    g.items.map((s) => sessionRow(s, now, multi)))))
}

function sessionRow(s, now, multi) {
  const meta = [s.title ? s.project : null, modelName(s.model), multi ? s.device_name : null].filter(Boolean)
  return el('a', { class: 'srow s-' + s.status, href: '#/sessions/' + encodeURIComponent(s.id) },
    statusTag(s.status),
    el('div', { class: 'main' },
      el('div', { class: 't', text: s.title || s.project }),
      el('div', { class: 'meta' }, meta.map((m) => el('span', { text: m })), s.status_detail && el('span', { class: 'detail', text: s.status_detail }))),
    el('div', { class: 'side' },
      el('div', { class: 'tok num', text: fmtTokens(totalTokens(s)) }),
      el('div', { class: 'when num', text: sessionTime(s, now) })))
}

// 会话列表

const SESSION_FILTERS = [['', '全部'], ['running', '执行中'], ['waiting', '等待授权'], ['done', '已完成'], ['idle', '空闲'], ['ended', '已结束']]

function renderSessions(now) {
  const st = state.sessions
  const macs = state.overview ? state.overview.devices : []
  return el('section', {},
    el('div', { class: 'head' },
      el('h1', { text: '会话' }),
      chips(SESSION_FILTERS, st.status, (k) => { st.status = k; loadSessions() })),
    macs.length > 1 && chips([['', '所有设备'], ...macs.map((d) => [d.id, d.name])], st.device, (k) => { st.device = k; loadSessions() }),
    st.key !== sessionsKey() ? loading() : sessionList(st.list, now),
    st.next && el('button', { class: 'btn secondary small more', type: 'button', text: '加载更多', onclick: () => loadSessions(true) }))
}

const sessionsKey = () => `${state.sessions.status}|${state.sessions.device}`

async function loadSessions(more) {
  const st = state.sessions
  const key = sessionsKey()
  if (!more && st.key !== key) { st.list = []; st.next = null; st.key = ''; render() }
  const q = new URLSearchParams()
  if (st.status) q.set('status', st.status)
  if (st.device) q.set('device', st.device)
  if (more && st.next) q.set('cursor', st.next)
  const r = await api('/api/sessions?' + q)
  if (sessionsKey() !== key) return   // 等待期间换了筛选
  st.list = more ? st.list.concat(r.sessions) : r.sessions
  st.next = r.next_cursor
  st.key = key
  render()
}

// 会话详情

function renderDetail(now) {
  const d = state.detail
  if (!d || d.session.id !== route().id) return loading()
  const s = d.session
  const t = { in: s.tokens_in, out: s.tokens_out, cr: s.tokens_cache_read, cw: s.tokens_cache_write }
  const rows = [
    ['项目', s.project],
    ['设备', s.device_name || '—'],
    ['模型', modelName(s.model) || '—'],
    ['状态', s.status_detail ? `${(STATUS[s.status] || [s.status])[0]} · ${s.status_detail}` : null],
    ['开始', `${md(s.started_at)} ${hm(s.started_at)}`],
    ['最后活动', `${md(s.last_activity_at)} ${hm(s.last_activity_at)} · ${ago(s.last_activity_at, now)}`],
    ['用时', duration((isLive(s) ? now : s.last_activity_at) - s.started_at)],
    ['token', `${fmtTokens(totalTokens(s))}（输入 ${fmtTokens(t.in)} · 输出 ${fmtTokens(t.out)} · 缓存读 ${fmtTokens(t.cr)} · 缓存写 ${fmtTokens(t.cw)}）`],
    ['请求', `${s.requests} 次`],
  ].filter((r) => r[1])
  return [
    el('a', { class: 'back', href: '#/sessions', text: '← 会话' }),
    el('div', { class: 'head' },
      el('div', { class: 'title' }, el('h1', { text: s.title || s.project }), statusTag(s.status))),
    el('div', { class: 'card' }, el('dl', { class: 'kv' }, rows.map(([k, v]) => [el('dt', { text: k }), el('dd', { class: 'num', text: v })]))),
    el('section', {},
      el('h2', { text: '状态记录' }),
      el('div', {},
        d.events.length
          ? el('ul', { class: 'timeline' }, d.events.map((e) => el('li', {},
              el('span', { class: 'when num', text: (sameDay(e.ts, now) ? '' : md(e.ts) + ' ') + hm(e.ts) }),
              statusTag(e.status),
              e.detail && el('span', { class: 'sub', text: e.detail }))))
          : el('div', { class: 'empty', text: '还没有状态记录' }))),
  ]
}

// 统计

function renderStats() {
  const s = state.stats
  const chips = el('div', { class: 'chips' }, [7, 30].map((n) => el('button', {
    class: 'chip' + (state.statsDays === n ? ' on' : ''), type: 'button', text: `${n} 天`,
    onclick: () => { state.statsDays = n; state.stats = null; render(); loadStats() },
  })))
  const head = el('div', { class: 'head' }, el('h1', { text: '统计' }), chips)
  if (!s) return [head, loading()]

  // 补齐没有数据的日子
  const byDay = new Map(s.daily.map((d) => [d.day, d]))
  const days = []
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (state.statsDays - 1))
  for (let i = 0; i < state.statsDays; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i)
    const k = dayKey(d)
    days.push({ day: k, label: `${d.getMonth() + 1}/${d.getDate()}`, total: byDay.get(k)?.total || 0, requests: byDay.get(k)?.requests || 0 })
  }
  const total = days.reduce((a, d) => a + d.total, 0)
  const requests = days.reduce((a, d) => a + d.requests, 0)
  const active = days.filter((d) => d.total > 0).length

  return [
    head,
    el('div', { class: 'tiles' },
      [['token', fmtTokens(total)], ['请求', requests.toLocaleString()], ['活跃天数', `${active} 天`], ['活跃日平均', fmtTokens(active ? total / active : 0)]]
        .map(([k, v]) => el('div', { class: 'card tile' }, el('div', { class: 'label', text: k }), el('div', { class: 'v', text: v })))),
    el('section', {}, el('h2', { text: '每天的 token' }), el('div', { class: 'card' }, dailyChart(days), dataTable(days))),
    el('div', { class: 'grid' },
      shareCard('按项目', s.projects.map((p) => [p.project, p.total])),
      shareCard('按模型', s.models.map((m) => [modelName(m.model), m.total]))),
  ]
}

/** 单序列柱状图：圆角柱顶、2px 间隔、悬停提示 */
function dailyChart(days) {
  const box = el('div', { class: 'chart' })
  const draw = () => {
    const W = Math.max(box.clientWidth, 280), H = 220, left = 44, bottom = 22, top = 8
    const plotW = W - left, plotH = H - bottom - top
    const max = Math.max(...days.map((d) => d.total), 1)
    const step = niceStep(max / 3)
    const yMax = Math.ceil(max / step) * step
    const slot = plotW / days.length
    const bw = Math.max(slot - Math.max(2, slot * 0.25), 1)
    const y = (v) => top + plotH - (v / yMax) * plotH
    const tip = el('div', { class: 'tip', hidden: true })
    const labelEvery = Math.ceil(days.length / Math.floor(plotW / 44))
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `最近 ${days.length} 天每天的 token 柱状图` },
      [0, 1, 2, 3].map((i) => i * step).filter((v) => v <= yMax).map((v) => [
        svg('line', { class: 'grid-line', x1: left, x2: W, y1: y(v), y2: y(v) }),
        svg('text', { class: 'axis', x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, fmtTokens(v)),
      ]),
      days.map((d, i) => {
        const x = left + i * slot + (slot - bw) / 2
        const h = (d.total / yMax) * plotH
        const r = Math.min(4, bw / 2, h)
        const yb = top + plotH
        const bar = h > 0 && svg('path', { class: 'bar', d: `M${x},${yb} V${yb - h + r} Q${x},${yb - h} ${x + r},${yb - h} H${x + bw - r} Q${x + bw},${yb - h} ${x + bw},${yb - h + r} V${yb} Z` })
        const hit = svg('rect', { class: 'hit', x: left + i * slot, y: top, width: slot, height: plotH })
        hit.addEventListener('mouseenter', () => {
          tip.textContent = `${d.label} · ${fmtTokens(d.total)} token · ${d.requests} 次请求`
          tip.style.left = (left + i * slot + slot / 2) / W * 100 + '%'
          tip.style.top = Math.max(y(d.total) - 6, 0) + 'px'
          tip.hidden = false
          if (bar) bar.classList.add('on')
        })
        hit.addEventListener('mouseleave', () => { tip.hidden = true; if (bar) bar.classList.remove('on') })
        const lbl = (i % labelEvery === 0 || i === days.length - 1) &&
          svg('text', { class: 'axis', x: left + i * slot + slot / 2, y: H - 4, 'text-anchor': 'middle' }, d.label)
        return [hit, bar, lbl]
      }))
    box.replaceChildren(s, tip)
  }
  requestAnimationFrame(draw)
  new ResizeObserver(() => draw()).observe(box)
  return box
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

function dataTable(days) {
  return el('details', {},
    el('summary', { class: 'sub', style: 'cursor:pointer', text: '查看数据表' }),
    el('div', { style: 'overflow-x:auto' }, el('table', { style: 'min-width:0' },
      el('thead', {}, el('tr', {}, ['日期', 'token', '请求'].map((t) => el('th', { text: t })))),
      el('tbody', {}, days.slice().reverse().map((d) => el('tr', { style: 'cursor:default' },
        el('td', { text: d.day }), el('td', { class: 'num', text: d.total.toLocaleString() }), el('td', { class: 'num', text: String(d.requests) })))))))
}

function shareCard(title, rows) {
  const sum = rows.reduce((a, r) => a + r[1], 0) || 1
  return el('div', { class: 'card' },
    el('div', { class: 'label', text: title }),
    rows.length
      ? el('div', {}, rows.map(([name, v]) => el('div', { class: 'share' },
          el('span', { class: 'n', text: name }),
          el('span', { class: 'sub num', text: `${fmtTokens(v)} · ${Math.round((v / sum) * 100)}%` }),
          el('div', { class: 'meter' }, el('div', { class: 'fill', style: `width:${(v / sum) * 100}%` })))))
      : el('div', { class: 'sub', text: '没有数据' }))
}

// 设备

const KIND = { mac: 'Mac', ios: 'iPhone', web: '网页' }

function renderDevices(now) {
  const d = state.devices
  if (!d) return loading()
  return el('section', {},
    el('div', { class: 'head' },
      el('h1', { text: '设备' }),
      el('button', { class: 'btn secondary small', type: 'button', text: '退出登录', onclick: logout })),
    el('div', { class: 'card', style: 'gap:0;padding-top:8px;padding-bottom:8px' }, d.devices.map((x) => {
      const online = x.kind === 'mac' && x.last_seen_at && now - x.last_seen_at <= 180000
      const meta = [KIND[x.kind] || x.kind, x.app_version && 'v' + x.app_version, (online ? '在线 · ' : '') + ago(x.last_seen_at, now)].filter(Boolean).join(' · ')
      return el('div', { class: 'dev' },
        el('div', {}, el('div', { class: 'name', text: x.name }), el('div', { class: 'sub', text: meta })),
        x.id === d.current
          ? el('span', { class: 'online on', text: '当前设备' })
          : el('button', { class: 'btn secondary small', type: 'button', text: '移除', onclick: () => revoke(x) }))
    })),
    el('p', { class: 'sub', style: 'margin:0', text: '移除后，那台设备需要重新登录。' }))
}

async function revoke(x) {
  if (!confirm(`移除“${x.name}”？那台设备需要重新登录。`)) return
  await fetch('/api/devices/' + encodeURIComponent(x.id), { method: 'DELETE' })
  loadRoute()
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  location.href = '/'
}

// ---------- 加载 ----------

async function loadOverview() { state.overview = await api('/api/overview'); render() }
async function loadDetail(id) { state.detail = await api('/api/sessions/' + encodeURIComponent(id)); render() }
async function loadStats() {
  const from = new Date(); from.setDate(from.getDate() - (state.statsDays - 1))
  state.stats = await api(`/api/stats?from=${dayKey(from)}`); render()
}
async function loadDevices() { state.devices = await api('/api/devices'); render() }

async function loadRoute() {
  const r = route()
  try {
    switch (r.name) {
      case 'overview': await loadOverview(); break
      case 'sessions':
        if (!state.overview) loadOverview().catch(() => {})   // 设备筛选要用
        // 已经翻过页就不自动刷新，免得列表跳回第一页
        if (state.sessions.key !== sessionsKey() || state.sessions.list.length <= 50) await loadSessions()
        break
      case 'detail': await loadDetail(r.id); break
      case 'stats': await loadStats(); break
      case 'devices': await loadDevices(); break
    }
    if (state.error) { state.error = null; render() }
  } catch (e) {
    if (e instanceof Unauthorized) return showLanding()
    state.error = e.message === 'HTTP 404' ? '找不到这个会话' : '连不上服务器，稍后会自动重试'
    render()
  }
}

function showLanding() {
  document.getElementById('shell').hidden = true
  document.getElementById('landing').hidden = false
}

async function start() {
  try {
    const { user } = await api('/api/me')
    state.me = user
  } catch (e) {
    if (e instanceof Unauthorized) return showLanding()
    document.getElementById('shell').hidden = false
    state.error = '连不上服务器，请稍后刷新'
    return render()
  }
  const avatar = document.getElementById('avatar')
  avatar.textContent = (state.me.name || state.me.email || '?').trim()[0].toUpperCase()
  avatar.title = [state.me.name, state.me.email].filter(Boolean).join(' · ')
  avatar.setAttribute('aria-label', '账号和设备：' + avatar.title)
  document.getElementById('shell').hidden = false
  render()
  loadRoute()

  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); loadRoute() })
  // 页面开着时每分钟拉一次；切回前台时立即拉
  setInterval(() => { if (document.visibilityState === 'visible') loadRoute() }, 60000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadRoute() })
  // 相对时间每 30 秒重画（统计页不重画，避免打断悬停）
  setInterval(() => { if (document.visibilityState === 'visible' && route().name !== 'stats') render() }, 30000)
}

// ---------- 主题：自动 / 浅色 / 深色 ----------

function setupTheme() {
  let current = 'auto'
  try { current = localStorage.getItem('theme') || 'auto' } catch {}
  const buttons = document.querySelectorAll('[data-theme-set]')
  const apply = (t) => {
    if (t === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)))
    try { t === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t) } catch {}
  }
  buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.themeSet)))
  apply(current)
}

setupTheme()
start()

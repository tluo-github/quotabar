// Quotlet 网站：概览、会话、会话详情、统计、设备。
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
  if (lang() === 'en') { const m = Math.round(Math.max(ms, 0) / 60000); if (m < 1) return '<1 min'; if (m < 60) return m + ' min'; if (m < 1440) return Math.floor(m / 60) + 'h ' + m % 60 + 'm'; return Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h' }
  const total = Math.round(Math.max(ms, 0) / 1000)
  const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60)
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
  if (h > 0) return m > 0 ? `${h}小时${m}分` : `${h}小时`
  if (m > 0) return `${m}分钟`
  return '不到1分钟'
}

function ago(t, now) {
  if (!t) return tr('从未')
  if (lang() === 'en') { const m = Math.max(0, Math.round((now - t) / 60000)); return m < 1 ? 'Just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago' }
  const m = Math.round((now - t) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}

/** 重置时间：今天 13:49 / 明天 02:59 / 本周日 03:00 / 下周一 03:00 / 11月30日 周日 03:00 */
function resetMoment(t, now) {
  if (lang() === 'en') return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(t)
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
  if (!id.startsWith('claude-')) return id.replace(/^gpt-/, 'GPT-')
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
  if (l.kind === 'session') return tr('5 小时')
  if (l.kind === 'weekly_all') return tr('本周')
  if (l.kind === 'weekly_scoped') return tr('本周') + ' · ' + (l.scope || '指定范围')
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
const statusTag = (s) => { const [t, c] = STATUS[s] || [s, 'quiet']; return el('span', { class: 'st st-' + c }, el('i', { 'aria-hidden': 'true' }), tr(t)) }
const isLive = (s) => s.status === 'running' || s.status === 'waiting'
const totalTokens = (s) => (s.tokens_in || 0) + (s.tokens_out || 0) + (s.tokens_cache_read || 0) + (s.tokens_cache_write || 0)

/** 列表已经按天分组，这里只写时刻；跨天才带日期 */
function sessionTime(s, now) {
  if (isLive(s)) return `${hm(s.started_at)} ${lang() === 'en' ? '·' : '起 ·'} ${duration(now - s.started_at)}`
  const a = s.started_at, b = s.last_activity_at
  return sameDay(a, b) ? `${hm(a)}–${hm(b)}` : `${md(a)} ${hm(a)}–${hm(b)}`
}

function dayLabel(t, now) {
  if (lang() === 'en') return sameDay(t, now) ? 'Today' : sameDay(t, now - 86400000) ? 'Yesterday' : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', weekday: 'short' }).format(t)
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
  statsSource: '', statsDevice: '', hiddenProjects: new Set(), history: null,
  sessionSource: '', search: '',
  alerts: [],
  error: null,
}

function route() {
  const h = location.hash.replace(/^#\/?/, '')
  const [name, id] = h.split('/')
  if (name === 'sessions' && id) return { name: 'detail', id: decodeURIComponent(id) }
  if (['sessions', 'stats', 'devices', 'settings'].includes(name)) return { name }
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
    case 'settings': content = renderSettings(); break
  }
  view.replaceChildren(...[state.error && el('div', { class: 'notice', text: tr(state.error) }), content].flat().filter(Boolean))
  translateShell()
  renderAlerts()
}

function loading() { return el('div', { class: 'empty', text: tr('正在加载…') }) }

function chips(options, current, onPick) {
  return el('div', { class: 'chips', role: 'group' }, options.map(([k, t, n]) => el('button', {
    class: 'chip' + (current === k ? ' on' : ''), type: 'button', 'aria-pressed': String(current === k),
    onclick: () => onPick(k),
  }, tr(t), n ? el('span', { class: 'n', text: String(n) }) : null)))
}

// 概览

function renderOverview(now) {
  const o = state.overview
  if (!o) return loading()
  const device = o.devices.find((d) => d.id === state.usageDevice) || o.devices[0]
  const usages = o.usage.filter((u) => u.device_id === device?.id)
  const today = o.sessions.filter((s) => sameDay(s.last_activity_at, now))
  const quota = el('section', { class: 'overview-panel overview-quota' },
    el('header', { class: 'head' },
      el('div', {}, el('div', { class: 'overview-kicker', text: 'QUOTLET CLOUD' }), el('h1', { text: tr('用量概览') })),
      el('button', { class: 'btn secondary small', text: tr('刷新'), onclick: () => loadRoute() })),
    devicesStrip(o, now),
    o.devices.length > 1 && chips(o.devices.map((d) => [d.id, d.name]), device?.id, (k) => { state.usageDevice = k; render() }),
    el('div', { class: 'provider-grid' }, ['claude', 'codex'].map((provider) => {
      const u = usages.find((x) => (x.provider || 'claude') === provider)
      const name = provider === 'codex' ? 'Codex' : 'Claude'
      const worst = u?.limits.map((l) => level(l.percent, l.severity)).sort((a, b) => b.rank - a.rank)[0]
      return el('section', { class: 'provider-card provider-' + provider },
        el('header', { class: 'head' },
          el('div', { class: 'title' }, el('span', { class: 'provider-icon', text: provider === 'codex' ? '⌘' : '✳', 'aria-hidden': 'true' }),
            el('h2', { text: name }), u?.plan && el('span', { class: 'plan', text: u.plan })),
          worst && el('span', { class: 'health h-' + worst.key, text: tr(worst.name) })),
        u?.limits.length ? u.limits.map((l) => limitCard(l, now)) : el('div', { class: 'quota-empty', text: tr('等待 Mac 上报额度') }),
        el('div', { class: 'sub muted', text: u ? tr('更新于') + ' ' + ago(u.fetched_at, now) : tr('使用后由 Mac 自动同步') }))
    })))
  const sessions = el('section', { class: 'overview-panel overview-sessions' },
    el('header', { class: 'head' }, el('h2', { text: tr('最近的会话') }),
      el('a', { class: 'link', href: '#/sessions', text: tr('查看全部会话 →') })),
    chips([['all', '全部'], ['running', '执行中', o.sessions.filter((s) => s.status === 'running').length], ['waiting', '等待授权'], ['done', '已完成']],
      state.overviewFilter, (k) => { state.overviewFilter = k; render() }),
    sessionList((state.overviewFilter === 'all' ? o.sessions : o.sessions.filter((s) => s.status === state.overviewFilter)).slice(0, 8), now))
  return el('div', { class: 'overview' }, quota,
    el('div', { class: 'summary-strip' },
      [[tr('近期会话'), o.sessions.length], [tr('进行中'), o.sessions.filter(isLive).length], [tr('今日会话 token'), fmtTokens(today.reduce((n, s) => n + totalTokens(s), 0))]]
        .map(([label, value]) => el('div', {}, el('span', { class: 'sub', text: label }), el('strong', { class: 'num', text: String(value) })))), sessions)
}

function limitCard(l, now) {
  const lv = level(l.percent, l.severity)
  const p = Math.round(l.percent)
  const win = WINDOW[l.kind]
  const elapsed = win && l.resets_at ? Math.min(Math.max(1 - (l.resets_at - now) / win, 0), 1) : null
  return el('div', { class: 'limit l-' + lv.key },
    el('div', { class: 'label', text: limitTitle(l) }),
    el('div', { class: 'big' }, String(p), el('small', { text: '%' })),
    el('div', { class: 'meter', role: 'img', 'aria-label': lang() === 'en' ? `${p}% used, ${tr(lv.name)}` : `已用 ${p}%，${lv.name}` + (elapsed != null ? `；时间过了 ${Math.round(elapsed * 100)}%` : '') },
      el('div', { class: 'fill', style: `width:${Math.min(p, 100)}%` }),
      elapsed != null && el('span', { class: 'tick', style: `left:${elapsed * 100}%`, title: lang() === 'en' ? `${Math.round(elapsed * 100)}% of window elapsed` : `时间过了 ${Math.round(elapsed * 100)}%` })),
    l.resets_at && el('div', { class: 'reset' },
      el('b', { text: resetMoment(l.resets_at, now) + ' · ' + tr('重置') }),
      el('span', { text: l.resets_at > now ? (lang() === 'en' ? 'In ' : '还有 ') + duration(l.resets_at - now) : tr('等待 Mac 刷新') })))
}

/** 每台 Mac 一个小胶囊：在线圆点 + 名字 + 状态 */
function devicesStrip(o, now) {
  if (!o.devices.length) return null
  const live = {}
  for (const s of o.sessions) if (isLive(s)) live[s.device_id] = (live[s.device_id] || 0) + 1
  return el('div', { class: 'devices' }, o.devices.map((d) => el('div', { class: 'devchip' },
    el('span', { class: 'dot' + (d.online ? ' on' : ''), 'aria-hidden': 'true' }),
    el('b', { text: d.name }),
    el('span', { class: 'muted', text: (d.online ? tr('在线') : tr('离线') + ' · ' + ago(d.last_seen_at, now)) }))))
}

/** 按天分组的会话列表，整行可点，设备始终显示。 */
function sessionList(list, now) {
  if (!list.length) return el('div', { class: 'empty', text: tr('没有会话') })
  const multi = true
  const groups = []
  for (const s of list) {
    // 进行中的会话归到今天
    const key = startOfDay(isLive(s) ? now : s.last_activity_at)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) groups.push(g = { key, items: [] })
    g.items.push(s)
  }
  return el('div', { class: 'list' }, el('div', { class: 'session-head' }, ['状态', '会话', '设备', 'token'].map((h) => el('span', { text: tr(h) }))), groups.map((g) => el('div', { class: 'group' },
    el('div', { class: 'day' },
      el('b', { text: dayLabel(g.key, now) }),
      el('span', { class: 'num', text: `${g.items.length} ${tr('个会话')} · ${fmtTokens(g.items.reduce((a, s) => a + totalTokens(s), 0))}` })),
    g.items.map((s) => sessionRow(s, now, multi)))))
}

function sessionRow(s, now, multi) {
  const meta = [s.title ? s.project : null, s.source === 'codex' ? 'Codex' : 'Claude Code', modelName(s.model)].filter(Boolean)
  return el('a', { class: 'srow s-' + s.status, href: '#/sessions/' + encodeURIComponent(s.id) },
    statusTag(s.status),
    el('div', { class: 'main' },
      el('div', { class: 't', text: s.title || s.project }),
      el('div', { class: 'meta' }, meta.map((m) => el('span', { text: m })), s.status_detail && el('span', { class: 'detail', text: s.status_detail }))),
    el('span', { class: 'session-device', text: s.device_name || 'Mac', title: s.device_name || 'Mac' }),
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
      el('h1', { text: tr('会话') }),
      chips(SESSION_FILTERS, st.status, (k) => { st.status = k; loadSessions().catch(handleLoadError) })),
    chips([['', '全部来源'], ['claude', 'Claude Code'], ['codex', 'Codex']], state.sessionSource, (k) => { state.sessionSource = k; loadSessions().catch(handleLoadError) }),
    el('input', { class: 'search', type: 'search', placeholder: tr('搜索标题或项目'), value: state.search, 'aria-label': tr('搜索标题或项目'), oninput: (e) => { state.search = e.target.value; const list = document.getElementById('session-results'); list.replaceChildren(sessionList(filteredSessions(), now)) } }),
    macs.length > 1 && chips([['', '所有设备'], ...macs.map((d) => [d.id, d.name])], st.device, (k) => { st.device = k; loadSessions().catch(handleLoadError) }),
    st.key !== sessionsKey() ? loading() : el('div', { id: 'session-results' }, sessionList(filteredSessions(), now)),
    st.next && el('button', { class: 'btn secondary small more', type: 'button', text: tr('加载更多'), onclick: () => loadSessions(true).catch(handleLoadError) }))
}

function filteredSessions() { const q = state.search.trim().toLowerCase(); return state.sessions.list.filter((s) => !q || [s.title, s.project, s.device_name].some((v) => v?.toLowerCase().includes(q))) }

const sessionsKey = () => `${state.sessions.status}|${state.sessions.device}|${state.sessionSource}`

async function loadSessions(more) {
  const st = state.sessions
  const key = sessionsKey()
  if (!more && st.key !== key) { st.list = []; st.next = null; st.key = ''; render() }
  const q = new URLSearchParams()
  if (st.status) q.set('status', st.status)
  if (state.sessionSource) q.set('source', state.sessionSource)
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
    ['来源', s.source === 'codex' ? 'Codex' : 'Claude Code'],
    ['设备', s.device_name || '—'],
    ['模型', modelName(s.model) || '—'],
    ['状态', s.status_detail ? `${tr((STATUS[s.status] || [s.status])[0])} · ${s.status_detail}` : null],
    ['开始', `${md(s.started_at)} ${hm(s.started_at)}`],
    ['最后活动', `${md(s.last_activity_at)} ${hm(s.last_activity_at)} · ${ago(s.last_activity_at, now)}`],
    ['用时', duration((isLive(s) ? now : s.last_activity_at) - s.started_at)],
    ['token', `${fmtTokens(totalTokens(s))} (${tr('输入')} ${fmtTokens(t.in)} · ${tr('输出')} ${fmtTokens(t.out)} · ${tr('缓存读')} ${fmtTokens(t.cr)} · ${tr('缓存写')} ${fmtTokens(t.cw)})`],
    ['请求', s.requests.toLocaleString()],
  ].filter((r) => r[1])
  return [
    el('a', { class: 'back', href: '#/sessions', text: tr('← 会话') }),
    el('div', { class: 'head' },
      el('div', { class: 'title' }, el('h1', { text: s.title || s.project }), statusTag(s.status))),
    el('div', { class: 'card' }, el('dl', { class: 'kv' }, rows.map(([k, v]) => [el('dt', { text: tr(k) }), el('dd', { class: 'num', text: v })]))),
    el('section', {},
      el('h2', { text: tr('状态记录') }),
      el('div', {},
        d.events.length
          ? el('ul', { class: 'timeline' }, d.events.map((e) => el('li', {},
              el('span', { class: 'when num', text: (sameDay(e.ts, now) ? '' : md(e.ts) + ' ') + hm(e.ts) }),
              statusTag(e.status),
              e.detail && el('span', { class: 'sub', text: e.detail }))))
          : el('div', { class: 'empty', text: tr('还没有状态记录') }))),
  ]
}

// 统计

function renderStats() {
  const s = state.stats
  const chips = el('div', { class: 'chips' }, [7, 30].map((n) => el('button', {
    class: 'chip' + (state.statsDays === n ? ' on' : ''), type: 'button', text: trDays(n),
    onclick: () => { state.statsDays = n; state.stats = null; render(); loadStats().catch(handleLoadError) },
  })))
  const head = el('div', { class: 'head' }, el('h1', { text: tr('用量分析') }), chips)
  const filters = el('div', { class: 'head' }, sourcePicker(), statsDevicePicker())
  if (!s) return [head, filters, loading()]

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
    head, filters,
    el('div', { class: 'tiles' },
      [['token', fmtTokens(total)], ['请求', requests.toLocaleString()], ['活跃天数', trDays(active)], ['活跃日平均', fmtTokens(active ? total / active : 0)]]
        .map(([k, v]) => el('div', { class: 'card tile' }, el('div', { class: 'label', text: tr(k) }), el('div', { class: 'v', text: v })))),
    el('section', {}, el('h2', { text: tr('每天的 token') }), el('div', { class: 'card' }, dailyChart(days), dataTable(days))),
    projectTrend(days),
    usageHistory(),
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
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': tr('每天的 token') + ' · ' + trDays(days.length) },
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
          tip.textContent = `${d.label} · ${fmtTokens(d.total)} token · ${d.requests} ${tr('请求')}`
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
  // view 的宽度变化由统一监听触发重新渲染。
  return box
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

function dataTable(days) {
  return el('details', {},
    el('summary', { class: 'sub', style: 'cursor:pointer', text: tr('查看数据表') }),
    el('div', { style: 'overflow-x:auto' }, el('table', { style: 'min-width:0' },
      el('thead', {}, el('tr', {}, ['日期', 'token', '请求'].map((t) => el('th', { text: tr(t) })))),
      el('tbody', {}, days.slice().reverse().map((d) => el('tr', { style: 'cursor:default' },
        el('td', { text: d.day }), el('td', { class: 'num', text: d.total.toLocaleString() }), el('td', { class: 'num', text: String(d.requests) })))))))
}

function shareCard(title, rows) {
  const sum = rows.reduce((a, r) => a + r[1], 0) || 1
  return el('div', { class: 'card' },
    el('div', { class: 'label', text: tr(title) }),
    rows.length
      ? el('div', {}, rows.map(([name, v]) => el('div', { class: 'share' },
          el('span', { class: 'n', text: name }),
          el('span', { class: 'sub num', text: `${fmtTokens(v)} · ${Math.round((v / sum) * 100)}%` }),
          el('div', { class: 'meter' }, el('div', { class: 'fill', style: `width:${(v / sum) * 100}%` })))))
      : el('div', { class: 'sub', text: tr('没有数据') }))
}

// 设备

const KIND = { mac: 'Mac', ios: 'iPhone', web: '网页' }

function renderDevices(now) {
  const d = state.devices
  if (!d) return loading()
  return el('section', {},
    el('div', { class: 'head' },
      el('h1', { text: tr('设备') }),
      el('button', { class: 'btn secondary small', type: 'button', text: tr('退出登录'), onclick: () => logout().catch(handleLoadError) })),
    el('div', { class: 'card', style: 'gap:0;padding-top:8px;padding-bottom:8px' }, d.devices.map((x) => {
      const online = x.kind === 'mac' && x.last_seen_at && now - x.last_seen_at <= 180000
      const meta = [tr(KIND[x.kind] || x.kind), x.app_version && 'v' + x.app_version, (online ? tr('在线') + ' · ' : '') + ago(x.last_seen_at, now)].filter(Boolean).join(' · ')
      return el('div', { class: 'dev' },
        el('div', {}, el('div', { class: 'name', text: x.name }), el('div', { class: 'sub', text: meta })),
        x.id === d.current
          ? el('span', { class: 'online on', text: tr('当前设备') })
          : el('button', { class: 'btn secondary small', type: 'button', text: tr('移除'), onclick: () => revoke(x).catch(handleLoadError) }))
    })),
    el('p', { class: 'sub', style: 'margin:0', text: tr('移除后，那台设备需要重新登录。') }))
}

async function revoke(x) {
  if (!confirm(lang() === 'en' ? `Remove “${x.name}”? It will need to sign in again.` : `移除“${x.name}”？那台设备需要重新登录。`)) return
  await api('/api/devices/' + encodeURIComponent(x.id), { method: 'DELETE' })
  loadRoute()
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' })
  location.href = '/'
}

// ---------- 加载 ----------

async function loadOverview() { state.overview = await api('/api/overview'); checkAlerts(); render() }
async function loadDetail(id) { state.detail = await api('/api/sessions/' + encodeURIComponent(id)); render() }
async function loadStats() {
  const requestID = state.statsRequestID = (state.statsRequestID || 0) + 1
  const from = new Date(); from.setDate(from.getDate() - (state.statsDays - 1))
  const q = new URLSearchParams({ from: dayKey(from), source: state.statsSource, device: state.statsDevice })
  const key = q.toString()
  const [stats, history] = await Promise.all([api('/api/stats?' + q), api('/api/usage-history?days=' + state.statsDays)])
  if (requestID !== state.statsRequestID) return
  if (key !== new URLSearchParams({ from: dayKey(from), source: state.statsSource, device: state.statsDevice }).toString()) return
  state.stats = stats; state.history = history.history; render()
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
      case 'stats': if (!state.overview) await loadOverview(); await loadStats(); break
      case 'devices': await loadDevices(); break
      case 'settings': break
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
  const refreshVisible = () => {
    if (document.visibilityState !== 'visible') return
    loadRoute()
    if (route().name !== 'overview') loadOverview().catch(handleLoadError)
  }
  setInterval(refreshVisible, 60000)
  document.addEventListener('visibilitychange', refreshVisible)
  // 相对时间每 30 秒重画（统计页不重画，避免打断悬停）
  setInterval(() => { if (document.visibilityState === 'visible' && route().name !== 'stats') render() }, 30000)
}

window.addEventListener('resize', () => { clearTimeout(window.resizeTimer); window.resizeTimer = setTimeout(() => { if (route().name === 'stats') render() }, 150) })

setupPreferences()
start()

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// 无第三方 DOM 依赖的交互回归：加载实际前端脚本，触发用户点击并检查生成的节点。
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.style = {}; this.clientWidth = 800; this.isConnected = true; this.classList = { toggle() {}, add() {}, remove() {} } }
  append(...items) { this.children.push(...items) }
  replaceChildren(...items) { this.children = items }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'value') this.value = value; if (key.startsWith('data-')) this.dataset[key.slice(5)] = value }
  removeAttribute(key) { delete this.attributes[key] }
  addEventListener(event, fn) { this.events[event] = fn }
  set textContent(value) { this.children = [String(value)] }
  get textContent() { return this.children.map((c) => c instanceof Element ? c.textContent : c).join('') }
}
function nodes(element) { return element instanceof Element ? [element, ...element.children.flatMap(nodes)] : [] }
function dashboard() {
  const elements = Object.fromEntries(['view', 'shell', 'landing', 'avatar', 'alerts', 'meta'].map((id) => [id, new Element('div')]))
  const saved = new Map(), requests = [], frames = [], intervals = []
  const now = Date.now()
  const usage = ['claude', 'codex'].map((provider) => ({ provider, device_id: 'mac', device_name: 'MacBook M4 Max', plan: 'Pro', fetched_at: now, limits: [{ kind: 'session', percent: 95, resets_at: now + 3600000 }] }))
  const overview = { usage, devices: [{ id: 'mac', name: 'MacBook M4 Max', online: true }], sessions: [] }
  const context = vm.createContext({
    console, Date, Map, Set, Intl, Math, URLSearchParams, String, Number,
    navigator: { language: 'zh-CN' }, location: { hash: '#/' },
    document: {
      createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag),
      getElementById: (id) => elements[id] || nodes(elements.view).find((e) => e.attributes.id === id),
      querySelectorAll: () => [], querySelector: () => elements.meta, addEventListener() {}, visibilityState: 'visible',
      documentElement: { dataset: {} },
    },
    localStorage: { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, String(v)) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    window: { addEventListener() {}, scrollTo() {} }, setInterval(fn, ms) { intervals.push([fn, ms]) }, setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => frames.push(fn),
    fetch: async (url) => { requests.push(url); return { status: 200, ok: true, json: async () => url === '/api/me' ? { user: { name: 'Bruce' } } : overview } },
  })
  for (const name of ['preferences', 'analytics', 'app']) vm.runInContext(readFileSync(new URL(`../web/static/${name}.js`, import.meta.url), 'utf8'), context)
  const run = (s) => vm.runInContext(s, context)
  return { context, run, elements, saved, overview, frames, requests, intervals }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('概览展示两家额度，Claude 和 Codex 都会产生独立告警', async () => {
  const d = dashboard(); await settle()
  assert.match(d.elements.view.textContent, /Claude/)
  assert.match(d.elements.view.textContent, /Codex/)
  assert.equal(nodes(d.elements.alerts).filter((e) => e.className === 'alert-toast').length, 2)
  const dismiss = nodes(d.elements.alerts).find((e) => e.className === 'dismiss')
  dismiss.events.click()
  assert.equal(nodes(d.elements.alerts).filter((e) => e.className === 'alert-toast').length, 1)
  d.run('checkAlerts(); renderAlerts()')
  assert.equal(nodes(d.elements.alerts).filter((e) => e.className === 'alert-toast').length, 1)
})
test('项目默认全选，清空、单选和全选会改变图表序列', async () => {
  const d = dashboard(); await settle()
  d.run(`state.stats = { projects: [{project:'Alpha',total:30,tokens_out:10},{project:'Beta',total:60,tokens_out:20}], project_daily: [{day:'2026-11-18',project:'Alpha',total:30,tokens_out:10},{day:'2026-11-18',project:'Beta',total:60,tokens_out:20}] }; view.replaceChildren(projectTrend([{day:'2026-11-18',label:'11/18'}]))`)
  let checks = nodes(d.elements.view).filter((e) => e.tag === 'input')
  assert.equal(checks.length, 2)
  assert.ok(checks.every((e) => 'checked' in e.attributes))
  for (const fn of d.frames.splice(0)) fn()
  assert.equal(nodes(d.elements.view).filter((e) => e.tag === 'polyline').length, 2)
  checks[0].events.change({ target: { checked: false } })
  assert.equal(d.run("state.hiddenProjects.has('Alpha')"), true)
  d.run(`view.replaceChildren(projectTrend([{day:'2026-11-18',label:'11/18'}]))`)
  nodes(d.elements.view).find((e) => e.tag === 'button' && e.textContent === '清空').events.click()
  assert.equal(d.run('state.hiddenProjects.size'), 2)
  d.run(`view.replaceChildren(projectTrend([{day:'2026-11-18',label:'11/18'}]))`)
  assert.match(d.elements.view.textContent, /选择项目/)
  nodes(d.elements.view).find((e) => e.tag === 'button' && e.textContent === '全选').events.click()
  assert.equal(d.run('state.hiddenProjects.size'), 0)
})
test('设置切换语言和深色主题后保存偏好，会话显示设备列', async () => {
  const d = dashboard(); await settle()
  d.run("location.hash='#/settings'; render()")
  nodes(d.elements.view).find((e) => e.tag === 'button' && e.textContent === 'English').events.click()
  assert.match(d.elements.view.textContent, /Preferences/)
  assert.equal(d.saved.get('language'), 'en')
  nodes(d.elements.view).find((e) => e.tag === 'button' && e.textContent === 'Dark').events.click()
  assert.equal(d.saved.get('theme'), 'dark')
  assert.equal(d.run('document.documentElement.dataset.theme'), 'dark')
  d.run(`view.replaceChildren(sessionList([{id:'test',source:'codex',device_name:'MacBook M4 Max',title:'Hello',project:'Alpha',model:'gpt-6.1-sol',status:'done',started_at:Date.now()-10000,last_activity_at:Date.now(),tokens_out:10}], Date.now()))`)
  assert.match(d.elements.view.textContent, /MacBook M4 Max/)
  assert.match(d.elements.view.textContent, /Device/)
  assert.match(d.elements.view.textContent, /GPT-6.1-sol/)
})
test('快速切换分析范围时，旧请求不能覆盖最新结果', async () => {
  const d = dashboard(); await settle()
  const resolvers = []
  d.context.fetch = (url) => new Promise((resolve) => resolvers.push({ url, resolve }))
  const first = d.run('state.statsDays=7; loadStats()')
  const second = d.run('state.statsDays=30; loadStats()')
  const payload = (value) => ({ ok: true, status: 200, json: async () => value })
  resolvers[2].resolve(payload({ marker: 'new' })); resolvers[3].resolve(payload({ history: [] }))
  await second
  resolvers[0].resolve(payload({ marker: 'old' })); resolvers[1].resolve(payload({ history: [] }))
  await first
  assert.equal(d.run('state.stats.marker'), 'new')
})

test('停留在其他页面时也持续刷新额度告警', async () => {
  const d = dashboard(); await settle()
  d.run("location.hash='#/settings'; render()")
  const before = d.requests.filter((url) => url === '/api/overview').length
  d.intervals.find(([, ms]) => ms === 60000)[0]()
  await settle()
  assert.equal(d.requests.filter((url) => url === '/api/overview').length, before + 1)
})

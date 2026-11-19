'use strict'
const prefs = {
  theme: readPreference('theme', 'auto'), language: readPreference('language', 'auto'),
  alerts: readPreference('alerts', 'on'), threshold: Number(readPreference('alertThreshold', '90')),
}
function readPreference(key, fallback) { try { return localStorage.getItem(key) || fallback } catch { return fallback } }
function savePreference(key, value) { try { localStorage.setItem(key, value) } catch {} }
function lang() { return prefs.language === 'auto' ? (navigator.language.startsWith('zh') ? 'zh' : 'en') : prefs.language }
const EN = {
  '概览': 'Overview', '会话': 'Sessions', '统计': 'Analytics', '分析': 'Analytics', '设备': 'Devices', '设置': 'Settings',
  '用量概览': 'Usage overview', '用量分析': 'Usage analytics', '最近的会话': 'Recent sessions', '查看全部会话 →': 'All sessions →',
  '全部': 'All', '全部来源': 'All providers', '执行中': 'Running', '进行中': 'Active', '等待授权': 'Approval needed', '已完成': 'Completed', '已结束': 'Ended', '空闲': 'Idle', '离线': 'Offline', '在线': 'Online',
  '接近上限': 'Near limit', '用量偏高': 'High usage', '健康': 'Healthy', '5 小时': '5 hours', '本周': 'Weekly', '重置': 'Resets',
  '刷新': 'Refresh', '更新于': 'Updated', '等待 Mac 上报额度': 'Waiting for quota from your Mac', '使用后由 Mac 自动同步': 'Syncs automatically after use on your Mac',
  '近期会话': 'Recent sessions', '今日会话 token': 'Tokens in today’s sessions', '个会话': 'sessions', '没有会话': 'No sessions', '所有设备': 'All devices',
  '搜索标题或项目': 'Search title or project', '搜索标题、项目或模型': 'Search title, project or model', 'token 用量': 'Token usage', '时间': 'Time', '未知模型': 'Unknown model', '用量条相对于当前列表中 token 最多的会话。': 'Usage bars are relative to the largest session in this list.', '查看全部会话': 'View all sessions', '加载更多': 'Load more', '正在加载…': 'Loading…', '项目': 'Project', '来源': 'Provider', '模型': 'Model',
  '输入': 'Input', '缓存读': 'Cache read', '缓存写': 'Cache write', '网页': 'Web', '开始': 'Started', '最后活动': 'Last activity', '用时': 'Duration', '请求': 'Requests', '状态': 'Status', '状态记录': 'Status history', '还没有状态记录': 'No status history yet', '← 会话': '← Sessions',
  '从未': 'Never', '等待 Mac 刷新': 'Waiting for your Mac to refresh', '每天的 token': 'Daily tokens', '按项目': 'By project', '按模型': 'By model',
  '活跃天数': 'Active days', '活跃日平均': 'Average per active day', '没有数据': 'No data', '查看数据表': 'View data table', '日期': 'Date',
  '退出登录': 'Sign out', '当前设备': 'This device', '移除': 'Remove', '移除后，那台设备需要重新登录。': 'Removed devices must sign in again.',
  '项目用量趋势': 'Project usage trends', '全选': 'Select all', '清空': 'Clear', '总 token': 'Total tokens', '输出': 'Output', '选择项目后显示趋势': 'Select projects to show trends',
  '额度历史': 'Quota history', '分析记录': 'Analysis history', '还没有额度历史记录': 'No quota history yet', '额度历史由 Mac 同步后记录，最多保留 90 天。': 'Quota snapshots are recorded after your Mac syncs and kept for up to 90 days.',
  '偏好设置': 'Preferences', '外观': 'Appearance', '跟随系统': 'System', '浅色': 'Light', '深色': 'Dark', '界面语言': 'Language',
  '额度告警': 'Quota alerts', '网页内提醒': 'In-page alerts', '开启': 'On', '关闭': 'Off', '提醒阈值': 'Alert threshold',
  'Claude 和 Codex 使用相同的告警规则。网页打开时显示提醒，桌面通知请在 Mac App 设置中管理。': 'Claude and Codex share the same alert rules. In-page alerts work while this page is open. Manage desktop notifications in the Mac app.',
  '偏好保存在当前浏览器。': 'Preferences are saved in this browser.', '账号': 'Account', '管理设备': 'Manage devices', '关闭提醒': 'Dismiss alert',
  '打开分析': 'View analytics', '告警已开启': 'Alerts enabled', '在网站和手机上查看 Claude 与 Codex 的额度、会话和用量趋势。': 'Track Claude and Codex quotas, sessions, and usage trends on the web and your phone.', '登录': 'Sign in',
  '连不上服务器，请稍后刷新': 'Unable to connect. Please refresh later.', '连不上服务器，稍后会自动重试': 'Unable to connect. Retrying shortly.', '找不到这个会话': 'Session not found',
}
function tr(text) { return lang() === 'en' ? (EN[text] || text) : text }
function trDays(n) { return lang() === 'en' ? `${n} days` : `${n} 天` }
function translateShell() {
  document.documentElement.lang = lang() === 'zh' ? 'zh-CN' : 'en'
  document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = tr(e.dataset.i18n) })
  const account = document.getElementById('avatar')
  if (account) account.setAttribute('aria-label', tr('账号'))
}
function applyTheme() {
  if (prefs.theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = prefs.theme
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"]').content = dark ? '#131715' : '#f5f6f3'
}
function setupPreferences() {
  if (!['auto', 'zh', 'en'].includes(prefs.language)) prefs.language = 'auto'
  if (!['auto', 'light', 'dark'].includes(prefs.theme)) prefs.theme = 'auto'
  if (![80, 90, 95].includes(prefs.threshold)) prefs.threshold = 90
  applyTheme(); translateShell()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
}
function renderSettings() {
  function row(label, control, note) {
    return el('div', { class: 'setting-row' }, el('div', {}, el('strong', { text: tr(label) }), note && el('p', { class: 'sub', text: tr(note) })), control)
  }
  function pick(key, choices) {
    return chips(choices, prefs[key], (v) => {
      prefs[key] = v; savePreference(key === 'threshold' ? 'alertThreshold' : key, v)
      if (key === 'theme') applyTheme()
      if (key === 'alerts' && v === 'off') state.alerts = []
      if (key === 'alerts' || key === 'threshold') checkAlerts()
      render()
    })
  }
  return [el('h1', { text: tr('设置') }),
    el('section', { class: 'overview-panel' }, el('h2', { text: tr('偏好设置') }),
      row('外观', pick('theme', [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']])),
      row('界面语言', pick('language', [['auto', '跟随系统'], ['zh', '中文'], ['en', 'English']])),
      el('p', { class: 'sub', text: tr('偏好保存在当前浏览器。') })),
    el('section', { class: 'overview-panel' }, el('h2', { text: tr('额度告警') }),
      row('网页内提醒', pick('alerts', [['on', '开启'], ['off', '关闭']])),
      row('提醒阈值', pick('threshold', [80, 90, 95].map((n) => [n, n + '%']))),
      el('p', { class: 'sub', text: tr('Claude 和 Codex 使用相同的告警规则。网页打开时显示提醒，桌面通知请在 Mac App 设置中管理。') })),
    el('section', { class: 'overview-panel' }, el('h2', { text: tr('账号') }),
      el('div', { class: 'setting-row' }, el('strong', { text: state.me?.name || state.me?.email || 'Quotlet' }), el('a', { class: 'link', href: '#/devices', text: tr('管理设备') })),
      el('button', { class: 'btn secondary small', text: tr('退出登录'), onclick: () => logout().catch(handleLoadError) }))]
}
function checkAlerts() {
  if (prefs.alerts !== 'on') return
  for (const u of state.overview?.usage || []) for (const l of u.limits) {
    if (l.percent < prefs.threshold || (l.resets_at && l.resets_at <= Date.now())) continue
    const provider = u.provider === 'codex' ? 'Codex' : 'Claude'
    const key = `quota-alert:${u.device_id}:${provider}:${l.kind}:${l.scope || ''}:${l.resets_at || 0}:${l.percent >= 100 ? 'full' : 'low'}`
    if (readPreference(key, '') || state.alerts.some((a) => a.key === key)) continue
    state.alerts.push({ key, provider, device: u.device_name, limit: l })
  }
}
function renderAlerts() {
  const box = document.getElementById('alerts')
  state.alerts = state.alerts.filter((a) => a.limit.percent >= prefs.threshold && (!a.limit.resets_at || a.limit.resets_at > Date.now()))
  box.replaceChildren(...state.alerts.slice(0, 3).map((a) => el('div', { class: 'alert-toast', role: 'status' },
    el('div', {}, el('strong', { text: `${a.provider} · ${tr(limitTitle(a.limit))} · ${Math.round(a.limit.percent)}%` }),
      el('div', { class: 'sub', text: a.device })),
    el('button', { class: 'dismiss', 'aria-label': tr('关闭提醒'), text: '×', onclick: () => { savePreference(a.key, '1'); state.alerts = state.alerts.filter((v) => v.key !== a.key); renderAlerts() } }))))
}

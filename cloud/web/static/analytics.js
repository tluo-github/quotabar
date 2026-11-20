'use strict'
const SERIES_COLORS = ['#c46c47', '#4276db', '#27936b', '#9c69c7', '#c7588b', '#298f9e', '#ad8324', '#7375a8']
function sourcePicker() {
  return chips([['', '全部来源'], ['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini']], state.statsSource,
    (k) => { state.statsSource = k; state.stats = null; render(); loadStats().catch(handleLoadError) })
}
function statsDevicePicker() {
  const devices = state.overview?.devices || []
  if (devices.length < 2) return null
  return el('select', { class: 'select', 'aria-label': tr('设备'), onchange: (e) => { state.statsDevice = e.target.value; state.stats = null; render(); loadStats().catch(handleLoadError) } },
    [['', tr('所有设备')], ...devices.map((d) => [d.id, d.name])].map(([id, name]) => el('option', { value: id, selected: id === state.statsDevice, text: name })))
}
function projectTrend(days) {
  const projects = state.stats.projects
  const output = state.projectOutput || false
  const rows = state.stats.project_daily || []
  const series = projects.map((p, i) => ({ id: p.project, color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: days.map((d) => rows.filter((r) => r.day === d.day && r.project === p.project).reduce((n, r) => n + (output ? r.tokens_out : r.total), 0)),
    total: output ? p.tokens_out : p.total }))
  const visible = series.filter((p) => !state.hiddenProjects.has(p.id))
  const legend = el('div', { class: 'project-legend' },
    el('div', { class: 'head' }, el('strong', { text: tr('按项目') }), el('div', {},
      el('button', { class: 'text-button', text: tr('全选'), onclick: () => { state.hiddenProjects.clear(); render() } }),
      el('button', { class: 'text-button', text: tr('清空'), onclick: () => { series.forEach((p) => state.hiddenProjects.add(p.id)); render() } }))),
    series.map((p) => el('label', { class: 'project-option' },
      el('input', { type: 'checkbox', checked: !state.hiddenProjects.has(p.id), onchange: (e) => { e.target.checked ? state.hiddenProjects.delete(p.id) : state.hiddenProjects.add(p.id); render() } }),
      el('i', { style: `background:${p.color}` }), el('span', { text: p.id }), el('b', { class: 'num', text: fmtTokens(p.total) }))))
  return el('section', { class: 'overview-panel' }, el('div', { class: 'head' }, el('h2', { text: tr('项目用量趋势') }),
    chips([['total', '总 token'], ['output', '输出']], output ? 'output' : 'total', (v) => { state.projectOutput = v === 'output'; render() })),
    el('div', { class: 'trend-layout' }, visible.length ? lineChart(days.map((d) => d.label), visible, false) : el('div', { class: 'empty', text: tr('选择项目后显示趋势') }), legend))
}
function usageHistory() {
  const metric = state.historyMetric || 'five_hour'
  const rows = (state.history || []).filter((r) => (!state.statsSource || r.provider === state.statsSource) && (!state.statsDevice || r.device_id === state.statsDevice))
  const groups = new Map()
  for (const r of rows) {
    const key = r.device_id + ':' + r.provider
    if (!groups.has(key)) groups.set(key, { id: `${providerName(r.provider)} · ${r.device_name}`, color: SERIES_COLORS[groups.size % SERIES_COLORS.length], points: [] })
    if (r[metric] != null) groups.get(key).points.push({ t: r.ts, v: r[metric] })
  }
  const series = [...groups.values()].filter((s) => s.points.length)
  return el('section', { class: 'overview-panel' },
    el('div', { class: 'head' }, el('h2', { text: tr('额度历史') }), chips([['five_hour', '5 小时'], ['weekly', '本周']], metric, (v) => { state.historyMetric = v; render() })),
    series.length ? timeChart(series) : el('div', { class: 'empty', text: tr('还没有额度历史记录') }),
    el('div', { class: 'chart-legend' }, series.map((s) => el('span', {}, el('i', { style: `background:${s.color}` }), s.id))),
    el('details', {}, el('summary', { text: tr('分析记录') }),
      el('div', { class: 'table-scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, ['日期', '来源', '设备', '5 小时', '本周'].map((h) => el('th', { text: tr(h) })))),
        el('tbody', {}, rows.slice().reverse().slice(0, 200).map((r) => el('tr', {},
          [md(r.ts) + ' ' + hm(r.ts), providerName(r.provider), r.device_name, r.five_hour == null ? '—' : r.five_hour + '%', r.weekly == null ? '—' : r.weekly + '%'].map((v) => el('td', { text: String(v) })))))))),
    el('p', { class: 'sub', text: tr('额度历史由 Mac 同步后记录，最多保留 90 天。') }))
}
function timeChart(series) {
  const points = series.flatMap((s) => s.points)
  const start = Math.min(...points.map((p) => p.t)), end = Math.max(...points.map((p) => p.t), start + 1)
  return chartCanvas(series.map((s) => ({ ...s, points: s.points.map((p) => ({ x: (p.t - start) / (end - start), y: p.v, label: md(p.t) + ' ' + hm(p.t) })) })),
    Array.from({ length: 5 }, (_, i) => ({ x: i / 4, label: md(start + (end - start) * i / 4) })), true)
}
function lineChart(labels, series, percent) {
  return chartCanvas(series.map((s) => ({ ...s, points: s.values.map((v, i) => ({ x: i / Math.max(labels.length - 1, 1), y: v, label: labels[i] })) })),
    labels.map((label, i) => ({ x: i / Math.max(labels.length - 1, 1), label })).filter((_, i) => i % Math.ceil(labels.length / 6) === 0 || i === labels.length - 1), percent)
}
function chartCanvas(series, labels, percent) {
  const box = el('div', { class: 'chart line-chart' })
  requestAnimationFrame(() => {
    if (!box.isConnected) return
    const W = Math.max(box.clientWidth, 260), H = 240, L = 48, R = 22, T = 12, B = 28
    const values = series.flatMap((s) => s.points.map((p) => p.y))
    const top = percent ? Math.max(100, ...values) : Math.max(1, ...values)
    const step = niceStep(top / 4), max = percent ? top : Math.ceil(top / step) * step
    const x = (v) => L + v * (W - L - R), y = (v) => T + (1 - v / max) * (H - T - B)
    const tip = el('div', { class: 'tip', hidden: true })
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': tr(percent ? '额度历史' : '项目用量趋势') },
      [0, 1, 2, 3, 4].map((i) => { const v = max * i / 4; return [svg('line', { class: 'grid-line', x1: L, x2: W - R, y1: y(v), y2: y(v) }), svg('text', { class: 'axis', x: L - 7, y: y(v) + 4, 'text-anchor': 'end' }, percent ? Math.round(v) + '%' : fmtTokens(v))] }),
      labels.map((p) => svg('text', { class: 'axis', x: x(p.x), y: H - 5, 'text-anchor': 'middle' }, p.label)),
      series.map((s, i) => [svg('polyline', { points: s.points.map((p) => `${x(p.x)},${y(p.y)}`).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': i >= 8 ? '5 3' : null }),
        s.points.map((p) => { const hit = svg('circle', { cx: x(p.x), cy: y(p.y), r: 4, fill: s.color });
          hit.append(svg('title', {}, `${s.id} · ${p.label} · ${percent ? p.y + '%' : fmtTokens(p.y)}`))
          return hit })]))
    box.replaceChildren(chart, tip)
  })
  return box
}
function handleLoadError(e) { if (e instanceof Unauthorized) return showLanding(); state.error = tr('连不上服务器，稍后会自动重试'); render() }

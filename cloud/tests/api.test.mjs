import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('../..', import.meta.url)))
import { buildSync } from 'esbuild'

// 使用实际 Hono 路由和 SQLite 执行 SQL；不连接线上 D1。
const dir = mkdtempSync(resolve(tmpdir(), 'quotlet-api-test-'))
const file = resolve(dir, 'routes.cjs')
buildSync({ stdin: { contents: `import { Hono } from 'hono'; import { requireAuth } from './src/auth'; import { ingest } from './src/ingest'; import { read } from './src/read'; const app = new Hono(); app.use('*', requireAuth); app.route('/api/ingest', ingest); app.route('/api', read); export default app;`, resolveDir: resolve('cloud'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: file })
const app = createRequire(import.meta.url)(file).default
const sqlite = `import sqlite3,json,sys
p=json.load(sys.stdin)
db=sqlite3.connect(p['path']);db.row_factory=sqlite3.Row;db.execute('PRAGMA foreign_keys=ON')
if 'script' in p: db.executescript(p['script']);out=[]
else:
 out=[]
 for s in p['statements']:
  cur=db.execute(s['sql'],s['args']);rows=[dict(r) for r in cur.fetchall()] if cur.description else []
  out.append({'results':rows,'meta':{'changes':max(cur.rowcount,0)}})
db.commit();print(json.dumps(out))`
function execute(payload) {
  const p = spawnSync('python3', ['-c', sqlite], { input: JSON.stringify({ path: resolve(dir, 'db.sqlite'), ...payload }), encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  return JSON.parse(p.stdout)
}
class Statement {
  constructor(sql, args = []) { this.sql = sql; this.args = args }
  bind(...args) { return new Statement(this.sql, args) }
  async all() { return execute({ statements: [this] })[0] }
  async first() { return (await this.all()).results[0] || null }
  async run() { return this.all() }
}
const DB = { prepare: (sql) => new Statement(sql), batch: async (statements) => execute({ statements }) }
const t = Date.now()
const token = 'local-test-mac', other = 'local-test-other'
const hash = (s) => createHash('sha256').update(s).digest('base64url')
execute({ script: readFileSync('cloud/migrations/0001_init.sql', 'utf8') + readFileSync('cloud/migrations/0002_m2.sql', 'utf8') })
execute({ statements: [
  { sql: 'INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)', args: ['u1', 'User One', t] },
  { sql: 'INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)', args: ['u2', 'User Two', t] },
  ...[['m1', 'u1', token], ['m2', 'u2', other]].map(([id, user, tok]) => ({ sql: 'INSERT INTO devices (id,user_id,kind,name,token_hash,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?)', args: [id, user, 'mac', 'MacBook M4 Max', hash(tok), t, t] })),
  { sql: 'INSERT INTO usage_latest VALUES (?,?,?,?,?)', args: ['m1', 'u1', 'Pro', '[{"kind":"session","percent":42}]', t] },
  { sql: 'INSERT INTO usage_history VALUES (?,?,?,?)', args: ['m1', t - 3600000, 42, 60] },
] })
execute({ script: readFileSync('cloud/migrations/0003_providers.sql', 'utf8') })
async function request(path, body, tok = token, method = body ? 'PUT' : 'GET') {
  return app.request('https://test.local/api' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }, { DB }, { waitUntil: () => {} })
}

test('旧 Claude 数据迁移后保留，同设备可以同时保存三个来源', async () => {
  let data = await (await request('/overview')).json()
  assert.equal(data.usage[0].provider, 'claude')
  assert.equal(data.usage[0].limits[0].percent, 42)
  for (const provider of ['claude', 'codex', 'gemini']) {
    const res = await request('/ingest/usage', { provider, plan: provider === 'codex' ? 'Plus' : 'Pro', fetched_at: t, limits: [{ kind: 'session', percent: provider === 'codex' ? 91 : provider === 'gemini' ? 18.5 : 45, resets_at: t + 7200000 }] })
    assert.equal(res.status, 200)
  }
  data = await (await request('/overview')).json()
  assert.deepEqual(data.usage.map((u) => u.provider).sort(), ['claude', 'codex', 'gemini'])
  const history = await (await request('/usage-history')).json()
  assert.deepEqual([...new Set(history.history.map((r) => r.provider))].sort(), ['claude', 'codex', 'gemini'])
})
test('会话上报保留来源和设备，来源筛选不混入其他提供方', async () => {
  const sessions = ['claude', 'codex', 'gemini'].map((source) => ({
    id: source + '-test', source, project: 'quotlet', title: 'Example',
    model: source === 'codex' ? 'gpt-6.1-sol' : source === 'gemini' ? 'gemini-4-neon-high' : 'claude-opus-5-5',
    status: 'running', status_at: t, started_at: t, last_activity_at: t,
  }))
  assert.equal((await request('/ingest/sessions', { sessions }, token, 'POST')).status, 200)
  for (const source of ['codex', 'gemini']) {
    const data = await (await request('/sessions?source=' + source)).json()
    assert.equal(data.sessions.length, 1)
    assert.equal(data.sessions[0].source, source)
    assert.equal(data.sessions[0].device_name, 'MacBook M4 Max')
  }
})
test('项目每日趋势与来源统计一致，其他账号不能读取数据', async () => {
  const rows = ['claude', 'codex', 'gemini'].map((source, i) => ({ day: '2026-11-18', source, project: 'quotlet', model: source, tokens_in: 10, tokens_out: (i + 1) * 100, requests: 1 }))
  assert.equal((await request('/ingest/daily', { full: true, rows })).status, 200)
  const stats = await (await request('/stats?from=2026-11-18&source=codex')).json()
  assert.equal(stats.daily[0].total, 210)
  assert.equal(stats.project_daily[0].tokens_out, 200)
  assert.equal(stats.projects[0].total, stats.project_daily[0].total)
  const geminiStats = await (await request('/stats?from=2026-11-18&source=gemini')).json()
  assert.equal(geminiStats.daily[0].total, 310)
  assert.equal(geminiStats.project_daily[0].tokens_out, 300)
  assert.equal((await (await request('/overview', null, other)).json()).usage.length, 0)
  assert.equal((await (await request('/usage-history', null, other)).json()).history.length, 0)
  assert.equal((await (await request('/sessions', null, other)).json()).sessions.length, 0)
  assert.equal((await request('/sessions', null, 'invalid')).status, 401)
})
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

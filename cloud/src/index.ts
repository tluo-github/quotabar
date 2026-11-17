import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'
import { auth, clearSession, requireAuth, type AppVars } from './auth'
import { now } from './util'

export interface Env {
  DB: D1Database
  USER_HUB: DurableObjectNamespace<UserHub>
  ASSETS: Fetcher
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
}

const app = new Hono<{ Bindings: Env; Variables: AppVars }>()

app.get('/api/health', (c) => c.json({ ok: true, time: now() }))

app.route('/', auth)

// 以下接口都要登录
app.use('/api/me', requireAuth)
app.use('/api/me/*', requireAuth)
app.use('/api/devices', requireAuth)
app.use('/api/devices/*', requireAuth)
app.use('/api/auth/logout', requireAuth)

app.get('/api/me', (c) => {
  const d = c.get('device')
  return c.json({ user: c.get('user'), device: { id: d.id, kind: d.kind, name: d.name } })
})

/** 删除账号：devices / identities 等通过外键级联删除 */
app.delete('/api/me', async (c) => {
  const userId = c.get('user').id
  const db = c.env.DB
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM session_events WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM daily_tokens WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM usage_history WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM commands WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM auth_codes WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ])
  clearSession(c)
  return c.json({ ok: true })
})

app.post('/api/auth/logout', async (c) => {
  await c.env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(now(), c.get('device').id).run()
  clearSession(c)
  return c.json({ ok: true })
})

app.get('/api/devices', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, name, app_version, last_seen_at, created_at, remote_enabled
       FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
  ).bind(c.get('user').id).all()
  return c.json({ devices: results, current: c.get('device').id })
})

app.delete('/api/devices/:id', async (c) => {
  const r = await c.env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(now(), c.req.param('id'), c.get('user').id).run()
  if (!r.meta.changes) return c.json({ error: 'not_found' }, 404)
  if (c.req.param('id') === c.get('device').id) clearSession(c)
  return c.json({ ok: true })
})

app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))

export class UserHub extends DurableObject<Env> {}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    // 清理过期的登录 code
    await env.DB.prepare('DELETE FROM auth_codes WHERE expires_at < ?').bind(now()).run()
  },
} satisfies ExportedHandler<Env>

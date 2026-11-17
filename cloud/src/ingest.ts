// Mac 上报：心跳、额度、会话、状态事件、每日 token。只接受 kind = mac 的设备 token。
//
// 免费套餐每次请求最多 50 条 D1 查询，所以批量写入一律用一条语句 + json_each(?)，
// 不按行拆成多条 INSERT。传进 json_each 的数据都是先在这里校验、重新序列化过的。

import { Hono } from 'hono'
import type { Env } from './index'
import type { AppVars } from './auth'
import { now } from './util'

export const ingest = new Hono<{ Bindings: Env; Variables: AppVars }>()

/** Mac 能上报的会话状态；offline 是服务端按心跳推算的，不接受上报 */
export const STATUSES = ['idle', 'running', 'waiting', 'done', 'ended'] as const
const HISTORY_GAP = 15 * 60 * 1000

ingest.use('*', async (c, next) => {
  if (c.get('device').kind !== 'mac') return c.json({ error: 'mac_only' }, 403)
  await next()
})

// ---------- 校验小工具 ----------

function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

function int(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : fallback
}

/** 毫秒时间戳；不接受未来超过 5 分钟的时间（Mac 时钟不准时截到现在） */
function ts(v: unknown, fallback: number): number {
  const t = int(v, fallback)
  return t > 0 ? Math.min(t, now() + 5 * 60_000) : fallback
}

function status(v: unknown): string | null {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? v : null
}

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => null)
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
}

function list(v: unknown, max: number): Record<string, unknown>[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}

const SESSION_ID = /^[\w-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

// ---------- 心跳 ----------

ingest.post('/heartbeat', async (c) => {
  const b = await body(c)
  await c.env.DB.prepare('UPDATE devices SET last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?')
    .bind(now(), str(b.app_version, 32), c.get('device').id).run()
  return c.json({ ok: true, time: now() })
})

// ---------- 额度 ----------

/** {plan, limits:[{kind,title,scope,percent,resets_at,severity}], fetched_at} */
ingest.put('/usage', async (c) => {
  const b = await body(c)
  const raw = list(b.limits, 20)
  if (!raw) return c.json({ error: 'bad_request' }, 400)
  const limits = raw.map((l) => ({
    kind: str(l.kind, 40) ?? 'unknown',
    title: str(l.title, 80),
    scope: str(l.scope, 60),
    percent: typeof l.percent === 'number' && Number.isFinite(l.percent) ? Math.min(Math.max(l.percent, 0), 1000) : 0,
    resets_at: typeof l.resets_at === 'number' ? int(l.resets_at) : null,
    severity: str(l.severity, 20),
  }))
  const device = c.get('device')
  const fetchedAt = ts(b.fetched_at, now())
  const fiveHour = limits.find((l) => l.kind === 'session')?.percent ?? null
  const weekly = limits.find((l) => l.kind === 'weekly_all')?.percent ?? null
  const db = c.env.DB
  await db.batch([
    db.prepare(
      `INSERT INTO usage_latest (device_id, user_id, plan, limits, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET plan = excluded.plan, limits = excluded.limits, fetched_at = excluded.fetched_at`,
    ).bind(device.id, device.user_id, str(b.plan, 20), JSON.stringify(limits), fetchedAt),
    // 趋势图用：同一台设备最多每 15 分钟存一条
    db.prepare(
      `INSERT INTO usage_history (device_id, ts, five_hour, weekly)
       SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM usage_history WHERE device_id = ?1 AND ts > ?5)`,
    ).bind(device.id, fetchedAt, fiveHour, weekly, fetchedAt - HISTORY_GAP),
  ])
  return c.json({ ok: true })
})

// ---------- 会话 ----------

/**
 * {sessions:[{id, project, title, model, status, status_detail, status_at,
 *             started_at, last_activity_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, requests}]}
 * 只发有变化的，单次最多 100 条。状态以 Mac 为准（没开 hooks 时是 Mac 按日志时间估算的）。
 */
ingest.post('/sessions', async (c) => {
  const b = await body(c)
  const raw = list(b.sessions, 100)
  if (!raw) return c.json({ error: 'bad_request' }, 400)
  const t = now()
  const rows = raw.flatMap((s) => {
    const id = typeof s.id === 'string' && SESSION_ID.test(s.id) ? s.id : null
    const st = status(s.status)
    if (!id || !st) return []
    const last = ts(s.last_activity_at, t)
    return [{
      id,
      project: str(s.project, 120) ?? '?',
      title: str(s.title, 200),
      model: str(s.model, 80),
      status: st,
      status_detail: str(s.status_detail, 200),
      status_at: ts(s.status_at, t),
      started_at: ts(s.started_at, last),
      last_activity_at: last,
      tokens_in: int(s.tokens_in),
      tokens_out: int(s.tokens_out),
      tokens_cache_read: int(s.tokens_cache_read),
      tokens_cache_write: int(s.tokens_cache_write),
      requests: int(s.requests),
    }]
  })
  if (!rows.length) return c.json({ ok: true, count: 0 })

  const db = c.env.DB
  const user = c.get('user').id
  const device = c.get('device').id
  const json = JSON.stringify(rows)

  // 先查旧状态：状态变了才记一条时间线
  const { results: before } = await db.prepare(
    'SELECT id, status FROM sessions WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))',
  ).bind(user, JSON.stringify(rows.map((r) => r.id))).all<{ id: string; status: string }>()
  const old = new Map(before.map((r) => [r.id, r.status]))
  // 新会话只在正在进行时记一条（第一次同步时几百个已完成的会话不记）
  const changed = rows.filter((r) => old.has(r.id) ? old.get(r.id) !== r.status : r.status === 'running' || r.status === 'waiting')

  const stmts = [
    db.prepare(
      `INSERT INTO sessions (user_id, id, device_id, project, title, model, status, status_detail, status_at,
                             started_at, last_activity_at, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, requests)
       SELECT ?1, j.value->>'id', ?2, j.value->>'project', j.value->>'title', j.value->>'model',
              j.value->>'status', j.value->>'status_detail', j.value->>'status_at',
              j.value->>'started_at', j.value->>'last_activity_at',
              j.value->>'tokens_in', j.value->>'tokens_out', j.value->>'tokens_cache_read', j.value->>'tokens_cache_write',
              j.value->>'requests'
         FROM json_each(?3) j WHERE true
       ON CONFLICT(user_id, id) DO UPDATE SET
         device_id = excluded.device_id, project = excluded.project, title = excluded.title, model = excluded.model,
         status_at = CASE WHEN sessions.status = excluded.status THEN sessions.status_at ELSE excluded.status_at END,
         status = excluded.status, status_detail = excluded.status_detail,
         started_at = excluded.started_at, last_activity_at = excluded.last_activity_at,
         tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write,
         requests = excluded.requests`,
    ).bind(user, device, json),
  ]
  if (changed.length) {
    stmts.push(db.prepare(
      `INSERT INTO session_events (user_id, session_id, ts, status, detail)
       SELECT ?1, j.value->>'id', j.value->>'status_at', j.value->>'status', j.value->>'status_detail' FROM json_each(?2) j`,
    ).bind(user, JSON.stringify(changed)))
  }
  await db.batch(stmts)
  return c.json({ ok: true, count: rows.length })
})

// ---------- 状态事件（里程碑 3 的 hooks 用） ----------

/** {events:[{session_id, ts, status, detail}]}，状态一变就发，单次最多 200 条 */
ingest.post('/events', async (c) => {
  const b = await body(c)
  const raw = list(b.events, 200)
  if (!raw) return c.json({ error: 'bad_request' }, 400)
  const t = now()
  const events = raw.flatMap((e) => {
    const sid = typeof e.session_id === 'string' && SESSION_ID.test(e.session_id) ? e.session_id : null
    const st = status(e.status)
    return sid && st ? [{ session_id: sid, ts: ts(e.ts, t), status: st, detail: str(e.detail, 200) }] : []
  })
  if (!events.length) return c.json({ ok: true, count: 0 })
  // 每个会话只用最新的一条去更新当前状态
  const latest = new Map<string, (typeof events)[number]>()
  for (const e of events) if ((latest.get(e.session_id)?.ts ?? -1) <= e.ts) latest.set(e.session_id, e)

  const db = c.env.DB
  const user = c.get('user').id
  await db.batch([
    db.prepare(
      `INSERT INTO session_events (user_id, session_id, ts, status, detail)
       SELECT ?1, j.value->>'session_id', j.value->>'ts', j.value->>'status', j.value->>'detail' FROM json_each(?2) j`,
    ).bind(user, JSON.stringify(events)),
    db.prepare(
      `UPDATE sessions SET status = j.value->>'status', status_detail = j.value->>'detail', status_at = j.value->>'ts'
         FROM json_each(?2) j
        WHERE sessions.user_id = ?1 AND sessions.id = j.value->>'session_id' AND sessions.status_at <= j.value->>'ts'`,
    ).bind(user, JSON.stringify([...latest.values()])),
  ])
  return c.json({ ok: true, count: events.length })
})

// ---------- 每日 token ----------

/**
 * {full?: true, rows:[{day, project, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, requests}]}
 * Mac 按本机时区算好日期。平时只发变了的行；app 启动后第一次发 full，服务端先清掉这台设备的旧数据。
 */
ingest.put('/daily', async (c) => {
  const b = await body(c)
  const raw = list(b.rows, 3000)
  if (!raw) return c.json({ error: 'bad_request' }, 400)
  const rows = raw.flatMap((r) => {
    if (typeof r.day !== 'string' || !DAY.test(r.day)) return []
    return [{
      day: r.day,
      project: str(r.project, 120) ?? '?',
      model: str(r.model, 80) ?? '?',
      tokens_in: int(r.tokens_in),
      tokens_out: int(r.tokens_out),
      tokens_cache_read: int(r.tokens_cache_read),
      tokens_cache_write: int(r.tokens_cache_write),
      requests: int(r.requests),
    }]
  })
  const db = c.env.DB
  const device = c.get('device')
  const stmts: D1PreparedStatement[] = []
  if (b.full === true) stmts.push(db.prepare('DELETE FROM daily_tokens WHERE device_id = ?').bind(device.id))
  if (rows.length) {
    stmts.push(db.prepare(
      `INSERT INTO daily_tokens (device_id, user_id, day, project, model,
                                 tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, requests)
       SELECT ?1, ?2, j.value->>'day', j.value->>'project', j.value->>'model',
              j.value->>'tokens_in', j.value->>'tokens_out', j.value->>'tokens_cache_read', j.value->>'tokens_cache_write',
              j.value->>'requests'
         FROM json_each(?3) j WHERE true
       ON CONFLICT(device_id, day, project, model) DO UPDATE SET
         tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
         tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write,
         requests = excluded.requests`,
    ).bind(device.id, device.user_id, JSON.stringify(rows)))
  }
  if (stmts.length) await db.batch(stmts)
  return c.json({ ok: true, count: rows.length })
})

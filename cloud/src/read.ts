// 读取接口：网站 / App 用。所有查询都限定在当前用户。

import { Hono } from 'hono'
import type { Env } from './index'
import type { AppVars } from './auth'
import { now } from './util'

export const read = new Hono<{ Bindings: Env; Variables: AppVars }>()

/** 这么久没收到 Mac 的任何请求就算离线（Mac 没变化时每 2 分钟发一次心跳） */
export const ONLINE_WINDOW = 3 * 60 * 1000

const SESSION_COLS = `s.id, s.device_id, d.name AS device_name, d.last_seen_at AS device_seen_at,
  s.project, s.title, s.model, s.status, s.status_detail, s.status_at, s.started_at, s.last_activity_at,
  s.tokens_in, s.tokens_out, s.tokens_cache_read, s.tokens_cache_write, s.requests`

interface SessionRow {
  id: string; device_id: string; device_name: string | null; device_seen_at: number | null
  status: string; [k: string]: unknown
}

/** Mac 离线了，“执行中 / 等待授权”就不可信了，改成 offline 显示 */
function present(s: SessionRow, t: number) {
  const { device_seen_at, ...rest } = s
  const live = s.status === 'running' || s.status === 'waiting'
  const offline = live && (!device_seen_at || t - device_seen_at > ONLINE_WINDOW)
  return { ...rest, status: offline ? 'offline' : s.status }
}

/** 概览：每台 Mac 的额度 + Mac 设备在线状态 + 最近的会话。网站每分钟拉一次。 */
read.get('/overview', async (c) => {
  const db = c.env.DB
  const user = c.get('user').id
  const t = now()
  const [usage, devices, sessions] = await db.batch([
    db.prepare(
      `SELECT u.device_id, d.name AS device_name, u.plan, u.limits, u.fetched_at
         FROM usage_latest u JOIN devices d ON d.id = u.device_id
        WHERE u.user_id = ? AND d.revoked_at IS NULL ORDER BY u.fetched_at DESC`,
    ).bind(user),
    db.prepare(
      `SELECT id, name, app_version, last_seen_at FROM devices
        WHERE user_id = ? AND kind = 'mac' AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
    ).bind(user),
    db.prepare(
      `SELECT ${SESSION_COLS} FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.user_id = ? ORDER BY s.last_activity_at DESC LIMIT 30`,
    ).bind(user),
  ])
  return c.json({
    now: t,
    usage: (usage.results as { limits: string }[]).map((u) => ({ ...u, limits: JSON.parse(u.limits) })),
    devices: (devices.results as { last_seen_at: number | null }[]).map((d) => ({
      ...d, online: !!d.last_seen_at && t - d.last_seen_at <= ONLINE_WINDOW,
    })),
    sessions: (sessions.results as SessionRow[]).map((s) => present(s, t)),
  })
})

/** 会话列表：?status=&device=&days=&cursor=，按最后活动时间倒序，每页 50 条 */
read.get('/sessions', async (c) => {
  const user = c.get('user').id
  const t = now()
  const where = ['s.user_id = ?']
  const args: unknown[] = [user]
  const status = c.req.query('status')
  if (status) { where.push('s.status = ?'); args.push(status) }
  const device = c.req.query('device')
  if (device) { where.push('s.device_id = ?'); args.push(device) }
  const days = Number(c.req.query('days'))
  if (days > 0) { where.push('s.last_activity_at >= ?'); args.push(t - Math.min(days, 365) * 86400_000) }
  // cursor = "<last_activity_at>:<id>"，上一页最后一条
  const cursor = c.req.query('cursor')?.match(/^(\d+):([\w-]{1,64})$/)
  if (cursor) {
    where.push('(s.last_activity_at < ? OR (s.last_activity_at = ? AND s.id < ?))')
    args.push(Number(cursor[1]), Number(cursor[1]), cursor[2])
  }
  const limit = 50
  const { results } = await c.env.DB.prepare(
    `SELECT ${SESSION_COLS} FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
      WHERE ${where.join(' AND ')} ORDER BY s.last_activity_at DESC, s.id DESC LIMIT ${limit + 1}`,
  ).bind(...args).all<SessionRow>()
  const page = results.slice(0, limit)
  const last = page[page.length - 1] as (SessionRow & { last_activity_at: number }) | undefined
  return c.json({
    sessions: page.map((s) => present(s, t)),
    next_cursor: results.length > limit && last ? `${last.last_activity_at}:${last.id}` : null,
  })
})

/** 会话详情 + 状态时间线（最近 200 条） */
read.get('/sessions/:id', async (c) => {
  const db = c.env.DB
  const user = c.get('user').id
  const id = c.req.param('id')
  const [s, events] = await db.batch([
    db.prepare(`SELECT ${SESSION_COLS} FROM sessions s LEFT JOIN devices d ON d.id = s.device_id WHERE s.user_id = ? AND s.id = ?`)
      .bind(user, id),
    db.prepare('SELECT ts, status, detail FROM session_events WHERE user_id = ? AND session_id = ? ORDER BY ts DESC LIMIT 200')
      .bind(user, id),
  ])
  const row = s.results[0] as SessionRow | undefined
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json({ session: present(row, now()), events: events.results })
})

/**
 * 统计：每日、按项目、按模型的 token（所有 Mac 加起来）。
 * ?from=YYYY-MM-DD（浏览器按本地时区算好），没有就用 ?days=30 按 UTC 推算。
 */
read.get('/stats', async (c) => {
  const db = c.env.DB
  const user = c.get('user').id
  let from = c.req.query('from') ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 90)
    from = new Date(now() - (days - 1) * 86400_000).toISOString().slice(0, 10)
  }
  const sums = `SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
    SUM(tokens_cache_read) AS tokens_cache_read, SUM(tokens_cache_write) AS tokens_cache_write, SUM(requests) AS requests,
    SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_write) AS total`
  const [daily, projects, models] = await db.batch([
    db.prepare(`SELECT day, ${sums} FROM daily_tokens WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day`).bind(user, from),
    db.prepare(`SELECT project, ${sums} FROM daily_tokens WHERE user_id = ? AND day >= ? GROUP BY project ORDER BY total DESC LIMIT 20`).bind(user, from),
    db.prepare(`SELECT model, ${sums} FROM daily_tokens WHERE user_id = ? AND day >= ? GROUP BY model ORDER BY total DESC`).bind(user, from),
  ])
  return c.json({ from, daily: daily.results, projects: projects.results, models: models.results })
})

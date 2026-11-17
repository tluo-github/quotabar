// 登录：GitHub OAuth（网页），Mac/iOS 通过一次性 code + PKCE 换设备 token。
// Apple / Google 以后按同样的结构加：/auth/<provider>/start、/auth/<provider>/callback → finishLogin()。

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Env } from './index'
import { hashToken, now, pkceChallenge, randomToken, safeEqual } from './util'
import { loginPage, errorPage, returnToAppPage } from './pages'

export type AppVars = { user: UserRow; device: DeviceRow }
type C = Context<{ Bindings: Env; Variables: AppVars }>

export interface UserRow { id: string; email: string | null; name: string | null; created_at: number }
export interface DeviceRow {
  id: string; user_id: string; kind: string; name: string
  remote_enabled: number; last_seen_at: number | null; created_at: number
}

const SESSION_COOKIE = 'qb_session'
const OAUTH_COOKIE = 'qb_oauth'
const CODE_TTL = 5 * 60 * 1000
const CLIENTS = ['web', 'mac', 'ios'] as const
type Client = (typeof CLIENTS)[number]

/** 登录开始时带过来的参数，存在短期 cookie 里，回调时取回 */
interface PendingLogin {
  state: string          // 发给 GitHub 的 state，回调时比对，防 CSRF
  client: Client
  clientState?: string   // Mac/iOS 自己的 state，原样带回
  challenge?: string     // Mac/iOS 的 PKCE code_challenge
}

function readPending(c: C): PendingLogin | null {
  const raw = getCookie(c, OAUTH_COOKIE)
  if (!raw) return null
  try { return JSON.parse(atob(raw)) as PendingLogin } catch { return null }
}

/** 校验 /login 上的参数；Mac/iOS 必须带 state 和 code_challenge */
function parseLoginParams(c: C): Omit<PendingLogin, 'state'> | string {
  const client = (c.req.query('client') ?? 'web') as Client
  if (!CLIENTS.includes(client)) return '不认识的客户端'
  if (client === 'web') return { client }
  const clientState = c.req.query('state') ?? ''
  const challenge = c.req.query('code_challenge') ?? ''
  if (!/^[\w-]{8,128}$/.test(clientState) || !/^[\w-]{43}$/.test(challenge)) return '登录参数不完整'
  return { client, clientState, challenge }
}

export const auth = new Hono<{ Bindings: Env; Variables: AppVars }>()

auth.get('/login', (c) => {
  const p = parseLoginParams(c)
  if (typeof p === 'string') return c.html(errorPage(p), 400)
  return c.html(loginPage(new URL(c.req.url).search))
})

// ---------- GitHub ----------

auth.get('/auth/github/start', (c) => {
  const p = parseLoginParams(c)
  if (typeof p === 'string') return c.html(errorPage(p), 400)
  const pending: PendingLogin = { ...p, state: randomToken() }
  setCookie(c, OAUTH_COOKIE, btoa(JSON.stringify(pending)), {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth', maxAge: 600,
  })
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', new URL('/auth/github/callback', c.req.url).toString())
  url.searchParams.set('scope', 'read:user user:email')
  url.searchParams.set('state', pending.state)
  url.searchParams.set('allow_signup', 'true')
  return c.redirect(url.toString())
})

auth.get('/auth/github/callback', async (c) => {
  const pending = readPending(c)
  deleteCookie(c, OAUTH_COOKIE, { path: '/auth' })
  const state = c.req.query('state') ?? ''
  if (!pending || !safeEqual(state, pending.state)) return c.html(errorPage('登录已过期，请重新登录'), 400)
  if (c.req.query('error')) return c.html(errorPage('你取消了 GitHub 授权'), 400)
  const code = c.req.query('code')
  if (!code) return c.html(errorPage('GitHub 没有返回授权码'), 400)

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL('/auth/github/callback', c.req.url).toString(),
    }),
  })
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as { access_token?: string }
  if (!tokenJson.access_token) return c.html(errorPage('GitHub 登录失败，请重试'), 502)

  const gh = (path: string) => fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'quotlet-cloud',
    },
  })
  const userRes = await gh('/user')
  if (!userRes.ok) return c.html(errorPage('读取 GitHub 账号失败'), 502)
  const ghUser = (await userRes.json()) as { id: number; login: string; name: string | null }
  let email: string | null = null
  const emailsRes = await gh('/user/emails')
  if (emailsRes.ok) {
    const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
    email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null
  }
  // access token 用完就丢，不保存

  const userId = await upsertIdentity(c.env.DB, 'github', String(ghUser.id), email, ghUser.name || ghUser.login)
  return finishLogin(c, pending, userId)
})

/** 找到或新建账号，返回 user id */
async function upsertIdentity(db: D1Database, provider: string, subject: string, email: string | null, name: string): Promise<string> {
  const existing = await db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .bind(provider, subject).first<{ user_id: string }>()
  if (existing) {
    await db.batch([
      db.prepare('UPDATE identities SET email = ? WHERE provider = ? AND subject = ?').bind(email, provider, subject),
      db.prepare('UPDATE users SET email = COALESCE(?, email), name = COALESCE(name, ?) WHERE id = ?').bind(email, name, existing.user_id),
    ])
    return existing.user_id
  }
  const id = crypto.randomUUID()
  const t = now()
  await db.batch([
    db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(id, email, name, t),
    db.prepare('INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)').bind(provider, subject, id, email, t),
  ])
  return id
}

/** 第三方登录成功之后：网页直接发 cookie；Mac/iOS 发一次性 code 跳回 App */
async function finishLogin(c: C, pending: PendingLogin, userId: string) {
  if (pending.client === 'web') {
    const token = await createDevice(c.env.DB, userId, 'web', browserName(c.req.header('User-Agent')))
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 365 * 86400,
    })
    return c.redirect('/')
  }
  const code = randomToken()
  await c.env.DB.prepare('INSERT INTO auth_codes (code_hash, user_id, client, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashToken(code), userId, pending.client, pending.challenge!, now() + CODE_TTL).run()
  const scheme = pending.client === 'mac' ? 'quotlet' : 'quotlet-ios'
  const appUrl = `${scheme}://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(pending.clientState!)}`
  // 显示一个“正在返回 App”的页面，由它跳到 quotlet://；浏览器问要不要打开时也有按钮可点
  return c.html(returnToAppPage(appUrl, pending.client))
}

async function createDevice(db: D1Database, userId: string, kind: string, name: string): Promise<string> {
  const token = randomToken()
  await db.prepare('INSERT INTO devices (id, user_id, kind, name, token_hash, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, kind, name.slice(0, 60), await hashToken(token), now(), now()).run()
  return token
}

function browserName(ua: string | undefined): string {
  if (!ua) return '浏览器'
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : ''
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '浏览器'
  return os ? `${br} · ${os}` : br
}

// ---------- Mac / iOS 用 code 换 token ----------

auth.post('/api/auth/exchange', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { code?: string; code_verifier?: string; device?: { name?: string } } | null
  if (!body?.code || !body.code_verifier) return c.json({ error: 'bad_request' }, 400)
  const db = c.env.DB
  const codeHash = await hashToken(body.code)
  // 先删再用：同一个 code 只能换一次
  const row = await db.prepare('DELETE FROM auth_codes WHERE code_hash = ? RETURNING user_id, client, code_challenge, expires_at')
    .bind(codeHash).first<{ user_id: string; client: string; code_challenge: string; expires_at: number }>()
  if (!row || row.expires_at < now()) return c.json({ error: 'invalid_code' }, 400)
  if (!safeEqual(await pkceChallenge(body.code_verifier), row.code_challenge)) return c.json({ error: 'invalid_verifier' }, 400)
  const name = (body.device?.name || (row.client === 'mac' ? 'Mac' : 'iPhone')).trim()
  const token = await createDevice(db, row.user_id, row.client, name)
  const user = await db.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(row.user_id).first()
  return c.json({ token, user })
})

// ---------- 鉴权中间件 ----------

/** Bearer token（Mac/iOS）或 cookie（网页）。用 cookie 的写请求要检查 Origin，防跨站请求。 */
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> = async (c, next) => {
  const header = c.req.header('Authorization')
  let token: string | undefined
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7)
  } else {
    token = getCookie(c, SESSION_COOKIE)
    if (token && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('Origin')
      if (origin !== new URL(c.req.url).origin) return c.json({ error: 'bad_origin' }, 403)
    }
  }
  if (!token) return c.json({ error: 'unauthorized' }, 401)
  const db = c.env.DB
  const device = await db.prepare(
    'SELECT id, user_id, kind, name, remote_enabled, last_seen_at, created_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL',
  ).bind(await hashToken(token)).first<DeviceRow>()
  if (!device) return c.json({ error: 'unauthorized' }, 401)
  const user = await db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').bind(device.user_id).first<UserRow>()
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  // 最多每分钟写一次 last_seen，省 D1 写入额度
  const t = now()
  if (!device.last_seen_at || t - device.last_seen_at > 60_000) {
    c.executionCtx.waitUntil(db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(t, device.id).run())
  }
  c.set('user', user)
  c.set('device', device)
  await next()
}

export function clearSession(c: C) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

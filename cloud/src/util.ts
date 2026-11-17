// 小工具：随机 token、哈希、base64url、cookie

const enc = new TextEncoder()

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 字节随机数，base64url 编码（43 个字符） */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(text))
}

/** 数据库里只存 token 的哈希 */
export async function hashToken(token: string): Promise<string> {
  return base64url(await sha256(token))
}

/** PKCE S256：base64url(sha256(verifier)) */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier))
}

/** 两个字符串等长比较，避免按字节提前返回 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function now(): number {
  return Date.now()
}

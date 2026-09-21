import type { Env } from './env'
import { apiError, json, hashPassword, verifyPassword, createSession, getUserFromRequest, nowIso, genId, safeJsonParse } from './util'

interface SignupBody { email?: string; password?: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function handleSignup(env: Env, request: Request): Promise<Response> {
  const body = safeJsonParse<SignupBody>(await request.text().catch(() => ''), {})
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''
  if (!EMAIL_RE.test(email)) return apiError('ایمیل معتبر نیست')
  if (password.length < 6) return apiError('رمز عبور باید حداقل ۶ کاراکتر باشد')

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  if (existing) return apiError('این ایمیل قبلاً ثبت شده است', 409)

  // The very first account becomes the platform admin.
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>()
  const role = (count?.c ?? 0) === 0 ? 'admin' : 'user'

  const id = genId()
  await env.DB.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, await hashPassword(password), role, nowIso())
    .run()

  const { token } = await createSession(env, id)
  return json({ token, user: { id, email, role } })
}

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  const body = safeJsonParse<SignupBody>(await request.text().catch(() => ''), {})
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''

  const row = await env.DB.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; password_hash: string; role: string }>()
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    return apiError('ایمیل یا رمز عبور اشتباه است', 401)
  }
  const { token } = await createSession(env, row.id)
  return json({ token, user: { id: row.id, email: row.email, role: row.role ?? 'user' } })
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  return json({ success: true })
}

/** The configured owner email, normalised (emails are stored lowercased). */
function ownerEmail(env: Env): string {
  return (env.OWNER_EMAIL ?? '').trim().toLowerCase()
}

/**
 * Is this account the panel owner?
 *
 * The owner is the account named by `OWNER_EMAIL` (set in `[vars]` of
 * wrangler.toml, e.g. `milad201400@gmail.com`). Only the owner sees and manages
 * the deployer bot; every other panel user and every additional admin is kept
 * out of that section entirely.
 *
 * If no `OWNER_EMAIL` is configured — or that account has not signed up yet —
 * the installation's first account owns the panel, so the section can never end
 * up with nobody able to open it.
 */
export async function isOwner(env: Env, userId: string): Promise<boolean> {
  const email = ownerEmail(env)
  if (email) {
    const owner = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(email)
      .first<{ id: string }>()
    if (owner) return owner.id === userId
  }
  const first = await env.DB.prepare('SELECT id FROM users ORDER BY created_at, id LIMIT 1').first<{ id: string }>()
  return !!first && first.id === userId
}

export async function handleMe(env: Env, request: Request): Promise<Response> {
  const user = await getUserFromRequest(env, request)
  if (!user) return apiError('نشست منقضی شده است', 401)
  const owner = await isOwner(env, user.id)
  // The owner runs this installation, so it always holds admin rights — even
  // when its `role` column says otherwise (the owner account is not necessarily
  // the first one created).
  return json({ user: { ...user, role: owner ? 'admin' : user.role, is_owner: owner } })
}

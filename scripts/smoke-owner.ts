/**
 * Smoke test for panel ownership (worker/auth.ts).
 *
 * Ownership decides who sees the Telegram deployer bot and the admin section, so
 * the rules must be exact:
 *   1. the account named by `OWNER_EMAIL` owns the panel — even if another
 *      account was created first,
 *   2. if that email has not signed up yet, the first account keeps control
 *      (the bot section can never become unreachable),
 *   3. with no `OWNER_EMAIL` configured, the first account owns the panel,
 *   4. the lookup is case/whitespace insensitive,
 *   5. login/signup hand the web app the *effective* user — owner ⇒ role admin
 *      and `is_owner: true` — because the navigation is rendered from that
 *      payload, and the stored role is healed to `admin` at the same time,
 *   6. a non-owner gets neither.
 */
import type { Env } from '../worker/env'
import { isOwner, handleLogin, handleMe } from '../worker/auth'
import { hashPassword } from '../worker/util'

interface Row {
  id: string
  email: string
  created_at: string
  role?: string
  password?: string
}

const firstAccount: Row = { id: 'u-first', email: 'first@example.com', created_at: '2026-01-01T00:00:00.000Z', role: 'admin' }
const milad: Row = { id: 'u-milad', email: 'milad201400@gmail.com', created_at: '2026-05-05T00:00:00.000Z', role: 'user' }

/** Minimal in-memory D1: the handful of statements worker/auth.ts runs. */
function makeEnv(rows: Row[], ownerEmail?: string, passwords: Record<string, string> = {}) {
  const updates: string[] = []
  const sessions = new Map<string, string>()
  const users = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))

  function run(sql: string, binds: unknown[]): unknown {
    if (/INSERT INTO sessions/i.test(sql)) {
      sessions.set(String(binds[0]), String(binds[1]))
      return { meta: { changes: 1 } }
    }
    if (/UPDATE users SET role/i.test(sql)) {
      updates.push(`${String(binds[0])}:${String(binds[1])}`)
      const row = users.find((u) => u.id === binds[1])
      if (row) row.role = String(binds[0])
      return { meta: { changes: 1 } }
    }
    if (/JOIN users u/i.test(sql)) {
      const userId = sessions.get(String(binds[0]))
      const row = users.find((u) => u.id === userId)
      return row ? { id: row.id, email: row.email, role: row.role, max_deployments: 0 } : null
    }
    if (/password_hash/i.test(sql)) {
      const row = users.find((u) => u.email === binds[0])
      return row ? { id: row.id, email: row.email, password_hash: passwords[row.email] ?? '', role: row.role } : null
    }
    if (/lower\(email\)/i.test(sql)) {
      const want = String(binds[0])
      const hit = users.find((u) => u.email.toLowerCase() === want)
      return hit ? { id: hit.id } : null
    }
    return users.length ? { id: users[0].id } : null
  }

  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => run(sql, binds),
        all: async () => ({ results: [] as unknown[] }),
        run: async () => run(sql, binds),
      }),
      first: async () => run(sql, []),
      all: async () => ({ results: [] as unknown[] }),
      run: async () => run(sql, []),
    }),
  }
  return { env: { DB: db, ASSETS: {} as Fetcher, OWNER_EMAIL: ownerEmail } as unknown as Env, updates, users }
}

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  console.log('۱) مالک تنظیم‌شده (OWNER_EMAIL) صاحب پنل است، نه اولین حساب')
  const pinned = makeEnv([firstAccount, milad], 'milad201400@gmail.com')
  check('حساب مالک است', await isOwner(pinned.env, milad.id))
  check('حساب قدیمی‌تر مالک نیست', !(await isOwner(pinned.env, firstAccount.id)))

  console.log('\n۲) اگر حساب مالک هنوز ثبت‌نام نکرده، اولین حساب کنترل را نگه می‌دارد')
  const notSignedUp = makeEnv([firstAccount], 'milad201400@gmail.com')
  check('اولین حساب مالک است', await isOwner(notSignedUp.env, firstAccount.id))
  check('حساب ناشناس مالک نیست', !(await isOwner(notSignedUp.env, milad.id)))

  console.log('\n۳) بدون OWNER_EMAIL، اولین حساب مالک است (رفتار پیشین)')
  const legacy = makeEnv([firstAccount, milad])
  check('اولین حساب مالک است', await isOwner(legacy.env, firstAccount.id))
  check('بقیه مالک نیستند', !(await isOwner(legacy.env, milad.id)))
  check('حساب ناموجود مالک نیست', !(await isOwner(legacy.env, 'ghost')))

  console.log('\n۴) ایمیل با فاصله و حروف بزرگ هم درست تطبیق داده می‌شود')
  const messy = makeEnv([milad], '  Milad201400@Gmail.com  ')
  check('فاصله و بزرگ‌بودن حروف مشکلی ایجاد نمی‌کند', await isOwner(messy.env, milad.id))

  // ── login / me carry the effective role ────────────────────────────────────
  const password = 'correct-horse-battery'
  const hash = await hashPassword(password)
  const ownerEnv = makeEnv(
    [firstAccount, milad],
    'milad201400@gmail.com',
    { 'milad201400@gmail.com': hash, 'first@example.com': hash },
  )

  console.log('\n۵) ورود مالک → نقش admin و is_owner، حتی وقتی ستون role = user است')
  const loginRes = await handleLogin(
    ownerEnv.env,
    new Request('https://panel.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'milad201400@gmail.com', password }),
    }),
  )
  const login = (await loginRes.json()) as { token?: string; user?: { email: string; role: string; is_owner?: boolean } }
  check('ورود موفق', loginRes.status === 200 && !!login.token, `status=${loginRes.status}`)
  check('نقش مؤثر admin است', login.user?.role === 'admin', String(login.user?.role))
  check('is_owner درست است', login.user?.is_owner === true)
  check('ستون role هم به admin اصلاح شد', ownerEnv.updates.includes('admin:u-milad'), ownerEnv.updates.join(','))

  console.log('\n۶) /auth/me همان تصویر مؤثر را برمی‌گرداند (نوار کناری از همین ساخته می‌شود)')
  const meRes = await handleMe(
    ownerEnv.env,
    new Request('https://panel.test/api/auth/me', { headers: { Authorization: `Bearer ${login.token}` } }),
  )
  const me = (await meRes.json()) as { user?: { role: string; is_owner?: boolean } }
  check('me → admin', me.user?.role === 'admin', String(me.user?.role))
  check('me → is_owner', me.user?.is_owner === true)

  console.log('\n۷) کاربر و ادمینِ غیرمالک، مالک محسوب نمی‌شوند')
  const otherRes = await handleLogin(
    ownerEnv.env,
    new Request('https://panel.test/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'first@example.com', password }),
    }),
  )
  const other = (await otherRes.json()) as { user?: { role: string; is_owner?: boolean } }
  check('نقش همان admin ذخیره‌شده می‌ماند', other.user?.role === 'admin', String(other.user?.role))
  check('is_owner = false', other.user?.is_owner === false)

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

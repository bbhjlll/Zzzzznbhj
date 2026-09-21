/**
 * Smoke test for panel ownership (worker/auth.ts → isOwner).
 *
 * Ownership decides who sees the Telegram deployer bot, so the rules must be
 * exact:
 *   1. the account named by `OWNER_EMAIL` owns the panel — even if another
 *      account was created first,
 *   2. if that email has not signed up yet, the first account keeps control
 *      (the bot section can never become unreachable),
 *   3. with no `OWNER_EMAIL` configured, the first account owns the panel,
 *   4. the lookup is case/whitespace insensitive.
 */
import type { Env } from '../worker/env'
import { isOwner } from '../worker/auth'

interface Row {
  id: string
  email: string
  created_at: string
}

const firstAccount: Row = { id: 'u-first', email: 'first@example.com', created_at: '2026-01-01T00:00:00.000Z' }
const milad: Row = { id: 'u-milad', email: 'milad201400@gmail.com', created_at: '2026-05-05T00:00:00.000Z' }

function makeEnv(rows: Row[], ownerEmail?: string): Env {
  const users = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: async () => run(sql, binds),
      all: async () => ({ results: [] as unknown[] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
    first: async () => run(sql, []),
    all: async () => ({ results: [] as unknown[] }),
    run: async () => ({ meta: { changes: 0 } }),
  })
  function run(sql: string, binds: unknown[]): unknown {
    if (/lower\(email\)/i.test(sql)) {
      const want = String(binds[0])
      const hit = users.find((u) => u.email.toLowerCase() === want)
      return hit ? { id: hit.id } : null
    }
    return users.length ? { id: users[0].id } : null
  }
  return { DB: { prepare }, ASSETS: {} as Fetcher, OWNER_EMAIL: ownerEmail } as unknown as Env
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
  check('حساب مالک است', await isOwner(pinned, milad.id))
  check('حساب قدیمی‌تر مالک نیست', !(await isOwner(pinned, firstAccount.id)))

  console.log('\n۲) اگر حساب مالک هنوز ثبت‌نام نکرده، اولین حساب کنترل را نگه می‌دارد')
  const notSignedUp = makeEnv([firstAccount], 'milad201400@gmail.com')
  check('اولین حساب مالک است', await isOwner(notSignedUp, firstAccount.id))
  check('حساب ناشناس مالک نیست', !(await isOwner(notSignedUp, milad.id)))

  console.log('\n۳) بدون OWNER_EMAIL، اولین حساب مالک است (رفتار پیشین)')
  const legacy = makeEnv([firstAccount, milad])
  check('اولین حساب مالک است', await isOwner(legacy, firstAccount.id))
  check('بقیه مالک نیستند', !(await isOwner(legacy, milad.id)))
  check('حساب ناموجود مالک نیست', !(await isOwner(legacy, 'ghost')))

  console.log('\n۴) ایمیل با فاصله و حروف بزرگ هم درست تطبیق داده می‌شود')
  const messy = makeEnv([milad], '  Milad201400@Gmail.com  ')
  check('فاصله و بزرگ‌بودن حروف مشکلی ایجاد نمی‌کند', await isOwner(messy, milad.id))

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * Isolation + token-management smoke test for the **public deployer bot**.
 *
 * Model under test:
 *   • one bot, open to everyone — no owner gate, no access levels;
 *   • every Telegram user gets their own space (unique token/deep link) and
 *     their own tokens & deployments; nothing is shared and nothing reaches a
 *     panel account;
 *   • the bot only deploys (no panel management screens);
 *   • webhook routing never falls back to another bot_config row.
 *
 * It drives the real webhook + router against an in-memory fake of the D1
 * surface and stub Telegram/provider APIs.
 */
import { handleTelegramWebhook } from '../worker/telegram'
import { MENU } from '../worker/telegram-ui'
import type { Env } from '../worker/env'

type Row = Record<string, unknown>
const USER_A = 1001
const USER_B = 2002

// ── Telegram + provider stubs ────────────────────────────────────────────────
const calls: Array<{ method: string; url: string; body: any }> = []

globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url)
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {}
  calls.push({ method: u.split('/').pop() ?? '', url: u, body })
  const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
  if (u.includes('api.telegram.org')) return json({ ok: true, result: { message_id: 42 } })
  if (u.includes('api.cloudflare.com')) {
    if (u.includes('/verify')) return json({ success: true, result: { id: 'cf-id-1', status: 'active' } })
    if (u.includes('/user/tokens/')) return json({ success: true, result: { name: 'Cloudflare Token A' } })
  }
  if (u.includes('backboard.railway.com')) return json({ data: { me: { name: 'Milad', email: 'milad@example.com' } } })
  if (u.includes('api.render.com')) return json([{ owner: { id: 'own-1', name: 'Render Acc', email: 'r@example.com' } }])
  return json({ ok: true })
}) as typeof fetch

// ── minimal fake D1 ──────────────────────────────────────────────────────────
const db: Record<string, Row[]> = {
  users: [], cf_tokens: [], railway_tokens: [], render_tokens: [], bot_config: [], bot_tenants: [],
  bot_users: [], bot_sessions: [], activity_logs: [], deployments: [],
  railway_deploys: [], render_deploys: [], optimizer_jobs: [], worker_members: [],
}

const tableOf = (sql: string) => (/(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i.exec(sql)?.[1] ?? '').toLowerCase()
const TOKEN_TABLES = /^(cf_tokens|railway_tokens|render_tokens)$/

function whereConds(sql: string, binds: unknown[], from: number) {
  const raw = /WHERE([\s\S]*?)(ORDER BY|LIMIT|RETURNING|$)/i.exec(sql)?.[1]?.trim()
  let i = from
  const conds: Array<[string, unknown]> = []
  if (!raw) return { conds, next: i }
  for (const part of raw.split(/\s+AND\s+/i)) {
    const [col, val] = part.split('=').map((s) => s.trim())
    conds.push([col, val === '?' ? binds[i++] : Number(val.replace(/'/g, ''))])
  }
  return { conds, next: i }
}

function matches(row: Row, conds: Array<[string, unknown]>) {
  return conds.every(([col, val]) => (val === null ? row[col] == null : row[col] === val))
}

async function first(sql: string, binds: unknown[]): Promise<unknown> {
  const table = tableOf(sql)
  if (sql.includes('COUNT(*)')) return { c: (db[table] ?? []).filter((r) => r.is_active === 1).length }
  if (table === 'bot_config' && sql.includes('webhook_secret = ?')) {
    return db.bot_config.find((r) => r.webhook_secret === binds[0] && r.is_active === 1) ?? null
  }
  if (table === 'bot_config' && sql.includes('is_active = 1')) return db.bot_config.find((r) => r.is_active === 1) ?? null
  if (table === 'bot_config') return db.bot_config.find((r) => r.user_id === binds[0]) ?? null
  if (table === 'bot_tenants') {
    const row = sql.includes('access_token = ?')
      ? db.bot_tenants.find((r) => r.access_token === binds[0])
      : db.bot_tenants.find((r) => r.telegram_id === binds[0])
    if (!row) return null
    if (/access_token, created_at/.test(sql)) return { access_token: row.access_token, created_at: row.created_at }
    return row
  }
  if (table === 'bot_users') {
    const row = db.bot_users.find((r) => r.user_id === binds[0] && r.telegram_id === binds[1])
    return row ? { id: row.id, is_active: row.is_active } : null
  }
  if (table === 'bot_sessions') {
    const row = db.bot_sessions.find((r) => r.id === binds[0])
    return row ? { state: row.state, data: row.data } : null
  }
  if (TOKEN_TABLES.test(table)) return db[table].find((r) => r.id === binds[0] && r.user_id === binds[1]) ?? null
  if (table === 'deployments') return db.deployments.find((r) => r.id === binds[0] && r.user_id === binds[1]) ?? null
  return null
}

async function all(sql: string, binds: unknown[]): Promise<{ results: unknown[] }> {
  const table = tableOf(sql)
  if ((TOKEN_TABLES.test(table) || table === 'deployments') && sql.includes('user_id = ?')) {
    return { results: db[table].filter((r) => r.user_id === binds[0]) }
  }
  return { results: [] }
}

async function run(sql: string, binds: unknown[]): Promise<{ meta: { changes: number }; name?: string }> {
  const table = tableOf(sql)
  if (/^INSERT/i.test(sql)) {
    const m = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(sql)
    if (m) {
      const names = m[1].split(',').map((s) => s.trim())
      const values = m[2].split(',').map((s) => s.trim())
      let bi = 0
      const row: Row = {}
      names.forEach((name, idx) => {
        const v = values[idx]
        row[name] = v === '?' ? binds[bi++] : v.replace(/'/g, '')
      })
      const existing = db[table].findIndex((r) => r.id === row.id)
      if (existing >= 0) db[table][existing] = { ...db[table][existing], ...row }
      else db[table].push(row)
    }
    return { meta: { changes: 1 } }
  }
  if (/^UPDATE/i.test(sql)) {
    const setRaw = /SET([\s\S]*?)WHERE/i.exec(sql)?.[1] ?? ''
    let bi = 0
    const updates: Array<[string, unknown]> = []
    for (const assign of setRaw.split(',').map((s) => s.trim())) {
      const [col, val] = assign.split('=').map((s) => s.trim())
      updates.push([col, val === '?' ? binds[bi++] : val.replace(/'/g, '')])
    }
    const { conds } = whereConds(sql, binds, bi)
    let changes = 0
    for (const row of db[table]) {
      if (matches(row, conds)) {
        for (const [col, val] of updates) row[col] = val
        changes++
      }
    }
    return { meta: { changes } }
  }
  if (/^DELETE/i.test(sql)) {
    const { conds } = whereConds(sql, binds, 0)
    const idx = db[table].findIndex((r) => matches(r, conds))
    if (idx < 0) return { meta: { changes: 0 } }
    const [removed] = db[table].splice(idx, 1)
    return { meta: { changes: 1 }, name: removed.name as string }
  }
  return { meta: { changes: 0 } }
}

// DELETE ... RETURNING goes through .first(), everything else through .run()
async function firstOrRun(sql: string, binds: unknown[]) {
  if (/^DELETE/i.test(sql)) {
    const res = await run(sql, binds)
    return res.name === undefined ? null : { name: res.name }
  }
  return first(sql, binds)
}

function makeEnv(): Env {
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      first: () => firstOrRun(sql, binds),
      all: () => all(sql, binds),
      run: () => run(sql, binds),
    }),
    first: () => firstOrRun(sql, []),
    all: () => all(sql, []),
    run: () => run(sql, []),
  })
  return { DB: { prepare } } as unknown as Env
}

function makeCtx() {
  const pending: Promise<unknown>[] = []
  return {
    pending,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  }
}

async function settle(ctx: { pending: Promise<unknown>[] }) {
  for (let i = 0; i < 10; i++) {
    if (!ctx.pending.length) break
    const batch = ctx.pending.splice(0, ctx.pending.length)
    await Promise.allSettled(batch)
  }
}

const request = (payload: unknown, secret?: string) =>
  new Request('https://panel.example.com/api/webhooks/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
    body: JSON.stringify(payload),
  })

const textUpdate = (text: string, from: number) => ({
  message: { message_id: 7, chat: { id: from }, from: { id: from, first_name: `u${from}` }, text },
})
const cbUpdate = (data: string, from: number) => ({
  callback_query: { id: 'cb1', data, from: { id: from, first_name: `u${from}` }, message: { message_id: 9, chat: { id: from } } },
})

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const flat = (kb?: Row[][]) => (kb ?? []).flat()
const buttonsOf = (body: any) => flat(body?.reply_markup?.inline_keyboard)
const lastBody = () => calls.at(-1)?.body ?? {}
const lastText = () => String(lastBody().text ?? '')
const sentTo = (botName: string) => calls.some((c) => c.url.includes(`/bot${botName}/`))

async function press(env: Env, data: string, secret: string, from: number) {
  calls.length = 0
  const ctx = makeCtx()
  await handleTelegramWebhook(env, ctx as any, request(cbUpdate(data, from), secret))
  await settle(ctx)
  return calls.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').at(-1)?.body ?? {}
}

async function say(env: Env, text: string, secret: string, from: number) {
  calls.length = 0
  const ctx = makeCtx()
  await handleTelegramWebhook(env, ctx as any, request(textUpdate(text, from), secret))
  await settle(ctx)
  return calls.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').at(-1)?.body ?? {}
}

const tenantOf = (telegramId: number) => db.bot_tenants.find((t) => t.telegram_id === String(telegramId)) as Row | undefined

async function main() {
  db.bot_config.push(
    { id: 'cfg1', user_id: 'panel-owner', bot_token: 'BOT1', bot_username: 'mili_deploy_bot', is_active: 1, welcome_message: 'سلام', chat_id: '777', webhook_secret: 'sec-1' },
    { id: 'cfg2', user_id: 'panel-other', bot_token: 'BOT2', bot_username: 'other_bot', is_active: 1, welcome_message: 'سلام', chat_id: '778', webhook_secret: 'sec-2' },
  )
  const env = makeEnv()

  console.log('۱) مسیریابی وب‌هوک: هر ربات دقیقاً به ردیف خودش')
  await say(env, '/start', 'sec-2', USER_B)
  check('پیام حساب دوم با توکن ربات دوم پاسخ می‌گیرد', sentTo('BOT2'), JSON.stringify(calls.map((c) => c.url.slice(-12))))
  check('و با توکن ربات اول پاسخ نمی‌گیرد', !sentTo('BOT1'))

  calls.length = 0
  const noSecret = makeCtx()
  await handleTelegramWebhook(env, noSecret as any, request(textUpdate('/start', USER_A)))
  await settle(noSecret)
  check('بدون هدر secret و با چند ربات، درخواست دور ریخته می‌شود', calls.length === 0, `calls=${calls.length}`)

  const badSecret = makeCtx()
  await handleTelegramWebhook(env, badSecret as any, request(textUpdate('/start', USER_A), 'sec-nope'))
  await settle(badSecret)
  check('secret ناشناس هم پاسخی نمی‌گیرد', calls.length === 0, `calls=${calls.length}`)

  const second = db.bot_config.splice(1, 1)[0]
  await say(env, '/start', undefined as never, USER_A)
  check('نصب تک‌رباتی بدون هدر مثل قبل کار می‌کند', sentTo('BOT1'))
  db.bot_config.push(second)

  console.log('\n۲) ربات عمومی است: هر کاربر فضای اختصاصی خودش را می‌گیرد')
  const aMenu = await say(env, '/start', 'sec-1', USER_A)
  check('کاربر تازه بدون هیچ کد/تأییدی منو را می‌گیرد', String(aMenu.text ?? '').includes('منوی اصلی'), String(aMenu.text ?? '').slice(0, 40))
  check('هیچ صفحهٔ مدیریت پنل در منو نیست', !String(aMenu.text ?? '').includes('تنظیمات'))
  const menuButtons = buttonsOf(aMenu).map((b) => String(b.callback_data ?? ''))
  check('منو فقط دکمه‌های استقرار دارد', menuButtons.includes('dpl:start') && !menuButtons.some((d) => d.startsWith('l:optimizer') || d.startsWith('l:members') || d.startsWith('l:users')))

  const tenantA = tenantOf(USER_A)
  const tenantB = tenantOf(USER_B)
  check('برای کاربر A فضای اختصاصی ساخته شد', !!tenantA?.user_id, JSON.stringify(tenantA))
  check('برای کاربر B فضای جداگانهٔ خودش ساخته شد', !!tenantB?.user_id && tenantB.user_id !== tenantA?.user_id)
  check('هر کاربر توکن اختصاصی خودش را دارد', tenantA?.access_token !== tenantB?.access_token && String(tenantA?.access_token).startsWith('mz-'))
  check('کاربر ربات یک حساب پنل واقعی نیست (بدون رمز عبور)', db.users.find((u) => u.id === tenantA?.user_id)?.password_hash === 'telegram-tenant')

  console.log('\n۳) جداسازی داده‌ها: توکن‌ها و استقرارهای هر کاربر')
  // Seed one token for each space, then make sure the screens keep them apart.
  db.cf_tokens.push(
    { id: 'tok-a', user_id: tenantA!.user_id, name: 'cf-token-A', token: 'x', status: 'active', created_at: '2026-09-01' },
    { id: 'tok-b', user_id: tenantB!.user_id, name: 'cf-token-B', token: 'x', status: 'active', created_at: '2026-09-02' },
  )
  const aTokens = await say(env, MENU.tokens, 'sec-1', USER_A)
  check('کاربر A فقط توکن خودش را می‌بیند', String(aTokens.text ?? '').includes('cf-token-A') && !String(aTokens.text ?? '').includes('cf-token-B'))
  const bTokens = await say(env, MENU.tokens, 'sec-1', USER_B)
  check('کاربر B هم فقط توکن خودش را می‌بیند', String(bTokens.text ?? '').includes('cf-token-B') && !String(bTokens.text ?? '').includes('cf-token-A'))

  const foreign = await say(env, `/start ${tenantB!.access_token}`, 'sec-1', USER_A)
  check('توکن اختصاصی کاربر دیگر پذیرفته نمی‌شود', String(foreign.text ?? '').includes('حساب دیگری'), String(foreign.text ?? '').slice(0, 40))

  console.log('\n۴) پروفایل و لینک اختصاصی')
  const profile = await say(env, MENU.profile, 'sec-1', USER_A)
  const profileText = String(profile.text ?? '')
  check('توکن اختصاصی در پروفایل نمایش داده می‌شود', profileText.includes(String(tenantA!.access_token)), profileText.slice(0, 80))
  check('لینک عمیق اختصاصی ساخته می‌شود', profileText.includes(`t.me/mili_deploy_bot?start=${tenantA!.access_token}`), profileText.slice(0, 80))
  const copy = await press(env, `cpf:${tenantA!.access_token}`, 'sec-1', USER_A)
  check('دکمهٔ کپی لینک، لینک را می‌فرستد', String(copy.text ?? '').includes(`start=${tenantA!.access_token}`), String(copy.text ?? '').slice(0, 50))

  console.log('\n۵) افزودن توکن‌ها از داخل ربات')
  const tokensScreenBody = await say(env, MENU.tokens, 'sec-1', USER_A)
  const tokenButtons = buttonsOf(tokensScreenBody).map((b) => String(b.callback_data ?? ''))
  check('دکمه‌های افزودن توکن CF/Railway/Render موجودند', ['tok:add:cf', 'tok:add:railway', 'tok:add:render'].every((d) => tokenButtons.includes(d)))

  await press(env, 'tok:add:cf', 'sec-1', USER_A)
  const session = db.bot_sessions.find((s) => s.id === `${tenantA!.user_id}:${USER_A}`)
  check('گفت‌وگو در حالت انتظار توکن قرار می‌گیرد', session?.state === 'await_token', String(session?.state))

  const saved = await say(env, `توکن اصلی | ${'A'.repeat(40)}`, 'sec-1', USER_A)
  const cfRow = db.cf_tokens.find((r) => r.name === 'توکن اصلی')
  check('توکن با نام دلخواه ذخیره شد', !!cfRow, JSON.stringify(db.cf_tokens.map((r) => r.name)))
  check('روی فضای همان کاربر ثبت شد', cfRow?.user_id === tenantA!.user_id)
  check('اعتبارسنجی با کلودفلر انجام شد', calls.some((c) => c.url.includes('api.cloudflare.com')))
  check('پیام حاوی توکن پاک شد', calls.some((c) => c.method === 'deleteMessage'))
  check('تأیید ذخیره نمایش داده شد', String(saved.text ?? '').includes('ذخیره شد'))
  check('حالت گفت‌وگو پاک شد', !db.bot_sessions.find((s) => s.id === `${tenantA!.user_id}:${USER_A}` && s.state === 'await_token'))

  await press(env, 'tok:add:railway', 'sec-1', USER_A)
  await say(env, `rail-1 | ${'R'.repeat(40)}`, 'sec-1', USER_A)
  const railRow = db.railway_tokens.find((r) => r.user_id === tenantA!.user_id)
  check('توکن Railway ذخیره شد', !!railRow, JSON.stringify(db.railway_tokens))
  check('نام حساب از Railway خوانده شد', railRow?.account_name === 'milad@example.com', String(railRow?.account_name))

  await press(env, 'tok:add:render', 'sec-1', USER_A)
  await say(env, 'N'.repeat(40), 'sec-1', USER_A)
  const renderRow = db.render_tokens.find((r) => r.user_id === tenantA!.user_id)
  check('توکن Render بدون نام هم ذخیره می‌شود', !!renderRow, JSON.stringify(db.render_tokens))

  console.log('\n۶) غیرفعال‌سازی و حذف توکن')
  const toggled = await press(env, 'tok:tgl:cf:tok-a', 'sec-1', USER_A)
  check('توکن غیرفعال شد', db.cf_tokens.find((r) => r.id === 'tok-a')?.status === 'inactive')
  check('و پیام تأیید آمد', String(toggled.text ?? '').includes('غیرفعال'))
  const confirm = await press(env, `tok:del:cf:${String(cfRow?.id ?? '')}`, 'sec-1', USER_A)
  check('قبل از حذف تأیید گرفته می‌شود', buttonsOf(confirm).some((b) => String(b.callback_data ?? '').startsWith('tok:rm:')))
  await press(env, `tok:rm:cf:${String(cfRow?.id ?? '')}`, 'sec-1', USER_A)
  check('توکن فقط بعد از تأیید حذف شد', !db.cf_tokens.find((r) => r.name === 'توکن اصلی'))

  console.log('\n۷) بازگشت به ویزارد استقرار بعد از افزودن توکن')
  await press(env, 'dpl:start', 'sec-1', USER_A)
  await press(env, 'dpl:m:workers', 'sec-1', USER_A)
  await press(env, 'dpl:s:edgetunnel', 'sec-1', USER_A)
  const wizardAdd = await press(env, 'tok:add:cf:dpl', 'sec-1', USER_A)
  check('از داخل ویزارد هم می‌توان توکن افزود', String(wizardAdd.text ?? '').includes('افزودن توکن'))
  const resumed = await say(env, 'W'.repeat(40), 'sec-1', USER_A)
  check('بعد از ذخیره، ویزارد همان‌جا ادامه می‌یابد', String(resumed.text ?? '').includes('انتخاب توکن'), String(resumed.text ?? '').slice(0, 50))
  check('و توکن تازه در لیست ویزارد دیده می‌شود', String(resumed.text ?? '').includes('Cloudflare Token A'))

  console.log('\n۸) هر کاربر فقط به فضای خودش دسترسی دارد — حتی با دکمه‌های کهنه')
  const before = db.cf_tokens.filter((r) => r.user_id === tenantA!.user_id).length
  // B presses a callback that carries A's row id.
  await press(env, 'tok:del:cf:tok-a', 'sec-1', USER_B)
  await press(env, 'tok:rm:cf:tok-a', 'sec-1', USER_B)
  check('B نمی‌تواند توکن A را حذف کند', db.cf_tokens.some((r) => r.id === 'tok-a'))
  check('و توکن‌های A دست‌نخورده مانده‌اند', db.cf_tokens.filter((r) => r.user_id === tenantA!.user_id).length === before)

  console.log('\n۹) مسدود کردن کاربر توسط مالک پنل — تنها کنترل ربات عمومی')
  const ownerRow = db.bot_users.find((r) => r.user_id === 'panel-owner' && r.telegram_id === String(USER_A))
  check('کاربر در لیست مالک ثبت شده', !!ownerRow)
  if (ownerRow) ownerRow.is_active = 0

  const blockedSay = await say(env, '/start', 'sec-1', USER_A)
  check('کاربر مسدود هیچ صفحه‌ای نمی‌گیرد', String(blockedSay.text ?? '').includes('بسته شده'), String(blockedSay.text ?? '').slice(0, 40))
  check('و هیچ دکمه‌ای هم نمی‌گیرد', buttonsOf(blockedSay).length === 0, `buttons=${buttonsOf(blockedSay).length}`)

  const sessionsBefore = db.bot_sessions.length
  await press(env, 'tok:add:cf', 'sec-1', USER_A)
  check('دکمه‌های کهنه هم برای کاربر مسدود اجرا نمی‌شوند', db.bot_sessions.length === sessionsBefore)

  if (ownerRow) ownerRow.is_active = 1
  const unblocked = await say(env, '/start', 'sec-1', USER_A)
  check('بعد از رفع مسدودی دوباره کار می‌کند', !!unblocked.text && !String(unblocked.text).includes('بسته شده'), String(unblocked.text ?? '').slice(0, 40))

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main()

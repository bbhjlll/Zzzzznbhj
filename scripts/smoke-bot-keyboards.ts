/**
 * Regression test for the "broken bot" report: a screen's inline buttons must
 * survive contact with the persistent reply keyboard (the tabs).
 *
 * Telegram accepts exactly one `reply_markup` per message, so the tabs and the
 * buttons cannot share a message. The webhook must therefore send the tabs on
 * their own hint message and always render the screen with its own buttons.
 *
 * Before the fix, pressing the "📋 ورکرها" tab sent the workspace list as text
 * with only the reply keyboard attached — readable, but with no button to tap.
 *
 * It also pins Telegram's 64-byte `callback_data` ceiling on the service-settings
 * screen: an oversized payload is rejected per *message*, so one long button
 * silently removes the whole keyboard (the Netherlands region button was 66
 * bytes, which is why the region could not be selected at all).
 */
import { handleTelegramWebhook } from '../worker/telegram'
import { CALLBACK_LIMIT, MENU, callbackBytes } from '../worker/telegram-ui'
import { RAILWAY_REGIONS, railwayRegionFromCode } from '../shared/panels'
import type { Env } from '../worker/env'

const TELEGRAM_ID = 777

type Row = Record<string, unknown>
type Call = { method: string; body: Record<string, any> }

const calls: Call[] = []

// ── Telegram API stub ────────────────────────────────────────────────────────
globalThis.fetch = (async (url: any, init: any) => {
  const method = String(url).split('/').pop() ?? ''
  calls.push({ method, body: init?.body ? JSON.parse(init.body) : {} })
  // The forced-membership gate checks getChatMember on every update; this user
  // has already joined, so the screens stay reachable.
  const result = method === 'getChatMember' ? { status: 'member' } : { message_id: 42 }
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

// ── minimal fake D1 ──────────────────────────────────────────────────────────
const CONFIG: Row = {
  id: 'cfg1',
  user_id: 'u1',
  bot_token: 'TEST',
  is_active: 1,
  welcome_message: 'خوش آمدی',
  chat_id: String(TELEGRAM_ID),
  claim_code: null,
}

// A deployed panel with a *real* 36-character Railway deployment id — the exact
// shape that made the region payload oversize Telegram's callback limit.
const RAILWAY_ID = '3f9a1c2e-5b7d-4e8f-9a01-2b3c4d5e6f70'
const RAILWAY_DEPLOY: Row = {
  id: RAILWAY_ID,
  user_id: 'u1',
  name: 'mil-rail',
  panel: 'mizetusi',
  region: 'europe-west4-drams3a',
  domain: 'mil-rail.up.railway.app',
  admin_username: 'admin',
  sleep_application: null,
  ipv6_egress: null,
  cdn_enabled: null,
  created_at: '2026-09-20T10:00:00.000Z',
}

const DEPLOYMENTS: Row[] = [
  { id: 'dep1', name: 'mil-aaa', status: 'deployed', worker_url: 'https://a.example.com', panel_url: null, uuid: 'u-1', custom_path: 'sub', method: 'workers', worker_source: 'edgetunnel', created_at: '2026-09-13T10:00:00.000Z' },
  { id: 'dep2', name: 'mil-bbb', status: 'failed', worker_url: 'https://b.example.com', panel_url: null, uuid: 'u-2', custom_path: 'sub', method: 'workers', worker_source: 'edgetunnel', created_at: '2026-09-12T10:00:00.000Z' },
]

function makeEnv(): Env {
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({ first: () => first(sql, binds), all: () => all(sql), run: () => run() }),
    first: () => first(sql, []),
    all: () => all(sql),
    run: () => run(),
  })
  return { DB: { prepare } } as unknown as Env
}

const run = async () => ({ meta: { changes: 1 } })

async function first(sql: string, _binds: unknown[]): Promise<unknown> {
  // The webhook now routes strictly by the per-bot setWebhook secret (no more
  // "first active row" fallback), so the mock answers that lookup explicitly.
  if (sql.includes('COUNT(*)')) return { c: 1 }
  if (sql.includes('FROM bot_config')) return CONFIG
  if (sql.includes('FROM railway_deploys')) return RAILWAY_DEPLOY
  return null
}

async function all(sql: string): Promise<{ results: unknown[] }> {
  if (sql.includes('FROM deployments')) return { results: DEPLOYMENTS }
  if (sql.includes('FROM railway_deploys')) return { results: [RAILWAY_DEPLOY] }
  return { results: [] }
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
  // waitUntil() chains can enqueue more work while draining.
  for (let i = 0; i < 10; i++) {
    if (!ctx.pending.length) break
    const batch = ctx.pending.splice(0, ctx.pending.length)
    await Promise.allSettled(batch)
  }
}

const request = (payload: unknown) =>
  new Request('https://panel.example.com/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'sec-1' },
    body: JSON.stringify(payload),
  })

const textUpdate = (text: string) => ({
  message: { message_id: 1, chat: { id: TELEGRAM_ID }, from: { id: TELEGRAM_ID, first_name: 'Milad' }, text },
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

const inlineOf = (c: Call | undefined) => c?.body?.reply_markup?.inline_keyboard as Row[][] | undefined
const replyOf = (c: Call | undefined) => c?.body?.reply_markup?.keyboard as string[][] | undefined
const flatButtons = (kb?: Row[][]) => (kb ?? []).flat()

async function main() {
  const env = makeEnv()

  console.log('۱) فشار دادن تب «ورکرها» از کیبورد پایین')
  calls.length = 0
  const ctx1 = makeCtx()
  await handleTelegramWebhook(env, ctx1 as any, request(textUpdate(MENU.workers)))
  await settle(ctx1)
  const sends1 = calls.filter((c) => c.method === 'sendMessage')
  check('دقیقاً یک پیام فرستاده می‌شود', sends1.length === 1, `تعداد=${sends1.length}`)
  check('متن لیست ورکرهاست', sends1[0]?.body.text?.includes('ورکرها') === true)
  const kb1 = inlineOf(sends1[0])
  check('کیبورد اینلاین همراه پیام است', !!kb1, JSON.stringify(sends1[0]?.body.reply_markup ?? null))
  check(
    'دکمهٔ هر ورکر موجود است',
    flatButtons(kb1).some((b) => String(b.callback_data ?? '').startsWith('w:')),
    JSON.stringify(kb1 ?? []),
  )
  check(
    'دکمه‌های کنترلی (بروزرسانی / استقرار جدید) موجودند',
    flatButtons(kb1).some((b) => b.callback_data === 'l:workers:0') &&
      flatButtons(kb1).some((b) => b.callback_data === 'dpl:start'),
  )
  check('کیبورد ثابت، جای کیبورد اینلاین را نگرفته', !replyOf(sends1[0]))

  console.log('\n۲) دستور /start — تب‌ها و دکمه‌ها با هم')
  calls.length = 0
  const ctx2 = makeCtx()
  await handleTelegramWebhook(env, ctx2 as any, request(textUpdate('/start')))
  await settle(ctx2)
  const sends2 = calls.filter((c) => c.method === 'sendMessage')
  check('دو پیام فرستاده می‌شود (تب‌ها + صفحه)', sends2.length === 2, `تعداد=${sends2.length}`)
  check('پیام تب‌ها کیبورد ثابت دارد', !!replyOf(sends2[0]) && replyOf(sends2[0])!.flat().includes(MENU.workers))
  check('پیام منو دکمه‌های اینلاین دارد', flatButtons(inlineOf(sends2[1])).length > 0)
  check('صفحهٔ منو آخرین پیام است (زیر تب‌ها)', sends2[1]?.body.text?.includes('منوی اصلی') === true)

  console.log('\n۳) فشار دکمهٔ اینلاین — ویرایش همان پیام')
  calls.length = 0
  const ctx3 = makeCtx()
  await handleTelegramWebhook(
    env,
    ctx3 as any,
    request({
      callback_query: {
        id: 'cb1',
        data: 'l:workers:0',
        from: { id: TELEGRAM_ID, first_name: 'Milad' },
        message: { message_id: 5, chat: { id: TELEGRAM_ID } },
      },
    }),
  )
  await settle(ctx3)
  const edits = calls.filter((c) => c.method === 'editMessageText')
  check('پیام درجا ویرایش می‌شود', edits.length === 1, `تعداد=${edits.length}`)
  check(
    'کیبورد ورکرها بعد از ویرایش هم هست',
    flatButtons(inlineOf(edits[0])).some((b) => String(b.callback_data ?? '').startsWith('w:')),
  )

  console.log('\n۴) تب‌های دیگر هم دکمه دارند')
  for (const tab of [MENU.profile, MENU.panels, MENU.tokens, MENU.servers, MENU.help]) {
    calls.length = 0
    const ctx = makeCtx()
    await handleTelegramWebhook(env, ctx as any, request(textUpdate(tab)))
    await settle(ctx)
    const send = calls.filter((c) => c.method === 'sendMessage').at(-1)
    check(`${tab} → دکمه‌های اینلاین دارد`, flatButtons(inlineOf(send)).length > 0)
  }

  console.log('\n۵) صفحهٔ تنظیمات سرویس — هیچ دکمه‌ای از سقف ۶۴ بایتی تلگرام رد نمی‌شود')
  // Telegram answers BUTTON_DATA_INVALID and drops the WHOLE message when one
  // button's `callback_data` is longer than 64 bytes. The region payload carried
  // the full region id (`srvset:g:<36-char id>:europe-west4-drams3a` = 66 bytes),
  // so the settings keyboard was rejected and the Netherlands could not be
  // selected. This pins the limit for every button the screen ships.
  calls.length = 0
  const ctx5 = makeCtx()
  await handleTelegramWebhook(
    env,
    ctx5 as any,
    request({
      callback_query: {
        id: 'cb2',
        data: `srvset:o:${RAILWAY_ID}`,
        from: { id: TELEGRAM_ID, first_name: 'Milad' },
        message: { message_id: 7, chat: { id: TELEGRAM_ID } },
      },
    }),
  )
  await settle(ctx5)
  const settingsMsg = calls.filter((c) => c.method === 'editMessageText' || c.method === 'sendMessage').at(-1)
  const settingsKb = inlineOf(settingsMsg)
  check('صفحهٔ تنظیمات سرویس رندر می‌شود', !!settingsKb, JSON.stringify(settingsMsg?.body ?? null).slice(0, 200))
  const settingsData = flatButtons(settingsKb)
    .map((b) => String(b.callback_data ?? ''))
    .filter(Boolean)
  check(
    'همهٔ callback_data ها داخل سقف ۶۴ بایتی هستند',
    settingsData.length > 0 && settingsData.every((d) => callbackBytes(d) <= CALLBACK_LIMIT),
    settingsData.map((d) => `${d}=${callbackBytes(d)}`).join(' | '),
  )
  check(
    'دکمهٔ هر چهار منطقه هست و به کد درست اشاره می‌کند',
    RAILWAY_REGIONS.every((r) => settingsData.includes(`srvset:g:${RAILWAY_ID}:${r.code}`)),
    settingsData.join(' | '),
  )
  check(
    'کد هر منطقه به همان منطقه برمی‌گردد',
    RAILWAY_REGIONS.every((r) => railwayRegionFromCode(r.code)?.id === r.id),
    RAILWAY_REGIONS.map((r) => `${r.code}→${railwayRegionFromCode(r.code)?.id}`).join(', '),
  )
  check(
    'شناسهٔ کامل منطقه (کیبورد قدیمی) هم پذیرفته می‌شود',
    RAILWAY_REGIONS.every((r) => railwayRegionFromCode(r.id)?.id === r.id),
  )

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main()

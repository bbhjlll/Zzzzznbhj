/**
 * Forced channel membership smoke test.
 *
 * Every user must join @miliconfig before the deployer bot unlocks. This drives
 * the real webhook against a stubbed Telegram API whose `getChatMember` answer
 * we flip between "left" and "member", and asserts:
 *   • a non-member gets the gate (channel link + "I joined" button) and never a
 *     real screen — for /start, for another command and for a stale inline
 *     button press;
 *   • the gate's own button re-checks live and refuses while still a non-member;
 *   • once the check passes the menu opens and the tab keyboard is installed;
 *   • a member is never gated.
 */
import { handleTelegramWebhook } from '../worker/telegram'
import { MENU } from '../worker/telegram-ui'
import type { Env } from '../worker/env'

const TELEGRAM_ID = 4242
const CHANNEL_URL = 'https://t.me/miliconfig'

type Row = Record<string, unknown>
type Call = { method: string; body: Record<string, any> }

const calls: Call[] = []
/** The live membership answer the stubbed getChatMember returns. */
let isMember = false

// ── Telegram API stub ────────────────────────────────────────────────────────
globalThis.fetch = (async (url: any, init: any) => {
  const method = String(url).split('/').pop() ?? ''
  calls.push({ method, body: init?.body ? JSON.parse(init.body) : {} })
  const result = method === 'getChatMember' ? { status: isMember ? 'member' : 'left' } : { message_id: 42 }
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  })
}) as typeof fetch

// ── minimal fake D1 ──────────────────────────────────────────────────────────
const CONFIG: Row = {
  id: 'cfg1',
  user_id: 'u1',
  bot_token: 'TEST',
  bot_username: 'mili_deploy_bot',
  is_active: 1,
  welcome_message: 'خوش آمدی',
  chat_id: String(TELEGRAM_ID),
  claim_code: null,
}
const TENANT: Row = {
  id: 'ten1',
  telegram_id: String(TELEGRAM_ID),
  user_id: 'tu1',
  access_token: 'mz-abcdef123456',
  username: 'tester',
  first_name: 'Tester',
}

function makeEnv(): Env {
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({ first: () => first(sql, binds), all: () => all(), run: () => run() }),
    first: () => first(sql, []),
    all: () => all(),
    run: () => run(),
  })
  return { DB: { prepare } } as unknown as Env
}

const run = async () => ({ meta: { changes: 1 } })
async function first(sql: string, _binds: unknown[]): Promise<unknown> {
  if (sql.includes('COUNT(*)')) return { c: 1 }
  if (sql.includes('FROM bot_config')) return CONFIG
  if (sql.includes('FROM bot_tenants')) return TENANT
  return null
}
async function all(): Promise<{ results: unknown[] }> {
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
  message: { message_id: 1, chat: { id: TELEGRAM_ID }, from: { id: TELEGRAM_ID, first_name: 'Tester' }, text },
})
const cbUpdate = (data: string) => ({
  callback_query: { id: 'cb1', data, from: { id: TELEGRAM_ID, first_name: 'Tester' }, message: { message_id: 9, chat: { id: TELEGRAM_ID } } },
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

const sent = () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
const lastSent = () => sent().at(-1)
const lastText = () => String(lastSent()?.body?.text ?? '')
const lastButtons = () => (lastSent()?.body?.reply_markup?.inline_keyboard ?? []).flat() as Row[]
const methodCalls = (m: string) => calls.filter((c) => c.method === m)

async function post(update: unknown) {
  calls.length = 0
  const ctx = makeCtx()
  await handleTelegramWebhook(makeEnv(), ctx as any, request(update))
  await settle(ctx)
}

async function main() {
  console.log('۱) غیرعضو /start می‌زند → دروازهٔ عضویت، نه منو')
  await post(textUpdate('/start'))
  check('متن دروازهٔ عضویت است', lastText().includes('عضویت') && lastText().includes('miliconfig'), lastText().slice(0, 60))
  check('منو باز نشده', !lastText().includes('منوی اصلی'))
  const gate = lastButtons()
  check('دکمهٔ لینک کانال هست', gate.some((b) => String(b.url ?? '') === CHANNEL_URL), JSON.stringify(gate))
  check('دکمهٔ «عضو شدم» با callback درست هست', gate.some((b) => b.callback_data === 'join:check'), JSON.stringify(gate))

  console.log('\n۲) غیرعضو دکمهٔ قدیمی می‌زند → باز هم دروازه')
  await post(cbUpdate('dpl:start'))
  check('صفحهٔ واقعی نمایش داده نمی‌شود', !lastText().includes('ورکر کلودفلر') && lastText().includes('عضویت'), lastText().slice(0, 60))
  check('دروازه درجا ویرایش شد', methodCalls('editMessageText').length === 1)

  console.log('\n۳) غیرعضو تب پایین را می‌زند → باز هم دروازه')
  await post(textUpdate(MENU.workers))
  check('لیست ورکرها نشان داده نمی‌شود و دروازه می‌آید', lastText().includes('عضویت') && !lastText().includes('ورکرها'), lastText().slice(0, 60))

  console.log('\n۴) غیرعضو «عضو شدم» می‌زند → رد، هنوز عضو نیست')
  await post(cbUpdate('join:check'))
  check('توست هشدار عضو نشدن فرستاده شد', methodCalls('answerCallbackQuery').some((c) => String(c.body.text ?? '').includes('هنوز')), JSON.stringify(methodCalls('answerCallbackQuery').map((c) => c.body.text)))
  check('دروازه همچنان باز است', lastText().includes('عضویت'))

  console.log('\n۵) بعد از عضویت، «عضو شدم» → منو + تب‌ها')
  isMember = true
  await post(cbUpdate('join:check'))
  check('توست تأیید فرستاده شد', methodCalls('answerCallbackQuery').some((c) => String(c.body.text ?? '').includes('تأیید')), JSON.stringify(methodCalls('answerCallbackQuery').map((c) => c.body.text)))
  check('منو باز شد', lastText().includes('منوی اصلی'), lastText().slice(0, 60))
  check('کیبورد ثابت (تب‌ها) نصب شد', methodCalls('sendMessage').some((c) => !!c.body?.reply_markup?.keyboard), JSON.stringify(calls.map((c) => c.method)))

  console.log('\n۶) عضو عادی بدون دروازه به همهٔ صفحه‌ها می‌رسد')
  await post(textUpdate(MENU.workers))
  check('دیگر دروازه‌ای نیست و صفحهٔ واقعی می‌آید', !lastText().includes('عضویت'), lastText().slice(0, 60))
  await post(textUpdate('/start'))
  check('/start هم مستقیم منو می‌دهد', lastText().includes('منوی اصلی'), lastText().slice(0, 60))

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main()

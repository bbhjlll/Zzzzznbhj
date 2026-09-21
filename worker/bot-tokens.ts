import type { Env } from './env'
import { genId, nowIso } from './util'
import { verifyRailwayToken } from './railway'
import { verifyRenderToken } from './render'
import {
  type BotConfigRow,
  type BotSession,
  type Screen,
  type ScreenCtx,
  type TgButton,
  faDate,
  sanitizeSecret,
  tg,
} from './telegram-core'

// ══════════════════════════════════════════════════════════════════════════════
//  Token management inside the bot.
//
//  Model: one public deployer bot, one isolated space per Telegram user. Every
//  read/write targets `cf_tokens`, `railway_tokens` and `render_tokens` rows whose
//  `user_id` is the calling user's own space (bot_tenants.user_id) — there is no
//  shared or admin token, and no way for one Telegram user to see another's
//  credentials. The panel owner's own tokens are never used on anyone's behalf.
//
//  Tokens can be added, paused and deleted without leaving Telegram; each pasted
//  secret is verified against the provider before it is stored, and the chat
//  message that carried it is deleted afterwards.
// ══════════════════════════════════════════════════════════════════════════════

export type TokenKind = 'cf' | 'railway' | 'render'

export interface KindSpec {
  id: TokenKind
  label: string
  table: 'cf_tokens' | 'railway_tokens' | 'render_tokens'
  /** Where the user creates the credential. */
  url: string
  hint: string
}

const KINDS: Record<TokenKind, KindSpec> = {
  cf: {
    id: 'cf',
    label: 'Cloudflare',
    table: 'cf_tokens',
    url: 'https://dash.cloudflare.com/profile/api-tokens',
    hint: 'پنل کلودفلر → My Profile → API Tokens → Create Token (قالب «Edit Cloudflare Workers» کافی است)',
  },
  railway: {
    id: 'railway',
    label: 'Railway',
    table: 'railway_tokens',
    url: 'https://railway.com/account/tokens',
    hint: 'Railway → Account Settings → Tokens → Create Token (نوع Account)',
  },
  render: {
    id: 'render',
    label: 'Render',
    table: 'render_tokens',
    url: 'https://dashboard.render.com/u/settings#api-keys',
    hint: 'Render → Account Settings → API Keys → Create API Key',
  },
}

export function kindSpec(raw?: string): KindSpec {
  return KINDS[(raw ?? 'cf') as TokenKind] ?? KINDS.cf
}

export const isTokenKind = (raw: string): raw is TokenKind => raw in KINDS

const home: TgButton = { text: '🏠 منوی اصلی', callback_data: 'n:menu' }

interface TokenRow {
  id: string
  name: string
  status: string
  last_used_at?: string | null
  account_name?: string | null
}

/** Every token row of this panel user — never another account's. */
async function rowsFor(env: Env, spec: KindSpec, userId: string): Promise<TokenRow[]> {
  const cols = spec.id === 'cf' ? 'id, name, status, last_used_at' : 'id, name, status, account_name, last_used_at'
  const r = await env.DB.prepare(`SELECT ${cols} FROM ${spec.table} WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`)
    .bind(userId)
    .all<TokenRow>()
  return r.results
}

function tokenLine(spec: KindSpec, t: TokenRow): string {
  const state = t.status === 'active' ? '✅' : '⛔'
  const account = t.account_name ? ` · ${t.account_name}` : ''
  const used = t.last_used_at ? ` · آخرین استفاده ${faDate(t.last_used_at)}` : ' · استفاده‌نشده'
  return `${state} <code>${t.name}</code>${account}${used}`
}

// ── Screens ──────────────────────────────────────────────────────────────────

export async function tokensScreen(ctx: ScreenCtx, notice?: string): Promise<Screen> {
  const [cf, railway, render] = await Promise.all([
    rowsFor(ctx.env, KINDS.cf, ctx.cfg.user_id),
    rowsFor(ctx.env, KINDS.railway, ctx.cfg.user_id),
    rowsFor(ctx.env, KINDS.render, ctx.cfg.user_id),
  ])

  let text = notice ? `${notice}\n\n———————————\n\n` : ''
  text +=
    '🔑 <b>توکن‌های من</b>\n\n' +
    'این توکن‌ها فقط روی همین حساب ثبت‌اند؛ ربات‌ها و حساب‌های دیگر به آن‌ها دسترسی ندارند و استقرارها همیشه با توکن خودتان انجام می‌شود.\n\n'

  const keyboard: TgButton[][] = []
  for (const spec of [KINDS.cf, KINDS.railway, KINDS.render]) {
    const rows = spec.id === 'cf' ? cf : spec.id === 'railway' ? railway : render
    text += `<b>${spec.label}</b>\n`
    if (!rows.length) text += '— توکنی ثبت نشده\n'
    for (const t of rows) {
      text += `${tokenLine(spec, t)}\n`
      keyboard.push([
        { text: t.status === 'active' ? `⛔ غیرفعال ${t.name}` : `✅ فعال ${t.name}`, callback_data: `tok:tgl:${spec.id}:${t.id}` },
        { text: '🗑 حذف', callback_data: `tok:del:${spec.id}:${t.id}` },
      ])
    }
    text += '\n'
  }
  text += '<i>افزودن توکن همین‌جا انجام می‌شود و توکن قبل از ذخیره اعتبارسنجی می‌گردد.</i>'

  keyboard.push([
    { text: '➕ کلودفلر', callback_data: 'tok:add:cf' },
    { text: '➕ Railway', callback_data: 'tok:add:railway' },
    { text: '➕ Render', callback_data: 'tok:add:render' },
  ])
  keyboard.push([{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }, home])
  if (ctx.origin) keyboard.push([{ text: '🌐 مدیریت در پنل وب', url: `${ctx.origin}/#/tokens` }])

  return { text, keyboard: { inline_keyboard: keyboard } }
}

/**
 * Ask for a token. `ret === 'dpl'` means the user came from the deploy wizard
 * (there were no usable tokens) and should be dropped back into it afterwards.
 */
export function tokenAddScreen(spec: KindSpec, ret?: string): Screen {
  const cancel = ret === 'dpl' ? 'dpl:start' : 'n:tokens'
  return {
    text:
      `➕ <b>افزودن توکن ${spec.label}</b>\n\n` +
      'توکن را در همین چت بفرستید. می‌توانید یک نام هم بدهید:\n' +
      '<code>نام دلخواه | توکن</code>\n\n' +
      `🔗 ساخت توکن: ${spec.hint}\n${spec.url}\n\n` +
      '🔒 توکن پیش از ذخیره با خود سرویس بررسی می‌شود و پیام حاوی آن بعد از ثبت، از چت پاک می‌گردد.',
    keyboard: { inline_keyboard: [[{ text: '❌ لغو', callback_data: cancel }], [home]] },
  }
}

export function tokenDeleteScreen(spec: KindSpec, t: TokenRow): Screen {
  return {
    text: `🗑 <b>حذف توکن ${spec.label}</b>\n\n<code>${t.name}</code>\n\nبا حذف توکن، استقرارهای بعدی با آن انجام نمی‌شود. مطمئن هستید؟`,
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ بله، حذف کن', callback_data: `tok:rm:${spec.id}:${t.id}` }],
        [{ text: '❌ انصراف', callback_data: 'n:tokens' }],
      ],
    },
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function findToken(env: Env, spec: KindSpec, userId: string, id: string): Promise<TokenRow | null> {
  const cols = spec.id === 'cf' ? 'id, name, status, last_used_at' : 'id, name, status, account_name, last_used_at'
  return env.DB.prepare(`SELECT ${cols} FROM ${spec.table} WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<TokenRow>()
}

export async function deleteTokenRow(ctx: ScreenCtx, spec: KindSpec, id: string): Promise<Screen> {
  const row = await ctx.env.DB.prepare(`DELETE FROM ${spec.table} WHERE id = ? AND user_id = ? RETURNING name`)
    .bind(id, ctx.cfg.user_id)
    .first<{ name: string }>()
  if (!row) return tokensScreen(ctx, '❌ توکن پیدا نشد.')
  await ctx.env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), ctx.cfg.user_id, 'token_deleted', 'token', row.name, nowIso())
    .run()
  return tokensScreen(ctx, `🗑 توکن <code>${row.name}</code> حذف شد.`)
}

export async function toggleTokenRow(ctx: ScreenCtx, spec: KindSpec, id: string): Promise<Screen> {
  const t = await findToken(ctx.env, spec, ctx.cfg.user_id, id)
  if (!t) return tokensScreen(ctx, '❌ توکن پیدا نشد.')
  const next = t.status === 'active' ? 'inactive' : 'active'
  await ctx.env.DB.prepare(`UPDATE ${spec.table} SET status = ? WHERE id = ? AND user_id = ?`).bind(next, id, ctx.cfg.user_id).run()
  return tokensScreen(ctx, next === 'active' ? `✅ توکن <code>${t.name}</code> فعال شد.` : `⛔ توکن <code>${t.name}</code> غیرفعال شد.`)
}

// ── Provider verification ────────────────────────────────────────────────────

/** Confirm a Cloudflare API token is live and read its name. */
async function verifyCfToken(token: string): Promise<{ name: string }> {
  const headers = { Authorization: `Bearer ${token}` }
  const resp = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers }).catch(() => null)
  const data = (resp ? await resp.json().catch(() => null) : null) as
    | { success?: boolean; result?: { id?: string; status?: string }; errors?: Array<{ message?: string }> }
    | null
  if (!data?.success) {
    const err = data?.errors?.[0]?.message
    if (!resp) throw new Error('اتصال به کلودفلر برقرار نشد — وضعیت اینترنت/فیلترینگ را بررسی و دوباره تلاش کنید')
    throw new Error(err ? `کلودفلر توکن را رد کرد: ${err}` : 'این توکن معتبر نیست (کلودفلر آن را نشناخت)')
  }
  if (data.result?.status && data.result.status !== 'active') throw new Error('این توکن در کلودفلر غیرفعال است')
  let name = ''
  if (data.result?.id) {
    const info = (await fetch(`https://api.cloudflare.com/client/v4/user/tokens/${data.result.id}`, { headers })
      .then((r) => r.json())
      .catch(() => null)) as { result?: { name?: string } } | null
    name = info?.result?.name ?? ''
  }
  return { name }
}

async function verifyByKind(kind: TokenKind, token: string): Promise<string> {
  if (kind === 'cf') return (await verifyCfToken(token)).name
  if (kind === 'railway') {
    const me = await verifyRailwayToken(token)
    return me.email || me.name
  }
  const owner = await verifyRenderToken(token)
  return owner.name || owner.email
}

function insertSql(spec: KindSpec): string {
  return spec.id === 'cf'
    ? "INSERT INTO cf_tokens (id, user_id, name, token, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
    : `INSERT INTO ${spec.table} (id, user_id, name, token, status, account_name, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`
}

// ── Pasted token handling ────────────────────────────────────────────────────

/** A user-supplied token name: invisible marks out, real spaces kept. */
function cleanLabel(raw: string): string {
  // eslint-disable-next-line no-misleading-character-class
  return raw.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
}

export interface TokenPasteInput {
  env: Env
  cfg: BotConfigRow
  chatId: number | string
  telegramId: string
  session: BotSession
  text: string
  /** Message that carried the secret — deleted once it is stored. */
  messageId?: number | null
}

export interface TokenPasteResult {
  screen: Screen
  /** True when the user came from the deploy wizard and it should be resumed. */
  resumeWizard: boolean
}

/** Explanation of a verification failure, with a way out of the flow. */
const failScreen = (err: unknown, spec: KindSpec): Screen => ({
  text: `❌ <b>توکن ${spec.label} ذخیره نشد</b>\n\n${err instanceof Error ? err.message : 'توکن نامعتبر است'}\n\nدوباره بفرستید یا با لغو بیرون بیایید.`,
  keyboard: { inline_keyboard: [[{ text: '❌ لغو', callback_data: 'n:tokens' }], [home]] },
})

export async function handleTokenPaste(input: TokenPasteInput): Promise<TokenPasteResult> {
  const spec = kindSpec(String(input.session.data.kind ?? 'cf'))
  const ret = String(input.session.data.ret ?? '')
  const ctx: ScreenCtx = {
    env: input.env,
    cfg: input.cfg,
    chatId: input.chatId,
    telegramId: input.telegramId,
    // Tokens always live in the caller's own isolated space.
    userId: input.cfg.user_id,
    origin: '',
  }
  // A wizard round-trip keeps its wizard state so it can be restored afterwards.
  const wizard = (input.session.data.wizard ?? null) as Record<string, unknown> | null

  const parts = input.text.split('|')
  const withName = parts.length > 1
  const token = sanitizeSecret(withName ? parts.slice(1).join('|') : parts[0])
  // The label is free text: keep its spaces, only drop invisible marks.
  const label = withName ? cleanLabel(parts[0]) : ''

  if (token.length < 20) {
    return { screen: failScreen(new Error('طول توکن درست نیست — کل رشته را از پنل سرویس کپی کنید'), spec), resumeWizard: false }
  }

  let remoteName = ''
  try {
    remoteName = await verifyByKind(spec.id, token)
  } catch (err) {
    return { screen: failScreen(err, spec), resumeWizard: false }
  }

  const name = label || remoteName || `توکن ${spec.label}`
  await input.env.DB.prepare(insertSql(spec))
    .bind(genId(), input.cfg.user_id, name, token, ...(spec.id === 'cf' ? [nowIso()] : [remoteName || null, nowIso()]))
    .run()
  await input.env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), input.cfg.user_id, spec.id === 'cf' ? 'token_created' : `${spec.id}_token_created`, 'token', name, nowIso())
    .run()

  // Wipe the message that carried the secret; best effort (ignore permission errors).
  if (input.messageId) await tg(input.cfg.bot_token, 'deleteMessage', { chat_id: input.chatId, message_id: input.messageId }).catch(() => null)

  const saved = `✅ توکن <code>${name}</code> (${spec.label}) ذخیره شد و آمادهٔ استفاده است.`
  if (ret === 'dpl' && wizard) {
    // The caller resumes the deploy wizard and shows its token step instead.
    return { screen: { text: saved }, resumeWizard: true }
  }
  return { screen: await tokensScreen(ctx, saved), resumeWizard: false }
}

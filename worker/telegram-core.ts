import type { Env } from './env'
import { genId, nowIso, safeJsonParse } from './util'

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram core — Bot API client, config resolution, access control,
//  conversation sessions and owner notifications.
//
//  The screen/UI layer lives in worker/telegram-ui.ts and the HTTP entry point
//  in worker/telegram.ts. Keeping them apart keeps every file small enough to
//  edit surgically.
// ══════════════════════════════════════════════════════════════════════════════

export interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
export interface TgMessage { message_id: number; chat: { id: number }; from?: TgUser; text?: string }
export interface TgCallbackQuery {
  id: string
  data?: string
  from?: TgUser
  message?: { message_id?: number; chat?: { id?: number } }
}
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallbackQuery }

export interface BotConfigRow {
  id: string
  user_id: string
  bot_token: string
  is_active: number
  welcome_message: string
  chat_id?: string | null
  bot_username?: string | null
  /** Legacy one-time claim code — the public deployer bot has no owner gate. */
  claim_code?: string | null
}

export interface BotSession { state: string; data: Record<string, unknown> }

/** A Telegram user of the public deployer bot — their own isolated space. */
export interface BotTenant {
  id: string
  telegram_id: string
  /** Synthetic, sign-in-less panel account that owns this space's data. */
  user_id: string
  /** The tenant's unique route token (also the personal deep-link payload). */
  access_token: string
  username?: string | null
  first_name?: string | null
}

/** Deployments a bot tenant may run (the panel owner can't be reached to ask). */
export const BOT_TENANT_QUOTA = 10

export interface TgButton { text: string; callback_data?: string; url?: string }
export interface TgKeyboard { inline_keyboard: TgButton[][] }
export interface Screen { text: string; keyboard?: TgKeyboard }

export interface ScreenCtx {
  env: Env
  cfg: BotConfigRow
  chatId: number | string
  telegramId: string
  /**
   * Owner of the data this screen may touch: the Telegram user's own isolated
   * space (bot_tenants.user_id) — never a panel account, never another user.
   */
  userId: string
  /** The caller's tenant row — their unique token and identity. */
  tenant?: BotTenant | null
  /** Bot @username, for building the personal deep link. */
  botUsername?: string | null
  /** Panel origin — used for links back into the web app. */
  origin: string
}

export interface TgEnvelope<T> { ok: boolean; result?: T; description?: string }

// ── Bot API client ───────────────────────────────────────────────────────────

export async function tg<T = unknown>(token: string, method: string, body: Record<string, unknown>): Promise<TgEnvelope<T>> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await resp.json()) as TgEnvelope<T>
  } catch {
    return { ok: false }
  }
}

export async function sendMsg(token: string, chatId: string | number, text: string, keyboard?: object): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  if (keyboard) body.reply_markup = keyboard
  await tg(token, 'sendMessage', body)
}

/** Render a screen into an existing message when possible, else send a new one. */
export async function renderScreen(
  token: string,
  chatId: string | number,
  messageId: number | null,
  screen: Screen,
): Promise<void> {
  if (messageId) {
    const res = await tg(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: screen.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
    })
    if (res.ok) return
    // 400 "message is not modified" just means the screen already shows this
    // content — nothing to do. Anything else falls back to a fresh message.
    if ((res.description ?? '').toLowerCase().includes('not modified')) return
  }
  await sendMsg(token, chatId, screen.text, screen.keyboard)
}

export function answerCb(token: string, id: string, text?: string): Promise<TgEnvelope<unknown>> {
  return tg(token, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
}

/** Register the bot's command list, profile texts and menu button. */
export async function syncBotProfile(token: string, webAppUrl: string): Promise<void> {
  await tg(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'شروع و ساخت فضای اختصاصی شما' },
      { command: 'deploy', description: 'استقرار ورکر یا پنل (Railway/Render)' },
      { command: 'workers', description: 'ورکرهای خودتان' },
      { command: 'panels', description: 'پنل‌های آمادهٔ استقرار' },
      { command: 'servers', description: 'پنل‌های Railway و Render شما' },
      { command: 'tokens', description: 'توکن‌های شما (Cloudflare/Railway/Render)' },
      { command: 'profile', description: 'توکن و لینک اختصاصی شما' },
      { command: 'quickstart', description: 'شروع سریع' },
      { command: 'menu', description: 'نمایش منو' },
      { command: 'help', description: 'راهنما' },
    ],
  })
  await tg(token, 'setMyDescription', {
    description:
      'ربات عمومی استقرار — ورکر کلودفلر بسازید یا پنل را روی Railway/Render بالا بیاورید. هر کاربر فضای اختصاصی خودش (توکن و لینک یکتا) را دارد و استقرارها با توکن خودِ او انجام می‌شود.',
  })
  await tg(token, 'setMyShortDescription', { short_description: 'استقرار ورکر و پنل، با توکن خودتان.' })
  await tg(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'باز کردن پنل', web_app: { url: webAppUrl } },
  })
}

// ── Config + sessions ────────────────────────────────────────────────────────

const CONFIG_COLUMNS = 'id, user_id, bot_token, bot_username, is_active, welcome_message, chat_id, claim_code'

export async function getActiveConfig(env: Env): Promise<BotConfigRow | null> {
  return env.DB.prepare(`SELECT ${CONFIG_COLUMNS} FROM bot_config WHERE is_active = 1 ORDER BY created_at LIMIT 1`)
    .first<BotConfigRow>()
}

/** How many bots are live right now — 0 or 1 means "a single-bot install". */
export async function activeBotCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM bot_config WHERE is_active = 1').first<{ c: number }>()
  return row?.c ?? 0
}

/**
 * Resolve which bot_config an incoming update belongs to.
 *
 * Every panel user runs **their own bot with their own tokens**, so routing must
 * be exact: Telegram echoes back the secret_token registered via setWebhook in
 * the X-Telegram-Bot-Api-Secret-Token header, and that secret maps to exactly one
 * bot_config row.
 *
 * The old code fell back to "the first active row" whenever the secret did not
 * match, which meant a second user's traffic could be served by the first user's
 * row — reading (and deploying with) *their* Cloudflare token. Now:
 *   • a matching secret wins, and
 *   • a header that matches nothing is dropped (the row is inactive/deleted), and
 *   • the legacy no-secret fallback only applies when the install genuinely runs
 *     a single bot (count == 1), so single-bot setups keep working.
 */
export async function resolveConfig(env: Env, request: Request): Promise<BotConfigRow | null> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (secret) {
    return env.DB.prepare(
      `SELECT ${CONFIG_COLUMNS} FROM bot_config WHERE webhook_secret = ? AND is_active = 1 LIMIT 1`,
    ).bind(secret).first<BotConfigRow>()
  }
  // No secret header: only a single-bot install may still be routed by default.
  if ((await activeBotCount(env)) !== 1) return null
  return getActiveConfig(env)
}

/** Best-effort delete of a chat message (used to wipe pasted secrets). */
export async function deleteMsg(token: string, chatId: string | number, messageId: number): Promise<void> {
  await tg(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null)
}

/** Strip invisible Unicode and whitespace that copy-paste injects into secrets. */
export function sanitizeSecret(raw: string): string {
  return raw
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '')
    .trim()
}

export async function saveOwnerChat(env: Env, cfg: BotConfigRow, chatId: number | string): Promise<void> {
  if (String(cfg.chat_id ?? '') === String(chatId)) return
  await env.DB.prepare('UPDATE bot_config SET chat_id = ?, updated_at = ? WHERE id = ?')
    .bind(String(chatId), nowIso(), cfg.id)
    .run()
  cfg.chat_id = String(chatId)
}

// ── Public-bot tenants ───────────────────────────────────────────────────────
//
// The bot is a standalone deployment tool, open to everyone: it is NOT tied to a
// panel account, so there is no owner/admin gate and no claim code. Every
// Telegram user gets their own space — a unique access token (their personal
// route/identity) plus an isolated, sign-in-less owner record for tokens and
// deployments. One user can never see or deploy with another user's token.

const TENANT_COLUMNS = 'id, telegram_id, user_id, access_token, username, first_name'

/** Personal tokens look like `mz-xxxxxxxxxxxx`. */
function newTenantToken(): string {
  return `mz-${genId().replace(/-/g, '').slice(0, 12)}`
}

/** Tenant by their unique token (deep links, `/start <token>`). */
export async function tenantByToken(env: Env, token: string): Promise<BotTenant | null> {
  return env.DB.prepare(`SELECT ${TENANT_COLUMNS} FROM bot_tenants WHERE access_token = ? LIMIT 1`)
    .bind(token.trim())
    .first<BotTenant>()
}

/**
 * Resolve (or provision) the space of the Telegram user behind an update.
 * The synthetic account is never given a usable password — it exists purely so
 * the existing deploy engine, quota and token tables can hold this user's data.
 */
export async function resolveTenant(
  env: Env,
  telegramId: string,
  profile: { username?: string | null; firstName?: string | null },
): Promise<BotTenant> {
  const existing = await env.DB.prepare(`SELECT ${TENANT_COLUMNS} FROM bot_tenants WHERE telegram_id = ?`)
    .bind(telegramId)
    .first<BotTenant>()
  if (existing) {
    await env.DB.prepare('UPDATE bot_tenants SET username = ?, first_name = ?, last_seen_at = ? WHERE id = ?')
      .bind(profile.username ?? null, profile.firstName ?? null, nowIso(), existing.id)
      .run()
    return existing
  }

  const userId = genId()
  const tenant: BotTenant = {
    id: genId(),
    telegram_id: telegramId,
    user_id: userId,
    access_token: newTenantToken(),
    username: profile.username ?? null,
    first_name: profile.firstName ?? null,
  }
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, role, max_deployments, created_at) VALUES (?, ?, 'telegram-tenant', 'user', ?, ?)",
  )
    .bind(userId, `tg-${telegramId}@bot.local`, BOT_TENANT_QUOTA, nowIso())
    .run()
  await env.DB.prepare(
    'INSERT INTO bot_tenants (id, telegram_id, user_id, access_token, username, first_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(tenant.id, tenant.telegram_id, tenant.user_id, tenant.access_token, tenant.username, tenant.first_name, nowIso(), nowIso())
    .run()
  return tenant
}

const sessionKey = (userId: string, telegramId: string) => `${userId}:${telegramId}`

export async function loadSession(env: Env, userId: string, telegramId: string): Promise<BotSession | null> {
  const row = await env.DB.prepare('SELECT state, data FROM bot_sessions WHERE id = ?')
    .bind(sessionKey(userId, telegramId))
    .first<{ state: string; data: string }>()
  if (!row) return null
  return { state: row.state, data: safeJsonParse<Record<string, unknown>>(row.data, {}) }
}

export async function saveSession(env: Env, userId: string, telegramId: string, session: BotSession): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO bot_sessions (id, user_id, telegram_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
  )
    .bind(sessionKey(userId, telegramId), userId, telegramId, session.state, JSON.stringify(session.data), nowIso())
    .run()
}

export async function clearSession(env: Env, userId: string, telegramId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM bot_sessions WHERE id = ?').bind(sessionKey(userId, telegramId)).run()
}

export async function trackUser(env: Env, cfg: BotConfigRow, tgId: string, username: string | null, firstName: string | null, lastName: string | null): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM bot_users WHERE user_id = ? AND telegram_id = ?')
    .bind(cfg.user_id, tgId)
    .first<{ id: string }>()
  if (existing) {
    await env.DB.prepare('UPDATE bot_users SET last_activity = ?, username = ?, first_name = ?, last_name = ? WHERE id = ?')
      .bind(nowIso(), username, firstName, lastName, existing.id)
      .run()
    return
  }
  await env.DB.prepare(
    `INSERT INTO bot_users (id, user_id, telegram_id, username, first_name, last_name, is_active, is_admin, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  )
    .bind(genId(), cfg.user_id, tgId, username, firstName, lastName, nowIso(), nowIso())
    .run()
  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), cfg.user_id, 'bot_user_joined', 'bot', username ? `@${username}` : firstName, nowIso())
    .run()
}

/**
 * Has the panel owner closed this Telegram user's access?
 *
 * The deployer bot is open to everyone, so `bot_users.is_active` is the only
 * control the owner keeps: blocking a user stops their updates from being
 * processed at all (no deploys, no token writes) until they are unblocked.
 */
export async function isBotUserBlocked(env: Env, ownerUserId: string, telegramId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT is_active FROM bot_users WHERE user_id = ? AND telegram_id = ?')
    .bind(ownerUserId, telegramId)
    .first<{ is_active: number }>()
  return !!row && !row.is_active
}

/**
 * Where a deployment's result notification should go.
 *
 * A panel account's own deployments notify its bot owner chat. Deployments made
 * from the public bot belong to a Telegram tenant instead — those must be sent
 * back to *that user*, never to the bot owner's chat.
 */
export async function ownerChat(env: Env, userId: string): Promise<{ bot_token: string; chat_id: string } | null> {
  const cfg = await env.DB.prepare('SELECT bot_token, chat_id FROM bot_config WHERE user_id = ? AND is_active = 1 LIMIT 1')
    .bind(userId)
    .first<{ bot_token: string; chat_id: string | null }>()
  if (cfg?.chat_id) return { bot_token: cfg.bot_token, chat_id: cfg.chat_id }
  const tenant = await env.DB.prepare(
    `SELECT bc.bot_token AS bot_token, bt.telegram_id AS telegram_id FROM bot_tenants bt
     JOIN bot_config bc ON bc.is_active = 1
     WHERE bt.user_id = ? ORDER BY bt.created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ bot_token: string; telegram_id: string }>()
  if (tenant?.bot_token) return { bot_token: tenant.bot_token, chat_id: tenant.telegram_id }
  return null
}

export const faDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fa-IR')
  } catch {
    return iso.slice(0, 10)
  }
}

export const STATUS_ICON: Record<string, string> = { deployed: '✅', failed: '❌', deploying: '⏳', pending: '⏳' }
export const statusIcon = (s: string) => STATUS_ICON[s] ?? '•'

export const subUrlOf = (d: { worker_url: string | null; custom_path: string | null; uuid: string | null }) =>
  d.worker_url ? `${d.worker_url}/${d.custom_path || d.uuid || ''}` : null

// ── Owner notifications (never allowed to break a deployment) ────────────────

export async function notifyDeployment(env: Env, userId: string, workerName: string, status: 'deployed' | 'failed', workerUrl: string | null, panelUrl: string | null, error?: string | null): Promise<void> {
  try {
    const target = await ownerChat(env, userId)
    if (!target) return
    const ok = status === 'deployed'
    let msg = ok
      ? `✅ <b>استقرار با موفقیت تمام شد</b>\n\n📦 <code>${workerName}</code>`
      : `❌ <b>استقرار ناموفق بود</b>\n\n📦 <code>${workerName}</code>${error ? `\n⚠️ ${error}` : ''}`
    const rows: TgButton[][] = []
    if (ok && workerUrl) {
      msg += `\n🔗 <code>${workerUrl}</code>`
      rows.push([
        { text: '🔗 باز کردن ورکر', url: workerUrl },
        ...(panelUrl ? [{ text: '🔐 پنل', url: panelUrl }] : []),
      ])
    }
    rows.push([{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, { text: '📊 داشبورد', callback_data: 'n:status' }])
    await sendMsg(target.bot_token, target.chat_id, msg, { inline_keyboard: rows })
  } catch {
    // notifications must never break deployments
  }
}

export async function notifyQuotaLevel(env: Env, userId: string, memberName: string, workerName: string, level: 1 | 2 | 3, detail: string): Promise<void> {
  try {
    const target = await ownerChat(env, userId)
    if (!target) return
    const head = level === 3 ? '⛔ سهمی تمام شد'
      : level === 2 ? '🟠 سهمی رو به اتمام (۹۰٪)'
      : '🟡 مصرف بالا (۸۰٪)'
    await sendMsg(target.bot_token, target.chat_id, `${head}\n\n👤 ${memberName} · 📦 ${workerName}\n${detail}`, {
      inline_keyboard: [[{ text: '👥 کاربران ساب', callback_data: 'l:members:0' }, { text: '🏠 منو', callback_data: 'n:menu' }]],
    })
  } catch {
    // ignore
  }
}

export async function notifyOptimizer(env: Env, userId: string, jobName: string, alive: number, total: number, subUrl: string | null): Promise<void> {
  try {
    const target = await ownerChat(env, userId)
    if (!target) return
    const msg = `⚡ <b>بهینه‌سازی کامل شد</b>\n\n📋 ${jobName}\n🟢 سالم: ${alive} از ${total}${subUrl ? `\n\n🔗 <code>${subUrl}</code>` : ''}`
    await sendMsg(target.bot_token, target.chat_id, msg, {
      inline_keyboard: [[{ text: '⚡ ساب‌های بهینه', callback_data: 'l:optimizer:0' }, { text: '🏠 منو', callback_data: 'n:menu' }]],
    })
  } catch {
    // ignore
  }
}

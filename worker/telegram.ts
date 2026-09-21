import type { Env } from './env'
import { replyKeyboard, routeCallback, routeText } from './telegram-ui'
import {
  answerCb,
  isBotUserBlocked,
  loadSession,
  notifyDeployment,
  notifyOptimizer,
  notifyQuotaLevel,
  renderScreen,
  resolveConfig,
  resolveTenant,
  sendMsg,
  tg,
  trackUser,
  type BotConfigRow,
  type BotTenant,
  type Screen,
  type TgUpdate,
} from './telegram-core'

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram webhook — the HTTP edge of the **public deployer bot**.
//
//  The bot is not tied to a panel account: there is no owner to claim it, no
//  access level to pass and no panel screen behind it. Every Telegram user who
//  writes to it gets their own isolated space (a unique token + their own
//  tokens and deployments), so the only job here is:
//
//    1. work out which bot the update belongs to (per-bot webhook secret),
//    2. resolve/provision that user's space,
//    3. hand the update to the router and answer Telegram immediately.
//
//  Telegram retries any webhook it considers slow, so the heavy work always runs
//  inside ctx.waitUntil().
// ══════════════════════════════════════════════════════════════════════════════

// Re-exported so worker/index.ts, worker/deploy.ts and worker/members.ts keep a
// single import path for both the webhook and the owner notifications.
export { notifyDeployment, notifyOptimizer, notifyQuotaLevel }

/** Deep-link payloads: /start workers, /start deploy, … */
const DEEP_LINKS: Record<string, string> = {
  workers: 'l:workers:0',
  panels: 'l:panels:0',
  servers: 'l:servers:0',
  tokens: 'n:tokens',
  deploy: 'dpl:start',
  profile: 'n:profile',
  help: 'n:help',
}

/** Screens that come back with the persistent tab keyboard attached. */
const MAIN_SCREENS = new Set(['l:workers:0', 'l:panels:0', 'l:servers:0', 'n:tokens', 'n:profile'])

/**
 * Telegram accepts a single `reply_markup` per message, so the persistent tab
 * keyboard and a screen's inline buttons can never travel together — sending
 * the tabs used to silently drop the buttons (the "broken bot" report: text
 * arrived with no buttons under it).
 *
 * They are therefore delivered as two messages: a one-line hint that installs
 * the tab keyboard, then the screen itself with its own buttons. Telegram keeps
 * the reply keyboard visible until it is replaced, so the tabs stay put for
 * every later screen and tab presses never need this again.
 */
async function installTabKeyboard(token: string, chatId: number | string): Promise<void> {
  await sendMsg(token, chatId, '⌨️ منوی سریع فعال شد — از دکمه‌های پایین هم می‌توانید استفاده کنید.', replyKeyboard()).catch(() => null)
}

function jsonOk(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A lightweight "the bot is working" signal — the app-like touch. */
function typing(token: string, chatId: number | string): Promise<unknown> {
  return tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' })
}

function errorScreen(): Screen {
  return {
    text: '⚠️ خطای غیرمنتظره رخ داد. لطفاً دوباره تلاش کنید.',
    keyboard: { inline_keyboard: [[{ text: '🔄 تلاش دوباره', callback_data: 'n:menu' }]] },
  }
}

/**
 * The data scope every screen must use: the caller's own tenant space.
 *
 * `cfg` keeps the bot's own settings (token, welcome message) while `user_id`
 * is swapped for the tenant's isolated owner record, so no query a screen makes
 * can ever reach another user's — or a panel account's — tokens and deploys.
 */
function scopeToTenant(cfg: BotConfigRow, tenant: BotTenant): BotConfigRow {
  return { ...cfg, user_id: tenant.user_id }
}

export async function handleTelegramWebhook(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
): Promise<Response> {
  const origin = new URL(request.url).origin

  let update: TgUpdate
  try {
    update = (await request.json()) as TgUpdate
  } catch {
    return jsonOk()
  }

  const cfg = await resolveConfig(env, request)
  if (!cfg) return jsonOk()
  const bt = cfg.bot_token

  const from = update.callback_query?.from ?? update.message?.from
  const chatId: number | undefined = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id
  if (!from?.id || !chatId) return jsonOk()
  const telegramId = String(from.id)

  // Public deployer: provision (or refresh) this Telegram user's own space.
  let tenant: BotTenant
  try {
    tenant = await resolveTenant(env, telegramId, { username: from.username ?? null, firstName: from.first_name ?? null })
  } catch {
    // Could not provision (transient D1 error) — retry on the next update.
    return jsonOk()
  }
  // The owner's block list is the bot's only access control: a blocked user is
  // answered once and never reaches a screen (so they can neither deploy nor
  // write tokens).
  if (await isBotUserBlocked(env, cfg.user_id, telegramId).catch(() => false)) {
    ctx.waitUntil(
      sendMsg(
        bt,
        chatId,
        '🚫 <b>دسترسی شما به این ربات بسته شده است.</b>\n\nاگر فکر می‌کنید اشتباهی رخ داده، با مدیر پنل تماس بگیرید.',
      ).catch(() => null),
    )
    return jsonOk()
  }

  const botCfg = scopeToTenant(cfg, tenant)
  const shared = {
    env,
    exec: ctx,
    cfg: botCfg,
    telegramId,
    userId: tenant.user_id,
    tenant,
    botUsername: cfg.bot_username ?? null,
    origin,
  }

  // ── Inline button presses ────────────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query
    const messageId = cq.message?.message_id ?? null
    ctx.waitUntil(answerCb(bt, cq.id).catch(() => null))
    ctx.waitUntil(
      (async () => {
        try {
          const session = await loadSession(env, tenant.user_id, telegramId)
          const screen = await routeCallback({
            ...shared,
            chatId,
            session,
            data: cq.data ?? '',
          })
          if (screen) await renderScreen(bt, chatId, messageId, screen)
        } catch (err) {
          console.error('telegram callback failed', err)
          await renderScreen(bt, chatId, messageId, errorScreen())
        }
      })(),
    )
    return jsonOk()
  }

  // ── Text messages ────────────────────────────────────────────────────────
  const message = update.message
  if (!message) return jsonOk()

  // Anything that is not text gets a short nudge instead of silence.
  if (!message.text) {
    ctx.waitUntil(
      sendMsg(bt, chatId, 'فقط پیام متنی پشتیبانی می‌شود. از منوی پایین استفاده کنید.', replyKeyboard()).catch(() => null),
    )
    return jsonOk()
  }

  const text = message.text.trim()

  ctx.waitUntil(
    (async () => {
      try {
        // Analytics for whoever connected this bot (the panel side's user list).
        await trackUser(env, cfg, telegramId, from.username ?? null, from.first_name ?? null, from.last_name ?? null)

        const session = await loadSession(env, tenant.user_id, telegramId)
        const args = { ...shared, chatId, session, data: '', messageId: message.message_id }

        await typing(bt, chatId).catch(() => null)

        // `/start <payload>` deep links land directly on the requested section.
        const [cmd, ...rest] = text.split(/\s+/)
        const deep = cmd === '/start' && rest[0] ? DEEP_LINKS[rest[0].toLowerCase()] : undefined
        if (deep) {
          const screen = await routeCallback({ ...args, data: deep })
          if (screen) {
            if (MAIN_SCREENS.has(deep)) await installTabKeyboard(bt, chatId)
            await renderScreen(bt, chatId, null, screen)
            return
          }
        }

        const screen = await routeText(args, text)
        if (!screen) return

        // The tabs are installed once, with the main screens.
        if (cmd === '/start' || text === '/menu' || text === '/quickstart' || MAIN_SCREENS.has(text)) {
          await installTabKeyboard(bt, chatId)
        }
        // A tab press just re-renders its screen; the tab keyboard is already on
        // screen, so the screen's own buttons must be sent untouched.
        await renderScreen(bt, chatId, null, screen)
      } catch (err) {
        console.error('telegram update failed', err)
        await sendMsg(bt, chatId, errorScreen().text).catch(() => null)
      }
    })(),
  )

  return jsonOk()
}

import type { Env } from './env'
import { genId, nowIso, safeJsonParse } from './util'
import { PANELS, panelsForTarget, panelOriginLabel, panelVerifiedLabel, resolvePanel } from '../shared/panels'
import { autoWorkerSources } from '../shared/worker-sources'
import { startDeployment } from './deploy'
import { startPanelDeploy, watchPanelDeploy, type PanelWatchResult, type StartPanelDeployResult } from './panel-deploy'
import {
  deleteTokenRow,
  findToken,
  handleTokenPaste,
  isTokenKind,
  kindSpec,
  tokenAddScreen,
  tokenDeleteScreen,
  tokensScreen,
  toggleTokenRow,
} from './bot-tokens'
import {
  type BotConfigRow, type BotSession, type BotTenant, type Screen, type ScreenCtx, type TgButton,
  clearSession, faDate, loadSession, saveSession, sendMsg, statusIcon, subUrlOf, tenantByToken,
} from './telegram-core'

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram UI — every screen of the bot plus the router that turns a command
//  or a button press into exactly one screen.
//
//  Design rules:
//   • Every screen is ONE message, edited in place (no chat spam).
//   • Persistent reply keyboard = the app's tabs, inline keyboard = actions.
//   • Callback payloads carry row ids (never names) so `callback_data` stays
//     well inside Telegram's 64-byte limit.
//   • Data screens are owner/admin only; strangers get a polite gate with a
//     "request access" button that pings the owner.
// ══════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 6

// ── Persistent reply keyboard = the app tabs ─────────────────────────────────

/**
 * The bot is a standalone **deployer**: its tabs are deployment-only.
 * Panel management screens (dashboard, optimizer, subscribers, panel users,
 * settings) deliberately do not exist here — the bot has no other job and no
 * other connection to the panel.
 */
export const MENU = {
  workers: '📋 ورکرها',
  panels: '🧩 پنل‌ها',
  servers: '🖥 سرورها',
  tokens: '🔑 توکن‌ها',
  profile: '👤 پروفایل من',
  help: '📖 راهنما',
} as const

export function replyKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [MENU.workers, MENU.tokens],
      [MENU.panels, MENU.servers],
      [MENU.profile, MENU.help],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'یک گزینه را انتخاب کنید',
  }
}

const homeButton = (): TgButton => ({ text: '🏠 منوی اصلی', callback_data: 'n:menu' })
const backButton = (target: string, label = '🔙 بازگشت'): TgButton => ({ text: label, callback_data: target })

function paginate<T>(rows: T[], page: number): { slice: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safe = Math.min(Math.max(0, page), pages - 1)
  return { slice: rows.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE), pages, page: safe }
}

function pagerRow(kind: string, page: number, pages: number): TgButton[] | null {
  if (pages <= 1) return null
  return [
    { text: '◀️', callback_data: `l:${kind}:${Math.max(0, page - 1)}` },
    { text: `صفحهٔ ${page + 1} از ${pages}`, callback_data: 'noop' },
    { text: '▶️', callback_data: `l:${kind}:${Math.min(pages - 1, page + 1)}` },
  ]
}

// ── Screens ──────────────────────────────────────────────────────────────────

export function menuScreen(ctx: ScreenCtx): Screen {
  const welcome = ctx.cfg.welcome_message?.trim() || '🚀 به ربات استقرار میلی‌کانفیگ خوش آمدید.'
  const rows: TgButton[][] = [
    [{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }],
    [{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, { text: '🔑 توکن‌های من', callback_data: 'n:tokens' }],
    [{ text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0' }, { text: '🖥 سرورها', callback_data: 'l:servers:0' }],
    [{ text: '👤 پروفایل و توکن من', callback_data: 'n:profile' }],
    [{ text: '📖 راهنما', callback_data: 'n:help' }, { text: '🔍 جست‌وجو', callback_data: 'n:search' }],
  ]
  return {
    text:
      `${welcome}\n\n` +
      '<b>منوی اصلی</b>\n' +
      'این ربات فقط برای <b>استقرار</b> است: ورکر کلودفلر یا پنل روی Railway/Render — با توکن خودتان.\n' +
      'هر صفحه در همین پیام به‌روز می‌شود.',
    keyboard: { inline_keyboard: rows },
  }
}

/**
 * The user's own space: their unique token + personal deep link and their
 * deployment counters. The bot has no panel account, so this — and the deploy
 * screens — is the whole relationship between the bot and its users.
 */
export async function profileScreen(ctx: ScreenCtx): Promise<Screen> {
  const { env } = ctx
  const [tokens, deployed, failed, rails, renders, me, latest] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM cf_tokens WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM deployments WHERE user_id = ? AND status = 'deployed'").bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM deployments WHERE user_id = ? AND status = 'failed'").bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM railway_deploys WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM render_deploys WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT access_token, created_at FROM bot_tenants WHERE telegram_id = ?')
      .bind(ctx.telegramId).first<{ access_token: string; created_at: string }>(),
    env.DB.prepare('SELECT id, name, status, created_at FROM deployments WHERE user_id = ? ORDER BY created_at DESC LIMIT 3')
      .bind(ctx.userId).all<{ id: string; name: string; status: string; created_at: string }>(),
  ])

  const token = ctx.tenant?.access_token ?? me?.access_token ?? '—'
  const link = ctx.botUsername ? `https://t.me/${ctx.botUsername}?start=${token}` : `t.me/<bot>?start=${token}`
  let text =
    '👤 <b>فضای استقرار شما</b>\n\n' +
    `🆔 شناسهٔ تلگرام: <code>${ctx.telegramId}</code>\n` +
    `🔑 توکن اختصاصی شما: <code>${token}</code>\n` +
    `🔗 لینک اختصاصی: <code>${link}</code>\n\n` +
    '<i>این لینک و توکن فقط مال شماست؛ با آن همیشه به فضای خودتان برمی‌گردید. توکن‌ها، ورکرها و استقرارهای هیچ کاربر دیگری برای شما نمایش داده نمی‌شود و شما هم به آن‌ها دسترسی ندارید.</i>\n\n' +
    `🔑 توکن‌های ثبت‌شده: <b>${tokens?.c ?? 0}</b>\n` +
    `🚀 ورکرهای فعال: <b>${deployed?.c ?? 0}</b>${failed?.c ? ` · ناموفق: ${failed.c}` : ''}\n` +
    `🏗 پنل Railway: <b>${rails?.c ?? 0}</b> · ☁️ پنل Render: <b>${renders?.c ?? 0}</b>\n`
  if (latest.results.length) {
    text += '\n<b>آخرین استقرارها</b>\n'
    for (const d of latest.results) text += `${statusIcon(d.status)} <code>${d.name}</code> · ${faDate(d.created_at)}\n`
  }
  if (me?.created_at) text += `\n📅 عضویت: ${faDate(me.created_at)}`

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '📋 کپی لینک اختصاصی', callback_data: `cpf:${token}` }],
        [{ text: '🔄 بروزرسانی', callback_data: 'n:profile' }, { text: '🔑 توکن‌های من', callback_data: 'n:tokens' }],
        [{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, homeButton()],
      ],
    },
  }
}

interface DeploymentRow {
  id: string
  name: string
  status: string
  worker_url: string | null
  panel_url: string | null
  uuid: string | null
  custom_path: string | null
  method: string | null
  worker_source: string | null
  created_at: string
}

const DEPLOYMENT_COLUMNS = 'id, name, status, worker_url, panel_url, uuid, custom_path, method, worker_source, created_at'

export async function workersScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const rows = await ctx.env.DB.prepare(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(ctx.userId).all<DeploymentRow>()
  if (!rows.results.length) {
    return {
      text: '📋 <b>ورکرها</b>\n\nهنوز ورکری مستقر نکرده‌اید.\nبا دکمهٔ «🚀 استقرار ورکر جدید» اولین ورکر را بسازید.',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار ورکر جدید', callback_data: 'dpl:start' }], [homeButton()]] },
    }
  }
  const { slice, pages, page: current } = paginate(rows.results, page)
  const keyboard: TgButton[][] = slice.map((d) => [
    { text: `${statusIcon(d.status)} ${d.name}`, callback_data: `w:${d.id}` },
    { text: d.status === 'deployed' ? '📋 ساب' : '⏳', callback_data: d.status === 'deployed' ? `cp:${d.id}:sub` : 'noop' },
  ])
  const pager = pagerRow('workers', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([{ text: '🔄 بروزرسانی', callback_data: `l:workers:${current}` }, { text: '🚀 استقرار جدید', callback_data: 'dpl:start' }])
  keyboard.push([homeButton()])
  return {
    text: `📋 <b>ورکرها</b> — ${rows.results.length} مورد\n\nروی هر ورکر بزنید تا ساب، پنل و جزئیاتش را ببینید.`,
    keyboard: { inline_keyboard: keyboard },
  }
}

export async function workerScreen(ctx: ScreenCtx, id: string): Promise<Screen> {
  const d = await ctx.env.DB.prepare(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ? AND user_id = ?`,
  ).bind(id, ctx.userId).first<DeploymentRow>()
  if (!d) {
    return { text: '❌ این ورکر پیدا نشد یا حذف شده است.', keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] } }
  }
  const sub = subUrlOf(d)
  const source = autoWorkerSources().find((s) => s.id === (d.worker_source ?? ''))?.name ?? d.worker_source ?? '—'

  let text =
    `${statusIcon(d.status)} <b>${d.name}</b>\n` +
    `<i>${d.status === 'deployed' ? 'مستقر' : d.status === 'failed' ? 'ناموفق' : 'در حال استقرار'}</i>\n\n` +
    `🧬 سورس: ${source}\n` +
    `🛠 روش: ${d.method === 'pages' ? 'Cloudflare Pages' : 'Cloudflare Workers'}\n` +
    `📅 ساخته‌شده: ${faDate(d.created_at)}\n`
  if (sub) text += `\n🔗 <b>ساب</b>\n<code>${sub}</code>\n`
  if (d.panel_url) text += `\n🔐 <b>پنل</b>\n<code>${d.panel_url}</code>\n`

  const rows: TgButton[][] = []
  const linkRow: TgButton[] = []
  if (sub) linkRow.push({ text: '🔗 باز کردن ساب', url: sub })
  if (d.panel_url) linkRow.push({ text: '🔐 پنل ورکر', url: d.panel_url })
  if (linkRow.length) rows.push(linkRow)

  const copyRow: TgButton[] = []
  if (sub) copyRow.push({ text: '📋 کپی ساب', callback_data: `cp:${d.id}:sub` })
  if (d.panel_url) copyRow.push({ text: '📋 کپی پنل', callback_data: `cp:${d.id}:panel` })
  if (copyRow.length) rows.push(copyRow)

  rows.push([{ text: '🔗 کانفیگ‌ها', callback_data: 'l:configs:0' }])
  rows.push([{ text: '🗑 حذف ورکر', callback_data: `del:${d.id}` }])
  rows.push([backButton('l:workers:0', '🔙 ورکرها'), homeButton()])

  return { text, keyboard: { inline_keyboard: rows } }
}

export async function configsScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const rows = await ctx.env.DB.prepare(
    "SELECT id, name, worker_url, uuid, custom_path FROM deployments WHERE user_id = ? AND status = 'deployed' ORDER BY created_at DESC LIMIT 100",
  ).bind(ctx.userId).all<{ id: string; name: string; worker_url: string; uuid: string | null; custom_path: string | null }>()
  if (!rows.results.length) {
    return { text: '🔗 هنوز کانفیگی آماده نیست — اول یک ورکر مستقر کنید.', keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [homeButton()]] } }
  }
  const { slice, pages, page: current } = paginate(rows.results, page)
  let text = '🔗 <b>کانفیگ‌های آماده</b>\n\n'
  const keyboard: TgButton[][] = []
  for (const d of slice) {
    const sub = `${d.worker_url}/${d.custom_path || d.uuid || ''}`
    text += `📦 <b>${d.name}</b>\n<code>${sub}</code>\n\n`
    keyboard.push([{ text: `📋 کپی ساب ${d.name}`, callback_data: `cp:${d.id}:sub` }])
  }
  const pager = pagerRow('configs', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export function panelsScreen(page: number): Screen {
  const { slice, pages, page: current } = paginate(PANELS, page)
  let text = '🧩 <b>کاتالوگ پنل‌ها</b>\n<i>همهٔ مخازن قبل از افزودن بررسی شده و فعال بودنشان تأیید شده است.</i>\n\n'
  const keyboard: TgButton[][] = []
  for (const p of slice) {
    text += `${panelOriginLabel(p)} <b>${p.name}</b>\n${p.tagline}\n\n`
    keyboard.push([{ text: `ℹ️ ${p.name}`, callback_data: `p:${p.id}` }])
  }
  const pager = pagerRow('panels', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([{ text: '🖥 سرورهای من', callback_data: 'l:servers:0' }, homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export function panelScreen(id: string, origin: string): Screen {
  const panel = PANELS.find((p) => p.id === id)
  if (!panel) {
    return { text: '❌ پنل پیدا نشد.', keyboard: { inline_keyboard: [[{ text: '🧩 کاتالوگ', callback_data: 'l:panels:0' }], [homeButton()]] } }
  }
  const p = resolvePanel(panel.id)
  const targets = p.targets.map((t) => (t === 'railway' ? 'Railway' : t === 'render' ? 'Render' : 'VPS')).join(' · ')
  let text =
    `${panelOriginLabel(p)} <b>${p.name}</b>\n<i>${p.tagline}</i>\n\n` +
    `🐳 اجرا: ${p.runtime === 'docker' ? 'Docker' : 'Python'}\n` +
    `🔢 پورت: <code>${p.port}</code> · مسیر پنل: <code>${p.panelPath}</code>\n` +
    `🎯 هدف‌ها: ${targets}\n` +
    `📦 مخزن: <code>${p.repo}</code>\n`
  if (p.dockerImage) text += `🏷 ایمیج: <code>${p.dockerImage}</code>\n`
  if (p.lastCommit) text += `✅ آخرین کامیت مخزن: <code>${p.lastCommit}</code> · ${panelVerifiedLabel(p)}\n`
  if (p.notes) text += `\n⚠️ ${p.notes}\n`

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '↗ صفحهٔ GitHub', url: p.url }],
        [{ text: '🚀 استقرار از پنل وب', url: `${origin}/#/deploy` }],
        [backButton('l:panels:0', '🔙 کاتالوگ'), homeButton()],
      ],
    },
  }
}

interface ServerItem {
  label: string
  panelName: string
  meta: string
  base: string | null
  path: string
  admin: string | null
}

export async function serversScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const [rails, renders] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, name, panel, region, domain, admin_username, created_at FROM railway_deploys
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(ctx.userId).all<{ id: string; name: string | null; panel: string | null; region: string; domain: string | null; admin_username: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      `SELECT id, name, panel, url, admin_username, created_at FROM render_deploys
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(ctx.userId).all<{ id: string; name: string | null; panel: string | null; url: string | null; admin_username: string | null; created_at: string }>(),
  ])

  const items: ServerItem[] = []
  for (const r of rails.results) {
    const panel = resolvePanel(r.panel)
    items.push({
      label: r.name ?? panel.name,
      panelName: panel.name,
      meta: `🏗 Railway · 📍 ${r.region} · ${faDate(r.created_at)}`,
      base: r.domain ? `https://${r.domain}` : null,
      path: panel.panelPath,
      admin: r.admin_username,
    })
  }
  for (const r of renders.results) {
    const panel = resolvePanel(r.panel)
    items.push({
      label: r.name ?? panel.name,
      panelName: panel.name,
      meta: `☁️ Render · 📅 ${faDate(r.created_at)}`,
      base: r.url,
      path: panel.panelPath,
      admin: r.admin_username,
    })
  }

  if (!items.length) {
    return {
      text: '🖥 <b>سرورها</b>\n\nهنوز پنلی روی Railway یا Render مستقر نشده است.\nهمین‌جا با «🚀 استقرار جدید → پنل Railway/Render» مستقر کنید یا از پنل وب استفاده کنید.',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار پنل', callback_data: 'dpl:start' }, { text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0' }], [homeButton()]] },
    }
  }

  const { slice, pages, page: current } = paginate(items, page)
  let text = `🖥 <b>سرورهای مستقرشده</b> — ${items.length} مورد\n\n`
  const keyboard: TgButton[][] = []
  for (const s of slice) {
    text += `<b>${s.label}</b> — ${s.panelName}\n${s.meta}\n`
    if (s.admin) text += `👤 ادمین: <code>${s.admin}</code>\n`
    if (s.base) {
      text += `🔐 <code>${s.base}${s.path}</code>\n\n`
      keyboard.push([{ text: `🔐 پنل ${s.panelName}`, url: `${s.base}${s.path}` }])
    } else {
      text += '⏳ دامنهٔ عمومی هنوز فعال نشده\n\n'
    }
  }
  const pager = pagerRow('servers', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export function helpScreen(): Screen {
  return {
    text:
      '📖 <b>راهنمای ربات استقرار</b>\n\n' +
      'این ربات <b>عمومی و فقط برای استقرار</b> است: ورکر کلودفلر بسازید یا پنل را روی Railway/Render بالا بیاورید. هیچ بخش مدیریت پنل (داشبورد، کاربران، تنظیمات) در آن نیست.\n\n' +
      '<b>دستورات</b>\n' +
      '/start — شروع و منوی اصلی\n' +
      '/deploy — استقرار ورکر یا پنل Railway/Render (ویزارد)\n' +
      '/profile — توکن و لینک اختصاصی شما\n' +
      '/quickstart — چند قدم تا اولین استقرار\n' +
      '/workers — لیست ورکرهای خودتان\n' +
      '/panels — کاتالوگ پنل‌ها\n' +
      '/servers — پنل‌های Railway و Render شما\n' +
      '/tokens — توکن‌ها (افزودن/غیرفعال‌کردن/حذف از همین‌جا)\n' +
      '/config &lt;name&gt; — لینک پنل و ساب یک ورکر\n' +
      '/sub &lt;name&gt; — لینک ساب\n' +
      '/menu — نمایش منو\n' +
      '/help — همین راهنما\n\n' +
      '<b>توکن‌ها و امنیت</b>\n' +
      '• هر کاربر توکن و لینک اختصاصی خودش را دارد؛ توکن‌ها، ورکرها و استقرارهای شما با هیچ کاربر دیگری مشترک نیست.\n' +
      '• توکن‌ها را در «🔑 توکن‌ها» همین‌جا اضافه کنید؛ قبل از ذخیره با خود سرویس بررسی می‌شود و پیام حاوی توکن پاک می‌گردد.\n\n' +
      '<b>نکته‌ها</b>\n' +
      '• همهٔ صفحه‌ها در یک پیام به‌روز می‌شوند تا چت شلوغ نشود.\n' +
      '• دکمهٔ «📋 کپی …» لینک را به‌صورت متن کدشده می‌فرستد؛ با یک لمس کپی می‌شود.',
    keyboard: {
      inline_keyboard: [
        [{ text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0' }, { text: '👤 پروفایل من', callback_data: 'n:profile' }],
        [homeButton()],
      ],
    },
  }
}

// ── Deploy wizard ────────────────────────────────────────────────────────────

/** `Record<string, unknown>` so it can also be persisted as a bot session. */
interface WizardData extends Record<string, unknown> {
  /** Cloudflare branch — worker execution method. */
  method?: 'workers' | 'pages'
  source?: string
  /** Row id + name of whichever token the deploy runs with (CF/Railway/Render). */
  tokenId?: string
  tokenName?: string
  name?: string
  uuid?: string
  /** Railway/Render branch — destination platform + catalog panel id. */
  target?: 'railway' | 'render'
  panel?: string
}

function randomName(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return `mil-${out}`
}

export function deployStartScreen(): Screen {
  return {
    text:
      '🚀 <b>استقرار جدید</b>\n\n' +
      'چه چیزی مستقر کنیم؟\n\n' +
      '⚡ <b>ورکر کلودفلر</b> — ورکر VLESS با پنل داخلی، ساب و KV خودکار (روش پیشنهادی و کامل).\n' +
      '🏗 <b>پنل روی Railway</b> — پنل‌های کاتالوگ با دامنهٔ رایگان <code>*.up.railway.app</code>.\n' +
      '☁️ <b>پنل روی Render</b> — همان پنل‌ها روی Render.com.',
    keyboard: {
      inline_keyboard: [
        [{ text: '⚡ ورکر کلودفلر', callback_data: 'dpl:m:workers' }],
        [{ text: '🏗 پنل روی Railway', callback_data: 'dpl:T:railway' }, { text: '☁️ Render', callback_data: 'dpl:T:render' }],
        [{ text: '📄 Pages (بتا)', callback_data: 'dpl:m:pages' }],
        [backButton('n:menu')],
      ],
    },
  }
}

/** Railway/Render branch — pick a panel from the shared catalog. */
export function deployPanelScreen(data: WizardData): Screen {
  const target = data.target === 'render' ? 'render' : 'railway'
  const panels = panelsForTarget(target)
  const keyboard: TgButton[][] = panels.map((p) => [{ text: `🧩 ${p.name}`, callback_data: `dpl:p:${p.id}` }])
  keyboard.push([backButton('dpl:start', '🔙 روش استقرار')])
  return {
    text:
      `<b>استقرار پنل روی ${target === 'render' ? 'Render' : 'Railway'} — انتخاب پنل</b>\n\n` +
      panels
        .map((p) => {
          const verified = panelVerifiedLabel(p)
          return `• <b>${p.name}</b> — <i>${p.tagline}</i>${verified ? `\n  ${verified}` : ''}`
        })
        .join('\n'),
    keyboard: { inline_keyboard: keyboard },
  }
}

export function deploySourceScreen(): Screen {
  const sources = autoWorkerSources()
  const keyboard: TgButton[][] = sources.map((s) => [{ text: `🧬 ${s.name}`, callback_data: `dpl:s:${s.id}` }])
  let text = '<b>مرحلهٔ ۲ از ۴ — منبع ورکر</b>\n\n'
  for (const s of sources) text += `• <b>${s.name}</b>\n  <i>${s.description}</i>\n`
  keyboard.push([backButton('dpl:start', '🔙 روش اجرا')])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export async function deployTokenScreen(ctx: ScreenCtx, data: WizardData): Promise<Screen> {
  // Railway/Render branch — the platform token decides where the panel lands.
  if (data.target === 'railway' || data.target === 'render') {
    const table = data.target === 'railway' ? 'railway_tokens' : 'render_tokens'
    const label = data.target === 'railway' ? 'Railway' : 'Render'
    const ts = await ctx.env.DB.prepare(`SELECT id, name FROM ${table} WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20`)
      .bind(ctx.userId).all<{ id: string; name: string }>()
    if (!ts.results.length) {
      return {
        text: `🔑 <b>توکن ${label} لازم است</b>\n\nروی این حساب هیچ توکن فعال ${label}ی ثبت نشده است. همین‌جا اضافه کنید — توکن روی حساب خودتان ذخیره می‌شود و به هیچ حساب دیگری وصل نیست.`,
        keyboard: {
          inline_keyboard: [
            [{ text: `➕ افزودن توکن ${label}`, callback_data: `tok:add:${data.target}:dpl` }],
            [{ text: '🌐 مدیریت توکن‌ها در پنل وب', url: `${ctx.origin}/#/tokens` }],
            [backButton('dpl:p:', '🔙 انتخاب پنل')],
          ],
        },
      }
    }
    const keyboard: TgButton[][] = ts.results.map((t) => [{ text: `🔑 ${t.name}`, callback_data: `dpl:t:${t.id}` }])
    keyboard.push([{ text: `➕ افزودن توکن ${label}`, callback_data: `tok:add:${data.target}:dpl` }])
    keyboard.push([backButton('dpl:p:', '🔙 انتخاب پنل')])
    return { text: `<b>توکن ${label}</b>\n\nاستقرار پنل با این حساب انجام می‌شود؛ یکی را انتخاب کنید (این توکن‌ها فقط مال حساب خودتان هستند):`, keyboard: { inline_keyboard: keyboard } }
  }

  const ts = await ctx.env.DB.prepare("SELECT id, name FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20")
    .bind(ctx.userId).all<{ id: string; name: string }>()
  if (!ts.results.length) {
    return {
      text: '🔑 <b>توکن کلودفلر لازم است</b>\n\nروی این حساب هیچ توکن فعال کلودفلری ثبت نشده است. همین‌جا اضافه کنید — توکن روی حساب خودتان ذخیره می‌شود و با توکن هیچ حساب دیگری مشترک نیست.',
      keyboard: {
        inline_keyboard: [
          [{ text: '➕ افزودن توکن کلودفلر', callback_data: 'tok:add:cf:dpl' }],
          [{ text: '🌐 مدیریت توکن‌ها در پنل وب', url: `${ctx.origin}/#/tokens` }],
          [backButton('dpl:start', '🔙 روش اجرا')],
        ],
      },
    }
  }
  const keyboard: TgButton[][] = ts.results.map((t) => [{ text: `🔑 ${t.name}`, callback_data: `dpl:t:${t.id}` }])
  keyboard.push([{ text: '➕ افزودن توکن کلودفلر', callback_data: 'tok:add:cf:dpl' }])
  keyboard.push([backButton('dpl:start', '🔙 روش اجرا')])
  return { text: '<b>مرحلهٔ ۳ از ۴ — انتخاب توکن</b>\n\nتوکنی که استقرار با آن انجام می‌شود را انتخاب کنید (فقط توکن‌های حساب خودتان نمایش داده می‌شود):', keyboard: { inline_keyboard: keyboard } }
}

export function deployConfirmScreen(data: WizardData, uuid: string): Screen {
  // Railway/Render branch — panel + platform + token summary.
  if (data.target === 'railway' || data.target === 'render') {
    const panel = resolvePanel(data.panel)
    const label = data.target === 'railway' ? 'Railway' : 'Render'
    return {
      text:
        `<b>تأیید نهایی — پنل روی ${label}</b>\n\n` +
        `🧩 پنل: <b>${panel.name}</b>\n` +
        `📦 نام پروژه: <code>${data.name ?? ''}</code>\n` +
        `🔑 توکن: <code>${data.tokenName ?? ''}</code>\n\n` +
        'رمز ادمین به‌صورت تصادفی ساخته و به‌عنوان متغیر محیطی سرویس ست می‌شود؛ بعد از آماده‌شدن فقط همین‌جا یک‌بار نمایش داده می‌شود.\n' +
        'با تأیید، استقرار شروع می‌شود و نتیجه همین‌جا اعلام خواهد شد.',
      keyboard: {
        inline_keyboard: [
          [{ text: '✅ شروع استقرار پنل', callback_data: 'dpl:go' }],
          [{ text: '✏️ تغییر نام', callback_data: 'dpl:name' }],
          [backButton('dpl:p:', '❌ لغو / تغییر پنل')],
        ],
      },
    }
  }

  const source = autoWorkerSources().find((s) => s.id === data.source)?.name ?? data.source ?? '—'
  return {
    text:
      '<b>مرحلهٔ ۴ از ۴ — تأیید نهایی</b>\n\n' +
      `📦 نام ورکر: <code>${data.name ?? ''}</code>\n` +
      `🆔 UUID: <code>${uuid}</code>\n` +
      `🧬 منبع: ${source}\n` +
      `🛠 روش: ${data.method === 'pages' ? 'Cloudflare Pages' : 'Cloudflare Workers'}\n` +
      `🔑 توکن: <code>${data.tokenName ?? ''}</code>\n\n` +
      'با تأیید، استقرار شروع می‌شود و نتیجه همین‌جا اعلام خواهد شد.',
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ شروع استقرار', callback_data: 'dpl:go' }],
        [{ text: '✏️ تغییر نام', callback_data: 'dpl:name' }, { text: '🎲 UUID جدید', callback_data: 'dpl:uuid' }],
        [backButton('dpl:start', '❌ لغو')],
      ],
    },
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export interface RouterArgs {
  env: Env
  /** Worker execution context — the deploy wizard needs it for waitUntil(). */
  exec: ExecutionContext
  cfg: BotConfigRow
  chatId: number | string
  telegramId: string
  /** The Telegram user's isolated space — the bot's only data scope. */
  userId: string
  tenant?: BotTenant | null
  /** Bot @username, used to build the user's personal deep link. */
  botUsername?: string | null
  origin: string
  session: BotSession | null
  data: string
  /** Message that produced this update — lets the bot delete pasted secrets. */
  messageId?: number | null
}

const screenCtx = (args: RouterArgs): ScreenCtx => ({
  env: args.env,
  cfg: args.cfg,
  chatId: args.chatId,
  telegramId: args.telegramId,
  userId: args.userId,
  tenant: args.tenant,
  botUsername: args.botUsername,
  origin: args.origin,
})

export async function routeCallback(args: RouterArgs): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)
  const [kind, a, b] = args.data.split(':')

  if (args.data === 'noop') return null

  // ── Public screens (available before access is granted) ──
  if (kind === 'n') {
    if (a === 'menu') return menuScreen(ctx)
    if (a === 'help') return helpScreen()
    if (a === 'search') {
      await saveSession(env, args.userId, args.telegramId, { state: 'await_search', data: {} })
      return { text: '🔍 <b>جست‌وجو</b>\n\nنام ورکر یا پنل را در پیام بعدی بفرستید.', keyboard: { inline_keyboard: [[{ text: '❌ لغو', callback_data: 'n:menu' }]] } }
    }
    if (a === 'tokens') return tokensScreen(ctx)
    if (a === 'profile') return profileScreen(ctx)
  }
  if (kind === 'l' && a === 'panels') return panelsScreen(Number(b ?? 0))
  if (kind === 'p') return panelScreen(a ?? '', args.origin)

  // ── Everything below is open to every user: this bot is a public deployer ──

  // ── Token management ──
  // Tokens always belong to the panel user who owns this bot (args.userId);
  // "tok:add:cf", "tok:del:cf:<id>", "tok:rm:cf:<id>", "tok:tgl:cf:<id>" and
  // "tok:add:cf:dpl" (return to the deploy wizard once stored).
  if (kind === 'tok') {
    // `tok:add:<kind>[:dpl]` carries the return hint in the id slot (there is no
    // row id yet); `tok:del|rm|tgl:<kind>:<id>` carries the row id instead.
    const parts = args.data.split(':')
    const action = parts[1] ?? ''
    const rawKind = parts[2] ?? 'cf'
    const id = parts[3]
    const ret = action === 'add' ? id : parts[4]
    const spec = kindSpec(rawKind)
    if (action === 'add') {
      if (!isTokenKind(rawKind)) return tokensScreen(ctx)
      const data: Record<string, unknown> = { kind: spec.id }
      if (ret === 'dpl') {
        // Come back to the deploy wizard once the token is stored.
        data.ret = 'dpl'
        data.wizard = args.session?.data ?? null
      }
      await saveSession(env, args.userId, args.telegramId, { state: 'await_token', data })
      return tokenAddScreen(spec, ret === 'dpl' ? 'dpl' : undefined)
    }
    if (action === 'del') {
      const t = id ? await findToken(env, spec, args.userId, id) : null
      return t ? tokenDeleteScreen(spec, t) : tokensScreen(ctx)
    }
    if (action === 'rm') return id ? deleteTokenRow(ctx, spec, id) : tokensScreen(ctx)
    if (action === 'tgl') return id ? toggleTokenRow(ctx, spec, id) : tokensScreen(ctx)
    return tokensScreen(ctx)
  }

  if (kind === 'l') {
    const page = Number(b ?? 0)
    if (a === 'workers') return workersScreen(ctx, page)
    if (a === 'configs') return configsScreen(ctx, page)
    if (a === 'servers') return serversScreen(ctx, page)
  }
  if (kind === 'w') return workerScreen(ctx, a ?? '')

  // Live status check for a Railway/Render panel deploy started in the wizard.
  if (kind === 'srv') {
    const platform = a === 'render' ? 'render' : 'railway'
    const id = b ?? ''
    const watched: PanelWatchResult = await watchPanelDeploy(env, args.userId, platform, id)
    if (watched.state === 'live') {
      const kb: TgButton[][] = [[{ text: `🔐 باز کردن پنل ${watched.panelName}`, url: `${watched.url}${watched.panelPath}` }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]]
      let text =
        `🟢 <b>پنل ${watched.panelName} زنده است</b>\n\n` +
        `🔗 <code>${watched.url}${watched.panelPath}</code>\n`
      if (watched.firstLive && watched.adminUsername) {
        text +=
          `\n👤 ادمین: <code>${watched.adminUsername}</code>\n🔐 رمز: <code>${watched.adminPassword ?? '—'}</code>\n\n` +
          '⚠️ این رمز فقط همین‌جا نمایش داده می‌شود — ذخیره‌اش کنید.'
      } else {
        text += '\n⏳ بوت‌استرپ ادمین قبلاً انجام شده است.'
      }
      return { text, keyboard: { inline_keyboard: kb } }
    }
    if (watched.state === 'failed') {
      return {
        text: `❌ <b>استقرار ناموفق بود</b>\n\nوضعیت Railway/Render: <code>${watched.status}</code>\nاز داشبورد پلتفرم لاگها را ببینید و دوباره تلاش کنید.`,
        keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]] },
      }
    }
    return {
      text: `⏳ <b>هنوز در حال استقرار است…</b>\n\nوضعیت: <code>${watched.status}</code>\n\nچند لحظه دیگر دوباره «بررسی وضعیت» را بزنید.`,
      keyboard: { inline_keyboard: [[{ text: '🔄 بررسی دوباره', callback_data: `srv:${platform}:${id}` }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]] },
    }
  }

  if (kind === 'cp') {
    const d = await env.DB.prepare('SELECT id, name, worker_url, panel_url, uuid, custom_path FROM deployments WHERE id = ? AND user_id = ?')
      .bind(a ?? '', args.userId)
      .first<{ id: string; name: string; worker_url: string | null; panel_url: string | null; uuid: string | null; custom_path: string | null }>()
    if (!d) return { text: '❌ مورد پیدا نشد.', keyboard: { inline_keyboard: [[homeButton()]] } }
    const value = b === 'panel' ? d.panel_url : subUrlOf(d)
    if (!value) return { text: '⏳ این مورد هنوز آماده نیست.', keyboard: { inline_keyboard: [[{ text: '🔙 ورکر', callback_data: `w:${d.id}` }], [homeButton()]] } }
    await sendMsg(cfg.bot_token, args.chatId, `📋 <b>${d.name}</b>\n\n<code>${value}</code>\n\n<i>برای کپی، روی متن بالا بزنید.</i>`)
    return null
  }

  if (kind === 'del' || kind === 'delok') {
    const d = await env.DB.prepare('SELECT id, name FROM deployments WHERE id = ? AND user_id = ?')
      .bind(a ?? '', args.userId)
      .first<{ id: string; name: string }>()
    if (!d) return { text: '❌ ورکر پیدا نشد.', keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }]] } }
    if (kind === 'del') {
      return {
        text: `🗑 <b>حذف ${d.name}</b>\n\nآیا مطمئن هستید؟ این رکورد از پنل حذف می‌شود (خود ورکر باید از داشبورد کلودفلر حذف شود).`,
        keyboard: { inline_keyboard: [[{ text: '✅ بله، حذف کن', callback_data: `delok:${d.id}` }], [backButton(`w:${d.id}`, '❌ انصراف')]] },
      }
    }
    await env.DB.prepare('DELETE FROM deployments WHERE id = ? AND user_id = ?').bind(d.id, args.userId).run()
    await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(genId(), args.userId, 'deployment_deleted', 'deployment', d.name, nowIso())
      .run()
    return workersScreen(ctx, 0)
  }

  // Personal link/token copy — the user's own unique route into the bot.
  if (kind === 'cpf') {
    await sendMsg(
      cfg.bot_token,
      args.chatId,
      `🔗 <b>لینک اختصاصی شما</b>\n\n<code>https://t.me/${args.botUsername ?? 'bot'}?start=${a ?? ''}</code>\n\n<i>برای کپی روی متن بالا بزنید.</i>`,
    )
    return null
  }

  // ── Deploy wizard ──
  if (kind === 'dpl') return deployWizard(args, a ?? '', b ?? '')
  return null
}

async function deployWizard(args: RouterArgs, a: string, b: string): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)
  const data: WizardData = (args.session?.data as WizardData) ?? {}

  if (a === 'start') {
    await clearSession(env, args.userId, args.telegramId)
    return deployStartScreen()
  }

  // ── Railway/Render panel branch ──
  if (a === 'T') {
    data.target = b === 'render' ? 'render' : 'railway'
    data.panel = undefined
    data.tokenId = undefined
    data.name = undefined
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployPanelScreen(data)
  }
  if (a === 'p' && data.target) {
    const panel = resolvePanel(b)
    if (!panel.targets.includes(data.target)) return deployPanelScreen(data)
    data.panel = panel.id
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployTokenScreen(ctx, data)
  }
  if (a === 't' && data.target && data.panel) {
    const table = data.target === 'railway' ? 'railway_tokens' : 'render_tokens'
    const token = await env.DB.prepare(`SELECT id, name FROM ${table} WHERE id = ? AND user_id = ? AND status = 'active'`)
      .bind(b, args.userId)
      .first<{ id: string; name: string }>()
    if (!token) return deployTokenScreen(ctx, data)
    data.tokenId = token.id
    data.tokenName = token.name
    data.name = data.name ?? randomName()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, String(data.uuid ?? ''))
  }

  // ── Shared steps ──
  if (a === 'name') {
    await saveSession(env, args.userId, args.telegramId, { state: 'await_name', data })
    return {
      text: '✏️ <b>نام پروژه/ورکر</b>\n\nنام جدید را بفرستید (حروف کوچک انگلیسی، عدد و خط تیره — مثل <code>mil-ab12cd</code>).',
      keyboard: { inline_keyboard: [[backButton('dpl:confirm', '❌ لغو')]] },
    }
  }
  if (a === 'confirm') return deployConfirmScreen(data, String(data.uuid ?? crypto.randomUUID()))

  // ── Cloudflare branch ──
  if (a === 'm') {
    data.method = b === 'pages' ? 'pages' : 'workers'
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deploySourceScreen()
  }
  if (a === 's') {
    if (!data.method) return deployStartScreen()
    data.source = b || 'edgetunnel'
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployTokenScreen(ctx, data)
  }
  if (a === 't') {
    if (!data.source) return deployStartScreen()
    const token = await env.DB.prepare("SELECT id, name FROM cf_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
      .bind(b, args.userId)
      .first<{ id: string; name: string }>()
    if (!token) return deployTokenScreen(ctx, data)
    data.tokenId = token.id
    data.tokenName = token.name
    data.name = data.name ?? randomName()
    data.uuid = data.uuid ?? crypto.randomUUID()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, data.uuid)
  }
  if (a === 'uuid') {
    data.uuid = crypto.randomUUID()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, data.uuid)
  }

  if (a === 'go') {
    // Panel branch: Railway or Render via the shared engine.
    if (data.target && data.panel && data.tokenId && data.name) {
      const started: StartPanelDeployResult = await startPanelDeploy(env, {
        userId: args.userId,
        tokenId: data.tokenId,
        name: data.name,
        panel: resolvePanel(data.panel),
      })
      await clearSession(env, args.userId, args.telegramId)
      if (!started.ok) {
        return {
          text: `❌ <b>استقرار پنل شروع نشد</b>\n\n${started.error}`,
          keyboard: { inline_keyboard: [[{ text: '🔁 تلاش دوباره', callback_data: 'dpl:start' }], [homeButton()]] },
        }
      }
      const label = started.platform === 'render' ? 'Render' : 'Railway'
      return {
        text:
          `🚀 <b>استقرار پنل روی ${label} شروع شد</b>\n\n` +
          `🧩 ${resolvePanel(data.panel).name}\n` +
          `📦 <code>${data.name}</code>\n\n` +
          'پروژه ساخته می‌شود، مخزن پنل متصل و متغیرهای محیطی ست می‌شوند. معمولاً ۲ تا ۵ دقیقه طول می‌کشد؛ به محض آماده‌شدن، نتیجه و رمز ادمین همین‌جا اعلام می‌شود.',
        keyboard: {
          inline_keyboard: [
            [{ text: started.platform === 'render' ? '☁️ داشبورد Render' : '🏗 داشبورد Railway', url: started.dashboardUrl }],
            [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }, { text: '👤 فضای من', callback_data: 'n:profile' }],
            [{ text: '🔄 بررسی وضعیت', callback_data: `srv:${started.platform}:${started.id}` }],
            [homeButton()],
          ],
        },
      }
    }

    // Cloudflare worker branch.
    if (!data.method || !data.source || !data.tokenId || !data.name) return deployStartScreen()
    const started = await startDeployment(env, args.exec, {
      userId: args.userId,
      name: data.name,
      uuid: String(data.uuid ?? crypto.randomUUID()),
      cfTokenId: data.tokenId,
      method: data.method,
      workerSource: data.source,
      origin: args.origin,
    })
    await clearSession(env, args.userId, args.telegramId)
    if (!started.ok) {
      return {
        text: `❌ <b>استقرار شروع نشد</b>\n\n${started.error}`,
        keyboard: { inline_keyboard: [[{ text: '🔁 تلاش دوباره', callback_data: 'dpl:start' }], [homeButton()]] },
      }
    }
    return {
      text:
        '🚀 <b>استقرار شروع شد</b>\n\n' +
        `📦 <code>${data.name}</code>\n` +
        'KV ساخته می‌شود، کد ورکر آپلود می‌شود و در پایان نتیجه را همین‌جا اعلام می‌کنیم.\nحدود ۳۰ تا ۹۰ ثانیه طول می‌کشد.',
      keyboard: { inline_keyboard: [[{ text: '👤 فضای من', callback_data: 'n:profile' }, { text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] },
    }
  }
  return null
}

// ── Text routing ─────────────────────────────────────────────────────────────

export async function routeText(args: RouterArgs, text: string): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)

  // Conversation states win over everything else.
  if (args.session) {
    if (args.session.state === 'await_token') {
      const res = await handleTokenPaste({
        env,
        cfg,
        chatId: args.chatId,
        telegramId: args.telegramId,
        session: args.session,
        text,
        messageId: args.messageId,
      })
      const wizard = (args.session.data.wizard ?? null) as WizardData | null
      if (res.resumeWizard && wizard) {
        await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data: wizard })
        const step = await deployTokenScreen(ctx, wizard)
        return { ...step, text: `${res.screen.text}\n\n${step.text}` }
      }
      await clearSession(env, args.userId, args.telegramId)
      return res.screen
    }
    if (args.session.state === 'await_name') {
      const name = text.trim().toLowerCase()
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
        return { text: '❌ نام نامعتبر است. فقط حروف کوچک انگلیسی، عدد و خط تیره (۲ تا ۶۳ کاراکتر).', keyboard: { inline_keyboard: [[backButton('dpl:confirm', '❌ لغو')]] } }
      }
      const data = { ...(args.session.data as WizardData), name }
      await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
      return deployConfirmScreen(data, String(data.uuid ?? crypto.randomUUID()))
    }
    if (args.session.state === 'await_search') {
      await clearSession(env, args.userId, args.telegramId)
      const q = text.trim().toLowerCase()
      const rows = await env.DB.prepare(
        'SELECT id, name, status FROM deployments WHERE user_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 10',
      ).bind(args.userId, `%${q}%`).all<{ id: string; name: string; status: string }>()
      const panels = PANELS.filter((p) => p.name.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q) || p.id.includes(q))
      let out = `🔍 <b>نتیجهٔ جست‌وجو</b>\n\n`
      const keyboard: TgButton[][] = []
      if (!rows.results.length && !panels.length) out += 'چیزی پیدا نشد.'
      for (const r of rows.results) {
        out += `📦 ${statusIcon(r.status)} <code>${r.name}</code>\n`
        keyboard.push([{ text: `📦 ${r.name}`, callback_data: `w:${r.id}` }])
      }
      for (const p of panels) {
        out += `🧩 ${panelOriginLabel(p)} <b>${p.name}</b>\n`
        keyboard.push([{ text: `ℹ️ ${p.name}`, callback_data: `p:${p.id}` }])
      }
      keyboard.push([homeButton()])
      return { text: out, keyboard: { inline_keyboard: keyboard } }
    }
  }

  // Reply-keyboard tabs — open to every user, no access levels.
  if (text === MENU.workers) return workersScreen(ctx, 0)
  if (text === MENU.panels) return panelsScreen(0)
  if (text === MENU.servers) return serversScreen(ctx, 0)
  if (text === MENU.tokens) return tokensScreen(ctx)
  if (text === MENU.profile) return profileScreen(ctx)
  if (text === MENU.help) return helpScreen()

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')

  if (cmd === '/start') {
    // `/start <token>`: the payload is the user's own unique route token. A
    // token belonging to another Telegram account is refused — spaces never
    // cross over, so nobody can step into someone else's deploys or tokens.
    const payload = (rest[0] ?? '').trim()
    const owner = payload ? await tenantByToken(env, payload) : null
    if (owner && owner.telegram_id !== args.telegramId) {
      return {
        text:
          '🔐 <b>این توکن/لینک به حساب دیگری تعلق دارد.</b>\n\n' +
          'هر کاربر توکن و فضای اختصاصی خودش را دارد. اگر می‌خواهید خودتان استقرار انجام دهید، همین /start را بزنید تا فضای شما ساخته شود.',
        keyboard: { inline_keyboard: [[{ text: '👤 فضای من', callback_data: 'n:profile' }, { text: '📖 راهنما', callback_data: 'n:help' }]] },
      }
    }
    return menuScreen(ctx)
  }
  if (cmd === '/menu') return menuScreen(ctx)
  if (cmd === '/help') return helpScreen()
  if (cmd === '/panels') return panelsScreen(0)
  if (cmd === '/quickstart') {
    return {
      text:
        '⚡ <b>شروع سریع</b>\n\n' +
        '۱) توکن Cloudflare خودتان را در «🔑 توکن‌ها» همین‌جا اضافه کنید.\n' +
        '۲) در همین ربات /deploy را بزنید.\n' +
        '۳) روش را انتخاب کنید: ورکر کلودفلر، یا پنل روی Railway/Render.\n' +
        '۴) منبع/پنل، توکن و نام را انتخاب و تأیید کنید.\n' +
        '۵) نتیجهٔ استقرار خودکار همین‌جا اعلام می‌شود.\n\n' +
        'استقرار پنل VPS از پنل وب است؛ کاتالوگ کامل در «🧩 پنل‌ها».',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [homeButton()]] },
    }
  }

  if (cmd === '/profile' || cmd === '/me') return profileScreen(ctx)
  if (cmd === '/workers') return workersScreen(ctx, 0)
  if (cmd === '/configs') return configsScreen(ctx, 0)
  if (cmd === '/servers') return serversScreen(ctx, 0)
  if (cmd === '/tokens') return tokensScreen(ctx)
  if (cmd === '/id') return { text: `🆔 شناسهٔ شما: <code>${args.telegramId}</code>`, keyboard: { inline_keyboard: [[{ text: '👤 فضای من', callback_data: 'n:profile' }]] } }
  if (cmd === '/deploy') return deployStartScreen()

  if (cmd === '/config' || cmd === '/sub' || cmd === '/panel') {
    if (!arg) return workersScreen(ctx, 0)
    const wn = arg.toLowerCase().replace(/[^a-z0-9-]/g, '')
    const d = await env.DB.prepare('SELECT id, name, status FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, wn)
      .first<{ id: string; name: string; status: string }>()
    if (!d) return { text: `❌ ورکری با نام <code>${wn}</code> پیدا نشد.`, keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] } }
    return workerScreen(ctx, d.id)
  }

  if (cmd === '/set') {
    const parts = arg.split(/\s+/)
    if (parts.length < 3) {
      return { text: '⚙️ استفاده: <code>/set worker key value</code>\nکلیدهای مجاز: path, proxyip, region, homepage', keyboard: { inline_keyboard: [[homeButton()]] } }
    }
    const [wn, key, ...valueParts] = parts
    const value = valueParts.join(' ')
    if (!['path', 'proxyip', 'region', 'homepage'].includes(key.toLowerCase())) {
      return { text: '❌ کلید نامعتبر. کلیدهای مجاز: path, proxyip, region, homepage', keyboard: { inline_keyboard: [[homeButton()]] } }
    }
    const target = wn.toLowerCase().replace(/[^a-z0-9-]/g, '')
    const d = await env.DB.prepare('SELECT id, name, config FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, target)
      .first<{ id: string; name: string; config: string | null }>()
    if (!d) return { text: `❌ ورکر <code>${wn}</code> پیدا نشد.`, keyboard: { inline_keyboard: [[homeButton()]] } }
    const stored = safeJsonParse<Record<string, unknown>>(d.config ?? '{}', {})
    stored[key.toLowerCase()] = value
    await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(stored), nowIso(), d.id).run()
    return { text: `✅ <code>${d.name}</code> به‌روز شد.\n${key.toLowerCase()}: <code>${value}</code>`, keyboard: { inline_keyboard: [[{ text: '📦 ورکر', callback_data: `w:${d.id}` }], [homeButton()]] } }
  }

  if (cmd === '/id') return { text: `🆔 شناسهٔ شما: <code>${args.telegramId}</code>`, keyboard: { inline_keyboard: [[homeButton()]] } }

  return {
    text: 'متوجه نشدم 🤔\nاز منوی پایین استفاده کنید یا /help را بزنید.',
    keyboard: { inline_keyboard: [[{ text: '📖 راهنما', callback_data: 'n:help' }], [homeButton()]] },
  }
}

import type { Env } from './env'
import { apiError, json, getUserFromRequest, logActivity, genId, nowIso, safeJsonParse } from './util'
import { handleSignup, handleLogin, handleLogout, handleMe, isOwner } from './auth'
import { startDeployment } from './deploy'
import { verifyRailwayToken, RailwayApiError } from './railway'
import { verifyRenderToken, RenderApiError } from './render'
import { startPanelDeploy, watchPanelDeploy } from './panel-deploy'
import { handleWorkerConfig } from './kvconfig'
import { handleIpScanner, handleRangeScan } from './scanner'
import { handleTelegramWebhook } from './telegram'
import { syncBotProfile } from './telegram-core'
import { ensureSchema } from './schema'
import { handleOptimizerCreate, handleOptimizerList, handleOptimizerGet, handleOptimizerDelete, serveOptimizerSub } from './optimizer'
import { handleOptProbe, handleOptPorts, handleOptScanBatch, handleOptSpeedtest } from './probe'
import { handleGroupCreate, handleGroupList, handleGroupDelete, handleGroupPatch, serveGroupSub } from './subgroups'
import { handleInjectorCreate, handleInjectorList, handleInjectorPatch, handleInjectorDelete, serveInjectedSub } from './injector'
import { handleMemberCreate, handleMemberList, handleMemberPatch, handleMemberDelete, handleMemberBulk, handleCfQuota, refreshMemberUsage, serveMemberSub, handleMemberTest } from './members'
import { serveStatusPage } from './status'
import { exportBackup, importBackup } from './backup'
import { handleSourceSettings, handleSourceNodes } from './sourcebridge'
import { resolvePanel } from '../shared/panels'

interface DeploymentBody {
  name?: string
  uuid?: string
  custom_path?: string
  method?: 'workers' | 'pages'
  worker_source?: string
  proxyip?: string
  admin_password?: string
  cf_token_id?: string
}

async function requireUser(env: Env, request: Request) {
  return getUserFromRequest(env, request)
}

// ── Tokens ─────────────────────────────────────────────────────────────────

async function listTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM cf_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return json({ data: r.results })
}

async function createToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و توکن الزامی است')
  const id = genId()
  await env.DB.prepare("INSERT INTO cf_tokens (id, user_id, name, token, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .bind(id, userId, body.name.trim(), body.token.trim(), nowIso())
    .run()
  await logActivity(env, userId, 'token_created', 'token', body.name.trim())
  return json({ data: { id, user_id: userId, name: body.name.trim(), token: body.token.trim(), status: 'active', created_at: nowIso() } }, 201)
}

async function deleteToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM cf_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'token_deleted', 'token', row.name)
  return json({ success: true })
}

// ── Railway tokens & auto-deploy ────────────────────────────────────────────

// Railway tokens are write-once secrets: after a successful save we never return
// the raw token to the browser again — the UI only sees the last 4 characters.

async function listRailwayTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT id, name, status, account_name, last_used_at, created_at, substr(token, -4) AS token_tail
     FROM railway_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(userId).all()
  return json({ data: r.results })
}

async function createRailwayToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و توکن الزامی است')

  // Validate the token against Railway before storing anything.
  let account: { name: string; email: string }
  try {
    account = await verifyRailwayToken(body.token.trim())
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'توکن Railway نامعتبر است', 400)
  }

  const id = genId()
  const accountName = account.email || account.name || null
  await env.DB.prepare(
    `INSERT INTO railway_tokens (id, user_id, name, token, status, account_name, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, userId, body.name.trim(), body.token.trim(), accountName, nowIso())
    .run()
  await logActivity(env, userId, 'railway_token_created', 'token', body.name.trim())
  return json(
    {
      data: {
        id,
        name: body.name.trim(),
        status: 'active',
        account_name: accountName,
        token_tail: body.token.trim().slice(-4),
        last_used_at: null,
        created_at: nowIso(),
      },
    },
    201,
  )
}

async function deleteRailwayToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM railway_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'railway_token_deleted', 'token', row.name)
  return json({ success: true })
}

async function loadRailwayToken(env: Env, userId: string, id: string): Promise<{ id: string; token: string; name: string } | null> {
  return env.DB.prepare("SELECT id, token, name FROM railway_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(id, userId)
    .first<{ id: string; token: string; name: string }>()
}

/** Auto-deploy a catalog panel to Railway: create project + service, start deploy. */
async function handleRailwayDeploy(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ token_id?: string; name?: string; region?: string; panel?: string }>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/panel-deploy.ts).
  const started = await startPanelDeploy(env, {
    userId,
    tokenId: body.token_id ?? '',
    name: body.name ?? '',
    panel: resolvePanel(body.panel),
    region: body.region,
  })
  if (!started.ok) return apiError(started.error, 400)
  const panel = resolvePanel(body.panel)
  return json({
    data: {
      deploymentId: started.id,
      projectId: started.id,
      projectUrl: started.dashboardUrl,
      domain: started.domain,
      panel: panel.id,
      panel_name: panel.name,
      panel_path: panel.panelPath,
      admin_username: started.adminUsername,
      admin_password: started.adminPassword,
    },
  })
}

// ── Render.com tokens & auto-deploy ──────────────────────────────────────────

async function listRenderTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT id, name, status, account_name, last_used_at, created_at, substr(token, -4) AS token_tail
     FROM render_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(userId).all()
  return json({ data: r.results })
}

async function createRenderToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و کلید الزامی است')

  let account: { name: string; email: string }
  try {
    account = await verifyRenderToken(body.token.trim())
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'کلید API رندر نامعتبر است', 400)
  }

  const id = genId()
  const accountName = account.email || account.name || null
  await env.DB.prepare(
    `INSERT INTO render_tokens (id, user_id, name, token, status, account_name, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, userId, body.name.trim(), body.token.trim(), accountName, nowIso())
    .run()
  await logActivity(env, userId, 'render_token_created', 'token', body.name.trim())
  return json(
    {
      data: {
        id,
        name: body.name.trim(),
        status: 'active',
        account_name: accountName,
        token_tail: body.token.trim().slice(-4),
        last_used_at: null,
        created_at: nowIso(),
      },
    },
    201,
  )
}

async function deleteRenderToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM render_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'render_token_deleted', 'token', row.name)
  return json({ success: true })
}

async function loadRenderToken(env: Env, userId: string, id: string): Promise<{ id: string; token: string; name: string } | null> {
  return env.DB.prepare("SELECT id, token, name FROM render_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(id, userId)
    .first<{ id: string; token: string; name: string }>()
}

/** Auto-deploy a catalog panel to Render.com: create Blueprint service, start deploy. */
async function handleRenderDeploy(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ token_id?: string; name?: string; panel?: string }>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/panel-deploy.ts).
  const started = await startPanelDeploy(env, {
    userId,
    tokenId: body.token_id ?? '',
    name: body.name ?? '',
    panel: resolvePanel(body.panel),
  })
  if (!started.ok) return apiError(started.error, 400)
  const panel = resolvePanel(body.panel)
  return json({
    data: {
      deployId: started.id,
      serviceId: started.serviceId,
      dashboardUrl: started.dashboardUrl,
      panel: panel.id,
      panel_name: panel.name,
      panel_path: panel.panelPath,
      admin_username: started.adminUsername,
      admin_password: started.adminPassword,
    },
  })
}

/** Poll the status of a Render deployment that handleRenderDeploy started. */
async function handleRenderStatus(env: Env, userId: string, url: URL): Promise<Response> {
  const deployId = url.searchParams.get('deploy_id') ?? ''
  if (!deployId) return apiError('شناسه استقرار ناقص است')
  // Same lifecycle the Telegram bot uses (worker/panel-deploy.ts): on the live
  // transition the panel admin is bootstrapped once and the owner is notified.
  const watched = await watchPanelDeploy(env, userId, 'render', deployId)
  if (watched.state === 'failed') return apiError(`استقرار ناموفق بود (${watched.status})`, 400)
  return json({
    data: {
      status: watched.state === 'live' ? 'LIVE' : watched.status,
      url: watched.url,
      setup_done: watched.state === 'live' ? true : undefined,
    },
  })
}

/** Poll the status of a Railway deployment that handleRailwayDeploy started. */
async function handleRailwayStatus(env: Env, userId: string, url: URL): Promise<Response> {
  const deploymentId = url.searchParams.get('deployment_id') ?? ''
  if (!deploymentId) return apiError('شناسه استقرار ناقص است')
  // Same lifecycle the Telegram bot uses (worker/panel-deploy.ts): on the live
  // transition the panel admin is bootstrapped once and the owner is notified.
  const watched = await watchPanelDeploy(env, userId, 'railway', deploymentId)
  if (watched.state === 'failed') return apiError(`استقرار ناموفق بود (${watched.status})`, 400)
  return json({
    data: {
      status: watched.state === 'live' ? 'SUCCESS' : watched.status,
      url: watched.url,
      setup_done: watched.state === 'live' ? true : undefined,
    },
  })
}

// ── Deployments ────────────────────────────────────────────────────────────

function parseDeploymentRow(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, config: safeJsonParse(row.config as string, {}) }
}

async function listDeployments(env: Env, userId: string, url: URL): Promise<Response> {
  const idsParam = url.searchParams.get('ids')
  let rows: Record<string, unknown>[]
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50)
    rows = []
    for (const id of ids) {
      const row = await env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND user_id = ?').bind(id, userId).first<Record<string, unknown>>()
      if (row) rows.push(row)
    }
  } else {
    const r = await env.DB.prepare('SELECT * FROM deployments WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<Record<string, unknown>>()
    rows = r.results
  }
  return json({ data: rows.map(parseDeploymentRow) })
}

async function getDeployment(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND user_id = ?').bind(id, userId).first<Record<string, unknown>>()
  if (!row) return apiError('ورکر پیدا نشد', 404)
  return json({ data: parseDeploymentRow(row) })
}

async function createDeployment(env: Env, userId: string, request: Request, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = safeJsonParse<DeploymentBody>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/deploy.ts).
  const started = await startDeployment(env, ctx, {
    userId,
    name: body.name ?? '',
    uuid: body.uuid ?? '',
    cfTokenId: body.cf_token_id ?? '',
    method: body.method === 'pages' ? 'pages' : 'workers',
    workerSource: body.worker_source ?? 'edgetunnel',
    proxyip: body.proxyip || undefined,
    adminPassword: body.admin_password || undefined,
    customPath: body.custom_path || undefined,
    origin,
  })
  if (!started.ok) return apiError(started.error, 400)
  return getDeployment(env, userId, started.id)
}

async function deleteDeployment(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM deployments WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('ورکر پیدا نشد', 404)
  await logActivity(env, userId, 'worker_deleted', 'deployment', row.name)
  return json({ success: true })
}

// ── Bot config & users ─────────────────────────────────────────────────────

/** Shape a bot_config row for the API (never leak the secret). */
async function botConfigRowToObj(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { webhook_secret: _secret, ...rest } = row
  return { ...rest, is_active: !!row.is_active }
}

/** Clean a pasted bot token: strip the optional "bot" prefix, whitespace and
 *  invisible Unicode characters (ZWNJ/RLM/LRM etc.) that Persian keyboards and
 *  copy-paste often inject — any of these makes Telegram reject the token. */
function sanitizeBotToken(raw: string): string {
  return raw
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '')
    .replace(/^bot/i, '')
    .trim()
}

/** Register (or re-register) the Telegram webhook for a bot.
 *  A per-bot random secret_token rides along so the webhook handler can route
 *  every incoming update to exactly this bot_config row. */
async function setBotWebhook(botToken: string, origin: string, secret: string): Promise<{ ok: boolean; description?: string }> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${origin}/api/webhooks/telegram`,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      secret_token: secret,
    }),
  }).then((r) => r.json()).catch(() => null)
  const data = resp as { ok?: boolean; description?: string } | null
  return { ok: !!data?.ok, description: data?.description }
}

/** Live webhook diagnostics straight from Telegram (getWebhookInfo). */
async function botWebhookInfo(env: Env, userId: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT bot_token FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<{ bot_token: string }>()
  if (!row) return apiError('ربات هنوز پیکربندی نشده است', 404)
  const info = await fetch(`https://api.telegram.org/bot${sanitizeBotToken(row.bot_token)}/getWebhookInfo`)
    .then((r) => r.json())
    .catch(() => null)
  const data = info as { ok?: boolean; result?: Record<string, unknown>; description?: string } | null
  if (!data?.ok) return apiError(`خواندن وضعیت وب‌هوک از تلگرام ناموفق بود: ${data?.description ?? 'ارتباط برقرار نشد'}`)
  return json({ data: data.result })
}

/** Force-reconnect the webhook using the stored token (no retyping needed). */
async function reconnectBotWebhook(env: Env, userId: string, origin: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT id, bot_token, is_active FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<{ id: string; bot_token: string; is_active: number }>()
  if (!row) return apiError('ربات هنوز پیکربندی نشده است', 404)
  if (!row.is_active) await env.DB.prepare('UPDATE bot_config SET is_active = 1 WHERE id = ?').bind(row.id).run()
  const secret = genId().replace(/-/g, '')
  const hook = await setBotWebhook(sanitizeBotToken(row.bot_token), origin, secret)
  if (!hook.ok) return apiError(`اتصال مجدد وب‌هوک ناموفق بود: ${hook.description ?? 'خطای ناشناخته'}`)
  await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ?, is_active = 1, updated_at = ? WHERE id = ?')
    .bind(`${origin}/api/webhooks/telegram`, secret, nowIso(), row.id)
    .run()
  await logActivity(env, userId, 'bot_webhook_reconnected', 'bot', null)
  return getBotConfig(env, userId)
}

async function getBotConfig(env: Env, userId: string, origin?: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()
  // Self-heal bots whose webhook was registered before per-bot secrets existed:
  // without a secret Telegram sends no routing header and the update can only be
  // routed when the whole install runs a single bot. Re-registering here gives
  // every panel user's bot its own exact routing again.
  if (row && origin && row.is_active && !row.webhook_secret && row.bot_token) {
    const secret = genId().replace(/-/g, '')
    const hook = await setBotWebhook(sanitizeBotToken(row.bot_token as string), origin, secret)
    if (hook.ok) {
      await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ?, updated_at = ? WHERE id = ?')
        .bind(`${origin}/api/webhooks/telegram`, secret, nowIso(), row.id as string)
        .run()
      row.webhook_secret = secret
    }
  }
  return json({ data: row ? await botConfigRowToObj(row) : null })
}

async function saveBotConfig(env: Env, userId: string, request: Request, origin: string): Promise<Response> {
  const body = safeJsonParse<{ bot_token?: string; welcome_message?: string; is_active?: boolean }>(await request.text().catch(() => ''), {})

  const existing = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()

  // Update without a token: toggle is_active and/or edit the welcome message.
  // Saving again also re-registers the webhook from the stored token — a safe
  // "reconnect" that fixes silently-dropped hooks without retyping the token.
  if (!body.bot_token?.trim() && existing) {
    const storedToken = sanitizeBotToken(existing.bot_token as string)
    let reconnect: { ok: boolean; description?: string } | null = null
    if ((typeof body.is_active === 'boolean' ? body.is_active : !!existing.is_active) && storedToken) {
      const secret = genId().replace(/-/g, '')
      reconnect = await setBotWebhook(storedToken, origin, secret)
      if (reconnect.ok) {
        await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ? WHERE id = ?')
          .bind(`${origin}/api/webhooks/telegram`, secret, existing.id as string)
          .run()
      }
    }
    await env.DB.prepare(
      `UPDATE bot_config SET
         welcome_message = COALESCE(?, welcome_message),
         is_active = COALESCE(?, is_active),
         updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        body.welcome_message?.trim() ?? null,
        typeof body.is_active === 'boolean' ? (body.is_active ? 1 : 0) : null,
        nowIso(),
        existing.id as string,
      )
      .run()
    if (reconnect && !reconnect.ok) {
      const updated = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()
      return json({ data: updated ? await botConfigRowToObj(updated) : null, warning: `وب‌هوک دوباره وصل نشد: ${reconnect.description ?? 'خطای ناشناخته'}` })
    }
    return getBotConfig(env, userId, origin)
  }

  if (!body.bot_token?.trim() && !existing) return apiError('توکن ربات الزامی است')
  const botToken = sanitizeBotToken(body.bot_token!)
  if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    return apiError('قالب توکن درست نیست — توکن باید شبیه 123456789:AAH... باشد و مستقیم از BotFather کپی شود')
  }

  // One bot, one panel account. Two users sharing a bot token would make the
  // webhook route updates to whichever row wins, i.e. one of them would deploy
  // with the other's Cloudflare token — refuse it outright.
  const claimed = await env.DB.prepare('SELECT user_id FROM bot_config WHERE bot_token = ? LIMIT 1')
    .bind(botToken)
    .first<{ user_id: string }>()
  if (claimed && claimed.user_id !== userId) {
    return apiError('این ربات قبلاً به حساب کاربری دیگری وصل شده است. هر ربات فقط به یک حساب تعلق دارد — در BotFather یک ربات تازه بسازید و توکن آن را اینجا وارد کنید')
  }
  const welcome = body.welcome_message?.trim()
    || ((existing?.welcome_message as string) ?? '')
    || 'سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.'

  // Validate the token with Telegram and connect the webhook.
  const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then((r) => r.json()).catch(() => null)
  const meData = meResp as { ok?: boolean; result?: { username?: string }; description?: string } | null
  if (!meData?.ok) {
    const d = meData?.description ?? ''
    const hint = d.includes('Unauthorized')
      ? 'توکن از سمت تلگرام رد شد — مطمئن شوید کل رشتهٔ کامل از BotFather کپی شده و ربات با /revoke باطل نشده باشد'
      : d
        ? `تلگرام پاسخ داد: ${d}`
        : 'اتصال به سرور تلگرام ناموفق بود — چند لحظه بعد دوباره تلاش کنید'
    return apiError(`توکن ربات تأیید نشد: ${hint}`)
  }
  const botUsername = meData.result?.username ?? null
  const webhookUrl = `${origin}/api/webhooks/telegram`
  const webhookSecret = genId().replace(/-/g, '')
  const hookData = await setBotWebhook(botToken, origin, webhookSecret)
  if (!hookData.ok) {
    return apiError(`اتصال وب‌هوک ناموفق بود: ${hookData.description ?? 'خطای ناشناخته'}`)
  }
  if (existing) {
    await env.DB.prepare(
      `UPDATE bot_config SET bot_token = ?, bot_username = ?, webhook_url = ?, webhook_secret = ?, is_active = ?, welcome_message = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(botToken, botUsername, webhookUrl, webhookSecret, body.is_active === false ? 0 : 1, welcome, nowIso(), existing.id as string)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO bot_config (id, user_id, bot_token, bot_username, webhook_url, webhook_secret, is_active, welcome_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(genId(), userId, botToken, botUsername, webhookUrl, webhookSecret, welcome, nowIso(), nowIso())
      .run()
  }

  // Register the command list, description and the "open web panel" button so
  // the bot behaves like an app from the very first time it is opened.
  await syncBotProfile(botToken, origin).catch(() => null)

  await logActivity(env, userId, 'bot_configured', 'bot', botUsername)
  return getBotConfig(env, userId, origin)
}

async function listBotUsers(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM bot_users WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return json({ data: r.results.map((u) => ({ ...u, is_active: !!u.is_active, is_admin: !!u.is_admin })) })
}

async function updateBotUser(env: Env, userId: string, id: string, request: Request): Promise<Response> {
  // The only lever the owner has over a public bot's users: block or unblock.
  // There are no bot-side admins any more, so nothing else is editable.
  const body = safeJsonParse<{ is_active?: boolean }>(await request.text().catch(() => ''), {})
  const sets: string[] = []
  const binds: (number | string)[] = []
  if (typeof body.is_active === 'boolean') { sets.push('is_active = ?'); binds.push(body.is_active ? 1 : 0) }
  if (!sets.length) return apiError('فیلدی برای به‌روزرسانی نیست')
  binds.push(id, userId)
  const r = await env.DB.prepare(`UPDATE bot_users SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run()
  if (!r.meta.changes) return apiError('کاربر پیدا نشد', 404)
  return json({ success: true })
}

async function deleteBotUser(env: Env, userId: string, id: string): Promise<Response> {
  const r = await env.DB.prepare('DELETE FROM bot_users WHERE id = ? AND user_id = ?').bind(id, userId).run()
  if (!r.meta.changes) return apiError('کاربر پیدا نشد', 404)
  return json({ success: true })
}

// ── Stats & logs ───────────────────────────────────────────────────────────

async function getStats(env: Env, userId: string): Promise<Response> {
  const [tokens, deps, botUsersAll, recentLogs] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM cf_tokens WHERE user_id = ?').bind(userId).first<{ c: number }>(),
    env.DB.prepare("SELECT status, COUNT(*) AS c FROM deployments WHERE user_id = ? GROUP BY status").bind(userId).all<{ status: string; c: number }>(),
    env.DB.prepare('SELECT is_active, is_admin, COUNT(*) AS c FROM bot_users WHERE user_id = ? GROUP BY is_active, is_admin').bind(userId).all<{ is_active: number; is_admin: number; c: number }>(),
    env.DB.prepare('SELECT id, action, entity_name, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 8').bind(userId).all(),
  ])

  const statusCounts = Object.fromEntries(deps.results.map((r) => [r.status, r.c]))
  const botUsers = botUsersAll.results.reduce((acc, g) => acc + g.c, 0)
  const activeBotUsers = botUsersAll.results.filter((g) => g.is_active).reduce((acc, g) => acc + g.c, 0)

  return json({
    tokens: tokens?.c ?? 0,
    deployments: deps.results.reduce((acc, g) => acc + g.c, 0),
    deployed: statusCounts.deployed ?? 0,
    failed: statusCounts.failed ?? 0,
    botUsers,
    activeBotUsers,
    recentLogs: recentLogs.results,
  })
}

async function listLogs(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(userId).all()
  return json({ data: r.results })
}

// ── Router ────────────────────────────────────────────────────────────────

/** Echo the caller's origin so the SPA can also be hosted on a separate domain. */
function corsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('Origin')
  if (!requestOrigin) return {}
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function withCors(response: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return response
  const resp = new Response(response.body, response)
  for (const [k, v] of Object.entries(headers)) resp.headers.set(k, v)
  return resp
}

async function handleRouted(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  origin: string,
  method: string,
): Promise<Response> {
  const url = new URL(request.url)

  // Telegram webhook — public, authenticated by bot token inside the handler.
  if (path === '/api/webhooks/telegram' && method === 'POST') {
    return await handleTelegramWebhook(env, ctx, request)
  }

  // Public auth endpoints
  if (path === '/api/auth/signup' && method === 'POST') return await handleSignup(env, request)
  if (path === '/api/auth/login' && method === 'POST') return await handleLogin(env, request)

  // Public subscription endpoints (token in URL acts as the credential)
  if (path.startsWith('/api/sub/') && method === 'GET') {
    const token = path.split('/')[4] ?? ''
    const target = url.searchParams.get('target')
    if (path.startsWith('/api/sub/opt/')) return await serveOptimizerSub(env, token, target)
    if (path.startsWith('/api/sub/group/')) return await serveGroupSub(env, token, target)
    if (path.startsWith('/api/sub/inject/')) return await serveInjectedSub(env, token, target)
    if (path.startsWith('/api/sub/member/')) return await serveMemberSub(env, token, target, request)
  }

  // Public status page per member (token in URL acts as the credential).
  // `/status/<token>/sub` serves the member's live subscription directly —
  // so the download button on the status card never 404s.
  if (path.startsWith('/status/') && method === 'GET') {
    const rest = path.slice('/status/'.length)
    const subMatch = rest.match(/^([^/]+)\/sub\/?$/)
    if (subMatch) {
      return await serveMemberSub(env, subMatch[1], url.searchParams.get('target'), request)
    }
    return await serveStatusPage(env, rest, url.origin)
  }

  // Everything below requires a session
  if (path.startsWith('/api/auth/') || path.startsWith('/api/')) {
    const user = await requireUser(env, request)

    if (path === '/api/auth/logout' && method === 'POST') {
      if (!user) return json({ success: true })
      return await handleLogout(env, request)
    }
    if (path === '/api/auth/me' && method === 'GET') return await handleMe(env, request)

    if (!user) return apiError('ابتدا وارد شوید', 401)

    if (path === '/api/tokens' && method === 'GET') return await listTokens(env, user.id)
    if (path === '/api/tokens' && method === 'POST') return await createToken(env, user.id, request)
    if (path.match(/^\/api\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteToken(env, user.id, path.split('/')[3])

    // ── Railway (StanNG auto-deploy) ─────────────────────────────────────
    if (path === '/api/railway/tokens' && method === 'GET') return await listRailwayTokens(env, user.id)
    if (path === '/api/railway/tokens' && method === 'POST') return await createRailwayToken(env, user.id, request)
    if (path.match(/^\/api\/railway\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteRailwayToken(env, user.id, path.split('/')[4])
    if (path === '/api/railway/deploy' && method === 'POST') return await handleRailwayDeploy(env, user.id, request)
    if (path === '/api/railway/status' && method === 'GET') return await handleRailwayStatus(env, user.id, url)

    // ── Render.com (StanNG auto-deploy) ──────────────────────────────────
    if (path === '/api/render/tokens' && method === 'GET') return await listRenderTokens(env, user.id)
    if (path === '/api/render/tokens' && method === 'POST') return await createRenderToken(env, user.id, request)
    if (path.match(/^\/api\/render\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteRenderToken(env, user.id, path.split('/')[4])
    if (path === '/api/render/deploy' && method === 'POST') return await handleRenderDeploy(env, user.id, request)
    if (path === '/api/render/status' && method === 'GET') return await handleRenderStatus(env, user.id, url)

    if (path === '/api/deployments' && method === 'GET') return await listDeployments(env, user.id, url)
    if (path === '/api/deployments' && method === 'POST') return await createDeployment(env, user.id, request, ctx, origin)
    if (path.match(/^\/api\/deployments\/[^/]+$/) && method === 'GET') return await getDeployment(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/deployments\/[^/]+$/) && method === 'DELETE') return await deleteDeployment(env, user.id, path.split('/')[3])

    // The deployer bot is the owner's own tool: it is not a panel feature for
    // users or admins, so the whole section is closed to everyone else.
    if ((path.startsWith('/api/bot-config') || path.startsWith('/api/bot-users')) && !(await isOwner(env, user.id))) {
      return apiError('این بخش فقط برای مالک پنل است', 403)
    }

    if (path === '/api/bot-config/webhook-info' && method === 'GET') return await botWebhookInfo(env, user.id)
    if (path === '/api/bot-config/reconnect' && method === 'POST') return await reconnectBotWebhook(env, user.id, origin)
    if (path === '/api/bot-config' && method === 'GET') return await getBotConfig(env, user.id, origin)
    if (path === '/api/bot-config' && (method === 'PUT' || method === 'PATCH')) return await saveBotConfig(env, user.id, request, origin)

    if (path === '/api/bot-users' && method === 'GET') return await listBotUsers(env, user.id)
    if (path.match(/^\/api\/bot-users\/[^/]+$/) && method === 'PATCH') return await updateBotUser(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/bot-users\/[^/]+$/) && method === 'DELETE') return await deleteBotUser(env, user.id, path.split('/')[3])

    if (path === '/api/stats' && method === 'GET') return await getStats(env, user.id)
    if (path === '/api/logs' && method === 'GET') return await listLogs(env, user.id)

    if (path === '/api/worker-config' && method === 'POST') {
      const body = safeJsonParse(await request.text().catch(() => ''), {})
      return await handleWorkerConfig(env, user.id, body)
    }

    // ── Real source bridge: unified settings + live node check ────────
    if (path === '/api/source-settings' && method === 'POST') {
      const body = safeJsonParse(await request.text().catch(() => ''), {})
      return await handleSourceSettings(env, user.id, body)
    }
    if (path.match(/^\/api\/source-nodes\/[^/]+$/) && method === 'GET') {
      return await handleSourceNodes(env, user.id, path.split('/')[3])
    }
    if (path === '/api/ip-scanner' && method === 'POST') {
      const body = safeJsonParse<{ mode?: string; ranges?: string; ports?: string; count?: number; timeout?: number }>(await request.text().catch(() => ''), {})
      if (body.mode === 'ranges') return await handleRangeScan(body)
      return await handleIpScanner(body)
    }

    // ── Config optimizer ────────────────────────────────────────────────
    if (path === '/api/optimizer' && method === 'GET') return await handleOptimizerList(env, user.id)
    if (path === '/api/optimizer' && method === 'POST') return await handleOptimizerCreate(env, user.id, request, ctx)
    if (path.match(/^\/api\/optimizer\/[^/]+$/) && method === 'GET') return await handleOptimizerGet(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/optimizer\/[^/]+$/) && method === 'DELETE') return await handleOptimizerDelete(env, user.id, path.split('/')[3])

    // ── Real edge probes (Sop8 engines: colo, ports, speedtest, batch) ──
    if (path === '/api/opt/probe' && method === 'GET') return await handleOptProbe(env, request)
    if (path === '/api/opt/ports' && method === 'GET') return await handleOptPorts(env, request)
    if (path === '/api/opt/scan-batch' && method === 'POST') return await handleOptScanBatch(env, request)
    if (path === '/api/opt/speedtest' && method === 'GET') return await handleOptSpeedtest(env, request)

    // ── Group subscriptions ───────────────────────────────────────────
    if (path === '/api/subgroups' && method === 'GET') return await handleGroupList(env, user.id)
    if (path === '/api/subgroups' && method === 'POST') return await handleGroupCreate(env, user.id, request)
    if (path.match(/^\/api\/subgroups\/[^/]+$/) && method === 'PATCH') return await handleGroupPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/subgroups\/[^/]+$/) && method === 'DELETE') return await handleGroupDelete(env, user.id, path.split('/')[3])

    // ── Custom injected subscriptions (miliconfig) ────────────────────
    if (path === '/api/injector' && method === 'GET') return await handleInjectorList(env, user.id)
    if (path === '/api/injector' && method === 'POST') return await handleInjectorCreate(env, user.id, request)
    if (path.match(/^\/api\/injector\/[^/]+$/) && method === 'PATCH') return await handleInjectorPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/injector\/[^/]+$/) && method === 'DELETE') return await handleInjectorDelete(env, user.id, path.split('/')[3])

    // ── Per-worker members (end users with private settings) ──────────
    if (path === '/api/backup' && method === 'GET') return await exportBackup(env, user.id)
    if (path === '/api/backup' && method === 'POST') return await importBackup(env, user.id, request)
    if (path === '/api/members' && method === 'GET') return await handleMemberList(env, user.id, url.searchParams.get('deployment_id'))
    if (path === '/api/members' && method === 'POST') return await handleMemberCreate(env, user.id, request)
    if (path === '/api/members/bulk' && method === 'POST') return await handleMemberBulk(env, user.id, request)
    if (path === '/api/cf-quota' && method === 'GET') return await handleCfQuota(env, user.id)
    if (path.match(/^\/api\/members\/[^/]+\/usage$/) && method === 'POST') return await refreshMemberUsage(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/members\/[^/]+\/test$/) && method === 'GET') return await handleMemberTest(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/members\/[^/]+$/) && method === 'PATCH') return await handleMemberPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/members\/[^/]+$/) && method === 'DELETE') return await handleMemberDelete(env, user.id, path.split('/')[3])

    // ── Admin: user & quota management ─────────────────────────────────
    if (path.startsWith('/api/admin')) {
      if (user.role !== 'admin') return apiError('دسترسی فقط برای ادمین', 403)
      if (path === '/api/admin/users' && method === 'GET') {
        const r = await env.DB.prepare(
          `SELECT u.id, u.email, u.role, u.max_deployments, u.created_at,
            (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id) AS deployments
           FROM users u ORDER BY u.created_at`,
        ).all()
        return json({ data: r.results })
      }
      const adminTarget = path.match(/^\/api\/admin\/users\/([^/]+)$/)
      if (adminTarget && method === 'PATCH') {
        const body = safeJsonParse<{ role?: string; max_deployments?: number }>(await request.text().catch(() => ''), {})
        if (body.role !== undefined) {
          if (!['admin', 'user'].includes(body.role)) return apiError('نقش نامعتبر است')
          await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, adminTarget[1]).run()
        }
        if (body.max_deployments !== undefined) {
          const quota = Math.min(Math.max(1, Number(body.max_deployments) || 1), 1000)
          await env.DB.prepare('UPDATE users SET max_deployments = ? WHERE id = ?').bind(quota, adminTarget[1]).run()
        }
        const row = await env.DB.prepare('SELECT id, email, role, max_deployments FROM users WHERE id = ?').bind(adminTarget[1]).first()
        if (!row) return apiError('کاربر پیدا نشد', 404)
        return json({ data: row })
      }
    }

    return apiError('مسیر API پیدا نشد', 404)
  }

  // Static assets (SPA)
  return env.ASSETS.fetch(request)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = url.origin
    const method = request.method
    const cors = corsHeaders(request)

    // CORS preflight
    if (method === 'OPTIONS' && path.startsWith('/api')) {
      return new Response(null, { status: 204, headers: cors })
    }

    try {
      // D1 is attached via dashboard bindings; until it is, answer the API
      // with a clear one-time setup hint instead of crashing.
      if (path.startsWith('/api')) {
        if (!env.DB) {
          return withCors(
            json(
              {
                error:
                  'اتصال دیتابیس هنوز برقرار نیست. در داشبورد کلودفلر: Workers & Pages → miliconfigpro-v1 → Settings → Bindings → Add → D1 database، نام متغیر: DB',
                setup_required: 'd1_binding',
              },
              503,
            ),
            cors,
          )
        }
        await ensureSchema(env)
      }
      const response = await handleRouted(request, env, ctx, path, origin, method)
      return withCors(response, cors)
    } catch (err) {
      console.error('API error:', err)
      return apiError(err instanceof Error ? err.message : 'خطای داخلی سرور', 500)
    }
  },
}

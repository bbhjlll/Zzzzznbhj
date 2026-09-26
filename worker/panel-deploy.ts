/**
 * Shared Railway / Render panel-deploy engine.
 *
 * The web wizard and the Telegram bot must behave identically when starting a
 * panel deployment (validation, credential generation, DB bookkeeping) and
 * when finishing one (admin bootstrap + owner notification), so both call
 * into this module instead of each implementing its own version.
 */

import type { Env } from './env'
import { genId, nowIso } from './util'
import { resolvePanel, type PanelCapability, type PanelSpec } from '../shared/panels'
import { deployToRailway, RailwayApiError, railwayDeployStatus, updateRailwayPanel } from './railway'
import { deployToRender, RenderApiError, renderDeployStatus } from './render'
import { notifyDeployment } from './telegram-core'

export type PanelPlatform = 'railway' | 'render'

/** Everything a caller needs to start a panel deployment. */
export interface StartPanelDeployInput {
  userId: string
  /** Row id of the Railway (`railway_tokens`) or Render (`render_tokens`) token. */
  tokenId: string
  /** Lowercase letters, digits and hyphens — used as the project/service name. */
  name: string
  panel: PanelSpec
  /** Railway region; ignored by Render. */
  region?: string
}

export type StartPanelDeployResult =
  | {
      ok: true
      platform: PanelPlatform
      /** Stable registry id stored in `railway_deploys` / `render_deploys`. */
      id: string
      /** Railway project id, returned to the web deployment wizard. */
      projectId?: string
      /** Render only — needed to poll the deploy status. */
      serviceId?: string
      adminUsername: string
      adminPassword: string
      /** Railway may already return the generated *.up.railway.app domain. */
      domain: string | null
      dashboardUrl: string
    }
  | { ok: false; error: string }

/**
 * Validate + start a panel deployment on Railway or Render.
 * Credentials are generated once, pushed to the service as env vars and
 * persisted so the watcher can bootstrap the panel admin when it goes live.
 */
export async function startPanelDeploy(env: Env, input: StartPanelDeployInput): Promise<StartPanelDeployResult> {
  const name = (input.name ?? '').trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return { ok: false, error: 'نام پروژه نامعتبر است (حروف کوچک انگلیسی، عدد و خط تیره)' }
  }
  if (!input.panel.targets.includes('railway') && !input.panel.targets.includes('render')) {
    return { ok: false, error: `${input.panel.name} روی Railway/Render مستقر نمی‌شود — از روش VPS استفاده کنید` }
  }

  // The token decides the platform: a Railway token deploys to Railway, a
  // Render key to Render — the same rule the web wizard follows.
  const rail = await env.DB.prepare("SELECT id, token, name FROM railway_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(input.tokenId, input.userId)
    .first<{ id: string; token: string; name: string }>()
  const render = rail ? null : await env.DB.prepare("SELECT id, token, name FROM render_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(input.tokenId, input.userId)
    .first<{ id: string; token: string; name: string }>()

  if (!rail && !render) return { ok: false, error: 'توکن Railway/Render فعال انتخاب‌شده پیدا نشد' }
  const platform: PanelPlatform = rail ? 'railway' : 'render'
  if (platform === 'railway' && !input.panel.targets.includes('railway')) {
    return { ok: false, error: `${input.panel.name} روی Railway مستقر نمی‌شود — یک کلید Render انتخاب کنید` }
  }
  if (platform === 'render' && !input.panel.targets.includes('render')) {
    return { ok: false, error: `${input.panel.name} روی Render مستقر نمی‌شود — یک توکن Railway انتخاب کنید` }
  }

  const token = (rail ?? render)!.token
  const tokenId = (rail ?? render)!.id
  const adminUsername = 'admin'
  const adminPassword = input.panel.defaultAdminPassword ?? `mil${genId().replaceAll('-', '')}`.slice(0, 14)
  const secretKey = genId()

  try {
    if (platform === 'railway') {
      const region = /^[a-z0-9-]+$/.test(input.region ?? '') ? (input.region as string) : 'us-west2'
      const result = await deployToRailway(token, name, region, input.panel, { adminPassword, secretKey })
      await env.DB.prepare(
        `INSERT INTO railway_deploys (
           id, user_id, token_id, project_id, service_id, environment_id, current_deployment_id,
           region, domain, branch, commit_sha, commit_url, project_token,
           tcp_proxy_id, tcp_proxy_domain, tcp_proxy_port, tcp_proxy_application_port, tcp_proxy_error,
           tcp_proxies, auto_deploy, name, panel, admin_username, admin_password, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        result.deploymentId,
        input.userId,
        tokenId,
        result.projectId,
        result.serviceId,
        result.environmentId,
        result.deploymentId,
        region,
        result.domain ?? null,
        'main',
        result.commitSha,
        result.commitUrl,
        result.projectToken ?? null,
        result.tcpProxy?.id ?? null,
        result.tcpProxy?.domain ?? null,
        result.tcpProxy?.proxyPort ?? null,
        result.tcpProxy?.applicationPort ?? null,
        result.tcpProxyError ?? null,
        JSON.stringify(result.tcpProxies ?? []),
        1,
        name,
        input.panel.id,
        adminUsername,
        adminPassword,
        nowIso(),
      ).run()
      await env.DB.prepare('UPDATE railway_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), tokenId).run()
      await logStarted(env, input.userId, 'railway', name)
      return { ok: true, platform, id: result.deploymentId, projectId: result.projectId, adminUsername, adminPassword, domain: result.domain ?? null, dashboardUrl: result.projectUrl }
    }

    const result = await deployToRender(token, name, input.panel, { adminPassword, secretKey })
    await env.DB.prepare(
      `INSERT INTO render_deploys (id, user_id, token_id, service_id, name, panel, admin_username, admin_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(result.deployId, input.userId, tokenId, result.serviceId, name, input.panel.id, adminUsername, adminPassword, nowIso()).run()
    await env.DB.prepare('UPDATE render_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), tokenId).run()
    await logStarted(env, input.userId, 'render', name)
    return { ok: true, platform, id: result.deployId, serviceId: result.serviceId, adminUsername, adminPassword, domain: null, dashboardUrl: result.dashboardUrl }
  } catch (err) {
    const msg = err instanceof RailwayApiError || err instanceof RenderApiError ? err.message : err instanceof Error ? err.message : 'خطا در استقرار پنل'
    return { ok: false, error: msg }
  }
}

async function logStarted(env: Env, userId: string, platform: PanelPlatform, name: string): Promise<void> {
  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), userId, `${platform}_deploy_started`, 'deployment', name, nowIso())
    .run()
}

export type PanelUpdateResult =
  | {
      ok: true
      platform: 'railway'
      deploymentId: string
      commitSha: string
      commitUrl: string
    }
  | { ok: false; error: string }

/**
 * Deploy the newest upstream commit immediately for one owned Railway panel.
 * The stable registry id stays the same; only current_deployment_id advances,
 * so cards, polling and future updates do not need to be recreated.
 */
export async function updatePanelDeploy(
  env: Env,
  userId: string,
  platform: PanelPlatform,
  id: string,
): Promise<PanelUpdateResult> {
  if (platform !== 'railway') return { ok: false, error: 'به‌روزرسانی فوری در حال حاضر برای Railway فعال است' }

  const row = await env.DB.prepare(
    `SELECT name, panel, project_id, service_id, environment_id, branch, token_id, project_token
     FROM railway_deploys WHERE id = ? AND user_id = ?`,
  ).bind(id, userId).first<{
    name: string | null
    panel: string | null
    project_id: string
    service_id: string
    environment_id: string
    branch: string | null
    token_id: string
    project_token: string | null
  }>()
  if (!row) return { ok: false, error: 'پنل در فهرست شما نیست' }

  const token = row.project_token || await activeToken(env, userId, row.token_id, 'railway')
  if (!token) return { ok: false, error: 'توکن Railway فعال برای این پنل پیدا نشد' }

  try {
    const result = await updateRailwayPanel(
      token,
      row.project_id,
      row.service_id,
      row.environment_id,
      resolvePanel(row.panel),
      row.branch || 'main',
    )
    await env.DB.prepare(
      `UPDATE railway_deploys
       SET current_deployment_id = ?, commit_sha = ?, commit_url = ?, auto_deploy = 1
       WHERE id = ? AND user_id = ?`,
    ).bind(result.deploymentId, result.commitSha, result.commitUrl, id, userId).run()
    await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(genId(), userId, 'railway_deploy_updated', 'deployment', row.name ?? id, nowIso())
      .run()
    return { ok: true, platform, ...result }
  } catch (err) {
    const message = err instanceof RailwayApiError ? err.message : err instanceof Error ? err.message : 'به‌روزرسانی پنل ناموفق بود'
    return { ok: false, error: message }
  }
}

export type PanelWatchResult =
  | { state: 'pending' | 'failed'; status: string; url: string | null }
  | {
      state: 'live'
      status: string
      url: string
      panelPath: string
      panelName: string
      adminUsername: string | null
      adminPassword: string | null
      /** True on the first poll that observed the deployment live. */
      firstLive: boolean
      /** Why a raw-TCP capability could not be switched on inside the panel. */
      capabilitiesError?: string | null
    }

interface RailRec {
  name: string | null
  domain: string | null
  panel: string | null
  current_deployment_id: string | null
  project_token: string | null
  admin_username: string | null
  admin_password: string | null
  setup_done: number
  token_id: string
}

interface RenderRec {
  name: string | null
  url: string | null
  panel: string | null
  service_id: string
  admin_username: string | null
  admin_password: string | null
  setup_done: number
  token_id: string
}

/**
 * Poll one panel deployment; when it goes live, bootstrap the panel admin
 * (panels exposing a setup endpoint) exactly once and notify the bot owner.
 */
export async function watchPanelDeploy(env: Env, userId: string, platform: PanelPlatform, deployId: string): Promise<PanelWatchResult> {
  try {
    if (platform === 'railway') {
      const rec = await env.DB.prepare('SELECT name, domain, panel, current_deployment_id, project_token, admin_username, admin_password, setup_done, token_id FROM railway_deploys WHERE id = ? AND user_id = ?')
        .bind(deployId, userId)
        .first<RailRec>()
      if (!rec) return { state: 'pending', status: 'NOT_FOUND', url: null }
      const token = rec.project_token || await activeToken(env, userId, rec.token_id, 'railway')
      if (!token) return { state: 'pending', status: 'NO_TOKEN', url: null }

      const statusId = rec.current_deployment_id || deployId
      let status = await railwayDeployStatus(token, statusId)
      if (status.status !== 'SUCCESS') {
        const failed = ['FAILED', 'CRASHED', 'REMOVED'].includes(status.status)
        return { state: failed ? 'failed' : 'pending', status: status.status, url: status.url }
      }

      const panel = resolvePanel(rec.panel)
      if (!rec.domain) return { state: 'pending', status: 'SUCCESS_NO_DOMAIN', url: null }
      const url = `https://${rec.domain}`
      const firstLive = !rec.setup_done
      let capabilitiesError: string | null = null
      if (firstLive) {
        if (panel.setupPath && rec.admin_username && rec.admin_password) {
          await bootstrapPanelAdmin(`${url}${panel.setupPath}`, rec.admin_username, rec.admin_password)
        }
        // Switch the published raw-TCP capabilities on inside the panel, so the
        // ports Railway now forwards to really have a listener behind them.
        if (rec.admin_password) {
          capabilitiesError = await enablePanelCapabilities(url, rec.admin_password, panel.capabilities)
        }
        await env.DB.prepare('UPDATE railway_deploys SET setup_done = 1 WHERE id = ? AND user_id = ?').bind(deployId, userId).run()
        await notifyDeployment(env, userId, rec.name ?? panel.name, 'deployed', url, `${url}${panel.panelPath}`).catch(() => null)
      }
      return {
        state: 'live',
        status: status.status,
        url,
        panelPath: panel.panelPath,
        panelName: panel.name,
        adminUsername: rec.admin_username,
        adminPassword: rec.admin_password,
        firstLive,
        capabilitiesError,
      }
    }

    const rec = await env.DB.prepare('SELECT name, url, panel, service_id, admin_username, admin_password, setup_done, token_id FROM render_deploys WHERE id = ? AND user_id = ?')
      .bind(deployId, userId)
      .first<RenderRec>()
    if (!rec) return { state: 'pending', status: 'NOT_FOUND', url: null }
    const token = await activeToken(env, userId, rec.token_id, 'render')
    if (!token) return { state: 'pending', status: 'NO_TOKEN', url: null }

    const status = await renderDeployStatus(token, deployId, rec.service_id)
    if (status.status !== 'LIVE') {
      const failed = ['FAILED', 'DEACTIVATED', 'CANCELED', 'BUILD_FAILED'].includes(status.status)
      return { state: failed ? 'failed' : 'pending', status: status.status, url: status.url ?? rec.url }
    }      const liveUrl = status.url ?? rec.url
      if (!liveUrl) return { state: 'pending', status: 'LIVE_NO_URL', url: null }
      const panel = resolvePanel(rec.panel)
      const firstLive = !rec.setup_done
      let capabilitiesError: string | null = null
      if (firstLive) {
        if (status.url && rec.url !== status.url) {
          await env.DB.prepare('UPDATE render_deploys SET url = ? WHERE id = ? AND user_id = ?').bind(status.url, deployId, userId).run()
        }
        if (panel.setupPath && rec.admin_username && rec.admin_password) {
          await bootstrapPanelAdmin(`${liveUrl}${panel.setupPath}`, rec.admin_username, rec.admin_password)
        }
        if (rec.admin_password) {
          capabilitiesError = await enablePanelCapabilities(liveUrl, rec.admin_password, panel.capabilities)
        }
      await env.DB.prepare('UPDATE render_deploys SET setup_done = 1, url = ? WHERE id = ? AND user_id = ?').bind(liveUrl, deployId, userId).run()
      await notifyDeployment(env, userId, rec.name ?? panel.name, 'deployed', liveUrl, `${liveUrl}${panel.panelPath}`).catch(() => null)
    }
    return {
      state: 'live',
      status: status.status,
      url: liveUrl,
      panelPath: panel.panelPath,        panelName: panel.name,
        adminUsername: rec.admin_username,
        adminPassword: rec.admin_password,
        firstLive,
        capabilitiesError,
      }
  } catch (err) {
    return { state: 'pending', status: err instanceof Error ? err.message.slice(0, 200) : 'ERROR', url: null }
  }
}

async function activeToken(env: Env, userId: string, tokenId: string, platform: PanelPlatform): Promise<string | null> {
  const table = platform === 'railway' ? 'railway_tokens' : 'render_tokens'
  const row = await env.DB.prepare(`SELECT token FROM ${table} WHERE id = ? AND user_id = ? AND status = 'active'`)
    .bind(tokenId, userId)
    .first<{ token: string }>()
  return row?.token ?? null
}

/**
 * One row of the user's hosted-panel registry, ready for the UI/API.
 * Flattens the platform-specific tables and the catalog spec into one shape so
 * the dashboard, the deployments page and the bot all render the same thing.
 */
export interface PanelDeployRow {
  platform: PanelPlatform
  /** `railway_deploys.id` / `render_deploys.id` — the deployment id. */
  id: string
  name: string | null
  /** Catalog panel id + display name. */
  panel: string
  panelName: string
  panelPath: string
  healthPath: string
  /** Public host (Railway) — Render only stores the full URL. */
  domain: string | null
  /** Live base URL, e.g. `https://app.up.railway.app`. */
  url: string | null
  /** Direct link into the panel dashboard. */
  panelUrl: string | null
  adminUsername: string | null
  adminPassword: string | null
  setupDone: boolean
  dashboardUrl: string | null
  /** Railway's current deployment id; this may change after an update. */
  currentDeploymentId: string | null
  branch: string | null
  commitSha: string | null
  commitUrl: string | null
  autoDeploy: boolean
  /** First (direct) TCP proxy — kept for the compact card summary. */
  tcpProxy: { domain: string; port: number; applicationPort: number } | null
  /** Every published raw-TCP capability, in catalog order. */
  tcpProxies: Array<{ label: string; domain: string; port: number; applicationPort: number }>
  tcpProxyError: string | null
  createdAt: string | null
}

/** Every panel this user has deployed on Railway/Render, newest first. */
export async function listPanelDeploys(env: Env, userId: string): Promise<PanelDeployRow[]> {
  const rail = await env.DB.prepare(
    `SELECT id, name, panel, domain, project_id, current_deployment_id, branch, commit_sha, commit_url,
            auto_deploy, tcp_proxy_domain, tcp_proxy_port, tcp_proxy_application_port, tcp_proxy_error,
            tcp_proxies, admin_username, admin_password, setup_done, created_at
     FROM railway_deploys WHERE user_id = ?`,
  ).bind(userId).all<{
    id: string; name: string | null; panel: string | null; domain: string | null; project_id: string
    current_deployment_id: string | null; branch: string | null; commit_sha: string | null; commit_url: string | null
    auto_deploy: number; tcp_proxy_domain: string | null; tcp_proxy_port: number | null
    tcp_proxy_application_port: number | null; tcp_proxy_error: string | null; tcp_proxies: string | null
    admin_username: string | null; admin_password: string | null; setup_done: number; created_at: string | null
  }>()
  const render = await env.DB.prepare(
    'SELECT id, name, panel, url, service_id, admin_username, admin_password, setup_done, created_at FROM render_deploys WHERE user_id = ?',
  ).bind(userId).all<{
    id: string; name: string | null; panel: string | null; url: string | null; service_id: string
    admin_username: string | null; admin_password: string | null; setup_done: number; created_at: string | null
  }>()

  const rows: PanelDeployRow[] = []
  for (const r of rail.results ?? []) {
    const spec = resolvePanel(r.panel)
    const url = r.domain ? `https://${r.domain}` : null
    rows.push({
      platform: 'railway',
      id: r.id,
      name: r.name,
      panel: spec.id,
      panelName: spec.name,
      panelPath: spec.panelPath,
      healthPath: spec.healthPath ?? spec.panelPath,
      domain: r.domain,
      url,
      panelUrl: url ? `${url}${spec.panelPath}` : null,
      adminUsername: r.admin_username,
      adminPassword: r.admin_password,
      setupDone: !!r.setup_done,
      dashboardUrl: r.project_id ? `https://railway.com/project/${r.project_id}` : null,
      currentDeploymentId: r.current_deployment_id ?? r.id,
      branch: r.branch ?? 'main',
      commitSha: r.commit_sha ?? null,
      commitUrl: r.commit_url ?? null,
      autoDeploy: r.auto_deploy !== 0,
      tcpProxy: r.tcp_proxy_domain && r.tcp_proxy_port && r.tcp_proxy_application_port
        ? { domain: r.tcp_proxy_domain, port: r.tcp_proxy_port, applicationPort: r.tcp_proxy_application_port }
        : null,
      tcpProxies: parseTcpProxies(r.tcp_proxies, r.tcp_proxy_domain, r.tcp_proxy_port, r.tcp_proxy_application_port),
      tcpProxyError: r.tcp_proxy_error ?? null,
      createdAt: r.created_at,
    })
  }
  for (const r of render.results ?? []) {
    const spec = resolvePanel(r.panel)
    rows.push({
      platform: 'render',
      id: r.id,
      name: r.name,
      panel: spec.id,
      panelName: spec.name,
      panelPath: spec.panelPath,
      healthPath: spec.healthPath ?? spec.panelPath,
      domain: r.url ? r.url.replace(/^https?:\/\//, '') : null,
      url: r.url,
      panelUrl: r.url ? `${r.url}${spec.panelPath}` : null,
      adminUsername: r.admin_username,
      adminPassword: r.admin_password,
      setupDone: !!r.setup_done,
      dashboardUrl: `https://dashboard.render.com/web/${r.service_id}`,
      currentDeploymentId: r.id,
      branch: null,
      commitSha: null,
      commitUrl: null,
      autoDeploy: true,
      tcpProxy: null,
      tcpProxies: [],
      tcpProxyError: null,
      createdAt: r.created_at,
    })
  }
  return rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * The stored proxy list, tolerating a row written before the JSON column
 * existed: those deployments have only the single-proxy columns, and the panel
 * catalog says which capability that first port belongs to.
 */
function parseTcpProxies(
  raw: string | null,
  domain: string | null,
  port: number | null,
  applicationPort: number | null,
): Array<{ label: string; domain: string; port: number; applicationPort: number }> {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<{ label?: string; domain?: string; proxyPort?: number; applicationPort?: number }>
      const list = parsed
        .filter((item) => item?.domain && item.proxyPort && item.applicationPort)
        .map((item) => ({
          label: String(item.label ?? `TCP ${item.applicationPort}`),
          domain: String(item.domain),
          port: Number(item.proxyPort),
          applicationPort: Number(item.applicationPort),
        }))
      if (list.length) return list
    } catch {
      /* fall through to the legacy single-proxy columns */
    }
  }
  return domain && port && applicationPort
    ? [{ label: 'Reality (مسیر مستقیم)', domain, port, applicationPort }]
    : []
}

/**
 * Drop one panel record from the panel's own registry.
 *
 * This only forgets the deployment inside miliconfig — the service keeps
 * running on Railway/Render, so the user can still delete it there (the card
 * links to the platform dashboard). Removing it from the platform too would
 * need the token and is deliberately left to the dashboard.
 */
export async function forgetPanelDeploy(
  env: Env,
  userId: string,
  platform: PanelPlatform,
  id: string,
): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  const table = platform === 'railway' ? 'railway_deploys' : 'render_deploys'
  const row = await env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ? RETURNING name`)
    .bind(id, userId)
    .first<{ name: string | null }>()
  if (!row) return { ok: false, error: 'این پنل در فهرست شما نیست' }
  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), userId, 'panel_forgotten', 'deployment', row.name ?? id, nowIso())
    .run()
  return { ok: true, name: row.name }
}

/**
 * Health-probe one of the user's panels from the edge.
 *
 * The URL always comes from our own record (never from the request), so this
 * cannot be used to make the worker fetch arbitrary hosts.
 */
export async function probePanelHealth(
  env: Env,
  userId: string,
  platform: PanelPlatform,
  id: string,
): Promise<{ ok: boolean; status: number | null; ms: number; url: string | null; error?: string }> {
  const deploys = await listPanelDeploys(env, userId)
  const target = deploys.find((d) => d.platform === platform && d.id === id)
  if (!target) return { ok: false, status: null, ms: 0, url: null, error: 'این پنل در فهرست شما نیست' }
  if (!target.url) return { ok: false, status: null, ms: 0, url: null, error: 'آدرس عمومی این پنل هنوز ساخته نشده' }

  const started = Date.now()
  try {
    const resp = await fetch(`${target.url}${target.healthPath}`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    return { ok: resp.ok, status: resp.status, ms: Date.now() - started, url: target.url }
  } catch (err) {
    return {
      ok: false,
      status: null,
      ms: Date.now() - started,
      url: target.url,
      error: err instanceof Error ? err.message.slice(0, 160) : 'پاسخی دریافت نشد',
    }
  }
}

/** POST the one-time admin credentials to the panel's setup endpoint (if any). */
async function bootstrapPanelAdmin(setupUrl: string, username: string, password: string): Promise<void> {
  // Brief retry loop — DNS/proxy warm-up right after the deploy goes live.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fetch(setupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(12000),
      })
      return
    } catch {
      if (attempt === 3) return
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}

/**
 * Switch the panel's own raw-TCP capabilities on (MTProto, the HTTP web proxy)
 * right after it first answers.
 *
 * The panel ships with those listeners off — a published port in front of a
 * socket nobody binds is the exact failure this deploy engine exists to avoid,
 * so whoever created the deployment also makes the decision. The panel accepts
 * the admin password as a header (`x-admin-password`), which saves a login round
 * trip, and its save endpoint reconciles the listeners before it answers.
 *
 * Returns a readable reason instead of throwing: a panel that is merely slow to
 * accept the write must not be reported as a failed deployment.
 */
async function enablePanelCapabilities(
  baseUrl: string,
  adminPassword: string,
  capabilities: PanelCapability[] | undefined,
): Promise<string | null> {
  if (!capabilities?.length) return null
  // `key` is a dotted path into the save payload: `mtproto` →
  // `{ mtproto: … }`, `webproxy.web-http` → `{ webproxy: { 'web-http': … } }`.
  const body: Record<string, unknown> = {}
  for (const capability of capabilities) {
    const path = capability.key.split('.').filter(Boolean)
    if (!path.length) continue
    let node = body
    for (const segment of path.slice(0, -1)) {
      const next = (node[segment] ??= {}) as Record<string, unknown>
      node = next
    }
    node[path[path.length - 1]] = { enabled: '1' }
  }
  if (!Object.keys(body).length) return null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${baseUrl}/api/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      if (resp.ok) return null
      if (resp.status === 401) return 'پنل رمز ادمین استقرار را نپذیرفت — قابلیت‌های پورت خام دستی روشن می‌شوند'
      if (attempt === 2) return `پنل قابلیت‌های پورت خام را نپذیرفت (HTTP ${resp.status})`
    } catch (err) {
      if (attempt === 2) return err instanceof Error ? err.message.slice(0, 160) : 'پنل پاسخ نداد'
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

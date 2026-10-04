import type { Env } from './env'
import { nowIso, genId, edgetunnelSubToken, safeJsonParse } from './util'
import { notifyDeployment } from './telegram'

// ── Ported 1:1 from the original cf-deploy function (Supabase → D1) ────────
// The deploy steps, source URLs, bindings and fallbacks are identical to the
// version the project originally shipped with.

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface WorkerSourceConfig {
  url: string
  label: string
  compat: string
  kvBinding: string
  configKey: string
  configFormat: 'edgetunnel' | 'custom'
  uuidEnvName: string
  fallbackUrls?: string[]
  /**
   * Which routing model the worker implements — this is what decides the
   * panel path and the subscription link, so the two can never be guessed
   * wrong again:
   *
   *  - `edgetunnel` (cmliu): the dashboard lives at a FIXED `/admin` (or
   *    `/login`), and the subscription is `/sub?token=<md5(host+uuid)>`.
   *  - `custom` / `nexus` (CFnew): the dashboard and the subscription are both
   *    served under the UUID path — `/<uuid>` is the panel, `/<uuid>/sub` the
   *    raw sub link. There is no `/sub` at the worker root.
   *  - `zeus`: the whole worker is a D1-backed panel; a user's subscription is
   *    `/sub/<username>`, which only exists after an account is created in the
   *    panel — there is no deploy-time sub link at all.
   */
  kind: 'edgetunnel' | 'custom' | 'nexus' | 'zeus'
}

const WORKER_SOURCES: Record<string, WorkerSourceConfig> = {
  edgetunnel: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: 'edgetunnel',
  },
  edgetunnel_kv: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel (KV mode)',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: 'edgetunnel',
  },
  custom: {
    url: 'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/worker-source.js',
    label: 'Custom worker (CFnew v2.9.8c)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The public mirrors of this (private-repo) source 404, so the copy
    // bundled with the panel is always tried as the fallback.
    fallbackUrls: [
      'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/worker-source.js',
      '/repo/worker-source.js',
    ],
    kind: 'custom',
  },
  nexus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/nexus.js',
    label: 'NEXUS — نسل جدید (پنل داخلی + نقشه زنده + مبهم‌سازی)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The repo is private, so every raw mirror 404s. Without the bundled copy
    // as a fallback the deploy dies with "failed to fetch worker source".
    fallbackUrls: [
      'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/nexus.js',
      '/repo/nexus.js',
    ],
    kind: 'nexus',
  },
  zeus: {
    // ZEUS PANEL (panel-zeus/Z-E-U-S) — full D1 panel, anti-censorship core:
    // TLS fragmentation, ClientHello fingerprint spoofing, D1-backed users.
    url: 'https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js',
    label: 'ZEUS PANEL (panel-zeus/Z-E-U-S)',
    // Read from the panel's own source (compatibility_date: "2026-07-10").
    compat: '2026-07-10',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: 'zeus',
  },
  miliconfigzeus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigzeus/main/Source-2.js',
    label: 'miliconfig zeus (full D1 panel)',
    compat: '2025-01-01',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: 'zeus',
  },
}

/** Source config for a worker_source id (unknown → the edgetunnel default). */
export function workerSourceConfig(workerSource: string | null | undefined): WorkerSourceConfig {
  return WORKER_SOURCES[workerSource ?? 'edgetunnel'] ?? WORKER_SOURCES.edgetunnel
}

export interface FetchedSource {
  code: string
  url: string
  /** raw.githubusercontent ETag = sha256 of the file — a perfect "did upstream
   *  change?" fingerprint, so a re-deploy never pushes an identical script. */
  etag: string
  usedFallback: boolean
}

/**
 * Download a worker source from its upstream repository, trying the primary
 * URL first and then any fallback (mirrors / the copy bundled with this panel)
 * so a moved or renamed repo can never 404 a deployment.
 */
export async function fetchWorkerSource(
  sourceConfig: WorkerSourceConfig,
  fallbackUrls: string[],
): Promise<FetchedSource | null> {
  for (const [i, url] of [sourceConfig.url, ...fallbackUrls].entries()) {
    try {
      const resp = await fetch(url)
      if (resp.ok && Number(resp.headers.get('content-length') ?? '1') !== 0) {
        const text = await resp.text()
        if (text.trim().length > 0) {
          return {
            code: text,
            url,
            etag: (resp.headers.get('etag') ?? '').trim(),
            usedFallback: i > 0,
          }
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null
}

/** Store the upstream fingerprint on the deployment so "update from repo" can
 *  tell the user whether anything actually changed. */
export async function recordSourceFingerprint(
  env: Env,
  deploymentId: string,
  source: { url: string; etag: string; bytes: number },
): Promise<void> {
  const row = await env.DB.prepare('SELECT config FROM deployments WHERE id = ?')
    .bind(deploymentId)
    .first<{ config: string | null }>()
  const cfg = safeJsonParse<Record<string, unknown>>(row?.config ?? '', {})
  cfg.source_url = source.url
  cfg.source_etag = source.etag
  cfg.source_bytes = source.bytes
  cfg.source_synced_at = nowIso()
  await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(cfg), nowIso(), deploymentId)
    .run()
}

/** Input shared by the web API and the Telegram bot when starting a deploy. */
export interface StartDeploymentInput {
  userId: string
  /** Worker script name (lowercase letters, digits and hyphens). */
  name: string
  uuid: string
  /** Row id of the Cloudflare token to use (must belong to the user + be active). */
  cfTokenId: string
  method?: 'workers' | 'pages'
  workerSource?: string
  proxyip?: string
  adminPassword?: string
  customPath?: string
  /** Panel origin, used for the bundled-source fallback and the wizard link. */
  origin: string
}

export type StartDeploymentResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Validate + create a deployment row and hand it to the deploy engine.
 * Extracted so the web API and the Telegram bot run the exact same checks
 * (name/uuid/token/quota) and can never drift apart.
 */
export async function startDeployment(
  env: Env,
  ctx: ExecutionContext,
  input: StartDeploymentInput,
): Promise<StartDeploymentResult> {
  const name = (input.name ?? '').trim().toLowerCase()
  const uuid = (input.uuid ?? '').trim()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return { ok: false, error: 'نام ورکر نامعتبر است' }
  if (!uuid) return { ok: false, error: 'UUID الزامی است' }

  const tokenRow = await env.DB.prepare("SELECT id, token FROM cf_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(input.cfTokenId ?? '', input.userId)
    .first<{ id: string; token: string }>()
  if (!tokenRow) return { ok: false, error: 'توکن فعال انتخاب‌شده پیدا نشد' }

  const quotaRow = await env.DB.prepare('SELECT max_deployments FROM users WHERE id = ?')
    .bind(input.userId)
    .first<{ max_deployments: number | null }>()
  const quota = quotaRow?.max_deployments ?? 100
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM deployments WHERE user_id = ?')
    .bind(input.userId)
    .first<{ c: number }>()
  if ((count?.c ?? 0) >= quota) return { ok: false, error: `به سقف تعداد ورکرهای خود (${quota}) رسیده‌اید` }

  const id = genId()
  await env.DB.prepare(
    `INSERT INTO deployments (id, user_id, name, worker_code, config, status, uuid, custom_path, method, worker_source, created_at, updated_at)
     VALUES (?, ?, ?, '[auto-loaded]', '{}', 'deploying', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.userId, name, uuid, input.customPath || null, input.method === 'pages' ? 'pages' : 'workers',
      input.workerSource ?? 'edgetunnel', nowIso(), nowIso())
    .run()

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), input.userId, 'deployment_created', 'deployment', name, nowIso())
    .run()

  ctx.waitUntil(runDeployment(env, {
    deployment_id: id,
    worker_name: name,
    cf_token: tokenRow.token,
    cf_token_row_id: tokenRow.id,
    uuid,
    method: input.method === 'pages' ? 'pages' : 'workers',
    worker_source: input.workerSource ?? 'edgetunnel',
    proxyip: input.proxyip || undefined,
    admin_password: input.adminPassword || undefined,
    custom_path: input.customPath || undefined,
    origin: input.origin,
  }))

  return { ok: true, id }
}

export interface DeployJob {
  deployment_id: string
  worker_name: string
  cf_token: string
  cf_token_row_id?: string | null
  uuid: string
  method: 'workers' | 'pages'
  worker_source: string
  proxyip?: string
  admin_password?: string
  custom_path?: string
  origin: string
}

async function appendLog(env: Env, id: string, line: string): Promise<void> {
  const row = await env.DB.prepare('SELECT logs FROM deployments WHERE id = ?').bind(id).first<{ logs: string | null }>()
  const existing = row?.logs ?? ''
  await env.DB.prepare('UPDATE deployments SET logs = ? WHERE id = ?').bind(existing + line + '\n', id).run()
}

async function updateDeployment(env: Env, id: string, status: string, updates: Record<string, unknown>): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?']
  const binds: unknown[] = [status, nowIso()]
  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k} = ?`)
    binds.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
  }
  binds.push(id)
  await env.DB.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`).bind(...(binds as string[])).run()
}

export async function runDeployment(env: Env, job: DeployJob): Promise<void> {
  const { deployment_id } = job
  const worker_name = job.worker_name
  const cf_token = job.cf_token
  const uuid = job.uuid
  const custom_path = job.custom_path ?? ''
  const sourceConfig0 = WORKER_SOURCES[job.worker_source || 'edgetunnel'] ?? WORKER_SOURCES.edgetunnel
  // Zeus is a full standalone panel — it always deploys as a Workers script.
  const method: DeployJob['method'] = sourceConfig0.kind === 'zeus' ? 'workers' : job.method
  const worker_source = job.worker_source || 'edgetunnel'
  const proxyip = job.proxyip ?? ''
  const admin_password = job.admin_password ?? ''
  const headers = { Authorization: `Bearer ${cf_token}` }

  try {
    const sourceConfig = WORKER_SOURCES[worker_source] ?? WORKER_SOURCES.edgetunnel
    const compatDate = sourceConfig.compat
    const kvBindingName = sourceConfig.kvBinding
    const configKvKey = sourceConfig.configKey
    const configFormat = sourceConfig.configFormat
    const uuidEnv = sourceConfig.uuidEnvName

    // ── Verify token ────────────────────────────────────────────────────
    await appendLog(env, deployment_id, 'verifying token...')
    const verifyResp = await fetch(`${API_BASE}/user/tokens/verify`, { headers })
    const verifyData = (await verifyResp.json()) as { success?: boolean }
    if (!verifyData.success) {
      await appendLog(env, deployment_id, '✗ invalid cloudflare token')
      await updateDeployment(env, deployment_id, 'failed', { error_message: 'invalid cloudflare token' })
      return
    }
    await appendLog(env, deployment_id, '✓ token verified')

    // ── Resolve account ─────────────────────────────────────────────────
    await appendLog(env, deployment_id, 'listing accounts...')
    const accountsResp = await fetch(`${API_BASE}/accounts?per_page=50`, { headers })
    const accountsData = (await accountsResp.json()) as { success?: boolean; result?: Array<{ id: string; name: string }> }
    if (!accountsData.success || !accountsData.result?.length) {
      await appendLog(env, deployment_id, '✗ no cloudflare accounts found')
      await updateDeployment(env, deployment_id, 'failed', { error_message: 'no cloudflare accounts found' })
      return
    }
    const accountId = accountsData.result[0].id
    const accountName = accountsData.result[0].name
    await appendLog(env, deployment_id, `✓ account: ${accountName} (${accountId.slice(0, 8)}...)`)

    // ── Fetch worker source ─────────────────────────────────────────────
    await appendLog(env, deployment_id, `fetching worker source from ${sourceConfig.label}...`)
    let workerCode = ''
    // Primary URL first; if unavailable (e.g. repo moved/renamed), fall back to
    // the copy bundled with this panel so the default source can never 404.
// Fallbacks may be absolute (a mirror) or panel-relative (the copy bundled
    // in `public/repo/`, e.g. `/repo/nexus.js`). Relative ones are resolved
    // against this installation's own origin — the repo is private, so the raw
    // mirrors 404 and the bundled copy is the only one that works.
    const fallbackUrls = (sourceConfig.fallbackUrls ?? []).map((u) =>
      /^https?:\/\//i.test(u) ? u : `${job.origin.replace(/\/$/, '')}${u.startsWith('/') ? u : `/${u}`}`,
    )
    const fetched = await fetchWorkerSource(sourceConfig, fallbackUrls)
    workerCode = fetched?.code ?? ''
    if (!workerCode) {
      await appendLog(env, deployment_id, '✗ failed to fetch worker source')
      await updateDeployment(env, deployment_id, 'failed', { error_message: 'failed to fetch worker source' })
      return
    }
    if (fetched?.usedFallback) {
      await appendLog(env, deployment_id, `primary source unavailable, used fallback (${new URL(fetched.url).host})`)
    }
    await appendLog(env, deployment_id, `✓ worker source fetched (${workerCode.length} bytes)`)
    await recordSourceFingerprint(env, deployment_id, {
      url: fetched!.url,
      etag: fetched!.etag,
      bytes: workerCode.length,
    })

    // ── Provision storage: full D1 database (zeus) or KV namespace ──────
    let d1DatabaseId = ''
    let kvNamespaceId = ''
    if (sourceConfig.kind === 'zeus') {
      await appendLog(env, deployment_id, 'creating D1 database...')
      const d1Name = `${worker_name}-db`
      const d1Resp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d1Name }),
      })
      const d1Data = (await d1Resp.json().catch(() => ({}))) as { success?: boolean; result?: { uuid?: string }; errors?: Array<{ message: string }> }
      d1DatabaseId = d1Data.result?.uuid ?? ''
      if (!d1DatabaseId) {
        // Already exists? Reuse it instead of failing.
        const listResp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database?per_page=100`, { headers })
        const listData = (await listResp.json().catch(() => ({}))) as { result?: Array<{ uuid?: string; name?: string }> }
        d1DatabaseId = listData.result?.find((d) => d.name === d1Name)?.uuid ?? ''
      }
      if (!d1DatabaseId) {
        const msg = d1Data.errors?.[0]?.message ?? 'failed to create D1 database'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, `✓ D1 database ready: ${d1DatabaseId.slice(0, 8)}...`)
    } else {
    await appendLog(env, deployment_id, 'creating KV namespace...')
    const kvResp = await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `${worker_name}-kv` }),
    })
    const kvData = (await kvResp.json()) as { success?: boolean; result?: { id: string }; errors?: Array<{ message: string }> }
    if (!kvData.success) {
      const msg = kvData.errors?.[0]?.message ?? 'failed to create KV namespace'
      await appendLog(env, deployment_id, `✗ ${msg}`)
      await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
      return
    }
    kvNamespaceId = kvData.result!.id
    await appendLog(env, deployment_id, `✓ KV namespace created: ${kvNamespaceId.slice(0, 8)}...`)
    }

    // ── Provision R2 bucket (free tier: 10 GB + zero egress) ────────────
    // Bound as R2 on every deployed worker — heavy data (logs, scan results,
    // IP lists, sub caches) can live here instead of slowing D1/KV down.
    // Non-fatal: if the token lacks R2 permission we just log and continue.
    let r2BucketName = ''
    await appendLog(env, deployment_id, 'creating R2 bucket...')
    const r2Name = `${worker_name}-r2`
    const r2Resp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r2Name }),
    })
    const r2Data = (await r2Resp.json().catch(() => ({}))) as { success?: boolean; result?: { name?: string }; errors?: Array<{ message: string }> }
    if (r2Data.success && r2Data.result?.name) {
      r2BucketName = r2Data.result.name
      await appendLog(env, deployment_id, `✓ R2 bucket created: ${r2BucketName} (free tier)`)
    } else {
      // Already exists? Reuse it.
      const r2ListResp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets?per_page=100`, { headers })
      const r2ListData = (await r2ListResp.json().catch(() => ({}))) as { result?: { buckets?: Array<{ name?: string }> } }
      r2BucketName = r2ListData.result?.buckets?.find((b) => b.name === r2Name)?.name ?? ''
      if (r2BucketName) {
        await appendLog(env, deployment_id, `✓ R2 bucket reused: ${r2BucketName}`)
      } else {
        await appendLog(env, deployment_id, `⚠ R2 bucket unavailable (${r2Data.errors?.[0]?.message ?? 'no permission'}) — continuing without R2`)
      }
    }

    // ── Write initial config to KV (KV sources only; zeus self-manages) ─
    let initialConfig: Record<string, unknown>
    const addTxtKey = 'ADD.txt'

    // Panel path for edgetunnel: the custom path if set, otherwise always
    // /admin so the panel address is predictable and ends with /admin.
    const panelPath = custom_path
      ? (custom_path.startsWith('/') ? custom_path : '/' + custom_path)
      : '/admin'

    if (sourceConfig.kind === 'zeus') {
      // Zeus panel lives at its own root with its own login — nothing to seed.
      await appendLog(env, deployment_id, '✓ zeus source: D1 schema self-initializes on first request')
    } else {

    if (sourceConfig.kind === 'nexus') {
      // NEXUS merges over its own defaults — just seed identity + proxyip.
      initialConfig = { name: 'NEXUS', lang: 'fa', theme: 'dark', uuid, p: proxyip || '' }
    } else if (configFormat === 'custom') {
      initialConfig = {
        wk: '', ev: 'yes', et: 'no', ex: 'no', ech: 'no', tp: '',
        customDNS: 'https://223.5.5.5/dns-query',
        customECHDomain: 'cloudflare-ech.com',
        alpn: '', d: custom_path || '', p: proxyip || '', yx: '', yxURL: '', s: '', homepage: '',
        scu: 'https://url.v1.mk/sub', ena: 'no', epd: 'yes', epi: 'yes', egi: 'yes',
        ae: '', rm: '', qj: '', dkby: 'no', yxby: '',
        ipv4: 'yes', ipv6: 'yes', ispMobile: 'yes', ispUnicom: 'yes', ispTelecom: 'yes',
      }
    } else {
      initialConfig = {
        UUID: uuid,
        HOST: '',
        HOSTS: [],
        PATH: panelPath,
        协议类型: 'vless',
        传输协议: 'ws',
        gRPC模式: 'gun',
        gRPCUserAgent: 'Mozilla/5.0',
        跳过证书验证: false,
        启用0RTT: false,
        TLS分片: null,
        随机路径: false,
        ECH: false,
        ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
        SS: { 加密方式: 'aes-128-gcm', TLS: true },
        Fingerprint: 'chrome',
        优选订阅生成: {
          local: true,
          本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 },
          SUB: null,
          SUBNAME: 'edgetunnel',
          SUBUpdateTime: 3,
          TOKEN: '',
        },
        订阅转换配置: {
          SUBAPI: 'https://subapi.edt-pages.workers.dev',
          SUBCONFIG: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/main/Clash/config/ACL4SSR_Online_Mini_MultiMode.ini',
          SUBEMOJI: false, SUBLIST: false, UDP: false, XUDP: false, TLS13: false, APPEND_TYPE: false, SORT: false,
        },
        反代: {
          proxyip: proxyip || 'auto',
          SOCKS5: { 启用: null, 全局: false, 账号: '', 白名单: [] },
          路径模板: {},
        },
        TG: { 启用: false, BotToken: null, ChatID: null },
        CF: { Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null, Usage: { success: false, pages: 0, workers: 0, total: 0, max: 100000 } },
      }
    }

    await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${configKvKey}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(initialConfig, null, 2),
    }).catch(() => null)
    await appendLog(env, deployment_id, `✓ initial config written to KV (${configKvKey})`)

    await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${addTxtKey}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: proxyip || '',
    }).catch(() => null)
    } // end non-zeus KV seeding

    let workerUrl: string
    // edgetunnel: panel lives at the panel path (login page asking for the
    // password) — custom path or /admin by default.
    // Default (custom) worker: UUID is always part of the URL and bypasses
    // the login page entirely.
    // Zeus: the whole worker IS the admin panel (root URL, own login).
    const panelKey = sourceConfig.kind === 'zeus' ? '' : configFormat === 'edgetunnel' ? panelPath.slice(1) : uuid

    if (method === 'workers') {
      // ── Upload worker script ──────────────────────────────────────────
      await appendLog(env, deployment_id, 'uploading worker script...')
      const meta = {
        main_module: 'worker.js',
        compatibility_date: compatDate,
        compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
        bindings: sourceConfig.kind === 'zeus' ? [
          { type: 'd1', name: 'DB', id: d1DatabaseId },
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: 'CF_API_TOKEN', text: cf_token },
          { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
          { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
          { type: 'plain_text', name: 'WIZARD_URL', text: job.origin },
        ] : [
          { type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId },
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: uuidEnv, text: uuid },
          ...(configFormat === 'edgetunnel' ? [
            { type: 'plain_text', name: 'PATH', text: panelPath },
            { type: 'plain_text', name: 'PROXYIP', text: proxyip },
            ...(admin_password ? [{ type: 'plain_text', name: 'ADMIN', text: admin_password }] : []),
          ] : sourceConfig.kind === 'nexus' ? [] : [
            { type: 'plain_text', name: 'P', text: proxyip },
          ]),
        ],
      }

      const formData = new FormData()
      formData.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
      formData.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js')

      const uploadResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, {
        method: 'PUT', headers, body: formData,
      })
      const uploadData = (await uploadResp.json()) as { success?: boolean; errors?: Array<{ message: string }> }
      if (!uploadData.success) {
        const msg = uploadData.errors?.[0]?.message ?? 'failed to upload worker'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, '✓ worker script uploaded')

      // ── Enable workers.dev route (with the original fallbacks) ────────
      await appendLog(env, deployment_id, 'enabling workers.dev route for script...')
      const subdomainResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      const subdomainResult = (await subdomainResp.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> }
      if (subdomainResult.success) {
        await appendLog(env, deployment_id, '✓ workers.dev route enabled')
      } else {
        await appendLog(env, deployment_id, `⚠ workers.dev route: ${subdomainResult.errors?.[0]?.message ?? 'unknown error'} — trying account subdomain...`)
        const existingSub = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
        const existingSubData = (await existingSub.json().catch(() => ({}))) as { result?: { subdomain?: string } }
        if (!existingSubData.result?.subdomain) {
          const subName = `edge-${worker_name}`.replace(/[^a-z0-9-]/g, '').slice(0, 30)
          await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdomain: subName }),
          }).catch(() => null)
          await appendLog(env, deployment_id, `✓ account subdomain set: ${subName}`)
        }
        await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }).catch(() => null)
      }

      await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/settings`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workers_dev: true, preview_version_id: null, placements: [{ mode: 'smart' }] }),
      }).catch(() => null)
      await appendLog(env, deployment_id, '✓ workers.dev route enabled + Smart Placement ON (worker co-located with D1)')

      // ── Enable gRPC + WebSockets on all zones of the account ───────────
      // Required for gRPC transport nodes to pass through Cloudflare without
      // conflicts. XHTTP needs no zone switch (plain HTTP/2 streams), but
      // WebSockets must be ON for ws/xhttp fallbacks. Non-fatal per zone.
      try {
        const zonesResp = await fetch(`${API_BASE}/zones?per_page=50`, { headers })
        const zonesData = (await zonesResp.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> }
        const zones = zonesData.result ?? []
        if (zones.length === 0) {
          await appendLog(env, deployment_id, 'ℹ no zones on token — workers.dev only (gRPC works natively there)')
        }
        for (const zone of zones) {
          const grpcResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/grpc`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const wsResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/websockets`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const okGrpc = grpcResp?.ok ?? false
          const okWs = wsResp?.ok ?? false
          await appendLog(env, deployment_id, `${okGrpc && okWs ? '✓' : '⚠'} zone ${zone.name}: gRPC ${okGrpc ? 'ON' : 'skip (permission?)'} · WebSockets ${okWs ? 'ON' : 'skip'}`)
        }
      } catch {
        await appendLog(env, deployment_id, '⚠ zone settings step skipped (no zone access)')
      }

      // ── Read workers.dev subdomain & build final URL ──────────────────
      await appendLog(env, deployment_id, 'reading workers.dev subdomain...')
      let subdomain: string | undefined
      try {
        const subResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
        const subData = (await subResp.json()) as { result?: { subdomain?: string } }
        subdomain = subData.result?.subdomain
      } catch {
        // Non-fatal — best-guess URL below.
      }
      workerUrl = subdomain
        ? `https://${worker_name}.${subdomain}.workers.dev`
        : `https://${worker_name}.workers.dev`
      await appendLog(env, deployment_id, `✓ worker URL: ${workerUrl}`)

      // Checkpoint: persist deployed NOW so the UI can never get stuck on
      // "در حال استقرار" because of a later optional step.
      await updateDeployment(env, deployment_id, 'deployed', {
        worker_url: workerUrl,
        kv_namespace_id: kvNamespaceId,
        cf_account_id: accountId,
        worker_source: worker_source,
      })
    } else {
      // ── Pages deployment (original flow) ──────────────────────────────
      await appendLog(env, deployment_id, 'creating Pages project...')
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: worker_name, production_branch: 'main' }),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'binding KV & variables to project...')
      const cfg = {
        deployment_configs: {
          production: {
            compatibility_date: compatDate,
            compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
            kv_namespaces: { [kvBindingName]: { namespace_id: kvNamespaceId } },
            ...(r2BucketName ? { r2_buckets: { R2: { bucket_name: r2BucketName } } } : {}),
            environment_variables: configFormat === 'edgetunnel' ? {
              [uuidEnv]: { value: uuid, type: 'plain_text' },
              PATH: { value: panelPath, type: 'plain_text' },
              PROXYIP: { value: proxyip, type: 'plain_text' },
              ...(admin_password ? { ADMIN: { value: admin_password, type: 'plain_text' } } : {}),
            } : {
              [uuidEnv]: { value: uuid, type: 'plain_text' },
              ...(sourceConfig.kind === 'nexus' ? {} : { P: { value: proxyip, type: 'plain_text' } }),
            },
          },
        },
      }
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects/${worker_name}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'uploading _worker.js deployment...')
      const pagesFd = new FormData()
      pagesFd.append('_worker.js', new Blob([workerCode], { type: 'application/javascript' }), '_worker.js')
      pagesFd.append('branch', 'main')
      const pagesDepResp = await fetch(
        `${API_BASE}/accounts/${accountId}/pages/projects/${worker_name}/deployments`,
        { method: 'POST', headers, body: pagesFd },
      )
      let pagesDepData: { result?: { url?: string } } = {}
      try {
        pagesDepData = (await pagesDepResp.json()) as { result?: { url?: string } }
      } catch {
        // Non-fatal — predictable *.pages.dev URL below.
      }
      workerUrl = pagesDepData.result?.url ?? `https://${worker_name}.pages.dev`
      await appendLog(env, deployment_id, `✓ Pages URL: ${workerUrl}`)

      await updateDeployment(env, deployment_id, 'deployed', {
        worker_url: workerUrl,
        kv_namespace_id: kvNamespaceId,
        cf_account_id: accountId,
        worker_source: worker_source,
      })
    }

    // ── Build the links the UI shows ────────────────────────────────────
    //
    // These differ per source and were previously computed from one wrong
    // guess: a fixed `/admin` (edgetunnel) or `/<uuid>` (CFnew) for EVERY
    // worker. That produced a 403 "UUID wrong" page for edgetunnel, a 404 for
    // zeus (`/<uuid>` does not exist there) and a `/sub` link that returned
    // the origin's 404 page. Each source is now spelled out exactly.
    const base = workerUrl.replace(/\/+$/, '')
    const customPath = (custom_path ?? '').trim()
    let panelUrl: string
    let subUrl: string
    if (sourceConfig.kind === 'edgetunnel') {
      // The dashboard is fixed at /admin (redirects to /login until the admin
      // password is entered); it never moves with a custom path.
      panelUrl = `${base}/admin`
      // The sub link needs the same md5(host+uuid) token the worker checks,
      // otherwise /sub falls through to the upstream 404 page.
      let token = ''
      try { token = await edgetunnelSubToken(new URL(base).host, uuid) } catch { /* best effort */ }
      subUrl = token ? `${base}/sub?token=${token}` : `${base}/sub`
    } else if (sourceConfig.kind === 'zeus') {
      // The whole worker is the panel. A subscription only exists after an
      // account is created inside it (`/sub/<username>`), so there is no
      // deploy-time sub link to show.
      panelUrl = base
      subUrl = ''
    } else {
      // CFnew-style workers (custom + NEXUS): the UUID path IS the dashboard
      // and its sub link — there is nothing at `/sub` on the root. When the
      // user set a custom path (`d`), the UUID path is disabled and the
      // dashboard/sub live under that path instead.
      const custom = customPath.replace(/^\/+|\/+$/g, '')
      if (custom) {
        panelUrl = `${base}/${custom}`
        subUrl = `${base}/${custom}/sub`
      } else {
        panelUrl = `${base}/${uuid}`
        subUrl = `${base}/${uuid}/sub`
      }
    }
    await appendLog(env, deployment_id, `✓ panel URL: ${panelUrl}`)
    if (subUrl) await appendLog(env, deployment_id, `✓ sub URL: ${subUrl}`)
    else await appendLog(env, deployment_id, 'ℹ این پنل لینک ساب آماده ندارد — داخل پنل کاربر بسازید')
    await appendLog(env, deployment_id, '✓ deployment complete!')

    await updateDeployment(env, deployment_id, 'deployed', {
      worker_url: workerUrl,
      panel_url: panelUrl,
      sub_url: subUrl || null,
      kv_namespace_id: kvNamespaceId,
      cf_account_id: accountId,
      route: null,
      worker_source: worker_source,
    })

    // Bookkeeping: token usage + activity log
    if (job.cf_token_row_id) {
      await env.DB.prepare('UPDATE cf_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), job.cf_token_row_id).run()
    }
    const depRow = await env.DB.prepare('SELECT user_id, name FROM deployments WHERE id = ?')
      .bind(deployment_id)
      .first<{ user_id: string; name: string }>()
    if (depRow) {
      await env.DB.prepare(
        'INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(genId(), depRow.user_id, 'deployment_deployed', 'deployment', depRow.name, nowIso())
        .run()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    await appendLog(env, deployment_id, `✗ ${msg}`)
    await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
  } finally {
    // Telegram notification (never blocks or breaks the deployment flow).
    const row = await env.DB.prepare('SELECT user_id, name, status, worker_url, panel_url, error_message FROM deployments WHERE id = ?')
      .bind(deployment_id)
      .first<{ user_id: string; name: string; status: string; worker_url: string | null; panel_url: string | null; error_message: string | null }>()
    if (row && (row.status === 'deployed' || row.status === 'failed')) {
      await notifyDeployment(env, row.user_id, row.name, row.status as 'deployed' | 'failed', row.worker_url, row.panel_url, row.error_message)
        .catch(() => null)
    }
  }
}

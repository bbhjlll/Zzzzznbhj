// Per-worker end users ("اعضا"): each deployed worker can be shared with
// several people, each with a private sub link and unique settings —
// country IP pool, transport, fragment, quota, expiry.

import type { Env } from './env'
import { apiError, genId, json, nowIso, safeJsonParse } from './util'
import { b64encodeUtf8 } from './net'
import { applyInjection, buildClashYaml, type PreferredIP } from './inject'
import { renderSubscription } from './formats'
import { resolvePool } from './countries'
import { fetchCountryIps } from './edtips'
import { findPreset, KNOWN_SNIS, CLIENT_FRAGMENT_PRESETS, CHAIN_PROTOCOLS } from './presets'
import { filterAlive, rotate } from './rotation'
import { fetchSourceNodes, resolveSource } from './sourcebridge'
import { notifyQuotaLevel } from './telegram'

/** Fire a Telegram quota alert only when the member crosses a new level.
 * Levels: 0 none, 1 = 80%, 2 = 90%, 3 = exhausted. Stored in notified_level
 * so each threshold is announced exactly once (reset clears it).
 */
async function maybeNotifyQuota(env: Env, member: Record<string, unknown>, level: 1 | 2 | 3, isRequests = false): Promise<void> {
  try {
    const current = (member.notified_level as number) ?? 0
    if (level <= current) return
    await env.DB.prepare('UPDATE worker_members SET notified_level = ? WHERE id = ?')
      .bind(level, member.id as string).run()
    const dep = await env.DB.prepare('SELECT name FROM deployments WHERE id = ?')
      .bind(member.deployment_id as string).first<{ name: string }>()
    const fmt = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.round(n / 1048576)} MB`
    const detail = isRequests && level === 3 ? 'سقف درخواست‌ها به پایان رسید'
      : `مصرف: ${fmt((member.used_bytes as number) ?? 0)}${member.quota_bytes ? ` از ${fmt(member.quota_bytes as number)}` : ''}`
    void notifyQuotaLevel(env, member.owner_user_id as string, member.name as string, dep?.name ?? 'ورکر', level, detail)
  } catch {
    // alerts must never break sub serving
  }
}

export interface CountryLocationConfig {
  location: string
  proxy: string
}

export interface MemberSettings {
  countries: string[]
  country_locations?: Record<string, CountryLocationConfig[]>
  custom_ips: string[]
  transport: '' | 'ws' | 'grpc' | 'httpupgrade'
  fragment: boolean
  fragment_preset: string
  fragment_config: {
    packets?: string; length?: string; interval?: string
    /** Advanced JSON fragment — passed through verbatim (fm= param). */
    fm?: string
    /** Custom cipher suites — passed through verbatim (cs= param). */
    cs?: string
  }
  /** ClientHello fingerprint (fp= param). */
  fingerprint: string
  /** Custom SNI/Host masking overrides. */
  custom_sni: string
  custom_host: string
  bypass_sanctions: boolean
  /** Anti-sanction strategy: '' = off, 'sni' = permissive SNI mask,
   *  'warp' = route egress through WARP (unlocks Gemini/OpenAI, real UDP). */
  sanctions_mode: '' | 'sni' | 'warp'
  /** Rotate the preferred-IP entry order every N minutes (0 = off). */
  ip_rotation_minutes: number
  // ── edgetunnel per-request URL params (applied to every node link) ──
  /** Per-member ProxyIP override — emitted as `proxyip=` query param. */
  proxyip: string
  /** Chain-proxy egress, e.g. `socks5://user:pass@host:1080` — emitted as
   *  `<proto>=` + `globalproxy` query params the EDT worker understands. */
  chain_proxy: string
  /** TLS Encrypted Client Hello — emitted as `ech=<sni>+<dns>` param. */
  ech: boolean
  ech_sni: string
  ech_dns: string
  /** WebSocket 0-RTT — appends `ed=2560` inside the node path. */
  ed_0rtt: boolean
  /** Randomize the ws path prefix on every sub fetch (anti-DPI). */
  random_path: boolean
  /** Client-specific fragment param: '' | 'shadowrocket' | 'happ'. */
  fragment_client: string
}

export interface MemberRow {
  id: string
  owner_user_id: string
  deployment_id: string
  name: string
  token: string
  enabled: number
  expires_at: string | null
  quota_bytes: number | null
  used_bytes: number
  usage_updated_at: string | null
  settings: string
  created_at: string
}

export const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'randomized', 'unsafe'] as const

const DEFAULT_SETTINGS: MemberSettings = {
  countries: [], country_locations: {}, custom_ips: [], transport: '',
  fragment: false, fragment_preset: '', fragment_config: {},
  fingerprint: '', custom_sni: '', custom_host: '', bypass_sanctions: false,
  sanctions_mode: '',
  ip_rotation_minutes: 0,
  proxyip: '', chain_proxy: '',
  ech: false, ech_sni: 'cloudflare-ech.com', ech_dns: 'https://dns.alidns.com/dns-query',
  ed_0rtt: false, random_path: false, fragment_client: '',
}

function cleanParam(v: unknown, max = 400): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/**
 * Accept a real date only. An unparsable value must never reach the database:
 * a member with `expires_at = 'abc'` compares as expired forever and would be
 * locked out of its own sub link on the first fetch.
 */
function normalizeExpiry(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v == null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false }
  const parsed = Date.parse(v.length === 10 ? `${v}T23:59:59Z` : v)
  if (Number.isNaN(parsed)) return { ok: false }
  return { ok: true, value: new Date(parsed).toISOString() }
}

function sanitizeSettings(s?: Partial<MemberSettings>): MemberSettings {
  const countries = (s?.countries ?? []).filter((c) => /^[a-z]{2}$|^(multi)$/.test(c)).slice(0, 8)
  const customIps = (s?.custom_ips ?? []).filter((ip) => /^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(ip)).slice(0, 20)
  const transport = (['', 'ws', 'grpc', 'httpupgrade'] as const).includes(s?.transport as never) ? (s?.transport ?? '') : ''
  // Sanitize country_locations: keep only valid country codes with valid location arrays
  const countryLocations: Record<string, CountryLocationConfig[]> = {}
  if (s?.country_locations && typeof s.country_locations === 'object') {
    for (const [code, locs] of Object.entries(s.country_locations)) {
      if (/^[a-z]{2}$|^multi$/.test(code) && Array.isArray(locs)) {
        const validLocs = locs
          .filter((l) => l && typeof l === 'object')
          .map((l) => ({
            location: typeof l.location === 'string' ? l.location.trim().slice(0, 100) : '',
            proxy: typeof l.proxy === 'string' ? l.proxy.trim().slice(0, 300) : '',
          }))
          .slice(0, 5)
        if (validLocs.length > 0) countryLocations[code] = validLocs
      }
    }
  }
  return {
    countries,
    country_locations: countryLocations,
    custom_ips: customIps,
    transport: transport as MemberSettings['transport'],
    fragment: !!s?.fragment,
    fragment_preset: typeof s?.fragment_preset === 'string' ? s.fragment_preset.slice(0, 20) : '',
    fragment_config: s?.fragment_config && typeof s.fragment_config === 'object'
      ? {
          // Basic values are length-capped; advanced fm/cs pass through
          // verbatim so exact working configs from Iran survive untouched.
          ...(s.fragment_config.packets ? { packets: String(s.fragment_config.packets).slice(0, 20) } : {}),
          ...(s.fragment_config.length ? { length: String(s.fragment_config.length).slice(0, 20) } : {}),
          ...(s.fragment_config.interval ? { interval: String(s.fragment_config.interval).slice(0, 20) } : {}),
          ...(cleanParam(s.fragment_config.fm) ? { fm: cleanParam(s.fragment_config.fm) } : {}),
          ...(cleanParam(s.fragment_config.cs) ? { cs: cleanParam(s.fragment_config.cs) } : {}),
        }
      : {},
    fingerprint: (FINGERPRINTS as readonly string[]).includes(String(s?.fingerprint)) ? String(s?.fingerprint) : '',
    custom_sni: cleanParam(s?.custom_sni, 200),
    custom_host: cleanParam(s?.custom_host, 200),
    bypass_sanctions: !!s?.bypass_sanctions,
    sanctions_mode: (['', 'sni', 'warp'] as const).includes(s?.sanctions_mode as never)
      ? (s?.sanctions_mode ?? '') as MemberSettings['sanctions_mode']
      : (s?.bypass_sanctions ? 'sni' : ''),
    ip_rotation_minutes: Math.min(1440, Math.max(0, Math.round(Number(s?.ip_rotation_minutes) || 0))),
    proxyip: cleanParam(s?.proxyip, 200),
    chain_proxy: /^(socks5|http|https|turn|sstp):\/\/[^\s]+$/.test(String(s?.chain_proxy ?? '').trim())
      ? String(s?.chain_proxy).trim().slice(0, 300) : '',
    ech: !!s?.ech,
    ech_sni: cleanParam(s?.ech_sni, 120) || 'cloudflare-ech.com',
    ech_dns: cleanParam(s?.ech_dns, 200) || 'https://dns.alidns.com/dns-query',
    ed_0rtt: !!s?.ed_0rtt,
    random_path: !!s?.random_path,
    fragment_client: CLIENT_FRAGMENT_PRESETS.some((p) => p.code === s?.fragment_client) ? String(s?.fragment_client) : '',
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

interface MemberBody extends Partial<MemberSettings> {
  name?: string
  deployment_id?: string
  enabled?: boolean
  expires_at?: string | null
  quota_gb?: number | null
  request_quota?: number | null
  ip_limit?: number | null
  start_on_connect?: boolean
  reset_period_days?: number | null
  country_locations?: Record<string, CountryLocationConfig[]>
}

export async function handleMemberCreate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<MemberBody>(await request.text().catch(() => ''), {})
  if (!body.deployment_id) return apiError('deployment_id الزامی است')
  const dep = await env.DB.prepare(
    `SELECT id, name FROM deployments WHERE id = ? AND user_id = ?`,
  ).bind(body.deployment_id, userId).first<{ id: string; name: string }>()
  if (!dep) return apiError('ورکر پیدا نشد', 404)

  const expiry = normalizeExpiry(body.expires_at)
  if (!expiry.ok) return apiError('تاریخ انقضا نامعتبر است')
  const already = await countMembers(env, userId, dep.id)
  if (already >= MAX_MEMBERS_PER_WORKER) {
    return apiError(`سقف ${MAX_MEMBERS_PER_WORKER} کاربر برای این ورکر پر شده است`)
  }

  const created = await insertMember(env, {
    userId, deploymentId: dep.id,
    name: body.name?.trim() || `کاربر ${dep.name}`,
    settings: sanitizeSettings(body),
    expiresAt: expiry.value,
    ...memberQuotas(body),
    startOnConnect: !!body.start_on_connect,
  })
  return json({ data: created }, 201)
}

/** Ceiling that keeps one worker shareable at scale while stopping a single
 *  account from filling the database. */
const MAX_MEMBERS_PER_WORKER = 500

async function countMembers(env: Env, userId: string, deploymentId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM worker_members WHERE owner_user_id = ? AND deployment_id = ?',
  ).bind(userId, deploymentId).first<{ c: number }>()
  return row?.c ?? 0
}

/** Normalise the optional quotas shared by every create path. */
function memberQuotas(body: MemberBody) {
  return {
    quotaBytes: body.quota_gb == null || body.quota_gb <= 0 ? null : Math.round(body.quota_gb * 1024 ** 3),
    reqQuota: body.request_quota == null || body.request_quota <= 0 ? null : Math.round(body.request_quota),
    ipLimit: body.ip_limit == null || body.ip_limit <= 0 ? null : Math.round(body.ip_limit),
    resetDays: body.reset_period_days == null || body.reset_period_days <= 0 ? null : Math.round(body.reset_period_days),
  }
}

interface InsertMemberInput {
  userId: string
  deploymentId: string
  name: string
  settings: MemberSettings
  expiresAt: string | null
  quotaBytes: number | null
  reqQuota: number | null
  ipLimit: number | null
  resetDays: number | null
  startOnConnect: boolean
}

/** Insert one member row and return its id + private sub token. */
async function insertMember(env: Env, input: InsertMemberInput): Promise<{ id: string; token: string }> {
  const id = genId()
  const token = genId().replace(/-/g, '')
  await env.DB.prepare(
    `INSERT INTO worker_members (id, owner_user_id, deployment_id, name, token, enabled, expires_at, quota_bytes, request_quota, ip_limit, used_bytes, used_requests, recent_ips, start_on_connect, reset_period_days, settings, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0, '[]', ?, ?, ?, ?)`,
  ).bind(
    id, input.userId, input.deploymentId, input.name, token,
    input.expiresAt, input.quotaBytes, input.reqQuota, input.ipLimit,
    input.startOnConnect ? 1 : 0, input.resetDays, JSON.stringify(input.settings), nowIso(),
  ).run()
  return { id, token }
}

/** POST /api/members/create-many — create several members in one call. */
export async function handleMemberCreateMany(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<MemberBody & { count?: number; name_prefix?: string }>(
    await request.text().catch(() => ''), {},
  )
  if (!body.deployment_id) return apiError('deployment_id الزامی است')
  const dep = await env.DB.prepare(
    'SELECT id, name FROM deployments WHERE id = ? AND user_id = ?',
  ).bind(body.deployment_id, userId).first<{ id: string; name: string }>()
  if (!dep) return apiError('ورکر پیدا نشد', 404)

  const count = Math.min(Math.max(Math.round(Number(body.count) || 0), 1), 100)
  const expiry = normalizeExpiry(body.expires_at)
  if (!expiry.ok) return apiError('تاریخ انقضا نامعتبر است')
  const already = await countMembers(env, userId, dep.id)
  if (already + count > MAX_MEMBERS_PER_WORKER) {
    return apiError(`با این تعداد از سقف ${MAX_MEMBERS_PER_WORKER} کاربر برای هر ورکر عبور می‌کنید (الان ${already} کاربر)`)
  }

  const settings = sanitizeSettings(body)
  const quotas = memberQuotas(body)
  const prefix = (body.name_prefix?.trim() || dep.name).slice(0, 40)
  const startOnConnect = !!body.start_on_connect
  const created: Array<{ id: string; token: string; name: string }> = []
  for (let i = 1; i <= count; i++) {
    const name = `${prefix} ${i}`
    const row = await insertMember(env, {
      userId, deploymentId: dep.id, name, settings,
      expiresAt: expiry.value, ...quotas, startOnConnect,
    })
    created.push({ ...row, name })
  }
  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), userId, 'members_created', 'member', `${count} × ${dep.name}`, nowIso())
    .run()
  return json({ data: created }, 201)
}

export async function handleMemberList(env: Env, userId: string, deploymentId: string | null): Promise<Response> {
  const rows = deploymentId
    ? await env.DB.prepare('SELECT * FROM worker_members WHERE owner_user_id = ? AND deployment_id = ? ORDER BY created_at DESC').bind(userId, deploymentId).all()
    : await env.DB.prepare('SELECT * FROM worker_members WHERE owner_user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return json({ data: rows.results.map(serializeMember) })
}

function serializeMember(row: Record<string, unknown>) {
  const settings = safeJsonParse<MemberSettings>(row.settings as string, DEFAULT_SETTINGS)
  return {
    ...row,
    settings,
    enabled: !!row.enabled,
    used_gb: Number((((row.used_bytes as number) ?? 0) / 1024 ** 3).toFixed(3)),
    quota_gb: row.quota_bytes ? Number((row.quota_bytes as number / 1024 ** 3).toFixed(2)) : null,
    used_requests: (row.used_requests as number) ?? 0,
    request_quota: row.request_quota ?? null,
    ip_limit: row.ip_limit ?? null,
    active_devices: safeJsonParse<{ ip: string }[]>(row.recent_ips as string ?? '[]', []).length,
    start_on_connect: !!row.start_on_connect,
    activated_at: row.activated_at ?? null,
    reset_period_days: row.reset_period_days ?? null,
    last_reset_at: row.last_reset_at ?? null,
  }
}

export async function handleMemberPatch(env: Env, userId: string, id: string, request: Request): Promise<Response> {
  const body = safeJsonParse<MemberBody>(await request.text().catch(() => ''), {})
  const existing = await env.DB.prepare('SELECT * FROM worker_members WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId).first<Record<string, unknown>>()
  if (!existing) return apiError('عضو پیدا نشد', 404)

  const prevSettings = safeJsonParse<MemberSettings>(existing.settings as string, DEFAULT_SETTINGS)
  const settings = sanitizeSettings({
    countries: body.countries ?? prevSettings.countries,
    custom_ips: body.custom_ips ?? prevSettings.custom_ips,
    transport: body.transport ?? prevSettings.transport,
    fragment: body.fragment ?? prevSettings.fragment,
    fragment_preset: body.fragment_preset !== undefined ? body.fragment_preset : prevSettings.fragment_preset,
    fragment_config: body.fragment_config ?? prevSettings.fragment_config,
    fingerprint: body.fingerprint !== undefined ? body.fingerprint : prevSettings.fingerprint,
    custom_sni: body.custom_sni !== undefined ? body.custom_sni : prevSettings.custom_sni,
    custom_host: body.custom_host !== undefined ? body.custom_host : prevSettings.custom_host,
    country_locations: body.country_locations ?? prevSettings.country_locations,
    bypass_sanctions: body.bypass_sanctions ?? prevSettings.bypass_sanctions,
    sanctions_mode: body.sanctions_mode !== undefined ? body.sanctions_mode : prevSettings.sanctions_mode,
    proxyip: body.proxyip !== undefined ? body.proxyip : prevSettings.proxyip,
    chain_proxy: body.chain_proxy !== undefined ? body.chain_proxy : prevSettings.chain_proxy,
    ech: body.ech ?? prevSettings.ech,
    ech_sni: body.ech_sni !== undefined ? body.ech_sni : prevSettings.ech_sni,
    ech_dns: body.ech_dns !== undefined ? body.ech_dns : prevSettings.ech_dns,
    ed_0rtt: body.ed_0rtt ?? prevSettings.ed_0rtt,
    random_path: body.random_path ?? prevSettings.random_path,
    fragment_client: body.fragment_client !== undefined ? body.fragment_client : prevSettings.fragment_client,
    ip_rotation_minutes: body.ip_rotation_minutes !== undefined ? body.ip_rotation_minutes : prevSettings.ip_rotation_minutes,
  })
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (existing.enabled as number)
  const expiry = body.expires_at !== undefined
    ? normalizeExpiry(body.expires_at)
    : { ok: true as const, value: existing.expires_at as string | null }
  if (!expiry.ok) return apiError('تاریخ انقضا نامعتبر است')
  const expiresAt = expiry.value
  const quotaBytes = body.quota_gb !== undefined
    ? (body.quota_gb == null || body.quota_gb <= 0 ? null : Math.round(body.quota_gb * 1024 ** 3))
    : (existing.quota_bytes as number | null)
  const reqQuota = body.request_quota !== undefined
    ? (body.request_quota == null || body.request_quota <= 0 ? null : Math.round(body.request_quota))
    : (existing.request_quota as number | null)
  const ipLimit = body.ip_limit !== undefined
    ? (body.ip_limit == null || body.ip_limit <= 0 ? null : Math.round(body.ip_limit))
    : (existing.ip_limit as number | null)
  const resetDays = body.reset_period_days !== undefined
    ? (body.reset_period_days == null || body.reset_period_days <= 0 ? null : Math.round(body.reset_period_days))
    : (existing.reset_period_days as number | null)
  const startOnConnect = body.start_on_connect !== undefined ? (body.start_on_connect ? 1 : 0) : (existing.start_on_connect as number)

  await env.DB.prepare(
    'UPDATE worker_members SET settings = ?, enabled = ?, expires_at = ?, quota_bytes = ?, request_quota = ?, ip_limit = ?, reset_period_days = ?, start_on_connect = ? WHERE id = ?',
  ).bind(JSON.stringify(settings), enabled, expiresAt, quotaBytes, reqQuota, ipLimit, resetDays, startOnConnect, id).run()
  return json({ data: { id } })
}

/** POST /api/members/bulk — batch actions on the owner's members. */
export async function handleMemberBulk(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ ids?: string[]; action?: string }>(await request.text().catch(() => ''), {})
  const ids = (body.ids ?? []).filter((i) => typeof i === 'string').slice(0, 200)
  if (!ids.length) return apiError('حداقل یک عضو انتخاب کنید')
  const ph = ids.map(() => '?').join(',')

  switch (body.action) {
    case 'enable':
      await env.DB.prepare(`UPDATE worker_members SET enabled = 1 WHERE owner_user_id = ? AND id IN (${ph})`).bind(userId, ...ids).run()
      break
    case 'disable':
      await env.DB.prepare(`UPDATE worker_members SET enabled = 0 WHERE owner_user_id = ? AND id IN (${ph})`).bind(userId, ...ids).run()
      break
    case 'delete':
      await env.DB.prepare(`DELETE FROM worker_members WHERE owner_user_id = ? AND id IN (${ph})`).bind(userId, ...ids).run()
      break
    case 'reset_quota':
      await env.DB.prepare(
        `UPDATE worker_members SET used_bytes = 0, used_requests = 0, recent_ips = '[]', notified_level = 0, last_reset_at = ? WHERE owner_user_id = ? AND id IN (${ph})`,
      ).bind(nowIso(), userId, ...ids).run()
      break
    case 'reset_time':
      await env.DB.prepare(
        `UPDATE worker_members SET activated_at = NULL WHERE owner_user_id = ? AND id IN (${ph})`,
      ).bind(userId, ...ids).run()
      break
    default:
      return apiError('action نامعتبر است')
  }
  return json({ success: true, affected: ids.length, action: body.action })
}

export async function handleMemberDelete(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM worker_members WHERE id = ? AND owner_user_id = ? RETURNING name')
    .bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('عضو پیدا نشد', 404)
  return json({ success: true })
}

// ── Usage via Cloudflare GraphQL analytics ─────────────────────────────────

const USAGE_QUERY = `query ($account: String!, $from: Time!, $worker: String!) {
  viewer { accounts(filter: { accountTag: $account }) {
    httpRequests1dGroups(limit: 32, filter: { date_geq: $from, scriptName: $worker }) {
      sum { bytes requests }
    }
  } }
}`

async function getDeployCf(env: Env, deploymentId: string, userId: string) {
  const dep = await env.DB.prepare(
    'SELECT id, name, cf_account_id, cf_token_row_id FROM deployments WHERE id = ? AND user_id = ?',
  ).bind(deploymentId, userId).first<{ id: string; name: string; cf_account_id: string | null; cf_token_row_id: string | null }>()
  if (!dep) return null
  const tokenRow = dep.cf_token_row_id
    ? await env.DB.prepare('SELECT token FROM cf_tokens WHERE id = ? AND user_id = ?').bind(dep.cf_token_row_id, userId).first<{ token: string }>()
    : await env.DB.prepare('SELECT token FROM cf_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(userId).first<{ token: string }>()
  if (!dep.cf_account_id || !tokenRow) return null
  return { accountId: dep.cf_account_id, workerName: dep.name, token: tokenRow.token }
}

/** Sum this month's edge bytes for the member's worker and store it. */
export async function refreshMemberUsage(env: Env, userId: string, id: string): Promise<Response> {
  const member = await env.DB.prepare('SELECT deployment_id FROM worker_members WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId).first<{ deployment_id: string }>()
  if (!member) return apiError('عضو پیدا نشد', 404)
  const cf = await getDeployCf(env, member.deployment_id, userId)
  if (!cf) return apiError('توکن یا account_id ورکر در دسترس نیست', 400)

  const from = new Date(Date.now() - 31 * 86400_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { account: cf.accountId, from, worker: cf.workerName } }),
  })
  const body = safeJsonParse<{ data?: { viewer?: { accounts?: { httpRequests1dGroups?: { sum?: { bytes?: number; requests?: number } }[] }[] } }; errors?: { message: string }[] }>(await resp.text().catch(() => ''), {})
  if (!resp.ok || body.errors?.length) {
    return apiError(`خواندن آمار کلودفلر ناموفق بود: ${body.errors?.[0]?.message ?? resp.status}`)
  }
  const groups = body.data?.viewer?.accounts?.[0]?.httpRequests1dGroups ?? []
  const bytes = groups.reduce((sum, g) => sum + (g.sum?.bytes ?? 0), 0)
  const requests = groups.reduce((sum, g) => sum + (g.sum?.requests ?? 0), 0)
  await env.DB.prepare('UPDATE worker_members SET used_bytes = ?, used_requests = ?, usage_updated_at = ? WHERE id = ?')
    .bind(bytes, requests, nowIso(), id).run()
  return json({ data: { used_bytes: bytes, used_requests: requests, used_gb: Number((bytes / 1024 ** 3).toFixed(3)) } })
}

// ── Cloudflare 100k daily-request monitor ──────────────────────────────────

const TODAY_QUERY = `query ($account: String!, $day: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    httpRequests1dGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) {
      sum { requests }
    }
  } }
}`

/** GET /api/cf-quota — total requests across all workers today vs the 100k free limit. */
export async function handleCfQuota(env: Env, userId: string): Promise<Response> {
  const tok = await env.DB.prepare(
    `SELECT token FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId).first<{ token: string }>()
  const dep = await env.DB.prepare(
    'SELECT cf_account_id FROM deployments WHERE user_id = ? AND cf_account_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
  ).bind(userId).first<{ cf_account_id: string | null }>()
  if (!tok?.token || !dep?.cf_account_id) return apiError('توکن فعال یا اکانت متصل یافت نشد', 400)

  const day = new Date().toISOString().slice(0, 10)
  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: TODAY_QUERY, variables: { account: dep.cf_account_id, day } }),
  })
  const body = safeJsonParse<{ data?: { viewer?: { accounts?: { httpRequests1dGroups?: { sum?: { requests?: number } }[] }[] } }; errors?: { message: string }[] }>(await resp.text().catch(() => ''), {})
  if (!resp.ok || body.errors?.length) {
    return apiError(`خواندن آمار کلودفلر ناموفق بود: ${body.errors?.[0]?.message ?? resp.status}`)
  }
  const usedToday = body.data?.viewer?.accounts?.[0]?.httpRequests1dGroups?.[0]?.sum?.requests ?? 0
  return json({ data: { used_today: usedToday, limit: 100_000, day } })
}


// ── Personalized sub serving ────────────────────────────────────────────────

/** Rewrite or insert a single URI query param in a node link (before the #-name). */
function setQueryParam(line: string, key: string, value: string): string {
  const hashIdx = line.indexOf('#')
  const main = hashIdx === -1 ? line : line.slice(0, hashIdx)
  const suffix = hashIdx === -1 ? '' : line.slice(hashIdx)
  const qIdx = main.indexOf('?')
  if (qIdx === -1) return `${main}?${key}=${encodeURIComponent(value)}${suffix}`
  const base = main.slice(0, qIdx)
  const parts = main.slice(qIdx + 1).split('&').filter((p) => p && !p.startsWith(`${key}=`))
  parts.push(`${key}=${encodeURIComponent(value)}`)
  return `${base}?${parts.join('&')}${suffix}`
}

/** Read a single URI query param from a node link (before the #-name). */
function getQueryParam(line: string, key: string): string {
  const hashIdx = line.indexOf('#')
  const qIdx = line.indexOf('?')
  const queryEnd = hashIdx > -1 ? hashIdx : line.length
  if (qIdx === -1) return ''
  return new URLSearchParams(line.slice(qIdx + 1, queryEnd)).get(key) ?? ''
}

/** Parse a vmess base64-JSON link into its object (or null). */
function parseVmess(line: string): Record<string, unknown> | null {
  if (!line.startsWith('vmess://')) return null
  try {
    const json = JSON.parse(atob(line.slice('vmess://'.length))) as Record<string, unknown>
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

/** Effective transport of a node ('ws' | 'grpc' | 'httpupgrade' | …). */
function nodeTransport(line: string): string {
  const vm = parseVmess(line)
  if (vm) return String(vm.net ?? '')
  return getQueryParam(line, 'type')
}

/** True when the node negotiates TLS — the only kind fragment/SNI/ECH/
 *  fingerprint tricks apply to (applying them elsewhere silently breaks links). */
function isTlsNode(line: string): boolean {
  const vm = parseVmess(line)
  if (vm) return String(vm.tls ?? '') === 'tls'
  if (!/^(vless|trojan|hysteria2?):\/\//.test(line)) return false // plain ss/socks
  const security = getQueryParam(line, 'security').toLowerCase()
  if (security === 'tls' || security === 'reality') return true
  if (security === 'none') return false
  // No explicit security param: treat :443 endpoints as TLS (edgetunnel default).
  const m = line.match(/@[^:/?#]+:(\d+)/)
  return m?.[1] === '443'
}

/** Rewrite the transport (`type=`) of vless/vmess/trojan nodes. Unlike a plain
 *  regex swap this also works when the link has NO type param yet, and handles
 *  vmess base64-JSON links. */
function rewriteTransport(line: string, transport: MemberSettings['transport']): string {
  if (!transport) return line
  const vm = parseVmess(line)
  if (vm) {
    vm.net = transport
    return 'vmess://' + btoa(JSON.stringify(vm))
  }
  if (!/^(vless|trojan):\/\//.test(line)) return line
  return setQueryParam(line, 'type', transport)
}

/** Append fragment params (xray-style) for clients that support them. */
function addFragmentParams(line: string, fc: MemberSettings['fragment_config']): string {
  const parts: string[] = []
  if (fc.packets) parts.push(`packets=${fc.packets}`)
  if (fc.length) parts.push(`length=${fc.length}`)
  if (fc.interval) parts.push(`interval=${fc.interval}`)
  if (!parts.length) return line
  return setQueryParam(line, 'fragment', parts.join(','))
}

/** Rewrite the ws path of a node to edgetunnel's WARP-chaining path
 *  (`/warp?ed=2560`) so the worker's egress goes through Cloudflare WARP —
 *  unlocks Gemini/OpenAI/sanctioned sites and gives real UDP egress.
 *  Handles both vmess base64 JSON and vless/trojan URI params. */
function applyWarpPath(line: string): string {
  const vm = parseVmess(line)
  if (vm) {
    if (String(vm.net ?? '') === 'ws') vm.path = '/warp?ed=2560'
    return 'vmess://' + btoa(JSON.stringify(vm))
  }
  return setQueryParam(line, 'path', '/warp?ed=2560')
}

/** Map the node's path value through `fn` (vmess JSON or URI param aware). */
function mapPathParam(line: string, fn: (p: string) => string): string {
  if (line.startsWith('vmess://')) {
    try {
      const json = JSON.parse(atob(line.slice('vmess://'.length))) as Record<string, unknown>
      if (String(json.net ?? '') === 'ws') json.path = fn(String(json.path ?? '/'))
      return 'vmess://' + btoa(JSON.stringify(json))
    } catch {
      return line
    }
  }
  const hashIdx = line.indexOf('#')
  const qIdx = line.indexOf('?')
  const queryEnd = hashIdx > -1 ? hashIdx : line.length
  if (qIdx === -1) return line
  const params = new URLSearchParams(line.slice(qIdx + 1, queryEnd))
  params.set('path', fn(params.get('path') ?? '/'))
  return line.slice(0, qIdx + 1) + params.toString() + (hashIdx > -1 ? line.slice(hashIdx) : '')
}

/** Common web directories for random-path obfuscation (edgetunnel-style). */
const RANDOM_DIRS = ['about', 'api', 'app', 'blog', 'cdn', 'chat', 'docs', 'download', 'forum', 'help', 'img', 'live', 'news', 'shop', 'static', 'video', 'watch', 'web']

function randomPathPrefix(): string {
  const count = 1 + Math.floor(Math.random() * 3)
  const parts: string[] = []
  for (let i = 0; i < count; i++) parts.push(RANDOM_DIRS[Math.floor(Math.random() * RANDOM_DIRS.length)]!)
  return '/' + parts.join('/')
}

// ── Shared member-settings resolution + safe transform pipeline ────────────

/** Merge stored JSON settings with defaults and ISP-preset overrides.
 *  Used identically by sub serving and the live test endpoint. */
function resolveMemberSettings(rawJson: string | null | undefined): MemberSettings {
  const parsed = safeJsonParse<Partial<MemberSettings>>(rawJson ?? '', {})
  const settings: MemberSettings = { ...DEFAULT_SETTINGS, ...parsed }
  if (settings.fragment && Object.keys(settings.fragment_config).length === 0) {
    settings.fragment_config = { packets: 'tlshello', length: '100-200', interval: '10-20' }
  }
  // ISP preset wins over manual fragment values when chosen.
  if (settings.fragment && settings.fragment_preset) {
    const preset = findPreset(settings.fragment_preset)
    if (preset) {
      settings.fragment_config = {
        ...preset.config,
        ...(settings.fragment_config.fm ? { fm: settings.fragment_config.fm } : {}),
        ...(settings.fragment_config.cs ? { cs: settings.fragment_config.cs } : {}),
      }
    }
  }
  return settings
}

export interface MemberTransformResult {
  lines: string[]
  /** Persian explanations for settings that could NOT be applied — shown in
   *  the panel so beginners understand why a combination does nothing. */
  warnings: string[]
  tls_total: number
  ws_total: number
}

/** Apply every member setting to the base node list — but ONLY where each
 *  trick is technically valid: TLS-level tricks (fragment/SNI/ECH/fingerprint)
 *  go onto TLS nodes, path-level tricks (WARP/random-path/0-RTT/host-mask)
 *  go onto WebSocket nodes. Invalid combinations are SKIPPED instead of
 *  producing dead links, and surfaced as warnings for the UI. */
function transformMemberNodes(base: string[], s: MemberSettings): MemberTransformResult {
  const warnings: string[] = []
  let out = base

  const tlsTotal = out.filter((l) => isTlsNode(l)).length
  const wsTotal = out.filter((l) => nodeTransport(l) === 'ws').length
  const needsTls = !!s.custom_sni || !!s.fingerprint || !!s.ech || !!s.fragment
  const needsWs = s.sanctions_mode === 'warp' || s.ed_0rtt || s.random_path || !!s.custom_host

  const applyTls = (fn: (l: string) => string) => { out = out.map((l) => (isTlsNode(l) ? fn(l) : l)) }
  const applyWs = (fn: (l: string) => string) => { out = out.map((l) => (nodeTransport(l) === 'ws' ? fn(l) : l)) }

  // ── transport rewrite (vless/vmess/trojan only) ──
  if (s.transport) {
    const before = [...out]
    out = out.map((l) => rewriteTransport(l, s.transport))
    if (!before.some((l, i) => l !== out[i])) {
      warnings.push(`ترنسپورت «${s.transport}» روی هیچ نودی اعمال نشد — سورس شما احتمالاً فقط نوع دیگری ارائه می‌دهد.`)
    }
  }

  // ── sanctions bypass ──
  const sanctionsMode = s.sanctions_mode || (s.bypass_sanctions ? 'sni' : '')
  if (sanctionsMode === 'warp') {
    applyWs(applyWarpPath)
    if (!s.custom_sni) applyTls((l) => setQueryParam(l, 'sni', KNOWN_SNIS[0]!))
  } else if (sanctionsMode === 'sni' && !s.custom_sni) {
    applyTls((l) => setQueryParam(l, 'sni', KNOWN_SNIS[0]!))
  }

  // ── TLS-level overrides (never touch plain-http/ss nodes) ──
  if (s.custom_sni) applyTls((l) => setQueryParam(l, 'sni', s.custom_sni))
  if (s.custom_host) applyWs((l) => setQueryParam(l, 'host', s.custom_host))
  if (s.fingerprint) applyTls((l) => setQueryParam(l, 'fp', s.fingerprint))
  if (s.fragment) {
    applyTls((l) => addFragmentParams(l, s.fragment_config))
    if (s.fragment_config.fm) applyTls((l) => setQueryParam(l, 'fm', s.fragment_config.fm!))
    if (s.fragment_config.cs) applyTls((l) => setQueryParam(l, 'cs', s.fragment_config.cs!))
  }
  if (s.fragment_client) {
    const cf = CLIENT_FRAGMENT_PRESETS.find((p) => p.code === s.fragment_client)
    if (cf) applyTls((l) => setQueryParam(l, 'fragment', cf.value))
  }
  if (s.ech) applyTls((l) => setQueryParam(l, 'ech', `${s.ech_sni}+${s.ech_dns}`))

  // ── edgetunnel per-request params (worker reads these off any node link) ──
  if (s.proxyip) out = out.map((l) => setQueryParam(l, 'proxyip', s.proxyip))
  if (s.chain_proxy) {
    const proto = s.chain_proxy.match(/^(socks5|http|https|turn|sstp):\/\//i)?.[1]?.toLowerCase() ?? 'socks5'
    const cred = s.chain_proxy.replace(/^[a-z0-9]+:\/\//i, '')
    out = out.map((l) => setQueryParam(setQueryParam(l, proto, cred), 'globalproxy', '1'))
  }
  if (s.random_path) applyWs((l) => mapPathParam(l, (p) => randomPathPrefix() + (p === '/' ? '' : p.startsWith('/') ? p : '/' + p)))
  if (s.ed_0rtt) applyWs((l) => mapPathParam(l, (p) => p + (p.includes('?') ? '&' : '?') + 'ed=2560'))

  if (needsTls && tlsTotal === 0) {
    warnings.push('هیچ نود TLS در سورس یافت نشد — فرگمنت/SNI/ECH/اثرانگشت بی‌اثر ماندند.')
  }
  if (needsWs && wsTotal === 0) {
    warnings.push('هیچ نود WebSocket در سورس یافت نشد — WARP/Host سفارشی/0-RTT/مسیر تصادفی بی‌اثر ماندند.')
  }

  return { lines: out, warnings, tls_total: tlsTotal, ws_total: wsTotal }
}

/** Public endpoint — GET /api/sub/member/:token[?target=clash] */
export async function serveMemberSub(env: Env, token: string, target: string | null, request?: Request): Promise<Response> {
  const member = await env.DB.prepare('SELECT * FROM worker_members WHERE token = ?').bind(token)
    .first<Record<string, unknown>>()
  if (!member) return new Response('یافت نشد', { status: 404 })
  if (!member.enabled) return new Response('این اشتراک غیرفعال شده است. با مدیر خود تماس بگیرید.', { status: 403 })

  // ── Start-on-first-connect: activate on first successful fetch ────────
  let activatedAt = member.activated_at as string | null
  const startOnConnect = !!member.start_on_connect
  if (startOnConnect && !activatedAt) {
    activatedAt = nowIso()
    await env.DB.prepare('UPDATE worker_members SET activated_at = ? WHERE id = ?').bind(activatedAt, member.id as string).run()
  }

  // ── Expiry — counted from first connection when start-on-connect is on
  let effectiveExpiry = member.expires_at as string | null
  if (effectiveExpiry && startOnConnect && activatedAt) {
    const span = new Date(effectiveExpiry).getTime() - new Date(member.created_at as string).getTime()
    if (span > 0) {
      effectiveExpiry = new Date(new Date(activatedAt).getTime() + span).toISOString()
    }
  }
  if (effectiveExpiry && effectiveExpiry < nowIso()) {
    return new Response('این اشتراک منقضی شده است. با مدیر خود تماس بگیرید.', { status: 403 })
  }

  // ── Scheduled automatic quota/volume reset ───────────────────────────
  const resetDays = member.reset_period_days as number | null
  if (resetDays && resetDays > 0) {
    const anchor = new Date((member.last_reset_at as string | null) ?? (member.created_at as string)).getTime()
    if (Date.now() - anchor >= resetDays * 86_400_000) {
      await env.DB.prepare(
        'UPDATE worker_members SET used_bytes = 0, used_requests = 0, recent_ips = \'[]\', notified_level = 0, last_reset_at = ? WHERE id = ?',
      ).bind(nowIso(), member.id as string).run()
      member.used_bytes = 0
      member.used_requests = 0
      member.recent_ips = '[]'
    }
  }
  const quota = member.quota_bytes as number | null
  if (quota && (member.used_bytes as number) >= quota) {
    await maybeNotifyQuota(env, member, 3)
    return new Response('حجم اشتراک شما به پایان رسیده است. با مدیر خود تماس بگیرید.', { status: 402 })
  }
  const reqQuota = member.request_quota as number | null
  if (reqQuota && ((member.used_requests as number) ?? 0) >= reqQuota) {
    await maybeNotifyQuota(env, member, 3, true)
    return new Response('سقف تعداد درخواست‌های شما به پایان رسیده است. با مدیر خود تماس بگیرید.', { status: 402 })
  }

  // ── Quota-usage alerts (80% / 90%) — fire once per threshold ─────────
  const byteRatio = quota ? (member.used_bytes as number) / quota : 0
  const reqRatio = reqQuota ? ((member.used_requests as number) ?? 0) / reqQuota : 0
  const ratio = Math.max(byteRatio, reqRatio)
  if (ratio >= 0.9) await maybeNotifyQuota(env, member, 2)
  else if (ratio >= 0.8) await maybeNotifyQuota(env, member, 1)

  const ctx = await resolveSource(env, member.owner_user_id as string, member.deployment_id as string)
  if (!ctx) return new Response('ورکر در دسترس نیست (اتصال واقعی به سورس برقرار نشد)', { status: 502 })

  const { lines } = await fetchSourceNodes(ctx)
  if (!lines.length) return new Response('کانفیگی از ورکر دریافت نشد', { status: 502 })

  const settings = resolveMemberSettings(member.settings as string)

  // ── Concurrent-device (IP) limit, enforced on sub fetch ──────────────
  const ipLimit = member.ip_limit as number | null
  if (ipLimit && ipLimit > 0 && request) {
    const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown'
    const now = Date.now()
    const DAY = 86_400_000
    const recent = safeJsonParse<{ ip: string; ts: number }[]>(member.recent_ips as string ?? '[]', [])
      .filter((r) => now - r.ts < DAY)
    if (!recent.some((r) => r.ip === clientIp)) {
      if (recent.length >= ipLimit) {
        return new Response(`تعداد دستگاه‌های مجاز شما (${ipLimit}) تکمیل است. با مدیر خود تماس بگیرید.`, { status: 403 })
      }
      recent.push({ ip: clientIp, ts: now })
    } else {
      for (const r of recent) if (r.ip === clientIp) r.ts = now
    }
    await env.DB.prepare('UPDATE worker_members SET recent_ips = ? WHERE id = ?')
      .bind(JSON.stringify(recent), member.id as string).run()
  }

  // Base node per line (dedupe by identity, keep first).
  const seen = new Set<string>()
  const base: string[] = []
  for (const line of lines) {
    const identity = line.replace(/#.*$/, '')
    if (!seen.has(identity)) { seen.add(identity); base.push(line) }
  }

  const namePrefix = String(member.name ?? '')
  const transformed = transformMemberNodes(base, settings)
  let out = transformed.lines

  // Preferred-IP pool: LIVE real IPs per country from the EDT ecosystem
  // (ipdb bestcf/bestproxy), with the static CIDR pools as offline fallback.
  // Custom IPs always win. Optional rotation + live health-checked fallback.
  let poolRaw: { ip: string }[] = []
  if (settings.countries.length) {
    try {
      const live = await fetchCountryIps(settings.countries, 4)
      if (live.length) poolRaw = live.map((entry) => {
        const [ip, port] = entry.split(':')
        return port ? { ip: ip!, port: Number(port) } : { ip: ip! }
      })
    } catch { /* live source down → static pools */ }
  }
  if (!poolRaw.length) poolRaw = resolvePool(settings.countries, []).map((p) => ({ ip: p.ip }))
  for (const ip of settings.custom_ips) poolRaw.push({ ip })
  if (settings.ip_rotation_minutes > 0) {
    poolRaw = rotate(poolRaw, settings.ip_rotation_minutes)
    const alive = await filterAlive(poolRaw, 12)
    if (alive.length) poolRaw = alive.map((a) => ({ ip: a.ip, port: a.port }))
  }
  const pool: PreferredIP[] = poolRaw

  let subLines = out
  let clashExtra: { fragment?: MemberSettings['fragment_config'] } = {}
  if (settings.fragment) clashExtra.fragment = settings.fragment_config

  if (pool.length) {
    const result = applyInjection(out, pool, [])
    subLines = result.subLines
  }

  // Prefix names with the member name for easy client identification.
  const named = subLines.map((l) => {
    const m = l.match(/^([^#]+)#(.*)$/)
    if (!m) return l
    const decoded = decodeURIComponent(m[2])
    return `${m[1]}#${encodeURIComponent(`${namePrefix} | ${decoded}`)}`
  })

  // ── Response format: explicit ?target= wins, otherwise auto-detect from
  // the client's User-Agent (edgetunnel behaviour).
  const ua = (request?.headers.get('user-agent') ?? '').toLowerCase()
  let fmt = target
  if (!fmt) {
    if (/clash|mihomo|meta/.test(ua)) fmt = 'clash'
    else if (/singbox|sing-box|sfa/.test(ua)) fmt = 'singbox'
  }
  const isBrowser = ua.includes('mozilla')

  // Subscription-Userinfo: real quota/expiry shown by v2rayNG, Clash, Hiddify…
  const expireUnix = effectiveExpiry ? Math.floor(Date.parse(effectiveExpiry) / 1000) : 0
  const subHeaders: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'profile-update-interval': '1',
    'subscription-userinfo': `upload=0; download=${(member.used_bytes as number) ?? 0}; total=${quota ?? 0}; expire=${expireUnix}`,
  }
  if (request) subHeaders['profile-web-page-url'] = new URL(request.url).origin + `/status/${token}`
  if (!isBrowser && ua) subHeaders['Content-Disposition'] = `attachment; filename*=utf-8''${encodeURIComponent(String(member.name ?? 'miliconfig'))}`

  if (fmt === 'clash') {
    const result = applyInjection(named, pool, [])
    const proxies = result.clashProxies.map((p) => {
      let q = p
      if (settings.fragment && (q.type === 'vless' || q.type === 'vmess')) q = { ...q, fragment: settings.fragment_config }
      if (settings.fingerprint && 'client-fingerprint' in q) q = { ...q, 'client-fingerprint': settings.fingerprint }
      return q
    })
    const yaml = buildClashYaml({ ...result, clashProxies: proxies })
    return new Response(yaml, { headers: { ...subHeaders, 'Content-Type': 'text/yaml; charset=utf-8' } })
  }

  if (fmt === 'singbox' || fmt === 'plain') {
    const resp = renderSubscription(named, fmt)
    for (const [k, v] of Object.entries(subHeaders)) if (k !== 'Content-Type') resp.headers.set(k, v)
    return resp
  }

  return new Response(b64encodeUtf8(named.join('\n')), { headers: subHeaders })
}

// ── Live dry-run test (beginner safety net) ─────────────────────────────────

/** GET /api/members/:id/test — run the member's exact sub pipeline against the
 *  live worker source and report node counts + warnings WITHOUT changing
 *  anything. Lets the panel tell beginners immediately whether their settings
 *  actually produce working nodes (and why not). */
export async function handleMemberTest(env: Env, userId: string, id: string): Promise<Response> {
  const member = await env.DB.prepare('SELECT * FROM worker_members WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId).first<Record<string, unknown>>()
  if (!member) return apiError('عضو پیدا نشد', 404)

  const ctx = await resolveSource(env, userId, member.deployment_id as string)
  if (!ctx) return apiError('اتصال به ورکر برقرار نیست — توکن/account_id/KV را بررسی کنید', 502)

  const { lines, live } = await fetchSourceNodes(ctx)
  if (!lines.length) {
    return json({ data: {
      source_live: false,
      source_count: 0,
      output_count: 0,
      tls_nodes: 0,
      ws_nodes: 0,
      warnings: ['ورکر هیچ نودی برنگرداند — استقرار، UUID یا ADD.txt ورکر را بررسی کنید.'],
      sample: [],
    } })
  }

  // Same dedupe as serving.
  const seen = new Set<string>()
  const base: string[] = []
  for (const line of lines) {
    const identity = line.replace(/#.*$/, '')
    if (!seen.has(identity)) { seen.add(identity); base.push(line) }
  }

  const settings = resolveMemberSettings(member.settings as string)
  const result = transformMemberNodes(base, settings)
  const sample = result.lines.slice(0, 3).map((l) => {
    const raw = l.split('#')[1] ?? ''
    try { return decodeURIComponent(raw) || '(بدون نام)' } catch { return raw }
  }).filter(Boolean)

  return json({ data: {
    source_live: live,
    source_count: base.length,
    output_count: result.lines.length,
    tls_nodes: result.tls_total,
    ws_nodes: result.ws_total,
    warnings: result.warnings,
    sample,
  } })
}

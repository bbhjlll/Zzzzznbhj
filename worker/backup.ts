// Full JSON backup export/import for a user's panel data.
// Export: members, injector jobs and group subs (deployment links are kept
// by name so imports work across accounts). Import restores rows, matching
// deployments by id first then by name; existing ids are reused.

import type { Env } from './env'
import { apiError, json, nowIso } from './util'

interface BackupMember {
  deployment_ref: { id: string; name: string }
  name: string
  token: string
  enabled: number
  expires_at: string | null
  quota_bytes: number | null
  request_quota: number | null
  ip_limit: number | null
  start_on_connect: number
  reset_period_days: number | null
  settings: Record<string, unknown>
}

interface BackupInjector {
  name: string
  source: string
  ips: string[]
  proxies: unknown[]
  sub_token: string
  rotate_minutes: number | null
}

interface BackupGroup {
  name: string
  deployment_refs: { id: string; name: string }[]
  sub_token: string
  inject?: number
  ips?: string[]
  proxies?: unknown[]
  /** Output format of the served subscription (base64/clash/singbox/plain). */
  format?: string
  /** Extra hand-pasted node links merged into the group — must survive a backup. */
  extra_links?: string[]
}

export async function exportBackup(env: Env, userId: string): Promise<Response> {
  const deps = await env.DB.prepare(
    `SELECT id, name FROM deployments WHERE user_id = ?`
  ).bind(userId).all<{ id: string; name: string }>()
  const depById = new Map((deps.results ?? []).map((d) => [d.id, d]))

  const members = await env.DB.prepare(
    `SELECT * FROM worker_members WHERE owner_user_id = ? ORDER BY created_at`
  ).bind(userId).all<Record<string, unknown>>()

  const injectors = await env.DB.prepare(
    `SELECT name, source, ips, proxies, sub_token, rotate_minutes FROM injector_jobs WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<{ name: string; source: string; ips: string; proxies: string; sub_token: string; rotate_minutes: number | null }>()

  const groups = await env.DB.prepare(
    `SELECT * FROM sub_groups WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<Record<string, unknown>>()

  const payload = {
    app: 'miliconfig',
    version: 1,
    exported_at: nowIso(),
    members: (members.results ?? []).map((m) => {
      const dep = depById.get(String(m.deployment_id))
      return {
        deployment_ref: dep ? { id: dep.id, name: dep.name } : { id: '', name: String(m.deployment_id) },
        name: m.name,
        token: m.token,
        enabled: m.enabled,
        expires_at: m.expires_at,
        quota_bytes: m.quota_bytes,
        request_quota: m.request_quota,
        ip_limit: m.ip_limit,
        start_on_connect: m.start_on_connect,
        reset_period_days: m.reset_period_days,
        settings: safeObj(m.settings),
      }
    }) as BackupMember[],
    injectors: (injectors.results ?? []).map((j) => ({
      name: j.name,
      source: j.source,
      ips: safeArr(j.ips),
      proxies: safeArr(j.proxies),
      sub_token: j.sub_token,
      rotate_minutes: j.rotate_minutes,
    })) as BackupInjector[],
    groups: (groups.results ?? []).map((g) => {
      const ids = safeArr(g.deployment_ids) as string[]
      return {
        name: g.name,
        deployment_refs: ids.map((id) => {
          const d = depById.get(id)
          return d ? { id: d.id, name: d.name } : { id, name: id }
        }),
        sub_token: g.sub_token,
        inject: g.inject as number | undefined,
        ips: safeArr(g.ips as string),
        proxies: safeArr(g.proxies as string),
        format: (g.format as string | null) ?? 'base64',
        extra_links: safeArr(g.extra_links as string) as string[],
      }
    }) as BackupGroup[],
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="miliconfig-backup-${nowIso().slice(0, 10)}.json"`,
    },
  })
}

function safeObj(v: unknown): Record<string, unknown> {
  try { return typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>) ?? {} } catch { return {} }
}
function safeArr(v: unknown): unknown[] {
  try { return typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : [] } catch { return [] }
}

export async function importBackup(env: Env, userId: string, request: Request): Promise<Response> {
  let body: { members?: BackupMember[]; injectors?: BackupInjector[]; groups?: BackupGroup[]; mode?: 'merge' | 'replace' }
  try { body = await request.json() } catch { return apiError('JSON نامعتبر است', 400) }
  const mode = body.mode === 'replace' ? 'replace' : 'merge'

  if (mode === 'replace') {
    // Only delete rows owned by this user — never other users' data.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM worker_members WHERE owner_user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM injector_jobs WHERE user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM sub_groups WHERE user_id = ?`).bind(userId),
    ])
  }

  const deps = await env.DB.prepare(`SELECT id, name FROM deployments WHERE user_id = ?`)
    .bind(userId).all<{ id: string; name: string }>()
  const depByName = new Map((deps.results ?? []).map((d) => [d.name.toLowerCase(), d.id]))
  const depById = new Set((deps.results ?? []).map((d) => d.id))

  let addedMembers = 0, skippedMembers = 0
  for (const m of body.members ?? []) {
    const depId = m.deployment_ref && depById.has(m.deployment_ref.id)
      ? m.deployment_ref.id
      : depByName.get((m.deployment_ref?.name ?? '').toLowerCase())
    if (!depId) { skippedMembers++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM worker_members WHERE token = ?`).bind(m.token).first()
    if (exists) { skippedMembers++; continue }
    await env.DB.prepare(
      `INSERT INTO worker_members (id, owner_user_id, deployment_id, name, token, enabled, expires_at, quota_bytes, request_quota, ip_limit, start_on_connect, reset_period_days, settings, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(
      crypto.randomUUID().replaceAll('-', ''), userId, depId, m.name, m.token,
      m.enabled === 0 ? 0 : 1, m.expires_at ?? null, m.quota_bytes ?? null,
      m.request_quota ?? null, m.ip_limit ?? null, m.start_on_connect ? 1 : 0,
      m.reset_period_days ?? null, JSON.stringify(m.settings ?? {}), nowIso(),
    ).run()
    addedMembers++
  }

  let addedInjectors = 0, skippedInjectors = 0
  for (const j of body.injectors ?? []) {
    const exists = await env.DB.prepare(`SELECT 1 FROM injector_jobs WHERE sub_token = ?`).bind(j.sub_token).first()
    if (exists) { skippedInjectors++; continue }
    await env.DB.prepare(
      `INSERT INTO injector_jobs (id, user_id, name, source, ips, proxies, sub_token, rotate_minutes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, j.name, j.source || 'custom',
      JSON.stringify(j.ips ?? []), JSON.stringify(j.proxies ?? []), j.sub_token, j.rotate_minutes ?? null, nowIso()).run()
    addedInjectors++
  }

  let addedGroups = 0, skippedGroups = 0
  for (const g of body.groups ?? []) {
    const ids = (g.deployment_refs ?? [])
      .map((r) => (depById.has(r.id) ? r.id : depByName.get(r.name.toLowerCase())))
      .filter((x): x is string => !!x)
    if (ids.length === 0 && (g.deployment_refs ?? []).length > 0) { skippedGroups++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM sub_groups WHERE sub_token = ?`).bind(g.sub_token).first()
    if (exists) { skippedGroups++; continue }
    await env.DB.prepare(
      `INSERT INTO sub_groups (id, user_id, name, deployment_ids, sub_token, inject, ips, proxies, format, extra_links, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), COALESCE(?7, '[]'), COALESCE(?8, '[]'), COALESCE(?9, 'base64'), COALESCE(?10, '[]'), ?11)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, g.name, JSON.stringify(ids), g.sub_token,
      g.inject ?? 0, JSON.stringify(g.ips ?? []), JSON.stringify(g.proxies ?? []),
      g.format ?? null, g.extra_links ? JSON.stringify(g.extra_links) : null, nowIso()).run()
    addedGroups++
  }

  return json({ ok: true, mode,
    members_added: addedMembers, members_skipped: skippedMembers,
    injectors_added: addedInjectors, injectors_skipped: skippedInjectors,
    groups_added: addedGroups, groups_skipped: skippedGroups })
}

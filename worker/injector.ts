import type { Env } from './env'
import { apiError, genId, json, nowIso, safeJsonParse } from './util'
import { applyInjection, buildSubBase64, collectNodeLines, type PreferredIP, type ProxySpec } from './inject'
import { applyEch, applyFragment, type EchConfig, type FragmentConfig } from './nodetls'
import { renderSubscription } from './formats'
import { expandRanges } from './net'
import { rotate } from './rotation'
import { ensureSchema } from './schema'

// Injection jobs: a saved, reusable custom sub (miliconfig-branded) that
// combines a source subscription with preferred IPs and proxy chains.

interface InjectorBody {
  name?: string
  source?: string
  ips?: PreferredIP[]
  proxies?: ProxySpec[]
  rotate_minutes?: number | null
  /** ECH — encrypts the client SNI itself (strongest anti-censorship trick). */
  ech?: boolean
  ech_sni?: string
  ech_dns?: string
  /** TLS fragmentation / cipher masking for the nodes of this sub. */
  fragment?: FragmentConfig
}

/** Defaults that work with the ECH endpoints Cloudflare publishes. */
const DEFAULT_ECH_SNI = 'cloudflare-ech.com'
const DEFAULT_ECH_DNS = 'https://dns.alidns.com/dns-query'

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max)
}

function readEch(row: { ech?: number | null; ech_sni?: string | null; ech_dns?: string | null }): EchConfig {
  return {
    enabled: !!row.ech,
    sni: cleanText(row.ech_sni, 120) || DEFAULT_ECH_SNI,
    dns: cleanText(row.ech_dns, 200) || DEFAULT_ECH_DNS,
  }
}

function readFragment(raw: unknown): FragmentConfig {
  const f = safeJsonParse<FragmentConfig>(typeof raw === 'string' ? raw : '', { enabled: false })
  return {
    enabled: !!f.enabled,
    fm: cleanText(f.fm, 2000) || undefined,
    cs: cleanText(f.cs, 2000) || undefined,
    preset: cleanText(f.preset, 60) || undefined,
  }
}

function sanitizeIps(ips?: PreferredIP[]): PreferredIP[] {
  // CIDR ranges (104.16.0.0/30 style) expand to individual addresses.
  const out: PreferredIP[] = []
  for (const p of ips ?? []) {
    if (!p || typeof p.ip !== 'string') continue
    const ip = p.ip.trim()
    if (ip.includes('/')) {
      for (const expanded of expandRanges([ip], 40 - out.length)) {
        out.push({ ip: expanded, ...(p.port ? { port: Number(p.port) } : {}) })
        if (out.length >= 40) return out
      }
    } else if (/^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(ip)) {
      out.push({ ip, ...(p.port ? { port: Number(p.port) } : {}) })
    }
  }
  return out.slice(0, 20)
}

function sanitizeProxies(proxies?: ProxySpec[]): ProxySpec[] {
  return (proxies ?? [])
    .filter((p) => p && ['http', 'socks5'].includes(String(p.type)) && p.server && Number(p.port) > 0)
    .slice(0, 5)
    .map((p) => ({
      type: p.type === 'http' ? 'http' as const : 'socks5' as const,
      server: String(p.server),
      port: Number(p.port),
      ...(p.username ? { username: String(p.username) } : {}),
      ...(p.password ? { password: String(p.password) } : {}),
    }))
}

export async function handleInjectorCreate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<InjectorBody>(await request.text().catch(() => ''), {})
  const name = body.name?.trim() || 'ساب سفارشی miliconfig'
  const source = body.source?.trim() ?? ''
  if (!source) return apiError('منبع (لینک ساب یا کانفیگ‌ها) الزامی است')
  const ips = sanitizeIps(body.ips)
  const proxies = sanitizeProxies(body.proxies)
  if (ips.length === 0 && proxies.length === 0) return apiError('حداقل یک IP ترجیحی یا یک پروکسی وارد کنید')

  // Validate the source parses now (fail fast, synchronously).
  let lines: string[]
  try {
    lines = (await collectNodeLines(source)).map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    return apiError(e instanceof Error ? e.message : 'منبع قابل خواندن نیست')
  }
  if (lines.length === 0) return apiError('هیچ کانفیگی در منبع پیدا نشد')

  const id = genId()
  const subToken = genId().replace(/-/g, '')
  const rotateMinutes = body.rotate_minutes != null && body.rotate_minutes > 0 ? Math.round(body.rotate_minutes) : null
  const ech = readEch({
    ech: body.ech ? 1 : 0,
    ech_sni: cleanText(body.ech_sni, 120) || DEFAULT_ECH_SNI,
    ech_dns: cleanText(body.ech_dns, 200) || DEFAULT_ECH_DNS,
  })
  const fragment = readFragment(body.fragment)
  await env.DB.prepare(
    `INSERT INTO injector_jobs (id, user_id, name, source, ips, proxies, sub_token, rotate_minutes, ech, ech_sni, ech_dns, fragment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, name, source.slice(0, 100_000), JSON.stringify(ips), JSON.stringify(proxies), subToken, rotateMinutes,
    ech.enabled ? 1 : 0, ech.sni, ech.dns, JSON.stringify(fragment), nowIso(), nowIso()).run()

  return json({ data: { id, sub_token: subToken } }, 201)
}

export async function handleInjectorList(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    'SELECT id, name, ips, proxies, sub_token, rotate_minutes, ech, ech_sni, ech_dns, fragment, created_at FROM injector_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
  ).bind(userId).all()
  return json({
    data: r.results.map((row) => ({
      ...row,
      ips: safeJsonParse(row.ips as string, []),
      proxies: safeJsonParse(row.proxies as string, []),
      rotate_minutes: row.rotate_minutes ?? null,
      ech: readEch(row as { ech: number | null; ech_sni: string | null; ech_dns: string | null }),
      fragment: readFragment(row.fragment),
    })),
  })
}

export async function handleInjectorDelete(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM injector_jobs WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('پیدا نشد', 404)
  return json({ success: true })
}

/** Update an injected sub's preferred IPs (e.g. push fresh scan results). */
export async function handleInjectorPatch(env: Env, userId: string, id: string, request: Request): Promise<Response> {
  const body = safeJsonParse<InjectorBody>(await request.text().catch(() => ''), {})
  const existing = await env.DB.prepare('SELECT id, ips, proxies, rotate_minutes, ech, ech_sni, ech_dns, fragment FROM injector_jobs WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ id: string; ips: string; proxies: string; rotate_minutes: number | null; ech: number | null; ech_sni: string | null; ech_dns: string | null; fragment: string | null }>()
  if (!existing) return apiError('پیدا نشد', 404)

  const ips = body.ips !== undefined ? sanitizeIps(body.ips) : safeJsonParse<PreferredIP[]>(existing.ips, [])
  const proxies = body.proxies !== undefined ? sanitizeProxies(body.proxies) : safeJsonParse<ProxySpec[]>(existing.proxies, [])
  if (ips.length === 0 && proxies.length === 0) return apiError('حداقل یک IP ترجیحی یا یک پروکسی لازم است')

  const rotateMinutes = body.rotate_minutes !== undefined
    ? (body.rotate_minutes == null || body.rotate_minutes <= 0 ? null : Math.round(body.rotate_minutes))
    : (existing.rotate_minutes ?? null)

  const ech = body.ech !== undefined
    ? readEch({ ech: body.ech ? 1 : 0, ech_sni: body.ech_sni ?? existing.ech_sni, ech_dns: body.ech_dns ?? existing.ech_dns })
    : readEch(existing)
  const fragment = body.fragment !== undefined ? readFragment(body.fragment) : readFragment(existing.fragment)

  await env.DB.prepare('UPDATE injector_jobs SET ips = ?, proxies = ?, rotate_minutes = ?, ech = ?, ech_sni = ?, ech_dns = ?, fragment = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(ips), JSON.stringify(proxies), rotateMinutes, ech.enabled ? 1 : 0, ech.sni, ech.dns, JSON.stringify(fragment), nowIso(), id)
    .run()
  return json({ data: { id, ips, proxies, ech, fragment } })
}

/** Public endpoint — GET /api/sub/inject/:token[?target=clash] */
export async function serveInjectedSub(env: Env, token: string, target: string | null): Promise<Response> {
  const row = await env.DB.prepare('SELECT source, ips, proxies, rotate_minutes, ech, ech_sni, ech_dns, fragment FROM injector_jobs WHERE sub_token = ?')
    .bind(token)
    .first<{ source: string; ips: string; proxies: string; rotate_minutes: number | null; ech: number | null; ech_sni: string | null; ech_dns: string | null; fragment: string | null }>()
  if (!row) return new Response('یافت نشد', { status: 404 })

  try {
    const source = await collectNodeLines(row.source)
    // Anti-censorship first, so the injected variants inherit ECH + fragmentation
    // too. (Share-link formats only: sing-box JSON needs a real ECHConfigList
    // and has no fragment field, so `?target=singbox` deliberately drops them.)
    const lines = applyFragment(applyEch(source, readEch(row)), readFragment(row.fragment))
    const rotatedIps = rotate(safeJsonParse<PreferredIP[]>(row.ips, []), row.rotate_minutes)
    const result = applyInjection(lines, rotatedIps, safeJsonParse<ProxySpec[]>(row.proxies, []))
    return renderSubscription(result.subLines, target)
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'خطا در تولید ساب', { status: 502 })
  }
}

/** Parse user-pasted IP / proxy text into structured lists (helper for the UI). */
export function parseIpLines(text: string, cap = 100): PreferredIP[] {
  // edgetunnel ADD.csv-style lines: plain IP/host, ip:port or CIDR ranges
  // like 104.16.0.0/30 (optionally with :port) are expanded per-address.
  const out: PreferredIP[] = []
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim()
    if (!line) continue
    const [addr, portRaw] = line.split(':')
    const port = portRaw ? Number(portRaw) || undefined : undefined
    if (addr.includes('/')) {
      for (const ip of expandRanges([addr], cap - out.length)) {
        out.push(port ? { ip, port } : { ip })
        if (out.length >= cap) return out
      }
    } else {
      out.push(port ? { ip: addr, port } : { ip: addr })
    }
  }
  return out
}

export function parseProxyLines(text: string): ProxySpec[] {
  return text.split('\n').map((l): ProxySpec | null => {
    const m = l.trim().match(/^(https?|socks5):\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+):(\d+)$/i)
    if (!m) return null
    return {
      type: (m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http') as 'socks5' | 'http',
      ...(m[2] ? { username: m[2] } : {}),
      ...(m[3] ? { password: m[3] } : {}),
      server: m[4],
      port: Number(m[5]),
    }
  }).filter((p): p is ProxySpec => p !== null)
}

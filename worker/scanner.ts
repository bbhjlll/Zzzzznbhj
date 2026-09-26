import { apiError, json } from './util'
import { expandRanges, probeBatch } from './net'
import { coloProbe, tcpProbe as tcpHandshake } from './probe'

interface ScanResult {
  ip: string
  latencyMs: number | null
  status: 'ok' | 'timeout' | 'error'
  /** Edge colo code (e.g. FRA) — only meaningful for Cloudflare IPs. */
  region?: string
  /** Human-readable city for the colo, when known. */
  city?: string
  /** True when trace + CF-RAY independently agreed on the colo. */
  verified?: boolean
  /** HTTP round-trip time (ms) through the candidate IP, when measured. */
  httpLatency?: number | null
  type: 'cloudflare' | 'clean' | 'proxy'
  source: string
  port?: number
  protocol?: string
  proxy?: string
}

const FALLBACK_CF_IPS = [
  '104.16.0.1', '104.16.0.2', '104.16.0.3', '104.17.0.1', '104.17.0.2',
  '104.18.0.1', '104.18.0.2', '172.64.0.1', '172.64.0.2', '162.159.0.1',
  '162.159.0.2', '1.1.1.1', '1.0.0.1',
]

/**
 * Probe one candidate IP for real.
 *
 * A cloudflare IP is verified by connecting to that exact IP while keeping a
 * valid hostname for the TLS SNI/Host (`cf.resolveOverride`) — fetching
 * `https://<ip>/cdn-cgi/trace` directly fails the certificate check, which is
 * why the old scanner came back empty. The genuine trace body plus the CF-RAY
 * header give the real, cross-verified colo.
 *
 * A "clean"/foreign IP is not a Cloudflare host, so the only honest signal is
 * a real TCP handshake — the CF trace URL would never resolve there.
 */
async function probeIP(ip: string, type: 'cloudflare' | 'clean' | 'proxy', source: string, timeoutMs = 5000): Promise<ScanResult> {
  if (type !== 'cloudflare') {
    const tcp = await tcpHandshake(ip, 443, timeoutMs)
    return {
      ip,
      latencyMs: tcp.latency,
      status: tcp.status === 'ok' && tcp.latency !== null ? 'ok' : 'timeout',
      type,
      source,
    }
  }

  const colo = await coloProbe(ip, timeoutMs)
  return {
    ip,
    latencyMs: colo.latency,
    status: colo.status === 'ok' && colo.latency !== null ? 'ok' : 'timeout',
    region: colo.colo ?? undefined,
    city: colo.city ?? undefined,
    verified: !!colo.crossVerified,
    httpLatency: colo.latency,
    type,
    source,
  }
}

async function fetchIPDB(type: 'bestcf' | 'bestProxy'): Promise<Array<{ ip: string; region?: string }>> {
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 10000)
    const r = await fetch(`https://ipdb.api.030101.xyz/?type=${type}`, { signal: ctrl.signal })
    clearTimeout(tid)
    if (!r.ok) return []
    const data: unknown = await r.json().catch(() => null)
    const list = (Array.isArray(data) ? data : ((data as Record<string, unknown>)?.result ?? [])) as Array<Record<string, unknown>>
    return list
      .filter((item) => item?.ip || item?.address)
      .slice(0, 50)
      .map((item) => ({ ip: String(item.ip ?? item.address), region: item.colo ? String(item.colo) : undefined }))
  } catch {
    return []
  }
}

async function fetchGithubList(url: string): Promise<Array<{ ip: string; region?: string }>> {
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 10000)
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(tid)
    if (!r.ok) return []
    const text = await r.text()
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && /^\d+\.\d+\.\d+\.\d+/.test(l))
      .slice(0, 50)
      .map((l) => {
        const [ip, region] = l.split('#')
        return { ip: ip.trim(), region: region?.trim() || undefined }
      })
  } catch {
    return []
  }
}

async function fetchProxyList(protocol: 'https' | 'socks5' | 'http'): Promise<ScanResult[]> {
  try {
    const ctrl = new AbortController()
    const tid = setTimeout(() => ctrl.abort(), 12000)
    const r = await fetch(`https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/${protocol}.json`, { signal: ctrl.signal })
    clearTimeout(tid)
    if (!r.ok) return []
    const data: unknown = await r.json().catch(() => null)
    if (!Array.isArray(data)) return []
    return (data as Array<Record<string, unknown>>)
      .filter((item) => item?.ip && item?.port)
      .slice(0, 30)
      .map((item) => ({
        ip: String(item.ip),
        latencyMs: null,
        status: 'ok' as const,
        region: item.country ? String(item.country) : undefined,
        type: 'proxy' as const,
        source: 'EDT-Pages/Proxy-List',
        port: Number(item.port),
        protocol: String(item.protocol ?? protocol),
        proxy: String(item.proxy ?? `${protocol}://${item.ip}:${item.port}`),
      }))
  } catch {
    return []
  }
}

/** Official Cloudflare ranges (always available) — expands CIDRs into a
 * spread sample so we probe different /16s instead of neighbours. */
async function fetchOfficialRanges(sample = 16): Promise<Array<{ ip: string; region?: string }>> {
  try {
    const r = await fetch('https://www.cloudflare.com/ips-v4')
    if (!r.ok) return []
    const ranges = (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean)
    const ips = expandRanges(ranges, 4000)
    if (!ips.length) return []
    const step = Math.max(1, Math.floor(ips.length / sample))
    return Array.from({ length: sample }, (_, i) => ({ ip: ips[Math.min(i * step, ips.length - 1)] }))
  } catch {
    return []
  }
}

/** Plain `ip` or `ip:port` proxy lists (e.g. TheSpeedX/PROXY-List). */
async function fetchHostPortList(url: string, defaultPort: number, cap = 40): Promise<Array<{ ip: string; port?: number; region?: string }>> {
  try {
    const r = await fetch(url)
    if (!r.ok) return []
    return (await r.text())
      .split(/\s+/)
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
      .filter((l, i, arr) => arr.indexOf(l) === i)
      .slice(0, cap)
      .map((l) => {
        const [ip, port] = l.split(':')
        return { ip, port: Number(port) || defaultPort }
      })
  } catch {
    return []
  }
}

/**
 * Real TCP scan over user-provided CIDR ranges and ports using the
 * Workers Sockets API — measures actual handshake latency per IP:port.
 */
export async function handleRangeScan(body: {
  ranges?: string
  ports?: string
  count?: number
  timeout?: number
}): Promise<Response> {
  const ranges = (body.ranges ?? '').split(/[\n,]/).map((r) => r.trim()).filter(Boolean).slice(0, 8)
  if (!ranges.length) return apiError('حداقل یک بازه IP وارد کنید (مثلاً 104.16.0.0/24)')
  const ports = (body.ports ?? '443')
    .split(/[\n,]/)
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
    .slice(0, 5)
  if (!ports.length) return apiError('پورت معتبری وارد نشد')

  const ips = expandRanges(ranges, 1024)
  if (!ips.length) return apiError('بازه IP معتبر نیست')

  // Workers can only keep a handful of TCP sockets open per request, so an
  // unbounded sweep (512 IPs × 5 ports) always ran past the client's 45s window
  // and returned nothing. Bound the real work to a budget that reliably
  // finishes, and report honestly how much of the range was covered.
  const BUDGET = 240
  const allTargets = ips.flatMap((ip) => ports.map((port) => ({ host: ip, port, ip })))
  const targets = allTargets.slice(0, BUDGET)
  const probed = await probeBatch(targets, 24, Math.min(Math.max(body.timeout ?? 2000, 500), 5000))

  const ok = probed
    .filter((p) => p.latencyMs !== null)
    .sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999))
    .slice(0, Math.min(Math.max(body.count ?? 50, 1), 200))
    .map((p) => ({
      ip: p.ip,
      port: p.port,
      latencyMs: p.latencyMs,
      status: 'ok' as const,
      type: 'cloudflare' as const,
      source: 'tcp-scan',
    }))

  return json({
    success: ok.length > 0,
    scanned: targets.length,
    total: allTargets.length,
    truncated: allTargets.length > targets.length,
    count: ok.length,
    results: ok,
  })
}

export async function handleIpScanner(body: { type?: string; count?: number; includeProxies?: boolean }): Promise<Response> {
  const type = body.type === 'clean' ? 'clean' : 'cloudflare'
  const safeCount = Math.min(Math.max(5, body.count ?? 30), 50)

  const candidates: Array<{ ip: string; type: 'cloudflare' | 'clean'; source: string; region?: string }> = []

  // Fetch all IP sources in parallel (much faster on mobile)
  const srcPromises = type === 'cloudflare' ? [
    fetchIPDB('bestcf').then((r) => r.map((c) => ({ ...c, type: 'cloudflare' as const, source: 'ipdb.api.030101.xyz' }))),
    fetchGithubList('https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt').then((r) => r.map((c) => ({ ...c, type: 'cloudflare' as const, source: 'ymyuuu/IPDB' }))),
    fetchGithubList('https://raw.githubusercontent.com/ZhiXuanWang/cf-speedtest/main/ip.txt').then((r) => r.map((c) => ({ ...c, type: 'cloudflare' as const, source: 'ZhiXuanWang/cf-speedtest' }))),
    fetchOfficialRanges().then((r) => r.map((c) => ({ ...c, type: 'cloudflare' as const, source: 'cloudflare.com/ips-v4' }))),
  ] : [
    fetchIPDB('bestProxy').then((r) => r.map((c) => ({ ...c, type: 'clean' as const, source: 'ipdb.api.030101.xyz' }))),
    fetchGithubList('https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestproxy.txt').then((r) => r.map((c) => ({ ...c, type: 'clean' as const, source: 'ymyuuu/IPDB' }))),
  ]
  const srcResults = await Promise.allSettled(srcPromises)
  for (const r of srcResults) {
    if (r.status === 'fulfilled') candidates.push(...r.value)
  }
  if (candidates.length === 0 && body.type !== 'clean') {
    for (const c of await fetchGithubList('https://raw.githubusercontent.com/ZhiXuanWang/cf-speedtest/main/ip.txt')) candidates.push({ ...c, type: 'cloudflare', source: 'cf-speedtest/fallback' })
    for (const c of await fetchOfficialRanges(10)) candidates.push({ ...c, type: 'cloudflare', source: 'cloudflare.com/ips-v4' })
  }
  if (candidates.length === 0) {
    for (const ip of FALLBACK_CF_IPS) candidates.push({ ip, type: type === 'cloudflare' ? 'cloudflare' : 'clean', source: 'fallback' })
  }

  // Deduplicate by IP
  const seen = new Set<string>()
  const unique = candidates.filter((c) => (seen.has(c.ip) ? false : (seen.add(c.ip), true)))

  if (unique.length === 0) return apiError('هیچ IP از منابع دریافت نشد.', 502)

  // Probe in batches until we have enough good results, with a hard ceiling on
  // total probes so a slow source can never burn the whole request budget.
  const MAX_PROBES = 120
  const BATCH = 12
  const allResults: ScanResult[] = []
  for (let i = 0; i < unique.length && i < MAX_PROBES && allResults.filter((r) => r.status === 'ok').length < safeCount; i += BATCH) {
    const batch = unique.slice(i, i + BATCH)
    allResults.push(...(await Promise.all(batch.map((c) => probeIP(c.ip, c.type, c.source)))))
  }

  const sorted = allResults
    .filter((r) => r.status === 'ok' && r.latencyMs !== null)
    .sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999))
    .slice(0, safeCount)

  let proxies: ScanResult[] = []
  if (body.includeProxies) {
    const [httpsProxies, socks5Proxies, httpProxies, speedxHttp, speedxSocks] = await Promise.all([
      fetchProxyList('https'),
      fetchProxyList('socks5'),
      fetchProxyList('http'),
      fetchHostPortList('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt', 8080),
      fetchHostPortList('https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt', 1080),
    ])
    const mapToResult = (list: Array<{ ip: string; port?: number }>, protocol: string, source: string): ScanResult[] =>
      list.map((p) => ({
        ip: p.ip,
        latencyMs: null,
        status: 'ok' as const,
        type: 'proxy' as const,
        source,
        port: p.port,
        protocol,
        proxy: `${protocol}://${p.ip}:${p.port}`,
      }))
    proxies = [
      ...httpsProxies,
      ...socks5Proxies,
      ...httpProxies,
      ...mapToResult(speedxHttp, 'http', 'TheSpeedX/PROXY-List'),
      ...mapToResult(speedxSocks, 'socks5', 'TheSpeedX/PROXY-List'),
    ]
  }

  if (sorted.length === 0) {
    return json({ success: false, error: 'هیچ IP پاسخ‌دهی پیدا نشد. بعداً دوباره تلاش کنید.' }, 200)
  }

  return json({ success: true, count: sorted.length, scanned: allResults.length, results: sorted, proxies: proxies.length > 0 ? proxies.slice(0, 50) : undefined })
}

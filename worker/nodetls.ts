// TLS-level rewriting for INJECTED subscriptions.
//
// The member engine (members.ts) applies SNI/ECH/fragment/fingerprint per end
// user; this module does the same job for a whole injected sub, which is how a
// panel we do not control (ZEUS, BPB, …) gets ECH and TLS fragmentation added
// inside miliconfig — the upstream worker source is never modified.
//
// Every helper only touches nodes that actually negotiate TLS. Plain ss://,
// socks:// or `security=none` links are returned untouched: adding TLS-only
// params to them produces broken configs instead of stealthier ones.

/** Read a single URI query param from a node link (before the #-name). */
export function getNodeParam(line: string, key: string): string {
  const hashIdx = line.indexOf('#')
  const qIdx = line.indexOf('?')
  if (qIdx === -1) return ''
  const queryEnd = hashIdx > -1 ? hashIdx : line.length
  return new URLSearchParams(line.slice(qIdx + 1, queryEnd)).get(key) ?? ''
}

/** Rewrite or insert a single URI query param in a node link. */
export function setNodeParam(line: string, key: string, value: string): string {
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

/** URI-style links (vless/trojan/hysteria) whose query string we can rewrite.
 *  vmess is base64 JSON: appending `?ech=` to it would corrupt the link, and
 *  the vmess share format has no ECH/fragment fields anyway — so it is never
 *  touched here. */
function isUriNode(line: string): boolean {
  return /^(vless|trojan|hysteria2?):\/\//.test(line)
}

/** True when the node negotiates TLS — the only kind ECH/fragment apply to. */
export function isTlsNode(line: string): boolean {
  if (line.startsWith('vmess://')) {
    try {
      const json = JSON.parse(atob(line.slice('vmess://'.length))) as Record<string, unknown>
      return String(json.tls ?? '') === 'tls'
    } catch {
      return false
    }
  }
  if (!/^(vless|trojan|hysteria2?):\/\//.test(line)) return false // plain ss/socks
  const security = getNodeParam(line, 'security').toLowerCase()
  if (security === 'tls' || security === 'reality') return true
  if (security === 'none') return false
  // No explicit security param: treat :443 endpoints as TLS (edgetunnel default).
  return line.match(/@[^:/?#]+:(\d+)/)?.[1] === '443'
}

export interface EchConfig {
  enabled: boolean
  sni: string
  dns: string
}

/**
 * Attach Encrypted Client Hello to every TLS node: `ech=<sni>+<dns>` — the
 * client's own SNI goes inside the encrypted inner ClientHello, which is the
 * strongest anti-censorship trick a config file can carry.
 */
export function applyEch(lines: string[], cfg: EchConfig): string[] {
  if (!cfg.enabled || !cfg.sni || !cfg.dns) return lines
  return lines.map((l) => (isTlsNode(l) && isUriNode(l) ? setNodeParam(l, 'ech', `${cfg.sni}+${cfg.dns}`) : l))
}

export interface FragmentConfig {
  enabled: boolean
  /** Patterniha-style fragment JSON (fm). */
  fm?: string
  /** Custom TLS cipher suites (cs). */
  cs?: string
  /** Preset code, kept for display only. */
  preset?: string
}

/**
 * Attach fragmentation + cipher-suite masking (`fm` / `cs`) to TLS nodes.
 * Empty values are skipped so a half-filled form can never break a link.
 */
export function applyFragment(lines: string[], cfg: FragmentConfig): string[] {
  if (!cfg.enabled) return lines
  return lines.map((l) => {
    if (!isTlsNode(l) || !isUriNode(l)) return l
    let out = l
    if (cfg.fm) out = setNodeParam(out, 'fm', cfg.fm)
    if (cfg.cs) out = setNodeParam(out, 'cs', cfg.cs)
    return out
  })
}
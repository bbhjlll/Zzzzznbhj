// Public status page per member: /status/:token
// Shows live member state (enabled, expiry, quotas, devices) plus a QR code
// and copyable links for the subscription. No auth needed beyond the secret token.

import type { Env } from './env'
import QRCode from 'qrcode'

interface MemberRow {
  name: string
  enabled: number
  expires_at: string | null
  start_on_connect: number
  activated_at: string | null
  quota_bytes: number | null
  request_quota: number | null
  ip_limit: number | null
  used_bytes: number
  used_requests: number
  recent_ips: string
}

function fmtBytes(n: number): string {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
  return n + ' B'
}

function daysLeft(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000))
}

export async function serveStatusPage(env: Env, token: string, origin: string): Promise<Response> {
  const m = await env.DB.prepare(
    `SELECT name, enabled, expires_at, start_on_connect, activated_at, quota_bytes, request_quota, ip_limit, used_bytes, used_requests, recent_ips FROM worker_members WHERE token = ?`
  ).bind(token).first<MemberRow>()

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const subUrl = `${origin}/api/sub/member/${token}`
  const statusSub = `${origin}/status/${token}/sub`
  const clashUrl = `${subUrl}?target=clash`
  const singboxUrl = `${subUrl}?target=singbox`
  const plainUrl = `${subUrl}?target=plain`

  let qrSvg = ''
  try {
    qrSvg = await QRCode.toString(subUrl, { type: 'svg', margin: 1, width: 180, color: { dark: '#38bdf8', light: '#0f172a00' } })
  } catch { /* non-fatal */ }

  // One-tap import deep-links: each opens the matching client app if it is
  // installed on the user's device and imports the live subscription.
  const enc = encodeURIComponent(subUrl)
  const clientLinks: [string, string][] = [
    ['v2rayNG', `v2rayng://install-sub?url=${enc}`],
    ['Clash Meta', `clash://install-config?url=${enc}`],
    ['sing-box', `sing-box://import-remote-profile?url=${enc}`],
    ['Hiddify', `hiddify://import/${subUrl}`],
    ['Streisand', `streisand://import/${subUrl}`],
    ['NekoBox', `sn://subscription?url=${enc}&name=miliconfig`],
  ]
  // Store pages, in case the app is not installed yet.
  const storeLinks: [string, string][] = [
    ['v2rayNG ↗', 'https://play.google.com/store/apps/details?id=com.v2ray.ang'],
    ['Hiddify ↗', 'https://play.google.com/store/apps/details?id=app.hiddify.com'],
    ['sing-box ↗', 'https://play.google.com/store/apps/details?id=io.nekohasekai.sfa'],
    ['Clash Meta ↗', 'https://github.com/MetaCubeX/ClashMetaForAndroid/releases'],
  ]

  let body: string
  if (!m) {
    // An unknown/invalid status token is a real 404 — returning 200 would make
    // crawlers and clients treat a dead link as a valid page.
    body = `<div class="card"><h1>❌ یافت نشد</h1><p class="muted">این لینک وضعیت معتبر نیست.</p></div>`
  } else {
    const enabled = m.enabled === 1
    const expiryIso = m.start_on_connect && !m.activated_at ? null : m.expires_at
    const expired = expiryIso ? Date.parse(expiryIso) < Date.now() : false

    const rows: [string, string][] = [
      ['وضعیت', !enabled ? '<span class="bad">غیرفعال</span>'
        : expired ? '<span class="bad">منقضی شده</span>'
        : '<span class="good">فعال ✅</span>'],
      ['انقضا', expiryIso ? `${new Date(expiryIso).toLocaleDateString('fa-IR')} (${daysLeft(expiryIso)} روز مانده)` : (m.start_on_connect ? 'شمارش از اولین اتصال — هنوز فعال نشده' : 'بدون انقضا')],
      ['دستگاه‌ها', `${(safeArr(m.recent_ips)).length}${m.ip_limit ? ` از حداکثر ${m.ip_limit}` : ''}`],
    ]

    const bar = (used: number, total: number | null, label: string, fmt: (n: number) => string) => {
      if (!total) return `<div class="quota"><div class="qhead"><span>${label}</span><b>${fmt(used)}</b></div><div class="track"><div class="fill inf"></div></div><small class="muted">بی‌نهایت</small></div>`
      const pct = Math.min(100, Math.round((used / total) * 100))
      const cls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''
      return `<div class="quota"><div class="qhead"><span>${label}</span><b>${fmt(used)} / ${fmt(total)} · ${pct}٪</b></div><div class="track"><div class="fill ${cls}" style="width:${pct}%"></div></div></div>`
    }

    body = `<div class="card">
      <h1>📡 ${esc(m.name)}</h1>
      ${rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')}
      ${bar(m.used_bytes, m.quota_bytes, 'حجم مصرفی', fmtBytes)}
      ${bar(m.used_requests, m.request_quota, 'درخواست‌ها', (n) => n.toLocaleString('en-US'))}
      <div class="links">
        <a href="${subUrl}" target="_blank" rel="noopener">ساب (Base64)</a>
        <a href="${clashUrl}" target="_blank" rel="noopener">Clash Meta</a>
      </div>
      <div class="links">
        <a href="${singboxUrl}" target="_blank" rel="noopener">Sing-box</a>
        <a href="${plainUrl}" target="_blank" rel="noopener">Plain</a>
        <a href="${statusSub}" target="_blank" rel="noopener">دانلود مستقیم</a>
      </div>
      <p class="muted" style="margin-top:18px;font-size:.8rem">افزودن مستقیم به کلاینت (اپ باید نصب باشد):</p>
      <div class="clients">
        ${clientLinks.map(([label, href]) => `<a href="${esc(href)}">${label}</a>`).join('')}
      </div>
      <details style="margin-top:12px">
        <summary class="muted" style="font-size:.8rem;cursor:pointer">اپ را ندارید؟ دانلود از استور</summary>
        <div class="clients" style="margin-top:8px">
          ${storeLinks.map(([label, href]) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`).join('')}
        </div>
      </details>
      <div class="qr">${qrSvg}<small class="muted">برای افزودن، QR را با اپ VPN اسکن کنید</small></div>
    </div>`
  }

  const html = `<!doctype html><html lang="fa" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>miliconfig — وضعیت اشتراک</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Vazirmatn,Tahoma,sans-serif;background:#020617;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:28px;width:min(420px,100%);box-shadow:0 20px 50px #0008}
h1{font-size:1.25rem;margin-bottom:18px;color:#f8fafc}
.row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1e293b;font-size:.9rem}
.muted{color:#64748b}
.good{color:#34d399}.bad{color:#f87171}
.quota{margin-top:14px}
.qhead{display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:6px}
.track{height:8px;background:#1e293b;border-radius:99px;overflow:hidden}
.fill{height:100%;background:#38bdf8;border-radius:99px;transition:width .4s}
.fill.warn{background:#fbbf24}.fill.danger{background:#f87171}.fill.inf{width:100%;opacity:.35}
.links{display:flex;gap:10px;margin-top:18px}
.links a{flex:1;text-align:center;padding:10px;border-radius:10px;background:#1e40af33;color:#93c5fd;text-decoration:none;font-size:.85rem;border:1px solid #1e40af}
.links a:hover{background:#1e40af55}
.clients{display:flex;flex-wrap:wrap;gap:8px}
.clients a{flex:1 1 30%;text-align:center;padding:9px 6px;border-radius:10px;background:#052e1633;color:#6ee7b7;text-decoration:none;font-size:.8rem;border:1px solid #065f46}
.clients a:hover{background:#052e1666}
.qr{margin-top:18px;text-align:center}
.qr svg{border-radius:12px}
small{display:block;margin-top:6px;font-size:.75rem}
</style></head><body>${body}</body></html>`

  return new Response(html, {
    status: m ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function safeArr(v: unknown): string[] {
  try { return typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : [] } catch { return [] }
}

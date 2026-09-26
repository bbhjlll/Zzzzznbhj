/**
 * IP Scanner — real measurements only.
 *
 * Every result comes from the worker's edge engines (worker/scanner.ts,
 * worker/probe.ts):
 *   • Cloudflare IPs are verified by connecting to that exact IP while keeping a
 *     valid hostname for TLS (`cf.resolveOverride`), then cross-checking the
 *     trace colo against the CF-RAY header. No fake/placeholder rows.
 *   • Clean/foreign IPs are measured with an actual TCP handshake.
 *   • CIDR mode really opens a TCP socket per IP:port and reports handshake
 *     latency, bounded to a probe budget so it always answers in time.
 *
 * On top of the scan the user can, per row: re-verify the colo, run a real
 * download speed test through that IP, copy it, push the selection into a
 * worker's ADD.txt, or inject it into a custom subscription.
 */
import { useEffect, useState } from 'react'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Cloud, Copy, Gauge, Loader2,
  Radar, ScanLine, Wifi, Zap,
} from 'lucide-react'
import { api, apiRaw } from '../lib/api'
import type { Deployment, InjectedSub } from '../lib/types'

interface ScanResult {
  ip: string
  latencyMs: number | null
  status: 'ok' | 'timeout' | 'error'
  region?: string
  city?: string
  verified?: boolean
  httpLatency?: number | null
  type: 'cloudflare' | 'clean' | 'proxy'
  source: string
  port?: number
  protocol?: string
  proxy?: string
}

interface ScanResponse {
  success: boolean
  results?: ScanResult[]
  proxies?: ScanResult[]
  error?: string
  scanned?: number
  total?: number
  truncated?: boolean
}

interface VerifyInfo { colo?: string; city?: string; latency?: number; crossVerified?: boolean }
interface SpeedInfo { mbps: number; ms: number }

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-4 h-4 rounded accent-brand-500" />
      {label}
    </label>
  )
}

export default function IpScanner() {
  const [scanType, setScanType] = useState<'cloudflare' | 'clean'>('cloudflare')
  const [scanMode, setScanMode] = useState<'list' | 'ranges'>('list')
  const [ranges, setRanges] = useState('')
  const [ports, setPorts] = useState('443')
  const [includeProxies, setIncludeProxies] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [results, setResults] = useState<ScanResult[]>([])
  const [proxies, setProxies] = useState<ScanResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const [speeds, setSpeeds] = useState<Record<string, SpeedInfo | 'loading'>>({})
  const [verifyInfo, setVerifyInfo] = useState<Record<string, VerifyInfo | 'loading'>>({})
  const [selectedIPs, setSelectedIPs] = useState<Set<string>>(new Set())
  const [targetDep, setTargetDep] = useState<string>('')
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const [injections, setInjections] = useState<InjectedSub[]>([])
  const [targetInj, setTargetInj] = useState<string>('')
  const [injecting, setInjecting] = useState(false)
  const [injected, setInjected] = useState(false)

  useEffect(() => {
    api<{ data: Deployment[] }>('/deployments')
      .then(({ data }) => setDeployments((data ?? []).filter((d) => d.status === 'deployed')))
      .catch(() => setDeployments([]))
    api<{ data: InjectedSub[] }>('/injector')
      .then(({ data }) => setInjections(data ?? []))
      .catch(() => setInjections([]))
  }, [])

  const runScan = async () => {
    setScanning(true); setError(null); setResults([]); setProxies([]); setSelectedIPs(new Set())
    setScanNote(null); setSpeeds({}); setVerifyInfo({})
    try {
      const scanPromise = api<ScanResponse>('/ip-scanner', {
        method: 'POST',
        body: scanMode === 'ranges'
          ? { mode: 'ranges', ranges, ports, count: 50, timeout: 2000 }
          : { type: scanType, count: 30, includeProxies },
      })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('اسکن بیش از حد طول کشید — بازهٔ کوچک‌تری بدهید یا دوباره تلاش کنید')), 45000),
      )
      const data = await Promise.race([scanPromise, timeoutPromise])
      if (data.success && data.results && data.results.length > 0) {
        setResults(data.results)
        if (data.proxies) setProxies(data.proxies)
        if (typeof data.scanned === 'number') {
          setScanNote(
            `✅ ${data.scanned} هدف به‌صورت واقعی آزمایش شد` +
            (data.truncated && data.total ? ` (از ${data.total} هدف — برای پوشش کامل، بازهٔ کوچک‌تری بدهید)` : ''),
          )
        }
      } else if (data.success) {
        setError('هیچ IP پاسخ‌دهی پیدا نشد — چند لحظه بعد دوباره تلاش کنید.')
      } else {
        setError(data.error ?? 'خطا در اسکن')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در اتصال')
    }
    setScanning(false)
  }

  const toggleSelect = (ip: string) =>
    setSelectedIPs((prev) => { const n = new Set(prev); n.has(ip) ? n.delete(ip) : n.add(ip); return n })

  /** Verify one IP's real edge colo (trace + CF-RAY cross-check). */
  const verifyIp = async (ip: string) => {
    setVerifyInfo((p) => ({ ...p, [ip]: 'loading' }))
    try {
      const data = await api<{ colo?: string | null; city?: string | null; latency?: number | null; crossVerified?: boolean }>(
        `/opt/probe?ip=${encodeURIComponent(ip)}&colo=1`,
      )
      setVerifyInfo((p) => ({
        ...p,
        [ip]: { colo: data.colo ?? undefined, city: data.city ?? undefined, latency: data.latency ?? undefined, crossVerified: !!data.crossVerified },
      }))
    } catch (e) {
      setVerifyInfo((p) => { const n = { ...p }; delete n[ip]; return n })
      setError(e instanceof Error ? e.message : 'تأیید IP ناموفق بود')
    }
  }

  /** Real download speed through the candidate IP (measured bytes). */
  const testSpeed = async (ip: string) => {
    setSpeeds((p) => ({ ...p, [ip]: 'loading' }))
    try {
      const t0 = performance.now()
      const resp = await apiRaw(`/opt/speedtest?ip=${encodeURIComponent(ip)}&bytes=2000000`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const buf = await resp.arrayBuffer()
      const ms = Math.max(1, performance.now() - t0)
      const mbps = (buf.byteLength * 8) / (1_048_576 * (ms / 1000))
      setSpeeds((p) => ({ ...p, [ip]: { mbps: Math.round(mbps * 100) / 100, ms: Math.round(ms) } }))
    } catch (e) {
      setSpeeds((p) => { const n = { ...p }; delete n[ip]; return n })
      setError(e instanceof Error ? e.message : 'تست سرعت ناموفق بود')
    }
  }

  /** Select the N fastest results. */
  const selectFastest = (n: number) => {
    const fastest = [...results]
      .filter((r) => r.latencyMs != null)
      .sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999))
      .slice(0, n)
    setSelectedIPs(new Set(fastest.map((r) => r.ip)))
  }

  const applyToWorker = async () => {
    if (!targetDep || selectedIPs.size === 0) return
    setApplying(true); setError(null)
    try {
      const getData = await api<{ success: boolean; addTxt?: string; error?: string }>('/worker-config', {
        method: 'POST',
        body: { deployment_id: targetDep, action: 'get' },
      })
      if (!getData.success) { setError(getData.error ?? 'خطا در خواندن تنظیمات'); setApplying(false); return }

      const newIPs = Array.from(selectedIPs).map((ip) => {
        const r = results.find((x) => x.ip === ip)
        const label = r?.region ?? r?.city ?? 'CF'
        return `${ip}:${r?.port ?? 443}#${label}`
      }).join('\n')

      const existing = (getData.addTxt as string) ?? ''
      const merged = existing ? `${existing}\n${newIPs}` : newIPs

      const setData = await api<{ success: boolean; error?: string }>('/worker-config', {
        method: 'POST',
        body: { deployment_id: targetDep, action: 'set_addtxt', addTxt: merged },
      })
      if (setData.success) {
        setApplied(true); setTimeout(() => setApplied(false), 3000); setSelectedIPs(new Set())
      } else { setError(setData.error ?? 'خطا در ذخیره') }
    } catch (e) { setError(e instanceof Error ? e.message : 'خطا در اتصال') }
    setApplying(false)
  }

  const injectToSub = async () => {
    if (!targetInj || selectedIPs.size === 0) return
    setInjecting(true); setError(null)
    try {
      const ips = Array.from(selectedIPs).map((ip) => {
        const r = results.find((x) => x.ip === ip)
        return r?.port ? { ip, port: r.port } : { ip }
      })
      await api(`/injector/${targetInj}`, { method: 'PATCH', body: { ips } })
      setInjected(true); setTimeout(() => setInjected(false), 3000); setSelectedIPs(new Set())
    } catch (e) { setError(e instanceof Error ? e.message : 'تزریق ناموفق بود') }
    setInjecting(false)
  }

  return (
    <div className="space-y-6">
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-2">
          <Radar className="w-5 h-5 text-brand-400" />
          <h2 className="text-lg font-bold text-white">اسکنر IP</h2>
        </div>
        <p className="text-sm text-slate-400 mb-5">
          بهترین IPهای Cloudflare یا کلین را دریافت کن، با تست واقعی (colo، TCP و سرعت) بسنج و مستقیم روی ورکر اعمال کن.
          IPهای اعمال‌شده در فیلد <span className="font-mono text-brand-300">ADD.txt</span> ورکر قرار می‌گیرند و ظرف ۳۰ ثانیه در ساب‌لینک ظاهر می‌شوند.
        </p>

        <div className="flex items-center gap-2 flex-wrap mb-4">
          {[
            { k: 'list', label: 'لیست‌های منتخب', icon: <Wifi className="w-4 h-4" /> },
            { k: 'ranges', label: 'اسکن واقعی بازه IP', icon: <ScanLine className="w-4 h-4" /> },
          ].map((t) => (
            <button key={t.k} onClick={() => setScanMode(t.k as typeof scanMode)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 border ${scanMode === t.k ? 'bg-brand-500/20 text-brand-300 border-brand-500/30' : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-white'}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {scanMode === 'ranges' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">بازه‌های IP (CIDR — هر خط یکی)</label>
              <textarea value={ranges} onChange={(e) => setRanges(e.target.value)} rows={3} dir="ltr"
                placeholder={'104.16.0.0/24\n172.64.0.0/24'} className="input-field text-sm font-mono" />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">پورت‌ها (با کاما — حداکثر ۵ تا)</label>
              <input value={ports} onChange={(e) => setPorts(e.target.value)} dir="ltr"
                placeholder="443, 2053, 2083, 2087" className="input-field text-sm font-mono" />
              <p className="text-[11px] text-slate-500 mt-2">
                اتصال TCP واقعی به هر IP:port زده می‌شود و تأخیر handshake اندازه‌گیری می‌شود.
                برای اینکه نتیجه همیشه به‌موقع برسد، حداکثر ۲۴۰ اتصال در هر اسکن اجرا می‌شود.
              </p>
            </div>
          </div>
        )}

        {scanMode === 'list' && (
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {[
              { k: 'cloudflare', label: 'پشت Cloudflare (CDN)', icon: <Cloud className="w-4 h-4" /> },
              { k: 'clean', label: 'کلین (Clean IP)', icon: <Wifi className="w-4 h-4" /> },
            ].map((t) => (
              <button key={t.k} onClick={() => setScanType(t.k as typeof scanType)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-2 border ${scanType === t.k ? 'bg-brand-500/20 text-brand-300 border-brand-500/30' : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-white'}`}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>
        )}

        <div className="mb-4">
          <Toggle checked={includeProxies} onChange={() => setIncludeProxies(!includeProxies)}
            label="دریافت لیست پروکسی از EDT-Pages/Proxy-List (HTTPS, SOCKS5, HTTP)" />
        </div>

        <div className="mb-4 p-3 rounded-xl bg-slate-800/30 border border-slate-700/30 text-xs text-slate-400 space-y-1">
          <p className="font-medium text-slate-300">منابع استفاده‌شده:</p>
          {scanType === 'cloudflare' ? (
            <>
              <p>• <a href="https://ipdb.api.030101.xyz/?type=bestcf" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline" dir="ltr">ipdb.api.030101.xyz/bestcf</a></p>
              <p>• <a href="https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline" dir="ltr">ymyuuu/IPDB bestcf.txt</a></p>
            </>
          ) : (
            <>
              <p>• <a href="https://ipdb.api.030101.xyz/?type=bestProxy" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline" dir="ltr">ipdb.api.030101.xyz/bestProxy</a></p>
              <p>• <a href="https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestproxy.txt" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline" dir="ltr">ymyuuu/IPDB bestproxy.txt</a></p>
            </>
          )}
          {includeProxies && (
            <p>• <a href="https://github.com/EDT-Pages/Proxy-List" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline" dir="ltr">EDT-Pages/Proxy-List</a> — پروکسی‌های HTTPS, SOCKS5, HTTP</p>
          )}
        </div>

        <button onClick={runScan} disabled={scanning} className="btn-primary flex items-center gap-2">
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />}
          {scanning ? 'در حال آزمایش واقعی IPها...' : 'شروع اسکن'}
        </button>
      </div>

      {error && (
        <div className="glass-card p-4 border-error-500/30 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-error-400 shrink-0" />
          <span className="text-sm text-error-300">{error}</span>
        </div>
      )}

      {scanNote && !error && (
        <div className="glass-card p-3 border-brand-500/25 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-brand-300 shrink-0" />
          <span className="text-xs text-slate-300">{scanNote}</span>
        </div>
      )}

      {results.length > 0 && (
        <div className="glass-card overflow-hidden">
          <div className="p-4 border-b border-slate-700/50 space-y-3 sm:flex sm:items-center sm:justify-between sm:flex-wrap sm:gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-sm font-bold text-white">{results.length} IP پیدا شد</h3>
              <button onClick={() => setSelectedIPs(selectedIPs.size === results.length ? new Set() : new Set(results.map((r) => r.ip)))}
                className="text-xs text-brand-400 hover:text-brand-300">
                {selectedIPs.size === results.length ? 'لغو همه' : 'انتخاب همه'}
              </button>
              <button onClick={() => selectFastest(10)} className="text-xs text-brand-400 hover:text-brand-300">
                ۱۰ تای سریع‌ترین
              </button>
              <button onClick={() => selectFastest(30)} className="text-xs text-brand-400 hover:text-brand-300">
                ۳۰ تای سریع‌ترین
              </button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <select value={targetDep} onChange={(e) => setTargetDep(e.target.value)} className="input-field text-sm py-2 sm:min-w-[180px] w-full sm:w-auto">
                <option value="">انتخاب ورکر هدف...</option>
                {deployments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <button onClick={applyToWorker} disabled={!targetDep || selectedIPs.size === 0 || applying}
                className="btn-primary flex items-center gap-2 text-sm">
                {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : applied ? <CheckCircle2 className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
                {applied ? 'اعمال شد ✓' : `اعمال روی ورکر${selectedIPs.size > 0 ? ` (${selectedIPs.size})` : ''}`}
              </button>
              {injections.length > 0 && (
                <>
                  <select value={targetInj} onChange={(e) => setTargetInj(e.target.value)} className="input-field text-sm py-2 sm:min-w-[180px] w-full sm:w-auto">
                    <option value="">تزریق به ساب سفارشی...</option>
                    {injections.map((inj) => <option key={inj.id} value={inj.id}>{inj.name}</option>)}
                  </select>
                  <button onClick={injectToSub} disabled={!targetInj || selectedIPs.size === 0 || injecting}
                    className="btn-primary flex items-center gap-2 text-sm">
                    {injecting ? <Loader2 className="w-4 h-4 animate-spin" /> : injected ? <CheckCircle2 className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                    {injected ? 'تزریق شد ✓' : `تزریق به ساب${selectedIPs.size > 0 ? ` (${selectedIPs.size})` : ''}`}
                  </button>
                </>
              )}
            </div>
          </div>
          {applied && (
            <div className="px-4 py-2 bg-green-500/10 border-b border-green-500/20 text-xs text-green-400 flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5" />
              IPها در KV ورکر ذخیره شدند — ظرف ۳۰ ثانیه ساب‌لینک به‌روز می‌شود.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50 text-xs text-slate-400">
                  <th className="text-right p-3 w-8"></th>
                  <th className="text-right p-3">IP</th>
                  <th className="text-right p-3">نوع</th>
                  <th className="text-right p-3">Ping</th>
                  <th className="text-right p-3">منطقه</th>
                  <th className="text-right p-3">منبع</th>
                  <th className="text-right p-3">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const v = verifyInfo[r.ip]
                  const sp = speeds[r.ip]
                  const colo = v && v !== 'loading' ? (v.colo ?? r.region) : r.region
                  return (
                    <tr key={`${r.ip}-${i}`} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                      <td className="p-3">
                        <input type="checkbox" checked={selectedIPs.has(r.ip)} onChange={() => toggleSelect(r.ip)} className="w-4 h-4 rounded accent-brand-500" />
                      </td>
                      <td className="p-3">
                        <span className="text-sm text-white font-mono" dir="ltr">{r.ip}{r.port ? `:${r.port}` : ''}</span>
                      </td>
                      <td className="p-3">
                        <span className={`badge text-xs ${r.type === 'cloudflare' ? 'bg-brand-500/10 text-brand-400' : 'bg-green-500/10 text-green-400'}`}>
                          {r.type === 'cloudflare' ? 'CDN' : 'Clean'}
                        </span>
                      </td>
                      <td className="p-3">
                        {r.latencyMs != null ? (
                          <span className={`text-sm font-medium ${r.latencyMs < 100 ? 'text-green-400' : r.latencyMs < 300 ? 'text-warning-400' : 'text-error-400'}`}>
                            {r.latencyMs} ms
                          </span>
                        ) : <span className="text-sm text-slate-500">—</span>}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5 flex-wrap" dir="ltr">
                          <span className="text-sm text-slate-300">{colo ?? '—'}</span>
                          {v && v !== 'loading' && v.city && <span className="text-[11px] text-slate-500">{v.city}</span>}
                          {v && v !== 'loading' && v.crossVerified && (
                            <span className="text-[10px] text-emerald-400 border border-emerald-500/30 rounded px-1">تأییدشده</span>
                          )}
                          {r.verified && !(v && v !== 'loading') && (
                            <span className="text-[10px] text-emerald-400 border border-emerald-500/30 rounded px-1">تأییدشده</span>
                          )}
                        </div>
                        {sp && sp !== 'loading' && (
                          <p className="text-[11px] text-brand-300 mt-1" dir="ltr">{sp.mbps} Mbps · {sp.ms}ms</p>
                        )}
                      </td>
                      <td className="p-3"><span className="text-xs text-slate-500 truncate max-w-[120px] block" dir="ltr">{r.source}</span></td>
                      <td className="p-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => navigator.clipboard?.writeText(r.ip)} title="کپی IP"
                            className="p-1.5 rounded-lg bg-slate-700/30 text-slate-400 hover:text-white transition-all">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => void verifyIp(r.ip)} disabled={v === 'loading'} title="تأیید colo واقعی"
                            className="p-1.5 rounded-lg bg-slate-700/30 text-slate-400 hover:text-brand-300 transition-all disabled:opacity-50">
                            {v === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radar className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => void testSpeed(r.ip)} disabled={sp === 'loading'} title="تست سرعت واقعی"
                            className="p-1.5 rounded-lg bg-slate-700/30 text-slate-400 hover:text-brand-300 transition-all disabled:opacity-50">
                            {sp === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {proxies.length > 0 && (
        <div className="glass-card overflow-hidden">
          <div className="p-4 border-b border-slate-700/50">
            <div className="flex items-center gap-2 mb-1">
              <Wifi className="w-4 h-4 text-green-400" />
              <h3 className="text-sm font-bold text-white">{proxies.length} پروکسی از EDT-Pages/Proxy-List</h3>
            </div>
            <p className="text-xs text-slate-400">پروکسی‌های HTTPS، SOCKS5 و HTTP آماده استفاده در فیلد Proxy IP ورکر</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50 text-xs text-slate-400">
                  <th className="text-right p-3">آدرس پروکسی</th>
                  <th className="text-right p-3">پروتکل</th>
                  <th className="text-right p-3">کشور</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((p, i) => (
                  <tr key={`${p.ip}-${i}`} className="border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
                    <td className="p-3"><span className="text-sm text-white font-mono" dir="ltr">{p.proxy}</span></td>
                    <td className="p-3">
                      <span className={`badge text-xs ${p.protocol === 'socks5' ? 'bg-purple-500/10 text-purple-400' : p.protocol === 'https' ? 'bg-brand-500/10 text-brand-400' : 'bg-amber-500/10 text-amber-400'}`}>
                        {p.protocol}
                      </span>
                    </td>
                    <td className="p-3"><span className="text-sm text-slate-300" dir="ltr">{p.region ?? '—'}</span></td>
                    <td className="p-3">
                      <button onClick={() => navigator.clipboard?.writeText(p.proxy ?? '')}
                        className="p-1.5 rounded-lg bg-slate-700/30 text-slate-400 hover:text-white transition-all">
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

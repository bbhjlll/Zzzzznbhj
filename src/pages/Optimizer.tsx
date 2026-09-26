import { useCallback, useEffect, useState, useRef } from 'react'
import { Zap, Play, Copy, Trash2, RefreshCw, Check, Syringe, Download, Sliders, Link } from 'lucide-react'
import { api, API_BASE } from '../lib/api'
import { FRAGMENT_PRESETS, FM_PRESETS, CS_PRESETS } from '../../worker/presets'
import type { OptimizerJob, OptimizerNode, InjectedSub } from '../lib/types'

const statusLabel: Record<OptimizerJob['status'], string> = {
  pending: 'در صف',
  running: 'در حال تست',
  done: 'تکمیل شد',
  failed: 'ناموفق',
}

export default function Optimizer() {
  const [name, setName] = useState('')
  const [input, setInput] = useState('')
  const [jobs, setJobs] = useState<OptimizerJob[]>([])
  const [detail, setDetail] = useState<OptimizerJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [keepDead, setKeepDead] = useState(false)

  // ── Injection (shared source + injection-specific) ──
  const [injMode, setInjMode] = useState(false)
  const [injName, setInjName] = useState('')
  const [injRotate, setInjRotate] = useState('')
  const [injIps, setInjIps] = useState('')
  const [injProxies, setInjProxies] = useState('')
  const [injections, setInjections] = useState<InjectedSub[]>([])
  const [injBusy, setInjBusy] = useState(false)
  const [injError, setInjError] = useState<string | null>(null)

  // ── Fragment injection ──
  const [fragEnabled, setFragEnabled] = useState(false)
  const [fragPreset, setFragPreset] = useState('')
  const [fragFm, setFragFm] = useState('')
  const [fragCs, setFragCs] = useState('')

  // ── EDT-Pages proxy auto-fetch ──
  const [proxyProtocol, setProxyProtocol] = useState<'socks5' | 'https'>('socks5')
  const [proxyLists, setProxyLists] = useState<Record<string, string[]>>({})
  const [proxyLoading, setProxyLoading] = useState(false)
  const [proxyError, setProxyError] = useState<string | null>(null)
  const proxyFetched = useRef(false)

  // Multiple CDN sources — jsDelivr is more CORS-friendly on mobile than raw.githubusercontent.com
  const EDT_SOURCES = [
    `https://cdn.jsdelivr.net/gh/EDT-Pages/Proxy-List@main/data/${proxyProtocol}.json`,
    `https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/${proxyProtocol}.json`,
  ]

  const fetchEtdProxies = async () => {
    setProxyLoading(true)
    setProxyError(null)
    for (const url of EDT_SOURCES) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 30000)
        const resp = await fetch(url, { signal: ctrl.signal })
        clearTimeout(t)
        if (!resp.ok) continue
        const data = await resp.json() as Array<{ proxy: string; country?: string }>
        const grouped: Record<string, string[]> = {}
        for (const p of data) {
          if (p.country) {
            const key = p.country.toLowerCase()
            if (!grouped[key]) grouped[key] = []
            grouped[key].push(p.proxy)
          }
        }
        if (Object.keys(grouped).length > 0) {
          setProxyLists(grouped)
          setProxyLoading(false)
          setProxyError(null)
          return
        }
      } catch { /* try next source */ }
    }
    setProxyError('دریافت پروکسی ناموفق بود — اینترنت خود را بررسی کنید')
    setProxyLoading(false)
  }

  useEffect(() => {
    if (proxyFetched.current) return
    proxyFetched.current = true
    fetchEtdProxies()
  }, [])

  const loadInjections = useCallback(async () => {
    try {
      const { data } = await api<{ data: InjectedSub[] }>('/injector')
      setInjections(data ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadInjections() }, [loadInjections])

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: OptimizerJob[] }>('/optimizer')
      setJobs(data ?? [])
    } catch { /* ignore */ }
  }, [])

  // `jobs` is read through a ref, not a dependency: depending on the state
  // array would re-run this effect on every `setJobs` (which always produces a
  // fresh array), i.e. a runaway fetch loop against /api/optimizer.
  const jobsRef = useRef(jobs)
  useEffect(() => { jobsRef.current = jobs }, [jobs])

  useEffect(() => {
    load()
    const t = setInterval(() => {
      if (jobsRef.current.some((j) => j.status === 'pending' || j.status === 'running')) load()
    }, 3000)
    return () => clearInterval(t)
  }, [load])

  const run = async () => {
    if (!input.trim()) { setError('لینک ساب یا کانفیگ‌ها را وارد کنید'); return }
    setBusy(true); setError(null)
    try {
      await api('/optimizer', { method: 'POST', body: { name: name.trim(), input: input.trim(), options: { keep_dead: keepDead } } })
      setInput(''); setName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در اجرا')
    } finally {
      setBusy(false)
    }
  }

  const runInjection = async () => {
    if (!input.trim()) { setInjError('منبع را وارد کنید'); return }
    setInjBusy(true); setInjError(null)
    try {
      const ips = injIps.split(/[\n,]/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [ip, port] = l.split(':')
        return port ? { ip, port: Number(port) } : { ip }
      })
      const proxies = injProxies.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(https?|socks5):\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+):(\d+)$/i)
        if (!m) return null
        return {
          type: m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http',
          server: m[4], port: Number(m[5]),
          ...(m[2] ? { username: m[2] } : {}), ...(m[3] ? { password: m[3] } : {}),
        }
      }).filter(Boolean)
      await api('/injector', { method: 'POST', body: { name: injName.trim(), source: input.trim(), ips, proxies, rotate_minutes: injRotate ? Number(injRotate) : null, ...(fragEnabled ? { fragment: { enabled: true, fm: fragFm || undefined, cs: fragCs || undefined, preset: fragPreset || undefined } } : {}) } })
      setInjIps(''); setInjProxies(''); setInjName('')
      await loadInjections()
    } catch (e) {
      setInjError(e instanceof Error ? e.message : 'خطا در ساخت')
    }
    setInjBusy(false)
  }

  const openDetail = async (id: string) => {
    try {
      const { data } = await api<{ data: OptimizerJob }>(`/optimizer/${id}`)
      setDetail(data)
    } catch { /* ignore */ }
  }

  const remove = async (id: string, name: string) => {
    if (!confirm(`بهینه‌سازی «${name}» حذف شود؟`)) return
    await api(`/optimizer/${id}`, { method: 'DELETE' }).catch(() => null)
    if (detail?.id === id) setDetail(null)
    load()
  }

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text).catch(() => null)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const subUrl = (token: string) => `${window.location.origin}${API_BASE}/sub/opt/${token}`
  const fmtUrl = (base: string, target?: string) => (target ? `${base}?target=${target}` : base)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
          <Zap className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">بهینه‌ساز کانفیگ</h1>
          <p className="text-sm text-slate-500">تست واقعی، بهینه‌سازی، تزریق IP/پروکسی — همه در یکجا</p>
        </div>
      </div>

      {/* ═══════ Unified Card ═══════ */}
      <div className="card p-5 space-y-4">
        {/* Name */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-slate-400 mb-1 block">نام (اختیاری)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً ساب اصلی من" className="input-field" />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none" data-guide="o-keep-dead">
              <input type="checkbox" checked={keepDead} onChange={(e) => setKeepDead(e.target.checked)} className="w-4 h-4 rounded accent-brand-500" />
              نگه‌داشتن نودهای مرده
            </label>
          </div>
        </div>

        {/* Source textarea (shared) */}
        <div>
          <label className="text-sm text-slate-400 mb-1 block">لینک ساب یا کانفیگ‌ها</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            dir="ltr"
            data-guide="o-input"
            placeholder={'یک یا چند لینک ساب، جدا شده با خط جدید:\nhttps://example.com/sub\nvless://uuid@host:443?...\nvmess://base64...\ntrojan://...\nss://...'}
            className="input-field font-mono text-xs"
          />
          <p className="text-[11px] text-slate-600 mt-1">پشتیبانی از: لینک ساب · vless · vmess · trojan · shadowsocks · sing-box JSON · Clash YAML</p>
        </div>

        {error && <p className="text-sm text-error-400">{error}</p>}

        {/* Action buttons row */}
        <div className="flex gap-2 flex-wrap">
          <button onClick={run} disabled={busy || !input.trim()} data-guide="o-start"
            className="btn-primary flex-1 min-w-[180px] flex items-center justify-center gap-2">
            <Play className="w-4 h-4" />
            {busy ? 'در حال ارسال...' : 'شروع بهینه‌سازی'}
          </button>
          <button onClick={() => setInjMode(!injMode)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border transition-all ${injMode ? 'bg-brand-500/20 text-brand-300 border-brand-500/40' : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:text-white'}`}>
            <Syringe className="w-4 h-4" />
            تزریق IP و پروکسی
          </button>
        </div>

        {/* ═══════ Injection settings (collapsible) ═══════ */}
        {injMode && (
          <div className="border border-slate-800 rounded-xl p-4 bg-slate-900/40 space-y-4">
            <p className="text-xs text-slate-400">IPهای ترجیحی entry نودها را ثابت می‌کنند (دور زدن فیلتر) و پروکسی‌های EDT خودکار دریافت می‌شوند.</p>

            {/* IPs + Proxies side by side */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
              <div>
                <label className="text-sm text-slate-400 mb-1 block">IPهای ترجیحی (هر خط یکی)</label>
                <textarea value={injIps} onChange={(e) => setInjIps(e.target.value)} rows={3} dir="ltr"
                  placeholder={'104.16.0.1\n172.64.0.1:2053'} className="input-field font-mono text-xs" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-slate-400">پروکسی‌های خروجی</label>
                  <div className="flex items-center gap-2">
                    <select value={proxyProtocol} onChange={(e) => setProxyProtocol(e.target.value as 'socks5' | 'https')}
                      className="text-[11px] bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300">
                      <option value="socks5">SOCKS5</option>
                      <option value="https">HTTPS</option>
                    </select>
                    <button onClick={fetchEtdProxies} disabled={proxyLoading}
                      className="text-[11px] text-brand-400 hover:text-brand-300 flex items-center gap-1">
                      <Download className={`w-3 h-3 ${proxyLoading ? 'animate-spin' : ''}`} />
                      {proxyLoading ? '...' : 'EDT'}
                    </button>
                  </div>
                </div>
                <textarea value={injProxies} onChange={(e) => setInjProxies(e.target.value)} rows={3} dir="ltr"
                  placeholder={'socks5://user:pass@1.2.3.4:1080\nhttp://5.6.7.8:8080'} className="input-field font-mono text-xs" />
                {/* EDT quick-add chips */}
                {proxyError && (
                  <p className="mt-1 text-[10px] text-red-400">{proxyError}</p>
                )}
                {Object.keys(proxyLists).length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] text-slate-500">پروکسی‌های زنده EDT — کلیک کنید تا اضافه شوند:</p>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(proxyLists).slice(0, 12).map(([country, proxies]) => (
                        <button key={country}
                          onClick={() => {
                            const first = proxies[0]
                            if (first && !injProxies.includes(first)) {
                              setInjProxies((p) => p ? `${p}\n${first}` : first)
                            }
                          }}
                          className="px-2 py-0.5 rounded text-[10px] bg-slate-800/60 border border-slate-700 text-slate-300 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors">
                          {country.toUpperCase()} ({proxies.length})
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Fragment toggle */}
            <div className="border-t border-slate-800 pt-3">
              <button onClick={() => setFragEnabled(!fragEnabled)} className="flex items-center gap-2 text-sm text-slate-300">
                <span className={`w-9 h-5 rounded-full transition-colors relative ${fragEnabled ? 'bg-brand-500' : 'bg-slate-700'}`}>
                  <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                    style={{ right: fragEnabled ? '2px' : '18px' }} />
                </span>
                🧩 فرگمنت (TLS Fragment) — تزریق در JSON sing-box
              </button>
              {fragEnabled && (
                <div className="mt-3 space-y-3">
                  <label className="block max-w-xs">
                    <span className="text-xs text-slate-400 mb-1 block">پریست</span>
                    <select value={fragPreset} onChange={(e) => {
                      setFragPreset(e.target.value)
                      const preset = FRAGMENT_PRESETS.find((p) => p.code === e.target.value)
                      if (preset) { setFragFm(preset.code); setFragCs('') }
                    }} className="input-field text-sm py-2 w-full">
                      <option value="">دستی</option>
                      {FRAGMENT_PRESETS.map((p) => <option key={p.code} value={p.code}>{p.flag} {p.label}</option>)}
                    </select>
                  </label>
                  <div className="flex gap-1.5 flex-wrap">
                    {FM_PRESETS.map((p) => (
                      <button key={p.code} onClick={() => setFragFm(p.json)}
                        className="px-2.5 py-1 rounded-lg bg-slate-800/60 text-[11px] text-slate-300 hover:text-brand-300 border border-slate-700 transition-colors">
                        ⚡ {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
                    <div>
                      <label className="text-xs text-slate-400 mb-1 block">fm= JSON</label>
                      <textarea value={fragFm} onChange={(e) => setFragFm(e.target.value)} rows={2}
                        className="input-field font-mono text-[11px] w-full" dir="ltr" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 mb-1 block">cs= Cipher Suite</label>
                      <textarea value={fragCs} onChange={(e) => setFragCs(e.target.value)} rows={2}
                        className="input-field font-mono text-[11px] w-full" dir="ltr" />
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {CS_PRESETS.map((p) => (
                      <button key={p.code} onClick={() => setFragCs(p.value)}
                        className="px-2.5 py-1 rounded-lg bg-slate-800/60 text-[11px] text-slate-300 hover:text-emerald-300 border border-slate-700 transition-colors">
                        🔐 {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Injection name + rotate + create button */}
            <div className="grid grid-cols-1 sm:flex sm:gap-2 sm:flex-wrap items-end gap-2">
              <input value={injName} onChange={(e) => setInjName(e.target.value)} placeholder="نام ساب (اختیاری)" className="input-field text-sm sm:flex-1 sm:min-w-[140px]" />
              <input value={injRotate} onChange={(e) => setInjRotate(e.target.value)} placeholder="چرخش IP (دقیقه)" className="input-field text-sm sm:w-[130px]" />
              <button onClick={runInjection} disabled={injBusy || !input.trim()} className="btn-primary text-sm flex items-center justify-center gap-2">
                <Syringe className="w-4 h-4" />{injBusy ? 'در حال ساخت...' : 'ساخت ساب تزریق‌شده'}
              </button>
            </div>
            {injError && <p className="text-sm text-error-400">{injError}</p>}
          </div>
        )}
      </div>

      {/* ═══════ Injected Subs (only when injection mode used) ═══════ */}
      {injections.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Link className="w-5 h-5 text-brand-400" />
            ساب‌های تزریق‌شده
          </h2>
          {injections.map((inj) => {
            const injSub = `${window.location.origin}${API_BASE}/sub/inject/${inj.sub_token}`
            const clashUrl = fmtUrl(injSub, 'clash')
            const singboxUrl = fmtUrl(injSub, 'singbox')
            return (
              <div key={inj.id} className="card p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm text-white font-medium">{inj.name}</p>
                    <p className="text-xs text-slate-500">{inj.ips.length} IP · {inj.proxies.length} پروکسی</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => copy(injSub, inj.id)} className="px-3 py-1.5 rounded-lg bg-slate-800/60 text-xs text-slate-300 hover:text-brand-300 flex items-center gap-1">
                      {copied === inj.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} ساب
                    </button>
                    <button onClick={() => copy(clashUrl, inj.id + '-c')} className="px-3 py-1.5 rounded-lg bg-slate-800/60 text-xs text-slate-300 hover:text-brand-300 flex items-center gap-1">
                      {copied === inj.id + '-c' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} Clash
                    </button>
                    <button onClick={() => copy(singboxUrl, inj.id + '-sb')} className="px-3 py-1.5 rounded-lg bg-slate-800/60 text-xs text-slate-300 hover:text-brand-300 flex items-center gap-1">
                      {copied === inj.id + '-sb' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} Sing-box
                    </button>
                    <button onClick={async () => { if (!confirm(`ساب «${inj.name}» حذف شود؟`)) return; await api(`/injector/${inj.id}`, { method: 'DELETE' }).catch(() => null); loadInjections() }}
                      className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500 font-mono truncate mt-2" dir="ltr">{injSub}</p>
              </div>
            )
          })}
        </div>
      )}

      {/* ═══════ Jobs History ═══════ */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Sliders className="w-5 h-5 text-amber-400" />
            تاریخچه بهینه‌سازی
          </h2>
          <button onClick={load} className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-white">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {jobs.length === 0 && (
          <div className="text-center py-12">
            <Zap className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400 text-sm mb-1">هنوز بهینه‌سازی‌ای انجام نشده</p>
            <p className="text-xs text-slate-600">لینک ساب خود را وارد کنید و روی «شروع بهینه‌سازی» بزنید</p>
          </div>
        )}

        {jobs.map((job) => (
          <div key={job.id} className="card p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-white font-medium truncate">{job.name}</p>
                <p className="text-xs text-slate-500 mt-1">
                  {job.status === 'done' && `${job.nodes_alive} سالم از ${job.nodes_total} نود`}
                  {job.status === 'running' && 'در حال تست نودها...'}
                  {job.status === 'pending' && 'در صف اجرا...'}
                  {job.status === 'failed' && (job.error_message ?? 'ناموفق')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                  job.status === 'done' ? 'bg-emerald-500/15 text-emerald-400' :
                  job.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                  'bg-amber-500/15 text-amber-400 animate-pulse'
                }`}>
                  {statusLabel[job.status]}
                </span>
                {job.status === 'done' && job.nodes_alive > 0 && (
                  <>
                    {([['', 'ساب'], ['clash', 'Clash'], ['singbox', 'Sing-box'], ['plain', 'Plain']] as const).map(([t, label]) => (
                      <button key={label} onClick={() => copy(fmtUrl(subUrl(job.sub_token), t), job.id + (t || '-b'))}
                        data-guide="o-format"
                        className="px-2 py-1.5 rounded-lg bg-slate-800/60 text-xs text-slate-300 hover:text-brand-300"
                        title={`کپی لینک ${label}`}>
                        {copied === job.id + (t || '-b') ? <Check className="w-3 h-3 text-emerald-400 inline" /> : null} {label}
                      </button>
                    ))}
                    <button onClick={() => openDetail(job.id)} className="text-xs px-3 py-1.5 rounded-lg bg-brand-600/20 text-brand-300 hover:bg-brand-600/30">
                      نودها
                    </button>
                  </>
                )}
                <button onClick={() => remove(job.id, job.name)} className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-red-400">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            {job.status === 'done' && job.nodes_alive > 0 && (
              <p className="text-xs text-slate-500 mt-3 font-mono truncate" dir="ltr">{subUrl(job.sub_token)}</p>
            )}
          </div>
        ))}
      </div>

      {/* Node latency detail */}
      {detail && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">نودهای سالم — {detail.name}</h3>
            <button onClick={() => setDetail(null)} className="text-xs text-slate-500 hover:text-white">بستن</button>
          </div>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {(detail.result_nodes ?? []).map((n: OptimizerNode, i: number) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-900/60 border border-slate-800">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{n.name}</p>
                  <p className="text-xs text-slate-500 font-mono" dir="ltr">{n.proto} · {n.host}:{n.port}</p>
                </div>
                <span className={`text-xs font-bold px-2 py-1 rounded-md ${
                  n.latencyMs < 300 ? 'bg-emerald-500/15 text-emerald-400' :
                  n.latencyMs < 1000 ? 'bg-amber-500/15 text-amber-400' :
                  'bg-red-500/15 text-red-400'
                }`}>
                  {n.latencyMs}ms
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

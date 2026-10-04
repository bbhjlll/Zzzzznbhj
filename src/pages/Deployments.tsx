import { useEffect, useState, useCallback, useRef } from 'react'
import { api, ApiError } from '../lib/api'
import type { Deployment, CFToken, SubGroup, InjectedSub } from '../lib/types'
import type { PreferredIP, ProxySpec } from '../lib/types'
import {
  Cloud, Loader2, CheckCircle2, XCircle, Clock, Trash2, ExternalLink,
  KeyRound, Rocket, Database, Copy, Check, Smartphone, Settings2,
  Power, PowerOff, AlertTriangle, Save, Eye, EyeOff, RefreshCw, Radio,
  Globe, Shield, Network, Server, Radar, ScanLine, Wifi, Github,
  ArrowRight, ChevronDown, ChevronUp, Lock, Layers, Zap, Link2,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import PanelDeploys from '../components/PanelDeploys'
import IpScanner from '../components/IpScanner'

// ── Types ─────────────────────────────────────────────────────────────────
// Edgetunnel config uses Chinese keys — we map them to a typed interface
interface EdgeConfig {
  UUID: string
  HOST: string
  HOSTS: string[]
  PATH: string
  协议类型: string // "vless" | "trojan" | "ss"
  传输协议: string // "ws" | "grpc" | "xhttp"
  gRPC模式: string
  gRPCUserAgent: string
  跳过证书验证: boolean
  启用0RTT: boolean
  TLS分片: string | null
  随机路径: boolean
  ECH: boolean
  ECHConfig: { DNS: string; SNI: string }
  SS: { 加密方式: string; TLS: boolean }
  Fingerprint: string
  优选订阅生成: {
    local: boolean
    本地IP库: { 随机IP: boolean; 随机数量: number; 指定端口: number }
    SUB: string | null
    SUBNAME: string
    SUBUpdateTime: number
    TOKEN: string
  }
  订阅转换配置: {
    SUBAPI: string
    SUBCONFIG: string
    SUBEMOJI: boolean
    SUBLIST: boolean
    UDP: boolean
    XUDP: boolean
    TLS13: boolean
    APPEND_TYPE: boolean
    SORT: boolean
  }
  反代: {
    proxyip: string
    SOCKS5: { 启用: string | null; 全局: boolean; 账号: string; 白名单: string[] }
    路径模板: Record<string, unknown>
  }
  TG: { 启用: boolean; BotToken: string | null; ChatID: string | null }
  CF: { Email: string | null; GlobalAPIKey: string | null; AccountID: string | null; APIToken: string | null; UsageAPI: string | null }
  disabled: boolean
  [key: string]: unknown
}

interface ScanResult {
  ip: string; latencyMs: number | null; status: 'ok' | 'timeout' | 'error'
  region?: string; city?: string; verified?: boolean; httpLatency?: number | null
  type: 'cloudflare' | 'clean' | 'proxy'; source: string
  port?: number; protocol?: string; proxy?: string
}

// ── Constants ─────────────────────────────────────────────────────────────
const EDGE_BASE = '/api'

/** Call a panel API endpoint; returns parsed JSON or null on failure. */
async function edgePost<T = Record<string, unknown>>(path: string, body: unknown): Promise<T | null> {
  try {
    return await api<T>(path, { method: 'POST', body })
  } catch {
    return null
  }
}

const DEFAULT_CONFIG: EdgeConfig = {
  UUID: '', HOST: '', HOSTS: [], PATH: '/',
  协议类型: 'vless', 传输协议: 'ws', gRPC模式: 'gun', gRPCUserAgent: 'Mozilla/5.0',
  跳过证书验证: false, 启用0RTT: false, TLS分片: null, 随机路径: false,
  ECH: false, ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
  SS: { 加密方式: 'aes-128-gcm', TLS: true },
  Fingerprint: 'chrome',
  优选订阅生成: {
    local: true, 本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 },
    SUB: null, SUBNAME: 'edgetunnel', SUBUpdateTime: 3, TOKEN: '',
  },
  订阅转换配置: {
    SUBAPI: 'https://subapi.edt-pages.workers.dev',
    SUBCONFIG: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/main/Clash/config/ACL4SSR_Online_Mini_MultiMode.ini',
    SUBEMOJI: false, SUBLIST: false, UDP: false, XUDP: false, TLS13: false, APPEND_TYPE: false, SORT: false,
  },
  反代: {
    proxyip: 'auto',
    SOCKS5: { 启用: null, 全局: false, 账号: '', 白名单: [] },
    路径模板: {},
  },
  TG: { 启用: false, BotToken: null, ChatID: null },
  CF: { Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null },
  disabled: false,
}

const SUB_TARGETS = [
  { key: 'clash', label: 'Clash' },
  { key: 'singbox', label: 'Sing-Box' },
  { key: 'v2rayng', label: 'v2rayNG' },
  { key: 'shadowrocket', label: 'Shadowrocket' },
  { key: 'surge', label: 'Surge' },
]

const IRAN_OPS = [
  { key: 'ispMobile', label: 'همراه اول (MCI)', color: 'bg-green-400' },
  { key: 'ispUnicom', label: 'ایرانسل', color: 'bg-yellow-400' },
  { key: 'ispTelecom', label: 'رایتل', color: 'bg-blue-400' },
  { key: 'ispMokhaberat', label: 'مخابرات (ثابت)', color: 'bg-purple-400' },
  { key: 'ispShatel', label: 'شاتل', color: 'bg-orange-400' },
  { key: 'ispAsiatek', label: 'آسیاتک', color: 'bg-red-400' },
  { key: 'ispParsonline', label: 'پارس آنلاین', color: 'bg-teal-400' },
  { key: 'ispHiweb', label: 'های‌وب', color: 'bg-pink-400' },
]

function mergeConfig(partial: Partial<EdgeConfig>): EdgeConfig {
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, unknown>
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) merged[k] = v
  }
  return merged as unknown as EdgeConfig
}

// ── Small reusable UI ────────────────────────────────────────────────────
function GhLink({ url, label }: { url: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-brand-400 transition-colors">
      <Github className="w-3 h-3" />{label}
    </a>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-sm text-slate-300">{label}</span>
      <button type="button" onClick={onChange}
        className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-brand-500' : 'bg-slate-600'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'right-0.5' : 'left-0.5'}`} />
      </button>
    </div>
  )
}

function Field({ label, value, onChange, placeholder, ltr, mono, textarea, rows }:
  { label: string; value: string; onChange: (v: string) => void; placeholder?: string; ltr?: boolean; mono?: boolean; textarea?: boolean; rows?: number }) {
  return (
    <div>
      <label className="text-xs text-slate-400 mb-1 block">{label}</label>
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className={`input-field text-sm ${mono ? 'font-mono' : ''}`} rows={rows ?? 2} dir={ltr ? 'ltr' : undefined} />
      ) : (
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
          className={`input-field text-sm ${mono ? 'font-mono' : ''}`} dir={ltr ? 'ltr' : undefined} />
      )}
    </div>
  )
}

function Sect({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-bold text-brand-300 mb-3 flex items-center gap-2">{icon}{title}</h3>
      {children}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
type DeployTab = 'workers' | 'panels' | 'scanner'

/** Tabs shown above the page (the dedicated panel sits next to the workers). */
const DEPLOY_TABS: Array<{ key: DeployTab; label: string }> = [
  { key: 'workers', label: 'ورکرها' },
  { key: 'panels', label: 'پنل اختصاصی' },
  { key: 'scanner', label: 'اسکنر IP' },
]

export default function Deployments() {
  // `?tab=panels` deep-links the dedicated panel (dashboard cards link there).
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  const tab: DeployTab = requested === 'panels' || requested === 'scanner' ? requested : 'workers'
  const selectTab = (next: DeployTab) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'workers') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">ورکرها و پنل</h1>
          <p className="text-slate-400 text-sm mt-1">
            مدیریت کامل ورکرهای کلودفلر، پنل اختصاصی روی Railway/Render، تنظیمات زنده و اسکنر IP
          </p>
        </div>
        <Link to="/deploy" className="btn-primary flex items-center gap-2">
          <Rocket className="w-4 h-4" /> استقرار جدید
        </Link>
      </div>

      <div className="flex items-center gap-1 bg-slate-800/50 rounded-xl p-1 border border-slate-700/50 w-fit">
        {DEPLOY_TABS.map((t) => (
          <button key={t.key} onClick={() => selectTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${tab === t.key ? 'bg-brand-500/20 text-brand-300' : 'text-slate-400 hover:text-white'}`}>
            {t.key === 'workers' ? <Server className="w-4 h-4" /> : t.key === 'panels' ? <Cloud className="w-4 h-4" /> : <Radar className="w-4 h-4" />}
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'workers' ? <WorkersTab /> : tab === 'panels' ? <PanelDeploys variant="full" /> : <IpScanner />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKERS TAB
// ═══════════════════════════════════════════════════════════════════════════
function WorkersTab() {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [tokens, setTokens] = useState<CFToken[]>([])
  const [loading, setLoading] = useState(true)
  const [configModal, setConfigModal] = useState<Deployment | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [updateMsg, setUpdateMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const [copiedSub, setCopiedSub] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [deps, toks] = await Promise.all([
      api<{ data: Deployment[] }>('/deployments').catch(() => ({ data: [] as Deployment[] })),
      api<{ data: CFToken[] }>('/tokens').catch(() => ({ data: [] as CFToken[] })),
    ])
    setDeployments(deps.data ?? [])
    setTokens((toks.data ?? []).filter((t) => t.status === 'active'))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Keep a ref in sync so the polling interval below always sees the latest list
  // without needing to be re-created (and re-subscribed) on every render.
  const deploymentsRef = useRef<Deployment[]>([])
  useEffect(() => { deploymentsRef.current = deployments }, [deployments])

  // Lightweight background refresh — a deployment can finish on Cloudflare's side
  // (and be marked "deployed" in the DB by the cf-deploy edge function) at any time,
  // including while the user is not on the deploy wizard screen. Without this,
  // a worker that is actually live keeps showing "در حال استقرار" forever until the
  // user manually reloads the page. We poll only the rows that are still in-flight
  // (deploying/pending) and merge fresh data in, so finished ones flip to "مستقر"
  // automatically without a full page reload.
  useEffect(() => {
    const interval = setInterval(async () => {
      const pendingIds = deploymentsRef.current
        .filter((d) => d.status === 'deploying' || d.status === 'pending')
        .map((d) => d.id)
      if (pendingIds.length === 0) return
      const { data } = await api<{ data: Deployment[] }>(`/deployments?ids=${pendingIds.join(',')}`).catch(() => ({ data: [] as Deployment[] }))
      if (!data || data.length === 0) return
      setDeployments((prev) => {
        const byId = new Map((data as Deployment[]).map((d) => [d.id, d]))
        return prev.map((d) => byId.get(d.id) ?? d)
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`ورکر «${name}» حذف شود؟`)) return
    try { await api(`/deployments/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    load()
  }

  const toggleWorker = async (dep: Deployment) => {
    setTogglingId(dep.id)
    try {
      const data = await api<{ success: boolean; disabled: boolean }>('/worker-config', {
        method: 'POST',
        body: { deployment_id: dep.id, action: 'toggle' },
      })
      if (data.success) {
        setDeployments((prev) => prev.map((d) =>
          d.id === dep.id ? { ...d, config: { ...((d.config as Record<string, unknown>) ?? {}), disabled: data.disabled } } : d
        ))
      }
    } catch { /* ignore */ }
    setTogglingId(null)
  }

  // Pull the worker's source from its upstream repo again. The D1 database,
// R2 bucket and every variable stay exactly as they are — only the code is
// replaced, and an unchanged repo uploads nothing.
  const updateFromRepo = async (dep: Deployment) => {
    setUpdatingId(dep.id)
    setUpdateMsg(null)
    try {
      const res = await api<{ updated: boolean; message: string }>('/deployments/update', {
        method: 'POST',
        body: { deployment_id: dep.id },
      })
      setUpdateMsg({ id: dep.id, text: res.message, ok: true })
      await load()
    } catch (e) {
      setUpdateMsg({ id: dep.id, text: e instanceof Error ? e.message : 'به‌روزرسانی ناموفق بود', ok: false })
    }
    setUpdatingId(null)
  }

  const copySub = async (url: string, key: string) => {
    try { await navigator.clipboard.writeText(url); setCopiedSub(key); setTimeout(() => setCopiedSub(null), 2000) } catch {}
  }

  const statusMap = {
    deployed: { label: 'مستقر', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30', Icon: CheckCircle2 },
    failed: { label: 'ناموفق', color: 'text-error-400', bg: 'bg-error-500/10', border: 'border-error-500/30', Icon: XCircle },
    deploying: { label: 'در حال استقرار', color: 'text-warning-400', bg: 'bg-warning-500/10', border: 'border-warning-500/30', Icon: Loader2 },
    pending: { label: 'در انتظار', color: 'text-slate-400', bg: 'bg-slate-700/30', border: 'border-slate-600/30', Icon: Clock },
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>

  if (deployments.length === 0) {
    return (
      <div className="glass-card p-12 text-center">
        <div className="inline-flex w-16 h-16 rounded-2xl bg-slate-800/50 items-center justify-center mb-4">
          <Cloud className="w-8 h-8 text-slate-500" />
        </div>
        <h3 className="text-lg font-bold text-white mb-2">هنوز ورکری مستقر نشده</h3>
        <p className="text-slate-400 text-sm mb-6">اولین ورکر خود را روی کلودفلر مستقر کنید</p>
        <Link to="/deploy" className="btn-primary inline-flex items-center gap-2"><Rocket className="w-4 h-4" /> شروع استقرار</Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <GroupSubPanel deployments={deployments.filter((d) => d.status === 'deployed')} onChanged={load} />

      {tokens.length === 0 && (
        <div className="glass-card p-4 border-warning-500/30 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm text-warning-300 font-medium">هیچ توکن فعالی وجود ندارد</p>
            <p className="text-xs text-slate-400 mt-1">برای خواندن و نوشتن تنظیمات ورکر، یک توکن با دسترسی <span className="font-mono text-warning-300">Workers KV Storage:Edit</span> اضافه کنید.</p>
            <Link to="/tokens" className="text-xs text-brand-400 hover:underline mt-1 inline-block">رفتن به مدیریت توکن ←</Link>
          </div>
        </div>
      )}

      {deployments.map((dep, i) => {
        const st = statusMap[dep.status] ?? statusMap.pending
        const StatusIcon = st.Icon
        const cfg = (dep.config as Record<string, unknown> | null) ?? {}
        const isDisabled = !!cfg.disabled
        const isExpanded = expandedId === dep.id
        const isToggling = togglingId === dep.id
        // KV-backed sources (edgetunnel/custom/NEXUS) have the KV config panel;
        // D1 panels (ZEUS) keep everything in their own UI, so we hide it.
        const isKvSource = !!dep.kv_namespace_id

        return (
          <div key={dep.id} className="glass-card animate-slide-up" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="p-5 flex items-center gap-4 flex-wrap">
              <div className={`p-3 rounded-xl ${st.bg} ${st.border} border shrink-0`}>
                <StatusIcon className={`w-5 h-5 ${st.color} ${dep.status === 'deploying' ? 'animate-spin' : ''}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-white" dir="ltr">{dep.name}</h3>
                  <span className={`badge ${st.bg} ${st.color} ${st.border} border`}>{isDisabled ? 'غیرفعال' : st.label}</span>
                  <span className="badge bg-slate-700/30 text-slate-400">{dep.method === 'workers' ? 'Workers' : 'Pages'}</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(dep.created_at).toLocaleString('fa-IR')}
                  {typeof cfg.source_synced_at === 'string' && cfg.source_synced_at && (
                    <span className="text-slate-600"> · آخرین همگام‌سازی با مخزن: {new Date(cfg.source_synced_at).toLocaleString('fa-IR')}</span>
                  )}
                </p>
                {updateMsg?.id === dep.id && (
                  <p className={`text-xs mt-1 ${updateMsg.ok ? 'text-emerald-400' : 'text-error-400'}`}>{updateMsg.text}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {dep.status === 'deployed' && isKvSource && (
                  <button onClick={() => toggleWorker(dep)} disabled={isToggling}
                    title={isDisabled ? 'فعال‌سازی' : 'غیرفعال‌سازی'}
                    className={`p-2 rounded-lg transition-all disabled:opacity-50 ${isDisabled ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20' : 'bg-slate-700/30 text-slate-400 hover:bg-slate-700/50'}`}>
                    {isToggling ? <Loader2 className="w-4 h-4 animate-spin" /> : isDisabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                  </button>
                )}
                {dep.status === 'deployed' && dep.method === 'workers' && (
                  <button onClick={() => updateFromRepo(dep)} disabled={updatingId === dep.id}
                    title="به‌روزرسانی کد از مخزن اصلی (دیتابیس و متغیرها دست‌نخورده)"
                    className="p-2 rounded-lg bg-slate-700/30 text-slate-400 hover:bg-brand-500/10 hover:text-brand-400 transition-all disabled:opacity-50">
                    {updatingId === dep.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  </button>
                )}
                {dep.status === 'deployed' && isKvSource && (
                  <button onClick={() => setConfigModal(dep)} title="تنظیمات ورکر"
                    className="p-2 rounded-lg bg-slate-700/30 text-slate-400 hover:bg-brand-500/10 hover:text-brand-400 transition-all">
                    <Settings2 className="w-4 h-4" />
                  </button>
                )}
                <button onClick={() => setExpandedId(isExpanded ? null : dep.id)}
                  className="p-2 rounded-lg bg-slate-700/30 text-slate-400 hover:text-white transition-all">
                  {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                <button onClick={() => handleDelete(dep.id, dep.name)}
                  className="p-2 rounded-lg bg-slate-700/30 text-slate-400 hover:bg-error-500/10 hover:text-error-400 transition-all">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {isExpanded && dep.status === 'deployed' && (
              <div className="px-5 pb-5 border-t border-slate-800/50 pt-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {dep.worker_url && (
                    <InfoCell icon={<Globe className="w-3.5 h-3.5 text-brand-400" />} label="آدرس ورکر">
                      <a href={dep.worker_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-brand-400 hover:underline truncate block" dir="ltr">{dep.worker_url}</a>
                    </InfoCell>
                  )}
                  {dep.uuid && (
                    <InfoCell icon={<KeyRound className="w-3.5 h-3.5 text-warning-400" />} label="UUID">
                      <span className="text-xs text-slate-300 font-mono" dir="ltr">{dep.uuid.slice(0, 16)}...</span>
                    </InfoCell>
                  )}
                  {dep.worker_url && dep.uuid && (
                    <InfoCell icon={<Link2 className="w-3.5 h-3.5 text-emerald-400" />} label="ساب مستقیم (آدرس ورکر + uuid)">
                      <button onClick={() => copySub(`${dep.worker_url}/${dep.uuid}`, `${dep.id}-direct`)}
                        title={`${dep.worker_url}/${dep.uuid}`}
                        className="flex items-center gap-1.5 text-xs text-emerald-400 hover:underline truncate max-w-full" dir="ltr">
                        <span className="truncate">{dep.worker_url}/{dep.uuid.slice(0, 13)}…</span>
                        {copiedSub === `${dep.id}-direct` ? <Check className="w-3 h-3 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
                      </button>
                    </InfoCell>
                  )}
                  {dep.kv_namespace_id && (
                    <InfoCell icon={<Database className="w-3.5 h-3.5 text-green-400" />} label="KV Namespace">
                      <span className="text-xs text-slate-300 font-mono" dir="ltr">{dep.kv_namespace_id.slice(0, 16)}...</span>
                    </InfoCell>
                  )}
                </div>

                {dep.sub_url ? (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Smartphone className="w-3.5 h-3.5 text-brand-400" />
                      <span className="text-xs text-slate-400 font-medium">ساب‌لینک (این لینک‌ها تنظیمات KV را منعکس می‌کنند):</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {SUB_TARGETS.map((t) => {
                        const sep = dep.sub_url!.includes('?') ? '&' : '?'
                        const url = `${dep.sub_url}${sep}target=${t.key}`
                        const key = `${dep.id}-${t.key}`
                        return (
                          <button key={t.key} onClick={() => copySub(url, key)} title={url}
                            className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/50 border border-slate-700/50 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all text-xs">
                            <span className="text-slate-300 font-medium">{t.label}</span>
                            {copiedSub === key ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-slate-500 group-hover:text-brand-400" />}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex items-center gap-2 bg-slate-900/40 rounded-lg px-3 py-2">
                      <code className="text-xs text-slate-500 truncate flex-1 font-mono" dir="ltr">{dep.sub_url}</code>
                      <button onClick={() => copySub(dep.sub_url!, `${dep.id}-base`)}>
                        {copiedSub === `${dep.id}-base` ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-slate-500 hover:text-brand-400" />}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-2">
                      هر بار که تنظیمات را ذخیره می‌کنی، ورکر ظرف ۳۰ ثانیه تنظیمات جدید را از KV می‌خواند و ساب‌لینک‌ها به‌روز می‌شوند.
                    </p>
                  </div>
                ) : dep.status === 'deployed' && (
                  <p className="text-[11px] text-slate-500">
                    این سورس لینک ساب آماده ندارد — کاربر/کانفیگ را داخل خود پنل بسازید و از لینک ساب آن استفاده کنید.
                  </p>
                )}

                {dep.panel_url && (
                  <div className="flex gap-2">
                    <a href={dep.panel_url} target="_blank" rel="noopener noreferrer"
                      className="btn-ghost flex items-center gap-1.5 text-sm py-2">
                      <ExternalLink className="w-4 h-4" /> باز کردن پنل ورکر
                    </a>
                  </div>
                )}
              </div>
            )}

            {dep.status === 'failed' && dep.error_message && (
              <div className="mx-5 mb-5 px-4 py-2.5 rounded-xl bg-error-500/10 border border-error-500/20 text-error-400 text-sm">
                {dep.error_message}
              </div>
            )}
          </div>
        )
      })}

      {configModal && (
        <ConfigModal dep={configModal} onClose={() => setConfigModal(null)}
          onSaved={(id, cfg) => setDeployments((prev) => prev.map((d) => d.id === id ? { ...d, config: cfg } : d))} />
      )}
    </div>
  )
}

function InfoCell({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-800/40 rounded-xl p-3 border border-slate-700/30">
      <div className="flex items-center gap-1.5 mb-1">{icon}<span className="text-xs text-slate-400">{label}</span></div>
      {children}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════
// GROUP SUBSCRIPTION — merge several deployed workers into one sub link
// ═════════════════════════════════════════════════════════════════════════
function GroupSubPanel({ deployments, onChanged }: { deployments: Deployment[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<SubGroup[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [injIps, setInjIps] = useState('')
  const [injProxies, setInjProxies] = useState('')
  const [inject, setInject] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editIps, setEditIps] = useState('')
  const [editProxies, setEditProxies] = useState('')
  const [format, setFormat] = useState('base64')
  const [extraLinks, setExtraLinks] = useState('')

  const FORMATS = [
    { key: 'base64', label: 'Base64 (v2rayNG و…)' },
    { key: 'plain', label: 'متن ساده' },
    { key: 'clash', label: 'Clash Meta' },
    { key: 'singbox', label: 'Sing-Box JSON' },
  ]

  const parseIps = (text: string): PreferredIP[] =>
    text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [ip, port] = l.split(':')
      return port ? { ip, port: Number(port) } : { ip }
    })
  const parseProxies = (text: string): ProxySpec[] =>
    text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(https?|socks5):\/\/(?:([^:@]+)(?::([^@]*))?@)?([^:/]+):(\d+)$/i)
      if (!m) return null
      return { type: m[1].toLowerCase() === 'socks5' ? 'socks5' : 'http', server: m[4], port: Number(m[5]), ...(m[2] ? { username: m[2] } : {}), ...(m[3] ? { password: m[3] } : {}) } as ProxySpec
    }).filter(Boolean) as ProxySpec[]

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: SubGroup[] }>('/subgroups')
      setGroups(data ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  const toggle = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const create = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      await api('/subgroups', {
        method: 'POST',
        body: {
          name: name.trim(), deployment_ids: Array.from(selected),
          inject, ips: parseIps(injIps), proxies: parseProxies(injProxies),
          format,
          extra_links: extraLinks.split('\n').map((l) => l.trim()).filter(Boolean),
        },
      })
      setSelected(new Set()); setName(''); setExtraLinks(''); await load(); onChanged()
    } catch { /* ignore */ }
    setBusy(false)
  }

  const remove = async (id: string) => {
    await api(`/subgroups/${id}`, { method: 'DELETE' }).catch(() => null)
    await load()
  }

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text).catch(() => null)
    setCopied(key); setTimeout(() => setCopied(null), 1500)
  }

  const groupUrl = (token: string) => `${window.location.origin}/api/sub/group/${token}`

  if (deployments.length === 0) return null

  return (
    <div className="glass-card p-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-brand-400" />
          <div className="text-right">
            <p className="text-sm font-bold text-white">ساب گروهی</p>
            <p className="text-xs text-slate-500">چند ورکر را انتخاب کن — یک لینک ساب ترکیبی بگیر</p>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {deployments.map((d) => (
              <button key={d.id} onClick={() => toggle(d.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all ${
                  selected.has(d.id) ? 'bg-brand-500/15 border-brand-500/40 text-brand-200' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:text-white'
                }`}>
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  selected.has(d.id) ? 'bg-brand-500 border-brand-500' : 'border-slate-600'
                }`}>
                  {selected.has(d.id) && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="truncate" dir="ltr">{d.name}</span>
              </button>
            ))}
          </div>

          <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-800 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">تزریق خودکار — ساب گروهی هر بار که خوانده شود با همین تنظیمات و آخرین کانفیگ ورکرها ساخته می‌شود</span>
              <button type="button" onClick={() => setInject(!inject)}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${inject ? 'bg-brand-500' : 'bg-slate-600'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${inject ? 'right-0.5' : 'left-0.5'}`} />
              </button>
            </div>
            {inject && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <textarea value={injIps} onChange={(e) => setInjIps(e.target.value)} rows={2} dir="ltr"
                  placeholder={'IPهای ترجیحی\n104.16.0.1\n172.64.0.1:2053'} className="input-field text-xs font-mono" />
                <textarea value={injProxies} onChange={(e) => setInjProxies(e.target.value)} rows={2} dir="ltr"
                  placeholder={'پروکسی خروجی\nsocks5://user:pass@1.2.3.4:1080'} className="input-field text-xs font-mono" />
              </div>
            )}
          </div>

          <div className="p-3 rounded-xl bg-slate-900/40 border border-slate-800 space-y-2">
            <span className="text-xs font-medium text-slate-300">فرمت خروجی ساب — لینک نهایی در همین فرمت تحویل داده می‌شود</span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {FORMATS.map((f) => (
                <button key={f.key} type="button" onClick={() => setFormat(f.key)}
                  className={`px-3 py-2 rounded-lg border text-xs transition-all ${format === f.key ? 'bg-brand-500/15 border-brand-500/40 text-brand-200' : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:text-white'}`}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <textarea value={extraLinks} onChange={(e) => setExtraLinks(e.target.value)} rows={2} dir="ltr"
            placeholder={'لینک‌های اضافه (هر آدرس حاوی نود، هر خط یک مورد):\nhttps://example.com/sub\nیا محتوای کانفیگ خام'}
            className="input-field text-xs font-mono" />

          <div className="flex gap-2 flex-wrap">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="نام گروه (اختیاری)" className="input-field text-sm flex-1 min-w-[160px]" />
            <button onClick={create} disabled={busy || (selected.size === 0 && extraLinks.trim() === '')} className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50">
              <Layers className="w-4 h-4" />
              ساخت ساب گروهی ({selected.size})
            </button>
          </div>

          {groups.length > 0 && (
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-900/40 border border-slate-800">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{g.name} <span className="text-xs text-slate-500">({g.deployment_ids.length} ورکر{g.extra_links?.length ? ` · ${g.extra_links.length} لینک اضافه` : ''})</span></p>
                    <p className="text-xs text-slate-500 font-mono truncate" dir="ltr">{groupUrl(g.sub_token)}</p>
                    <p className="text-[10px] text-brand-400/80">فرمت: {FORMATS.find((f) => f.key === (g.format || 'base64'))?.label ?? 'Base64'}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => copy(groupUrl(g.sub_token), g.id)} className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-brand-300" title="کپی لینک ساب">
                      {copied === g.id ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <button onClick={() => copy(groupUrl(g.sub_token) + '?target=clash', g.id + '-clash')} className="px-2 py-2 rounded-lg bg-slate-800/60 text-xs text-slate-400 hover:text-brand-300" title="کپی لینک Clash Meta">
                      Clash
                    </button>
                    <button onClick={() => copy(groupUrl(g.sub_token) + '?target=singbox', g.id + '-sb')} className="px-2 py-2 rounded-lg bg-slate-800/60 text-xs text-slate-400 hover:text-brand-300" title="کپی لینک Sing-Box">
                      SB
                    </button>
                    <button onClick={() => { setEditingId(editingId === g.id ? null : g.id); setEditIps((g.ips ?? []).map((p) => p.port ? `${p.ip}:${p.port}` : p.ip).join('\n')); setEditProxies((g.proxies ?? []).map((p) => `${p.type}://${p.username ? p.username + (p.password ? ':' + p.password : '') + '@' : ''}${p.server}:${p.port}`).join('\n')) }}
                      className="px-2 py-2 rounded-lg bg-slate-800/60 text-xs text-slate-400 hover:text-brand-300" title="تنظیم تزریق">
                      تزریق
                    </button>
                    <button onClick={() => remove(g.id)} className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  {editingId === g.id && (
                    <div className="w-full mt-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800 space-y-2">
                      <p className="text-xs text-slate-400">تنظیمات تزریق — بلافاصله روی لینک همین گروه اعمال می‌شود (لینک تغییر نمی‌کند)</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <textarea value={editIps} onChange={(e) => setEditIps(e.target.value)} rows={2} dir="ltr"
                          placeholder={'IPهای ترجیحی\n104.16.0.1'} className="input-field text-xs font-mono" />
                        <textarea value={editProxies} onChange={(e) => setEditProxies(e.target.value)} rows={2} dir="ltr"
                          placeholder={'پروکسی خروجی\nsocks5://user:pass@1.2.3.4:1080'} className="input-field text-xs font-mono" />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={async () => {
                          await api(`/subgroups/${g.id}`, { method: 'PATCH', body: { ips: parseIps(editIps), proxies: parseProxies(editProxies), inject: true } }).catch(() => null)
                          setEditingId(null); await load()
                        }} className="btn-primary text-xs px-3 py-2">ذخیره تزریق</button>
                        <button onClick={async () => {
                          await api(`/subgroups/${g.id}`, { method: 'PATCH', body: { inject: false } }).catch(() => null)
                          setEditingId(null); await load()
                        }} className="btn-ghost text-xs px-3 py-2">غیرفعال‌سازی</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG MODAL — reads/writes edgetunnel config.json in KV
// ═══════════════════════════════════════════════════════════════════════════
function ConfigModal({ dep, onClose, onSaved }: {
  dep: Deployment
  onClose: () => void
  onSaved: (id: string, config: Record<string, unknown>) => void
}) {
  const [config, setConfig] = useState<EdgeConfig>(DEFAULT_CONFIG)
  const [addTxt, setAddTxt] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showUuid, setShowUuid] = useState(false)
  const [nodes, setNodes] = useState<{ live: boolean; count: number; sample?: string[]; sub_url: string | null } | null>(null)
  const [checking, setChecking] = useState(false)
  const [uProxyip, setUProxyip] = useState('')
  const [uPath, setUPath] = useState('')
  const [uSaved, setUSaved] = useState(false)

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null)
      try {
        const data = await api<{ success: boolean; config?: Partial<EdgeConfig>; addTxt?: string; error?: string }>('/worker-config', {
          method: 'POST',
          body: { deployment_id: dep.id, action: 'get' },
        })
        if (!cancelled) {
          if (data.success) {
            setConfig(mergeConfig((data.config ?? {}) as Partial<EdgeConfig>))
            setAddTxt(data.addTxt ?? '')
          } else {
            setError(data.error ?? 'خطا در خواندن تنظیمات از KV')
            setConfig(mergeConfig((dep.config ?? {}) as Partial<EdgeConfig>))
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'خطا در اتصال')
          setConfig(mergeConfig((dep.config ?? {}) as Partial<EdgeConfig>))
        }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [dep])

  const loadUnified = async () => {
    try {
      const data = await api<{ success: boolean; data?: { proxyip?: string; path?: string } }>('/source-settings', {
        method: 'POST',
        body: { deployment_id: dep.id, action: 'get' },
      })
      if (data.success && data.data) {
        setUProxyip(data.data.proxyip ?? '')
        setUPath(data.data.path ?? '')
      }
    } catch { /* unified view unavailable */ }
  }
  useEffect(() => { loadUnified() }, [dep.id])

  const checkNodes = async () => {
    setChecking(true)
    try {
      const data = await api<{ data: { live: boolean; count: number; sample?: string[]; sub_url: string | null } }>(`/source-nodes/${dep.id}`)
      setNodes(data.data)
    } catch {
      setNodes({ live: false, count: 0, sub_url: null })
    }
    setChecking(false)
  }

  const saveUnified = async () => {
    setSaving(true); setError(null)
    try {
      const data = await api<{ success: boolean; error?: string }>('/source-settings', {
        method: 'POST',
        body: { deployment_id: dep.id, action: 'set', settings: { proxyip: uProxyip, path: uPath, addtxt: addTxt } },
      })
      if (data.success) { setUSaved(true); setTimeout(() => setUSaved(false), 2500) }
      else setError(data.error ?? 'خطا در ذخیره تنظیمات سورس')
    } catch (e) { setError(e instanceof Error ? e.message : 'خطا در اتصال') }
    setSaving(false)
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const data = await api<{ success: boolean; error?: string }>('/worker-config', {
        method: 'POST',
        body: { deployment_id: dep.id, action: 'set', config },
      })
      if (data.success) {
        // Also save ADD.txt if changed
        await edgePost('/worker-config', { deployment_id: dep.id, action: 'set_addtxt', addTxt })
        onSaved(dep.id, config as unknown as Record<string, unknown>)
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } else {
        setError(data.error ?? 'خطا در ذخیره')
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'خطا در اتصال') }
    setSaving(false)
  }

  const setStr = (key: keyof EdgeConfig, value: string) =>
    setConfig((p) => ({ ...p, [key]: value }))
  const togBool = (key: keyof EdgeConfig) =>
    setConfig((p) => ({ ...p, [key]: !(p[key] as boolean) }))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card w-full max-w-3xl max-h-[88vh] overflow-y-auto p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold text-white">تنظیمات ورکر</h2>
            <p className="text-sm text-slate-400" dir="ltr">{dep.name}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-2"><XCircle className="w-5 h-5" /></button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-14 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-brand-400" />
            <span className="text-sm text-slate-400">در حال خواندن تنظیمات از KV ورکر...</span>
          </div>
        ) : (
          <div className="space-y-6">
            {error && (
              <div className="px-4 py-3 rounded-xl bg-error-500/10 border border-error-500/20 text-sm space-y-2">
                <div className="flex items-start gap-2 text-error-400">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
                {error.includes('401') && (
                  <div className="text-xs text-slate-400 pr-6">
                    توکن فعال شما دسترسی <span className="font-mono text-warning-300">Workers KV Storage:Read</span> و{' '}
                    <span className="font-mono text-warning-300">Workers KV Storage:Edit</span> ندارد.{' '}
                    <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer"
                      className="text-brand-400 hover:underline">توکن را در پنل Cloudflare ویرایش کنید ←</a>
                  </div>
                )}
              </div>
            )}

            {/* Live source bridge */}
            <Sect title="اتصال زنده به سورس ورکر" icon={<Radio className="w-4 h-4" />}>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={checkNodes} disabled={checking}
                  className="btn-secondary flex items-center gap-2 text-sm">
                  {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
                  بررسی نودهای زنده
                </button>
                <button onClick={saveUnified} disabled={saving}
                  className="btn-primary flex items-center gap-2 text-sm">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : uSaved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  {uSaved ? 'روی سورس اعمال شد ✓' : 'ذخیره سریع (سورس واقعی)'}
                </button>
              </div>
              {nodes && (
                <div className={`mt-3 px-3 py-2 rounded-lg text-sm border ${nodes.live ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-warning-500/10 border-warning-500/20 text-warning-300'}`}>
                  {nodes.live
                    ? `✓ ${nodes.count} نود زنده مستقیماً از سورس مستقرشده خوانده شد`
                    : nodes.count > 0
                      ? `${nodes.count} نود از کانفیگ KV بازسازی شد (دسترسی مستقیم به آدرس ورکر ممکن نشد)`
                      : 'هیچ نودی دریافت نشد — ورکر در دسترس نیست'}
                  {nodes.sub_url && (
                    <div className="mt-1 text-xs text-slate-400 break-all" dir="ltr">sub: {nodes.sub_url}</div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label="Proxy IP (واقعی روی سورس)" value={uProxyip} onChange={setUProxyip} ltr />
                <Field label="مسیر پنل/PATH" value={uPath} onChange={setUPath} ltr />
              </div>
              <p className="text-xs text-slate-500 mt-2">
                این تنظیمات بدون باز کردن پنل مستقربشده، مستقیماً داخل KV همان سورس نوشته می‌شود و بلافاصله روی ساب‌لینک واقعی اثر می‌گذارد.
              </p>
            </Sect>

            {/* Protocol */}
            <Sect title="پروتکل و انتقال — روی ساب‌لینک نهایی اثر مستقیم دارد" icon={<Shield className="w-4 h-4" />}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">نوع پروتکل</label>
                  <select value={config.协议类型} onChange={(e) => setStr('协议类型', e.target.value)} className="input-field text-sm">
                    <option value="vless">VLESS</option>
                    <option value="trojan">Trojan</option>
                    <option value="ss">Shadowsocks (SS)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">نوع انتقال</label>
                  <select value={config.传输协议} onChange={(e) => setStr('传输协议', e.target.value)} className="input-field text-sm">
                    <option value="ws">WebSocket</option>
                    <option value="grpc">gRPC</option>
                    <option value="xhttp">XHTTP</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                <Toggle checked={config.跳过证书验证} onChange={() => togBool('跳过证书验证')} label="رد کردن گواهی" />
                <Toggle checked={config.启用0RTT} onChange={() => togBool('启用0RTT')} label="0-RTT" />
                <Toggle checked={config.随机路径} onChange={() => togBool('随机路径')} label="مسیر تصادفی" />
                <Toggle checked={config.ECH} onChange={() => togBool('ECH')} label="ECH" />
              </div>
              {config.ECH && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <Field label="ECH DNS" value={config.ECHConfig.DNS} onChange={(v) => setConfig((p) => ({ ...p, ECHConfig: { ...p.ECHConfig, DNS: v } }))} ltr />
                  <Field label="ECH SNI" value={config.ECHConfig.SNI} onChange={(v) => setConfig((p) => ({ ...p, ECHConfig: { ...p.ECHConfig, SNI: v } }))} ltr />
                </div>
              )}
              {config.协议类型 === 'ss' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">رمزنگاری SS</label>
                    <select value={config.SS.加密方式} onChange={(e) => setConfig((p) => ({ ...p, SS: { ...p.SS, 加密方式: e.target.value } }))} className="input-field text-sm">
                      <option value="aes-128-gcm">aes-128-gcm</option>
                      <option value="aes-256-gcm">aes-256-gcm</option>
                      <option value="chacha20-ietf-poly1305">chacha20-ietf-poly1305</option>
                    </select>
                  </div>
                  <Toggle checked={config.SS.TLS} onChange={() => setConfig((p) => ({ ...p, SS: { ...p.SS, TLS: !p.SS.TLS } }))} label="TLS برای SS" />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">اثر انگشت (Fingerprint)</label>
                  <select value={config.Fingerprint} onChange={(e) => setStr('Fingerprint', e.target.value)} className="input-field text-sm">
                    {['chrome','firefox','safari','ios','android','edge','random'].map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">TLS Fragmentation</label>
                  <select value={config.TLS分片 ?? ''} onChange={(e) => setStr('TLS分片', e.target.value)} className="input-field text-sm">
                    <option value="">غیرفعال</option>
                    <option value="Shadowrocket">Shadowrocket</option>
                    <option value="Happ">Happ</option>
                  </select>
                </div>
              </div>
            </Sect>

            {/* Network & Proxy */}
            <Sect title="شبکه و پروکسی" icon={<Network className="w-4 h-4" />}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Proxy IP — برای دور زدن محدودیت Worker→Origin" value={config.反代.proxyip} onChange={(v) => setConfig((p) => ({ ...p, 反代: { ...p.反代, proxyip: v } }))} ltr placeholder="auto یا IP:port,IP:port" />
                <Field label="مسیر سفارشی (PATH)" value={config.PATH} onChange={(v) => setStr('PATH', v)} ltr placeholder="/" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                <Field label="SNI / HOST — دامنه‌ای که در TLS نمایش داده می‌شود" value={config.HOST} onChange={(v) => setStr('HOST', v)} ltr placeholder="خالی = دامنه ورکر" />
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">HOSTS — دامنه‌های اضافی (هر خط یکی)</label>
                  <textarea value={(config.HOSTS ?? []).join('\n')} onChange={(e) => setConfig((p) => ({ ...p, HOSTS: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }))} className="input-field text-sm" rows={2} dir="ltr" placeholder="example.com\nanother.com" />
                </div>
              </div>
              {/* SOCKS5 Proxy */}
              <div className="mt-3 p-3 rounded-xl bg-slate-900/40 border border-slate-800/50">
                <div className="flex items-center gap-2 mb-2">
                  <Network className="w-3.5 h-3.5 text-purple-400" />
                  <span className="text-xs font-medium text-slate-300">پروکسی SOCKS5 — اختیاری</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="آدرس SOCKS5 (user:pass@host:port)" value={config.反代.SOCKS5.账号 ?? ''} onChange={(v) => setConfig((p) => ({ ...p, 反代: { ...p.反代, SOCKS5: { ...p.反代.SOCKS5, 账号: v } } }))} ltr mono placeholder="user:pass@1.2.3.4:1080" />
                  <div className="flex items-end">
                    <Toggle checked={config.反代.SOCKS5.全局} onChange={() => setConfig((p) => ({ ...p, 反代: { ...p.反代, SOCKS5: { ...p.反代.SOCKS5, 全局: !p.反代.SOCKS5.全局 } } }))} label="全局 SOCKS5 (همه ترافیک)" />
                  </div>
                </div>
              </div>
              <div className="mt-1 flex gap-3 flex-wrap">
                <GhLink url="https://github.com/EDT-Pages/Proxy-List" label="EDT-Pages/Proxy-List" />
                <GhLink url="https://github.com/ymyuuu/IPDB" label="ymyuuu/IPDB" />
              </div>
            </Sect>

            {/* Preferred IPs (ADD.txt) */}
            <Sect title="IPهای بهینه — مستقیم روی ساب‌لینک اثر می‌گذارد" icon={<Server className="w-4 h-4" />}>
              <Field label="IPهای سفارشی (ADD.txt) — هر خط یک IP، فرمت: IP:port#name" value={addTxt} onChange={setAddTxt} ltr textarea rows={4} placeholder="104.16.0.1:443#HK&#10;172.64.0.1:443#US" />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">تعداد IP تصادفی</label>
                  <input type="number" value={config.优选订阅生成.本地IP库.随机数量} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, 本地IP库: { ...p.优选订阅生成.本地IP库, 随机数量: Number(e.target.value) || 16 } } }))} className="input-field text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">پورت مشخص</label>
                  <input type="number" value={config.优选订阅生成.本地IP库.指定端口} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, 本地IP库: { ...p.优选订阅生成.本地IP库, 指定端口: Number(e.target.value) || -1 } } }))} className="input-field text-sm" placeholder="-1 = همه پورت‌ها" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">نام ساب</label>
                  <input type="text" value={config.优选订阅生成.SUBNAME} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, SUBNAME: e.target.value } }))} className="input-field text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <Toggle checked={config.优选订阅生成.local} onChange={() => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, local: !p.优选订阅生成.local } }))} label="استفاده از IP محلی" />
                <Toggle checked={config.优选订阅生成.本地IP库.随机IP} onChange={() => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, 本地IP库: { ...p.优选订阅生成.本地IP库, 随机IP: !p.优选订阅生成.本地IP库.随机IP } } }))} label="IP تصادفی (به‌جای ADD.txt)" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">بازه به‌روزرسانی ساب (ساعت)</label>
                  <input type="number" value={config.优选订阅生成.SUBUpdateTime} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, SUBUpdateTime: Number(e.target.value) || 3 } }))} className="input-field text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">توکن ساب (اختیاری)</label>
                  <input type="text" value={config.优选订阅生成.TOKEN} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, TOKEN: e.target.value } }))} className="input-field text-sm font-mono" dir="ltr" placeholder="خالی = بدون توکن" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">آدرس ساب خارجی (SUB)</label>
                  <input type="text" value={config.优选订阅生成.SUB ?? ''} onChange={(e) => setConfig((p) => ({ ...p, 优选订阅生成: { ...p.优选订阅生成, SUB: e.target.value || null } }))} className="input-field text-sm" dir="ltr" placeholder="خالی = ساب محلی" />
                </div>
              </div>
              <div className="mt-1 flex gap-3 flex-wrap">
                <GhLink url="https://github.com/ymyuuu/IPDB" label="ymyuuu/IPDB" />
                <GhLink url="https://github.com/XIU2/CloudflareSpeedTest" label="XIU2/CloudflareSpeedTest" />
              </div>
            </Sect>

            {/* gRPC / XHTTP transport settings */}
            {(config.传输协议 === 'grpc' || config.传输协议 === 'xhttp') && (
              <Sect title="تنظیمات gRPC / XHTTP" icon={<Server className="w-4 h-4" />}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">حالت gRPC</label>
                    <select value={config.gRPC模式} onChange={(e) => setStr('gRPC模式', e.target.value)} className="input-field text-sm">
                      <option value="gun">gun</option>
                      <option value="multi">multi</option>
                    </select>
                  </div>
                  <Field label="User-Agent گRPC" value={config.gRPCUserAgent} onChange={(v) => setStr('gRPCUserAgent', v)} ltr placeholder="Mozilla/5.0" />
                </div>
              </Sect>
            )}

            {/* Subscription converter */}
            <Sect title="تبدیل ساب و آدرس‌ها — روی ساب‌لینک نهایی اثر مستقیم دارد" icon={<Globe className="w-4 h-4" />}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="آدرس تبدیل‌کننده ساب (SUBAPI)" value={config.订阅转换配置.SUBAPI} onChange={(v) => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, SUBAPI: v } }))} ltr />
                <Field label="آدرس کانفیگ ساب (SUBCONFIG)" value={config.订阅转换配置.SUBCONFIG} onChange={(v) => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, SUBCONFIG: v } }))} ltr />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                <Toggle checked={config.订阅转换配置.UDP} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, UDP: !p.订阅转换配置.UDP } }))} label="UDP" />
                <Toggle checked={config.订阅转换配置.XUDP} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, XUDP: !p.订阅转换配置.XUDP } }))} label="XUDP" />
                <Toggle checked={config.订阅转换配置.TLS13} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, TLS13: !p.订阅转换配置.TLS13 } }))} label="TLS 1.3" />
                <Toggle checked={config.订阅转换配置.SORT} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, SORT: !p.订阅转换配置.SORT } }))} label="مرتب‌سازی" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                <Toggle checked={config.订阅转换配置.SUBEMOJI} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, SUBEMOJI: !p.订阅转换配置.SUBEMOJI } }))} label="Emoji در ساب" />
                <Toggle checked={config.订阅转换配置.SUBLIST} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, SUBLIST: !p.订阅转换配置.SUBLIST } }))} label="لیست ساب" />
                <Toggle checked={config.订阅转换配置.APPEND_TYPE} onChange={() => setConfig((p) => ({ ...p, 订阅转换配置: { ...p.订阅转换配置, APPEND_TYPE: !p.订阅转换配置.APPEND_TYPE } }))} label="افزودن نوع" />
              </div>
            </Sect>

            {/* UUID read-only */}
            <Sect title="UUID (کلید احراز هویت)" icon={<KeyRound className="w-4 h-4" />}>
              <div className="flex items-center gap-2">
                <input type={showUuid ? 'text' : 'password'} value={dep.uuid ?? ''} readOnly
                  className="input-field text-sm font-mono flex-1" dir="ltr" />
                <button onClick={() => setShowUuid(!showUuid)} className="btn-ghost p-3">
                  {showUuid ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">این مقدار در ورکر تغییر نمی‌کند و فقط برای مرجع نمایش داده می‌شود. پنل ورکر دیگر لازم نیست — همه تنظیمات از همین‌جا مدیریت می‌شود.</p>
            </Sect>

            {/* Security note */}
            <div className="flex items-start gap-2 p-3 rounded-xl bg-slate-800/30 border border-slate-700/30">
              <Lock className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400">
                سکرت‌های ادمین (توکن API کلودفلر، توکن بات تلگرام، رمز ادمین) از این پنل حذف شده‌اند.
                این اطلاعات حساس دیگر در KV ورکر ذخیره نمی‌شوند و ارتباط ورکر با پروژه اصلی قطع شده است.
              </p>
            </div>
          </div>
        )}

        {!loading && (
          <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-slate-700/50">
            <p className="text-xs text-slate-500">تنظیمات مستقیم در KV ورکر ذخیره می‌شود — ساب‌لینک ظرف ۳۰ ثانیه به‌روز می‌شود.</p>
            <div className="flex gap-3">
              <button onClick={onClose} className="btn-ghost text-sm">بستن</button>
              <button onClick={save} disabled={saving}
                className="btn-primary flex items-center gap-2 text-sm">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                {saved ? 'ذخیره شد ✓' : 'ذخیره در ورکر'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { CFToken, RailwayToken, RenderToken } from '../lib/types'
import {
  KeyRound,
  Plus,
  Trash2,
  Loader2,
  Copy,
  Check,
  Eye,
  EyeOff,
  ShieldCheck,
  X,
  ExternalLink,
  Mail,
  Cloud,
  Sparkles,
  Wand2,
  TrainFront,
} from 'lucide-react'
import { PANELS } from '../../shared/panels'

/** The single first-party panel these tokens deploy (see shared/panels.ts). */
const PANEL_NAME = PANELS[0].name

const RAILWAY_TOKENS_PAGE = 'https://railway.com/account/tokens'
const RENDER_TOKENS_PAGE = 'https://dashboard.render.com/account/api-keys'

const CF_TOKENS_PAGE = 'https://dash.cloudflare.com/profile/api-tokens'

// Permission keys for the prefill URL — Cloudflare accepts simple key/type pairs,
// no need to fetch permission group IDs from the API.
// 15 permissions — all with read+edit where applicable, zone-scoped where relevant.
// Includes R2 (free object storage bound to deployed workers) and zone_settings
// (enables gRPC/WebSockets on the user's zones during deployment).
const CF_PERM_KEYS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'workers_r2', type: 'edit' }, // R2 buckets: created + bound to every deployed worker
  { key: 'page', type: 'edit' },
  { key: 'dns', type: 'edit' },
  { key: 'zone', type: 'read' },
  { key: 'zone_settings', type: 'edit' }, // enables gRPC + WebSockets for grpc/xhttp transports
  { key: 'dns_records', type: 'edit' },
  { key: 'ssl_and_certificate', type: 'edit' },
  { key: 'cache_purge', type: 'edit' },
  { key: 'user_details', type: 'read' },
  { key: 'account', type: 'read' },
  { key: 'workers_tail', type: 'read' },
  { key: 'd1', type: 'edit' }, // needed by D1-backed worker sources (e.g. miliconfigzeus)
]

function buildPrefillUrl(): string {
  const keysParam = encodeURIComponent(JSON.stringify(CF_PERM_KEYS))
  return `${CF_TOKENS_PAGE}?permissionGroupKeys=${keysParam}&accountId=*&zoneId=all&name=Miliconfig-Pro`
}

export default function Tokens() {
  const [tokens, setTokens] = useState<CFToken[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newToken, setNewToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set())

  // ── Railway tokens (panel auto-deploy) ───────────────────────────────
  const [railTokens, setRailTokens] = useState<RailwayToken[]>([])
  const [railLoading, setRailLoading] = useState(true)
  const [railShowAdd, setRailShowAdd] = useState(false)
  const [railName, setRailName] = useState('')
  const [railToken, setRailToken] = useState('')
  const [railSaving, setRailSaving] = useState(false)
  const [railError, setRailError] = useState<string | null>(null)
  const [railSaved, setRailSaved] = useState(false)

  // ── Render.com tokens (panel auto-deploy) ────────────────────────────
  const [renderTokens, setRenderTokens] = useState<RenderToken[]>([])
  const [renderLoading, setRenderLoading] = useState(true)
  const [renderShowAdd, setRenderShowAdd] = useState(false)
  const [renderName, setRenderName] = useState('')
  const [renderToken, setRenderToken] = useState('')
  const [renderSaving, setRenderSaving] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [renderSaved, setRenderSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: CFToken[] }>('/tokens')
      setTokens(data ?? [])
    } catch {
      setTokens([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const loadRail = useCallback(async () => {
    try {
      const { data } = await api<{ data: RailwayToken[] }>('/railway/tokens')
      setRailTokens(data ?? [])
    } catch {
      setRailTokens([])
    }
    setRailLoading(false)
  }, [])

  useEffect(() => { loadRail() }, [loadRail])

  const handleRailAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setRailSaving(true)
    setRailError(null)
    setRailSaved(false)
    try {
      await api('/railway/tokens', { method: 'POST', body: { name: railName, token: railToken } })
      setRailSaved(true)
      setRailName('')
      setRailToken('')
      await loadRail()
      setTimeout(() => { setRailShowAdd(false); setRailSaved(false) }, 900)
    } catch (err) {
      setRailError(err instanceof Error ? err.message : 'خطا در ذخیره توکن Railway')
    } finally {
      setRailSaving(false)
    }
  }

  const handleRailDelete = async (id: string, name: string) => {
    if (!confirm(`توکن Railway «${name}» حذف شود؟`)) return
    try { await api(`/railway/tokens/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    loadRail()
  }

  const loadRender = useCallback(async () => {
    try {
      const { data } = await api<{ data: RenderToken[] }>('/render/tokens')
      setRenderTokens(data ?? [])
    } catch {
      setRenderTokens([])
    }
    setRenderLoading(false)
  }, [])

  useEffect(() => { loadRender() }, [loadRender])

  const handleRenderAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setRenderSaving(true)
    setRenderError(null)
    setRenderSaved(false)
    try {
      await api('/render/tokens', { method: 'POST', body: { name: renderName, token: renderToken } })
      setRenderSaved(true)
      setRenderName('')
      setRenderToken('')
      await loadRender()
      setTimeout(() => { setRenderShowAdd(false); setRenderSaved(false) }, 900)
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : 'خطا در ذخیره کلید API رندر')
    } finally {
      setRenderSaving(false)
    }
  }

  const handleRenderDelete = async (id: string, name: string) => {
    if (!confirm(`کلید API رندر «${name}» حذف شود؟`)) return
    try { await api(`/render/tokens/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    loadRender()
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setAddError(null)
    try {
      await api('/tokens', { method: 'POST', body: { name: newName, token: newToken } })
      setNewName('')
      setNewToken('')
      setAddError(null)
      setShowAdd(false)
      load()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'خطا در ذخیره توکن')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`توکن «${name}» حذف شود؟`)) return
    try { await api(`/tokens/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    load()
  }

  const toggleVisible = (id: string) => {
    const next = new Set(visibleIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setVisibleIds(next)
  }

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const maskToken = (t: string) => t.slice(0, 6) + '••••••••••••••••' + t.slice(-4)

  const [autoBuildLoading, setAutoBuildLoading] = useState(false)

  const openAdd = () => { setAddError(null); setShowAdd(true) }

  const handleAutoBuildToken = async () => {
    setAutoBuildLoading(true)
    window.open(buildPrefillUrl(), '_blank', 'noopener')
    setAutoBuildLoading(false)
  }

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">توکن‌های کلودفلر</h1>
          <p className="text-slate-400 text-sm mt-1">مدیریت توکن‌های API کلودفلر برای استقرار ورکرها</p>
        </div>
        <button onClick={openAdd} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> افزودن توکن
        </button>
      </div>

      {/* Quick start guide */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-brand-400" />
          <h2 className="text-sm font-bold text-white">مسیر سریع راه‌اندازی</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <a
            href="https://tempmail.ing/"
            target="_blank"
            rel="noopener noreferrer"
            className="group p-4 rounded-xl bg-slate-900/40 border border-slate-800/50 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <Mail className="w-4 h-4 text-amber-400" />
              </div>
              <span className="text-xs font-mono text-slate-500">۱</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">ایمیل موقت</h3>
            <p className="text-xs text-slate-400 leading-relaxed">یک ایمیل یکبارمصرف برای ثبت‌نام در کلودفلر — نیازی به ایمیل شخصی نیست.</p>
            <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">
              دریافت ایمیل <ExternalLink className="w-3 h-3" />
            </span>
          </a>

          <a
            href="https://dash.cloudflare.com/sign-up"
            target="_blank"
            rel="noopener noreferrer"
            className="group p-4 rounded-xl bg-slate-900/40 border border-slate-800/50 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Cloud className="w-4 h-4 text-blue-400" />
              </div>
              <span className="text-xs font-mono text-slate-500">۲</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">ساخت حساب کلودفلر</h3>
            <p className="text-xs text-slate-400 leading-relaxed">با ایمیل موقت در کلودفلر ثبت‌نام کنید و آن را تأیید کنید.</p>
            <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">
              ثبت‌نام <ExternalLink className="w-3 h-3" />
            </span>
          </a>

          <a
            href="https://dash.cloudflare.com/profile/api-tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="group p-4 rounded-xl bg-slate-900/40 border border-brand-500/30 bg-brand-500/5 transition-all"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-brand-500/10">
                <KeyRound className="w-4 h-4 text-brand-400" />
              </div>
              <span className="text-xs font-mono text-slate-500">۳</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">ساخت توکن API</h3>
            <p className="text-xs text-slate-400 leading-relaxed">توکن با ۱۵ دسترسی کامل (Workers، KV، R2، DNS، Zone Settings، SSL، Cache و...) ساخته می‌شود — همه با دسترسی خواندن و نوشتن. R2 و تنظیمات gRPC/Zone هم پوشش داده شده‌اند تا هیچ ارور توکنی در استقرار نداشته باشید.</p>
            <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">
              ساخت توکن <ExternalLink className="w-3 h-3" />
            </span>
          </a>
        </div>

        {/* Auto-build token button */}
        <div className="mt-4 pt-4 border-t border-slate-800/50">
          <button
            onClick={handleAutoBuildToken}
            disabled={autoBuildLoading}
            className="w-full p-4 rounded-xl bg-gradient-to-r from-brand-500/10 to-brand-600/10 border border-brand-500/30 hover:border-brand-500/50 hover:from-brand-500/20 hover:to-brand-600/20 transition-all flex items-center gap-3 group disabled:opacity-60"
          >
            <div className="p-2.5 rounded-xl bg-brand-500/15 group-hover:bg-brand-500/25 transition-colors">
              {autoBuildLoading ? <Loader2 className="w-5 h-5 text-brand-400 animate-spin" /> : <Wand2 className="w-5 h-5 text-brand-400" />}
            </div>
            <div className="text-right flex-1">
              <p className="text-sm font-bold text-white">ساخت خودکار توکن با دسترسی‌های آماده</p>
              <p className="text-xs text-slate-400 mt-0.5">با کلیک روی این دکمه، صفحه ساخت توکن کلودفلر با تمام دسترسی‌های لازم از قبل پر می‌شود — فقط روی «Continue to summary» و «Create Token» کلیک کنید.</p>
            </div>
            <ExternalLink className="w-4 h-4 text-brand-400 group-hover:translate-x-1 transition-transform" />
          </button>
        </div>
      </div>

      {tokens.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-slate-800/50 items-center justify-center mb-4">
            <KeyRound className="w-8 h-8 text-slate-500" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">هنوز توکنی اضافه نشده</h3>
          <p className="text-slate-400 text-sm mb-6">برای شروع استقرار ورکرها، ابتدا یک توکن API کلودفلر اضافه کنید</p>
          <button onClick={openAdd} className="btn-primary inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> افزودن اولین توکن
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tokens.map((token, i) => (
            <div key={token.id} className="glass-card glass-card-hover p-5 animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-brand-500/10">
                    <ShieldCheck className="w-5 h-5 text-brand-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white">{token.name}</h3>
                    <span className={`badge ${token.status === 'active' ? 'bg-green-500/10 text-green-400' : 'bg-slate-700/50 text-slate-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${token.status === 'active' ? 'bg-green-400' : 'bg-slate-500'}`} />
                      {token.status === 'active' ? 'فعال' : 'غیرفعال'}
                    </span>
                  </div>
                </div>
                <button onClick={() => handleDelete(token.id, token.name)} className="p-2 rounded-lg text-slate-500 hover:bg-error-500/10 hover:text-error-400 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 bg-slate-900/50 rounded-xl p-3 border border-slate-800/50">
                <code className="flex-1 text-sm text-slate-300 font-mono truncate" dir="ltr">
                  {visibleIds.has(token.id) ? token.token : maskToken(token.token)}
                </code>
                <button onClick={() => toggleVisible(token.id)} className="p-1.5 rounded-lg text-slate-500 hover:text-white transition-colors">
                  {visibleIds.has(token.id) ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
                <button onClick={() => copyToken(token.id, token.token)} className="p-1.5 rounded-lg text-slate-500 hover:text-white transition-colors">
                  {copiedId === token.id ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>

              <p className="text-xs text-slate-500 mt-3">
                {token.last_used_at ? `آخرین استفاده: ${new Date(token.last_used_at).toLocaleDateString('fa-IR')}` : 'هنوز استفاده نشده'}
                {' • '}
                ساخته شده در {new Date(token.created_at).toLocaleDateString('fa-IR')}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ═══ Railway tokens — panel auto-deploy ═══ */}
      <div className="pt-4 border-t border-slate-800/60">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <TrainFront className="w-5 h-5 text-purple-400" /> توکن‌های Railway
            </h2>
            <p className="text-slate-400 text-sm mt-1">استقرار خودکار {PANEL_NAME} روی Railway — پروژه ساخته می‌شود، مخزن متصل و دیپلوی اجرا می‌شود</p>
          </div>
          <button onClick={() => { setRailError(null); setRailSaved(false); setRailShowAdd(true) }} className="btn-primary flex items-center gap-2 bg-purple-600/80 hover:bg-purple-600">
            <Plus className="w-4 h-4" /> افزودن توکن Railway
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <a href={RAILWAY_TOKENS_PAGE} target="_blank" rel="noopener noreferrer"
            className="group p-4 rounded-xl bg-slate-900/40 border border-purple-500/30 bg-purple-500/5 hover:border-purple-500/50 transition-all">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-purple-500/10"><KeyRound className="w-4 h-4 text-purple-400" /></div>
              <span className="text-xs font-mono text-slate-500">۱</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">ساخت توکن در Railway</h3>
            <p className="text-xs text-slate-400 leading-relaxed">حساب Railway بسازید و از <span className="text-purple-300" dir="ltr">railway.com/account/tokens</span> یک توکن <b>Account</b> بگیرید — توکن فقط یک‌بار نمایش داده می‌شود.</p>
            <span className="inline-flex items-center gap-1 text-xs text-purple-300 mt-3 group-hover:gap-2 transition-all">ساخت توکن <ExternalLink className="w-3 h-3" /></span>
          </a>
          <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/50">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-brand-500/10"><Sparkles className="w-4 h-4 text-brand-400" /></div>
              <span className="text-xs font-mono text-slate-500">۲</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">استقرار در ویزارد</h3>
            <p className="text-xs text-slate-400 leading-relaxed">در صفحه استقرار، روش <b>Railway</b> را انتخاب و حالت «استقرار خودکار» را بزنید — پروژه، سرویس و دیپلوی بدون خروج از پنل انجام می‌شود.</p>
          </div>
        </div>

        {railLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
        ) : railTokens.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <div className="inline-flex w-14 h-14 rounded-2xl bg-purple-500/10 items-center justify-center mb-3">
              <TrainFront className="w-7 h-7 text-purple-400" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">هنوز توکن Railway اضافه نشده</h3>
            <p className="text-slate-400 text-sm">برای استقرار خودکار {PANEL_NAME} روی Railway یک توکن Account اضافه کنید</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {railTokens.map((t, i) => (
              <div key={t.id} className="glass-card glass-card-hover p-5 animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-purple-500/10">
                      <TrainFront className="w-5 h-5 text-purple-400" />
                    </div>
                    <div>
                      <h3 className="font-bold text-white">{t.name}</h3>
                      <span className="badge bg-green-500/10 text-green-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        {t.status === 'active' ? 'فعال' : 'غیرفعال'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => handleRailDelete(t.id, t.name)} className="p-2 rounded-lg text-slate-500 hover:bg-error-500/10 hover:text-error-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {t.account_name && (
                  <p className="text-xs text-slate-500 mb-2" dir="ltr">{t.account_name}</p>
                )}
                <div className="flex items-center gap-2 bg-slate-900/50 rounded-xl px-3 py-2 border border-slate-800/50">
                  <code className="flex-1 text-sm text-slate-400 font-mono" dir="ltr">••••••••••••{t.token_tail}</code>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  {t.last_used_at ? `آخرین استفاده: ${new Date(t.last_used_at).toLocaleString('fa-IR')}` : 'هنوز استفاده نشده'}
                  {' • '}
                  ساخته شده در {new Date(t.created_at).toLocaleDateString('fa-IR')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ Render.com tokens — panel auto-deploy ═══ */}
      <div className="pt-4 border-t border-slate-800/60">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Cloud className="w-5 h-5 text-teal-400" /> کلیدهای API رندر (Render.com)
            </h2>
            <p className="text-slate-400 text-sm mt-1">استقرار خودکار {PANEL_NAME} روی Render — Blueprint ساخته شده و سرویس Docker مستقر می‌شود</p>
          </div>
          <button onClick={() => { setRenderError(null); setRenderSaved(false); setRenderShowAdd(true) }} className="btn-primary flex items-center gap-2 bg-teal-600/80 hover:bg-teal-600">
            <Plus className="w-4 h-4" /> افزودن کلید رندر
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <a href={RENDER_TOKENS_PAGE} target="_blank" rel="noopener noreferrer"
            className="group p-4 rounded-xl bg-slate-900/40 border border-teal-500/30 bg-teal-500/5 hover:border-teal-500/50 transition-all">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-teal-500/10"><KeyRound className="w-4 h-4 text-teal-400" /></div>
              <span className="text-xs font-mono text-slate-500">۱</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">ساخت کلید API رندر</h3>
            <p className="text-xs text-slate-400 leading-relaxed">حساب رندر بسازید و از <span className="text-teal-300" dir="ltr">dashboard.render.com/account/api-keys</span> یک کلید بسازید — کلید فقط یک‌بار نمایش داده می‌شود.</p>
            <span className="inline-flex items-center gap-1 text-xs text-teal-300 mt-3 group-hover:gap-2 transition-all">ساخت کلید <ExternalLink className="w-3 h-3" /></span>
          </a>
          <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/50">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-brand-500/10"><Sparkles className="w-4 h-4 text-brand-400" /></div>
              <span className="text-xs font-mono text-slate-500">۲</span>
            </div>
            <h3 className="text-sm font-bold text-white mb-1">استقرار در ویزارد</h3>
            <p className="text-xs text-slate-400 leading-relaxed">در صفحه استقرار روش <b>Render.com</b> را انتخاب کنید — سرویس Docker از مخزن پنل اختصاصی ساخته و مستقر می‌شود.</p>
          </div>
        </div>

        {renderLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-teal-400" /></div>
        ) : renderTokens.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <div className="inline-flex w-14 h-14 rounded-2xl bg-teal-500/10 items-center justify-center mb-3">
              <Cloud className="w-7 h-7 text-teal-400" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">هنوز کلید API رندر اضافه نشده</h3>
            <p className="text-slate-400 text-sm">برای استقرار خودکار {PANEL_NAME} روی Render یک کلید API بسازید و اضافه کنید</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {renderTokens.map((t, i) => (
              <div key={t.id} className="glass-card glass-card-hover p-5 animate-slide-up" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-teal-500/10">
                      <Cloud className="w-5 h-5 text-teal-400" />
                    </div>
                    <div>
                      <h3 className="font-bold text-white">{t.name}</h3>
                      <span className="badge bg-green-500/10 text-green-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                        {t.status === 'active' ? 'فعال' : 'غیرفعال'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => handleRenderDelete(t.id, t.name)} className="p-2 rounded-lg text-slate-500 hover:bg-error-500/10 hover:text-error-400 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {t.account_name && (
                  <p className="text-xs text-slate-500 mb-2" dir="ltr">{t.account_name}</p>
                )}
                <div className="flex items-center gap-2 bg-slate-900/50 rounded-xl px-3 py-2 border border-slate-800/50">
                  <code className="flex-1 text-sm text-slate-400 font-mono" dir="ltr">••••••••••••{t.token_tail}</code>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  {t.last_used_at ? `آخرین استفاده: ${new Date(t.last_used_at).toLocaleString('fa-IR')}` : 'هنوز استفاده نشده'}
                  {' • '}
                  ساخته شده در {new Date(t.created_at).toLocaleDateString('fa-IR')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setShowAdd(false)}>
          <div className="glass-card p-6 w-full max-w-md animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-brand-400" /> توکن جدید
              </h2>
              <button onClick={() => setShowAdd(false)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleAdd} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">نام توکن</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مثلاً: توکن اصلی"
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">توکن API کلودفلر</label>
                <textarea
                  required
                  value={newToken}
                  onChange={(e) => { setNewToken(e.target.value); setAddError(null) }}
                  placeholder="توکن را اینجا paste کنید..."
                  rows={3}
                  className="input-field font-mono text-sm"
                  dir="ltr"
                />
              </div>
              {addError && (
                <div className="px-3 py-2 rounded-xl bg-error-500/10 border border-error-500/30 text-xs text-error-300">
                  {addError}
                </div>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={saving} className="btn-primary flex-1 flex items-center justify-center gap-2">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  ذخیره توکن
                </button>
                <button type="button" onClick={() => setShowAdd(false)} className="btn-ghost">انصراف</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Railway add modal */}
      {railShowAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => { if (!railSaving) setRailShowAdd(false) }}>
          <div className="glass-card p-6 w-full max-w-md animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <TrainFront className="w-5 h-5 text-purple-400" /> توکن جدید Railway
              </h2>
              <button onClick={() => setRailShowAdd(false)} disabled={railSaving} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRailAdd} className="space-y-4">
              <div className="px-3 py-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 text-xs text-purple-200 leading-relaxed">
                توکن را از <a href={RAILWAY_TOKENS_PAGE} target="_blank" rel="noopener noreferrer" className="underline">railway.com/account/tokens</a> بگیرید — توکن فقط همان لحظه نمایش داده می‌شود و قبل از ذخیره در اینجا با Railway بررسی می‌شود.
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">نام توکن</label>
                <input
                  type="text"
                  required
                  value={railName}
                  onChange={(e) => setRailName(e.target.value)}
                  placeholder="مثلاً: Railway اصلی"
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">توکن Account Railway</label>
                <textarea
                  required
                  value={railToken}
                  onChange={(e) => { setRailToken(e.target.value); setRailError(null) }}
                  placeholder="توکن را اینجا paste کنید..."
                  rows={3}
                  className="input-field font-mono text-sm"
                  dir="ltr"
                />
              </div>
              {railError && (
                <div className="px-3 py-2 rounded-xl bg-error-500/10 border border-error-500/30 text-xs text-error-300">
                  {railError}
                </div>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={railSaving} className="btn-primary flex-1 flex items-center justify-center gap-2 bg-purple-600/80 hover:bg-purple-600">
                  {railSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : railSaved ? <Check className="w-4 h-4 text-white" /> : <Plus className="w-4 h-4" />}
                  {railSaving ? 'در حال بررسی با Railway...' : railSaved ? 'تأیید و ذخیره شد ✓' : 'تأیید و ذخیره'}
                </button>
                <button type="button" onClick={() => setRailShowAdd(false)} disabled={railSaving} className="btn-ghost">انصراف</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Render add modal */}
      {renderShowAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => { if (!renderSaving) setRenderShowAdd(false) }}>
          <div className="glass-card p-6 w-full max-w-md animate-slide-up" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Cloud className="w-5 h-5 text-teal-400" /> کلید جدید API رندر
              </h2>
              <button onClick={() => setRenderShowAdd(false)} disabled={renderSaving} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/50">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleRenderAdd} className="space-y-4">
              <div className="px-3 py-2.5 rounded-xl bg-teal-500/10 border border-teal-500/20 text-xs text-teal-200 leading-relaxed">
                کلید را از <a href={RENDER_TOKENS_PAGE} target="_blank" rel="noopener noreferrer" className="underline">dashboard.render.com/account/api-keys</a> بگیرید — کلید فقط همان لحظه نمایش داده می‌شود و قبل از ذخیره در اینجا با رندر بررسی می‌شود.
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">نام کلید</label>
                <input
                  type="text"
                  required
                  value={renderName}
                  onChange={(e) => setRenderName(e.target.value)}
                  placeholder="مثلاً: رندر اصلی"
                  className="input-field"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">کلید API رندر (rnd_...)</label>
                <textarea
                  required
                  value={renderToken}
                  onChange={(e) => { setRenderToken(e.target.value); setRenderError(null) }}
                  placeholder="کلید را اینجا paste کنید..."
                  rows={3}
                  className="input-field font-mono text-sm"
                  dir="ltr"
                />
              </div>
              {renderError && (
                <div className="px-3 py-2 rounded-xl bg-error-500/10 border border-error-500/30 text-xs text-error-300">
                  {renderError}
                </div>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={renderSaving} className="btn-primary flex-1 flex items-center justify-center gap-2 bg-teal-600/80 hover:bg-teal-600">
                  {renderSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : renderSaved ? <Check className="w-4 h-4 text-white" /> : <Plus className="w-4 h-4" />}
                  {renderSaving ? 'در حال بررسی با رندر...' : renderSaved ? 'تأیید و ذخیره شد ✓' : 'تأیید و ذخیره'}
                </button>
                <button type="button" onClick={() => setRenderShowAdd(false)} disabled={renderSaving} className="btn-ghost">انصراف</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

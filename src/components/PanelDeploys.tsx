/**
 * "پنل اختصاصی ما" — the one catalog panel this installation ships, together
 * with every deployment of it the signed-in user owns.
 *
 * The dashboard, the deployments page and the members page all render this
 * component, so the panel spec (path, health path, volume, port) and its live
 * state are defined in exactly one place. It reads its data from
 * `GET /api/panels` and drives the three panel actions:
 *
 *   • بررسی زنده  → POST /panels/watch   (polls the platform, bootstraps admin once)
 *   • بررسی سلامت → POST /panels/health  (fetches the panel's own /health from the edge)
 *   • آخرین نسخه  → POST /panels/update  (deploys the newest connected-repo commit)
 *   • حذف از فهرست → POST /panels/forget (forgets the record; the service keeps running)
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Github,
  HardDrive,
  KeyRound,
  Loader2,
  RefreshCw,
  Rocket,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api } from '../lib/api'
import type { HostedPanelDeploy, HostedPanelHealth, HostedPanelOverview, HostedPanelWatch } from '../lib/types'

interface Props {
  /** `card` = dashboard summary (fits in a glass card), `full` = deployments tab. */
  variant?: 'card' | 'full'
}

/** Live state we last observed for a deployment (null = never checked). */
interface LiveState {
  state: 'pending' | 'failed' | 'live'
  status: string
  health?: HostedPanelHealth
}

const PLATFORM_LABEL: Record<HostedPanelDeploy['platform'], string> = {
  railway: 'Railway',
  render: 'Render',
}

/** Deployment-target chip label (the spec also lists `vps`). */
const TARGET_LABEL: Record<string, string> = { railway: 'Railway', render: 'Render', vps: 'VPS' }

export default function PanelDeploys({ variant = 'card' }: Props) {
  const [data, setData] = useState<HostedPanelOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Record<string, LiveState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: HostedPanelOverview }>('/panels')
      setData(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت پنل')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const key = (d: HostedPanelDeploy) => `${d.platform}:${d.id}`

  /** Poll the platform for a deploy; on the live transition the admin is bootstrapped. */
  const watch = async (d: HostedPanelDeploy) => {
    setBusy(key(d))
    try {
      const { data: res } = await api<{ data: HostedPanelWatch }>('/panels/watch', {
        method: 'POST',
        body: { platform: d.platform, id: d.id },
      })
      setLive((prev) => ({
        ...prev,
        [key(d)]: { state: res.state, status: res.status, health: prev[key(d)]?.health },
      }))
      if (res.state === 'live') {
        // The panel refused to switch a published raw-TCP port on — the deploy
        // itself is fine, so it is a warning rather than a failed state.
        if (res.capabilitiesError) setError(res.capabilitiesError)
        await load()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'بررسی وضعیت ناموفق بود')
    } finally {
      setBusy(null)
    }
  }

  /** Probe the panel's own health endpoint from the edge. */
  const checkHealth = async (d: HostedPanelDeploy) => {
    setBusy(key(d))
    try {
      const { data: health } = await api<{ data: HostedPanelHealth }>('/panels/health', {
        method: 'POST',
        body: { platform: d.platform, id: d.id },
      })
      setLive((prev) => ({ ...prev, [key(d)]: { ...(prev[key(d)] ?? { state: 'pending', status: '' }), health } }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'بررسی سلامت ناموفق بود')
    } finally {
      setBusy(null)
    }
  }

  /** Deploy the newest commit from the panel's connected Railway repository. */
  const updateLatest = async (d: HostedPanelDeploy) => {
    if (d.platform !== 'railway') return
    setBusy(key(d))
    setError(null)
    try {
      const { data: update } = await api<{ data: { deploymentId: string; commitSha: string } }>('/panels/update', {
        method: 'POST',
        body: { platform: d.platform, id: d.id },
      })
      setLive((prev) => ({
        ...prev,
        [key(d)]: { state: 'pending', status: 'QUEUED', health: prev[key(d)]?.health },
      }))
      await load()
      setCopied(`updated:${update.deploymentId}`)
      setTimeout(() => setCopied(null), 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'استقرار آخرین نسخه ناموفق بود')
    } finally {
      setBusy(null)
    }
  }

  /** Forget the record inside miliconfig (the service itself keeps running). */
  const forget = async (d: HostedPanelDeploy) => {
    if (!confirm(`پنل «${d.name ?? d.panelName}» از فهرست این پنل حذف شود؟ سرویس روی ${PLATFORM_LABEL[d.platform]} به کار خود ادامه می‌دهد.`)) return
    setBusy(key(d))
    try {
      await api('/panels/forget', { method: 'POST', body: { platform: d.platform, id: d.id } })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'حذف ناموفق بود')
    } finally {
      setBusy(null)
    }
  }

  const copy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 1800)
  }

  if (loading) {
    return (
      <div className="glass-card p-6 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
      </div>
    )
  }

  const panel = data?.panel
  const deploys = data?.deploys ?? []
  const shown = variant === 'card' ? deploys.slice(0, 2) : deploys

  return (
    <div className={variant === 'card' ? 'glass-card p-6' : 'space-y-4'}>
      {/* ── Panel identity ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <img src="/icon.svg" alt="" aria-hidden="true" className="w-12 h-12 rounded-2xl border border-brand-300/35 shrink-0" />
          <div className="min-w-0">
            <p className="eyebrow">OUR OWN PANEL</p>
            <h2 className="text-lg font-bold text-white leading-tight">{panel?.name ?? 'پنل اختصاصی ما'}</h2>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{panel?.tagline}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link to="/deploy" className="btn-primary text-sm flex items-center gap-2">
            <Rocket className="w-4 h-4" /> استقرار پنل جدید
          </Link>
          <button onClick={() => void load()} className="btn-ghost text-sm flex items-center gap-2" title="بروزرسانی فهرست">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── Spec chips: where it runs, how it is reached, what must persist ── */}
      {panel && (
        <div className="flex flex-wrap items-center gap-2 mt-4 text-xs">
          <span className="chip" dir="ltr">
            <Github className="w-3.5 h-3.5" /> {panel.repo}
          </span>
          <span className="chip" dir="ltr">
            <Server className="w-3.5 h-3.5" /> :{panel.port}
          </span>
          <span className="chip" dir="ltr">
            <ShieldCheck className="w-3.5 h-3.5" /> {panel.panelPath}
          </span>
          <span className="chip" dir="ltr">
            <Activity className="w-3.5 h-3.5" /> {panel.healthPath}
          </span>
          {panel.dataVolume && (
            <span className="chip" dir="ltr">
              <HardDrive className="w-3.5 h-3.5" /> {panel.dataVolume}
            </span>
          )}
          {panel.targets.map((t) => (
            <span key={t} className="chip-live">
              {TARGET_LABEL[t] ?? t}
            </span>
          ))}
          {panel.verifiedAt && <span className="chip">بررسی‌شده {panel.verifiedAt}</span>}
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 text-xs text-error-300 px-3 py-2 rounded-lg bg-error-500/10 border border-error-500/30">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* ── Deployments ────────────────────────────────────────────────── */}
      {deploys.length === 0 ? (
        <div className="mt-5 p-6 rounded-2xl border border-dashed border-brand-300/30 bg-brand-500/5 text-center">
          <Cloud className="w-9 h-9 text-brand-300 mx-auto mb-3" />
          <p className="text-sm font-bold text-white">هنوز پنل اختصاصی مستقر نشده</p>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            با توکن Railway یا کلید Render، همین پنل در چند دقیقه بالا می‌آید؛ مسیر پنل <code dir="ltr">{panel?.panelPath}</code> و
            دیتابیس روی <code dir="ltr">{panel?.dataVolume ?? '/data'}</code> ذخیره می‌شود.
          </p>
          <div className="flex items-center justify-center gap-3 mt-4">
            <Link to="/tokens" className="btn-ghost text-sm">
              ۱. افزودن توکن
            </Link>
            <Link to="/deploy" className="btn-primary text-sm">
              ۲. استقرار پنل
            </Link>
          </div>
        </div>
      ) : (
        <div className={`mt-5 grid grid-cols-1 ${variant === 'full' ? 'lg:grid-cols-2' : ''} gap-4`}>
          {shown.map((d) => {
            const k = key(d)
            const state = live[k]
            const busyHere = busy === k
            const isRevealed = revealed.has(k)
            return (
              <div key={k} className="rounded-2xl border border-white/[0.07] bg-black/30 p-4 animate-slide-up">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-white truncate" dir="ltr">{d.name ?? d.panelName}</p>
                    <p className="text-xs text-slate-500 mt-0.5" dir="ltr">
                      {PLATFORM_LABEL[d.platform]} · {d.id.slice(0, 8)}…
                    </p>
                  </div>
                  <span
                    className={
                      'chip ' + (state?.state === 'live' ? 'chip-live' : state?.state === 'failed' ? 'text-error-300' : '')
                    }
                  >
                    {state
                      ? state.state === 'live'
                        ? 'زنده'
                        : state.state === 'failed'
                          ? 'ناموفق'
                          : 'در حال ساخت'
                      : d.setupDone
                        ? 'مستقر'
                        : 'بررسی‌نشده'}
                  </span>
                </div>

                {d.commitUrl && (
                  <a href={d.commitUrl} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white inline-flex items-center gap-1" dir="ltr">
                    <Github className="w-3.5 h-3.5" /> {d.commitSha?.slice(0, 7) ?? 'latest'}
                  </a>
                )}
                {(d.tcpProxies?.length ?? 0) > 0 && (
                  <span className="text-slate-400 inline-flex items-center gap-1" dir="ltr" title="Railway TCP Proxy">
                    <Server className="w-3.5 h-3.5" />
                    {d.tcpProxies!.map((p) => `${p.label}: ${p.domain}:${p.port}`).join(' · ')}
                  </span>
                )}
                {d.tcpProxyError && (
                  <span className="text-warning-300 inline-flex items-center gap-1" title={d.tcpProxyError}>
                    <AlertTriangle className="w-3.5 h-3.5" /> TCP Proxy نیاز به بررسی
                  </span>
                )}

                {/* Links: open the panel, or jump to the platform dashboard */}
                <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                  {d.panelUrl ? (
                    <a href={d.panelUrl} target="_blank" rel="noopener noreferrer" className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1">
                      <ExternalLink className="w-3.5 h-3.5" /> ورود به پنل
                    </a>
                  ) : (
                    <span className="text-slate-500">دامنه هنوز ساخته نشده</span>
                  )}
                  {d.url && (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white inline-flex items-center gap-1" dir="ltr">
                      {d.domain}
                    </a>
                  )}
                  {d.dashboardUrl && (
                    <a href={d.dashboardUrl} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-white inline-flex items-center gap-1">
                      <ExternalLink className="w-3.5 h-3.5" /> داشبورد {PLATFORM_LABEL[d.platform]}
                    </a>
                  )}
                </div>

                {/* One-time admin credentials */}
                {d.adminUsername && d.adminPassword && (
                  <div className="mt-3 rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                    <p className="text-[11px] text-slate-500 mb-1 flex items-center gap-1">
                      <KeyRound className="w-3 h-3" /> حساب ادمین پنل — فقط همین‌جا نمایش داده می‌شود
                    </p>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <code className="text-xs text-slate-300" dir="ltr">
                        {d.adminUsername} / {isRevealed ? d.adminPassword : '•'.repeat(12)}
                      </code>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            const next = new Set(revealed)
                            if (isRevealed) next.delete(k)
                            else next.add(k)
                            setRevealed(next)
                          }}
                          className="text-[11px] text-slate-400 hover:text-white px-2 py-1 rounded-lg border border-white/[0.08]"
                        >
                          {isRevealed ? 'پنهان' : 'نمایش'}
                        </button>
                        <button
                          onClick={() => copy(`${d.adminUsername} / ${d.adminPassword}`, k)}
                          className="text-[11px] text-slate-400 hover:text-white px-2 py-1 rounded-lg border border-white/[0.08] inline-flex items-center gap-1"
                        >
                          {copied === k ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          {copied === k ? 'کپی شد' : 'کپی'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Health probe result */}
                {state?.health && (
                  <p className={`text-[11px] mt-2 ${state.health.ok ? 'text-brand-300' : 'text-warning-300'}`} dir="ltr">
                    {state.health.ok
                      ? `health ✓ ${state.health.status} — ${state.health.ms}ms`
                      : `health ✗ ${state.health.status ?? state.health.error ?? 'no response'} — ${state.health.ms}ms`}
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    onClick={() => void watch(d)}
                    disabled={busyHere}
                    className="btn-secondary text-xs flex items-center gap-1.5"
                  >
                    {busyHere ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    بررسی زنده
                  </button>
                  <button
                    onClick={() => void checkHealth(d)}
                    disabled={busyHere || !d.url}
                    className="btn-ghost text-xs flex items-center gap-1.5"
                  >
                    <Activity className="w-3.5 h-3.5" /> بررسی سلامت
                  </button>
                  {d.platform === 'railway' && (
                    <button
                      onClick={() => void updateLatest(d)}
                      disabled={busyHere}
                      className="btn-secondary text-xs flex items-center gap-1.5"
                      title="آخرین commit شاخه main مخزن متصل را همین حالا مستقر می‌کند"
                    >
                      {busyHere ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
                      استقرار آخرین نسخه
                    </button>
                  )}
                  {state?.state === 'live' && (
                    <span className="text-[11px] text-brand-300 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> روی {PLATFORM_LABEL[d.platform]} زنده است
                    </span>
                  )}
                  <button
                    onClick={() => void forget(d)}
                    disabled={busyHere}
                    className="text-xs text-slate-500 hover:text-error-300 inline-flex items-center gap-1 ms-auto"
                    title="فقط از فهرست این پنل حذف می‌شود"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> حذف از فهرست
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Volume / Reality caveat — the deployment only works with these ── */}
      {panel?.notes && variant === 'full' && (
        <div className="mt-4 rounded-2xl border border-warning-500/25 bg-warning-500/5 p-4">
          <p className="text-xs text-warning-300 flex items-center gap-2 mb-1">
            <AlertTriangle className="w-4 h-4" /> نکات مهم این پنل
          </p>
          <p className="text-xs text-slate-400 leading-relaxed">{panel.notes}</p>
        </div>
      )}

      {variant === 'card' && deploys.length > 2 && (
        <Link to="/deployments?tab=panels" className="text-xs text-brand-400 hover:text-brand-300 inline-block mt-4">
          همهٔ {deploys.length} پنل مستقرشده ←
        </Link>
      )}
    </div>
  )
}

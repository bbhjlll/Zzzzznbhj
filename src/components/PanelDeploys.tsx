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
 *   • بروزرسانی   → POST /panels/update  (rebuilds the service from the newest commit)
 *   • بروزرسانی خودکار → POST /panels/auto-update (scheduled sweep keeps it current)
 *   • حذف از فهرست → POST /panels/forget (forgets the record; the service keeps running)
 *
 * It also carries the **direct deploy** control: one click in the app starts a
 * brand-new panel on Railway in the chosen region — the exact same engine the
 * bot and the wizard use (worker/panel-deploy.ts) — and follows it until it is
 * live, without a multi-step wizard in between.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
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
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import { applyPanelRepo, DEFAULT_RAILWAY_REGION, RAILWAY_REGIONS, railwayRegionLabel, resolveRailwayRegion } from '../../shared/panels'
import { api } from '../lib/api'
import type {
  HostedPanelDeploy,
  HostedPanelHealth,
  HostedPanelOverview,
  HostedPanelUpdate,
  HostedPanelWatch,
  RailwayToken,
} from '../lib/types'

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

/** A partial settings change sent to `POST /panels/settings`. */
type SettingsPatch = {
  region?: string
  sleepApplication?: boolean
  ipv6Egress?: boolean
  cdnEnabled?: boolean
}

/** Shape `POST /railway/deploy` answers with (the direct deploy control). */
interface DirectDeployResponse {
  deploymentId: string
  projectUrl: string
  domain: string | null
  admin_username: string
  admin_password: string
  /** Region Railway actually confirmed, plus its Persian label. */
  region: string
  region_label: string
}

/** Railway deployment states, translated for the log line. */
const RAILWAY_STATE_LABEL: Record<string, string> = {
  QUEUED: 'در صف',
  INITIALIZING: 'در حال شروع',
  WAITING: 'در انتظار',
  BUILDING: 'در حال بیلد (Docker)',
  DEPLOYING: 'در حال استقرار',
  SUCCESS: 'موفق',
  FAILED: 'ناموفق',
  CRASHED: 'کرش',
  SLEEPING: 'خواب',
  SUCCESS_NO_DOMAIN: 'موفق — دامنه در حال ساخت',
}

/** A fresh, valid Railway project name for a direct deploy. */
function directDeployName(): string {
  const suffix = Math.random().toString(36).slice(2, 6)
  return `panel-${suffix}`
}

/** One on/off row of the service-settings panel. */
function SettingToggle({
  label,
  hint,
  value,
  disabled,
  onToggle,
}: {
  label: string
  hint: string
  value: boolean | null
  disabled: boolean
  onToggle: (next: boolean) => void
}) {
  const on = value === true
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(!on)}
      className="w-full flex items-start gap-2.5 text-start disabled:opacity-50"
    >
      <span
        className={`mt-0.5 w-8 h-4 shrink-0 rounded-full border transition-colors relative ${
          on ? 'bg-brand-500/40 border-brand-300/50' : 'bg-slate-700/50 border-white/[0.08]'
        }`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${on ? 'bg-brand-300 start-4' : 'bg-slate-400 start-0.5'}`}
        />
      </span>
      <span className="min-w-0">
        <span className={`block text-xs ${on ? 'text-brand-300' : 'text-slate-300'}`}>{label}</span>
        <span className="block text-[10px] text-slate-500 leading-relaxed">{hint}</span>
      </span>
    </button>
  )
}

export default function PanelDeploys({ variant = 'card' }: Props) {
  const [data, setData] = useState<HostedPanelOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<Record<string, LiveState>>({})
  const [busy, setBusy] = useState<string | null>(null)
  /** Separate from `busy` so only the button that was clicked shows a spinner. */
  const [updating, setUpdating] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  /** Which deployment's service-settings panel is expanded. */
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  /** Outcome of the last settings change (a caveat the platform reported). */
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null)
  /** The direct-deploy control: region, token, live progress and result. */
  const [railTokens, setRailTokens] = useState<RailwayToken[]>([])
  const [directTokenId, setDirectTokenId] = useState('')
  const [directRegion, setDirectRegion] = useState<string>(DEFAULT_RAILWAY_REGION)
  const [directState, setDirectState] = useState<'idle' | 'deploying' | 'live' | 'failed'>('idle')
  const [directLog, setDirectLog] = useState<string[]>([])
  const [directResult, setDirectResult] = useState<
    { name: string; url: string | null; panelUrl: string | null; username: string; password: string; regionLabel: string } | null
  >(null)
  const directPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: HostedPanelOverview }>('/panels')
      // The admin's source override lives server-side; mirror it into the shared
      // catalog so every other screen (wizard, tokens, VPS package) shows — and
      // builds — the same address.
      applyPanelRepo(data.panel.repo)
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

  // ── Editable source address ──────────────────────────────────────────────
  // The panel's repository can move; the admin keeps it current from here and
  // the server applies it to every deploy, the bot and the version probe.
  const [repoDraft, setRepoDraft] = useState('')
  const [repoBusy, setRepoBusy] = useState(false)
  const [repoMsg, setRepoMsg] = useState<string | null>(null)

  useEffect(() => {
    if (data?.panel.repo) setRepoDraft(data.panel.repo)
  }, [data?.panel.repo])

  const saveRepo = async (e?: React.FormEvent, value?: string) => {
    e?.preventDefault()
    const next = (value ?? repoDraft).trim()
    setRepoBusy(true)
    setRepoMsg(null)
    try {
      const { data: res } = await api<{ data: { repo: string; defaultRepo: string; changed: boolean } }>('/panels/repo', {
        method: 'POST',
        body: { repo: next },
      })
      applyPanelRepo(res.repo)
      setRepoMsg(res.changed ? `✓ مخزن منبع روی ${res.repo} تنظیم شد` : '✓ آدرس پیش‌فرض حفظ شد')
      setRepoDraft(res.repo)
      await load()
    } catch (err) {
      setRepoMsg(err instanceof Error ? err.message : 'خطا در ذخیرهٔ آدرس مخزن')
    } finally {
      setRepoBusy(false)
    }
  }

  // The direct deploy needs a Railway credential, so the control knows up front
  // whether it can start (and which token it would use).
  useEffect(() => {
    let cancelled = false
    api<{ data: RailwayToken[] }>('/railway/tokens')
      .then(({ data }) => {
        if (cancelled) return
        const active = (data ?? []).filter((t) => t.status === 'active')
        setRailTokens(active)
        if (active.length) setDirectTokenId((prev) => (prev && active.some((t) => t.id === prev) ? prev : active[0].id))
      })
      .catch(() => { if (!cancelled) setRailTokens([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => () => {
    if (directPollRef.current) clearInterval(directPollRef.current)
  }, [])

  const key = (d: HostedPanelDeploy) => `${d.platform}:${d.id}`

  /**
   * The direct deploy: create the project on Railway in the selected region and
   * follow it to "live" without leaving the page. Same API the bot uses, so the
   * panel, the region and the credentials are created by exactly one engine.
   */
  const directDeploy = async () => {
    if (directState === 'deploying') return
    const token = railTokens.find((t) => t.id === directTokenId) ?? railTokens[0]
    if (!token) {
      setError('برای استقرار مستقیم ابتدا یک توکن Railway اضافه کنید')
      return
    }
    if (directPollRef.current) clearInterval(directPollRef.current)
    const projectName = directDeployName()
    setDirectResult(null)
    setDirectState('deploying')
    setError(null)
    setDirectLog([
      'اتصال به Railway…',
      `منطقهٔ درخواستی: ${railwayRegionLabel(directRegion)}`,
    ])
    try {
      const { data } = await api<{ data: DirectDeployResponse }>('/railway/deploy', {
        method: 'POST',
        body: { token_id: token.id, name: projectName, region: directRegion, panel: panel?.id ?? 'mizetusi' },
      })
      setDirectLog((prev) => [
        ...prev,
        `✓ پروژهٔ «${projectName}» ساخته شد`,
        `✓ منطقهٔ تأییدشده: ${data.region_label}`,
        `✓ ادمین پنل: ${data.admin_username}`,
        '',
        'در حال بیلد روی Railway — معمولاً ۳ تا ۶ دقیقه.',
      ])
      await load()
      const startedAt = Date.now()
      const tick = async () => {
        try {
          const { data: res } = await api<{ data: HostedPanelWatch }>('/panels/watch', {
            method: 'POST',
            body: { platform: 'railway', id: data.deploymentId },
          })
          const label = RAILWAY_STATE_LABEL[res.status] ?? res.status
          setDirectLog((prev) => [...prev.filter((l) => !l.startsWith('وضعیت:')), `وضعیت: ${label}`].slice(-14))
          if (res.state === 'live') {
            if (directPollRef.current) clearInterval(directPollRef.current)
            directPollRef.current = null
            setDirectState('live')
            setDirectResult({
              name: projectName,
              url: res.url ?? data.domain,
              panelUrl: res.url ? `${res.url.replace(/\/+$/, '')}${res.panelPath ?? ''}` : null,
              username: res.adminUsername ?? data.admin_username,
              password: res.adminPassword ?? data.admin_password,
              regionLabel: data.region_label,
            })
            if (res.capabilitiesError) setError(res.capabilitiesError)
            await load()
          } else if (res.state === 'failed') {
            if (directPollRef.current) clearInterval(directPollRef.current)
            directPollRef.current = null
            setDirectState('failed')
            setDirectLog((prev) => [...prev, '❌ استقرار ناموفق بود — لاگ بیلد را در داشبورد Railway بررسی کنید.'])
            await load()
          } else if (Date.now() - startedAt > 12 * 60 * 1000) {
            if (directPollRef.current) clearInterval(directPollRef.current)
            directPollRef.current = null
            setDirectState('failed')
            setDirectLog((prev) => [...prev, '❌ زمان انتظار تمام شد — وضعیت را در داشبورد Railway ببینید.'])
          }
        } catch {
          /* transient network error — keep polling */
        }
      }
      void tick()
      directPollRef.current = setInterval(tick, 4000)
    } catch (e) {
      setDirectState('failed')
      setDirectLog((prev) => [...prev, `❌ ${e instanceof Error ? e.message : 'استقرار مستقیم ناموفق بود'}`])
    }
  }

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

  /**
   * Rebuild one deployment from the newest upstream commit.
   *
   * The row id becomes the deployment that was just started (every deploy row
   * uses the platform deployment id as its id), so the live state moves to the
   * new key — the card keeps showing "در حال ساخت" for the update it triggered.
   */
  const update = async (d: HostedPanelDeploy) => {
    setBusy(key(d))
    setUpdating(key(d))
    try {
      const { data: res } = await api<{ data: HostedPanelUpdate }>('/panels/update', {
        method: 'POST',
        body: { platform: d.platform, id: d.id },
      })
      setLive((prev) => {
        const next = { ...prev }
        delete next[key(d)]
        next[`${d.platform}:${res.id}`] = {
          state: 'pending',
          status: res.version ? `بروزرسانی به ${res.version.short}` : 'بروزرسانی',
        }
        return next
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'بروزرسانی پنل ناموفق بود')
    } finally {
      setUpdating(null)
      setBusy(null)
    }
  }

  /** Opt a deployment in/out of the scheduled latest-version sweep. */
  const toggleAutoUpdate = async (d: HostedPanelDeploy, enabled: boolean) => {
    setBusy(key(d))
    try {
      await api('/panels/auto-update', { method: 'POST', body: { platform: d.platform, id: d.id, enabled } })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تغییر بروزرسانی خودکار ناموفق بود')
    } finally {
      setBusy(null)
    }
  }

  /**
   * Change a running deployment's platform settings (region, Serverless,
   * outbound IPv6, CDN caching). The endpoint returns the refreshed registry, so
   * the card reflects exactly what the platform accepted.
   */
  const saveSettings = async (d: HostedPanelDeploy, patch: SettingsPatch) => {
    setSettingsNotice(null)
    setBusy(key(d))
    try {
      const { data: fresh } = await api<{ data: { deploys: HostedPanelDeploy[]; warning?: string | null } }>('/panels/settings', {
        method: 'POST',
        body: { platform: d.platform, id: d.id, ...patch },
      })
      setData((prev) => (prev ? { ...prev, deploys: fresh.deploys } : prev))
      setSettingsNotice(fresh.warning ?? null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تغییر تنظیمات ناموفق بود')
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
          {data?.latestVersion && (
            <a
              href={data.latestVersion.url}
              target="_blank"
              rel="noopener noreferrer"
              className="chip-live"
              title={data.latestVersion.message ?? 'آخرین کامیت مخزن بالادست'}
            >
              <ArrowUpCircle className="w-3.5 h-3.5" />
              آخرین نسخهٔ بالادست: <code dir="ltr">{data.latestVersion.short}</code>
              {data.latestVersion.date ? ` · ${data.latestVersion.date.slice(0, 10)}` : ''}
            </a>
          )}
        </div>
      )}

      {/* ── Source address: the admin repoints the panel whenever it moves ── */}
      {panel && (
        <form onSubmit={saveRepo} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="panel-source-repo" className="text-xs text-slate-400 shrink-0">
            مخزن منبع پنل
          </label>
          <input
            id="panel-source-repo"
            dir="ltr"
            value={repoDraft}
            onChange={(e) => setRepoDraft(e.target.value)}
            placeholder="owner/name"
            className="input-field font-mono text-xs flex-1 min-w-[16rem]"
          />
          <button type="submit" disabled={repoBusy} className="btn-ghost text-xs flex items-center gap-1.5">
            {repoBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            ذخیرهٔ آدرس
          </button>
          {panel.defaultRepo && panel.repo !== panel.defaultRepo && (
            <button
              type="button"
              onClick={() => {
                setRepoDraft(panel.defaultRepo)
                void saveRepo(undefined, panel.defaultRepo)
              }}
              className="btn-ghost text-xs text-slate-400"
            >
              بازگشت به {panel.defaultRepo}
            </button>
          )}
        </form>
      )}
      {repoMsg && <p className="mt-2 text-xs text-slate-400" dir="auto">{repoMsg}</p>}

      {error && (
        <div className="mt-4 flex items-start gap-2 text-xs text-error-300 px-3 py-2 rounded-lg bg-error-500/10 border border-error-500/30">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* ── Direct deploy — one click, region chosen here ──────────────── */}
      <div className="mt-5 rounded-2xl border border-brand-300/30 bg-brand-500/[0.06] p-4" data-guide="p-direct-deploy">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-white flex items-center gap-2">
              <Rocket className="w-4 h-4 text-brand-300" /> استقرار مستقیم روی Railway
            </p>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              بدون ویزارد: پروژه ساخته می‌شود، منطقه دقیقاً همان چیزی است که اینجا انتخاب می‌کنید و رمز ادمین یک‌بار نمایش داده می‌شود.
            </p>
          </div>
          <span className="chip" dir="ltr">
            📍 {railwayRegionLabel(directRegion)}
          </span>
        </div>

        {railTokens.length === 0 ? (
          <div className="flex flex-wrap items-center gap-3 mt-3">
            <p className="text-xs text-slate-300">
              برای استقرار مستقیم یک توکن Railway اضافه کنید (Account Settings → Tokens).
            </p>
            <Link to="/tokens" className="btn-secondary text-xs">
              <KeyRound className="w-3.5 h-3.5" /> افزودن توکن Railway
            </Link>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-3">
            <label className="sr-only" htmlFor="direct-region">منطقهٔ استقرار</label>
            <select
              id="direct-region"
              value={directRegion}
              disabled={directState === 'deploying'}
              onChange={(e) => setDirectRegion(e.target.value)}
              className="bg-slate-900/70 border border-white/[0.08] rounded-lg px-2 py-2 text-xs text-slate-200 disabled:opacity-50"
              title="منطقهٔ استقرار روی Railway"
            >
              {RAILWAY_REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} — {r.area}
                </option>
              ))}
            </select>
            {railTokens.length > 1 && (
              <select
                value={directTokenId}
                disabled={directState === 'deploying'}
                onChange={(e) => setDirectTokenId(e.target.value)}
                className="bg-slate-900/70 border border-white/[0.08] rounded-lg px-2 py-2 text-xs text-slate-200 disabled:opacity-50"
                title="توکن Railway"
              >
                {railTokens.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => void directDeploy()}
              disabled={directState === 'deploying'}
              className="btn-primary text-sm flex items-center justify-center gap-2"
            >
              {directState === 'deploying' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> در حال استقرار…
                </>
              ) : (
                <>
                  <Rocket className="w-4 h-4" /> استقرار مستقیم پنل
                </>
              )}
            </button>
          </div>
        )}

        {directLog.length > 0 && (
          <pre
            dir="ltr"
            className="mt-3 max-h-44 overflow-auto rounded-xl bg-black/50 border border-white/[0.06] p-3 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap"
          >
            {directLog.join('\n')}
          </pre>
        )}

        {directResult && (
          <div className="mt-3 rounded-xl border border-brand-300/30 bg-black/30 p-3 space-y-2">
            <p className="text-xs text-brand-300 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> «{directResult.name}» روی {directResult.regionLabel} زنده شد
            </p>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {directResult.panelUrl && (
                <a href={directResult.panelUrl} target="_blank" rel="noopener noreferrer" className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1" dir="ltr">
                  <ExternalLink className="w-3.5 h-3.5" /> {directResult.panelUrl}
                </a>
              )}
              <code className="text-slate-300" dir="ltr">
                {directResult.username} / {directResult.password}
              </code>
              <button
                onClick={() => copy(`${directResult.username} / ${directResult.password}`, 'direct')}
                className="text-[11px] text-slate-400 hover:text-white px-2 py-1 rounded-lg border border-white/[0.08] inline-flex items-center gap-1"
              >
                {copied === 'direct' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied === 'direct' ? 'کپی شد' : 'کپی رمز ادمین'}
              </button>
            </div>
          </div>
        )}
      </div>

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
            const updatingHere = updating === k
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

                {/* Update state: what revision this deployment was last pointed at */}
                {(d.lastUpdatedAt || d.lastVersion) && (
                  <p className="text-[11px] text-slate-500 mt-2">
                    آخرین بروزرسانی:{' '}
                    {d.lastUpdatedAt ? new Date(d.lastUpdatedAt).toLocaleString('fa-IR') : '—'}
                    {d.lastVersion ? (
                      <>
                        {' '}
                        · نسخه <code dir="ltr">{d.lastVersion.slice(0, 7)}</code>
                      </>
                    ) : null}
                  </p>
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
                  <button
                    onClick={() => void update(d)}
                    disabled={busyHere}
                    data-guide="p-update"
                    className="btn-ghost text-xs flex items-center gap-1.5"
                    title="سرویس فعلی از نو ساخته می‌شود و روی آخرین نسخهٔ مخزن بالادست می‌رود"
                  >
                    {updatingHere ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUpCircle className="w-3.5 h-3.5" />}
                    بروزرسانی به آخرین نسخه
                  </button>
                  <button
                    onClick={() => void toggleAutoUpdate(d, !d.autoUpdate)}
                    disabled={busyHere}
                    data-guide="p-auto-update"
                    className={`text-xs inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors ${
                      d.autoUpdate ? 'text-brand-300 border-brand-300/40 bg-brand-500/10' : 'text-slate-400 border-white/[0.08]'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${d.autoUpdate ? 'bg-brand-300 animate-pulse-dot' : 'bg-slate-600'}`} />
                    بروزرسانی خودکار {d.autoUpdate ? 'روشن' : 'خاموش'}
                  </button>
                  {state?.state === 'live' && (
                    <span className="text-[11px] text-brand-300 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> روی {PLATFORM_LABEL[d.platform]} زنده است
                    </span>
                  )}
                  {d.platform === 'railway' && (
                    <button
                      onClick={() => setSettingsFor(settingsFor === key(d) ? null : key(d))}
                      disabled={busyHere}
                      data-guide="p-settings"
                      className={`text-xs inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-colors ${
                        settingsFor === key(d) ? 'text-brand-300 border-brand-300/40 bg-brand-500/10' : 'text-slate-400 border-white/[0.08]'
                      }`}
                      title="منطقه، Serverless، Outbound IPv6 و CDN"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" /> تنظیمات سرویس
                    </button>
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

                {/* Service settings — the same knobs the Railway dashboard exposes */}
                {d.platform === 'railway' && settingsFor === key(d) && (
                  <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 space-y-3">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] text-slate-400">منطقهٔ استقرار</label>
                        <span className="text-[10px] text-slate-500">{railwayRegionLabel(d.region ?? DEFAULT_RAILWAY_REGION)}</span>
                      </div>
                      <select
                        value={resolveRailwayRegion(d.region) ?? DEFAULT_RAILWAY_REGION}
                        disabled={busyHere}
                        onChange={(e) => void saveSettings(d, { region: e.target.value })}
                        className="w-full bg-slate-900/70 border border-white/[0.08] rounded-lg px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                        dir="ltr"
                      >
                        {RAILWAY_REGIONS.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label} — {r.area}
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                        تغییر منطقه بدون قطعی است، مگر پنل Volume داشته باشد؛ در آن صورت منتقل‌شدن حجم کمی طول می‌کشد و سرویس موقتاً قطع می‌شود.
                      </p>
                    </div>

                    <SettingToggle
                      label="Serverless (خواب در بی‌کاری)"
                      hint="کانتینر بدون ترافیک به صفر مقیاس می‌دهد و با درخواست بعدی بیدار می‌شود؛ هزینهٔ مصرف کمتر می‌شود."
                      value={d.sleepApplication}
                      disabled={busyHere}
                      onToggle={(v) => void saveSettings(d, { sleepApplication: v })}
                    />
                    <SettingToggle
                      label="Outbound IPv6"
                      hint="اجازهٔ اتصال خروجی به مقصدهای IPv6 (مثل برخی سرویس‌های ایمیلی/API)."
                      value={d.ipv6Egress}
                      disabled={busyHere}
                      onToggle={(v) => void saveSettings(d, { ipv6Egress: v })}
                    />
                    <SettingToggle
                      label="CDN Caching"
                      hint="کش‌کردن فایل‌های استاتیک در لبه؛ نیاز به دامنهٔ عمومی دارد و برای پنل‌های لاگین‌محور معمولاً لازم نیست."
                      value={d.cdnEnabled}
                      disabled={busyHere}
                      onToggle={(v) => void saveSettings(d, { cdnEnabled: v })}
                    />
                    {busyHere && (
                      <p className="text-[10px] text-brand-300 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> در حال اعمال…
                      </p>
                    )}
                    {settingsNotice && (
                      <p className="text-[10px] text-warning-300 leading-relaxed flex items-start gap-1">
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {settingsNotice}
                      </p>
                    )}
                  </div>
                )}
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

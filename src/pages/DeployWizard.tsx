import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import {
  Rocket,
  Loader2,
  Check,
  ChevronLeft,
  Settings,
  Cloud,
  AlertCircle,
  Sparkles,
  Terminal,
  RefreshCw,
  ExternalLink,
  Mail,
  KeyRound,
  TrainFront,
} from 'lucide-react'
import JSZip from 'jszip'
import { generateDockerCompose, generateNginxConf, generateEnvFile, generateDeployScript, generateRailwayDockerfile, generateRailwayToml, generateRailwayReadme } from '../lib/vps-deploy'
import type { CFToken, RailwayToken, RenderToken } from '../lib/types'
import { DEFAULT_RAILWAY_REGION, PANELS, railwayRegionLabel } from '../../shared/panels'

/**
 * The panel this wizard installs. The catalog ships a single, first-party panel
 * (see shared/panels.ts), so every label, port, path and generated file below is
 * derived from it — nothing panel-specific is hardcoded here any more.
 */
const PANEL = PANELS[0]
const PANEL_PORT = String(PANEL.port)

function genUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function genName() {
  return 'edge-relay-' + genUuid().slice(0, 4)
}

function validName(n: string) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(n ?? '')
}

function validPath(p: string) {
  return !p || /^\/?[A-Za-z0-9_-]+$/.test(p)
}

export default function DeployWizard() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(1)
  const [tokens, setTokens] = useState<CFToken[]>([])
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState(genName())
  const [uuid, setUuid] = useState(genUuid())
  const [customPath, setCustomPath] = useState('')
  const [selectedToken, setSelectedToken] = useState('')
  const [method, setMethod] = useState<'workers' | 'pages' | 'vps' | 'railway' | 'render'>('workers')
  const [workerSource, setWorkerSource] = useState('edgetunnel')
  const [proxyIP, setProxyIP] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployLogs, setDeployLogs] = useState<string[]>([])
  const [deployResult, setDeployResult] = useState<{ success: boolean; message: string; url?: string; panelUrl?: string } | null>(null)

  // ── Railway auto-deploy (panel via the Railway Public API) ─────────────
  const [railTokens, setRailTokens] = useState<RailwayToken[]>([])
  const [railTokenId, setRailTokenId] = useState('')
  const [railMode, setRailMode] = useState<'auto' | 'zip'>('auto')
  const [cfBypass, setCfBypass] = useState(false)
  // Panel methods install the catalog panel; the Cloudflare methods install a
  // worker source. Keeping `workerSource` in sync with the chosen method means
  // the dropdown, the payload and the generated files always agree.
  const chooseMethod = (m: typeof method) => {
    setMethod(m)
    setWorkerSource(m === 'vps' || m === 'railway' || m === 'render' ? PANEL.id : 'edgetunnel')
  }
  const [railProjectUrl, setRailProjectUrl] = useState<string | null>(null)
  const [newRailName, setNewRailName] = useState('railway-main')
  const [newRailToken, setNewRailToken] = useState('')
  const [railSaving, setRailSaving] = useState(false)
  const [railSaveError, setRailSaveError] = useState<string | null>(null)

  // ── Render.com auto-deploy ───────────────────────────────────────────
  const [renderTokens, setRenderTokens] = useState<RenderToken[]>([])
  const [renderTokenId, setRenderTokenId] = useState('')
  const [renderProjectUrl, setRenderProjectUrl] = useState<string | null>(null)
  const [newRenderName, setNewRenderName] = useState(`${PANEL.id}-main`)
  const [newRenderToken, setNewRenderToken] = useState('')
  const [renderSaving, setRenderSaving] = useState(false)
  const [renderSaveError, setRenderSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<{ data: CFToken[] }>('/tokens')
      .then(({ data }) => {
        if (cancelled) return
        const active = (data ?? []).filter((t) => t.status === 'active')
        setTokens(active)
        if (active.length > 0) setSelectedToken(active[0].id)
      })
      .catch(() => setTokens([]))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Railway tokens — independent of the CF-token requirement.
  const refreshRailTokens = useCallback(async () => {
    try {
      const { data } = await api<{ data: RailwayToken[] }>('/railway/tokens')
      setRailTokens(data ?? [])
      if ((data ?? []).length > 0 && !(data as RailwayToken[]).some((t) => t.id === railTokenId)) {
        setRailTokenId((data as RailwayToken[])[0].id)
      }
    } catch {
      setRailTokens([])
    }
  }, [railTokenId])

  useEffect(() => {
    let cancelled = false
    api<{ data: RailwayToken[] }>('/railway/tokens')
      .then(({ data }) => {
        if (cancelled) return
        setRailTokens(data ?? [])
        if ((data ?? []).length > 0) setRailTokenId((data as RailwayToken[])[0].id)
      })
      .catch(() => { if (!cancelled) setRailTokens([]) })
    return () => { cancelled = true }
  }, [])

  const refreshRenderTokens = useCallback(async () => {
    try {
      const { data } = await api<{ data: RenderToken[] }>('/render/tokens')
      setRenderTokens(data ?? [])
      if ((data ?? []).length > 0 && !(data as RenderToken[]).some((t) => t.id === renderTokenId)) {
        setRenderTokenId((data as RenderToken[])[0].id)
      }
    } catch {
      setRenderTokens([])
    }
  }, [renderTokenId])

  useEffect(() => {
    let cancelled = false
    api<{ data: RenderToken[] }>('/render/tokens')
      .then(({ data }) => {
        if (cancelled) return
        setRenderTokens(data ?? [])
        if ((data ?? []).length > 0) setRenderTokenId((data as RenderToken[])[0].id)
      })
      .catch(() => { if (!cancelled) setRenderTokens([]) })
    return () => { cancelled = true }
  }, [])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // One-time panel admin credentials returned by the Railway deploy call —
  // kept in a ref so the status poller can label the result when it succeeds.
  const railAdminRef = useRef<{ user: string; pass: string } | null>(null)

  // Region Railway *confirmed* for the running deploy (from `POST /railway/deploy`),
  // so the success message names the real location instead of the requested one.
  const railRegionRef = useRef<string | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const startPolling = useCallback((deploymentId: string) => {
    stopPolling()
    const startedAt = Date.now()
    const tick = async () => {
      type DepState = { status?: string; logs?: string | null; worker_url?: string | null; panel_url?: string | null; error_message?: string | null } | null
      let dep: DepState = null
      try {
        dep = (await api<{ data: DepState }>(`/deployments/${deploymentId}`)).data
      } catch { /* transient network error — keep polling */ }
      if (!dep) return

      if (dep.logs) {
        setDeployLogs(dep.logs.split('\n').filter(Boolean))
      }

      // Activity log + token last_used_at are written server-side.
      if (dep.status === 'deployed') {
        stopPolling()
        setDeploying(false)
        setDeployResult({
          success: true,
          message: 'ورکر با موفقیت مستقر شد!',
          url: dep.worker_url ?? undefined,
          panelUrl: dep.panel_url ?? undefined,
        })
      } else if (dep.status === 'failed') {
        stopPolling()
        setDeploying(false)
        setDeployResult({ success: false, message: dep.error_message ?? 'استقرار ناموفق بود' })
      } else if (Date.now() - startedAt > 4 * 60 * 1000) {
        // Safety net: don't poll forever if the backend engine died silently.
        stopPolling()
        setDeploying(false)
        setDeployResult({ success: false, message: 'استقرار بیش از حد طول کشید. وضعیت را در صفحه ورکرها بررسی کنید.' })
      }
    }
    void tick()
    pollRef.current = setInterval(tick, 2000)
  }, [stopPolling])

  const RAIL_STATUS_LABEL: Record<string, string> = {
    QUEUED: 'در صف',
    INITIALIZING: 'در حال شروع',
    WAITING: 'در انتظار',
    BUILDING: 'در حال بیلد (Docker)',
    DEPLOYING: 'در حال استقرار',
    SUCCESS: 'موفق',
    FAILED: 'ناموفق',
    CRASHED: 'کرش',
    SLEEPING: 'خواب',
    SKIPPED: 'رد شد',
    REMOVING: 'در حال حذف',
    REMOVED: 'حذف شد',
  }

  const RENDER_STATUS_LABEL: Record<string, string> = {
    CREATED: 'ایجاد شد',
    BUILD_IN_PROGRESS: 'در حال بیلد (Docker)',
    UPDATE_IN_PROGRESS: 'در حال استقرار',
    LIVE: 'موفق (Live)',
    FAILED: 'ناموفق',
    CANCELED: 'لغو شد',
    DEACTIVATED: 'غیرفعال',
  }

  /** Poll a Render deployment until it reaches a terminal state. */
  const startRenderPolling = useCallback((deployId: string, serviceId: string, tokenId: string) => {
    stopPolling()
    const startedAt = Date.now()
    const tick = async () => {
      try {
        const { data } = await api<{ data: { status: string; url: string | null } }>(
          `/render/status?deploy_id=${encodeURIComponent(deployId)}&service_id=${encodeURIComponent(serviceId)}&token_id=${encodeURIComponent(tokenId)}`,
        )
        const st = (data?.status ?? 'UNKNOWN').toUpperCase()
        const label = RENDER_STATUS_LABEL[st] ?? st
        setDeployLogs((prev) => {
          const base = prev.filter((l) => !l.startsWith('وضعیت:'))
          return [...base, `وضعیت: ${label}`].slice(-14)
        })

        if (st === 'LIVE') {
          stopPolling()
          setDeploying(false)
          const url = data?.url?.trim() || null
          setDeployResult({
            success: true,
            message: url
              ? `${PANEL.name} با موفقیت روی Render مستقر شد! 🎉`
              : 'استقرار روی Render موفق بود — دامنه را در داشبورد سرویس فعال کنید.',
            url: url ?? undefined,
            panelUrl: url ? `${url.replace(/\/+$/, '')}${PANEL.panelPath}` : undefined,
          })
        } else if (st === 'FAILED' || st === 'CANCELED' || st === 'DEACTIVATED') {
          stopPolling()
          setDeploying(false)
          setDeployResult({
            success: false,
            message: `استقرار روی Render ${st === 'FAILED' ? 'ناموفق بود' : st === 'CANCELED' ? 'لغو شد' : 'غیرفعال شد'}. لاگ بیلد را در داشبورد Render بررسی کنید.`,
          })
        } else if (Date.now() - startedAt > 12 * 60 * 1000) {
          stopPolling()
          setDeploying(false)
          setDeployResult({ success: false, message: 'استقرار بیش از حد طول کشید. وضعیت را در داشبورد Render بررسی کنید.' })
        }
      } catch {
        // transient network error — keep polling
      }
    }
    void tick()
    pollRef.current = setInterval(tick, 5000)
  }, [stopPolling])

  /** Poll a Railway deployment until it reaches a terminal state. */
  const startRailPolling = useCallback((deploymentId: string, tokenId: string) => {
    stopPolling()
    const startedAt = Date.now()
    const tick = async () => {
      try {
        const { data } = await api<{ data: { status: string; url: string | null } }>(
          `/railway/status?deployment_id=${encodeURIComponent(deploymentId)}&token_id=${encodeURIComponent(tokenId)}`,
        )
        const st = (data?.status ?? 'UNKNOWN').toUpperCase()
        const label = RAIL_STATUS_LABEL[st] ?? st
        setDeployLogs((prev) => {
          const base = prev.filter((l) => !l.startsWith('وضعیت:'))
          return [...base, `وضعیت: ${label}`].slice(-14)
        })

        if (st === 'SUCCESS') {
          stopPolling()
          setDeploying(false)
          const url = data?.url?.trim() || null
          const admin = railAdminRef.current
          setDeployResult({
            success: true,
            message: url
              ? (admin
                  ? `${PANEL.name} در ${railRegionRef.current ?? railwayRegionLabel(DEFAULT_RAILWAY_REGION)} مستقر شد و ادمین پنل ساخته شد! 🎉`
                  : `${PANEL.name} با موفقیت روی Railway مستقر شد! 🎉`)
              : 'استقرار روی Railway موفق بود — دامنه را در بخش Networking پروژه فعال کنید.',
            url: url ?? undefined,
            panelUrl: url ? `${url.replace(/\/+$/, '')}${PANEL.panelPath}` : undefined,
          })
        } else if (st === 'FAILED' || st === 'CRASHED') {
          stopPolling()
          setDeploying(false)
          setDeployResult({
            success: false,
            message: `استقرار روی Railway ${st === 'CRASHED' ? 'کرش کرد' : 'ناموفق بود'}. لاگ بیلد را در داشبورد Railway پروژه بررسی کنید.`,
          })
        } else if (Date.now() - startedAt > 12 * 60 * 1000) {
          stopPolling()
          setDeploying(false)
          setDeployResult({ success: false, message: 'استقرار بیش از حد طول کشید. وضعیت را در داشبورد Railway بررسی کنید.' })
        }
      } catch {
        // transient network error — keep polling
      }
    }
    void tick()
    pollRef.current = setInterval(tick, 5000)
  }, [stopPolling])

  const handleDeploy = async () => {
    if (deploying) return
    setError(null)

    // Client-side validation before hitting the API.
    const isRailAuto = method === 'railway' && railMode === 'auto'
    const isRenderAuto = method === 'render'
    const isZip = method === 'vps' || (method === 'railway' && railMode === 'zip')
    const isCf = method === 'workers' || method === 'pages'

    if (!validName(name)) { setError('نام نامعتبر است — حروف کوچک انگلیسی، عدد و خط‌تیره'); return }
    const cfToken = tokens.find((t) => t.id === selectedToken) ?? null
    if (isCf) {
      if (!uuid.trim()) { setError('UUID خالی است'); return }
      if (!cfToken) { setError('ابتدا یک توکن فعال کلودفلر انتخاب کنید'); return }
    }

    setDeploying(true)
    setDeployResult(null)

    // ── Render.com auto-deploy via the REST API ────────────────────────
    if (isRenderAuto) {
      const rt = renderTokens.find((t) => t.id === renderTokenId)
      if (!rt) { setError('کلید API رندر انتخاب نشده است — یک کلید اضافه یا انتخاب کنید'); setDeploying(false); return }
      setRenderProjectUrl(null)
      setDeployLogs(['اتصال به Render…'])
      try {
        const { data } = await api<{ data: { serviceId: string; deployId: string; dashboardUrl: string } }>('/render/deploy', {
          method: 'POST',
          body: { token_id: rt.id, name, panel: PANEL.id },
        })
        setRenderProjectUrl(data.dashboardUrl)
        setDeployLogs([
          '✓ کلید API رندر تأیید شد',
          '✓ Blueprint ساخته شد',
          `✓ سرویس Docker از مخزن ${PANEL.repo} متصل شد`,
          `✓ PORT=${PANEL_PORT} تنظیم شد`,
          `✓ استقرار شروع شد (${data.deployId.slice(0, 8)}…)`,
          '',
          'در حال بیلد و استقرار روی Render — معمولاً ۳ تا ۶ دقیقه.',
        ])
        startRenderPolling(data.deployId, data.serviceId, rt.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطا در استقرار روی Render'
        setDeployLogs((prev) => [...prev, `❌ ${msg}`])
        setDeployResult({ success: false, message: msg })
        setDeploying(false)
      }
      return
    }

    // ── Railway auto-deploy via the Public API (no ZIP, no manual steps) ──
    if (isRailAuto) {
      const rt = railTokens.find((t) => t.id === railTokenId)
      if (!rt) { setError('توکن Railway انتخاب نشده است — یک توکن اضافه یا انتخاب کنید'); setDeploying(false); return }
      setRailProjectUrl(null)
      setDeployLogs(['اتصال به Railway…'])
      try {
        const { data } = await api<{ data: { deploymentId: string; projectId: string; projectUrl: string; domain?: string; admin_username?: string; admin_password?: string; region?: string; region_label?: string } }>('/railway/deploy', {
          method: 'POST',
          body: { token_id: rt.id, name, region: DEFAULT_RAILWAY_REGION, panel: PANEL.id },
        })
        setRailProjectUrl(data.projectUrl)
        railRegionRef.current = data.region_label ?? (data.region ? railwayRegionLabel(data.region) : null)
        if (data.admin_username && data.admin_password) {
          railAdminRef.current = { user: data.admin_username, pass: data.admin_password }
        }
        setDeployLogs([
          '✓ پروژه ساخته شد',
          '✓ محیط production آماده شد',
          `✓ مخزن ${PANEL.repo} (GitHub) متصل شد`,
          `✓ منطقهٔ تأییدشده: ${railRegionRef.current ?? railwayRegionLabel(DEFAULT_RAILWAY_REGION)}`,
          ...(data.domain ? [`✓ دامنه: ${data.domain}`] : []),
          `✓ PORT=${PANEL_PORT} تنظیم شد`,
          `✓ استقرار شروع شد (${data.deploymentId.slice(0, 8)}…)`,
          '',
          'در حال بیلد و استقرار روی Railway — معمولاً ۲ تا ۵ دقیقه.',
        ])
        startRailPolling(data.deploymentId, rt.id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطا در استقرار روی Railway'
        setDeployLogs((prev) => [...prev, `❌ ${msg}`])
        setDeployResult({ success: false, message: msg })
        setDeploying(false)
      }
      return
    }

    // VPS/Railway-ZIP mode: generate Docker files and download as ZIP
    if (isZip) {
      const isRailway = method === 'railway'
      setDeployLogs([isRailway ? 'در حال تولید فایل‌های Railway...' : 'در حال تولید فایل‌های Docker...'])
      try {
        const vpsPort = PANEL_PORT
        const cfg = { name, uuid, adminPassword: adminPassword || uuid, domain: '', port: vpsPort, panel: PANEL.id }
        const zip = new JSZip()
        if (isRailway) {
          zip.file('Dockerfile', generateRailwayDockerfile(cfg))
          zip.file('railway.toml', generateRailwayToml(cfg))
          zip.file('README.md', generateRailwayReadme(cfg))
        } else {
          zip.file('docker-compose.yml', generateDockerCompose(cfg))
          zip.file('nginx.conf', generateNginxConf(cfg))
          zip.file('.env', generateEnvFile(cfg))
          zip.file('deploy.sh', generateDeployScript(cfg))
          zip.file('README.md', `# ${name} — ${PANEL.name} Docker Deployment\n\n## Quick Start\n\n1. Upload this ZIP to your VPS\n2. Extract: \`unzip ${name}-${PANEL.id}.zip\`\n3. Run: \`bash deploy.sh\`\n\n## Panel Access\n\n- URL: http://YOUR_SERVER_IP:${PANEL_PORT}${PANEL.panelPath}\n- Password: \`${adminPassword || uuid}\`\n\n---\nGenerated by miliconfigpro panel\n`)
        }
        const blob = await zip.generateAsync({ type: 'blob' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${name}-${PANEL.id}.zip`
        a.click()
        URL.revokeObjectURL(url)
        setDeployLogs([
          'فایل‌ها تولید شدند ✓',
          ...(isRailway ? [
            `Dockerfile ✓`,
            `railway.toml ✓`,
            `README.md ✓`,
          ] : [
            `docker-compose.yml ✓`,
            `nginx.conf ✓`,
            `.env ✓`,
            `deploy.sh ✓`,
            `README.md ✓`,
          ]),
          '',
          `📦 ${name}-${PANEL.id}.zip — ${blob.size} bytes`,
          '',
          'برای استقرار:',
          ...(isRailway ? [
            '1. فایل‌ها را در مخزن GitHub قرار دهید',
            '2. به railway.app/new بروید',
            '3. Deploy from GitHub → مخزن را انتخاب کنید',
          ] : [
            '1. ZIP را به VPS آپلود کنید',
            '2. استخراج: unzip ' + name + `-${PANEL.id}.zip`,
            '3. اجرا: bash deploy.sh',
          ]),
        ])
        setDeploying(false)
        setDeployResult({ success: true, message: isRailway ? 'فایل‌های Railway تولید و دانلود شدند!' : 'فایل‌های Docker تولید و دانلود شدند!', url: isRailway ? 'https://your-app.up.railway.app' : `http://YOUR_SERVER_IP:${vpsPort}`, panelUrl: isRailway ? `https://your-app.up.railway.app${PANEL.panelPath}` : `http://YOUR_SERVER_IP:${vpsPort}${PANEL.panelPath}` })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'خطای تولید فایل'
        setDeployResult({ success: false, message: msg })
        setDeploying(false)
      }
      return
    }

    setDeployLogs(['در حال ارسال درخواست استقرار…'])

    try {
      const { data: dep } = await api<{ data: { id: string; status?: string; error_message?: string | null } }>('/deployments', {
        method: 'POST',
        body: {
          name,
          uuid,
          custom_path: customPath || undefined,
          method,
          worker_source: workerSource,
          proxyip: proxyIP || undefined,
          admin_password: adminPassword || undefined,
          cf_token_id: cfToken?.id ?? '',
        },
      })

      if (dep?.status === 'failed') {
        setDeployResult({ success: false, message: dep.error_message ?? 'استقرار بلافاصله ناموفق بود' })
        setDeploying(false)
        return
      }
      if (dep?.id) {
        startPolling(dep.id)
      } else {
        throw new Error('شناسه استقرار دریافت نشد')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'خطای شبکه'
      setDeployResult({ success: false, message: msg })
      setDeploying(false)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>
  }

  // Users without a Cloudflare token may still deploy the panel (Railway/VPS).
  const needCfGate = tokens.length === 0 && !cfBypass

  if (needCfGate) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-white">استقرار ورکر جدید</h1>
          <p className="text-slate-400 text-sm mt-1">{method === 'railway' ? 'فایل‌های Railway (Dockerfile + railway.toml) برای استقرار پنل تولید و دانلود می‌شوند' : method === 'vps' ? 'فایل‌های Docker برای استقرار پنل روی VPS تولید و دانلود می‌شوند' : 'ورکر به‌صورت خودکار از مخزن دانلود و روی کلودفلر مستقر می‌شود — نیازی به کدنویسی نیست'}</p>
        </div>

        <div className="glass-card p-12 text-center">
          <AlertCircle className="w-12 h-12 text-warning-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold text-white mb-2">ابتدا یک توکن اضافه کنید</h3>
          <p className="text-slate-400 text-sm mb-6">برای استقرار ورکرها به توکن API کلودفلر نیاز دارید</p>
          <button onClick={() => navigate('/tokens')} className="btn-primary">رفتن به مدیریت توکن</button>
          <div className="mt-5 pt-5 border-t border-slate-800/50">
            <p className="text-xs text-slate-500 mb-3">توکن کلودفلر ندارید؟ پنل اختصاصی (FastAPI + xray-core) را می‌توانید بدون توکن کلودفلر روی Railway یا VPS خودتان مستقر کنید:</p>
            <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={() => { chooseMethod('railway'); setRailMode('auto'); setCfBypass(true) }}
              className="btn-ghost inline-flex items-center gap-2"
            >
              <TrainFront className="w-4 h-4 text-purple-400" /> استقرار پنل روی Railway
            </button>
            <button
              onClick={() => { chooseMethod('render'); setCfBypass(true) }}
              className="btn-ghost inline-flex items-center gap-2"
            >
              <Cloud className="w-4 h-4 text-teal-400" /> استقرار پنل روی Render.com
            </button>
          </div>
          </div>
        </div>

        {/* Quick start */}
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="w-5 h-5 text-brand-400" />
            <h2 className="text-sm font-bold text-white">مسیر سریع راه‌اندازی</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <a href="https://tempmail.ing/" target="_blank" rel="noopener noreferrer" className="group p-4 rounded-xl bg-slate-900/40 border border-slate-800/50 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 rounded-lg bg-amber-500/10"><Mail className="w-4 h-4 text-amber-400" /></div>
                <span className="text-xs font-mono text-slate-500">۱</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-1">ایمیل موقت</h3>
              <p className="text-xs text-slate-400 leading-relaxed">یک ایمیل یکبارمصرف برای ثبت‌نام در کلودفلر.</p>
              <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">دریافت ایمیل <ExternalLink className="w-3 h-3" /></span>
            </a>
            <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener noreferrer" className="group p-4 rounded-xl bg-slate-900/40 border border-slate-800/50 hover:border-brand-500/40 hover:bg-brand-500/5 transition-all">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 rounded-lg bg-blue-500/10"><Cloud className="w-4 h-4 text-blue-400" /></div>
                <span className="text-xs font-mono text-slate-500">۲</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-1">ساخت حساب کلودفلر</h3>
              <p className="text-xs text-slate-400 leading-relaxed">با ایمیل موقت ثبت‌نام کنید و تأیید کنید.</p>
              <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">ثبت‌نام <ExternalLink className="w-3 h-3" /></span>
            </a>
            <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="group p-4 rounded-xl bg-slate-900/40 border border-brand-500/30 bg-brand-500/5 transition-all">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-2 rounded-lg bg-brand-500/10"><KeyRound className="w-4 h-4 text-brand-400" /></div>
                <span className="text-xs font-mono text-slate-500">۳</span>
              </div>
              <h3 className="text-sm font-bold text-white mb-1">ساخت توکن API</h3>
              <p className="text-xs text-slate-400 leading-relaxed">توکن با دسترسی Workers، KV و R2 بسازید (دکمهٔ «ساخت خودکار توکن» در تب توکن‌ها همهٔ ۱۵ دسترسی لازم را از قبل پر می‌کند — شامل R2 و تنظیمات gRPC).</p>
              <span className="inline-flex items-center gap-1 text-xs text-brand-300 mt-3 group-hover:gap-2 transition-all">ساخت توکن <ExternalLink className="w-3 h-3" /></span>
            </a>
          </div>
        </div>
      </div>
    )
  }

  // Panel methods deploy the catalog panel (our own NEXUS/Mizetusi) rather than
  // a Cloudflare worker source, so every label and summary card below branches
  // on this — the panel path must never show worker-only wording.
  const panelMethod = method === 'vps' || method === 'railway' || method === 'render'

  const steps = [
    { num: 1, label: 'نام و کلید', icon: Terminal },
    { num: 2, label: 'تنظیمات', icon: Settings },
    { num: 3, label: 'استقرار', icon: Rocket },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">{panelMethod ? 'استقرار پنل اختصاصی' : 'استقرار ورکر جدید'}</h1>        <p className="text-slate-400 text-sm mt-1">{method === 'render' ? 'استقرار خودکار پنل روی Render.com — سرویس Docker از مخزن ساخته و مستقر می‌شود' : method === 'railway' && railMode === 'auto' ? 'استقرار خودکار پنل روی Railway — پروژه ساخته، مخزن متصل و دیپلوی اجرا می‌شود' : method === 'railway' ? 'فایل‌های Railway (Dockerfile + railway.toml) برای استقرار پنل تولید و دانلود می‌شوند' : method === 'vps' ? 'فایل‌های Docker برای استقرار پنل روی VPS تولید و دانلود می‌شوند' : 'ورکر به‌صورت خودکار از مخزن دانلود و روی کلودفلر مستقر می‌شود — نیازی به کدنویسی نیست'}</p>
        </div>

        {/* Info banner */}
        <div className="glass-card p-4 flex items-center gap-3 border-brand-500/20">
          <div className="p-2 rounded-lg bg-brand-500/10">
            <Sparkles className="w-5 h-5 text-brand-400" />
          </div>
          <div>
            <p className="text-sm text-white font-medium">{method === 'railway' && railMode === 'auto' ? 'استقرار خودکار روی Railway' : method === 'render' ? 'استقرار خودکار روی Render.com' : 'استقرار کاملاً خودکار'}</p>
            <p className="text-xs text-slate-400">{method === 'render' ? 'با کلید API شما یک Blueprint ساخته می‌شود، سرویس Docker از مخزن عمومی miladjahani/Mizetusi (با Dockerfile رسمی شامل xray-core و پنل) بیلد و مستقر می‌گردد — وضعیت همین‌جا دنبال می‌شود.' : method === 'railway' && railMode === 'auto' ? 'با توکن Account شما پروژه‌ای در Railway ساخته می‌شود، سرویس از مخزن عمومی miladjahani/Mizetusi ساخته شده و Docker بیلد و مستقر می‌گردد — وضعیت همین‌جا دنبال می‌شود.' : method === 'railway' ? 'فایل‌های Dockerfile و railway.toml تولید و به‌صورت ZIP دانلود می‌شوند. سپس در Railway از GitHub مستقر کنید.' : method === 'vps' ? 'فایل‌های docker-compose.yml، nginx.conf، .env و deploy.sh تولید و به‌صورت ZIP دانلود می‌شوند.' : 'کد ورکر از مخزن GitHub بارگذاری می‌شود، KV ساخته می‌شود، bindings تنظیم می‌شود و ورکر روی edge مستقر می‌گردد.'}</p>
          </div>
        </div>

      {/* Steps indicator */}
      <div className="flex items-center justify-between max-w-2xl">
        {steps.map((s, i) => {
          const Icon = s.icon
          const isActive = step === s.num
          const isDone = step > s.num
          return (
            <div key={s.num} className="flex items-center flex-1">
              <div className="flex flex-col items-center gap-2">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 ${
                  isDone ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                  isActive ? 'bg-brand-600 text-white shadow-lg shadow-brand-500/30 animate-pulse-glow' :
                  'bg-slate-800/50 text-slate-500 border border-slate-700/50'
                }`}>
                  {isDone ? <Check className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                </div>
                <span className={`text-xs font-medium ${isActive ? 'text-white' : 'text-slate-500'}`}>{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`flex-1 h-0.5 mx-2 rounded transition-all duration-300 ${isDone ? 'bg-green-500/50' : 'bg-slate-800'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* Step content */}
      <div className="glass-card p-6 lg:p-8 min-h-[300px]">
        {step === 1 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">{panelMethod ? 'نام پروژه' : 'نام ورکر'}</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value.trim().toLowerCase())}
                  placeholder="my-awesome-worker"
                  className="input-field flex-1"
                  dir="ltr"
                />
                <button onClick={() => setName(genName())} type="button" className="btn-ghost flex items-center gap-1.5" title="نام تصادفی">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">حروف کوچک، عدد، خط‌تیره · {method === 'railway' ? 'نام پروژه در Railway می‌شود' : method === 'render' ? 'نام سرویس در Render می‌شود' : method === 'vps' ? 'نام سرویس روی VPS می‌شود' : <>می‌شود <code className="text-brand-300">{name}.workers.dev</code></>}</p>
            </div>

            {(method === 'railway' && railMode === 'auto') || method === 'render' ? null : (
            <>
            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">رمز دسترسی (UUID)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={uuid}
                  onChange={(e) => setUuid(e.target.value.trim())}
                  className="input-field flex-1 font-mono text-sm"
                  dir="ltr"
                />
                <button onClick={() => setUuid(genUuid())} type="button" className="btn-ghost flex items-center gap-1.5" title="تولید UUID جدید">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-2">این کلید خصوصی پنل شماست — هر کس آن را داشته باشد می‌تواند {panelMethod ? 'پنل' : 'ورکر'} را مدیریت کند</p>
            </div>

            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">مسیر سفارشی — اختیاری</label>
              <input
                type="text"
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value.trim())}
                placeholder="مثلاً mypath"
                className="input-field"
                dir="ltr"
              />
              <p className="text-xs text-slate-500 mt-2">اگر تنظیم شود، پنل از <code className="text-brand-300">/{customPath || 'mypath'}</code> در دسترس است؛ در غیر این صورت پیش‌فرض <code className="text-brand-300">/admin</code> است</p>
            </div>
            </>)}

            <div className="flex justify-end">
              <button
                disabled={!name.trim() || !validName(name) || ((method !== 'railway' || railMode !== 'auto') && method !== 'render' && !uuid.trim())}
                onClick={() => setStep(2)}
                className="btn-primary flex items-center gap-2"
              >
                مرحله بعد <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 animate-fade-in">
            {(method === 'workers' || method === 'pages') && (
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">توکن کلودفلر</label>
                {tokens.length === 0 ? (
                  <div className="flex items-center justify-between gap-2 flex-wrap rounded-xl bg-warning-500/10 border border-warning-500/30 px-4 py-3">
                    <span className="text-sm text-warning-300">توکن کلودفلری ثبت نشده — برای این روش الزامی است</span>
                    <button type="button" onClick={() => navigate('/tokens')} className="text-xs text-brand-300 hover:underline">مدیریت توکن‌ها ←</button>
                  </div>
                ) : (
                  <select value={selectedToken} onChange={(e) => setSelectedToken(e.target.value)} className="input-field">
                    {tokens.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {method === 'render' && (
              <RenderTokenPanel
                tokens={renderTokens}
                selectedId={renderTokenId}
                onSelect={setRenderTokenId}
                newName={newRenderName}
                newToken={newRenderToken}
                onNewName={setNewRenderName}
                onNewToken={(v) => { setNewRenderToken(v); setRenderSaveError(null) }}
                saving={renderSaving}
                error={renderSaveError}
                onSave={async () => {
                  if (!newRenderToken.trim()) { setRenderSaveError('کلید API رندر را paste کنید'); return }
                  setRenderSaving(true)
                  setRenderSaveError(null)
                  try {
                    const { data } = await api<{ data: { id: string } }>('/render/tokens', {
                      method: 'POST',
                      body: { name: newRenderName.trim() || 'render-main', token: newRenderToken.trim() },
                    })
                    setRenderTokenId(data.id)
                    setNewRenderToken('')
                    await refreshRenderTokens()
                  } catch (err) {
                    setRenderSaveError(err instanceof Error ? err.message : 'خطا در ذخیره کلید API رندر')
                  } finally {
                    setRenderSaving(false)
                  }
                }}
              />
            )}

            {method === 'railway' && railMode === 'auto' && (
              <RailwayTokenPanel
                tokens={railTokens}
                selectedId={railTokenId}
                onSelect={setRailTokenId}
                newName={newRailName}
                newToken={newRailToken}
                onNewName={setNewRailName}
                onNewToken={(v) => { setNewRailToken(v); setRailSaveError(null) }}
                saving={railSaving}
                error={railSaveError}
                onSave={async () => {
                  if (!newRailToken.trim()) { setRailSaveError('توکن Account Railway را paste کنید'); return }
                  setRailSaving(true)
                  setRailSaveError(null)
                  try {
                    const { data } = await api<{ data: { id: string } }>('/railway/tokens', {
                      method: 'POST',
                      body: { name: newRailName.trim() || 'railway-main', token: newRailToken.trim() },
                    })
                    setRailTokenId(data.id)
                    setNewRailToken('')
                    await refreshRailTokens()
                  } catch (err) {
                    setRailSaveError(err instanceof Error ? err.message : 'خطا در ذخیره توکن Railway')
                  } finally {
                    setRailSaving(false)
                  }
                }}
              />
            )}

            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">محیط اجرا</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <button
                  type="button"
                  onClick={() => chooseMethod('workers')}
                  className={`p-4 rounded-xl border text-right transition-all ${
                    method === 'workers' ? 'border-brand-500 bg-brand-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <Cloud className={`w-5 h-5 mb-2 ${method === 'workers' ? 'text-brand-400' : 'text-slate-500'}`} />
                  <p className="text-sm font-bold text-white">CF Workers</p>
                  <p className="text-xs text-slate-400 mt-1">Edge Workers. پیشنهادی.</p>
                </button>
                <button
                  type="button"
                  onClick={() => chooseMethod('pages')}
                  className={`p-4 rounded-xl border text-right transition-all ${
                    method === 'pages' ? 'border-brand-500 bg-brand-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <Cloud className={`w-5 h-5 mb-2 ${method === 'pages' ? 'text-brand-400' : 'text-slate-500'}`} />
                  <p className="text-sm font-bold text-white">CF Pages</p>
                  <p className="text-xs text-slate-400 mt-1">_worker.js function.</p>
                </button>
                <button
                  type="button"
                  onClick={() => chooseMethod('vps')}
                  className={`p-4 rounded-xl border text-right transition-all ${
                    method === 'vps' ? 'border-brand-500 bg-brand-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <Terminal className={`w-5 h-5 mb-2 ${method === 'vps' ? 'text-brand-400' : 'text-slate-500'}`} />
                  <p className="text-sm font-bold text-white">VPS (Docker)</p>
                  <p className="text-xs text-slate-400 mt-1">سرور اختصاصی روی Docker — پنل ما با xray-core.</p>
                </button>
                <button
                  type="button"
                  onClick={() => chooseMethod('railway')}
                  className={`p-4 rounded-xl border text-right transition-all ${
                    method === 'railway' ? 'border-purple-500 bg-purple-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <TrainFront className={`w-5 h-5 mb-2 ${method === 'railway' ? 'text-purple-400' : 'text-slate-500'}`} />
                  <p className="text-sm font-bold text-white">Railway</p>
                  <p className="text-xs text-slate-400 mt-1">استقرار خودکار پنل.</p>
                </button>
                <button
                  type="button"
                  onClick={() => chooseMethod('render')}
                  className={`p-4 rounded-xl border text-right transition-all ${
                    method === 'render' ? 'border-teal-500 bg-teal-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'
                  }`}
                >
                  <Cloud className={`w-5 h-5 mb-2 ${method === 'render' ? 'text-teal-400' : 'text-slate-500'}`} />
                  <p className="text-sm font-bold text-white">Render.com</p>
                  <p className="text-xs text-slate-400 mt-1">استقرار خودکار پنل.</p>
                </button>
              </div>
            </div>

            {method === 'railway' && (
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">روش استقرار Railway</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRailMode('auto')}
                    className={`p-3 rounded-xl border text-right transition-all ${railMode === 'auto' ? 'border-purple-500 bg-purple-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'}`}
                  >
                    <p className="text-sm font-bold text-white flex items-center gap-2">
                      <TrainFront className="w-4 h-4 text-purple-400" /> خودکار با توکن (پیشنهادی)
                    </p>
                    <p className="text-xs text-slate-400 mt-1">پروژه ساخته می‌شود، مخزن پنل متصل و دیپلوی شروع می‌شود — همه از همین‌جا.</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setRailMode('zip')}
                    className={`p-3 rounded-xl border text-right transition-all ${railMode === 'zip' ? 'border-brand-500 bg-brand-500/10' : 'border-slate-700 bg-slate-900/40 hover:border-slate-600'}`}
                  >
                    <p className="text-sm font-bold text-white flex items-center gap-2">
                      <Rocket className="w-4 h-4 text-brand-400" /> دانلود فایل ZIP (دستی)
                    </p>
                    <p className="text-xs text-slate-400 mt-1">فایل‌های Docker استاندارد را دانلود و خودتان در Railway از GitHub مستقر کنید.</p>
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">
                {method === 'vps' || method === 'railway' || method === 'render' ? 'پنل' : 'منبع ورکر'}
              </label>
              {method === 'vps' || method === 'railway' || method === 'render' ? (
                PANELS.length === 1 ? (
                  <div className="p-3 rounded-xl border border-brand-500/40 bg-brand-500/5">
                    <p className="text-sm font-bold text-white flex items-center gap-2">
                      <Rocket className="w-4 h-4 text-brand-400" />
                      {PANEL.name}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">{PANEL.tagline}</p>
                    <p className="text-xs text-slate-500 mt-1" dir="ltr">
                      {PANEL.repo} · {method === 'render' ? 'Render.com' : method === 'railway' ? 'Railway' : 'Docker + VPS'}
                    </p>
                  </div>
                ) : (
                <select value={workerSource} onChange={(e) => setWorkerSource(e.target.value)} className="input-field">
                  {PANELS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.tagline} ({method === 'render' ? 'Render.com' : method === 'railway' ? 'Railway' : 'Docker + VPS'})
                    </option>
                  ))}
                </select>
                )
              ) : (
                <select value={workerSource} onChange={(e) => setWorkerSource(e.target.value)} className="input-field">
                  <option value="edgetunnel">cmliu/edgetunnel — ورکر کامل (VLESS/Trojan/SS + پنل)</option>
                  <option value="edgetunnel_kv">cmliu/edgetunnel — حالت KV (پیکربندی از KV)</option>
                  <option value="custom">ورکر سفارشی ما — CFnew v2.9.8c (پنل داخلی با تنظیمات کامل)</option>
                  <option value="nexus">NEXUS — نسل جدید (پنل داخلی هوشمند + نقشهٔ زنده + مبهم‌سازی پیشرفته)</option>
                  <option value="miliconfigzeus">miliconfig zeus — پنل کامل D1 (مدیریت کاربران، سهمیه، اسکنر)</option>
                </select>
              )}
              <p className="text-xs text-slate-500 mt-2">
                {method === 'vps'
                  ? <>پنل اختصاصی <b>{PANEL.name}</b> روی سرور اختصاصی شما با Docker بالا می‌آید — فایل‌های <code className="text-brand-300">docker-compose.yml</code>، <code className="text-brand-300">nginx.conf</code>، <code className="text-brand-300">.env</code> و <code className="text-brand-300">deploy.sh</code> تولید و دانلود می‌شوند؛ بعد از اجرا از <code className="text-brand-300">{PANEL.panelPath}</code> وارد پنل شوید (رمز ادمین هنگام استقرار ساخته می‌شود).</>
                  : workerSource === 'custom'
                  ? <>ورکر سفارشی ما با پنل داخلی کامل، اسکنر IP داخلی، و آپدیت خودکار. KV binding با نام <code className="text-brand-300">C</code> و کلید پیکربندی <code className="text-brand-300">c</code>.</>
                  : workerSource === 'nexus'
                  ? <>NEXUS — نسل جدید ورکر با پنل داخلی تنظیمات هوشمند، نقشهٔ زندهٔ سراسری، مبهم‌سازی پیشرفته و ساب‌نویس خودکار. پنل با همان UUID در مسیر <code className="text-brand-300">/{uuid}</code> باز می‌شود و تنظیمات در KV (<code className="text-brand-300">C</code> / <code className="text-brand-300">c</code>) ذخیره می‌شود.</>
                  : workerSource === 'miliconfigzeus'
                  ? <>پنل کامل miliconfigzeus با دیتابیس اختصاصی D1 مستقر می‌شود (خودکار ساخته می‌شود). مدیریت کاربران، سهمیه‌ها و اسکنر داخل خود پنل مستقر است؛ آدرس پنل، ریشه همان ورکر خواهد بود. این سورس همیشه به‌صورت Workers مستقر می‌شود.</>
                  : method === 'render'
                  ? <>{PANEL.name} با کلید API رندر روی Render.com مستقر می‌شود — سرویس Docker (xray-core + پنل) از همان Dockerfile رسمی بیلد می‌شود. بعد از موفقیت، از <code className="text-brand-300">{PANEL.panelPath}</code> وارد پنل شوید (رمز ادمین موقع استقرار ساخته و همین‌جا نمایش داده می‌شود).</>
                  : method === 'railway'
                  ? railMode === 'auto'
                    ? <>{PANEL.name} با توکن Railway روی سرورهای Railway مستقر می‌شود — Docker بیلد شده و xray-core + پنل بالا می‌آید. بعد از موفقیت، از <code className="text-brand-300">{PANEL.panelPath}</code> وارد پنل شوید (رمز ادمین موقع استقرار ساخته و همین‌جا نمایش داده می‌شود).</>
                    : <>فایل‌های Docker استاندارد تولید و دانلود می‌شوند — برای استقرار دستی در Railway یا هر سرویس Docker.</>
                  : <>ورکر از مخزن رسمی <a href="https://github.com/cmliu/edgetunnel" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">cmliu/edgetunnel</a> بارگذاری می‌شود. پنل داخلی ورکر حذف شده و همه تنظیمات از این برنامه مدیریت می‌شود.</>
                }
              </p>
            </div>

            {(method === 'workers' || method === 'pages') && (
            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">Proxy IP — اختیاری</label>
              <input
                type="text"
                value={proxyIP}
                onChange={(e) => setProxyIP(e.target.value)}
                placeholder="auto یا IP:port,IP:port"
                className="input-field"
                dir="ltr"
              />
              <p className="text-xs text-slate-500 mt-2">برای دور زدن محدودیت Worker→Origin. می‌توانید بعداً از اسکنر IP انتخاب کنید. <a href="https://github.com/EDT-Pages/Proxy-List" target="_blank" rel="noopener noreferrer" className="text-brand-400 hover:underline">EDT-Pages/Proxy-List</a></p>
            </div>
            )}

            {(method === 'workers' || method === 'pages') && workerSource !== 'custom' && workerSource !== 'nexus' && (
              <div>
                <label className="block text-sm text-slate-300 mb-2 font-medium">رمز ادمین — اختیاری</label>
                <input
                  type="text"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="رمز دلخواه برای پنل /admin ورکر"
                  className="input-field"
                  dir="ltr"
                />
                <p className="text-xs text-slate-500 mt-2">اگر تنظیم شود، پنل داخلی ورکر (در مسیر <code className="text-brand-300">/admin</code>) با این رمز محافظت می‌شود. اگر خالی بگذارید، UUID به‌عنوان رمز استفاده می‌شود.</p>
              </div>
            )}

            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="btn-ghost">قبلی</button>
              <button onClick={() => setStep(3)} className="btn-primary flex items-center gap-2">
                <Sparkles className="w-4 h-4" /> بررسی و استقرار
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6 animate-fade-in">
            {/* Summary */}
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-slate-300 mb-3">خلاصه استقرار</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">{panelMethod ? 'نام پروژه' : 'نام ورکر'}</p>
                  <p className="text-white font-medium" dir="ltr">{name}</p>
                </div>
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">محیط اجرا</p>
                  <p className="text-white font-medium">{method === 'workers' ? 'CF Workers' : method === 'pages' ? 'CF Pages' : method === 'railway' ? 'Railway' : method === 'render' ? 'Render.com' : 'VPS (Docker)'}</p>
                </div>
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">{panelMethod ? 'پنل' : 'منبع ورکر'}</p>
                  <p className="text-white font-medium" dir={panelMethod ? undefined : 'ltr'}>{panelMethod ? PANEL.name : workerSource === 'custom' ? 'ورکر سفارشی ما' : workerSource === 'nexus' ? 'NEXUS — نسل جدید' : workerSource === 'miliconfigzeus' ? 'miliconfig zeus' : workerSource === 'edgetunnel' ? 'cmliu/edgetunnel' : 'cmliu/edgetunnel (KV)'}</p>
                </div>
                {!panelMethod && (
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">Proxy IP</p>
                  <p className="text-white font-medium" dir="ltr">{proxyIP || 'auto'}</p>
                </div>
                )}
                {!panelMethod && adminPassword && workerSource !== 'custom' && workerSource !== 'nexus' && (
                  <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                    <p className="text-xs text-slate-500 mb-1">رمز ادمین</p>
                    <p className="text-white font-medium" dir="ltr">{'•'.repeat(Math.min(adminPassword.length, 20))}</p>
                  </div>
                )}
                {method !== 'vps' && !(method === 'railway' && railMode === 'zip') && (
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">{method === 'railway' && railMode === 'auto' ? 'توکن Railway' : method === 'render' ? 'کلید API رندر' : 'توکن کلودفلر'}</p>
                  <p className="text-white font-medium">
                    {method === 'railway' && railMode === 'auto'
                      ? (railTokens.find(t => t.id === railTokenId)?.name ?? '—')
                      : method === 'render'
                      ? (renderTokens.find(t => t.id === renderTokenId)?.name ?? '—')
                      : (tokens.find(t => t.id === selectedToken)?.name ?? '—')}
                  </p>
                </div>
                )}
                <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                  <p className="text-xs text-slate-500 mb-1">مسیر پنل</p>
                  <p className="text-white font-medium" dir="ltr">
                    {panelMethod
                      ? `${PANEL.panelPath} (${PANEL.name})`
                      : workerSource === 'nexus' ? `/${uuid || '…'}` : `/${customPath || 'admin'}`}
                  </p>
                </div>
              </div>
            </div>

            {/* Deploy button */}
            {!deployResult && (
              <div className="flex flex-col items-center gap-4 py-6">
                {error && (
                  <div className="w-full max-w-md px-4 py-3 rounded-xl bg-error-500/10 border border-error-500/30 text-error-400 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="btn-primary flex items-center gap-2 px-8 py-3 text-lg"
                >
                  {deploying ? <Loader2 className="w-5 h-5 animate-spin" /> : <Rocket className="w-5 h-5" />}
                  {deploying
                    ? (method === 'railway' && railMode === 'auto' ? 'در حال استقرار روی Railway...' : method === 'render' ? 'در حال استقرار روی Render...' : (method === 'vps' || (method === 'railway' && railMode === 'zip')) ? 'در حال تولید فایل‌ها...' : 'در حال استقرار...')
                    : ((method === 'vps' || (method === 'railway' && railMode === 'zip')) ? (method === 'railway' ? 'دانلود فایل‌های Railway' : 'دانلود فایل‌های Docker') : (method === 'railway' && railMode === 'auto' ? 'استقرار روی Railway' : method === 'render' ? 'استقرار روی Render' : 'استقرار ورکر'))}
                </button>

                {/* Live logs */}
                {deploying && deployLogs.length > 0 && (
                  <div className="w-full max-w-2xl mt-4">
                    <div className="bg-slate-900/80 rounded-xl border border-slate-800 p-4 max-h-48 overflow-y-auto font-mono text-xs space-y-1" dir="ltr">
                      {deployLogs.map((log, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <span className="text-slate-600 shrink-0">{i + 1}.</span>
                          <span className={log.includes('✓') || log.includes('verified') || log.includes('created') || log.includes('enabled') || log.includes('uploaded') ? 'text-green-400' : log.includes('warning') || log.includes('⚠') ? 'text-warning-400' : 'text-slate-300'}>
                            {log}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {deploying && (
                  <p className="text-sm text-slate-400 animate-pulse">{method === 'railway' && railMode === 'auto' ? `Railway در حال بیلد Docker و استقرار ${PANEL.name} است — این صفحه خودکار به‌روزرسانی می‌شود.` : method === 'render' ? `Render در حال بیلد Docker و استقرار ${PANEL.name} است — این صفحه خودکار به‌روزرسانی می‌شود.` : 'ورکر از مخزن دانلود، KV ساخته و روی edge مستقر می‌شود...'}</p>
                )}
              </div>
            )}

            {/* Result */}
            {deployResult && (
              <div className="animate-slide-up">
                {deployResult.success ? (
                  <div className="text-center py-6">
                    <div className="inline-flex w-16 h-16 rounded-2xl bg-green-500/10 items-center justify-center mb-4 animate-pulse-glow">
                      <Check className="w-8 h-8 text-green-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">{deployResult.message}</h3>

                    {deployResult.panelUrl && (
                      <div className="mt-6 space-y-3 max-w-md mx-auto">
                        <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                          <p className="text-xs text-slate-500 mb-2">{panelMethod ? 'لینک پنل' : 'لینک خصوصی پنل ورکر'}</p>
                          <a href={deployResult.panelUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-brand-300 hover:text-brand-200 transition-colors break-all text-sm" dir="ltr">
                            <ExternalLink className="w-4 h-4 shrink-0" /> {deployResult.panelUrl}
                          </a>
                        </div>
                        {deployResult.url && (
                          <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                            <p className="text-xs text-slate-500 mb-2">{panelMethod ? 'آدرس پایه پنل' : 'آدرس پایه ورکر'}</p>
                            <p className="text-slate-300 text-sm break-all" dir="ltr">{deployResult.url}</p>
                          </div>
                        )}
                        {method === 'railway' && railAdminRef.current && (
                          <div className="p-4 rounded-xl bg-slate-900/50 border border-brand-500/40">
                            <p className="text-xs text-slate-500 mb-2">حساب ادمین {PANEL.name} — فقط همین‌جا نمایش داده می‌شود</p>
                            <p className="text-slate-300 text-sm font-mono" dir="ltr">username: {railAdminRef.current.user}</p>
                            <p className="text-slate-300 text-sm font-mono break-all" dir="ltr">password: {railAdminRef.current.pass}</p>
                          </div>
                        )}
                        <p className="text-xs text-warning-400/80 px-4">لینک پنل را خصوصی نگه دارید — هر کس آن را داشته باشد می‌تواند {panelMethod ? 'پنل' : 'ورکر'} را مدیریت کند.</p>
                      </div>
                    )}

                    <div className="flex gap-3 justify-center mt-6 flex-wrap">
                      {method === 'railway' && railMode === 'auto' && railProjectUrl && (
                        <a href={railProjectUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2">
                          <ExternalLink className="w-4 h-4" /> داشبورد پروژه در Railway
                        </a>
                      )}
                      {method === 'render' && renderProjectUrl && (
                        <a href={renderProjectUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-2">
                          <ExternalLink className="w-4 h-4" /> داشبورد سرویس در Render
                        </a>
                      )}
                      {!(method === 'railway' && railMode === 'auto') && method !== 'render' && (
                        <button onClick={() => navigate(panelMethod ? '/deployments?tab=panels' : '/deployments')} className="btn-primary">{panelMethod ? 'مشاهده پنل‌ها' : 'مشاهده ورکرها'}</button>
                      )}
                      <button onClick={() => { setStep(1); setDeployResult(null); setRailProjectUrl(null); setRenderProjectUrl(null); setName(genName()); setUuid(genUuid()); setCustomPath(''); setProxyIP(''); setAdminPassword(''); setDeployLogs([]); railAdminRef.current = null; }} className="btn-ghost">استقرار جدید</button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-6">
                    <div className="inline-flex w-16 h-16 rounded-2xl bg-error-500/10 items-center justify-center mb-4">
                      <AlertCircle className="w-8 h-8 text-error-400" />
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2">استقرار ناموفق</h3>
                    <p className="text-slate-400 text-sm mb-6 max-w-md mx-auto">{deployResult.message}</p>

                    {deployLogs.length > 0 && (
                      <div className="max-w-2xl mx-auto mb-6">
                        <div className="bg-slate-900/80 rounded-xl border border-slate-800 p-4 max-h-48 overflow-y-auto font-mono text-xs space-y-1 text-right" dir="ltr">
                          {deployLogs.map((log, i) => (
                            <div key={i} className={log.includes('✓') || log.includes('bytes') ? 'text-green-400' : 'text-slate-300'}>{log}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(method === 'vps' || method === 'railway') && deployResult.success && (
                      <div className="max-w-md mx-auto mb-6 p-4 rounded-xl bg-brand-500/10 border border-brand-500/30 text-right">
                        <p className="text-sm font-bold text-brand-300 mb-2">مراحل بعدی:</p>
                        {method === 'railway' ? (
                          <ol className="text-xs text-slate-300 space-y-1 list-decimal list-inside">
                            <li>فایل ZIP را از حساب GitHub خود fork کنید</li>
                            <li>به <a href="https://railway.app/new" target="_blank" rel="noopener noreferrer" className="text-brand-300 hover:underline">railway.app/new</a> بروید</li>
                            <li><strong>Deploy from GitHub repo</strong> → مخزن fork‌شده را انتخاب کنید</li>
                            <li>Railway خودکار Dockerfile را تشخیص می‌دهد و مستقر می‌کند</li>
                            <li>در <strong>Settings → Variables</strong> متغیرها را تنظیم کنید</li>
                            <li>در <strong>Settings → Networking</strong> دکمه Generate Domain را بزنید</li>
                          </ol>
                        ) : (
                          <ol className="text-xs text-slate-300 space-y-1 list-decimal list-inside">
                            <li>فایل ZIP را به VPS آپلود کنید</li>
                            <li>استخراج کنید: <code className="text-brand-300">unzip {name}-{PANEL.id}.zip</code></li>
                            <li>اجرا کنید: <code className="text-brand-300">bash deploy.sh</code></li>
                            <li>پنل: <code className="text-brand-300">http://آیپی‌سرور:8080/login</code></li>
                          </ol>
                        )}
                      </div>
                    )}

                    <div className="flex gap-3 justify-center">
                      <button onClick={() => setDeployResult(null)} className="btn-primary">تلاش مجدد</button>
                      <button onClick={() => setStep(2)} className="btn-ghost">بازگشت به تنظیمات</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!deployResult && (
              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="btn-ghost" disabled={deploying}>قبلی</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Railway account-token picker + inline add (used in step 2 of the wizard). */
function RailwayTokenPanel({ tokens, selectedId, onSelect, newName, newToken, onNewName, onNewToken, saving, error, onSave }: {
  tokens: RailwayToken[]
  selectedId: string
  onSelect: (id: string) => void
  newName: string
  newToken: string
  onNewName: (v: string) => void
  onNewToken: (v: string) => void
  saving: boolean
  error: string | null
  onSave: () => void
}) {
  return (
    <div className="space-y-3 rounded-xl border border-purple-500/25 bg-purple-500/5 p-4">
      <label className="block text-sm text-slate-300 mb-1 font-medium">توکن Railway (Account)</label>
      {tokens.length === 0 ? (
        <p className="text-sm text-warning-300 leading-relaxed">
          هنوز توکن Railway ثبت نشده. از{' '}
          <a href="https://railway.com/account/tokens" target="_blank" rel="noopener noreferrer" className="text-purple-300 underline">railway.com/account/tokens</a>{' '}
          یک توکن Account بگیرید (فقط یک‌بار نمایش داده می‌شود) و همین‌جا ذخیره کنید:
        </p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <select value={selectedId} onChange={(e) => onSelect(e.target.value)} className="input-field text-sm flex-1 min-w-[200px]">
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.account_name ? ` (${t.account_name})` : ''}</option>
            ))}
          </select>
          <a href="/#/tokens" className="text-xs text-purple-300 hover:underline">مدیریت توکن‌ها ←</a>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
          placeholder="نام توکن (مثلاً railway-main)"
          className="input-field text-sm"
        />
        <textarea
          value={newToken}
          onChange={(e) => onNewToken(e.target.value)}
          rows={2}
          placeholder="توکن Account Railway را اینجا paste کنید..."
          className="input-field font-mono text-sm"
          dir="ltr"
        />
      </div>
      {error && <p className="text-xs text-error-300">{error}</p>}
      <button type="button" onClick={onSave} disabled={saving} className="btn-secondary text-sm flex items-center gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        {saving ? 'در حال بررسی با Railway...' : 'تأیید و ذخیره توکن Railway'}
      </button>
    </div>
  )
}

/** Render.com API-key picker + inline add (used in step 2 of the wizard). */
function RenderTokenPanel({ tokens, selectedId, onSelect, newName, newToken, onNewName, onNewToken, saving, error, onSave }: {
  tokens: RenderToken[]
  selectedId: string
  onSelect: (id: string) => void
  newName: string
  newToken: string
  onNewName: (v: string) => void
  onNewToken: (v: string) => void
  saving: boolean
  error: string | null
  onSave: () => void
}) {
  return (
    <div className="space-y-3 rounded-xl border border-teal-500/25 bg-teal-500/5 p-4">
      <label className="block text-sm text-slate-300 mb-1 font-medium">کلید API رندر (Render.com)</label>
      {tokens.length === 0 ? (
        <p className="text-sm text-warning-300 leading-relaxed">
          هنوز کلید API رندر ثبت نشده. از{' '}
          <a href="https://dashboard.render.com/account/api-keys" target="_blank" rel="noopener noreferrer" className="text-teal-300 underline">dashboard.render.com/account/api-keys</a>{' '}
          یک کلید بسازید و همین‌جا ذخیره کنید:
        </p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <select value={selectedId} onChange={(e) => onSelect(e.target.value)} className="input-field text-sm flex-1 min-w-[200px]">
            {tokens.map((t) => (
              <option key={t.id} value={t.id}>{t.name}{t.account_name ? ` (${t.account_name})` : ''}</option>
            ))}
          </select>
          <a href="/#/tokens" className="text-xs text-teal-300 hover:underline">مدیریت توکن‌ها ←</a>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr] gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
          placeholder={`نام کلید (مثلاً ${PANEL.id}-main)`}
          className="input-field text-sm"
        />
        <textarea
          value={newToken}
          onChange={(e) => onNewToken(e.target.value)}
          rows={2}
          placeholder="کلید API رندر (rnd_...) را اینجا paste کنید..."
          className="input-field font-mono text-sm"
          dir="ltr"
        />
      </div>
      {error && <p className="text-xs text-error-300">{error}</p>}
      <button type="button" onClick={onSave} disabled={saving} className="btn-secondary text-sm flex items-center gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        {saving ? 'در حال بررسی با Render...' : 'تأیید و ذخیره کلید رندر'}
      </button>
    </div>
  )
}

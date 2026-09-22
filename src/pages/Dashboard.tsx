import { useEffect, useState } from 'react'
import PanelDeploys from '../components/PanelDeploys'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import {
  KeyRound,
  Rocket,
  Users,
  Activity,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Cloud,
  Bot,
  Zap,
  Download,
  Upload,
  DatabaseBackup,
} from 'lucide-react'
import { Gauge } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useRef } from 'react'

interface Stats {
  tokens: number
  deployments: number
  deployed: number
  failed: number
  botUsers: number
  activeBotUsers: number
  recentLogs: number
}

interface RecentLog {
  id: string
  action: string
  entity_name: string | null
  created_at: string
}

export default function Dashboard() {
  const { user } = useAuth()
  const [stats, setStats] = useState<Stats | null>(null)
  const [logs, setLogs] = useState<RecentLog[]>([])
  const [quota, setQuota] = useState<{ used_today: number; limit: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const importFileRef = useRef<HTMLInputElement>(null)

  const handleImport = async (file: File) => {
    setImporting(true)
    setBackupMsg(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const res = await api<{ members_added: number; members_skipped: number; injectors_added: number; injectors_skipped: number; groups_added: number; groups_skipped: number }>('/api/backup', {
        method: 'POST',
        body: JSON.stringify({ ...parsed, mode: 'merge' }),
      })
      setBackupMsg(`بازگردانی شد: ${res.members_added} عضو، ${res.injectors_added} ساب تزریقی، ${res.groups_added} گروه (${res.members_skipped + res.injectors_skipped + res.groups_skipped} تکراری رد شد)`)
    } catch (e) {
      setBackupMsg(`خطا در بازگردانی: ${e instanceof Error ? e.message : 'فایل نامعتبر'}`)
    } finally {
      setImporting(false)
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const s = await api<Stats & { recentLogs: RecentLog[] }>('/stats')
        if (cancelled) return
        setStats({
          tokens: s.tokens,
          deployments: s.deployments,
          deployed: s.deployed,
          failed: s.failed,
          botUsers: s.botUsers,
          activeBotUsers: s.activeBotUsers,
          recentLogs: 0,
        })
        setLogs(s.recentLogs ?? [])
      } catch { /* stats unavailable */ }
      try {
        const q = await api<{ data: { used_today: number; limit: number } }>('/cf-quota')
        if (!cancelled) setQuota(q.data ?? null)
      } catch { /* cf-quota unavailable */ }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-400" />
      </div>
    )
  }

  const statCards = [
    { label: 'توکن‌های کلودفلر', value: stats?.tokens ?? 0, icon: KeyRound, color: 'from-blue-500 to-blue-600', link: '/tokens' },
    { label: 'ورکرهای مستقر شده', value: stats?.deployed ?? 0, icon: Rocket, color: 'from-green-500 to-green-600', link: '/deployments' },
    { label: 'کاربران ربات', value: stats?.botUsers ?? 0, icon: Users, color: 'from-purple-500 to-purple-600', link: '/bot-users' },
    { label: 'کاربران فعال', value: stats?.activeBotUsers ?? 0, icon: Activity, color: 'from-orange-500 to-orange-600', link: '/bot-users' },
  ]

  const actionLabels: Record<string, string> = {
    token_created: 'توکن ساخته شد',
    token_deleted: 'توکن حذف شد',
    deployment_created: 'استقرار شروع شد',
    deployment_deployed: 'ورکر مستقر شد',
    deployment_failed: 'استقرار ناموفق',
    bot_configured: 'ربات پیکربندی شد',
    bot_user_joined: 'کاربر جدید ربات',
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">داشبورد</h1>
          <p className="text-slate-400 text-sm mt-1">سلام {user?.email?.split('@')[0]} 👋 خوش برگشتی!</p>
        </div>
        <Link to="/deploy" className="btn-primary flex items-center gap-2 self-start">
          <Zap className="w-4 h-4" />
          استقرار ورکر جدید
        </Link>
      </div>


      {/* Backup / restore */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <DatabaseBackup className="w-4 h-4 text-brand-400" /> بکاپ و بازگردانی
            </h2>
            <p className="text-xs text-slate-500 mt-1">عضوها، ساب‌های تزریقی و گروهی — لینک‌ها بعد از بازگردانی همان قبلی می‌مانند.</p>
            {backupMsg && <p className="text-xs text-brand-300 mt-2">{backupMsg}</p>}
          </div>
          <div className="flex items-center gap-2">
            <a href="/api/backup" download
              className="btn-secondary flex items-center gap-2 text-sm px-3 py-1.5">
              <Download className="w-4 h-4" /> خروجی JSON
            </a>
            <button onClick={() => importFileRef.current?.click()} disabled={importing}
              className="btn-primary flex items-center gap-2 text-sm px-3 py-1.5">
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} بازگردانی
            </button>
            <input ref={importFileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImport(f) }} />
          </div>
        </div>
      </div>

      {/* The panel this installation is built around — always the first block. */}
      <PanelDeploys variant="card" />

      {/* Cloudflare daily-request quota monitor */}
      {quota && (
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Gauge className="w-4 h-4 text-brand-400" /> سهمیه درخواست کلودفلر (امروز)
            </h2>
            <span className={`text-xs font-mono ${quota.used_today / quota.limit > 0.8 ? 'text-error-400' : 'text-slate-400'}`} dir="ltr">
              {quota.used_today.toLocaleString()} / {quota.limit.toLocaleString()}
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div className={`h-full rounded-full ${quota.used_today / quota.limit > 0.8 ? 'bg-error-500' : 'bg-brand-500'}`}
              style={{ width: `${Math.min(100, (quota.used_today / quota.limit) * 100)}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-2">مجموع درخواست‌های همه ورکرهای اکانت شما امروز — نزدیک شدن به سقف رایگان ۱۰۰ هزار را پیش‌بینی کنید.</p>
        </div>
      )}
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon
          return (
            <Link to={card.link} key={i} className="stat-card group animate-slide-up" style={{ animationDelay: `${i * 100}ms` }}>
              <div className={`absolute -top-4 -left-4 w-24 h-24 bg-gradient-to-br ${card.color} opacity-10 rounded-full blur-2xl group-hover:opacity-20 transition-opacity`} />
              <div className="flex items-start justify-between mb-4">
                <div className={`p-3 rounded-xl bg-gradient-to-br ${card.color} shadow-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <TrendingUp className="w-4 h-4 text-slate-600" />
              </div>
              <p className="text-3xl font-bold text-white mb-1">{card.value}</p>
              <p className="text-sm text-slate-400">{card.label}</p>
            </Link>
          )
        })}
      </div>

      {/* Deployment status + quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Deployment status */}
        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Cloud className="w-5 h-5 text-brand-400" />
              وضعیت ورکرها
            </h2>
            <Link to="/deployments" className="text-sm text-brand-400 hover:text-brand-300 transition-colors">مشاهده همه</Link>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="text-center p-4 rounded-xl bg-slate-900/50 border border-slate-800">
              <div className="inline-flex p-2 rounded-lg bg-blue-500/10 mb-2">
                <Rocket className="w-5 h-5 text-blue-400" />
              </div>
              <p className="text-2xl font-bold text-white">{stats?.deployments ?? 0}</p>
              <p className="text-xs text-slate-400 mt-1">کل ورکرها</p>
            </div>
            <div className="text-center p-4 rounded-xl bg-slate-900/50 border border-slate-800">
              <div className="inline-flex p-2 rounded-lg bg-green-500/10 mb-2">
                <CheckCircle2 className="w-5 h-5 text-green-400" />
              </div>
              <p className="text-2xl font-bold text-green-400">{stats?.deployed ?? 0}</p>
              <p className="text-xs text-slate-400 mt-1">موفق</p>
            </div>
            <div className="text-center p-4 rounded-xl bg-slate-900/50 border border-slate-800">
              <div className="inline-flex p-2 rounded-lg bg-red-500/10 mb-2">
                <XCircle className="w-5 h-5 text-red-400" />
              </div>
              <p className="text-2xl font-bold text-red-400">{stats?.failed ?? 0}</p>
              <p className="text-xs text-slate-400 mt-1">ناموفق</p>
            </div>
          </div>

          {/* Quick action buttons */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
            <Link to="/deploy" className="btn-primary flex items-center justify-center gap-2 text-sm">
              <Zap className="w-4 h-4" /> ورکر جدید
            </Link>
            <Link to="/tokens" className="btn-ghost flex items-center justify-center gap-2 text-sm">
              <KeyRound className="w-4 h-4" /> توکن‌ها
            </Link>
            <Link to="/members" className="btn-ghost flex items-center justify-center gap-2 text-sm">
              <Users className="w-4 h-4" /> کاربران
            </Link>
            <Link to="/optimizer" className="btn-ghost flex items-center justify-center gap-2 text-sm">
              <Zap className="w-4 h-4" /> بهینه‌ساز
            </Link>
          </div>
          {/* Empty state: no deployments yet */}
          {(stats?.deployments ?? 0) === 0 && (
            <div className="mt-6 p-6 rounded-xl border-2 border-dashed border-brand-500/30 bg-brand-500/5 text-center">
              <Rocket className="w-10 h-10 text-brand-400 mx-auto mb-3" />
              <h3 className="text-lg font-bold text-white mb-1">هنوز ورکری مستقر نکردید؟</h3>
              <p className="text-sm text-slate-400 mb-4">اول یک توکن کلودفلر اضافه کنید، سپس اولین ورکر خود را بسازید.</p>
              <div className="flex items-center justify-center gap-3">
                <Link to="/tokens" className="btn-ghost text-sm">۱. افزودن توکن</Link>
                <Link to="/deploy" className="btn-primary text-sm">۲. استقرار ورکر</Link>
              </div>
            </div>
          )}
        </div>

        {/* Recent activity */}
        <div className="glass-card p-6">
          <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-brand-400" />
            فعالیت‌های اخیر
          </h2>
          {logs.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-sm">
              هنوز فعالیتی ثبت نشده
            </div>
          ) : (
            <div className="space-y-3">
              {logs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 p-3 rounded-xl bg-slate-900/40 border border-slate-800/50 hover:border-slate-700 transition-colors">
                  <div className="w-2 h-2 rounded-full bg-brand-400 mt-2 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">{actionLabels[log.action] ?? log.action}</p>
                    {log.entity_name && <p className="text-xs text-slate-500 truncate">{log.entity_name}</p>}
                    <p className="text-xs text-slate-600 mt-1">{new Date(log.created_at).toLocaleString('fa-IR')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

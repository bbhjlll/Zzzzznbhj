import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { BotUser } from '../lib/types'
import {
  Users,
  Loader2,
  Search,
  UserCheck,
  UserX,
  Trash2,
  TrendingUp,
  Info,
} from 'lucide-react'

export default function BotUsers() {
  const [users, setUsers] = useState<BotUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'blocked'>('all')

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: BotUser[] }>('/bot-users')
      setUsers(data ?? [])
    } catch {
      setUsers([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (user: BotUser) => {
    try { await api(`/bot-users/${user.id}`, { method: 'PATCH', body: { is_active: !user.is_active } }) } catch { /* ignore */ }
    load()
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`«${name}» از لیست کاربران ربات حذف شود؟\nفضای استقرار، توکن‌ها و استقرارهای او پاک نمی‌شوند.`)) return
    try { await api(`/bot-users/${id}`, { method: 'DELETE' }) } catch { /* ignore */ }
    load()
  }

  const filtered = users.filter((u) => {
    const matchSearch = !search ||
      u.username?.toLowerCase().includes(search.toLowerCase()) ||
      u.first_name?.toLowerCase().includes(search.toLowerCase()) ||
      u.telegram_id.includes(search)
    const matchFilter =
      filter === 'all' ? true :
      filter === 'active' ? u.is_active :
      !u.is_active
    return matchSearch && matchFilter
  })

  const stats = {
    total: users.length,
    active: users.filter(u => u.is_active).length,
    blocked: users.filter(u => !u.is_active).length,
    today: users.filter(u => {
      const d = new Date(u.created_at)
      const today = new Date()
      return d.toDateString() === today.toDateString()
    }).length,
  }

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">کاربران ربات</h1>
        <p className="text-slate-400 text-sm mt-1">هر کسی که به ربات /start بدهد یک فضای استقرار جداگانه برای خودش می‌گیرد</p>
      </div>

      {/* What this list means — only the owner ever sees it */}
      <div className="glass-card p-4 border-brand-500/30">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-brand-400 shrink-0 mt-0.5" />
          <p className="text-sm text-slate-300 leading-6">
            ربات <b>عمومی و فقط برای استقرار</b> است: هر کاربر توکن و لینک اختصاصی خودش را دارد و استقرارها با
            توکن خودِ او انجام می‌شود. تنها کنترل شما «مسدود کردن» است — کاربر مسدود هیچ صفحه‌ای نمی‌گیرد و
            نمی‌تواند استقرار یا توکن ثبت کند.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card">
          <div className="p-2.5 rounded-xl bg-blue-500/10 inline-block mb-3"><Users className="w-5 h-5 text-blue-400" /></div>
          <p className="text-2xl font-bold text-white">{stats.total}</p>
          <p className="text-xs text-slate-400 mt-1">کل کاربران</p>
        </div>
        <div className="stat-card">
          <div className="p-2.5 rounded-xl bg-green-500/10 inline-block mb-3"><UserCheck className="w-5 h-5 text-green-400" /></div>
          <p className="text-2xl font-bold text-white">{stats.active}</p>
          <p className="text-xs text-slate-400 mt-1">فعال</p>
        </div>
        <div className="stat-card">
          <div className="p-2.5 rounded-xl bg-error-500/10 inline-block mb-3"><UserX className="w-5 h-5 text-error-400" /></div>
          <p className="text-2xl font-bold text-white">{stats.blocked}</p>
          <p className="text-xs text-slate-400 mt-1">مسدود</p>
        </div>
        <div className="stat-card">
          <div className="p-2.5 rounded-xl bg-brand-500/10 inline-block mb-3"><TrendingUp className="w-5 h-5 text-brand-400" /></div>
          <p className="text-2xl font-bold text-white">{stats.today}</p>
          <p className="text-xs text-slate-400 mt-1">امروز</p>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجو بر اساس نام، یوزرنیم یا آیدی..."
              className="input-field pr-11"
            />
          </div>
          <div className="flex gap-2">
            {(['all', 'active', 'blocked'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  filter === f ? 'bg-brand-600 text-white' : 'bg-slate-800/50 text-slate-400 hover:text-white'
                }`}
              >
                {f === 'all' ? 'همه' : f === 'active' ? 'فعال' : 'مسدود'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Users table */}
      {filtered.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <Users className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">{users.length === 0 ? 'هنوز کاربری به ربات نپیوسته' : 'موردی یافت نشده'}</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800/50 text-right">
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">کاربر</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400 hidden sm:table-cell">آیدی تلگرام</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400 hidden md:table-cell">آخرین فعالیت</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">وضعیت</th>
                  <th className="px-4 py-3 text-xs font-medium text-slate-400">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id} className="border-b border-slate-800/30 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 bg-gradient-to-br from-brand-500 to-brand-700">
                          {(user.first_name ?? user.username ?? '?')[0]?.toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm text-white font-medium truncate">
                            {user.first_name} {user.last_name}
                          </p>
                          {user.username && <p className="text-xs text-slate-500 truncate" dir="ltr">@{user.username}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <code className="text-xs text-slate-400" dir="ltr">{user.telegram_id}</code>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-xs text-slate-500">{user.last_activity ? new Date(user.last_activity).toLocaleString('fa-IR') : '—'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`badge ${user.is_active ? 'bg-green-500/10 text-green-400' : 'bg-error-500/10 text-error-400'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-green-400' : 'bg-error-400'}`} />
                        {user.is_active ? 'فعال' : 'مسدود'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleToggle(user)}
                          title={user.is_active ? 'مسدود کردن دسترسی' : 'رفع مسدودی'}
                          className="p-2 rounded-lg text-slate-400 hover:bg-slate-700/50 hover:text-white transition-colors"
                        >
                          {user.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => handleDelete(user.id, user.first_name ?? user.username ?? 'کاربر')}
                          title="حذف از لیست"
                          className="p-2 rounded-lg text-slate-400 hover:bg-error-500/10 hover:text-error-400 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
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

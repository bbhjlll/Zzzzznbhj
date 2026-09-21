import { useCallback, useEffect, useState } from 'react'
import { Shield, Check } from 'lucide-react'
import { api } from '../lib/api'
import type { AdminUser } from '../lib/types'

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: AdminUser[] }>('/admin/users')
      setUsers(data ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت کاربران')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (id: string, body: { role?: string; max_deployments?: number }) => {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body })
      await load()
      setSaved(id)
      setTimeout(() => setSaved(null), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-2xl bg-black/60 border border-brand-300/35 flex items-center justify-center shadow-[0_0_24px_-6px_rgba(198,244,91,0.5)]">
          <Shield className="w-6 h-6 text-brand-300" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">مدیریت کاربران</h1>
          <p className="eyebrow-muted mt-1">ADMIN &amp; QUOTAS</p>
        </div>
      </div>

      {error && <p className="text-sm text-error-400">{error}</p>}

      <div className="card divide-y divide-slate-800">
        {users.map((u) => (
          <div key={u.id} className="p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <p className="text-white font-medium truncate">{u.email}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {u.deployments} ورکر · عضویت {new Date(u.created_at).toLocaleDateString('fa-IR')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* Role toggle */}
              <button
                onClick={() => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                  u.role === 'admin'
                    ? 'bg-brand-500/20 text-brand-300 border border-brand-500/40'
                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                }`}
              >
                {u.role === 'admin' ? 'ادمین' : 'کاربر'}
              </button>

              {/* Quota */}
              <input
                type="number"
                min={1}
                value={quotaDraft[u.id] ?? String(u.max_deployments)}
                onChange={(e) => setQuotaDraft((d) => ({ ...d, [u.id]: e.target.value }))}
                className="input-field w-24 text-center text-sm"
                title="سقف تعداد ورکر"
              />
              <button
                onClick={() => patch(u.id, { max_deployments: Number(quotaDraft[u.id] ?? u.max_deployments) })}
                className="p-2 rounded-lg bg-slate-800/60 text-slate-400 hover:text-brand-300"
                title="ذخیره سقف"
              >
                {saved === u.id ? <Check className="w-4 h-4 text-emerald-400" /> : <Check className="w-4 h-4" />}
              </button>
            </div>
          </div>
        ))}
        {users.length === 0 && !error && (
          <p className="text-sm text-slate-500 text-center py-8">کاربری ثبت نشده</p>
        )}
      </div>
    </div>
  )
}

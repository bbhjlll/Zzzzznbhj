import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { Cloud, Mail, Lock, Loader2, Sparkles, Eye, EyeOff } from 'lucide-react'

export default function AuthPage() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const fn = mode === 'signin' ? signIn : signUp
    const { error } = await fn(email, password)
    if (error) setError(error)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-slate-950 bg-grid flex items-center justify-center p-4 relative overflow-hidden">
      <div className="fixed inset-0 bg-radial-glow pointer-events-none" />
      <div className="absolute top-20 right-20 w-72 h-72 bg-brand-600/10 rounded-full blur-3xl animate-float" />
      <div className="absolute bottom-20 left-20 w-72 h-72 bg-brand-400/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '1s' }} />

      <div className="relative w-full max-w-md animate-slide-up">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-3xl bg-black/60 border border-brand-300/35 items-center justify-center mb-4 animate-pulse-glow">
            <Cloud className="w-8 h-8 text-brand-300" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">miliconfig <span className="gradient-text">Pro</span></h1>
          <p className="eyebrow">CONTROL CENTER</p>
          <p className="text-slate-400 text-sm mt-2">پنل مدیریت پیشرفته ورکرهای کلودفلر</p>
        </div>

        {/* Card */}
        <div className="glass-card p-8">
          {/* Tabs */}
          <div className="flex gap-2 p-1 bg-slate-900/50 rounded-xl mb-6">
            <button
              onClick={() => setMode('signin')}
              className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === 'signin' ? 'bg-brand-600 text-white shadow-lg shadow-brand-500/30' : 'text-slate-400 hover:text-white'
              }`}
            >
              ورود
            </button>
            <button
              onClick={() => setMode('signup')}
              className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                mode === 'signup' ? 'bg-brand-600 text-white shadow-lg shadow-brand-500/30' : 'text-slate-400 hover:text-white'
              }`}
            >
              ثبت‌نام
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">ایمیل</label>
              <div className="relative">
                <Mail className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input-field pr-11"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-300 mb-2 font-medium">رمز عبور</label>
              <div className="relative">                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
                <input
                  type={showPass ? 'text' : 'password'}
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="حداقل ۶ کاراکتر"
                  className="input-field pr-11 pl-11"
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors">
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-4 py-3 rounded-xl bg-error-500/10 border border-error-500/30 text-error-400 text-sm animate-slide-in">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full flex items-center justify-center gap-2">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
              {mode === 'signin' ? 'ورود به پنل' : 'ساخت حساب'}
            </button>
          </form>

          <div className="mt-6 space-y-3">
            <button type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
              className="w-full text-center text-sm text-brand-400 hover:text-brand-300 transition-colors">
              {mode === 'signin' ? 'حساب ندارید؟ ثبت‌نام کنید' : 'قبلاً ثبت‌نام کردید؟ وارد شوید'}
            </button>
            <p className="text-center text-xs text-slate-500">
              با ورود، شما قوانین و مقررات را می‌پذیرید
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

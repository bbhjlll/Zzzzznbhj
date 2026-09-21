import { useEffect, useState, useCallback } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../lib/auth'
import type { BotConfig } from '../lib/types'
import {
  Bot,
  Loader2,
  Save,
  Check,
  Webhook,
  Power,
  AlertCircle,
  Sparkles,
  Copy,
  RefreshCw,
  PlugZap,
  ShieldCheck,
} from 'lucide-react'

interface WebhookInfo {
  url?: string
  pending_update_count?: number
  last_error_date?: number
  last_error_message?: string
  ip_address?: string
}

export default function BotConfigPage() {
  const { user } = useAuth()
  const [config, setConfig] = useState<BotConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [hookInfo, setHookInfo] = useState<WebhookInfo | null>(null)
  const [checkingHook, setCheckingHook] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)

  /** Strip invisible Unicode (ZWNJ/RTL marks) + whitespace + optional "bot" prefix —
   *  Persian copy-paste often injects these and Telegram silently rejects the token. */
  const cleanToken = (raw: string) =>
    // eslint-disable-next-line no-misleading-character-class
    raw.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '').replace(/^bot/i, '')
  const [welcomeMessage, setWelcomeMessage] = useState('سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.')
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: BotConfig | null }>('/bot-config')
      if (data) {
        setConfig(data)
        setWelcomeMessage(data.welcome_message)
      }
    } catch { /* not configured yet */ }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)

    try {
      // The server validates the token via Telegram getMe and connects the webhook.
      const { data } = await api<{ data: BotConfig }>('/bot-config', {
        method: 'PUT',
        body: { bot_token: cleanToken(botToken), welcome_message: welcomeMessage, is_active: true },
      })
      setConfig(data)
      setMessage({ type: 'success', text: 'ربات با موفقیت فعال شد! وب‌هوک متصل است و ربات آماده دریافت پیام‌هاست.' })
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'خطا در ارتباط با سرور'
      setMessage({ type: 'error', text: msg })
    }

    setSaving(false)
    setTimeout(() => setMessage(null), 5000)
  }

  const handleToggleActive = async () => {
    if (!config) return
    const newActive = !config.is_active
    try {
      const { data } = await api<{ data: BotConfig }>('/bot-config', { method: 'PATCH', body: { is_active: newActive } })
      if (data) setConfig(data)
      else setConfig({ ...config, is_active: newActive })
    } catch { /* ignore */ }
  }

  const copyWebhookUrl = () => {
    if (config?.webhook_url) {
      navigator.clipboard.writeText(config.webhook_url)
      setWebhookCopied(true)
      setTimeout(() => setWebhookCopied(false), 2000)
    }
  }

  const checkWebhookInfo = async () => {
    setCheckingHook(true)
    try {
      const { data } = await api<{ data: WebhookInfo }>('/bot-config/webhook-info')
      setHookInfo(data ?? null)
    } catch (err) {
      setHookInfo(null)
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'خطا در دریافت وضعیت از تلگرام' })
      setTimeout(() => setMessage(null), 5000)
    }
    setCheckingHook(false)
  }

  const reconnectWebhook = async () => {
    setReconnecting(true)
    setMessage(null)
    try {
      await api<{ data: BotConfig }>('/bot-config/reconnect', { method: 'POST' })
      setMessage({ type: 'success', text: 'وب‌هوک دوباره وصل شد! حالا به ربات /start بدهید.' })
      await load()
      await checkWebhookInfo()
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'خطا در اتصال مجدد' })
    }
    setReconnecting(false)
    setTimeout(() => setMessage(null), 6000)
  }

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>
  }

  const webhookUrl = `${window.location.origin}/api/webhooks/telegram`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">ربات استقرار تلگرام</h1>
        <p className="text-slate-400 text-sm mt-1">فقط مالک پنل: یک ربات عمومی که هر کاربر با فضای اختصاصی خودش از آن استقرار می‌گیرد</p>
      </div>

      {/* Status banner */}
      {config && (
        <div className={`glass-card p-4 flex items-center justify-between ${config.is_active ? 'border-green-500/30' : 'border-slate-700/50'}`}>
          <div className="flex items-center gap-3">
            <div className={`p-2.5 rounded-xl ${config.is_active ? 'bg-green-500/10' : 'bg-slate-700/30'}`}>
              <Power className={`w-5 h-5 ${config.is_active ? 'text-green-400' : 'text-slate-400'}`} />
            </div>
            <div>
              <p className="text-white font-medium">{config.is_active ? 'ربات فعال است' : 'ربات غیرفعال است'}</p>
              {config.bot_username && <p className="text-xs text-slate-400" dir="ltr">@{config.bot_username}</p>}
            </div>
          </div>
          <button onClick={handleToggleActive} className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
            config.is_active ? 'bg-error-500/10 text-error-400 hover:bg-error-500/20' : 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
          }`}>
            {config.is_active ? 'غیرفعال' : 'فعال'}
          </button>
        </div>
      )}

      {/* One public deployer bot; each Telegram user gets an isolated space */}
      <div className="glass-card p-5 border-brand-500/30 space-y-3">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-brand-400" /> ربات عمومی استقرار (فقط مالک)
        </h2>
        <ul className="text-sm text-slate-300 space-y-2 leading-6 list-disc ps-5">
          <li>
            این تب فقط برای <b>حساب مالک</b> (<code className="text-brand-200" dir="ltr">{user?.email ?? 'OWNER_EMAIL'}</code>) است؛
            کاربران و مدیران دیگر پنل آن را نه در منو می‌بینند و نه با آدرس مستقیم.
          </li>
          <li>ربات یک <b>استقراردهندهٔ عمومی</b> است: هر کاربر تلگرام با <code>/start</code> فضای اختصاصی خودش را می‌گیرد و توکن، لینک و استقرارهایش از بقیه جداست.</li>
          <li>هر کاربر توکن Cloudflare / Railway / Render خودش را در «🔑 توکن‌ها» داخل تلگرام اضافه می‌کند؛ استقرار با همان توکن انجام می‌شود، نه توکن شما.</li>
          <li>ربات هیچ ارتباط دیگری با پنل ندارد — نه مدیریت کاربران پنل، نه دسترسی به داده‌های آن؛ فقط استقرار.</li>
        </ul>
      </div>

      {/* Config form */}
      <form onSubmit={handleSave} className="glass-card p-6 space-y-5">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Bot className="w-5 h-5 text-brand-400" /> تنظیمات ربات
        </h2>

        <div>
          <label className="block text-sm text-slate-300 mb-2 font-medium">توکن ربات تلگرام</label>
          <input
            type="text"
            required={!config}
            value={botToken}
            onChange={(e) => setBotToken(cleanToken(e.target.value))}
            placeholder={config ? 'برای تغییر توکن، توکن جدید را وارد کنید' : '123456789:ABCdefGHIjklMNO...'}
            className="input-field font-mono text-sm"
            dir="ltr"
          />
          <p className="text-xs text-slate-500 mt-2">توکن را از @BotFather دریافت کنید{config ? ' — برای حفظ توکن فعلی، این فیلد را خالی بگذارید' : ''}. کاراکترهای نامرئی هنگام کپی خودکار پاک می‌شوند؛ کل رشتهٔ کامل (اعداد + دو‌نقطه + حروف) را یکجا کپی کنید.</p>
        </div>

        <div>
          <label className="block text-sm text-slate-300 mb-2 font-medium">پیام خوش‌آمدگویی</label>
          <textarea
            value={welcomeMessage}
            onChange={(e) => setWelcomeMessage(e.target.value)}
            rows={3}
            className="input-field"
          />
        </div>

        {message && (
          <div className={`px-4 py-3 rounded-xl text-sm animate-slide-in ${
            message.type === 'success' ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-error-500/10 border border-error-500/30 text-error-400'
          }`}>
            <div className="flex items-center gap-2">
              {message.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
              {message.text}
            </div>
          </div>
        )}

        <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          ذخیره تنظیمات
        </button>
      </form>

      {/* Webhook status */}
      {config && (
        <div className="glass-card p-6 space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Webhook className="w-5 h-5 text-brand-400" /> وضعیت وب‌هوک
          </h2>

          <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800/50">
            <p className="text-xs text-slate-500 mb-2">آدرس وب‌هوک:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm text-slate-300 font-mono truncate" dir="ltr">{config.webhook_url ?? webhookUrl}</code>
              <button onClick={copyWebhookUrl} className="p-1.5 rounded-lg text-slate-500 hover:text-white transition-colors">
                {webhookCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {config.webhook_url ? (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-green-500/10 border border-green-500/30">
              <Check className="w-5 h-5 text-green-400" />
              <p className="text-sm text-green-400">وب‌هوک متصل است و ربات آماده دریافت پیام‌هاست</p>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
              <AlertCircle className="w-5 h-5 text-amber-400" />
              <p className="text-sm text-amber-400">وب‌هوک هنوز متصل نیست. دوباره تنظیمات را ذخیره کنید تا اتصال خودکار انجام شود.</p>
            </div>
          )}

          {/* Live diagnostics straight from Telegram */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={checkWebhookInfo}
                disabled={checkingHook || !config}
                className="px-3 py-2 rounded-xl text-xs font-medium bg-brand-500/10 text-brand-300 hover:bg-brand-500/20 transition-all flex items-center gap-2 disabled:opacity-50"
              >
                {checkingHook ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                بررسی زنده از تلگرام
              </button>
              {config && (
                <button
                  type="button"
                  onClick={reconnectWebhook}
                  disabled={reconnecting}
                  className="px-3 py-2 rounded-xl text-xs font-medium bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {reconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
                  اتصال مجدد وب‌هوک (بدون نیاز به توکن)
                </button>
              )}
            </div>

            {hookInfo && (
              <div className={`p-4 rounded-xl border text-sm space-y-2 ${
                hookInfo.last_error_message
                  ? 'bg-error-500/10 border-error-500/30'
                  : 'bg-slate-900/50 border-slate-800/50'
              }`} dir="ltr">
                <p className="text-xs text-slate-500 font-bold" dir="rtl">پاسخ واقعی تلگرام (getWebhookInfo):</p>
                <p><span className="text-slate-500">URL:</span> <code className="text-slate-300 font-mono text-xs break-all">{hookInfo.url || '—'}</code></p>
                <p><span className="text-slate-500">Pending updates:</span> <span className="text-slate-300">{hookInfo.pending_update_count ?? 0}</span></p>
                {hookInfo.last_error_message && (
                  <p className="text-error-400"><span className="text-slate-500">Last error:</span> {hookInfo.last_error_message}{hookInfo.last_error_date ? ` (${new Date(hookInfo.last_error_date * 1000).toLocaleString('fa-IR')})` : ''}</p>
                )}
                {!hookInfo.last_error_message && hookInfo.url && (
                  <p className="text-green-400" dir="rtl">تلگرام تأیید می‌کند وب‌هوک فعال است — اگر باز هم پاسخی نمی‌گیرید، یک بار «اتصال مجدد» را بزنید و بعد /start بفرستید.</p>
                )}
                {!hookInfo.url && (
                  <p className="text-amber-400" dir="rtl">تلگرام می‌گوید هیچ وب‌هوکی تنظیم نشده — دکمهٔ «اتصال مجدد» را بزنید.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Public deployer: no owner gate, no claim code */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-3">
          <ShieldCheck className="w-5 h-5 text-brand-400" /> دسترسی ربات
        </h2>
        <p className="text-sm text-slate-400 leading-relaxed" dir="rtl">
          این ربات <b className="text-slate-200">عمومی و فقط برای استقرار</b> است و کد اتصال/قفل مالک ندارد: هر کاربر
          تلگرام با فرستادن <code className="text-brand-200">/start</code> فضای اختصاصی خودش را می‌گیرد. هر کس فقط
          توکن‌ها و استقرارهای خودش را می‌بیند و استقرارها با توکن خودِ او انجام می‌شود — نه توکن شما.
        </p>
      </div>

      {/* Bot commands info */}
      <div className="glass-card p-6">
        <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Sparkles className="w-5 h-5 text-brand-400" /> دستورات ربات
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { cmd: '/start', desc: 'شروع و نمایش منوی اصلی (همراه با کیبورد دائمی پایین صفحه)' },
            { cmd: '/quickstart', desc: 'شروع سریع — چهار قدم تا اولین ورکر' },
            { cmd: '/deploy', desc: 'ویزارد استقرار: ورکر کلودفلر یا پنل Railway/Render' },
            { cmd: '/workers', desc: 'لیست ورکرهای مستقر شده (صفحه‌بندی‌شده)' },
            { cmd: '/config <name>', desc: 'دریافت لینک پنل، ساب و کانفیگ' },
            { cmd: '/sub <name>', desc: 'دریافت لینک اشتراک (ساب)' },
            { cmd: '/panel <name>', desc: 'دریافت لینک پنل ورکر' },
            { cmd: '/panels', desc: 'پنل‌های آمادهٔ استقرار (StanNG v2، PXPANEL، LUFFY، 3X-UI، S-UI، PasarGuard، Remnawave، WG-Easy)' },
            { cmd: '/servers', desc: 'پنل‌های مستقرشده روی Railway و Render' },
            { cmd: '/configs', desc: 'کانفیگ‌ها و ساب‌های آماده' },
            { cmd: '/members', desc: 'کاربران ساب و سهمیهٔ مصرف' },
            { cmd: '/settings', desc: 'تنظیمات ربات (پیام خوش‌آمد، ثبت دستورات و دکمهٔ منو)' },
            { cmd: '/set <name> <key> <value>', desc: 'تغییر تنظیمات ورکر' },
            { cmd: '/status', desc: 'داشبورد وضعیت سرویس‌ها و سرورها' },
            { cmd: '/tokens', desc: 'لیست توکن‌های کلودفلر' },
            { cmd: '/id', desc: 'نمایش شناسهٔ تلگرام شما' },
            { cmd: '/menu', desc: 'بازگشت به منوی اصلی' },
            { cmd: '/help', desc: 'راهنمای دستورات' },
          ].map((c) => (
            <div key={c.cmd} className="flex items-center gap-3 p-3 rounded-xl bg-slate-900/40 border border-slate-800/50">
              <code className="text-sm text-brand-300 font-mono shrink-0" dir="ltr">{c.cmd}</code>
              <span className="text-sm text-slate-400">{c.desc}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-4 leading-relaxed">
          ربات مانند یک اپلیکیشن کار می‌کند: دکمه‌های پایین صفحه بخش‌های اصلی‌اند، هر صفحه در همان پیام به‌روز
          می‌شود و دکمهٔ «باز کردن پنل» گوشهٔ چت، شما را به همین پنل وب می‌آورد. لینک‌های عمیق هم پشتیبانی
          می‌شوند: <code className="text-brand-300" dir="ltr">t.me/&lt;bot&gt;?start=workers</code> یا
          {' '}<code className="text-brand-300" dir="ltr">?start=deploy</code>.
        </p>
      </div>
    </div>
  )
}

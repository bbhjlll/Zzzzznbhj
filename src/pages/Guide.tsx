import {
  BookOpen, LogIn, KeyRound, Rocket, Cloud, Zap, UsersRound,
  Bot, ShieldCheck, AlertTriangle,
} from 'lucide-react'

interface Step {
  n: string
  title: string
  icon: React.ReactNode
  body: React.ReactNode
}

const STEPS: Step[] = [
  {
    n: '۱', title: 'ورود / ثبت‌نام', icon: <LogIn className="w-4 h-4" />,
    body: (
      <>
        در صفحه <b>ورود</b> با ایمیل و رمز عبور حساب بسازید یا وارد شوید.
        <b> اولین کاربری که ثبت‌نام کند به‌صورت خودکار «ادمین»</b> می‌شود و تب «مدیریت کاربران» را می‌بیند.
        همه صفحات دیگر بدون ورود در دسترس نیستند.
      </>
    ),
  },
  {
    n: '۲', title: 'افزودن توکن Cloudflare', icon: <KeyRound className="w-4 h-4" />,
    body: (
      <>
        از داشبورد کلودفلر یک <b>API Token</b> بسازید و در تب «توکن‌ها» ثبت کنید. این توکن قلب پنل است —
        با آن ورکرها مستقر می‌شوند و تنظیمات واقعی خوانده/نوشته می‌شود. دسترسی‌های لازم:
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs" dir="ltr">
          {['Workers Scripts:Edit', 'Workers KV Storage:Read+Edit', 'Account Settings:Read', 'Analytics:Read', 'D1:Edit'].map((p) => (
            <span key={p} className="px-2 py-0.5 rounded bg-slate-800 text-brand-300 font-mono">{p}</span>
          ))}
        </div>
      </>
    ),
  },
  {
    n: '۳', title: 'استقرار پنل اختصاصی', icon: <Cloud className="w-4 h-4" />,
    body: (
      <>
        پنل اصلی این مجموعه «<b>پنل اختصاصی ما</b>» است: در «استقرار جدید» روش <b>Railway</b> یا <b>Render.com</b> را
        انتخاب کنید، توکن را بدهید و نام سرویس را تأیید کنید — پروژه ساخته می‌شود، مخزن به آن وصل می‌شود و داکر بیلد و مستقر می‌شود.
        رمز ادمین موقع استقرار ساخته و <b>یک‌بار</b> نمایش داده می‌شود (در «ورکرها و پنل → پنل اختصاصی» همیشه قابل دیدن است).
        حتماً یک <b>Volume روی <span className="font-mono text-xs">/data</span></b> بگذارید وگرنه با هر ری‌دیپلوی دیتابیس پاک می‌شود؛
        Reality فقط روی هاستی با پورت TCP واقعی (VPS یا TCP Proxy) منتشر می‌شود.
      </>
    ),
  },
  {
    n: '۴', title: 'استقرار ورکر جدید', icon: <Rocket className="w-4 h-4" />,
    body: (
      <>
        «استقرار جدید» → نام ورکر، UUID، سورس (edgetunnel یا پیش‌فرض میلی‌کانفیگ)، مسیر پنل و Proxy IP را تعیین کنید.
        مراحل استقرار به‌صورت زنده لاگ می‌شود؛ در پایان آدرس <span className="font-mono text-xs">workers.dev</span>
        {' '}و آدرس پنل ورکر (همیشه با پسوند <span className="font-mono text-xs">/admin</span>) تحویل گرفته می‌شود.
      </>
    ),
  },
  {
    n: '۵', title: 'مدیریت ورکرها و پنل', icon: <Cloud className="w-4 h-4" />,
    body: (
      <>
        در صفحه «ورکرها و پنل» بدون باز کردن پنل مستقرشده:
        <b> تنظیمات واقعی</b> (Proxy IP، مسیر، ADD.txt، پروتکل/ترنسپورت) را داخل KV خود سورس ذخیره کنید،
        با «بررسی نودهای زنده» اتصال را تأیید کنید و با <b>اسکنر IP</b> بازه CIDR را با handshake واقعی TCP اسکن کرده و IPهای سریع را روی ورکر یا ساب اعمال کنید.
      </>
    ),
  },
  {
    n: '۶', title: 'بهینه‌ساز و ساب گروهی', icon: <Zap className="w-4 h-4" />,
    body: (
      <>
        لینک ساب یا کانفیگ‌ها را به «بهینه‌ساز» بدهید → هر نود با TCP واقعی تست می‌شود، مرده‌ها حذف و سالم‌ها با تأخیر مرتب در یک ساب جدید تحویل می‌شوند.
        همچنین می‌توانید چند ورکر را در یک <b>ساب گروهی</b> ادغام کنید یا «ساب تزریقی» بسازید که IPهای منتخب و زنجیره HTTP/SOCKS5 در لحظه fetch روی آن اعمال می‌شود — لینک ثابت می‌ماند و محتوا همیشه به‌روز است.
      </>
    ),
  },
  {
    n: '۷', title: 'کاربران ورکر (اعضا)', icon: <UsersRound className="w-4 h-4" />,
    body: (
      <>
        هر ورکر را بین چند نفر تقسیم کنید: هر عضو <b>لینک ساب خصوصی</b> با تنظیمات منحصربه‌فرد می‌گیرد —
        کشور IP (آمریکا، آلمان، ...)، ترنسپورت (ws/gRPC)، فرگمنت با <b>پریست اپراتوری</b> (همراه اول، ایرانسل، رایتل، TCI، گیمینگ)，
        دورزدن تحریم، سقف حجم ماهانه، سقف درخواست و تاریخ انقضا. مصرف از Analytics کلودفلر خوانده می‌شود و با تمام شدن سهمیه، ساب عضو بسته می‌شود.
      </>
    ),
  },
  {
    n: '۸', title: 'ربات تلگرام', icon: <Bot className="w-4 h-4" />,
    body: (
      <>
        توکن ربات را در «ربات تلگرام» ثبت کنید و به ربات <b>/start</b> بدهید. لیست ورکرها با دکمه، دریافت ساب،
        ساب‌های بهینه و نوتیفیکیشن خودکار نتیجه هر استقرار را در تلگرام خواهید داشت.
      </>
    ),
  },
]

export default function Guide() {
  return (
    <div className="space-y-6">
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-2">
          <BookOpen className="w-5 h-5 text-brand-400" />
          <h2 className="text-lg font-bold text-white">راهنمای استفاده از میلی‌کانفیگ</h2>
        </div>
        <p className="text-sm text-slate-400">
          مسیر کامل کاربری از صفحه ورود تا تحویل ساب به مشتری — به ترتیب همین هفت قدم جلو بروید.
        </p>
      </div>

      <div className="space-y-3">
        {STEPS.map((s) => (
          <div key={s.n} className="glass-card p-5">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 shrink-0 rounded-xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center text-brand-300 font-bold text-sm">
                {s.n}
              </div>
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-white font-medium mb-1.5">{s.icon}{s.title}</h3>
                <p className="text-sm text-slate-300 leading-relaxed">{s.body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card p-5 border-warning-500/20">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <h3 className="text-white font-medium text-sm">نکات امنیتی</h3>
        </div>
        <ul className="list-disc pr-5 text-sm text-slate-300 space-y-1">
          <li>رمز پنل ورکرهای edgetunnel را فقط برای خودتان نگه دارید؛ آدرس پنل همیشه <span className="font-mono text-xs">/admin</span> است.</li>
          <li>لینک ساب هر عضو محرمانه است — هر کس لینک را داشته باشد به کانفیگ دسترسی دارد؛ با دکمه غیرفعال، دسترسی را فوری قطع کنید.</li>
          <li>توکن Cloudflare را با حداقل دسترسی‌های لازم بسازید و در صورت لو رفتن از تب «توکن‌ها» حذفش کنید.</li>
        </ul>
        <div className="flex items-start gap-2 mt-3 text-xs text-warning-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>سقف حجم/درخواست در لحظهٔ fetch ساب اعمال می‌شود و مصرف از آمار روزانهٔ کلودفلر خوانده می‌شود؛ قطع آنی وسط اتصال از عهده هیچ پنلی برنمی‌آید.</span>
        </div>
      </div>
    </div>
  )
}

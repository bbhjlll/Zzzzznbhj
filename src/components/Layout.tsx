import { NavLink, useNavigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import LiveGuide from './LiveGuide'
import {
  LayoutDashboard,
  KeyRound,
  Rocket,
  Users,
  UsersRound,
  Bot,
  ScrollText,
  LogOut,
  Cloud,
  Menu,
  X,
  UserPlus,
  Zap,
  Shield,
  BookOpen,
  ChevronLeft,
} from 'lucide-react'
import { useEffect, useState } from 'react'

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; guide?: string }

const baseNavItems: NavItem[] = [
  { to: '/', label: 'داشبورد', icon: LayoutDashboard, end: true, guide: 'nav-dashboard' },
  { to: '/tokens', label: 'توکن‌ها', icon: KeyRound, guide: 'nav-tokens' },
  { to: '/deploy', label: 'استقرار جدید', icon: UserPlus, guide: 'nav-deploy' },
  { to: '/deployments', label: 'ورکرها', icon: Cloud, guide: 'nav-deployments' },
  { to: '/optimizer', label: 'بهینه‌ساز', icon: Zap, guide: 'nav-optimizer' },
  { to: '/members', label: 'کاربران ورکر', icon: UsersRound, guide: 'nav-members' },
  { to: '/bot-config', label: 'ربات تلگرام', icon: Bot, guide: 'nav-bot-config' },
  { to: '/bot-users', label: 'کاربران ربات', icon: Users, guide: 'nav-bot-users' },
  { to: '/logs', label: 'لاگ‌ها', icon: ScrollText, guide: 'nav-logs' },
  { to: '/guide', label: 'راهنما', icon: BookOpen, guide: 'nav-guide' },
]

const adminNavItem: NavItem = { to: '/admin', label: 'مدیریت کاربران', icon: Shield, guide: 'nav-admin' }

/** ۰۱، ۰۲، … — the numbered rail used by the control-center nav. */
function faIndex(n: number): string {
  const digits = '۰۱۲۳۴۵۶۷۸۹'
  return String(n + 1).padStart(2, '0').replace(/\d/g, (d) => digits[Number(d)])
}

/** The lime square mark shared by the header, the rail and the account block. */
function BrandMark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  const box = size === 'sm' ? 'w-8 h-8 rounded-lg' : 'w-11 h-11 rounded-2xl'
  // The app icon itself is the brand mark, so the rail, the mobile header, the
  // favicon and the installed PWA always show the exact same artwork
  // (public/icon.svg → pwa-icon-*.png).
  return (
    <img
      src="/icon.svg"
      alt=""
      aria-hidden="true"
      className={`${box} shrink-0 object-cover border border-brand-300/35 shadow-[0_0_24px_-6px_rgba(198,244,91,0.5)]`}
    />
  )
}

function LiveChip({ label = 'زنده' }: { label?: string }) {
  return (
    <span className="chip-live">
      <span className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-pulse-dot" />
      {label}
    </span>
  )
}

/** Desktop-only control strip: the control-center header above every page. */
function TopStrip() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const time = now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const date = now.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="hidden lg:flex items-center justify-between gap-4 px-8 py-3.5 border-b border-white/[0.06] bg-[#0b120c]/70 backdrop-blur-xl sticky top-0 z-20">
      <div className="flex items-center gap-3 min-w-0">
        <span className="eyebrow">REAL-TIME NETWORK CONTROL</span>
        <span className="hairline w-16 xl:w-28" />
        <LiveChip />
        <span className="chip">سیستم آنلاین است</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="font-mono text-sm text-slate-200 tabular-nums" dir="ltr">{time}</span>
        <span className="text-xs text-slate-500">{date}</span>
      </div>
    </div>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // The bot is the owner's own deployer, not a panel feature: even panel
  // admins never see its section.
  const visibleNav = baseNavItems.filter((item) => user?.is_owner || (item.to !== '/bot-config' && item.to !== '/bot-users'))
  const navItems = user?.role === 'admin' ? [...visibleNav, adminNavItem] : visibleNav

  const handleSignOut = async () => {
    await signOut()
    navigate('/auth')
  }

  return (
    <LiveGuide>
    <div className="min-h-screen bg-slate-950 bg-grid">
      <div className="fixed inset-0 bg-radial-glow pointer-events-none" />

      {/* Mobile header — unchanged behaviour: logo + drawer toggle */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-[#0a0f0b]/90 backdrop-blur-xl border-b border-white/[0.07] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <BrandMark size="sm" />
          <div className="leading-tight">
            <span className="block font-bold text-white text-sm">miliconfig</span>
            <span className="eyebrow-muted">CONTROL CENTER</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LiveChip />
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-slate-300">
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Sidebar / rail */}
      <aside className={`fixed top-0 right-0 bottom-0 w-72 z-30 transition-transform duration-300 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="h-full bg-[#0b120c]/95 backdrop-blur-xl border-l border-white/[0.07] flex flex-col">
          {/* Logo */}
          <div className="p-5 border-b border-white/[0.07]">
            <div className="flex items-center gap-3">
              <BrandMark />
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-white leading-tight">miliconfig</h1>
                <p className="eyebrow">CONTROL CENTER</p>
              </div>
              <span className="ms-auto chip">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-300 animate-pulse-dot" />
                v7
              </span>
            </div>
          </div>

          {/* Nav — numbered control rail */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {navItems.map((item, i) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  data-guide={item.guide}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all duration-200 group border ${
                      isActive
                        ? 'bg-black/60 border-brand-300/40 text-brand-200 shadow-[0_0_30px_-18px_rgba(198,244,91,0.8)]'
                        : 'border-transparent text-slate-400 hover:text-white hover:bg-white/[0.04]'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={`font-mono text-[10px] w-5 shrink-0 ${isActive ? 'text-brand-300' : 'text-slate-600'}`}>
                        {faIndex(i)}
                      </span>
                      <Icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-brand-300' : ''}`} />
                      <span className="font-medium text-sm truncate">{item.label}</span>
                      <ChevronLeft className={`w-4 h-4 ms-auto shrink-0 transition-opacity ${isActive ? 'text-brand-300/70 opacity-100' : 'opacity-0 group-hover:opacity-40'}`} />
                    </>
                  )}
                </NavLink>
              )
            })}
          </nav>

          {/* Account */}
          <div className="p-4 border-t border-white/[0.07]">
            <div className="flex items-center gap-3 mb-3 px-2">
              <div className="w-9 h-9 rounded-xl bg-black/60 border border-brand-300/30 flex items-center justify-center text-brand-200 font-bold text-sm">
                {user?.email?.[0]?.toUpperCase() ?? 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium truncate">{user?.email}</p>
                <p className="eyebrow-muted">{user?.role === 'admin' ? 'ADMIN' : 'ACCOUNT'}</p>
              </div>
            </div>
            <button onClick={handleSignOut} data-guide="signout" className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-white/[0.03] border border-white/[0.08] text-slate-300 hover:border-error-500/40 hover:text-error-400 transition-all duration-200 text-sm font-medium">
              <LogOut className="w-4 h-4" />
              خروج از حساب
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/60 z-20" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <main className="lg:mr-72 min-h-screen pt-16 lg:pt-0">
        <TopStrip />
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
    </LiveGuide>
  )
}

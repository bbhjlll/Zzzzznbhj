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
} from 'lucide-react'
import { useState } from 'react'

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

      {/* Mobile header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-slate-900/80 backdrop-blur-xl border-b border-slate-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-white">miliconfig</span>
        </div>
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-lg bg-slate-800/50 text-slate-300">
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Sidebar */}
      <aside className={`fixed top-0 right-0 bottom-0 w-72 z-30 transition-transform duration-300 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="h-full bg-slate-900/60 backdrop-blur-xl border-l border-slate-800/50 flex flex-col">
          {/* Logo */}
          <div className="p-6 border-b border-slate-800/50">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-lg shadow-brand-500/30 animate-pulse-glow">
                <Cloud className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-white">miliconfig</h1>
                <p className="text-xs text-brand-400 font-medium">پنل مدیریت Pro</p>
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  data-guide={item.guide}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group ${
                      isActive
                        ? 'bg-gradient-to-r from-brand-600/30 to-brand-500/10 text-brand-300 border border-brand-500/30'
                        : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
                    }`
                  }
                >
                  <Icon className="w-5 h-5 shrink-0" />
                  <span className="font-medium text-sm">{item.label}</span>
                </NavLink>
              )
            })}
          </nav>

          {/* User */}
          <div className="p-4 border-t border-slate-800/50">
            <div className="flex items-center gap-3 mb-3 px-2">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white font-bold text-sm">
                {user?.email?.[0]?.toUpperCase() ?? 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-medium truncate">{user?.email}</p>
                <p className="text-xs text-slate-500">مدیر</p>
              </div>
            </div>
            <button onClick={handleSignOut} data-guide="signout" className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800/50 text-slate-300 hover:bg-error-500/10 hover:text-error-400 transition-all duration-200 text-sm font-medium">
              <LogOut className="w-4 h-4" />
              خروج
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/50 z-20" onClick={() => setSidebarOpen(false)} />}

      {/* Main content */}
      <main className="lg:mr-72 min-h-screen pt-16 lg:pt-0">
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
          <Outlet />
        </div>
      </main>
    </div>
    </LiveGuide>
  )
}

import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth'
import AuthPage from './pages/AuthPage'
import Dashboard from './pages/Dashboard'
import Tokens from './pages/Tokens'
import Deployments from './pages/Deployments'
import DeployWizard from './pages/DeployWizard'
import BotUsers from './pages/BotUsers'
import BotConfig from './pages/BotConfig'
import ActivityLogs from './pages/ActivityLogs'
import Optimizer from './pages/Optimizer'
import Members from './pages/Members'
import Admin from './pages/Admin'
import Guide from './pages/Guide'
import Layout from './components/Layout'

function ProtectedRoute({ children }: { children?: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="animate-pulse text-brand-400 text-lg">در حال بارگذاری...</div></div>
  if (!user) return <Navigate to="/auth" replace />
  return <>{children}</>
}

/** The deployer-bot section belongs to the installation owner alone. */
function OwnerRoute({ children }: { children?: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="animate-pulse text-brand-400 text-lg">در حال بارگذاری...</div></div>
  if (!user) return <Navigate to="/auth" replace />
  if (!user.is_owner) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-950"><div className="animate-pulse text-brand-400 text-lg">در حال بارگذاری...</div></div>
  }

  return (
    <Routes>
      <Route path="/auth" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="tokens" element={<Tokens />} />
        <Route path="deployments" element={<Deployments />} />
        <Route path="deploy" element={<DeployWizard />} />
        <Route path="bot-users" element={<OwnerRoute><BotUsers /></OwnerRoute>} />
        <Route path="bot-config" element={<OwnerRoute><BotConfig /></OwnerRoute>} />
        <Route path="logs" element={<ActivityLogs />} />
        <Route path="optimizer" element={<Optimizer />} />
        <Route path="members" element={<Members />} />
        <Route path="admin" element={<Admin />} />
        <Route path="guide" element={<Guide />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

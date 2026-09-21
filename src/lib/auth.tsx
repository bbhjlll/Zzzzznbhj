import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api, setToken, clearToken, getToken } from './api'

export interface User {
  id: string
  email: string
  role?: string
  /** Only the installation owner may see and manage the deployer bot. */
  is_owner?: boolean
}

interface AuthContextType {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signUp: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signIn: async () => ({ error: 'not implemented' }),
  signUp: async () => ({ error: 'not implemented' }),
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!getToken()) {
      setLoading(false)
      return
    }
    api<{ user: User }>('/auth/me')
      .then(({ user }) => setUser(user))
      .catch(() => {
        clearToken()
        setUser(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const signIn = async (email: string, password: string) => {
    try {
      const { token, user } = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } })
      setToken(token)
      setUser(user)
      return { error: null }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'خطا در ورود' }
    }
  }

  const signUp = async (email: string, password: string) => {
    try {
      const { token, user } = await api<{ token: string; user: User }>('/auth/signup', { method: 'POST', body: { email, password } })
      setToken(token)
      setUser(user)
      return { error: null }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'خطا در ثبت‌نام' }
    }
  }

  const signOut = async () => {
    try { await api('/auth/logout', { method: 'POST' }) } catch { /* best effort */ }
    clearToken()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

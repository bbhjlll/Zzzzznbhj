const TOKEN_KEY = 'miliconfig_token'

/**
 * API base URL.
 * - Same-origin by default (SPA served by the worker itself).
 * - Override at build time with VITE_API_BASE (e.g. https://my-panel.workers.dev/api)
 *   when the frontend is hosted statically and the worker runs elsewhere.
 */
export const API_BASE = String(import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '')

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface ApiOptions {
  method?: string
  body?: unknown
}

/** Authenticated JSON request to the panel's worker API. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }

  // Session expired → clear local state so auth flow restarts.
  // 403 means "authenticated but not allowed" — that must never log the user out.
  if (resp.status === 401 && !path.startsWith('/auth')) {
    clearToken()
    // Tell the auth provider so ProtectedRoute bounces to /auth instead of
    // leaving the user on a page whose every request now fails.
    window.dispatchEvent(new Event('miliconfig:session-expired'))
  }

  const contentType = resp.headers.get('Content-Type') ?? ''
  const text = await resp.text().catch(() => '')
  let data: unknown = null
  try { data = text && contentType.includes('json') ? JSON.parse(text) : null } catch { /* non-JSON */ }

  if (!resp.ok) {
    const message =
      (data as { error?: string } | null)?.error ??
      (resp.status === 401 ? 'نشست شما منقضی شده است. دوباره وارد شوید.' :
       resp.status === 403 ? 'به این بخش دسترسی ندارید.' :
       resp.status === 404 || resp.status === 405 ? 'بک‌اند اینجا اجرا نمی‌شود — برنامه را با `npm run deploy` روی کلودفلر مستقر کنید و VITE_API_BASE را تنظیم کنید.' :
       `خطای سرور (${resp.status})`)
    throw new ApiError(message, resp.status)
  }
  return data as T
}

/**
 * Authenticated raw fetch — for endpoints that stream a body instead of JSON
 * (e.g. the real speed test, which counts actual downloaded bytes).
 */
export async function apiRaw(path: string): Promise<Response> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    return await fetch(`${API_BASE}${path}`, { headers })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }
}

/**
 * Authenticated file download.
 *
 * A plain `<a href="/api/...">` cannot carry the Bearer token, so the server
 * would answer 401 (or download the error body). Everything the panel exports
 * must go through here: the token is attached, the response is read as a blob
 * and saved with the filename the server chose.
 */
export async function downloadApi(path: string, fallbackName = 'download.json'): Promise<void> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}`, { headers })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }

  if (resp.status === 401) {
    clearToken()
    throw new ApiError('نشست شما منقضی شده است. دوباره وارد شوید.', resp.status)
  }
  if (resp.status === 403) throw new ApiError('به این بخش دسترسی ندارید.', resp.status)
  if (!resp.ok) throw new ApiError(`خطای سرور (${resp.status})`, resp.status)

  const disposition = resp.headers.get('Content-Disposition') ?? ''
  const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await resp.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

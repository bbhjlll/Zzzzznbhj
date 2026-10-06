import type { Env } from './env'
import { applyPanelRepo, normalizePanelRepo, resetPanelRepo } from '../shared/panels'

/**
 * The dedicated panel's source repository can move (renamed owner, new fork,
 * different upstream), so it is an admin-editable setting rather than a value
 * frozen in the catalog.
 *
 * The override lives in D1 (`app_settings.panel_repo`) and is pushed into the
 * shared catalog through `applyPanelRepo`, which is the single choke point every
 * path reads: Railway, Render, the VPS package, the upstream version probe, the
 * Telegram bot and the web UI all resolve the panel through `resolvePanel()`.
 */
const KEY = 'panel_repo'

/**
 * Reading D1 on every request would be wasteful, and nothing depends on an
 * override landing within milliseconds of a save — the writer applies it
 * synchronously, so a short TTL only affects other isolates.
 */
const TTL_MS = 30_000
let syncedAt = 0

/** Apply the stored override to the shared catalog (idempotent, cached). */
export async function syncPanelSource(env: Env): Promise<void> {
  if (Date.now() - syncedAt < TTL_MS) return
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(KEY)
      .first<{ value: string }>()
    const repo = normalizePanelRepo(row?.value ?? '')
    if (repo) applyPanelRepo(repo)
    else resetPanelRepo()
    syncedAt = Date.now()
  } catch {
    // A transient D1 error must never break a request: keep the last known
    // address (the catalog default on a cold isolate).
  }
}

/**
 * Store a new source address. Returns the canonical `owner/name`, or `null`
 * when the input is not a repository address (nothing is written in that case).
 */
export async function setPanelSource(env: Env, input: string): Promise<string | null> {
  const repo = normalizePanelRepo(input ?? '')
  if (!repo) return null
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(KEY, repo, new Date().toISOString())
    .run()
  // Apply right now: the current isolate must not wait out the TTL.
  applyPanelRepo(repo)
  syncedAt = Date.now()
  return repo
}

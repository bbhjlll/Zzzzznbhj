import type { Env } from './env'
import { apiError, genId, json, nowIso, safeJsonParse } from './util'
import { fetchWorkerSource, recordSourceFingerprint, workerSourceConfig } from './deploy'

// ── "به‌روزرسانی از مخزن" ─────────────────────────────────────────────────
// Every worker this panel deploys is a *copy* of an upstream repository file.
// This endpoint pulls that repository again and pushes the new file over the
// existing Cloudflare Worker — without touching the D1 database, the R2 bucket
// or any variable, because the current bindings are read back from Cloudflare
// and re-sent unchanged with the new code.
//
// The upstream file's ETag (a sha256 of its content) is stored on the
// deployment, so pressing the button on an unchanged repo costs one small GET
// and uploads nothing at all.

const API_BASE = 'https://api.cloudflare.com/client/v4'

interface UpdateBody {
  deployment_id?: string
}

interface ScriptSettings {
  main_module?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  bindings?: unknown[]
}

async function appendLog(env: Env, id: string, line: string): Promise<void> {
  const row = await env.DB.prepare('SELECT logs FROM deployments WHERE id = ?').bind(id).first<{ logs: string | null }>()
  await env.DB.prepare('UPDATE deployments SET logs = ? WHERE id = ?')
    .bind((row?.logs ?? '') + line + '\n', id)
    .run()
}

/**
 * POST /api/deployments/update — re-fetch the deployment's worker source from
 * its upstream repository and deploy it if it changed.
 */
export async function handleDeploymentUpdate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<UpdateBody>(await request.text().catch(() => ''), {})
  const id = body.deployment_id ?? ''
  if (!id) return apiError('deployment_id الزامی است', 400)

  const dep = await env.DB.prepare(
    `SELECT id, user_id, name, status, method, worker_source, config, cf_account_id, cf_token_row_id
       FROM deployments WHERE id = ? AND user_id = ?`,
  ).bind(id, userId).first<{
    id: string
    user_id: string
    name: string
    status: string
    method: string
    worker_source: string
    config: string | null
    cf_account_id: string | null
    cf_token_row_id: string | null
  }>()
  if (!dep) return apiError('ورکر پیدا نشد', 404)
  if (dep.status !== 'deployed') return apiError('این ورکر هنوز مستقر نشده است', 400)
  if (dep.method !== 'workers') return apiError('به‌روزرسانی از مخزن فقط برای ورکرهای Cloudflare Workers است', 400)
  if (!dep.cf_account_id) return apiError('این ورکر account_id ندارد — لطفاً دوباره مستقرش کنید', 400)

  const sourceConfig = workerSourceConfig(dep.worker_source)
  if (!sourceConfig.url) return apiError('این منبع ورکر از مخزن قابل به‌روزرسانی نیست', 400)

  const tokenRow = dep.cf_token_row_id
    ? await env.DB.prepare('SELECT token FROM cf_tokens WHERE id = ? AND user_id = ?')
        .bind(dep.cf_token_row_id, dep.user_id).first<{ token: string }>()
    : await env.DB.prepare(`SELECT token FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
        .bind(dep.user_id).first<{ token: string }>()
  if (!tokenRow?.token) return apiError('توکن فعال Cloudflare برای این ورکر پیدا نشد', 400)

  const headers = { Authorization: `Bearer ${tokenRow.token}` }
  const cfg = safeJsonParse<Record<string, unknown>>(dep.config ?? '', {})
  const previousEtag = String(cfg.source_etag ?? '')
  const previousSyncedAt = String(cfg.source_synced_at ?? '')

  await appendLog(env, id, `↻ checking upstream repository (${sourceConfig.label})...`)
  const fetched = await fetchWorkerSource(sourceConfig, sourceConfig.fallbackUrls ?? [])
  if (!fetched) {
    await appendLog(env, id, '✗ upstream source unreachable')
    return apiError('دریافت سورس از مخزن ناموفق بود', 502)
  }

  // Nothing new upstream — say so instead of pushing an identical script.
  if (previousEtag && fetched.etag && fetched.etag === previousEtag) {
    await appendLog(env, id, `✓ already up to date (${previousSyncedAt || 'unknown sync time'})`)
    return json({
      success: true,
      updated: false,
      up_to_date: true,
      bytes: fetched.code.length,
      source_url: fetched.url,
      synced_at: previousSyncedAt,
      message: 'نسخهٔ مخزن تغییری نکرده — ورکر هم‌اکنون به‌روز است.',
    })
  }

  // Read the live bindings so D1 / R2 / KV / variables survive the re-upload.
  const settingsResp = await fetch(
    `${API_BASE}/accounts/${dep.cf_account_id}/workers/scripts/${dep.name}/settings`,
    { headers },
  )
  const settingsData = (await settingsResp.json().catch(() => ({}))) as {
    success?: boolean
    result?: ScriptSettings
    errors?: Array<{ message: string }>
  }
  const live = settingsData.result
  if (!settingsData.success || !live?.bindings) {
    const msg = settingsData.errors?.[0]?.message ?? `failed to read worker settings (${settingsResp.status})`
    await appendLog(env, id, `✗ ${msg}`)
    return apiError(msg, 502)
  }

  const meta = {
    main_module: live.main_module || 'worker.js',
    compatibility_date: live.compatibility_date || sourceConfig.compat,
    compatibility_flags: live.compatibility_flags?.length
      ? live.compatibility_flags
      : ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings: live.bindings,
  }

  await appendLog(env, id, `uploading new source (${fetched.code.length} bytes)...`)
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
  form.append(meta.main_module, new Blob([fetched.code], { type: 'application/javascript+module' }), meta.main_module)

  const uploadResp = await fetch(
    `${API_BASE}/accounts/${dep.cf_account_id}/workers/scripts/${dep.name}`,
    { method: 'PUT', headers, body: form },
  )
  const uploadData = (await uploadResp.json().catch(() => ({}))) as {
    success?: boolean
    errors?: Array<{ message: string }>
  }
  if (!uploadData.success) {
    const msg = uploadData.errors?.[0]?.message ?? `upload failed (${uploadResp.status})`
    await appendLog(env, id, `✗ ${msg}`)
    return apiError(msg, 502)
  }

  await recordSourceFingerprint(env, id, { url: fetched.url, etag: fetched.etag, bytes: fetched.code.length })
  await appendLog(env, id, `✓ updated from repository (${fetched.code.length} bytes, bindings preserved)`)

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(genId(), userId, 'deployment_updated', 'deployment', dep.name,
      JSON.stringify({ bytes: fetched.code.length, source: fetched.url }), nowIso())
    .run()

  return json({
    success: true,
    updated: true,
    up_to_date: false,
    bytes: fetched.code.length,
    source_url: fetched.url,
    synced_at: nowIso(),
    message: `ورکر از مخزن به‌روز شد (${fetched.code.length} بایت) — دیتابیس و متغیرها دست‌نخورده ماندند.`,
  })
}
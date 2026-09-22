/**
 * Render.com REST API helpers (api.render.com/v1).
 *
 * Mirror of the Railway flow: an account API key (created at
 * https://dashboard.render.com/account/api-keys) authenticates via
 * `Authorization: Bearer <key>`. We create a Blueprint from an embedded
 * render.yaml-style spec for a catalog panel (see shared/panels.ts) — Docker
 * or native Python depending on the panel runtime — then trigger a deploy and
 * poll its status:
 *
 *   GET  /v1/owners                 → owner id for the key (verify)
 *   POST /v1/blueprints (multipart) → resources[] (web service id)
 *   POST /v1/services/{serviceId}/deploys → deploy id
 *   GET  /v1/deploys/{id} → status (created → build_in_progress → live)
 */

import { panelDataFile, type PanelSpec } from '../shared/panels'

export class RenderApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderApiError'
  }
}

const RENDER_API = 'https://api.render.com/v1'

interface RenderErrorBody {
  message?: string
  error?: string
}

async function renderFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response
  try {
    // FormData bodies must not get an explicit JSON content-type: fetch
    // generates the correct multipart boundary itself.
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
    resp = await fetch(`${RENDER_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch {
    throw new RenderApiError('اتصال به Render برقرار نشد — وضعیت اینترنت/فیلترینگ را بررسی و دوباره تلاش کنید')
  }

  const text = await resp.text().catch(() => '')
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }

  if (!resp.ok) {
    const body = data as RenderErrorBody | null
    const raw = body?.message ?? body?.error ?? (data ? JSON.stringify(data).slice(0, 300) : '') ?? ''
    if (resp.status === 401 || resp.status === 403 || /invalid|unauthorized|forbidden/i.test(raw)) {
      throw new RenderApiError('کلید API رندر نامعتبر است یا دسترسی کافی ندارد (از dashboard.render.com/account/api-keys کلید بسازید)')
    }
    throw new RenderApiError(`Render API خطا داد (HTTP ${resp.status}): ${raw}`.trim())
  }
  return data as T
}

interface RenderOwner {
  id?: string
  name?: string
  email?: string
  type?: string
}

/** Confirm a key belongs to a real Render account and read its owner. */
export async function verifyRenderToken(token: string): Promise<{ id: string; name: string; email: string }> {
  // GET /v1/owners returns the account that owns the API key.
  const owners = await renderFetch<Array<{ cursor?: string; owner?: RenderOwner }>>(token, '/owners')
  const owner = owners?.[0]?.owner
  if (!owner?.id) throw new RenderApiError('کلید API رندر قابل تأیید نیست')
  return { id: owner.id, name: owner.name ?? '', email: owner.email ?? '' }
}

export interface RenderDeployResult {
  serviceId: string
  deployId: string
  dashboardUrl: string
}

interface RenderResource {
  id?: string
  type?: string
}

interface BlueprintResponse {
  resources?: RenderResource[]
  blueprint?: { resources?: RenderResource[] }
  errors?: Array<{ error?: string }>
}

/**
 * render.yaml as YAML text. Docker panels build the repo's own Dockerfile;
 * native panels run the panel's build/start commands on Render's Python image.
 * The Blueprint API wants this as a `file` part in a multipart form, next to
 * an `ownerId` field.
 */
function buildRenderYaml(name: string, panel: PanelSpec, values: PanelDeployEnv): string {
  const lines: string[] = [
    'services:',
    '  - type: web',
    `    name: ${name}`,
  ]

  if (panel.runtime === 'docker') {
    lines.push(
      '    env: docker',
      '    plan: free',
      `    repo: https://github.com/${panel.repo}`,
      `    dockerfilePath: ${panel.dockerfilePath ?? 'Dockerfile'}`,
    )
  } else {
    lines.push(
      '    env: python',
      '    plan: free',
      `    repo: https://github.com/${panel.repo}`,
      '    branch: main',
      `    buildCommand: ${panel.buildCommand ?? 'pip install -r requirements.txt'}`,
      `    startCommand: ${panel.startCommand ?? 'python main.py'}`,
      `    healthCheckPath: ${panel.healthPath ?? panel.panelPath}`,
    )
  }


  const envVars: Array<[string, string]> = []
  if (panel.env.port) envVars.push([panel.env.port, String(panel.port)])
  if (panel.env.adminPassword) envVars.push([panel.env.adminPassword, values.adminPassword])
  if (panel.env.secretKey) envVars.push([panel.env.secretKey, values.secretKey])
  // A file inside the disk, never the disk's mount path itself — panels open
  // this value with sqlite3, which cannot open a directory.
  if (panel.env.dataDir) envVars.push([panel.env.dataDir, panelDataFile(panel)])

  if (envVars.length) {
    lines.push('    envVars:')
    for (const [key, value] of envVars) {
      lines.push(`      - key: ${key}`)
      lines.push(`        value: "${value}"`)
    }
  }
  lines.push('    autoDeploy: true')
  lines.push('')
  return lines.join('\n')
}

/** Values generated per-deploy and injected as panel env vars. */
export interface PanelDeployEnv {
  adminPassword: string
  secretKey: string
}

/**
 * Create a Render Blueprint from a catalog panel repo and trigger a deploy.
 * Returns the new web-service id, the deploy id and a dashboard link.
 */
export async function deployToRender(
  token: string,
  projectName: string,
  panel: PanelSpec,
  values: PanelDeployEnv,
): Promise<RenderDeployResult> {
  // 0. Resolve the owner id that this API key belongs to.
  const owner = await verifyRenderToken(token)

  // 1. Provision the web service via a Blueprint (multipart form).
  const form = new FormData()
  form.append('ownerId', owner.id)
  form.append('file', new Blob([buildRenderYaml(projectName, panel, values)], { type: 'text/yaml' }), 'render.yaml')

  const blueprint = await renderFetch<BlueprintResponse>(token, '/blueprints', {
    method: 'POST',
    body: form,
  })

  // Response shape: resources may sit at the top level or under `blueprint`.
  const resources = blueprint?.resources ?? blueprint?.blueprint?.resources ?? []

  // Prefer the web service; fall back to the first provisioned resource.
  const web = resources.find((r) => r.type === 'WEB_SERVICE')
  const serviceId = web?.id ?? resources[0]?.id
  if (!serviceId) {
    const errs = blueprint?.errors ?? []
    if (errs.some((e) => e.error === 'need_payment_info')) {
      throw new RenderApiError(
        'حساب Render شما نیاز به ثبت روش پرداخت دارد — در dashboard.render.com/billing یک کارت اضافه کنید، سپس دوباره تلاش کنید.',
      )
    }
    throw new RenderApiError(
      'Blueprint ساخته نشد. مطمئن شوید حساب GitHub شما در Render متصل است (dashboard.render.com → Account Settings → GitHub) و دوباره تلاش کنید.',
    )
  }

  // 2. Trigger the deploy.
  const deploy = await renderFetch<{ id?: string }>(
    token,
    `/services/${encodeURIComponent(serviceId)}/deploys`,
    { method: 'POST', body: JSON.stringify({}) },
  )
  const deployId = deploy?.id
  if (!deployId) throw new RenderApiError('دستور استقرار روی Render اجرا نشد')

  return { serviceId, deployId, dashboardUrl: `https://dashboard.render.com/web/${serviceId}` }
}

/** Poll the status of a deploy started with deployToRender. */
export async function renderDeployStatus(
  token: string,
  deployId: string,
  serviceId: string,
): Promise<{ status: string; url: string | null }> {
  const dep = await renderFetch<{ id?: string; status?: string }>(token, `/deploys/${encodeURIComponent(deployId)}`)
  if (!dep?.id) throw new RenderApiError('استقرار موردنظر پیدا نشد')

  let url: string | null = null
  if ((dep.status ?? '').toUpperCase() === 'LIVE') {
    // The service object may wrap serviceDetails at the top level or under a
    // `service` key — check both so the live URL is never missed.
    const svc = await renderFetch<{
      serviceDetails?: { url?: string | null }
      service?: { serviceDetails?: { url?: string | null }; url?: string | null }
    }>(token, `/services/${encodeURIComponent(serviceId)}`)
    url = svc?.serviceDetails?.url ?? svc?.service?.serviceDetails?.url ?? svc?.service?.url ?? null
  }
  return { status: (dep.status ?? 'UNKNOWN').toUpperCase(), url }
}
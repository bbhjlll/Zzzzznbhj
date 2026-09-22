/**
 * Railway Public API (GraphQL) helpers.
 *
 * Railway exposes its dashboard API at https://backboard.railway.com/graphql/v2.
 * Account/workspace tokens authenticate via `Authorization: Bearer <token>`.
 * We use it to auto-deploy a catalog panel (see shared/panels.ts) into a
 * brand-new Railway project, exactly like the Cloudflare flow creates workers:
 *
 *   projectCreate → default environment → serviceCreate (source = GitHub repo)
 *   → env vars + start command → serviceInstanceDeployV2 → poll until SUCCESS
 */

import { panelDataDir, panelDataFile, type PanelSpec } from '../shared/panels'

export class RailwayApiError extends Error {
  /**
   * True when Railway answered an explicit authorization denial. A *brand-new*
   * token is refused with exactly this response for a short window while
   * Railway propagates it, so callers use the flag to retry once instead of
   * telling the user their credential is bogus.
   */
  readonly denied: boolean

  constructor(message: string, denied = false) {
    super(message)
    this.name = 'RailwayApiError'
    this.denied = denied
  }
}

const RAILWAY_ENDPOINT = 'https://backboard.railway.com/graphql/v2'

interface GqlResponse {
  data?: Record<string, unknown> | null
  errors?: Array<{ message?: string; extensions?: { code?: string } }>
}

/**
 * Railway mounts volumes as root, while panel images commonly drop to an
 * unprivileged user (the catalog panel runs as `appuser`, uid 10001) and then
 * cannot create its SQLite file on the mount — the app dies on boot with
 * "unable to open database file". `RAILWAY_RUN_UID=0` is Railway's documented
 * way to run the container as root so it can own its own data volume.
 * Verified against a live deploy: without it the panel crash-looped.
 */
const RUN_AS_ROOT_VAR = 'RAILWAY_RUN_UID'

/** Account/workspace/OAuth tokens go in `Authorization`; project tokens do not. */
type Headers = Record<string, string>
const bearerHeaders = (token: string): Headers => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
})
/** Project/Environment tokens authenticate with their own header (Railway docs). */
const projectHeaders = (token: string): Headers => ({
  'Content-Type': 'application/json',
  'Project-Access-Token': token,
})

/** How long to wait before one retry of an authorization denial. */
const AUTH_RETRY_MS = 1500


/** One GraphQL round-trip; throws RailwayApiError with a user-friendly message. */
async function gqlOnce(
  headers: Headers,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  let resp: Response
  try {
    resp = await fetch(RAILWAY_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    throw new RailwayApiError('اتصال به Railway برقرار نشد — وضعیت اینترنت/فیلترینگ را بررسی و دوباره تلاش کنید')
  }

  let data: GqlResponse | null = null
  try {
    data = (await resp.json()) as GqlResponse
  } catch {
    /* fall through */
  }

  // Railway returns HTTP 200 with an errors array for most failures.
  const errors = data?.errors ?? []
  if (!data || (!data.data && errors.length === 0)) {
    if (resp.status === 429) throw new RailwayApiError('محدودیت نرخ درخواست Railway — کمی بعد دوباره تلاش کنید')
    throw new RailwayApiError(`Railway API پاسخ نامعتبر داد (HTTP ${resp.status})`)
  }
  if (errors.length) {
    const msgs = errors.map((e) => e.message ?? 'خطای نامشخص').filter(Boolean)
    if (msgs.some((m) => /not authorized|unauthorized|forbidden|invalid/i.test(m))) {
      // Either the credential really is bad, or Railway answered a denial for a
      // token that would work on the next try (see gql), so both are named.
      throw new RailwayApiError(
        'توکن Railway نامعتبر است یا دسترسی کافی ندارد — ابتدا یک‌بار دیگر تلاش کنید و اگر باز هم رد شد، از railway.com/account/tokens یک توکن «Account» بسازید',
        true,
      )
    }
    throw new RailwayApiError(msgs.join(' — ') || 'خطای Railway API')
  }
  return data.data ?? {}
}

/**
 * Raw GraphQL call with one retry on an authorization denial.
 *
 * Observed while integrating: Railway answers a bare `Not Authorized` for a
 * token that is in fact valid — the identical request succeeds moments later,
 * and the same token verifies consistently through a second HTTP client. One
 * retry therefore keeps a working credential from being reported as invalid,
 * while a persistent denial still surfaces as a clear error.
 */
async function gql(token: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    return await gqlOnce(bearerHeaders(token), query, variables)
  } catch (err) {
    if (!(err instanceof RailwayApiError) || !err.denied) throw err
    await new Promise((resolve) => setTimeout(resolve, AUTH_RETRY_MS))
    return await gqlOnce(bearerHeaders(token), query, variables)
  }
}

/**
 * Is this a *Project/Environment* token rather than an Account token?
 *
 * Both kinds are UUIDs, so the shape tells us nothing — but a project token is
 * a real Railway credential that simply cannot answer account-level queries
 * (`me` answers "Not Authorized"). Asking Railway directly lets us explain the
 * difference instead of calling a valid credential "invalid".
 *
 * The probe must use the `Project-Access-Token` header: that is the only header
 * project tokens are accepted in, so a Bearer probe could never identify one.
 */
async function isRailwayProjectToken(token: string): Promise<boolean> {
  try {
    const data = await gqlOnce(projectHeaders(token), 'query { projectToken { projectId environmentId } }')
    const pt = data.projectToken as { projectId?: string; environmentId?: string } | undefined
    return Boolean(pt?.projectId || pt?.environmentId)
  } catch {
    return false
  }
}

/** Confirm a token belongs to a real Railway account and read its owner. */
export async function verifyRailwayToken(token: string): Promise<{ name: string; email: string }> {
  try {
    const data = await gql(token, 'query { me { name email } }')
    const me = data.me as { name?: string; email?: string } | undefined
    if (!me) throw new RailwayApiError('توکن Railway قابل تأیید نیست')
    return { name: me.name ?? '', email: me.email ?? '' }
  } catch (err) {
    if (err instanceof RailwayApiError && (await isRailwayProjectToken(token))) {
      throw new RailwayApiError(
        'این توکن «Project/Environment» است، نه توکن حساب — از railway.com/account/tokens (Account Settings → Tokens → Create Token) یک توکن Account بسازید و همان را وارد کنید',
      )
    }
    throw err
  }
}

export interface RailwayDeployResult {
  projectId: string
  serviceId: string
  environmentId: string
  deploymentId: string
  projectUrl: string
  domain?: string | null
}

/** Values generated per-deploy and injected as panel env vars. */
export interface PanelDeployEnv {
  adminPassword: string
  secretKey: string
}

interface EnvEdge { node?: { id?: string; name?: string } }

/**
 * Create a Railway project from a catalog panel repo and trigger a deploy.
 * Returns the resource ids + a dashboard link to the new project.
 */
export async function deployToRailway(
  token: string,
  projectName: string,
  region = 'us-west2',
  panel: PanelSpec,
  values: PanelDeployEnv,
): Promise<RailwayDeployResult> {
  // 0. The live API requires a workspaceId on projectCreate — resolve the
  //    token's first workspace via `me { workspaces }`. Tolerate both the
  //    direct-list and Relay (edges/node) response shapes.
  const wsData = await gql(token, 'query { me { workspaces { id name } } }')
  const wsRaw = (wsData.me as { workspaces?: unknown } | undefined)?.workspaces
  const wsList: Array<{ id?: string; name?: string }> = Array.isArray(wsRaw)
    ? (wsRaw as Array<{ id?: string; name?: string }>)
    : Array.isArray((wsRaw as { edges?: Array<{ node?: unknown }> } | null | undefined)?.edges)
      ? ((wsRaw as { edges: Array<{ node?: { id?: string; name?: string } }> }).edges.map((e) => e.node ?? {}))
      : []
  const workspaceId = wsList[0]?.id
  if (!workspaceId) throw new RailwayApiError('حساب Railway شما هیچ workspace فعالی ندارد — از railway.com/account/tokens یک توکن Account بسازید')

  // 1. Create the project inside that workspace.
  const created = await gql(
    token,
    'mutation ($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }',
    { input: { name: projectName, workspaceId } },
  )
  const projectId = (created.projectCreate as { id?: string } | undefined)?.id
  if (!projectId) throw new RailwayApiError('پروژه Railway ساخته نشد')

  // 2. Resolve the default ("production") environment — create it if missing.
  const envData = await gql(
    token,
    'query ($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }',
    { id: projectId },
  )
  const edges = (((envData.project as { environments?: { edges?: EnvEdge[] } } | undefined)?.environments)?.edges ?? []) as EnvEdge[]
  let environmentId = edges.find((e) => (e.node?.name ?? '').toLowerCase() === 'production')?.node?.id
  if (!environmentId) environmentId = edges[0]?.node?.id
  if (!environmentId) {
    const envCreated = await gql(
      token,
      'mutation ($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id } }',
      { input: { projectId, name: 'production' } },
    )
    environmentId = (envCreated.environmentCreate as { id?: string } | undefined)?.id
  }
  if (!environmentId) throw new RailwayApiError('محیط پروژه Railway ساخته نشد')

  // 3. Create the service from the public GitHub repo.
  const svc = await gql(
    token,
    'mutation ($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }',
    {
      input: {
        projectId,
        environmentId,
        name: projectName,
        branch: 'main',
        source: { repo: panel.repo },
      },
    },
  )
  const serviceId = (svc.serviceCreate as { id?: string } | undefined)?.id
  if (!serviceId) {
    throw new RailwayApiError(
      `اتصال مخزن ${panel.name} به Railway ناموفق بود. مطمئن شوید حساب GitHub شما در Railway متصل است (Railway → Account Settings → GitHub)، سپس دوباره تلاش کنید.`,
    )
  }

  // 3b. Pin the deployment region (and, for non-Docker panels, the build/start
  //     commands Nixpacks needs) before the first deploy.
  const instanceInput: Record<string, unknown> = { region }
  if (panel.healthPath || panel.panelPath) instanceInput.healthcheckPath = panel.healthPath ?? panel.panelPath
  if (panel.runtime !== 'docker') {
    if (panel.startCommand) instanceInput.startCommand = panel.startCommand
    if (panel.buildCommand) instanceInput.buildCommand = panel.buildCommand
  }
  await gql(
    token,
    'mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
    { serviceId, environmentId, input: instanceInput },
  ).catch(() => null)

  // 3c. Generate a *.up.railway.app domain so the panel is reachable as soon
  //     as the first deploy goes live.
  let domain: string | null = null
  try {
    const dom = await gql(
      token,
      'mutation ($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }',
      { input: { serviceId, environmentId } },
    )
    domain = (dom.serviceDomainCreate as { domain?: string } | undefined)?.domain ?? null
  } catch {
    /* the domain can still be generated later from the dashboard */
  }

  // 3d. Attach a persistent volume to the panel's data directory. Railway wipes
  //     the container filesystem on every redeploy, so a panel that keeps its
  //     users/config in SQLite would silently reset to defaults without this.
  if (panel.env.dataDir) {
    await gql(
      token,
      'mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }',
      { input: { projectId, environmentId, serviceId, mountPath: panelDataDir(panel) } },
    ).catch(() => null)
  }

  // 4. Set the panel's env vars so it starts configured on first boot
  //    (PORT + the generated admin credentials, when the panel understands them).
  const envVars: Array<[string, string]> = []
  if (panel.env.port) envVars.push([panel.env.port, String(panel.port)])
  if (panel.env.adminPassword) envVars.push([panel.env.adminPassword, values.adminPassword])
  if (panel.env.secretKey) envVars.push([panel.env.secretKey, values.secretKey])
  // The panel wants the *file* inside the volume: pointing SQLITE_PATH at the
  // mount directory itself crashes the app on boot ("unable to open database
  // file"), which is exactly how a live Railway deploy failed before this.
  if (panel.env.dataDir) envVars.push([panel.env.dataDir, panelDataFile(panel)])
  // Only when a volume is attached: the container needs to own the root-owned
  // mount, and images that run as an unprivileged user otherwise cannot.
  if (panel.env.dataDir) envVars.push([RUN_AS_ROOT_VAR, '0'])
  for (const [name, value] of envVars) {
    // `skipDeploys` matters: every variable write otherwise starts its own
    // deployment, so a panel would build three or four times in a row (wasting
    // build minutes and flapping the service) before the real deploy below.
    await gql(
      token,
      'mutation ($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
      { input: { projectId, environmentId, serviceId, name, value, skipDeploys: true } },
    ).catch(() => null)
  }

  // 5. Trigger the deploy. Returns the deployment id (string).
  const dep = await gql(
    token,
    'mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }',
    { serviceId, environmentId },
  )
  const deploymentId = dep.serviceInstanceDeployV2 as string | undefined
  if (!deploymentId) throw new RailwayApiError('دستور استقرار روی Railway اجرا نشد')

  return { projectId, serviceId, environmentId, deploymentId, projectUrl: `https://railway.com/project/${projectId}`, domain }
}

/** Poll the status of a deployment started with deployToRailway. */
export async function railwayDeployStatus(token: string, deploymentId: string): Promise<{ status: string; url: string | null }> {
  const data = await gql(
    token,
    'query ($id: String!) { deployment(id: $id) { id status url staticUrl } }',
    { id: deploymentId },
  )
  const dep = data.deployment as { status?: string; url?: string | null; staticUrl?: string | null } | undefined
  if (!dep) throw new RailwayApiError('استقرار موردنظر پیدا نشد')
  return { status: dep.status ?? 'UNKNOWN', url: dep.url ?? dep.staticUrl ?? null }
}

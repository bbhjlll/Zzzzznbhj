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

import { buildPanelDeployEnv, DEFAULT_RAILWAY_REGION, panelBranch, panelDataDir, panelDataFile, panelTcpPorts, type PanelSpec } from '../shared/panels'

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
  // Account/workspace tokens use Authorization; project tokens use this header.
  // Railway ignores the other header, so one helper safely supports both.
  'Project-Access-Token': token,
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
    // Two account-level refusals users actually hit, with the same English
    // phrasing Railway returns. Their own words are unhelpful on a phone, so
    // each becomes an actionable Persian message.
    if (msgs.some((m) => /provision limit|resource limit|upgrade to provision/i.test(m))) {
      throw new RailwayApiError(
        'سهمیهٔ منابع پلن Railway شما پر شده — یک پروژهٔ بی‌استفاده را در داشبورد حذف کنید (یا پلن را ارتقا دهید) و دوباره تلاش کنید',
      )
    }
    if (msgs.some((m) => /too quickly|per \d+ seconds/i.test(m))) {
      throw new RailwayApiError('Railway اجازه می‌دهد هر ۳۰ ثانیه یک پروژه ساخته شود — نیم دقیقه صبر کنید و دوباره تلاش کنید')
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

export interface RailwayTcpProxy {
  id: string
  domain: string
  proxyPort: number
  applicationPort: number
  /** Which capability this proxy fronts (Reality, MTProto, HTTP …). */
  label?: string
}

export interface RailwayDeployResult {
  projectId: string
  serviceId: string
  environmentId: string
  deploymentId: string
  /** Pinned upstream sha; null when GitHub could not be reached and Railway
   *  deployed the connected branch HEAD instead. */
  commitSha: string | null
  commitUrl: string | null
  projectToken?: string | null
  /** First (direct) proxy — kept for the single-proxy card fields. */
  tcpProxy?: RailwayTcpProxy | null
  /** Every capability that got its own proxy, in catalog order. */
  tcpProxies?: RailwayTcpProxy[]
  tcpProxyError?: string | null
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
 * Newest commit that should be deployed for a connected GitHub branch.
 *
 * Deliberately best-effort. A Cloudflare Worker shares its egress IP with other
 * tenants and GitHub rate-limits unauthenticated calls per IP, so this lookup
 * really does answer HTTP 403 (the exact "403" users saw) even though the token
 * and the deploy are perfectly fine. Railway is already connected to the repo
 * and can build the branch HEAD without a pinned sha, so a failed lookup must
 * never fail the deployment: it returns `{ sha: null }` and the caller deploys
 * the branch HEAD instead.
 */
async function latestPanelCommit(
  panel: PanelSpec,
  branch = 'main',
): Promise<{ sha: string | null; url: string | null }> {
  const endpoint = `https://api.github.com/repos/${panel.repo}/commits/${encodeURIComponent(branch)}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-panel-deployer' },
        signal: AbortSignal.timeout(8000),
      })
      if (response.ok) {
        const data = (await response.json().catch(() => null)) as { sha?: string; html_url?: string } | null
        if (data?.sha) {
          return { sha: data.sha, url: data.html_url ?? `https://github.com/${panel.repo}/commit/${data.sha}` }
        }
        break
      }
      // 403/429 mean rate limited — retrying immediately cannot help, so stop
      // and let the caller deploy the branch HEAD. Anything else gets one more
      // try in case it was a transient 5xx/timeout.
      if (response.status === 403 || response.status === 429) return { sha: null, url: panel.url }
    } catch {
      /* offline / timeout → one more try */
    }
  }
  return { sha: null, url: panel.url }
}

/** Trigger a build of the service; pins `commitSha` when we know it, else HEAD. */
async function triggerRailwayDeploy(
  token: string,
  serviceId: string,
  environmentId: string,
  commitSha: string | null,
): Promise<string> {
  const mutation = commitSha
    ? 'mutation ($serviceId: String!, $environmentId: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha) }'
    : 'mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }'
  const variables: Record<string, unknown> = { serviceId, environmentId }
  if (commitSha) variables.commitSha = commitSha
  const data = await gql(token, mutation, variables)
  const deploymentId = data.serviceInstanceDeployV2 as string | undefined
  if (!deploymentId) throw new RailwayApiError('دستور استقرار آخرین نسخه روی Railway اجرا نشد')
  return deploymentId
}

/**
 * The newest deployment of a service, straight from Railway.
 *
 * `serviceCreate` in {@link deployToRailway} makes Railway build the connected
 * repository immediately, so there is always a deployment to point at even when
 * the explicit deploy command cannot run (a project token, a transient 403, a
 * rate limit). Reading it back turns "the panel actually deployed but we showed
 * an error" into a normal success.
 */
async function latestRailwayDeploymentId(
  token: string,
  projectId: string,
  serviceId: string,
  environmentId: string,
  attempts = 4,
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const data = await gql(
        token,
        'query ($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id } } } }',
        { input: { projectId, serviceId, environmentId } },
      )
      const edges = (data.deployments as { edges?: Array<{ node?: { id?: string } }> } | undefined)?.edges ?? []
      const id = edges[0]?.node?.id
      if (id) return id
    } catch {
      /* keep trying — Railway may still be creating the initial build */
    }
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

/**
 * Create a Railway project from a catalog panel repo and trigger a deploy.
 * Returns the resource ids + a dashboard link to the new project.
 */
export async function deployToRailway(
  token: string,
  projectName: string,
  region = DEFAULT_RAILWAY_REGION,
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
        branch: panelBranch(panel),
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

  // 3a. Suppress source-triggered builds while variables, token and TCP proxy
  //     are attached. The single explicit deployment below uses the latest HEAD.
  await gql(
    token,
    'mutation ($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }',
    { input: { projectId, serviceId, environmentId, enabled: false } },
  ).catch(() => null)

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

  // 3e. Create a project-scoped token for this deployment. The panel receives
  //     it as NEXUS_RAILWAY_TOKEN and can then create/update its own TCP proxies
  //     without retaining the user's broad Account token.
  let projectToken: string | null = null
  try {
    const tokenData = await gql(
      token,
      'mutation ($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }',
      { input: { projectId, environmentId, name: `${projectName} panel manager` } },
    )
    projectToken = typeof tokenData.projectTokenCreate === 'string' ? tokenData.projectTokenCreate : null
  } catch {
    /* web deployment continues with the account token as a fallback */
  }

  // 3f. Publish every declared raw-TCP capability (Reality, MTProto and the HTTP
  //     web proxy on Mizetusi). Railway gives each one a random public port, so
  //     a card that published only the first would hand out two links that
  //     answer nothing. The API requires one redeploy after creation; the
  //     explicit deployment below provides it. A failure is non-fatal per
  //     capability — the HTTPS panel still boots and the rest still publish.
  const tcpProxies: RailwayTcpProxy[] = []
  const tcpErrors: string[] = []
  for (const capability of panelTcpPorts(panel)) {
    try {
      const proxyData = await gql(
        token,
        'mutation ($input: TCPProxyCreateInput!) { tcpProxyCreate(input: $input) { id domain proxyPort applicationPort } }',
        { input: { environmentId, serviceId, applicationPort: capability.port } },
      )
      const item = proxyData.tcpProxyCreate as Partial<RailwayTcpProxy> | undefined
      if (item?.id && item.domain && item.proxyPort) {
        tcpProxies.push({ ...(item as RailwayTcpProxy), label: capability.label })
      } else {
        tcpErrors.push(`${capability.label}: Railway پروکسی TCP را بدون آدرس کامل برگرداند`)
      }
    } catch (err) {
      const reason = err instanceof RailwayApiError ? err.message : 'ساخت پروکسی TCP در Railway ناموفق بود'
      tcpErrors.push(`${capability.label}: ${reason}`)
    }
  }
  const tcpProxy = tcpProxies[0] ?? null
  const tcpProxyError = tcpErrors.length ? tcpErrors.join(' · ') : null

  // 4. Apply the shared, complete panel manifest. This includes generated admin
  //    credentials, JWT signing key, state file, platform/runtime switches,
  //    public URL and the project-scoped Railway token.
  const envVars = buildPanelDeployEnv(panel, 'railway', {
    ...values,
    railwayToken: projectToken ?? undefined,
    publicBaseUrl: domain ? `https://${domain}` : undefined,
  })
  // Only when a volume is attached: the container needs to own the root-owned
  // mount, and images that run as an unprivileged user otherwise cannot.
  if (panel.env.dataDir) envVars.push({ name: RUN_AS_ROOT_VAR, value: '0', secret: false })
  const uniqueEnvVars = [...new Map(envVars.map((item) => [item.name, item])).values()]
  for (const { name, value } of uniqueEnvVars) {
    // `skipDeploys` matters: every variable write otherwise starts its own
    // deployment, so a panel would build three or four times in a row (wasting
    // build minutes and flapping the service) before the real deploy below.
    await gql(
      token,
      'mutation ($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
      { input: { projectId, environmentId, serviceId, name, value, skipDeploys: true } },
    ).catch(() => null)
  }

  // 5. Fetch the newest main commit and deploy exactly that revision. This is
  //    deliberately not serviceInstanceRedeploy, which reuses an older SHA.
  const latest = await latestPanelCommit(panel)

  // Turn automatic GitHub deploys back on only after every setting is in place.
  // Future pushes to the connected branch now update this panel without any
  // action from miliconfig. Non-fatal: some project tokens reject this
  // mutation with a permission error *after* the service has been fully
  // created and its first deployment is already running — surfacing it would
  // show the user a false failure while the panel actually deploys fine.
  await gql(
    token,
    'mutation ($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }',
    { input: { projectId, serviceId, environmentId, enabled: true } },
  ).catch(() => null)

  // 5a. Trigger the (re)build. `serviceCreate` above already made Railway build
  //     the connected branch, so when the explicit command is refused — a
  //     project token, a transient 403, a rate limit — the deployment Railway
  //     is already running is adopted instead of reporting a failure the user
  //     would see while the panel actually deploys fine. That false failure is
  //     exactly the bug this guards against.
  let deploymentId: string
  try {
    deploymentId = await triggerRailwayDeploy(token, serviceId, environmentId, latest.sha)
  } catch (err) {
    const existing = await latestRailwayDeploymentId(token, projectId, serviceId, environmentId)
    if (!existing) throw err
    deploymentId = existing
  }

  return {
    projectId,
    serviceId,
    environmentId,
    deploymentId,
    commitSha: latest.sha,
    commitUrl: latest.url,
    projectToken,
    tcpProxy,
    tcpProxies,
    tcpProxyError,
    projectUrl: `https://railway.com/project/${projectId}`,
    domain,
  }
}

/** Deploy the newest commit of a connected panel branch on an existing service. */
export async function updateRailwayPanel(
  token: string,
  projectId: string,
  serviceId: string,
  environmentId: string,
  panel: PanelSpec,
  branch = 'main',
): Promise<{ deploymentId: string; commitSha: string | null; commitUrl: string | null }> {
  const latest = await latestPanelCommit(panel, branch)
  // Non-fatal for the same reason as in deployToRailway: the deploy command
  // itself below is what the user is waiting on.
  await gql(
    token,
    'mutation ($input: ServiceInstanceAutoDeployUpdateInput!) { serviceInstanceAutoDeployUpdate(input: $input) { enabled } }',
    { input: { projectId, serviceId, environmentId, enabled: true } },
  ).catch(() => null)
  const deploymentId = await triggerRailwayDeploy(token, serviceId, environmentId, latest.sha)
  return { deploymentId, commitSha: latest.sha, commitUrl: latest.url }
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

/**
 * Start a fresh build+deploy of an existing service from the newest commit on
 * the service's tracked branch. This is what "بروزرسانی به آخرین نسخه" does:
 * Railway rebuilds the repository HEAD, so the running panel moves to the
 * latest upstream release without recreating the project, its volume or its
 * environment variables.
 */
export async function railwayRedeploy(token: string, serviceId: string, environmentId: string): Promise<string> {
  const dep = await gql(
    token,
    'mutation ($serviceId: String!, $environmentId: String!) { serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }',
    { serviceId, environmentId },
  )
  const deploymentId = dep.serviceInstanceDeployV2 as string | undefined
  if (!deploymentId) throw new RailwayApiError('دستور بروزرسانی روی Railway اجرا نشد')
  return deploymentId
}

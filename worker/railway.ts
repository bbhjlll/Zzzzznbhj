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

import {
  buildPanelDeployEnv,
  DEFAULT_RAILWAY_REGION,
  panelBranch,
  panelDataDir,
  panelDataFile,
  panelTcpPorts,
  railwayMultiRegionConfig,
  railwayRegionLabel,
  resolveRailwayRegion,
  type PanelSpec,
} from '../shared/panels'

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
  /**
   * The region Railway actually has configured on the service after the deploy
   * request — the canonical identifier, read back from Railway, never just the
   * value we asked for.
   */
  region: string
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
 * The *committed* deploy config Railway holds for one service instance.
 *
 * Read from `environment(id).config` — the configuration a service's next
 * deployment will go out with. This is the only surface that answers the region
 * for a service on Railway's multi-region model: `serviceInstance.region` is the
 * legacy single-region field and stays `null` forever for such a service, which
 * is why the previous read-back could never detect a region that was not
 * applied. A deployment's own `meta.serviceManifest.deploy` carries the same
 * shape but is a snapshot frozen at deploy time, so it cannot confirm a change
 * made *before* the next deploy.
 */
interface CommittedDeployConfig {
  multiRegionConfig?: Record<string, { numReplicas?: number } | null> | null
  /** Legacy single-region field, still used by services created before 2024. */
  region?: string | null
}

/** The slice of `environment(id).config` these helpers read. */
interface CommittedEnvironmentConfig {
  services?: Record<
    string,
    {
      deploy?: CommittedDeployConfig
      volumeMounts?: Record<string, { mountPath?: string } | null> | null
    }
  >
  volumes?: Record<string, { region?: string | null } | null>
}

async function readCommittedEnvironmentConfig(
  token: string,
  environmentId: string,
): Promise<CommittedEnvironmentConfig | null> {
  const data = await gql(
    token,
    'query ($environmentId: String!) { environment(id: $environmentId) { config } }',
    { environmentId },
  )
  return (data.environment as { config?: CommittedEnvironmentConfig } | undefined)?.config ?? null
}

async function readCommittedDeployConfig(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<CommittedDeployConfig | null> {
  const config = await readCommittedEnvironmentConfig(token, environmentId)
  const deploy = config?.services?.[serviceId]?.deploy
  return deploy ?? null
}

/**
 * Every volume attached to a service, with the region it is bound to.
 *
 * A Railway volume lives in exactly one region and cannot be attached to a
 * service in another, so a region change on an existing panel has to be told
 * about the volume it leaves behind — otherwise the change looks applied and the
 * next deploy fails on the mismatch.
 */
export async function readRailwayVolumeRegions(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<Array<{ id: string; region: string | null }>> {
  try {
    const config = await readCommittedEnvironmentConfig(token, environmentId)
    const mounts = config?.services?.[serviceId]?.volumeMounts ?? {}
    const volumes = config?.volumes ?? {}
    return Object.keys(mounts).map((id) => ({ id, region: volumes[id]?.region ?? null }))
  } catch {
    /* verification is best-effort: an unreadable config must not fail a change */
    return []
  }
}

/**
 * The single region a `multiRegionConfig` pins, or null when it holds none.
 *
 * A zero-replica entry is how Railway (and its CLI) removes a region, so those
 * are skipped; when more than one region is still configured the first is
 * reported, which is enough for the mismatch check below.
 */
function regionFromMultiRegionConfig(
  multiRegionConfig: CommittedDeployConfig['multiRegionConfig'],
): string | null {
  if (!multiRegionConfig || typeof multiRegionConfig !== 'object') return null
  for (const [region, config] of Object.entries(multiRegionConfig)) {
    if (!region) continue
    if (config && typeof config.numReplicas === 'number' && config.numReplicas <= 0) continue
    if (config === null) continue
    return region
  }
  return null
}

/**
 * Read the region a service instance is configured with, straight from Railway.
 *
 * Best-effort by design: this is a *verification* step, and an API surface that
 * cannot answer it must not fail an otherwise valid deployment. `null` means
 * "could not be determined", which callers treat differently from a mismatch.
 *
 * `multiRegionConfig` first (what we and the dashboard both write), then the
 * legacy single-region field, then the legacy `serviceInstance.region` probe for
 * the oldest services.
 */
async function readRailwayServiceRegion(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<string | null> {
  try {
    const deploy = await readCommittedDeployConfig(token, serviceId, environmentId)
    const fromConfig = regionFromMultiRegionConfig(deploy?.multiRegionConfig)
    if (fromConfig) return fromConfig
    if (deploy?.region) return deploy.region
    const data = await gql(
      token,
      'query ($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { region } }',
      { serviceId, environmentId },
    )
    const inst = data.serviceInstance as { region?: string | null } | undefined
    return inst?.region ?? null
  } catch {
    return null
  }
}

/**
 * Point a service instance at a region and **prove Railway accepted it**.
 *
 * The write goes through `multiRegionConfig`, not `serviceInstanceUpdate.input
 * .region`. Both are accepted by the live API, but on a service using Railway's
 * multi-region model — every service this app creates — the `region` scalar is a
 * silent no-op: the mutation answers `true`, `serviceInstance.region` stays
 * `null`, the committed `multiRegionConfig` keeps whatever the workspace put
 * there (`{"sfo":{"numReplicas":1}}` for a US-preferred account) and the
 * container therefore keeps running in America. That is the exact bug this
 * fixes: "asked for the Netherlands, deployed to America".
 *
 * Verification is deliberately not best-effort. A refusal — or a read-back that
 * shows a *different* region than the one requested — surfaces as a clear error
 * instead of a deploy that silently runs on another continent.
 *
 * A region Railway reports in one of its other spellings (the short id `sfo`, or
 * a superseded name like `europe-west4`) is normalised before comparing, so the
 * different names for the same region never look like a mismatch.
 *
 * The write is **retried until the committed config agrees**, because a
 * brand-new service is not ready for it yet: `serviceCreate` makes Railway
 * commit the service's own initial deploy config a moment later, taken from the
 * workspace's preferred region, and when that lands after our write it wins —
 * verified against the live API, where a deploy asked for Amsterdam, wrote
 * Amsterdam, and then read back San Francisco until it gave up. Re-sending the
 * write until the config holds the region we asked for closes that race; the
 * alternative (one write, then hope) is what put panels in America.
 */
export const REGION_WRITE_ATTEMPTS = 5

/** Pause before re-sending a region write Railway has not committed yet. */
const REGION_RETRY_MS = 900

async function applyRailwayRegion(
  token: string,
  serviceId: string,
  environmentId: string,
  region: string,
): Promise<string> {
  const wanted = resolveRailwayRegion(region)
  if (!wanted) {
    throw new RailwayApiError(
      `منطقهٔ «${region}» را Railway پشتیبانی نمی‌کند — یکی از منطقه‌های فهرست (هلند/آمریکا/سنگاپور) را انتخاب کنید`,
    )
  }

  // A region Railway reports in a spelling we did not send — a stale committed
  // value, or the workspace default — is only ever reported once every attempt
  // has failed to change it.
  let refused: string | null = null
  for (let attempt = 0; attempt < REGION_WRITE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, REGION_RETRY_MS))
    await gql(
      token,
      'mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
      { serviceId, environmentId, input: { multiRegionConfig: railwayMultiRegionConfig(wanted) } },
    )
    const observed = await readRailwayServiceRegion(token, serviceId, environmentId)
    // An unreadable config is not a refusal: this is a verification step, and it
    // must not fail a deploy that may well be correct.
    if (!observed) {
      if (refused) break
      return wanted
    }
    if ((resolveRailwayRegion(observed) ?? observed) === wanted) return wanted
    refused = observed
  }

  if (refused) {
    throw new RailwayApiError(
      `Railway منطقهٔ درخواستی (${wanted}) را اعمال نکرد و سرویس روی ${refused} ماند — دوباره تلاش کنید یا منطقه را از داشبورد Railway عوض کنید`,
    )
  }
  return wanted
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

  // 3b. Health check path (and, for non-Docker panels, the build/start commands
  //     Nixpacks needs) before the first deploy.
  const instanceInput: Record<string, unknown> = {}
  if (panel.healthPath || panel.panelPath) instanceInput.healthcheckPath = panel.healthPath ?? panel.panelPath
  if (panel.runtime !== 'docker') {
    if (panel.startCommand) instanceInput.startCommand = panel.startCommand
    if (panel.buildCommand) instanceInput.buildCommand = panel.buildCommand
  }
  if (Object.keys(instanceInput).length) {
    await gql(
      token,
      'mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
      { serviceId, environmentId, input: instanceInput },
    ).catch(() => null)
  }

  // 3b-2. Pin the deployment region before anything below creates resources for
  //       this service. Unlike the settings above this one is not best-effort: a
  //       region Railway refuses means the panel would silently run in the
  //       workspace's default region (America), so the mismatch is surfaced
  //       instead of ignored. The confirmed region is also what the data volume
  //       below is created in — see the note there.
  const appliedRegion = await applyRailwayRegion(token, serviceId, environmentId, region)

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
  //
  //     The region is passed explicitly, because a Railway volume is bound to
  //     one region and does *not* follow its service. Verified against the live
  //     API: a volume created without one lands in the workspace's preferred
  //     region (America on a US-preferred account) even when the service is
  //     pinned to the Netherlands, and the service can then no longer attach its
  //     own data volume — its deployments fail. That is what kept "it deployed
  //     to America anyway" alive after the region write itself was fixed.
  if (panel.env.dataDir) {
    await gql(
      token,
      'mutation ($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }',
      { input: { projectId, environmentId, serviceId, mountPath: panelDataDir(panel), region: appliedRegion } },
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

  // 5-pre. Assert the region one last time, immediately before the build is
  //        requested. A brand-new service receives its own initial deploy config
  //        from Railway a moment after `serviceCreate`, and that config — the
  //        workspace's preferred region, America for most accounts — overwrites
  //        whatever was written before it landed. Re-asserting here (instead of
  //        once, early) is what makes the deployed container actually come up in
  //        the region the user chose. The volume above already follows the
  //        region, so this only ever re-confirms the same one.
  await applyRailwayRegion(token, serviceId, environmentId, region)

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
    region: appliedRegion,
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
 * The deployment a service is actually running right now.
 *
 * The id we record at deploy time goes stale the moment anything else queues a
 * redeploy — every settings change does — and Railway then answers `REMOVED` for
 * it. Following the service itself is what keeps a healthy panel from being
 * reported as failed.
 */
export async function latestRailwayServiceDeployment(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<{ id: string; status: string; url: string | null } | null> {
  try {
    const data = await gql(
      token,
      'query ($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { latestDeployment { id status url staticUrl } } }',
      { serviceId, environmentId },
    )
    const dep = (
      data.serviceInstance as
        | { latestDeployment?: { id?: string; status?: string; url?: string | null; staticUrl?: string | null } | null }
        | undefined
    )?.latestDeployment
    if (!dep?.id) return null
    return { id: dep.id, status: dep.status ?? 'UNKNOWN', url: dep.url ?? dep.staticUrl ?? null }
  } catch {
    return null
  }
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

// ── Per-service settings (region, serverless, outbound IPv6, CDN) ────────────

/** A partial settings change; every defined field is applied independently. */
export interface RailwaySettingsPatch {
  /** Region code — must be one of `RAILWAY_REGIONS` (validated by the caller). */
  region?: string
  /** Sleep the container when idle (Railway's "Enable Serverless"). */
  sleepApplication?: boolean
  /** Allow outbound IPv6 connections (Railway stages this as a config change). */
  ipv6Egress?: boolean
  /** CDN caching (needs an applied public domain). */
  cdnEnabled?: boolean
}

/** What Railway reports back for the toggles we cannot read directly. */
export interface RailwayServiceSettings {
  /** Region currently configured on the service, when Railway reports one. */
  region: string | null
  /** True when CDN caching is on; null when it could not be determined. */
  cdnEnabled: boolean | null
}

interface ServiceEdgeState {
  edgeConfig?: { enabled?: boolean | null; caching?: { mode?: string | null } | null } | null
}

/**
 * The caching mode Railway treats as "CDN off". Verified against the live API:
 * `updateServiceEdgeConfig` with this mode is the only way to actually disable
 * the cache (`disableServiceCdn` answers `true` and changes nothing).
 */
const CDN_OFF_MODE = 'off'

/**
 * The caching mode Railway treats as "CDN on", and the only other value it
 * accepts — every other spelling is answered with "Problem processing request".
 *
 * Turning the CDN back on takes this *and* `enableServiceCdn`, because the mode
 * is sticky: `enableServiceCdn` flips the edge on but leaves the mode alone, so
 * a service whose mode we previously set to `off` stays permanently uncached
 * (verified live: it answers `{enabled: true, caching: {mode: "off"}}` and the
 * read-back then reports the setting did not change).
 */
const CDN_ON_MODE = 'auto'

/** Turn CDN caching on or off, the way Railway actually honours it. */
async function writeRailwayCdn(
  token: string,
  serviceId: string,
  environmentId: string,
  on: boolean,
): Promise<void> {
  if (on) {
    await gql(
      token,
      'mutation ($input: EnableServiceCdnInput!) { enableServiceCdn(input: $input) { enabled caching { mode } } }',
      { input: { serviceId, environmentId } },
    )
  }
  await gql(
    token,
    'mutation ($input: UpdateServiceEdgeConfigInput!) { updateServiceEdgeConfig(input: $input) { enabled caching { mode } } }',
    {
      input: {
        serviceId,
        environmentId,
        config: { caching: { mode: on ? CDN_ON_MODE : CDN_OFF_MODE } },
      },
    },
  )
}

/** Is CDN caching on for this service? `null` when Railway will not answer. */
async function readRailwayEdgeEnabled(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<boolean | null> {
  try {
    const data = await gql(
      token,
      'query ($serviceId: String!, $environmentId: String!) { serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { edgeConfig { enabled caching { mode } } } }',
      { serviceId, environmentId },
    )
    const edge = (data.serviceInstance as ServiceEdgeState | undefined)?.edgeConfig
    if (!edge) return null
    return Boolean(edge.enabled) && (edge.caching?.mode ?? '').toLowerCase() !== CDN_OFF_MODE
  } catch {
    return null
  }
}

/**
 * Read the settings Railway exposes through a plain query.
 *
 * The region comes from the committed deploy config ({@link readRailwayServiceRegion}),
 * never from `serviceInstance.region` — that legacy field answers `null` for
 * every service on Railway's multi-region model, so the settings card used to
 * show "unknown" for a region that was in fact pinned. Serverless and outbound
 * IPv6 have no documented read field, so those come from our own record (see
 * `panel-deploy.ts`).
 */
export async function readRailwayServiceSettings(
  token: string,
  serviceId: string,
  environmentId: string,
): Promise<RailwayServiceSettings> {
  const [region, cdnEnabled] = await Promise.all([
    readRailwayServiceRegion(token, serviceId, environmentId),
    readRailwayEdgeEnabled(token, serviceId, environmentId),
  ])
  return { region, cdnEnabled }
}

/** What actually happened to a settings change, so the UI can tell the truth. */
export interface RailwaySettingsResult {
  /** Region Railway reports on the service after the change (null when unverifiable). */
  region: string | null
  /**
   * Deployment started to make a region change take effect. A region change only
   * moves the running container on the *next* deployment, so without this the
   * panel keeps serving from the old region while the settings card says it
   * moved.
   */
  redeployId: string | null
  /** A non-fatal problem worth showing (applied, but not in effect yet). */
  warning: string | null
}

/**
 * Apply a settings change on an existing Railway service.
 *
 *  • `region` → `serviceInstanceUpdate` (+ a redeploy, so it takes effect).
 *  • `sleepApplication` → its own `serviceInstanceUpdate`.
 *  • `ipv6Egress` → `environmentPatchCommit`: Railway models outbound IPv6 as an
 *    environment config change, and committing that patch also triggers the
 *    redeploy the toggle needs.
 *  • `cdnEnabled` → `enableServiceCdn` **plus** `updateServiceEdgeConfig` with
 *    `caching.mode = "auto"` to turn it on, and just the caching mode `"off"`
 *    to turn it off. **Not** `disableServiceCdn`: verified against the live API,
 *    that mutation answers `true` and leaves the cache exactly as it was, so the
 *    toggle only ever appeared to work in one direction. Needs an applied public
 *    domain, which a deployed panel has.
 *
 * Region and serverless are sent as **separate** mutations on purpose. Railway
 * fails the whole `serviceInstanceUpdate` for a single unknown field, and its
 * serverless flag (`sleepApplication`) is newer than `region` — bundled into one
 * call, one refused flag would silently drop the region change with it, which is
 * a large part of why "the settings in miliconfig do nothing on Railway".
 *
 * Each step is independent: a refusal on one setting does not discard the
 * others, and the first hard error is surfaced to the caller.
 */
export async function updateRailwayServiceSettings(
  token: string,
  opts: { serviceId: string; environmentId: string } & RailwaySettingsPatch,
): Promise<RailwaySettingsResult> {
  const result: RailwaySettingsResult = { region: null, redeployId: null, warning: null }

  if (opts.region) {
    result.region = await applyRailwayRegion(token, opts.serviceId, opts.environmentId, opts.region)

    // A data volume is bound to one region and cannot follow its service. Moving
    // the service off the volume's region therefore leaves the panel without its
    // data on the next deploy — say so instead of reporting a clean move.
    const stale = (await readRailwayVolumeRegions(token, opts.serviceId, opts.environmentId)).filter(
      (v) => v.region && (resolveRailwayRegion(v.region) ?? v.region) !== result.region,
    )
    if (stale.length) {
      const where = Array.from(new Set(stale.map((v) => railwayRegionLabel(v.region)))).join('، ')
      result.warning = `منطقه روی ${railwayRegionLabel(result.region)} ثبت شد، اما حجم دادهٔ پنل در ${where} ساخته شده و Railway آن را روی سرویس منطقهٔ جدید سوار نمی‌کند — پنل را از نو مستقر کنید تا داده هم در منطقهٔ جدید ساخته شود`
    }

    try {
      result.redeployId = await railwayRedeploy(token, opts.serviceId, opts.environmentId)
    } catch (err) {
      const reason = err instanceof RailwayApiError ? err.message : 'دستور راه‌اندازی مجدد پذیرفته نشد'
      const notice = `منطقه روی ${railwayRegionLabel(result.region)} ثبت شد اما برای اعمال آن یک راه‌اندازی مجدد لازم است و ناموفق بود (${reason}) — از دکمهٔ «بروزرسانی به آخرین نسخه» استفاده کنید`
      result.warning = result.warning ? `${result.warning} — ${notice}` : notice
    }
  }

  if (typeof opts.sleepApplication === 'boolean') {
    await gql(
      token,
      'mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
      { serviceId: opts.serviceId, environmentId: opts.environmentId, input: { sleepApplication: opts.sleepApplication } },
    )
  }

  if (typeof opts.ipv6Egress === 'boolean') {
    await gql(
      token,
      'mutation ($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) { environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage) }',
      {
        environmentId: opts.environmentId,
        patch: { services: { [opts.serviceId]: { deploy: { ipv6EgressEnabled: opts.ipv6Egress } } } },
        commitMessage: `miliconfig: outbound IPv6 ${opts.ipv6Egress ? 'enabled' : 'disabled'}`,
      },
    )
  }

  if (typeof opts.cdnEnabled === 'boolean') {
    // The caching *mode* is the switch Railway actually honours; `disableServiceCdn`
    // is a no-op that still answers `true`, and `enableServiceCdn` alone cannot
    // bring the cache back once the mode is `off`.
    await writeRailwayCdn(token, opts.serviceId, opts.environmentId, opts.cdnEnabled)
    // Verify rather than trust: a mutation Railway accepted is not the same as a
    // setting that changed, which is the whole lesson of this file.
    let cdn = await readRailwayEdgeEnabled(token, opts.serviceId, opts.environmentId)
    if (cdn !== null && cdn !== opts.cdnEnabled) {
      await writeRailwayCdn(token, opts.serviceId, opts.environmentId, opts.cdnEnabled)
      cdn = await readRailwayEdgeEnabled(token, opts.serviceId, opts.environmentId)
    }
    if (cdn !== null && cdn !== opts.cdnEnabled) {
      const reason = `Railway وضعیت CDN را تغییر نداد و همچنان ${cdn ? 'روشن' : 'خاموش'} است`
      result.warning = result.warning ? `${result.warning} — ${reason}` : reason
    }
  }

  return result
}

/**
 * Deployable panel catalog — the single source of truth for the panel the app
 * installs on Railway, Render.com and a Docker VPS.
 *
 * Both the Worker (worker/railway.ts, worker/render.ts, worker/panel-deploy.ts,
 * worker/telegram-ui.ts) and the frontend (DeployWizard, vps-deploy.ts) import
 * this module, so the list below is exactly what every part of the app offers —
 * the Telegram deployer, the web wizard and the generated ZIP packages can never
 * disagree about what "the panel" is.
 *
 * The catalog now holds **one** entry: our own panel (NEXUS / Mizetusi). Third-
 * party panels were removed on the owner's request — see REMOVED_PANELS for what
 * was dropped and why, so the decision stays auditable. The Cloudflare *worker*
 * sources are a separate catalog (shared/worker-sources.ts) and are unaffected.
 *
 * Only public, non-secret metadata lives here. Credentials (admin password,
 * secret key) are always generated at deploy time and never stored in this file.
 *
 * LIVENESS RULE: every entry carries `lastCommit` + `verifiedAt` — the date of
 * the newest upstream commit and the date we checked it against the live repo.
 */

export type PanelRuntime = 'docker' | 'python'
export type DeployTarget = 'railway' | 'render' | 'vps'
/** Community a project comes from — shown as a flag in the pickers. */
export type PanelOrigin = 'ir' | 'cn' | 'ru' | 'intl'

/** Environment-variable names a panel understands on the host. */
export interface PanelEnvNames {
  /** Dashboard admin password. */
  adminPassword?: string
  /** Session/signing secret. */
  secretKey?: string
  /** HTTP port to bind. */
  port?: string
  /** Persistent data directory. */
  dataDir?: string
  /** Public domain variable (set by the platform when available). */
  publicDomain?: string
  /** PostgreSQL connection string (panels that need a database). */
  dbUrl?: string
  /** Redis connection string. */
  redisUrl?: string
  /** Redis host name. */
  redisHost?: string
  /** Host adapter name used by the panel (for example NEXUS_PLATFORM). */
  platform?: string
  /** Runtime engine master switch (for example XRAY_ENABLED). */
  engineEnabled?: string
  /** Optional WARP master switch (for example WARP_ENABLED). */
  warpEnabled?: string
  /** Railway project token consumed by the panel's TCP-proxy manager. */
  railwayToken?: string
  /** Explicit HTTP port used when Railway's injected PORT names a raw transport. */
  httpPort?: string
  /** Direct endpoint host/port for VPS-style deployments. */
  directHost?: string
  directPort?: string
}

/** One raw-TCP capability and the port its listener binds inside the container. */
export interface PanelTcpPort {
  port: number
  label: string
}

/**
 * A switch the deployer flips on the panel itself after the first live poll.
 * `key` is the dotted path inside the panel's save payload
 * (`{ mtproto: { enabled: '1' } }`, `{ webproxy: { 'web-http': … } }`).
 */
export interface PanelCapability {
  key: string
  label: string
}

export interface PanelSpec {
  /** Stable id passed through the API (`worker_source` / `panel`). */
  id: string
  /** Display name. */
  name: string
  /** One-line description shown in the pickers. */
  tagline: string
  /** GitHub repository in `owner/name` form. */
  repo: string
  /** Full repository URL. */
  url: string
  /**
   * Branch the deployers build from *and* the branch the version check reads.
   * Keeping it in the catalog means "the latest version" is one definition for
   * the Railway deploy, the Render blueprint and the upstream-version probe.
   */
  defaultBranch?: string
  /** docker = container image; python = plain Python app. */
  runtime: PanelRuntime
  /** Port the panel listens on. */
  port: number
  /** Extra container ports (e.g. a separate subscription port). */
  extraPorts?: number[]
  /**
   * The raw-TCP capabilities that need a published port of their own, with the
   * label the dashboard shows. Railway gives each one a random public port
   * (TCP proxy), a VPS publishes the same numbers directly — so this list is
   * what every deploy path iterates, never a single "first extra port".
   */
  tcpPorts?: PanelTcpPort[]
  /**
   * Panel-side switches this deployer turns on itself once the panel answers
   * (see `key`: the path inside the panel's own save API). They are the
   * listeners behind {@link PanelSpec.tcpPorts} — without them a published port
   * forwards to a socket nothing ever binds.
   */
  capabilities?: PanelCapability[]
  /** UDP container ports (e.g. WireGuard 51820/udp). */
  udpPorts?: number[]
  /** Whether the project ships a Dockerfile we can build from source. */
  hasDockerfile?: boolean
  /** Published container image — preferred over building from source. */
  dockerImage?: string
  /** Panel needs a PostgreSQL sidecar (the generated compose adds one). */
  requiresDb?: 'postgres'
  /** Panel needs a Redis sidecar. */
  requiresRedis?: boolean
  /** Container path that must persist between restarts. */
  dataVolume?: string
  /**
   * State file the panel expects *inside* that path (SQLite database). Panels
   * read this from an env var, and handing them the directory itself makes
   * sqlite3 fail with "unable to open database file" — so the file is declared
   * here rather than re-derived at every deploy path.
   */
  dataFile?: string
  /** Linux capabilities the container needs (e.g. NET_ADMIN for Fail2ban). */
  capAdd?: string[]
  /** Extra read-only host mounts (e.g. /lib/modules for WireGuard). */
  extraVolumes?: string[]
  /** Kernel settings the container requires. */
  sysctls?: string[]
  /** Some panels (s-ui) refuse to run without a TTY. */
  tty?: boolean
  /** Path to the Dockerfile inside the repo (docker runtime only). */
  dockerfilePath?: string
  /** Build command for non-Docker runtimes. */
  buildCommand?: string
  /** Start command for non-Docker runtimes. */
  startCommand?: string
  /** Dashboard/login path used for links and health checks. */
  panelPath: string
  /** Health-check path (defaults to panelPath). */
  healthPath?: string
  /** Env-var names to set on the host. */
  env: PanelEnvNames
  /** Optional post-deploy admin bootstrap endpoint on the panel itself. */
  setupPath?: string
  /** Targets this panel supports. */
  targets: DeployTarget[]
  /** Installs xray-core inside generated VPS images (proxy panels only). */
  needsXray?: boolean
  /** Documented default admin password, shown as a hint to the user. */
  defaultAdminPassword?: string
  /** Community this project comes from. */
  origin?: PanelOrigin
  /** Requirements / caveats shown in the picker and generated README. */
  notes?: string
  /** ISO date of the newest upstream commit we verified. */
  lastCommit?: string
  /** ISO date this entry was verified against the live repository. */
  verifiedAt?: string
}

/** Flag + label for each community. */
export const PANEL_ORIGIN: Record<PanelOrigin, { flag: string; label: string }> = {
  ir: { flag: '🇮🇷', label: 'ایران' },
  cn: { flag: '🇨🇳', label: 'چین' },
  ru: { flag: '🇷🇺', label: 'روسیه' },
  intl: { flag: '🌍', label: 'بین‌المللی' },
}

export const PANELS: PanelSpec[] = [
  {
    id: 'mizetusi',
    name: 'پنل اختصاصی ما',
    tagline:
      'NEXUS (Mizetusi) — کنترل‌سنتر FastAPI + Xray با ماتریس کامل ترانسپورت (VLESS/VMess/Trojan/Shadowsocks/Reality) و پل ورکر کلودفلر',
    repo: 'miladjahani/Mizetusi',
    url: 'https://github.com/miladjahani/Mizetusi',
    defaultBranch: 'main',
    runtime: 'docker',
    port: 8080,
    // Every raw-TCP capability, in the order a client should try them. On a VPS
    // these numbers are the public ports; on Railway each one needs a TCP proxy
    // (its public port is random), and Render publishes HTTPS only — so the
    // list is the single source of truth both paths iterate.
    extraPorts: [8443, 8446, 8448],
    tcpPorts: [
      { port: 8443, label: 'Reality (مسیر مستقیم)' },
      { port: 8446, label: 'MTProto' },
      { port: 8448, label: 'وب‌پروکسی HTTP' },
    ],
    // The listeners behind those ports are off in a fresh panel by design; the
    // deployer owns the decision, so it switches them on right after the panel
    // first answers, and the published ports stop pointing at nothing.
    capabilities: [
      { key: 'mtproto', label: 'پروکسی MTProto' },
      { key: 'webproxy.web-http', label: 'وب‌پروکسی HTTP' },
    ],
    hasDockerfile: true,
    dockerfilePath: 'Dockerfile',
    panelPath: '/login',
    healthPath: '/health',
    env: {
      adminPassword: 'ADMIN_PASSWORD',
      secretKey: 'JWT_SECRET',
      port: 'PORT',
      dataDir: 'SQLITE_PATH',
      publicDomain: 'PUBLIC_BASE_URL',
      platform: 'NEXUS_PLATFORM',
      engineEnabled: 'XRAY_ENABLED',
      warpEnabled: 'WARP_ENABLED',
      railwayToken: 'NEXUS_RAILWAY_TOKEN',
      httpPort: 'NEXUS_HTTP_PORT',
      directHost: 'NEXUS_DIRECT_HOST',
      directPort: 'NEXUS_DIRECT_PORT',
    },
    targets: ['railway', 'render', 'vps'],
    // The image builds xray-core from the official xtls image itself, so nothing
    // has to be installed on the host.
    needsXray: false,
    // No `defaultAdminPassword` on purpose: the deployer then generates a strong
    // password per deployment and shows it once, instead of shipping the panel's
    // own `admin/admin` default. The upstream default is documented in `notes`.
    origin: 'ir',
    dataVolume: '/data',
    // Exactly what the panel's own docker-compose.yml / render.yaml set, and
    // what app/db.py falls back to when the variable is absent.
    dataFile: '/data/nexus.db',
    capAdd: ['NET_ADMIN'],
    notes:
      'رمز ادمین هنگام استقرار ساخته و یک‌بار نمایش داده می‌شود (پیش‌فرض خودِ پنل admin/admin است — همان اول عوضش کنید). دیتابیس SQLite در /data است، پس روی Railway/Render یک Volume روی /data بگذارید وگرنه با هر ری‌دیپلوی پاک می‌شود. سه پورت خام ۸۴۴۳ (Reality)، ۸۴۴۶ (MTProto) و ۸۴۴۸ (وب‌پروکسی HTTP) منتشر می‌شوند: روی VPS همین شماره‌ها عمومی‌اند و روی Railway هرکدام یک TCP Proxy با پورت تصادفی می‌گیرند که در کارت پنل نمایش داده می‌شود. سوییچ MTProto و وب‌پروکسی HTTP خودکار روشن می‌شوند. روی Render فقط پورت HTTPS منتشر می‌شود، پس این سه پورت آنجا در دسترس نیستند. CAP NET_ADMIN فقط برای خروج اختیاری WARP در compose تنظیم شده است.',
    lastCommit: '2026-09-25',
    verifiedAt: '2026-09-25',
  },
]

export const DEFAULT_PANEL_ID = PANELS[0].id

/**
 * Panels that were in this catalog and were **removed on the owner's request**:
 * the app now ships a single, first-party panel. They are recorded here (instead
 * of being silently deleted) so the removal is auditable and reversible, and so
 * nobody later re-adds one believing it was never considered.
 *
 * The Cloudflare worker sources (shared/worker-sources.ts) are unaffected.
 */
export const REMOVED_PANELS: Array<{ id: string; name: string; repo: string; reason: string }> = [
  { id: 'stanngv2', name: 'StanNG v2', repo: 'youdidking/stanngv2', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'pxpanel', name: 'PXPANEL', repo: 'iran-px-panel/pxpanel', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: '3xui', name: '3X-UI', repo: 'MHSanaei/3x-ui', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'sui', name: 'S-UI', repo: 'alireza0/s-ui', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'pasarguard', name: 'PasarGuard', repo: 'PasarGuard/panel', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'luffy', name: 'Luffy Panel', repo: 'luffy-sh-op/LUFFY_PANEL', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'wgeasy', name: 'WG-Easy', repo: 'wg-easy/wg-easy', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
  { id: 'remnawave', name: 'Remnawave', repo: 'remnawave/backend', reason: 'پنل شخص ثالث — به درخواست مالک حذف شد' },
]

/**
 * Repositories we checked and deliberately did NOT add — kept here so the
 * decision is auditable instead of silently forgotten.
 *
 * - Gozargah/Marzban      → آخرین کامیت ۲۰۲۵-۰۱-۰۹ (غیرفعال) — جانشینش PasarGuard است
 * - 3Kmfi6HP/EDtunnel     → مخزن اصلی دیگر در دسترس نیست (۴۰۴)
 * - zizifn/edgetunnel     → آخرین کامیت ۲۰۲۴-۱۱-۲۷ (راکد)
 * - Misaka-blog/cf-wkrs-pages-vless → آخرین کامیت ۲۰۲۴-۰۴-۲۳ (راکد)
 * - yonggekkk/argosbx     → فایل ورکر در مخزن فقط یک استاب است (از طریق اسکریپت خودش منتشر می‌شود)
 */
export const EXCLUDED_REPOS: Array<{ repo: string; reason: string }> = [
  // Brand names users asked about that have no verifiable public repository —
  // they are sold/distributed through Telegram channels and resellers, so we
  // cannot check liveness or wire them into the automated deployer.
  { repo: 'SLV panel', reason: 'مخزن عمومی قابل‌تأییدی ندارد (از طریق تلگرام/نمایندگی توزیع می‌شود)' },
  { repo: 'RVG panel', reason: 'مخزن عمومی ندارد؛ فقط به‌عنوان سبک کانفیگ (RVG style) در چند پروژه ارجاع داده شده' },
  { repo: 'loofi panel', reason: 'در گیت‌هاب فقط پروژه‌های هم‌نام و بی‌ربط پیدا شد (no verifiable repo)' },
  { repo: 'sanayii panel', reason: 'مخزن عمومی ندارد؛ در گفتگوی 3x-ui به‌عنوان پنل تجاری فارسی نام برده شده' },
  { repo: 'solgx', reason: 'هیچ مخزن مرتبطی در گیت‌هاب پیدا نشد (0 نتیجه)' },
  { repo: 'freedomnet25500/new-worker-panel', reason: 'آخرین کامیت ۲۰۲۴-۰۶-۰۱ — راکد' },
  { repo: 'x4gKing/Vless-Panel', reason: 'مخزن در دسترس نیست (404)' },
  { repo: 'Gozargah/Marzban', reason: 'آخرین کامیت ۲۰۲۵-۰۱-۰۹ — غیرفعال (جانشین: PasarGuard)' },
  { repo: '3Kmfi6HP/EDtunnel', reason: 'مخزن در دسترس نیست (404)' },
  { repo: 'zizifn/edgetunnel', reason: 'آخرین کامیت ۲۰۲۴-۱۱-۲۷ — راکد' },
  { repo: 'Misaka-blog/cf-wkrs-pages-vless', reason: 'آخرین کامیت ۲۰۲۴-۰۴-۲۳ — راکد' },
  { repo: 'yonggekkk/argosbx', reason: 'فایل ورکر در مخزن استاب است' },
]

/** Resolve a panel id (unknown/empty → the default panel). */
export function resolvePanel(id?: string | null): PanelSpec {
  return PANELS.find((p) => p.id === id) ?? PANELS[0]
}

/** Panels that can be deployed to a given target. */
export function panelsForTarget(target: DeployTarget): PanelSpec[] {
  return PANELS.filter((p) => p.targets.includes(target))
}

/** Flag + community label for a panel. */
export function panelOriginLabel(panel: PanelSpec): string {
  const origin = panel.origin ? PANEL_ORIGIN[panel.origin] : undefined
  return origin ? `${origin.flag} ${origin.label}` : ''
}

/** Full clone URL used inside generated Dockerfiles / deploy scripts. */
/** Container directory a panel's state lives in (never the file itself). */
export function panelDataDir(panel: PanelSpec): string {
  return panel.dataVolume ?? '/data'
}

/**
 * The state *file* a panel should be pointed at, inside {@link panelDataDir}.
 * Panel env vars take a file path — giving sqlite3 a directory is a boot crash.
 */
export function panelDataFile(panel: PanelSpec): string {
  return panel.dataFile ?? `${panelDataDir(panel)}/panel.db`
}

export function panelRepoUrl(panel: PanelSpec): string {
  return `https://github.com/${panel.repo}.git`
}

/**
 * Every raw-TCP capability a deploy path has to publish, with its label.
 * Panels that only declared bare `extraPorts` still get one entry each, so an
 * older catalog entry cannot silently lose its Reality port.
 */
export function panelTcpPorts(panel: PanelSpec): PanelTcpPort[] {
  if (panel.tcpPorts?.length) return panel.tcpPorts
  return (panel.extraPorts ?? []).map((port) => ({ port, label: `TCP ${port}` }))
}

/** Branch the deployers build and the version check reads (`main` by default). */
export function panelBranch(panel: PanelSpec): string {
  return panel.defaultBranch ?? 'main'
}

/**
 * Railway region every panel deploys to unless the caller asks otherwise.
 *
 * `europe-west4` is Railway's **Amsterdam / Netherlands** region, which is what
 * the owner requires for panels (better latency for the Middle East audience).
 * It is the single default used by the bot, the web wizard and the API, so no
 * deploy path can silently fall back to the US.
 */
export const DEFAULT_RAILWAY_REGION = 'europe-west4'

/** One selectable Railway deployment region. */
export interface RailwayRegion {
  /** Region code accepted by `serviceInstanceUpdate.input.region`. */
  id: string
  /** Persian label shown in the pickers. */
  label: string
  /** Country/area, for the secondary line. */
  area: string
}

/**
 * Every region Railway offers today.
 *
 * Sourced from Railway's public "Regions" reference (US West, US East, EU West
 * and Southeast Asia). The owner wants Netherlands by default and the rest
 * selectable per deployment, so this list is the one place both the bot and the
 * web app read the choices from.
 */
export const RAILWAY_REGIONS: RailwayRegion[] = [
  { id: 'europe-west4', label: 'هلند (آمستردام)', area: 'اروپای غربی' },
  { id: 'us-west2', label: 'آمریکا (کالیفرنیا)', area: 'غرب آمریکا' },
  { id: 'us-east4', label: 'آمریکا (ویرجینیا)', area: 'شرق آمریکا' },
  { id: 'asia-southeast1', label: 'سنگاپور', area: 'جنوب‌شرق آسیا' },
]

/**
 * Labels for the region codes Railway may return or store — including the
 * suffixed "metal" identifiers used by multi-region config, so a record written
 * by the dashboard still renders with a friendly name.
 */
export const RAILWAY_REGION_LABELS: Record<string, string> = {
  'europe-west4': 'هلند (آمستردام)',
  'europe-west4-drams3a': 'هلند (آمستردام)',
  'us-west2': 'آمریکا (کالیفرنیا)',
  'us-west1': 'آمریکا (اورگان)',
  'us-east4': 'آمریکا (ویرجینیا)',
  'us-east4-eqdc4a': 'آمریکا (ویرجینیا)',
  'asia-southeast1': 'سنگاپور',
  'asia-southeast1-eqsg3a': 'سنگاپور',
}

/** Human label for a Railway region code (falls back to the raw code). */
export function railwayRegionLabel(region?: string | null): string {
  if (!region) return RAILWAY_REGION_LABELS[DEFAULT_RAILWAY_REGION]
  return RAILWAY_REGION_LABELS[region] ?? region
}

/** Is this a region code we offer? (Keeps a bad request away from Railway.) */
export function isRailwayRegion(region: string): boolean {
  return RAILWAY_REGIONS.some((r) => r.id === region)
}

/** Generated and user-specific values used to build a deployment manifest. */
export interface PanelDeploySecrets {
  adminPassword: string
  secretKey: string
  /** Railway project token, created once after the project/environment exist. */
  railwayToken?: string
  /** Public HTTPS origin, when the platform has generated it already. */
  publicBaseUrl?: string
  /** Direct host exposed by a VPS deployment, if the user supplied one. */
  directHost?: string
}

export interface PanelDeployEnvEntry {
  name: string
  value: string
  /** Never include the value in an API response or generated README. */
  secret: boolean
}

/**
 * Complete deploy-time environment for a panel.
 *
 * Every automated and generated deployment path consumes this function, so the
 * Railway, Render and VPS flows cannot silently drift apart. Static switches are
 * derived from the catalog; passwords, signing keys, state paths and platform
 * tokens are filled from the per-deploy values.
 */
export function buildPanelDeployEnv(
  panel: PanelSpec,
  platform: DeployTarget,
  values: PanelDeploySecrets,
): PanelDeployEnvEntry[] {
  const entries: PanelDeployEnvEntry[] = []
  const add = (name: string | undefined, value: string | undefined, secret = false) => {
    if (name && value !== undefined) entries.push({ name, value, secret })
  }

  add(panel.env.adminPassword, values.adminPassword, true)
  add(panel.env.secretKey, values.secretKey, true)
  add(panel.env.dataDir, panelDataFile(panel))
  add(panel.env.platform, platform)
  add(panel.env.engineEnabled, 'true')
  add(panel.env.warpEnabled, 'false')

  if (platform === 'railway') {
    // A TCP proxy makes Railway inject the proxy target as PORT. Pin both names to
    // the HTTP edge so uvicorn and Xray never contend for the same listener.
    add(panel.env.port, String(panel.port))
    add(panel.env.httpPort, String(panel.port))
    add(panel.env.publicDomain, values.publicBaseUrl)
    add(panel.env.railwayToken, values.railwayToken, true)
  } else if (platform === 'render') {
    // Render injects PORT and RENDER_EXTERNAL_URL itself.
    add(panel.env.publicDomain, values.publicBaseUrl)
  } else {
    add(panel.env.port, String(panel.port))
    add(panel.env.publicDomain, values.publicBaseUrl)
    add(panel.env.directHost, values.directHost ?? '')
    add(panel.env.directPort, panel.extraPorts?.[0] ? String(panel.extraPorts[0]) : '')
  }

  return entries
}

/** Verified-liveness badge text, e.g. "بررسی‌شده ۲۰۲۶-۰۹-۱۲". */
export function panelVerifiedLabel(panel: PanelSpec): string {
  return panel.verifiedAt ? `بررسی‌شده ${panel.verifiedAt}` : ''
}

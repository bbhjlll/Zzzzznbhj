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
  /** docker = container image; python = plain Python app. */
  runtime: PanelRuntime
  /** Port the panel listens on. */
  port: number
  /** Extra container ports (e.g. a separate subscription port). */
  extraPorts?: number[]
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
    runtime: 'docker',
    port: 8080,
    // 8443 carries the raw-TCP Reality inbound; it is only publishable on a host
    // with a real TCP port (VPS), so Railway/Render simply skip it.
    extraPorts: [8443],
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
      'رمز ادمین هنگام استقرار ساخته و یک‌بار نمایش داده می‌شود (پیش‌فرض خودِ پنل admin/admin است — همان اول عوضش کنید). دیتابیس SQLite در /data است، پس روی Railway/Render یک Volume روی /data بگذارید وگرنه با هر ری‌دیپلوی پاک می‌شود. Reality فقط وقتی منتشر می‌شود که هاست یک پورت TCP واقعی داشته باشد (VPS: 8443، یا TCP Proxy ریلوی). CAP NET_ADMIN فقط برای خروج اختیاری WARP در compose تنظیم شده است.',
    lastCommit: '2026-09-21',
    verifiedAt: '2026-09-21',
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

/** Verified-liveness badge text, e.g. "بررسی‌شده ۲۰۲۶-۰۹-۱۲". */
export function panelVerifiedLabel(panel: PanelSpec): string {
  return panel.verifiedAt ? `بررسی‌شده ${panel.verifiedAt}` : ''
}

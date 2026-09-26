export interface CFToken {
  id: string
  name: string
  token: string
  status: 'active' | 'inactive'
  last_used_at: string | null
  created_at: string
}

export interface RailwayToken {
  id: string
  name: string
  status: 'active' | 'inactive'
  account_name: string | null
  token_tail: string
  last_used_at: string | null
  created_at: string
}

export interface RenderToken {
  id: string
  name: string
  status: 'active' | 'inactive'
  account_name: string | null
  token_tail: string
  last_used_at: string | null
  created_at: string
}

export interface Deployment {
  id: string
  name: string
  worker_code: string
  config: Record<string, unknown>
  status: 'pending' | 'deploying' | 'deployed' | 'failed'
  logs?: string | null
  worker_url: string | null
  route: string | null
  error_message: string | null
  uuid: string | null
  custom_path: string | null
  custom_domain: string | null
  kv_namespace_id: string | null
  panel_url: string | null
  method: 'workers' | 'pages'
  cf_account_id: string | null
  created_at: string
  updated_at: string
}

export interface BotUser {
  id: string
  telegram_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  /** Access is open to everyone; the owner can only block a user. */
  is_active: boolean
  /** Legacy column from the old gate model — the deployer bot has no admins. */
  is_admin: boolean
  created_at: string
  last_activity: string | null
}

export interface ActivityLog {
  id: string
  action: string
  entity_type: string
  entity_name: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export interface BotConfig {
  id: string
  bot_token: string
  bot_username: string | null
  webhook_url: string | null
  is_active: boolean
  welcome_message: string
  /** Legacy column from the owner-claim flow; the public bot does not use it. */
  chat_id: string | null
  /** Legacy column from the owner-claim flow; the public bot does not use it. */
  claim_code: string | null
  created_at: string
  updated_at: string
}

export interface OptimizerJob {
  id: string
  name: string
  status: 'pending' | 'running' | 'done' | 'failed'
  nodes_total: number
  nodes_alive: number
  sub_token: string
  error_message: string | null
  result_nodes?: OptimizerNode[]
  created_at: string
  updated_at: string
}

export interface OptimizerNode {
  name: string
  proto: string
  host: string
  port: number
  latencyMs: number
}

export interface SubGroup {
  id: string
  name: string
  deployment_ids: string[]
  sub_token: string
  ips?: PreferredIP[]
  proxies?: ProxySpec[]
  inject?: boolean
  format?: string
  extra_links?: string[]
  created_at: string
}

export interface AdminUser {
  id: string
  email: string
  role: 'admin' | 'user'
  max_deployments: number
  deployments: number
  created_at: string
}

export interface ScanResultItem {
  ip: string
  port?: number
  latencyMs: number | null
  status: 'ok' | 'timeout' | 'error'
  region?: string
  source?: string
}

export interface PreferredIP { ip: string; port?: number }

export interface ProxySpec {
  type: 'http' | 'socks5'
  server: string
  port: number
  username?: string
  password?: string
}

export interface InjectedSub {
  id: string
  name: string
  ips: PreferredIP[]
  proxies: ProxySpec[]
  sub_token: string
  created_at: string
}

export interface CountryLocationConfig {
  location: string
  proxy: string
}

export interface MemberSettings {
  countries: string[]
  country_locations?: Record<string, CountryLocationConfig[]>
  custom_ips: string[]
  transport: '' | 'ws' | 'grpc' | 'httpupgrade'
  fragment: boolean
  fragment_preset?: string
  fragment_config: { packets?: string; length?: string; interval?: string; fm?: string; cs?: string }
  fingerprint?: string
  custom_sni?: string
  custom_host?: string
  bypass_sanctions: boolean
  sanctions_mode?: '' | 'sni' | 'warp'
  ip_rotation_minutes?: number
  proxyip?: string
  chain_proxy?: string
  ech?: boolean
  ech_sni?: string
  ech_dns?: string
  ed_0rtt?: boolean
  random_path?: boolean
  fragment_client?: string
  max_nodes_per_location?: number
}

export interface WorkerMember {
  id: string
  deployment_id: string
  name: string
  token: string
  enabled: boolean
  expires_at: string | null
  quota_bytes: number | null
  used_bytes: number
  used_gb: number
  quota_gb: number | null
  used_requests: number
  request_quota: number | null
  ip_limit: number | null
  active_devices: number
  start_on_connect?: boolean
  activated_at?: string | null
  reset_period_days?: number | null
  last_reset_at?: string | null
  usage_updated_at: string | null
  settings: MemberSettings
  created_at: string
}

// ── Hosted panel (the dedicated catalog panel) ──────────────────────────────

/** Static spec of the panel this installation deploys, straight from the API. */
export interface HostedPanelSpec {
  id: string
  name: string
  tagline: string
  repo: string
  repoUrl: string
  port: number
  extraPorts: number[]
  /** Raw-TCP capabilities this panel publishes, with their labels. */
  tcpPorts: Array<{ port: number; label: string }>
  panelPath: string
  healthPath: string
  origin: string | null
  targets: string[]
  dataVolume: string | null
  notes: string | null
  lastCommit: string | null
  verifiedAt: string | null
}

/** One deployment of that panel on Railway or Render. */
export interface HostedPanelDeploy {
  platform: 'railway' | 'render'
  id: string
  name: string | null
  panel: string
  panelName: string
  panelPath: string
  healthPath: string
  domain: string | null
  url: string | null
  panelUrl: string | null
  adminUsername: string | null
  adminPassword: string | null
  setupDone: boolean
  dashboardUrl: string | null
  currentDeploymentId: string | null
  branch: string | null
  commitSha: string | null
  commitUrl: string | null
  autoDeploy: boolean
  tcpProxy: { domain: string; port: number; applicationPort: number } | null
  /** Every published raw-TCP capability (Reality, MTProto, HTTP …). */
  tcpProxies: Array<{ label: string; domain: string; port: number; applicationPort: number }>
  tcpProxyError: string | null
  createdAt: string | null
  /** Rebuilds itself from the newest upstream commit on its own. */
  autoUpdate: boolean
  /** Upstream revision the last update pointed this deployment at. */
  lastVersion: string | null
  /** When the last update/rebuild was triggered (ISO), null if never. */
  lastUpdatedAt: string | null
}

/** Newest upstream commit of the panel's repository (from `GET /panels`). */
export interface PanelVersion {
  sha: string
  short: string
  date: string | null
  message: string | null
  url: string
}

export interface HostedPanelOverview {
  panel: HostedPanelSpec
  deploys: HostedPanelDeploy[]
  /** Best-effort upstream revision; null when GitHub was unreachable. */
  latestVersion: PanelVersion | null
}

/** Result of `POST /panels/update` — the deployment is rebuilt on the latest commit. */
export interface HostedPanelUpdate {
  platform: 'railway' | 'render'
  /** Row id after the update (the new platform deployment id). */
  id: string
  version: PanelVersion | null
  /** True when it was already on the newest revision before this rebuild. */
  alreadyLatest: boolean
}

/** Result of polling one hosted panel (`POST /panels/watch`). */
export interface HostedPanelWatch {
  state: 'pending' | 'failed' | 'live'
  status: string
  url: string | null
  panelPath?: string
  panelName?: string
  adminUsername?: string | null
  adminPassword?: string | null
  firstLive?: boolean
  /** Why a raw-TCP capability could not be switched on inside the panel. */
  capabilitiesError?: string | null
}

/** Result of the edge health probe (`POST /panels/health`). */
export interface HostedPanelHealth {
  ok: boolean
  status: number | null
  ms: number
  url: string | null
  error?: string
}

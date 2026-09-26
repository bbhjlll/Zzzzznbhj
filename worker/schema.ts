import type { Env } from './env'

// Idempotent schema bootstrap — runs once per isolate on the first request,
// so a freshly-created empty D1 database works with zero manual migration
// steps (Cloudflare Builds just deploys and everything self-initializes).
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cf_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS render_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    account_name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS railway_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    account_name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS railway_deploys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    current_deployment_id TEXT,
    region TEXT NOT NULL DEFAULT 'us-west2',
    domain TEXT,
    branch TEXT NOT NULL DEFAULT 'main',
    commit_sha TEXT,
    commit_url TEXT,
    project_token TEXT,
    tcp_proxy_id TEXT,
    tcp_proxy_domain TEXT,
    tcp_proxy_port INTEGER,
    tcp_proxy_application_port INTEGER,
    tcp_proxy_error TEXT,
    tcp_proxies TEXT,
    auto_deploy INTEGER NOT NULL DEFAULT 1,
    name TEXT,
    panel TEXT,
    admin_username TEXT,
    admin_password TEXT,
    setup_done INTEGER NOT NULL DEFAULT 0,
    auto_update INTEGER NOT NULL DEFAULT 0,
    last_version TEXT,
    last_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS render_deploys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    name TEXT,
    panel TEXT,
    url TEXT,
    admin_username TEXT,
    admin_password TEXT,
    setup_done INTEGER NOT NULL DEFAULT 0,
    auto_update INTEGER NOT NULL DEFAULT 0,
    last_version TEXT,
    last_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    worker_code TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deploying','deployed','failed')),
    worker_url TEXT,
    route TEXT,
    error_message TEXT,
    logs TEXT,
    uuid TEXT,
    custom_path TEXT,
    custom_domain TEXT,
    kv_namespace_id TEXT,
    panel_url TEXT,
    method TEXT NOT NULL DEFAULT 'workers' CHECK (method IN ('workers','pages')),
    worker_source TEXT NOT NULL DEFAULT 'edgetunnel',
    cf_account_id TEXT,
    cf_token_row_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bot_config (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    bot_token TEXT NOT NULL,
    bot_username TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    welcome_message TEXT NOT NULL DEFAULT 'سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.',
    claim_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bot_users (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id TEXT NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity TEXT,
    UNIQUE (user_id, telegram_id)
  )`,
  `CREATE TABLE IF NOT EXISTS activity_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'general',
    entity_name TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS optimizer_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
    result_nodes TEXT NOT NULL DEFAULT '[]',
    result_sub TEXT NOT NULL DEFAULT '',
    sub_token TEXT NOT NULL UNIQUE,
    nodes_total INTEGER NOT NULL DEFAULT 0,
    nodes_alive INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sub_groups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    deployment_ids TEXT NOT NULL DEFAULT '[]',
    sub_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS injector_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    ips TEXT NOT NULL DEFAULT '[]',
    proxies TEXT NOT NULL DEFAULT '[]',
    sub_token TEXT NOT NULL UNIQUE,
    rotate_minutes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS worker_members (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    quota_bytes INTEGER,
    request_quota INTEGER,
    ip_limit INTEGER,
    used_bytes INTEGER NOT NULL DEFAULT 0,
    used_requests INTEGER NOT NULL DEFAULT 0,
    recent_ips TEXT NOT NULL DEFAULT '[]',
    start_on_connect INTEGER NOT NULL DEFAULT 0,
    activated_at TEXT,
    reset_period_days INTEGER,
    last_reset_at TEXT,
    usage_updated_at TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_cf_tokens_user ON cf_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_railway_tokens_user ON railway_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_railway_deploys_user ON railway_deploys(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_render_tokens_user ON render_tokens(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_render_deploys_user ON render_deploys(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status)`,
  `CREATE TABLE IF NOT EXISTS bot_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    telegram_id TEXT NOT NULL,
    state TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS bot_tenants (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bot_users_user ON bot_users(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_tenants_token ON bot_tenants(access_token)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_sessions_user ON bot_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_optimizer_jobs_user ON optimizer_jobs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_groups_user ON sub_groups(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_members_owner ON worker_members(owner_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_worker_members_dep ON worker_members(deployment_id)`,
]

// Column additions for databases created before these fields existed.
// Each ALTER fails harmlessly when the column is already present.
const MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`,
  `ALTER TABLE users ADD COLUMN max_deployments INTEGER NOT NULL DEFAULT 100`,
  `ALTER TABLE bot_config ADD COLUMN chat_id TEXT`,
  `ALTER TABLE bot_config ADD COLUMN webhook_secret TEXT`,
  // One-time code the owner sends as `/start <code>` to claim the bot. Rows
  // created before it existed stay NULL and fall back to the legacy
  // "first /start claims the bot" rule, so nobody gets locked out.
  `ALTER TABLE bot_config ADD COLUMN claim_code TEXT`,
  `ALTER TABLE sub_groups ADD COLUMN ips TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE sub_groups ADD COLUMN proxies TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE sub_groups ADD COLUMN inject INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE sub_groups ADD COLUMN format TEXT NOT NULL DEFAULT 'base64'`,
  `ALTER TABLE sub_groups ADD COLUMN extra_links TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE deployments ADD COLUMN cf_token_row_id TEXT`,
  `ALTER TABLE worker_members ADD COLUMN request_quota INTEGER`,
  `ALTER TABLE worker_members ADD COLUMN used_requests INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worker_members ADD COLUMN ip_limit INTEGER`,
  `ALTER TABLE worker_members ADD COLUMN recent_ips TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE worker_members ADD COLUMN start_on_connect INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE worker_members ADD COLUMN activated_at TEXT`,
  `ALTER TABLE worker_members ADD COLUMN reset_period_days INTEGER`,
  `ALTER TABLE worker_members ADD COLUMN last_reset_at TEXT`,
  `ALTER TABLE worker_members ADD COLUMN notified_level INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE injector_jobs ADD COLUMN rotate_minutes INTEGER`,
  `ALTER TABLE optimizer_jobs ADD COLUMN opt_options TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN panel TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN name TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN current_deployment_id TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN branch TEXT NOT NULL DEFAULT 'main'`,
  `ALTER TABLE railway_deploys ADD COLUMN commit_sha TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN commit_url TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN project_token TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxy_id TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxy_domain TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxy_port INTEGER`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxy_application_port INTEGER`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxy_error TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN tcp_proxies TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 1`,
  // Latest-version tracking for the dedicated panel (see panel-deploy.ts):
  // `auto_update` opts a deployment into the scheduled sweep and `last_version`
  // remembers the upstream revision it was last updated to.
  `ALTER TABLE railway_deploys ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE railway_deploys ADD COLUMN last_version TEXT`,
  `ALTER TABLE railway_deploys ADD COLUMN last_updated_at TEXT`,
  `ALTER TABLE render_deploys ADD COLUMN auto_update INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE render_deploys ADD COLUMN last_version TEXT`,
  `ALTER TABLE render_deploys ADD COLUMN last_updated_at TEXT`,
]

let ready: Promise<void> | null = null

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const stmt of SCHEMA_STATEMENTS) {
        await env.DB.prepare(stmt).run()
      }
      for (const stmt of MIGRATIONS) {
        await env.DB.prepare(stmt).run().catch(() => null)
      }
    })().catch((err) => {
      // Allow retry on the next request if bootstrap failed transiently.
      ready = null
      throw err
    })
  }
  return ready
}

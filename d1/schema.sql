-- miliconfig Pro — Cloudflare D1 schema
-- Replaces Supabase (auth + Postgres) entirely.
-- Apply with:  npx wrangler d1 execute miliconfig-pro --remote --file=d1/schema.sql
-- (local dev:  npx wrangler d1 execute miliconfig-pro --local --file=d1/schema.sql)

-- Panel accounts (replaces Supabase auth.users)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,           -- pbkdf2$iterations$saltB64$hashB64
  role TEXT NOT NULL DEFAULT 'user',     -- first account becomes 'admin'
  max_deployments INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bearer session tokens (replaces Supabase sessions)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- Cloudflare API tokens
CREATE TABLE IF NOT EXISTS cf_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Render.com API keys (StanNG auto-deploy)
CREATE TABLE IF NOT EXISTS render_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  account_name TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Railway account tokens (StanNG auto-deploy)
CREATE TABLE IF NOT EXISTS railway_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  account_name TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- In-flight StanNG auto-deploys on Railway (region, domain, one-time admin creds)
CREATE TABLE IF NOT EXISTS railway_deploys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  current_deployment_id TEXT,
  region TEXT NOT NULL DEFAULT 'europe-west4-drams3a',
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
  -- Latest-version tracking (see worker/panel-deploy.ts): auto_update opts the
  -- deployment into the scheduled "always on the newest release" sweep and
  -- last_version remembers the upstream revision it was updated to.
  auto_update INTEGER NOT NULL DEFAULT 0,
  last_version TEXT,
  last_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Render.com panel deployments
CREATE TABLE IF NOT EXISTS render_deploys (
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
);

-- Worker deployment records
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  worker_code TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',     -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deploying','deployed','failed')),
  worker_url TEXT,
  route TEXT,
  error_message TEXT,
  logs TEXT,
  uuid TEXT,                             -- panel/UUID key used by deployed workers
  custom_path TEXT,
  custom_domain TEXT,
  kv_namespace_id TEXT,
  panel_url TEXT,
  -- Ready-to-use subscription link (source-specific: edgetunnel's /sub?token=…,
  -- CFnew's /<uuid>/sub, empty for zeus). Computed at deploy time so the UI
  -- never has to guess a path that may 404.
  sub_url TEXT,
  method TEXT NOT NULL DEFAULT 'workers' CHECK (method IN ('workers','pages')),
  worker_source TEXT NOT NULL DEFAULT 'edgetunnel',
  cf_account_id TEXT,
  cf_token_row_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram bot settings (one row per account)
CREATE TABLE IF NOT EXISTS bot_config (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bot_token TEXT NOT NULL,
  bot_username TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,                   -- per-bot setWebhook secret_token for exact routing
  is_active INTEGER NOT NULL DEFAULT 1,
  welcome_message TEXT NOT NULL DEFAULT 'سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.',
  chat_id TEXT,                          -- owner chat for push notifications
  claim_code TEXT,                       -- one-time `/start <code>` owner claim code
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Public deployer bot: one row per Telegram user of the bot.
--
-- The bot is a standalone deployment tool: each Telegram user gets their own
-- isolated space (`user_id` points at a synthetic, sign-in-less account) and
-- their own unique access token / deep link (`access_token`). Bot work never
-- touches a real panel account's data.
CREATE TABLE IF NOT EXISTS bot_tenants (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_tenants_token ON bot_tenants(access_token);

-- Telegram bot end-users
CREATE TABLE IF NOT EXISTS bot_users (
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
);

-- Activity audit log
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'general',
  entity_name TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Config optimizer jobs (real TCP-tested optimized subscriptions)
CREATE TABLE IF NOT EXISTS optimizer_jobs (
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
);

-- Group subscriptions (merge several workers into one sub link)
CREATE TABLE IF NOT EXISTS sub_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  deployment_ids TEXT NOT NULL DEFAULT '[]',
  sub_token TEXT NOT NULL UNIQUE,
  ips TEXT NOT NULL DEFAULT '[]',       -- preferred IPs injected at serve time
  proxies TEXT NOT NULL DEFAULT '[]',   -- http/socks5 chains injected at serve time
  inject INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL DEFAULT 'base64',
  extra_links TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Custom injected subscriptions (miliconfig-branded)
CREATE TABLE IF NOT EXISTS injector_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  ips TEXT NOT NULL DEFAULT '[]',
  proxies TEXT NOT NULL DEFAULT '[]',
  sub_token TEXT NOT NULL UNIQUE,
  rotate_minutes INTEGER,
  ech INTEGER NOT NULL DEFAULT 0,
  ech_sni TEXT,
  ech_dns TEXT,
  fragment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_cf_tokens_user ON cf_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_render_tokens_user ON render_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_railway_tokens_user ON railway_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_railway_deploys_user ON railway_deploys(user_id);
CREATE INDEX IF NOT EXISTS idx_render_deploys_user ON render_deploys(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_user ON deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_bot_users_user ON bot_users(user_id);

-- Conversation state for the Telegram bot's multi-step flows (deploy wizard,
-- rename, search, welcome-message edit). One row per user + telegram account.
CREATE TABLE IF NOT EXISTS bot_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_user ON bot_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_optimizer_jobs_user ON optimizer_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_groups_user ON sub_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_injector_jobs_user ON injector_jobs(user_id);

CREATE TABLE IF NOT EXISTS worker_members (
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
  notified_level INTEGER NOT NULL DEFAULT 0,
  usage_updated_at TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_worker_members_owner ON worker_members(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_worker_members_dep ON worker_members(deployment_id);

/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  /**
   * Panel owner, by email. Non-secret config from `[vars]` in wrangler.toml.
   * When set (and that account exists) only this account sees the bot section;
   * otherwise the installation's first account owns it.
   */
  OWNER_EMAIL?: string
}

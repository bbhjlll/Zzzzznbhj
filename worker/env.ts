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
  /**
   * Public URL of the panel UI when it is served from a different domain than
   * this Worker (a static host, GitHub Pages, …). Used for the bot's
   * "باز کردن پنل" menu button and every link back into the app from bot
   * screens. Empty/unset falls back to the Worker's own origin, which is where
   * the SPA ships by default. The Telegram webhook always keeps the Worker
   * origin, since Telegram must reach the Worker and not the CDN.
   */
  PANEL_URL?: string
}

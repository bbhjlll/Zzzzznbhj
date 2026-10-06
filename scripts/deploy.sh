#!/bin/sh
# Cloudflare Builds / manual deploy entrypoint.
#
# Ensures the panel's D1 database exists (creates it on first run), injects the
# real database_id into a generated config, and deploys the Worker — so the D1
# binding survives every deployment and never has to be re-added by hand.
#
# Requires the build API token to allow "D1 Edit". If it does not, we fall back
# to deploying without the binding so the build still goes green.
set -eu

DB_NAME="miliconfigpro-v1"
CONFIG_OUT="wrangler.deploy.toml"

# `dist/` is a build artifact (it is gitignored) and the Worker serves its JS
# bundle straight from there. Deploying without a fresh build ships an
# index.html whose script 404s, which renders the whole panel as a blank page.
# So the frontend is rebuilt on every deploy path, including Cloudflare Builds.
echo "── building frontend ──"
npx vite build

# wrangler.toml now declares the D1 binding itself, so a plain deploy always
# carries it. The fallback below only runs for older checkouts without it.
if grep -q '^\[\[d1_databases\]\]' wrangler.toml; then
  echo "── D1 binding found in wrangler.toml — deploying directly ──"
  exec npx wrangler deploy
fi

echo "── resolving D1 database (${DB_NAME}) ──"

DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s);
    const arr = Array.isArray(parsed) ? parsed : parsed.result || [];
    const m = arr.find((x) => x.name === process.argv[1] || x.database_name === process.argv[1]);
    console.log(m ? m.uuid || m.database_id || "" : "");
  } catch {
    console.log("");
  }
})' "$DB_NAME") || DB_ID=""

if [ -z "${DB_ID}" ]; then
  echo "not found — creating..."
  CREATE_OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1) || true
  DB_ID=$(printf '%s' "${CREATE_OUT:-}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1 || true)
fi

if [ -z "${DB_ID}" ]; then
  echo "⚠ could not resolve or create the D1 database."
  echo "⚠ Deploying WITHOUT the D1 binding. To fix permanently:"
  echo "⚠   Workers & Pages → ${DB_NAME} → Settings → Build → API token:"
  echo "⚠   create a token that also includes 'D1 Edit', then redeploy."
  exec npx wrangler deploy
fi

echo "✓ database_id: ${DB_ID}"

{
  cat wrangler.toml
  printf '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\n' "$DB_NAME" "$DB_ID"
} > "$CONFIG_OUT"

echo "── deploying worker ──"
npx wrangler deploy --config "$CONFIG_OUT"

# Enable Smart Placement so the worker runs next to its D1 database — the
# panel does many sequential D1 round-trips, this cuts real-world latency.
# Uses the CI token when available (Cloudflare Builds); silently skipped otherwise.
echo "── enabling Smart Placement ──"
node -e '
const t = process.env.CLOUDFLARE_API_TOKEN;
if (!t) { console.log("skip (no CLOUDFLARE_API_TOKEN)"); process.exit(0); }
(async () => {
  try {
    const h = { Authorization: `Bearer ${t}` };
    const a = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", { headers: h }).then(r => r.json());
    const acc = a?.result?.[0]?.id;
    if (!acc) throw new Error("no account");
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts/miliconfigpro-v1/settings`, {
      method: "PATCH", headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ placements: [{ mode: "smart" }] }),
    });
    console.log(r.ok ? "✓ Smart Placement enabled" : `⚠ Smart Placement skipped (HTTP ${r.status})`);
  } catch (e) { console.log(`⚠ Smart Placement skipped (${e.message})`); }
})();
' || true

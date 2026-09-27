/**
 * Engine-level smoke test for worker/panel-deploy.ts with the Railway and
 * Render HTTP APIs faked via a patched global fetch. Verifies:
 *   • startPanelDeploy persists railway_deploys/render_deploys rows with the
 *     one-time admin credentials and returns the right shape
 *   • platform mismatch (Railway-only panel + Render token) is rejected
 *   • watchPanelDeploy performs the one-time admin bootstrap + returns the
 *     credentials on the first live poll, then reports firstLive=false
 *   • the hosted-panel registry the dashboard/deployments/bot read:
 *     listPanelDeploys flattens both platform tables, forgetPanelDeploy drops
 *     exactly one owned row and probePanelHealth fetches the panel's own
 *     health path from our stored URL
 *   • latest-version tracking: fetchLatestPanelVersion reads the tracked branch
 *     of the upstream repo, updatePanelDeploy rebuilds the existing service on
 *     Railway *and* Render without losing its volume/env, setPanelAutoUpdate
 *     flips the per-deployment flag (refusing other people's rows) and the
 *     scheduled autoUpdatePanels sweep rebuilds only deployments that are
 *     actually behind upstream
 */
import {
  startPanelDeploy,
  watchPanelDeploy,
  listPanelDeploys,
  forgetPanelDeploy,
  probePanelHealth,
  fetchLatestPanelVersion,
  updatePanelDeploy,
  setPanelAutoUpdate,
  autoUpdatePanels,
} from '../worker/panel-deploy'
import { verifyRailwayToken, RailwayApiError } from '../worker/railway'

// ── fetch mocking ────────────────────────────────────────────────────────────
const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = []
let gqlQueue: Array<Record<string, unknown>> = []
let githubQueue: Array<Record<string, unknown>> = []
let renderQueue: Array<{ status: number; body: unknown }> = []
let setupStatus = 200
/** Sha the fake GitHub commits endpoint reports as the newest upstream commit. */
const UPSTREAM_SHA = 'abcdef1234567890abcdef1234567890abcdef12'

const realFetch = globalThis.fetch
function installFetch() {
  // @ts-expect-error test shim
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    const headers = (init?.headers ?? undefined) as Record<string, string> | undefined
    calls.push({ url, method, body, headers })

    if (url.includes('backboard.railway.com')) {
      const next = gqlQueue.shift() ?? {}
      // A queued `__errors` item models a Railway GraphQL failure (Railway
      // answers HTTP 200 with an errors array, exactly like the real API).
      if (Array.isArray(next.__errors)) {
        return new Response(JSON.stringify({ errors: next.__errors }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: next }), { status: 200 })
    }
    if (url.includes('api.github.com')) {
      // A queued item models one specific commit lookup (the connected-repo
      // "latest commit" read); otherwise answer the upstream version lookup with
      // the newest commit of the tracked branch. `__status` models a rate-limited
      // (403) / throttled (429) answer.
      const queued = githubQueue.shift()
      if (queued) {
        const status = typeof queued.__status === 'number' ? queued.__status : 200
        return new Response(status === 200 ? JSON.stringify(queued) : '', { status })
      }
      return new Response(
        JSON.stringify([
          {
            sha: UPSTREAM_SHA,
            html_url: `https://github.com/miladjahani/Mizetusi/commit/${UPSTREAM_SHA}`,
            commit: { message: 'feat: latest release\n\nmore detail', committer: { date: '2026-09-24T10:00:00Z' } },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url.includes('api.render.com')) {
      const next = renderQueue.shift() ?? { status: 200, body: {} }
      return new Response(JSON.stringify(next.body), { status: next.status })
    }
    // panel setup endpoint
    return new Response('ok', { status: setupStatus })
  }
}

// ── fake D1 (same minimal shim as the wizard smoke test) ─────────────────────
type Row = Record<string, unknown>
function makeDb() {
  const tables: Record<string, Map<string, Row>> = {
    railway_tokens: new Map(),
    render_tokens: new Map(),
    railway_deploys: new Map(),
    render_deploys: new Map(),
    activity_logs: new Map(),
  }
  function exec(sql: string, binds: unknown[], asSelect = false): { meta: { changes: number } } | Row | null {
    const ins = sql.match(/INSERT INTO (\w+)/)
    const upd = sql.match(/UPDATE\s+(\w+)\s+SET([\s\S]*?)WHERE([\s\S]*)$/)
    const sel = sql.match(/FROM (\w+)/)
    if (ins && !asSelect) {
      const t = tables[ins[1]]
      if (!t) return { meta: { changes: 0 } }
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim())
      const row: Row = { setup_done: 0 }
      cols.forEach((c, i) => (row[c] = binds[i]))
      t.set(String(binds[0]), row)
      return { meta: { changes: 1 } }
    }
    if (upd && !asSelect) {
      const t = tables[upd[1]]
      if (!t) return { meta: { changes: 0 } }
      const target = [...t.values()].find(
        (r) => String(r['id']) === String(binds[binds.length - 2]) && String(r['user_id']) === String(binds[binds.length - 1]),
      )
      if (!target) return { meta: { changes: 0 } }
      let placeholderIndex = 0
      for (const assign of upd[2].split(',')) {
        const [col, val] = assign.split('=').map((s) => s.trim())
        if (val === '?') {
          target[col] = binds[placeholderIndex++]
        } else if (/^\d+$/.test(val)) {
          target[col] = Number(val)
        } else if (val === 'NULL') {
          target[col] = null
        }
      }
      return { meta: { changes: 1 } }
    }
    if (sel && asSelect) {
      const t = tables[sel[1]]
      if (!t) return null
      const cols = sql.slice(sql.toUpperCase().indexOf('SELECT') + 6, sql.toUpperCase().indexOf('FROM')).split(',').map((c) => c.trim())
      const where = sql.match(/WHERE ([\s\S]*?)(?:LIMIT|$)/)
      for (const r of t.values()) {
        if (where) {
          let ok = true
          let bindIdx = 0
          for (const clause of where[1].split(' AND ').map((c) => c.trim())) {
            const m = clause.match(/(\w+)\s*=\s*\?/)
            if (m) {
              if (String(r[m[1]]) !== String(binds[bindIdx])) { ok = false; break }
              bindIdx++
            }
          }
          if (!ok) continue
        }
        const out: Row = {}
        for (const c of cols) {
          if (c.includes('(') || c.toUpperCase() === 'DISTINCT') continue
          out[c.split(/\s+AS\s+/i)[0]] = r[c.split(/\s+AS\s+/i)[0]]
        }
        return out
      }
      return null
    }
    return asSelect ? null : { meta: { changes: 1 } }
  }

  /**
   * SELECT … WHERE → matching rows. Conditions are `col = ?` (positional
   * binds) or `col = <literal>`, which covers `user_id = ?` and the
   * `auto_update = 1` filter the sweep uses.
   */
  function execAll(sql: string, binds: unknown[]): Row[] {
    const sel = sql.match(/FROM (\w+)/)
    if (!sel) return []
    const t = tables[sel[1]]
    if (!t) return []
    const cols = sql
      .slice(sql.toUpperCase().indexOf('SELECT') + 6, sql.toUpperCase().indexOf('FROM'))
      .split(',')
      .map((c) => c.trim().split(/\s+AS\s+/i)[0])
    const conds: Array<(r: Row) => boolean> = []
    for (const clause of (sql.match(/WHERE ([\s\S]*)$/)?.[1] ?? '').split(/\s+AND\s+/i)) {
      const m = clause.trim().match(/^(\w+)\s*=\s*(\?|'[^']*'|\d+)$/)
      if (!m) continue
      const col = m[1]
      if (m[2] === '?') {
        const value = String(binds[conds.length])
        conds.push((r) => String(r[col]) === value)
      } else {
        const value = m[2].startsWith("'") ? m[2].slice(1, -1) : m[2]
        conds.push((r) => String(r[col]) === value)
      }
    }
    const rows: Row[] = []
    for (const r of t.values()) {
      if (!conds.every((c) => c(r))) continue
      const out: Row = {}
      for (const c of cols) out[c] = r[c]
      rows.push(out)
    }
    return rows
  }

  /** DELETE … RETURNING (the shape panel-deploy uses for `forgetPanelDeploy`). */
  function execDelete(sql: string, binds: unknown[]): Row | null {
    const del = sql.match(/DELETE FROM (\w+)/)
    if (!del) return null
    const t = tables[del[1]]
    if (!t) return null
    for (const [key, row] of [...t.entries()]) {
      if (String(row['id']) === String(binds[0]) && String(row['user_id']) === String(binds[1])) {
        t.delete(key)
        return { name: row['name'] ?? null }
      }
    }
    return null
  }

  return {
    DB: {
      // Real D1 lets you run a parameterless statement without calling bind(),
      // so the shim exposes run/first/all both directly and after bind().
      prepare: (sql: string) => {
        const bound = (binds: unknown[]) => ({
          run: async () => (/DELETE FROM/i.test(sql) ? { meta: { changes: execDelete(sql, binds) ? 1 : 0 } } : exec(sql, binds)),
          first: async <T>() => (/DELETE FROM/i.test(sql) ? (execDelete(sql, binds) as T | null) : (exec(sql, binds, true) as T | null)),
          all: async <T>() => ({ results: execAll(sql, binds) as T[] }),
        })
        return Object.assign(bound([]), { bind: (...binds: unknown[]) => bound(binds) })
      },
    },
    tables,
  }
}

async function main() {
  installFetch()
  const env = makeDb()
  env.tables.railway_tokens.set('rt1', { id: 'rt1', token: 'RAILWAY_TOKEN', name: 'rail', user_id: 'u1', status: 'active' })
  env.tables.render_tokens.set('rd1', { id: 'rd1', token: 'RENDER_KEY', name: 'render', user_id: 'u1', status: 'active' })

  let pass = 0
  let fail = 0
  const check = (name: string, ok: boolean, extra = '') => {
    if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${extra}`) }
  }

  // The catalog holds one panel (see shared/panels.ts); resolve it by id so the
  // test still fails loudly if the id ever changes.
  const panel = (await import('../shared/panels')).resolvePanel('mizetusi')
  if (panel.id !== 'mizetusi') {
    console.error(`panel catalog changed: expected mizetusi, got ${panel.id}`)
    process.exit(1)
  }

  console.log('1) invalid name rejected')
  let r = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'Bad Name!', panel })
  check('invalid name', !r.ok)

  console.log('2) platform mismatch rejected')
  // The shipped panel supports railway+render, so derive a VPS-only variant from
  // it to exercise the guard (a Railway token on a VPS-only panel).
  const vpsOnly = { ...panel, targets: ['vps'] as typeof panel.targets }
  r = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'ok-name', panel: vpsOnly })
  check('vps-only panel rejected', !r.ok && r.error.includes('VPS'))

  console.log('3) railway happy path')
  githubQueue = [{ sha: 'abc123def456', html_url: 'https://github.com/miladjahani/Mizetusi/commit/abc123def456' }]
  gqlQueue = [
    { me: { workspaces: [{ id: 'ws1', name: 'W' }] } },            // workspaces
    { projectCreate: { id: 'prj1' } },                              // projectCreate
    { project: { environments: { edges: [{ node: { id: 'env1', name: 'production' } }] } } }, // envs
    { serviceCreate: { id: 'svc1' } },                              // serviceCreate
    { serviceInstanceAutoDeployUpdate: { enabled: false } },         // pause source deploys
    {},                                                             // instanceUpdate
    { serviceDomainCreate: { domain: 'my-app.up.railway.app' } },   // domain
    { volumeCreate: { id: 'vol1' } },                               // data volume
    { projectTokenCreate: 'project-token-1' },                      // project-scoped token
    { tcpProxyCreate: { id: 'tcp1', domain: 'proxy1.rlwy.net', proxyPort: 23177, applicationPort: 8443 } },
    { tcpProxyCreate: { id: 'tcp2', domain: 'proxy2.rlwy.net', proxyPort: 23178, applicationPort: 8446 } },
    { tcpProxyCreate: { id: 'tcp3', domain: 'proxy3.rlwy.net', proxyPort: 23179, applicationPort: 8448 } },
    // Complete manifest + RAILWAY_RUN_UID. Every write skips its own deploy.
    {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    { serviceInstanceAutoDeployUpdate: { enabled: true } },          // future GitHub pushes
    { serviceInstanceDeployV2: 'dep1' },                            // exact latest commit
  ]
  r = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'my-app', panel })
  check('started ok', r.ok, JSON.stringify(r).slice(0, 120))
  if (r.ok) {
    check('returns domain', r.domain === 'my-app.up.railway.app')
    check('returns admin creds', r.adminUsername === 'admin' && r.adminPassword.length >= 10)
    const row = env.tables.railway_deploys.get(r.id)
    check('deploy row persisted', !!row && row['panel'] === panel.id && row['admin_password'] === r.adminPassword)
    check('project token persisted privately', row?.['project_token'] === 'project-token-1')
    check('TCP proxy persisted', row?.['tcp_proxy_domain'] === 'proxy1.rlwy.net' && row?.['tcp_proxy_port'] === 23177)
    // Every raw port gets its own public proxy: reality + mtproto + web-http.
    const storedProxies = JSON.parse(String(row?.['tcp_proxies'] ?? '[]')) as Array<{ applicationPort: number; label?: string }>
    check(
      'all three raw ports proxied',
      storedProxies.length === 3 && [8443, 8446, 8448].every((p) => storedProxies.some((t) => t.applicationPort === p)),
      JSON.stringify(storedProxies),
    )
    check('latest commit persisted', row?.['commit_sha'] === 'abc123def456' && row?.['current_deployment_id'] === 'dep1')
    check('activity logged', env.tables.activity_logs.size === 1)
  }

  console.log('4) watch — first live poll bootstraps admin once')
  setupStatus = 200
  gqlQueue = [{ deployment: { id: 'dep1', status: 'SUCCESS', url: null } }]
  const w1 = await watchPanelDeploy(env as never, 'u1', 'railway', 'dep1')
  check('live result', w1.state === 'live')
  if (w1.state === 'live') {
    check('firstLive=true', w1.firstLive === true)
    check('creds surfaced', w1.adminPassword === env.tables.railway_deploys.get('dep1')?.['admin_password'])
    check('panel path attached', w1.panelPath === panel.panelPath)
  }
  // Bootstrap runs only for panels that declare a setup endpoint; the shipped
  // panel configures itself from env vars, so it expects zero POSTs.
  const expectedSetupPosts = panel.setupPath ? 1 : 0
  const panelPosts = (endpoint: string) => calls.filter((c) => c.url.includes('my-app.up.railway.app') && c.method === 'POST' && c.url.includes(endpoint))
  const setupCalls = panelPosts(panel.setupPath ?? '/__no_setup__')
  check(`setup POSTs on first poll (${expectedSetupPosts})`, setupCalls.length === expectedSetupPosts, `got ${setupCalls.length}`)
  // The panel ships with the raw-port listeners off; the deploy flips them on
  // through its own save API right after it comes up.
  const capabilityPosts = panelPosts('/api/telegram')
  check(
    'raw-port capabilities enabled once',
    capabilityPosts.length === 1,
    `got ${capabilityPosts.length}`,
  )
  if (capabilityPosts[0]) {
    const sent = JSON.parse(capabilityPosts[0].body ?? '{}') as Record<string, Record<string, unknown>>
    check('mtproto enabled', sent['mtproto']?.['enabled'] === '1', capabilityPosts[0].body ?? '')
    check('web-http enabled', sent['webproxy']?.['web-http']?.['enabled'] === '1', capabilityPosts[0].body ?? '')
    check('admin password sent as header', !!capabilityPosts[0].headers?.['x-admin-password'])
  }
  check('capabilities reported ok', w1.state === 'live' && w1.capabilitiesError == null, w1.state === 'live' ? String(w1.capabilitiesError) : '')
  const afterRow = env.tables.railway_deploys.get('dep1')
  check('setup_done flipped', afterRow?.['setup_done'] === 1, `row=${JSON.stringify(afterRow)}`)

  console.log('5) watch — second poll reports firstLive=false, no repeat setup')
  gqlQueue = [{ deployment: { id: 'dep1', status: 'SUCCESS', url: null } }]
  const w2 = await watchPanelDeploy(env as never, 'u1', 'railway', 'dep1')
  check('still live', w2.state === 'live')
  check('firstLive=false', w2.state === 'live' && w2.firstLive === false)
  check('no repeat setup POST', panelPosts(panel.setupPath ?? '/__no_setup__').length === expectedSetupPosts)
  check('no repeat capability POST', panelPosts('/api/telegram').length === 1)

  console.log('6) render token on a railway-only panel → mismatch error')
  // Same trick the other way round: a railway-only variant must reject a Render key.
  const railOnlyPanel = { ...panel, targets: ['railway'] as typeof panel.targets }
  r = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rd1', name: 'cross-app', panel: railOnlyPanel })
  check('railway-only panel + render key rejected', !r.ok && r.error.includes('Render'))

  console.log('7) panel registry — list flattens both platforms')
  env.tables.render_deploys.set('rnd1', {
    id: 'rnd1', user_id: 'u1', token_id: 'rd1', service_id: 'srv1', name: 'render-app',
    panel: panel.id, url: 'https://render-app.onrender.com', admin_username: 'admin',
    admin_password: 'renderpass1234', setup_done: 1, created_at: '2026-05-02T00:00:00.000Z',
  })
  env.tables.railway_deploys.set('other', { id: 'other', user_id: 'u2', panel: panel.id, project_id: 'p9', setup_done: 0, created_at: '2026-05-03T00:00:00.000Z' })
  const registry = await listPanelDeploys(env as never, 'u1')
  check('only the caller’s panels are listed', registry.every((r) => r.id !== 'other'), JSON.stringify(registry.map((r) => r.id)))
  check('both platforms are present', new Set(registry.map((r) => r.platform)).size === 2, registry.map((r) => r.platform).join(','))
  const railRow = registry.find((r) => r.platform === 'railway')!
  const rendRow = registry.find((r) => r.platform === 'render')!
  check('spec is attached (name/path/health)', railRow.panelName === panel.name && railRow.panelPath === panel.panelPath && railRow.healthPath === (panel.healthPath ?? panel.panelPath))
  check('railway panel url + dashboard link', railRow.panelUrl === 'https://my-app.up.railway.app/login' && railRow.dashboardUrl === 'https://railway.com/project/prj1', `${railRow.panelUrl} | ${railRow.dashboardUrl}`)
  check('render panel url + dashboard link', rendRow.panelUrl === 'https://render-app.onrender.com/login' && rendRow.dashboardUrl === 'https://dashboard.render.com/web/srv1', `${rendRow.panelUrl} | ${rendRow.dashboardUrl}`)
  // A panel that stores state on disk only survives a redeploy with a volume,
  // so the engine must ask for one at the panel's data path.
  const volCall = calls.find((c) => (c.body ?? '').includes('volumeCreate'))
  check('data volume requested at /data', !!volCall && (volCall.body ?? '').includes('/data'), volCall?.body?.slice(0, 160))
  // Regression: the panel is handed the SQLite *file* inside the volume. Passing
  // the mount directory itself makes sqlite3 fail on boot (a live Railway
  // deploy crashed with "unable to open database file" because of it).
  const dataVarBody = calls.map((c) => c.body ?? '').find((b) => b.includes(panel.env.dataDir!)) ?? ''
  check('panel state var points at a file, not the mount dir', dataVarBody.includes('"' + panel.dataFile + '"'), dataVarBody.slice(0, 220))
  // Railway volumes are root-owned; a panel image running as an unprivileged
  // user cannot write to its mount, so the deploy must opt into running as root
  // (verified live: without this the panel crash-looped on boot).
  check(
    'container is allowed to own its volume',
    calls.some((c) => (c.body ?? '').includes('RAILWAY_RUN_UID') && (c.body ?? '').includes('"0"')),
  )
  // Regression: one variable write must not start its own deployment, or the
  // panel builds once per env var before the real deploy.
  const varBodies = calls.map((c) => c.body ?? '').filter((b) => b.includes('variableUpsert'))
  check(
    'variable writes skip their own deploy',
    varBodies.length > 0 && varBodies.every((b) => b.includes('"skipDeploys":true')),
    `${varBodies.length} writes`,
  )
  check('automatic GitHub deploys enabled', calls.some((c) => (c.body ?? '').includes('serviceInstanceAutoDeployUpdate') && (c.body ?? '').includes('"enabled":true')))
  check('initial deploy pins latest SHA', calls.some((c) => (c.body ?? '').includes('serviceInstanceDeployV2') && (c.body ?? '').includes('"commitSha":"abc123def456"')))
  check('full runtime manifest injected', ['NEXUS_PLATFORM', 'XRAY_ENABLED', 'WARP_ENABLED', 'NEXUS_HTTP_PORT', 'PUBLIC_BASE_URL', 'NEXUS_RAILWAY_TOKEN'].every((name) => varBodies.some((body) => body.includes(name))))
  const dates = registry.map((r) => String(r.createdAt ?? ''))
  check('newest first', dates.every((d, i) => i === 0 || dates[i - 1] >= d), dates.join(' > '))

  console.log('8) health probe uses the stored url, never the request')
  const health = await probePanelHealth(env as never, 'u1', 'railway', 'dep1')
  check('probe hit the panel health path', calls.some((c) => c.url === `https://my-app.up.railway.app${panel.healthPath ?? panel.panelPath}`), JSON.stringify(calls.at(-1)))
  check('healthy response reported', health.ok && health.status === setupStatus, JSON.stringify(health))
  const foreign = await probePanelHealth(env as never, 'u1', 'railway', 'other')
  check('other users’ panels are refused', !foreign.ok && !!foreign.error, JSON.stringify(foreign))

  console.log('9) forget drops exactly one owned row + logs it')
  const before = env.tables.activity_logs.size
  const forgotten = await forgetPanelDeploy(env as never, 'u1', 'render', 'rnd1')
  check('forgotten ok', forgotten.ok === true, JSON.stringify(forgotten))
  check('row gone', !env.tables.render_deploys.has('rnd1'))
  check('activity logged', env.tables.activity_logs.size === before + 1)
  const notMine = await forgetPanelDeploy(env as never, 'u1', 'railway', 'other')
  check('another user’s panel cannot be forgotten', notMine.ok === false)
  check('it is still there', env.tables.railway_deploys.has('other'))

  console.log('10) railway token diagnosis — Account vs Project token')
  const denied = [{ message: 'Not Authorized', extensions: { code: 'INTERNAL_SERVER_ERROR' } }]
  // A project token is valid but account-level queries are refused: the error
  // must name the token kind, not claim the credential is bogus. The denial is
  // answered twice because a denial is retried once before it is believed.
  gqlQueue = [
    { __errors: denied },
    { __errors: denied },
    { projectToken: { projectId: 'prj1', environmentId: 'env1' } },
  ]
  let projectMsg = ''
  try {
    await verifyRailwayToken('11111111-2222-3333-4444-555555555555')
  } catch (e) {
    projectMsg = e instanceof RailwayApiError ? e.message : `wrong error: ${String(e)}`
  }
  check('project token named as such', projectMsg.includes('Project'), projectMsg)
  check('project token hint points at Account tokens', projectMsg.includes('/account/tokens'), projectMsg)
  // Project tokens are only accepted in their own header (Railway docs) — a
  // Bearer-only probe could never recognise one.
  check(
    'project probe used the Project-Access-Token header',
    calls.some((c) => !!c.headers && 'Project-Access-Token' in c.headers),
  )

  // A blanket denial is retried once (a fresh token is refused while Railway
  // propagates it) before the caller sees any error at all.
  gqlQueue = [{ __errors: denied }, { me: { id: 'u1', name: 'Recovered' } }]
  let retried: { name: string; email: string } | null = null
  let retryErr = ''
  try {
    retried = await verifyRailwayToken('11111111-2222-3333-4444-555555555555')
  } catch (e) {
    retryErr = String(e)
  }
  check('denied call is retried and then accepted', retried?.name === 'Recovered', retryErr)
  check('only two attempts were made', gqlQueue.length === 0, `left ${gqlQueue.length}`)

  // Account-level refusals get actionable Persian text instead of Railway's
  // English sentence (both were hit for real while testing a live deploy).
  gqlQueue = [{ __errors: [{ message: 'Free plan resource provision limit exceeded. Please upgrade to provision more resources!' }] }]
  let quotaMsg = ''
  try {
    await verifyRailwayToken('11111111-2222-3333-4444-555555555555')
  } catch (e) {
    quotaMsg = e instanceof RailwayApiError ? e.message : String(e)
  }
  check('resource limit explained in Persian', quotaMsg.includes('سهمیهٔ منابع'), quotaMsg)

  gqlQueue = [{ __errors: [{ message: 'You are creating projects too quickly. This workspace allows 1 project per 30 seconds. Try again shortly.' }] }]
  let fastMsg = ''
  try {
    await verifyRailwayToken('11111111-2222-3333-4444-555555555555')
  } catch (e) {
    fastMsg = e instanceof RailwayApiError ? e.message : String(e)
  }
  check('project rate limit explained in Persian', fastMsg.includes('۳۰ ثانیه'), fastMsg)

  // A token Railway does not recognise at all keeps the generic message.
  gqlQueue = [
    { __errors: denied },
    { __errors: denied },
    { __errors: [{ message: 'Project Token not found' }] },
  ]
  let unknownMsg = ''
  try {
    await verifyRailwayToken('11111111-2222-3333-4444-555555555555')
  } catch (e) {
    unknownMsg = e instanceof RailwayApiError ? e.message : `wrong error: ${String(e)}`
  }
  check('unknown token rejected generically', unknownMsg.includes('نامعتبر') && !unknownMsg.includes('Project/Environment'), unknownMsg)

  console.log('11) latest upstream version (GitHub commits API)')
  const latest = await fetchLatestPanelVersion(panel)
  check('parsed sha', latest?.short === 'abcdef1', JSON.stringify(latest))
  check('parsed commit date', latest?.date === '2026-09-24T10:00:00Z', String(latest?.date))
  check('commit message first line only', latest?.message === 'feat: latest release', String(latest?.message))
  check(
    'read the branch the catalog declares',
    calls.some((c) => c.url.includes(`/repos/${panel.repo}/commits`) && c.url.includes(`sha=${panel.defaultBranch}`)),
  )

  console.log('12) update → rebuild the existing railway service on the newest commit')
  gqlQueue = [{ serviceInstanceDeployV2: 'dep2' }]
  let updated = await updatePanelDeploy(env as never, 'u1', 'railway', 'dep1')
  check('update accepted', updated.ok === true, JSON.stringify(updated))
  if (updated.ok) {
    check('row id follows the new deployment', updated.id === 'dep2')
    check('upstream version attached', updated.version?.short === 'abcdef1')
    check('first update is not “already latest”', updated.alreadyLatest === false)
  }
  const afterUpdate = await listPanelDeploys(env as never, 'u1')
  const railAfterUpdate = afterUpdate.find((r) => r.platform === 'railway')!
  check('registry reports the new deployment id', railAfterUpdate.id === 'dep2', railAfterUpdate.id)
  check('last_version persisted', railAfterUpdate.lastVersion === UPSTREAM_SHA, String(railAfterUpdate.lastVersion))
  check('last_updated_at persisted', !!railAfterUpdate.lastUpdatedAt, String(railAfterUpdate.lastUpdatedAt))
  check('update logged', [...env.tables.activity_logs.values()].some((l) => l['action'] === 'panel_updated'))
  const redeployCalls = calls.filter((c) => (c.body ?? '').includes('serviceInstanceDeployV2'))
  check(
    'railway rebuilt the same service (volume + env kept)',
    redeployCalls.length >= 2 && (redeployCalls.at(-1)?.body ?? '').includes('svc1'),
    `${redeployCalls.length} deploy calls`,
  )

  console.log('13) update → rebuild the existing render service')
  env.tables.render_deploys.set('rr1', {
    id: 'rr1', user_id: 'u1', token_id: 'rd1', service_id: 'srv9', name: 'render-two',
    panel: panel.id, url: 'https://render-two.onrender.com', setup_done: 1, created_at: '2026-05-04T00:00:00.000Z',
  })
  renderQueue = [{ status: 200, body: { id: 'rnd2' } }]
  updated = await updatePanelDeploy(env as never, 'u1', 'render', 'rr1')
  check('render update accepted', updated.ok === true, JSON.stringify(updated))
  if (updated.ok) check('render row id follows the deploy', updated.id === 'rnd2')
  check('render deploy POSTed to the existing service', calls.some((c) => c.url.endsWith('/services/srv9/deploys') && c.method === 'POST'))
  const renderRow = (await listPanelDeploys(env as never, 'u1')).find((r) => r.platform === 'render')!
  check('render keeps its url', renderRow.url === 'https://render-two.onrender.com', String(renderRow.url))

  console.log('14) auto-update flag + the scheduled sweep')
  const on = await setPanelAutoUpdate(env as never, 'u1', 'render', 'rnd2', true)
  check('flag switched on', on.ok === true && on.autoUpdate === true, JSON.stringify(on))
  const off = await setPanelAutoUpdate(env as never, 'u1', 'render', 'rnd2', false)
  check('flag switched off', off.ok === true && off.autoUpdate === false, JSON.stringify(off))
  await setPanelAutoUpdate(env as never, 'u1', 'render', 'rnd2', true)
  const foreignToggle = await setPanelAutoUpdate(env as never, 'u1', 'railway', 'not-mine', true)
  check('unknown/foreign deployment refused', foreignToggle.ok === false)
  check('auto-update change logged', [...env.tables.activity_logs.values()].some((l) => l['action'] === 'panel_auto_update_on'))

  // Already on the newest sha → the sweep must not rebuild it (no wasted build).
  const idle = await autoUpdatePanels(env as never)
  check('sweep looked at the opted-in deployment', idle.checked === 1, JSON.stringify(idle))
  check('nothing rebuilt while already current', idle.updated === 0 && idle.failed === 0, JSON.stringify(idle))

  // Behind upstream → rebuilt exactly once, and the new sha is recorded.
  const stored = [...env.tables.render_deploys.values()].find((r) => r['name'] === 'render-two')!
  stored['last_version'] = '0000000000000000000000000000000000000000'
  renderQueue = [{ status: 200, body: { id: 'rnd3' } }]
  const sweep = await autoUpdatePanels(env as never)
  check('sweep rebuilt the stale deployment', sweep.updated === 1 && sweep.failed === 0, JSON.stringify(sweep))
  const swept = (await listPanelDeploys(env as never, 'u1')).find((r) => r.platform === 'render')!
  check('swept deployment records the upstream sha', swept.lastVersion === UPSTREAM_SHA && swept.id === 'rnd3', `${swept.id} · ${swept.lastVersion}`)

  console.log('15) GitHub lookup rate-limited (HTTP 403) must not fail the deploy')
  // The connected-repo "latest commit" read is best-effort: a Worker shares its
  // egress IP, GitHub answers 403, and the panel still deploys from the branch
  // HEAD. This is the exact failure mode users reported as "403 but it deploys".
  const railwayPreamble = (ids: { prj: string; env: string; svc: string }) => [
    { me: { workspaces: [{ id: 'ws1', name: 'W' }] } },
    { projectCreate: { id: ids.prj } },
    { project: { environments: { edges: [{ node: { id: ids.env, name: 'production' } }] } } },
    { serviceCreate: { id: ids.svc } },
    { serviceInstanceAutoDeployUpdate: { enabled: false } },
    {},
    { serviceDomainCreate: { domain: 'rate.up.railway.app' } },
    { volumeCreate: { id: 'vol1' } },
    { projectTokenCreate: 'project-token-9' },
    { tcpProxyCreate: { id: 'tcp1', domain: 'p1.rlwy.net', proxyPort: 23177, applicationPort: 8443 } },
    { tcpProxyCreate: { id: 'tcp2', domain: 'p2.rlwy.net', proxyPort: 23178, applicationPort: 8446 } },
    { tcpProxyCreate: { id: 'tcp3', domain: 'p3.rlwy.net', proxyPort: 23179, applicationPort: 8448 } },
    ...Array.from({ length: 11 }, () => ({})),
    { serviceInstanceAutoDeployUpdate: { enabled: true } },
  ]
  githubQueue = [{ __status: 403 }]
  gqlQueue = [...railwayPreamble({ prj: 'prjR', env: 'envR', svc: 'svcR' }), { serviceInstanceDeployV2: 'dep-head' }]
  const rateLimited = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'rate-limited', panel })
  check('deploy still succeeds when GitHub is rate-limited', rateLimited.ok === true, JSON.stringify(rateLimited).slice(0, 160))
  if (rateLimited.ok) {
    const row = env.tables.railway_deploys.get(rateLimited.id)
    check('deployed from the branch HEAD (no pinned sha)', row?.['commit_sha'] === null, String(row?.['commit_sha']))
  }
  const headDeploy = calls.map((c) => c.body ?? '').filter((b) => b.includes('serviceInstanceDeployV2')).at(-1) ?? ''
  check('deploy command omits commitSha when the sha is unknown', !headDeploy.includes('commitSha'), headDeploy.slice(0, 200))

  console.log('16) refused explicit deploy adopts the build Railway already started')
  // serviceCreate makes Railway build the repo immediately; a refused explicit
  // deploy must therefore point at that build, not report a failed deployment.
  githubQueue = [{ sha: 'headsha0123', html_url: 'https://github.com/miladjahani/Mizetusi/commit/headsha0123' }]
  gqlQueue = [
    ...railwayPreamble({ prj: 'prjA', env: 'envA', svc: 'svcA' }),
    { __errors: [{ message: 'Not Authorized' }] },
    { __errors: [{ message: 'Not Authorized' }] },
    { deployments: { edges: [{ node: { id: 'adopted-dep' } }] } },
  ]
  const adopted = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'adopted-build', panel })
  check('deploy succeeds by adopting the existing build', adopted.ok === true && adopted.id === 'adopted-dep', JSON.stringify(adopted).slice(0, 160))
  if (adopted.ok) check('the adopted deployment is persisted', env.tables.railway_deploys.has('adopted-dep'))

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  globalThis.fetch = realFetch
  process.exit(1)
})

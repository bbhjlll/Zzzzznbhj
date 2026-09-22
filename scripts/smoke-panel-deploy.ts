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
 */
import { startPanelDeploy, watchPanelDeploy, listPanelDeploys, forgetPanelDeploy, probePanelHealth } from '../worker/panel-deploy'

// ── fetch mocking ────────────────────────────────────────────────────────────
const calls: Array<{ url: string; method: string; body?: string }> = []
let gqlQueue: Array<Record<string, unknown>> = []
let renderQueue: Array<{ status: number; body: unknown }> = []
let setupStatus = 200

const realFetch = globalThis.fetch
function installFetch() {
  // @ts-expect-error test shim
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push({ url, method, body })

    if (url.includes('backboard.railway.com')) {
      const data = gqlQueue.shift() ?? {}
      return new Response(JSON.stringify({ data }), { status: 200 })
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
    const upd = sql.match(/UPDATE (\w+) SET([\s\S]*?)WHERE([\s\S]*)$/)
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
      for (const assign of upd[2].split(',')) {
        const [col, val] = assign.split('=').map((s) => s.trim())
        if (val === '?') {
          const phIndex = sql.slice(0, sql.indexOf(assign)).split('?').length - 1
          target[col] = binds[phIndex]
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

  /** SELECT … (no WHERE support beyond `user_id = ?`) → every matching row. */
  function execAll(sql: string, binds: unknown[]): Row[] {
    const sel = sql.match(/FROM (\w+)/)
    if (!sel) return []
    const t = tables[sel[1]]
    if (!t) return []
    const cols = sql
      .slice(sql.toUpperCase().indexOf('SELECT') + 6, sql.toUpperCase().indexOf('FROM'))
      .split(',')
      .map((c) => c.trim().split(/\s+AS\s+/i)[0])
    const scoped = /user_id\s*=\s*\?/.test(sql)
    const userId = scoped ? String(binds[binds.length - 1]) : null
    const rows: Row[] = []
    for (const r of t.values()) {
      if (userId && String(r['user_id']) !== userId) continue
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
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => (/DELETE FROM/i.test(sql) ? { meta: { changes: execDelete(sql, binds) ? 1 : 0 } } : exec(sql, binds)),
          first: async <T>() => (/DELETE FROM/i.test(sql) ? (execDelete(sql, binds) as T | null) : (exec(sql, binds, true) as T | null)),
          all: async <T>() => ({ results: execAll(sql, binds) as T[] }),
        }),
      }),
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
  gqlQueue = [
    { me: { workspaces: [{ id: 'ws1', name: 'W' }] } },            // workspaces
    { projectCreate: { id: 'prj1' } },                              // projectCreate
    { project: { environments: { edges: [{ node: { id: 'env1', name: 'production' } }] } } }, // envs
    { serviceCreate: { id: 'svc1' } },                              // serviceCreate
    {},                                                             // instanceUpdate
    { serviceDomainCreate: { domain: 'my-app.up.railway.app' } },   // domain
    {}, {}, {},                                                     // variableUpserts (PORT/ADMIN_PASSWORD/JWT_SECRET)
    {},                                                             // variableUpserts (SQLITE_PATH)
    { serviceInstanceDeployV2: 'dep1' },                            // deploy trigger
  ]
  r = await startPanelDeploy(env as never, { userId: 'u1', tokenId: 'rt1', name: 'my-app', panel })
  check('started ok', r.ok, JSON.stringify(r).slice(0, 120))
  if (r.ok) {
    check('returns domain', r.domain === 'my-app.up.railway.app')
    check('returns admin creds', r.adminUsername === 'admin' && r.adminPassword.length >= 10)
    const row = env.tables.railway_deploys.get(r.id)
    check('deploy row persisted', !!row && row['panel'] === panel.id && row['admin_password'] === r.adminPassword)
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
  const setupCalls = calls.filter((c) => c.url.includes('my-app.up.railway.app') && c.method === 'POST')
  check(`setup POSTs on first poll (${expectedSetupPosts})`, setupCalls.length === expectedSetupPosts, `got ${setupCalls.length}`)
  const afterRow = env.tables.railway_deploys.get('dep1')
  check('setup_done flipped', afterRow?.['setup_done'] === 1, `row=${JSON.stringify(afterRow)}`)

  console.log('5) watch — second poll reports firstLive=false, no repeat setup')
  gqlQueue = [{ deployment: { id: 'dep1', status: 'SUCCESS', url: null } }]
  const w2 = await watchPanelDeploy(env as never, 'u1', 'railway', 'dep1')
  check('still live', w2.state === 'live')
  check('firstLive=false', w2.state === 'live' && w2.firstLive === false)
  const setupCalls2 = calls.filter((c) => c.url.includes('my-app.up.railway.app') && c.method === 'POST')
  check('no repeat setup POST', setupCalls2.length === expectedSetupPosts, `got ${setupCalls2.length}`)

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

  console.log(`\n${pass} passed, ${fail} failed`)
  globalThis.fetch = realFetch
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  globalThis.fetch = realFetch
  process.exit(1)
})

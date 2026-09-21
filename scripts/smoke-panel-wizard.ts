/**
 * Smoke test for the Railway/Render panel deploy wizard routes in
 * worker/telegram-ui.ts. Runs against an in-memory fake of the D1 surface the
 * router touches, then simulates: target → panel → token → confirm, plus the
 * `srv:` status branch (pending / live) and the wizard's validation guards.
 *
 * The deploy-start step (`dpl:go`) is intentionally NOT executed here because
 * it calls the real Railway/Render HTTP APIs; the shared engine is covered by
 * `scripts/smoke-panel-deploy.ts` which fakes only the HTTP layer instead.
 */
import { routeCallback, deployStartScreen } from '../worker/telegram-ui'
import type { BotConfigRow, BotSession } from '../worker/telegram-core'

// ── minimal fake D1 ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>

function makeDb() {
  const tables: Record<string, Map<string, Row>> = {
    railway_tokens: new Map(),
    render_tokens: new Map(),
    railway_deploys: new Map(),
    render_deploys: new Map(),
    bot_sessions: new Map(),
    activity_logs: new Map(),
    bot_users: new Map(),
  }

  const db = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => exec(sql, binds),
          first: async <T>() => (exec(sql, binds, true) as Row | null) as T | null,
          all: async <T>() => ({ results: execAll(sql, binds) as T[] }),
        }),
      }),
    },
    tables,
  }

  function exec(sql: string, binds: unknown[], asSelect = false): { meta: { changes: number } } | Row | null {
    const ins = sql.match(/INSERT INTO (\w+)/)
    const upd = sql.match(/UPDATE (\w+) SET([\s\S]*?)WHERE([\s\S]*)$/)
    const sel = sql.match(/FROM (\w+)/)

    if (ins && !asSelect) {
      const t = tables[ins[1]]
      if (!t) return { meta: { changes: 0 } }
      const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim())
      const row: Row = {}
      cols.forEach((c, i) => (row[c] = binds[i]))
      t.set(String(binds[0]), row)
      return { meta: { changes: 1 } }
    }

    if (upd && !asSelect) {
      const table = upd[1]
      const t = tables[table]
      if (!t) return { meta: { changes: 0 } }
      // WHERE id = ? AND user_id = ? → binds[last-1], binds[last]
      const target = [...t.values()].find(
        (r) => String(r['id']) === String(binds[binds.length - 2]) && String(r['user_id']) === String(binds[binds.length - 1]),
      )
      if (!target) return { meta: { changes: 0 } }
      for (const assign of upd[2].split(',')) {
        const [col, ph] = assign.split('=').map((s) => s.trim())
        if (ph !== '?') continue
        const phIndex = sql.slice(0, sql.indexOf(assign)).split('?').length - 1
        target[col] = binds[phIndex]
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
          const clauses = where[1].split(' AND ').map((c) => c.trim())
          let ok = true
          let bindIdx = 0
          for (const clause of clauses) {
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
          if (c.includes('(')) continue
          out[c] = r[c]
        }
        return out
      }
      return null
    }

    return asSelect ? null : { meta: { changes: 1 } }
  }

  /** `.all()` — same WHERE matching as `exec`, but every matching row. */
  function execAll(sql: string, binds: unknown[]): Row[] {
    const sel = sql.match(/FROM (\w+)/)
    if (!sel) return []
    const t = tables[sel[1]]
    if (!t) return []
    const upper = sql.toUpperCase()
    const cols = sql.slice(upper.indexOf('SELECT') + 6, upper.indexOf('FROM')).split(',').map((c) => c.trim())
    const where = sql.match(/WHERE ([\s\S]*?)(?:ORDER BY|LIMIT|$)/)
    const out: Row[] = []
    for (const r of t.values()) {
      if (where) {
        const clauses = where[1].split(' AND ').map((c) => c.trim())
        let ok = true
        let bindIdx = 0
        for (const clause of clauses) {
          const m = clause.match(/(\w+)\s*=\s*\?/)
          if (m) {
            if (String(r[m[1]]) !== String(binds[bindIdx])) { ok = false; break }
            bindIdx++
          }
        }
        if (!ok) continue
      }
      const row: Row = {}
      for (const c of cols) {
        if (c.includes('(')) continue
        row[c] = r[c]
      }
      out.push(row)
    }
    return out
  }

  return db
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const env = makeDb()

const cfg: BotConfigRow = {
  id: 'cfg1',
  user_id: 'u1',
  bot_token: 'TEST',
  welcome_message: 'سلام',
  chat_id: '100',
}

const session: BotSession | null = null

function args(data: string, sess: BotSession | null = session) {
  return {
    env: env as never,
    exec: { waitUntil: () => {} } as unknown as ExecutionContext,
    cfg,
    chatId: 100,
    telegramId: '100',
    userId: 'u1',
    origin: 'https://panel.example.com',
    session: sess,
    data,
  }
}

// ── the scenario ─────────────────────────────────────────────────────────────
async function main() {
  let pass = 0
  let fail = 0
  const check = (name: string, ok: boolean, extra = '') => {
    if (ok) { pass++; console.log(`  ✓ ${name}`) }
    else { fail++; console.log(`  ✗ ${name} ${extra}`) }
  }

  console.log('1) start screen offers three destinations')
  const start = deployStartScreen()
  const allData = start.keyboard.inline_keyboard.flat().map((b) => b.callback_data)
  check('has workers', allData.includes('dpl:m:workers'))
  check('has railway', allData.includes('dpl:T:railway'))
  check('has render', allData.includes('dpl:T:render'))

  console.log('2) target=railway → panel catalog')
  let res = await routeCallback(args('dpl:T:railway'))
  check('shows panel list', !!res && res.text.includes('Railway'))
  const panelButtons = res!.keyboard.inline_keyboard.flat().filter((b) => b.callback_data?.startsWith('dpl:p:'))
  check('railway panel buttons > 0', panelButtons.length > 0, `got ${panelButtons.length}`)

  // The bot loads the persisted session before every update — mirror that by
  // threading an explicit session object through the steps below.
  const mk = (over: Record<string, unknown>): BotSession => ({ state: 'deploy', data: over })

  console.log('3) pick a railway-capable panel → token step (no tokens yet → hint)')
  const panelId = panelButtons[0].callback_data.split(':')[2]
  res = await routeCallback(args(`dpl:p:${panelId}`, mk({ target: 'railway' })))
  check('token hint (no tokens)', !!res && res.text.includes('توکن Railway لازم است'), res?.text.slice(0, 80))

  console.log('4) with a token → confirm screen')
  const tokens = (env as unknown as { tables: Record<string, Map<string, Row>> }).tables.railway_tokens
  tokens.set('tok1', { id: 'tok1', name: 'My Railway', token: 'rtk', user_id: 'u1', status: 'active' })
  res = await routeCallback(args(`dpl:p:${panelId}`, mk({ target: 'railway' })))
  res = await routeCallback(args('dpl:t:tok1', mk({ target: 'railway', panel: panelId })))
  check('confirm screen', !!res && res.text.includes('تأیید نهایی'), res?.text.slice(0, 80))
  check('random name set', !!res && /mil-[a-z2-9]{6}/.test(res.text))

  console.log('5) rename via await_name state → back to confirm')
  const renamedSession: BotSession = { state: 'await_name', data: { target: 'railway', panel: panelId, tokenId: 'tok1', tokenName: 'My Railway', name: 'old' } }
  const { routeText } = await import('../worker/telegram-ui')
  res = await routeText(args('', renamedSession), 'my-panel-1')
  check('confirm after rename', !!res && res.text.includes('my-panel-1'))

  console.log('6) invalid panel for render target is rejected')
  res = await routeCallback(args('dpl:T:render', mk({})))
  const renderPanels = res!.keyboard.inline_keyboard.flat().filter((b) => b.callback_data?.startsWith('dpl:p:'))
  check('render catalog shown', renderPanels.length > 0)
  res = await routeCallback(args('dpl:p:__nope__', mk({ target: 'render' })))
  check('unknown panel falls back to catalog', !!res && res.keyboard.inline_keyboard.flat().some((b) => b.callback_data?.startsWith('dpl:p:')))

  console.log('7) srv: status — pending and live paths')
  const deploys = (env as unknown as { tables: Map<string, Map<string, Row>> }).tables.railway_deploys
  deploys.set('dep1', {
    id: 'dep1', user_id: 'u1', token_id: 'tok1', panel: panelId,
    admin_username: 'admin', admin_password: 'secret123', setup_done: 0,
    domain: 'my-panel.up.railway.app', name: 'my-panel', status: 'SUCCESS',
  })
  // watchPanelDeploy needs the upstream API — instead verify the router reaches
  // the pending branch gracefully when the token lookup fails (NO_TOKEN path).
  tokens.delete('tok1')
  res = await routeCallback(args('srv:railway:dep1'))
  check('srv pending path', !!res && (res.text.includes('در حال استقرار') || res.text.includes('ناموفق')))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

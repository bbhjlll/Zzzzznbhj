/**
 * Catalog integrity check for shared/panels.ts.
 *
 * Every panel the app can deploy comes from this one array, so a malformed
 * entry breaks the Railway/Render/VPS deployers at runtime instead of at build
 * time. This test pins the contract:
 *
 *   • ids are unique and stable
 *   • every entry is complete enough for all of its declared targets
 *   • env-var names are real UPPER_SNAKE names (they are pasted into live hosts)
 *   • the liveness rule holds: every entry carries `lastCommit` + `verifiedAt`
 *
 * The catalog deliberately holds a single, first-party panel, so the test also
 * pins that the third-party entries stay removed (and recorded in
 * REMOVED_PANELS) unless someone decides otherwise on purpose.
 */
import { PANELS, DEFAULT_PANEL_ID, REMOVED_PANELS, buildPanelDeployEnv, panelsForTarget, resolvePanel, panelRepoUrl, panelTcpPorts } from '../shared/panels'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const VALID_ENV = /^[A-Z][A-Z0-9_]*$/
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

console.log(`۱) ${PANELS.length} پنل در کاتالوگ — یکتایی و شناسه‌ها`)
const ids = PANELS.map((p) => p.id)
check('شناسه‌ها یکتا هستند', new Set(ids).size === ids.length, ids.join(','))
check('شناسه‌ها اسلاگ امن دارند', ids.every((id) => /^[a-z0-9-]+$/.test(id)))
check('پنل پیش‌فرض وجود دارد', ids.includes(DEFAULT_PANEL_ID), DEFAULT_PANEL_ID)
check('شناسهٔ ناشناس به پنل پیش‌فرض برمی‌گردد', resolvePanel('__nope__').id === DEFAULT_PANEL_ID)

console.log('\n۲) هر پنل برای همهٔ هدف‌هایش کامل است')
for (const p of PANELS) {
  const problems: string[] = []
  if (!p.name?.trim()) problems.push('name')
  if (!p.tagline?.trim()) problems.push('tagline')
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo)) problems.push('repo')
  if (!p.url.startsWith('https://github.com/')) problems.push('url')
  if (!p.panelPath?.startsWith('/')) problems.push('panelPath')
  if (!p.targets?.length) problems.push('targets')
  if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) problems.push('port')
  if (p.extraPorts?.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) problems.push('extraPorts')
  if (p.tcpPorts?.some((t) => !Number.isInteger(t.port) || t.port < 1 || t.port > 65535)) problems.push('tcpPorts')
  if (p.udpPorts?.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) problems.push('udpPorts')
  if (p.runtime === 'docker' && !p.hasDockerfile && !p.dockerImage) problems.push('docker needs hasDockerfile or dockerImage')
  if (p.runtime === 'docker' && p.hasDockerfile && !p.dockerfilePath) problems.push('dockerfilePath')
  if (p.runtime === 'python' && !p.startCommand) problems.push('python needs startCommand')
  if (p.dataVolume && !p.dataVolume.startsWith('/')) problems.push('dataVolume')
  check(`${p.id} — ساختار`, problems.length === 0, problems.join(' · '))
}

console.log('\n۳) نام متغیرهای محیطی واقعی هستند')
for (const p of PANELS) {
  const names = Object.values(p.env ?? {}).filter(Boolean) as string[]
  check(`${p.id} — env (${names.length})`, names.every((n) => VALID_ENV.test(n)), names.join(','))
}

console.log('\n۴) قاعدهٔ زنده‌بودن: هر ورودی lastCommit + verifiedAt دارد')
for (const p of PANELS) {
  check(`${p.id} — ${p.lastCommit ?? '—'} / ${p.verifiedAt ?? '—'}`,
    !!p.lastCommit && ISO_DAY.test(p.lastCommit) && !!p.verifiedAt && ISO_DAY.test(p.verifiedAt))
}
check('کاتالوگ توسط رابط‌های هدف سرو می‌شود', panelsForTarget('railway').length > 0 && panelsForTarget('render').length > 0 && panelsForTarget('vps').length === PANELS.length)

console.log('\n۵) پنلی که باید باشد — فقط پنل اختصاصی')
const expected = ['mizetusi']
for (const id of expected) check(`«${id}» در کاتالوگ هست`, ids.includes(id))
check('کاتالوگ فقط یک پنل دارد', PANELS.length === 1, `${PANELS.length} پنل`)
check('نامش «پنل اختصاصی ما» است', PANELS[0].name === 'پنل اختصاصی ما', PANELS[0].name)

console.log('\n۶) پنل‌های شخص ثالث حذف شده‌اند (ثبت‌شده در REMOVED_PANELS)')
const removed = REMOVED_PANELS.map((r) => r.id)
for (const id of ['stanngv2', 'pxpanel', '3xui', 'sui', 'pasarguard', 'luffy', 'wgeasy', 'remnawave']) {
  check(`«${id}» دیگر در کاتالوگ نیست`, !ids.includes(id))
  check(`«${id}» در REMOVED_PANELS ثبت شده`, removed.includes(id))
}
check('شناسهٔ حذف‌شده به پنل اختصاصی برمی‌گردد', resolvePanel('stanngv2').id === DEFAULT_PANEL_ID)

const miz = PANELS.find((p) => p.id === 'mizetusi')!
check('Mizetusi → مخزن درست', miz.repo === 'miladjahani/Mizetusi', miz.repo)
check('Mizetusi → پورت 8080', miz.port === 8080)
check('Mizetusi → مسیر پنل /login', miz.panelPath === '/login')
check('Mizetusi → healthcheck روی /health', miz.healthPath === '/health')
check('Mizetusi → هر سه هدف', ['railway', 'render', 'vps'].every((t) => miz.targets.includes(t)))
check('Mizetusi → رمز ادمین و کلید سشن', miz.env.adminPassword === 'ADMIN_PASSWORD' && miz.env.secretKey === 'JWT_SECRET')
check('Mizetusi → دیتای ماندگار روی /data', miz.dataVolume === '/data')
check('Mizetusi → پورت TCP ریلیتی', miz.extraPorts?.includes(8443) === true)
check('Mizetusi → پورت MTProto و HTTP هم فعال', miz.extraPorts?.includes(8446) === true && miz.extraPorts?.includes(8448) === true)
check(
  'Mizetusi → هر سه پورت پروکسی می‌گیرند',
  [8443, 8446, 8448].every((p) => (panelTcpPorts(miz) ?? []).some((t) => t.port === p)),
  JSON.stringify(panelTcpPorts(miz)),
)
check(
  'Mizetusi → قابلیت‌های MTProto و WebProxy روشن می‌شوند',
  ['mtproto', 'webproxy.web-http'].every((k) => (miz.capabilities ?? []).some((c) => c.key === k)),
  JSON.stringify(miz.capabilities),
)
check('Mizetusi → بدون نیاز به نصب xray روی هاست', miz.needsXray === false)
check('Mizetusi → کلون رسمی', panelRepoUrl(miz) === 'https://github.com/miladjahani/Mizetusi.git', panelRepoUrl(miz))
const railwayManifest = buildPanelDeployEnv(miz, 'railway', {
  adminPassword: 'admin-secret',
  secretKey: 'jwt-secret',
  railwayToken: 'project-secret',
  publicBaseUrl: 'https://panel.up.railway.app',
})
const railwayNames = railwayManifest.map((item) => item.name)
check(
  'Mizetusi → مانیفست کامل Railway',
  ['ADMIN_PASSWORD', 'JWT_SECRET', 'SQLITE_PATH', 'NEXUS_PLATFORM', 'XRAY_ENABLED', 'WARP_ENABLED', 'PORT', 'NEXUS_HTTP_PORT', 'PUBLIC_BASE_URL', 'NEXUS_RAILWAY_TOKEN'].every((name) => railwayNames.includes(name)),
  railwayNames.join(','),
)
check(
  'Mizetusi → secretها در مانیفست علامت‌گذاری شده‌اند',
  railwayManifest.filter((item) => item.secret).map((item) => item.name).sort().join(',') === 'ADMIN_PASSWORD,JWT_SECRET,NEXUS_RAILWAY_TOKEN',
)

console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
process.exit(failures ? 1 : 0)

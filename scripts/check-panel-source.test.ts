// Throwaway behaviour check for the admin-editable panel source override.
import {
  applyPanelRepo,
  DEFAULT_PANEL_REPO,
  normalizePanelRepo,
  resetPanelRepo,
  resolvePanel,
  panelRepoUrl,
} from '../shared/panels'

let failures = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

// 1. Normalisation of every shape an admin might paste.
eq('plain owner/name', normalizePanelRepo('miliopi/Lalaland'), 'miliopi/Lalaland')
eq('full github url', normalizePanelRepo('https://github.com/miliopi/Lalaland'), 'miliopi/Lalaland')
eq('url with .git', normalizePanelRepo('https://github.com/miliopi/Lalaland.git'), 'miliopi/Lalaland')
eq('trailing slash', normalizePanelRepo('miliopi/Lalaland/'), 'miliopi/Lalaland')
eq('whitespace padded', normalizePanelRepo('  miliopi/Lalaland\n'), 'miliopi/Lalaland')

// 2. Anything that could break the interpolated API URLs must be rejected.
eq('path traversal', normalizePanelRepo('foo/../../etc'), null)
eq('query string', normalizePanelRepo('a/b?x=1'), null)
eq('extra segments', normalizePanelRepo('a/b/c'), null)
eq('missing owner', normalizePanelRepo('/Lalaland'), null)
eq('empty', normalizePanelRepo(''), null)
eq('two words', normalizePanelRepo('not a repo'), null)

// 3. Applying the override is what every deploy path reads.
const before = resolvePanel(undefined).repo
eq('catalog default', before, DEFAULT_PANEL_REPO)
applyPanelRepo('miliopi/Lalaland')
eq('resolvePanel sees override', resolvePanel(undefined).repo, 'miliopi/Lalaland')
eq('repo url follows', resolvePanel(undefined).url, 'https://github.com/miliopi/Lalaland')
eq('invalid override ignored', (applyPanelRepo('nope'), resolvePanel(undefined).repo), 'miliopi/Lalaland')
// panelRepoUrl is the *clone* URL, which is what the VPS package clones.
eq('panelRepoUrl helper', panelRepoUrl(resolvePanel(undefined)), 'https://github.com/miliopi/Lalaland.git')

// 4. Reset returns to the address shipped with the code.
resetPanelRepo()
eq('reset restores default', resolvePanel(undefined).repo, DEFAULT_PANEL_REPO)
eq('reset restores url', resolvePanel(undefined).url, `https://github.com/${DEFAULT_PANEL_REPO}`)

// 5. The version probe and the bot read the same object.
eq('version probe target', (applyPanelRepo('miliopi/Lalaland'), resolvePanel(undefined).repo), 'miliopi/Lalaland')
resetPanelRepo()

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
if (failures) process.exit(1)

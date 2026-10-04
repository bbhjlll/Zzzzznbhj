/**
 * Unique, secret identity for every panel deployment.
 *
 * A deployment must never be a copy of another one. Each Railway/Render install
 * gets its own project name, its own admin password and its own session key, all
 * generated here — nothing is derived from the panel catalog's published
 * defaults (e.g. a documented factory password) and nothing is reused from an
 * earlier deployment. That keeps two properties at once:
 *
 *   • isolation — one compromised (or suspended) deployment can never expose or
 *     take down another, because no two deployments share a credential;
 *   • privacy   — the values exist only in this install's environment, so they
 *     are useless anywhere else.
 *
 * Every value comes from crypto.getRandomValues, never Math.random.
 */

/** Unambiguous alphabet (no 0/O/1/l/I) — 57 symbols ≈ 5.8 bits per character. */
const SECRET_ALPHABET = '23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const HEX = '0123456789abcdef'

/** Platform limit for a Railway/Render project or service name. */
const MAX_NAME_LENGTH = 63

function randomIndex(max: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % max
}

/** Random string of `length` symbols drawn from `alphabet`. */
export function randomString(length: number, alphabet: string = SECRET_ALPHABET): string {
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[randomIndex(alphabet.length)]
  return out
}

/**
 * A fresh panel admin password: 20 unambiguous alphanumerics (~116 bits of
 * entropy) containing at least one upper-case, one lower-case and one digit so
 * panels that enforce a password policy accept it.
 */
export function generateAdminPassword(): string {
  const chars = randomString(17).split('')
  chars.push(randomString(1, UPPER), randomString(1, LOWER), randomString(1, DIGITS))
  // Fisher–Yates so the guaranteed characters are not always in the last slots.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    const swap = chars[i]
    chars[i] = chars[j]
    chars[j] = swap
  }
  return chars.join('')
}

/** A 256-bit session/signing key as lowercase hex. */
export function generateSecretKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => HEX[b >> 4] + HEX[b & 15]).join('')
}

/** Short hyphen-safe suffix used to make an identifier unique. */
export function generateNameSuffix(length = 4): string {
  return randomString(length, NAME_ALPHABET)
}

/**
 * Return a name that `isTaken` does not report as used. The requested name is
 * kept whenever it is free; otherwise a random suffix is appended so two
 * deployments of the same panel never register the same identifier.
 */
export function uniqueName(base: string, isTaken: (name: string) => boolean): string {
  const clean =
    base.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'panel'
  if (!isTaken(clean)) return clean

  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = generateNameSuffix()
    const candidate = `${clean.slice(0, MAX_NAME_LENGTH - suffix.length - 1)}-${suffix}`
    if (!isTaken(candidate)) return candidate
  }
  const tail = `${Date.now().toString(36)}${generateNameSuffix(4)}`
  return `${clean.slice(0, MAX_NAME_LENGTH - tail.length - 1)}-${tail}`
}

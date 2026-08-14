/**
 * `.env` ships its optional keys present-but-empty (`DISTRIBUTION_FILE=`, `CHAIN_ID=`,
 * `IMPLEMENTATION=`), so an "unset" variable reaches Node as '' rather than undefined.
 * `??` only falls back on undefined, so it keeps the empty string and silently defeats
 * the default — that is how `yarn deploy:mainnet` came to look for a file named "".
 *
 * Read env through these helpers so absent and empty mean the same thing.
 */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function envOr(name: string, fallback: string): string {
  return env(name) ?? fallback
}

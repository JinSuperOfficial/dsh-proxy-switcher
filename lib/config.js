/**
 * Configuration for dsh-proxy-switcher: defaults, validation, the layered
 * priority chain, and atomic persistence.
 *
 * Priority (highest first), exactly as documented in the README:
 *
 *   1. runtime override   — what the settings page or `/proxy` command applied
 *                           to THIS process (never written unless the caller asks)
 *   2. environment        — DSH_PROXY_SWITCHER_* variables, read per call
 *   3. configuration file — DSH_HOME/proxy-switcher.json (or $DSH_PROXY_SWITCHER_CONFIG)
 *   4. defaults           — the built-in values in DEFAULT_CONFIG
 *
 * Layer 2 is deliberately re-read on every resolution rather than cached, so a
 * rotated variable (a password in particular) reaches the very next request.
 *
 * SECURITY: the config file can hold a plaintext password. It is written with
 * owner-only permissions where the platform supports them, and the API layer
 * never returns the value — only `hasPassword`. `passwordEnv` is the
 * recommended alternative and keeps the secret out of the file entirely.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { normalizeProxySpec, redactProxyUrl } from './proxy.js'

/** Current config document version. */
export const CONFIG_VERSION = 1

/** Sentinel a client sends to mean "keep whatever password is already stored". */
export const KEEP_SECRET = '__KEEP__'

/** The modes a user can select. */
export const MODES = ['direct', 'system', 'custom']

/** Default probe endpoint used by the connection test. */
export const DEFAULT_PROBE_URL = 'https://www.gstatic.com/generate_204'

/** Built-in defaults — layer 4 of the priority chain. */
export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  /** Master switch: false forces direct regardless of `mode`. */
  enabled: true,
  /** 'direct' | 'system' | 'custom' */
  mode: 'system',
  /** Profile id used when mode === 'custom'. */
  activeProfile: null,
  /** Saved proxies, switchable by id from the settings page. */
  profiles: [],
  /** Global no_proxy list, merged with the active profile's own list. */
  noProxy: 'localhost,127.0.0.1,::1',
  /** Never send loopback destinations through a proxy. */
  bypassLoopback: true,
  /** Endpoint used by the "test connection" action. */
  probeUrl: DEFAULT_PROBE_URL,
  /** Per-attempt timeout for probes and connections. */
  timeoutMs: 15000,
  /** What to do when mode is 'custom' but the profile is missing/empty. */
  onMissingProfile: 'block',
  /** Optional automatic fallback after repeated proxy failures. */
  fallback: { mode: 'off', failureThreshold: 3 },
  /** Write the effective proxy into process.env too (opt-in; affects children). */
  syncProcessEnv: false,
  /** Keep a bounded history of switch events for the settings page. */
  historyLimit: 50,
})

/** Environment variable names the switcher reads. Documented in the README. */
export const ENV_KEYS = Object.freeze({
  config: 'DSH_PROXY_SWITCHER_CONFIG',
  enabled: 'DSH_PROXY_SWITCHER_ENABLED',
  mode: 'DSH_PROXY_SWITCHER_MODE',
  profile: 'DSH_PROXY_SWITCHER_PROFILE',
  url: 'DSH_PROXY_SWITCHER_URL',
  noProxy: 'DSH_PROXY_SWITCHER_NO_PROXY',
})

/**
 * Resolve the config file path: an explicit override wins, then DSH_HOME, then
 * the user's home directory. The path is never inside the plugin package, so
 * upgrading the plugin cannot clobber a user's proxies.
 * @param explicit - a caller-supplied path (plugin config or env var).
 * @returns the absolute config file path.
 */
export function resolveConfigPath(explicit) {
  const fromEnv = process.env[ENV_KEYS.config]
  const candidate = explicit || fromEnv
  if (candidate) return resolve(String(candidate))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'proxy-switcher.json')
}

/** Coerce the many spellings of a boolean env var. */
function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(text)) return true
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(text)) return false
  return undefined
}

/** Clamp an integer into range, falling back when the input is unusable. */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * Validate and normalise one proxy profile.
 * @param raw - untrusted profile object.
 * @param index - position, used to synthesise a stable id.
 * @returns a cleaned profile, or null when it is unusable.
 */
export function normalizeProfile(raw, index = 0) {
  if (raw == null || typeof raw !== 'object') return null
  let spec
  try {
    spec = normalizeProxySpec(raw)
  } catch {
    return null
  }
  if (spec == null) return null
  const id = String(raw.id ?? '').trim() || `profile-${index + 1}`
  return {
    id: id.slice(0, 64),
    name: String(raw.name ?? '').trim().slice(0, 120) || `${spec.protocol}://${spec.host}:${spec.port}`,
    protocol: spec.protocol,
    host: spec.host,
    port: spec.port,
    username: spec.username ?? '',
    password: typeof raw.password === 'string' ? raw.password : '',
    passwordEnv: String(raw.passwordEnv ?? '').trim().slice(0, 128),
    noProxy: String(raw.noProxy ?? '').trim().slice(0, 2048),
  }
}

/**
 * Validate and normalise a whole config document, dropping unusable parts
 * rather than failing the load (a hand-edited file must not brick dsh).
 * @param raw - untrusted document.
 * @returns a complete, well-formed config.
 */
export function normalizeConfig(raw) {
  const source = raw != null && typeof raw === 'object' ? raw : {}
  const profiles = []
  const seen = new Set()
  const list = Array.isArray(source.profiles) ? source.profiles : []
  for (const [index, entry] of list.entries()) {
    const profile = normalizeProfile(entry, index)
    if (profile == null) continue
    let id = profile.id
    let suffix = 2
    while (seen.has(id)) id = `${profile.id}-${suffix++}`
    seen.add(id)
    profiles.push({ ...profile, id })
  }

  const mode = MODES.includes(source.mode) ? source.mode : DEFAULT_CONFIG.mode
  const fallbackSource = source.fallback != null && typeof source.fallback === 'object' ? source.fallback : {}
  const fallbackMode = fallbackSource.mode === 'direct' ? 'direct' : 'off'

  const activeRaw = source.activeProfile == null ? null : String(source.activeProfile)
  const activeProfile = activeRaw !== null && profiles.some((p) => p.id === activeRaw)
    ? activeRaw
    : (profiles[0]?.id ?? null)

  return {
    version: CONFIG_VERSION,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.enabled,
    mode,
    activeProfile,
    profiles,
    noProxy: typeof source.noProxy === 'string' ? source.noProxy.slice(0, 4096) : DEFAULT_CONFIG.noProxy,
    bypassLoopback: typeof source.bypassLoopback === 'boolean' ? source.bypassLoopback : DEFAULT_CONFIG.bypassLoopback,
    probeUrl: typeof source.probeUrl === 'string' && source.probeUrl ? source.probeUrl.slice(0, 2048) : DEFAULT_CONFIG.probeUrl,
    timeoutMs: clampInt(source.timeoutMs, 1000, 120000, DEFAULT_CONFIG.timeoutMs),
    onMissingProfile: source.onMissingProfile === 'direct' ? 'direct' : 'block',
    fallback: {
      mode: fallbackMode,
      failureThreshold: clampInt(fallbackSource.failureThreshold, 1, 100, DEFAULT_CONFIG.fallback.failureThreshold),
    },
    syncProcessEnv: typeof source.syncProcessEnv === 'boolean' ? source.syncProcessEnv : DEFAULT_CONFIG.syncProcessEnv,
    historyLimit: clampInt(source.historyLimit, 0, 500, DEFAULT_CONFIG.historyLimit),
  }
}

/**
 * Read the config file. A missing file is normal (first run); a corrupt file is
 * reported, not thrown, so the switcher still starts with defaults.
 * @param path - absolute config path.
 * @returns the normalised config plus load diagnostics.
 */
export function readConfigFile(path) {
  if (!existsSync(path)) return { config: normalizeConfig({}), exists: false, error: null }
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = text.trim() === '' ? {} : JSON.parse(text)
    return { config: normalizeConfig(parsed), exists: true, error: null }
  } catch (error) {
    return { config: normalizeConfig({}), exists: true, error: `配置文件 ${path} could not be parsed: ${error.message}` }
  }
}

/**
 * Write the config file atomically, owner-readable only.
 * @param path - absolute config path.
 * @param config - the document to persist.
 * @returns the path written.
 */
export function writeConfigFile(path, config) {
  const directory = dirname(path)
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort: Windows ACLs already restrict the profile directory.
  }
  return path
}

/**
 * The environment layer. Only keys that are actually present contribute, so an
 * unset variable never overrides the file with an empty value.
 * @param env - environment source (defaults to process.env).
 * @returns a partial config plus the list of keys that contributed.
 */
export function readEnvLayer(env = process.env) {
  const partial = {}
  const applied = []

  const enabled = parseBoolean(env[ENV_KEYS.enabled])
  if (enabled !== undefined) {
    partial.enabled = enabled
    applied.push(ENV_KEYS.enabled)
  }

  const mode = String(env[ENV_KEYS.mode] ?? '').trim().toLowerCase()
  if (mode) {
    if (mode === 'none' || mode === 'off') {
      partial.enabled = false
      applied.push(ENV_KEYS.mode)
    } else if (MODES.includes(mode)) {
      partial.mode = mode
      applied.push(ENV_KEYS.mode)
    }
  }

  // An explicit URL implies an ad-hoc custom proxy, which outranks a profile id.
  const url = String(env[ENV_KEYS.url] ?? '').trim()
  if (url) {
    partial.mode = 'custom'
    partial.__adHocUrl = url
    applied.push(ENV_KEYS.url)
  }

  const profile = String(env[ENV_KEYS.profile] ?? '').trim()
  if (profile) {
    partial.activeProfile = profile
    if (partial.mode === undefined) partial.mode = 'custom'
    applied.push(ENV_KEYS.profile)
  }

  const noProxy = env[ENV_KEYS.noProxy]
  if (typeof noProxy === 'string' && noProxy.trim() !== '') {
    partial.noProxy = noProxy
    applied.push(ENV_KEYS.noProxy)
  }

  return { partial, applied }
}

/**
 * Merge the four layers into an effective config.
 * @param fileConfig - layer 3.
 * @param options.env - environment source.
 * @param options.runtime - layer 1 override (partial config).
 * @returns `{ config, sources }` where `sources` names the winning layer per field.
 */
export function resolveLayers(fileConfig, options = {}) {
  const env = options.env ?? process.env
  const runtime = options.runtime ?? null
  const { partial: envPartial, applied } = readEnvLayer(env)

  const merged = { ...DEFAULT_CONFIG, ...fileConfig }
  const sources = {
    enabled: 'default',
    mode: 'default',
    activeProfile: 'default',
    noProxy: 'default',
    adHocUrl: null,
    env: applied,
    runtime: [],
  }

  for (const key of ['enabled', 'mode', 'activeProfile', 'noProxy']) {
    if (Object.hasOwn(envPartial, key)) {
      merged[key] = envPartial[key]
      sources[key] = 'env'
    }
  }
  if (envPartial.__adHocUrl) sources.adHocUrl = envPartial.__adHocUrl

  if (runtime != null) {
    for (const key of Object.keys(runtime)) {
      if (key === '__adHocUrl') {
        sources.adHocUrl = runtime[key]
        sources.runtime.push(key)
        continue
      }
      if (key === 'fallback' || key === 'profiles' || key === 'probeUrl' || key === 'timeoutMs'
        || key === 'bypassLoopback' || key === 'onMissingProfile' || key === 'syncProcessEnv') {
        merged[key] = runtime[key]
        sources.runtime.push(key)
        continue
      }
      if (key === 'enabled' || key === 'mode' || key === 'activeProfile' || key === 'noProxy') {
        merged[key] = runtime[key]
        sources[key] = 'runtime'
        sources.runtime.push(key)
      }
    }
  }

  const config = normalizeConfig(merged)
  // The ad-hoc URL survives normalisation as a synthetic profile so everything
  // downstream (apply, status, test) treats it like any other proxy.
  if (sources.adHocUrl) {
    const spec = safeSpec(sources.adHocUrl)
    if (spec) {
      const adHoc = {
        id: AD_HOC_PROFILE_ID,
        name: `${spec.protocol}://${spec.host}:${spec.port}`,
        protocol: spec.protocol,
        host: spec.host,
        port: spec.port,
        username: spec.username ?? '',
        password: spec.password ?? '',
        passwordEnv: '',
        noProxy: '',
      }
      config.profiles = [adHoc, ...config.profiles.filter((p) => p.id !== AD_HOC_PROFILE_ID)]
      config.activeProfile = AD_HOC_PROFILE_ID
      config.mode = 'custom'
      sources.activeProfile = 'env-or-runtime-url'
    }
  }

  return { config, sources }
}

/** Synthetic profile id backing DSH_PROXY_SWITCHER_URL. */
export const AD_HOC_PROFILE_ID = '__env_url__'

/** `normalizeProxySpec` that returns null instead of throwing. */
function safeSpec(input) {
  try {
    return normalizeProxySpec(input)
  } catch {
    return null
  }
}

/** Read the ambient system/env proxy configuration, as Node itself would. */
export function readSystemProxy(env = process.env) {
  const pick = (...names) => {
    for (const name of names) {
      const value = env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }
  const httpProxy = pick('HTTP_PROXY', 'http_proxy')
  const httpsProxy = pick('HTTPS_PROXY', 'https_proxy')
  const allProxy = pick('ALL_PROXY', 'all_proxy')
  const noProxy = pick('NO_PROXY', 'no_proxy')
  const chosen = allProxy ?? httpsProxy ?? httpProxy
  const spec = chosen ? safeSpec(chosen) : null
  return {
    spec,
    // SECURITY: these three strings end up in the status payload the settings
    // page renders, and a proxy URL can carry `user:password@`. The dialable
    // secret stays in `spec` (never returned to a client); the descriptive
    // strings are masked here so no caller has to remember to do it.
    httpProxy: httpProxy === undefined ? undefined : redactProxyUrl(httpProxy),
    httpsProxy: httpsProxy === undefined ? undefined : redactProxyUrl(httpsProxy),
    allProxy: allProxy === undefined ? undefined : redactProxyUrl(allProxy),
    noProxy,
    /** Node's own env-proxy opt-in; recorded so the status can explain it. */
    nodeUseEnvProxy: env.NODE_USE_ENV_PROXY,
  }
}

/**
 * Turn a stored profile into dialable settings, resolving `passwordEnv` at call
 * time so a rotated variable takes effect on the next request.
 * @param profile - a normalised profile.
 * @param env - environment source.
 * @returns the profile with a concrete password, or an `error` explaining why not.
 */
export function materializeProfile(profile, env = process.env) {
  if (profile == null) return { spec: null, error: '未选择任何代理配置' }
  let password = profile.password ?? ''
  let passwordSource = password ? 'inline' : 'none'
  if (profile.passwordEnv) {
    const fromEnv = env[profile.passwordEnv]
    if (typeof fromEnv === 'string' && fromEnv !== '') {
      password = fromEnv
      passwordSource = 'env'
    } else if (!password) {
      return {
        spec: null,
        error: `代理配置 "${profile.id}" 引用了环境变量 ${profile.passwordEnv}，但该变量未设置`,
      }
    }
  }
  const spec = safeSpec({
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    password,
  })
  if (spec == null) return { spec: null, error: `代理配置 "${profile.id}" 没有可用的主机` }
  return { spec, passwordSource, noProxy: profile.noProxy }
}

/**
 * The redacted, browser-safe view of a config document.
 * The password is replaced by a presence flag so the settings page can render a
 * masked field and send back {@link KEEP_SECRET} when the user does not retype it.
 * @param config - the effective config.
 * @returns a deep copy safe to return over HTTP.
 */
export function redactConfig(config) {
  return {
    ...config,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      password: '',
      hasPassword: Boolean(profile.password),
      hasPasswordEnv: Boolean(profile.passwordEnv),
      /** Masked preview, e.g. socks5://user:***@127.0.0.1:1080 */
      maskedUrl: maskProfile(profile),
    })),
  }
}

/** A display URL for a profile with its credentials masked. */
export function maskProfile(profile) {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host
  const credentials = profile.username ? `${profile.username}:***@` : ''
  return `${profile.protocol}://${credentials}${host}:${profile.port}`
}

/**
 * Apply an incoming (possibly partial, possibly secret-bearing) config patch
 * from the settings page onto the stored config.
 *
 * Password handling: an omitted `password` or the {@link KEEP_SECRET} sentinel
 * preserves the stored value; an empty string clears it.
 *
 * @param current - the currently stored config.
 * @param patch - the incoming document.
 * @returns the merged, normalised config.
 */
export function mergeConfigPatch(current, patch) {
  if (patch == null || typeof patch !== 'object') return current
  const merged = { ...current }

  for (const key of ['enabled', 'mode', 'activeProfile', 'noProxy', 'bypassLoopback', 'probeUrl', 'timeoutMs',
    'onMissingProfile', 'syncProcessEnv', 'historyLimit']) {
    if (Object.hasOwn(patch, key)) merged[key] = patch[key]
  }
  if (Object.hasOwn(patch, 'fallback') && patch.fallback != null && typeof patch.fallback === 'object') {
    merged.fallback = { ...current.fallback, ...patch.fallback }
  }

  if (Array.isArray(patch.profiles)) {
    const previous = new Map(current.profiles.map((profile) => [profile.id, profile]))
    merged.profiles = patch.profiles.map((incoming, index) => {
      const normalized = normalizeProfile(incoming, index)
      if (normalized == null) return null
      const before = previous.get(normalized.id)
      let password = normalized.password
      if (incoming.password === undefined || incoming.password === KEEP_SECRET) {
        password = before?.password ?? ''
      }
      return { ...normalized, password }
    }).filter(Boolean)
  } else if (patch.profiles !== undefined) {
    merged.profiles = current.profiles
  }

  return normalizeConfig(merged)
}

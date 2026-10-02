/**
 * Process-wide transport control: how a resolved proxy policy actually reaches
 * the socket.
 *
 * THE MECHANISM
 * -------------
 * dsh makes its outbound calls — LLM chat completions, web search, web fetch,
 * MCP over HTTP, model discovery — with plain `fetch()`. Node's built-in `fetch`
 * resolves its transport from the well-known global-dispatcher slot
 * `Symbol.for('undici.globalDispatcher.1')` on `globalThis`; the npm `undici`
 * package writes exactly that slot (plus its `.2` successor) from
 * `setGlobalDispatcher()`. So installing a dispatcher from npm undici retargets
 * Node's built-in `fetch`, and installing a different one retargets it again —
 * in a running process, with no wrapper and no restart.
 *
 * This is the same mechanism `@deepseek-ai/dsh-http-proxy` uses at launch, which
 * is why this plugin prefers to drive THAT package rather than race it:
 *
 *   - strategy `delegate` (preferred): the policy is expressible as
 *     `http(s)://` proxy URLs, and `@deepseek-ai/dsh-http-proxy` is present. We
 *     call its exported `installProxyFromEnvironment()` with a synthetic
 *     environment. That keeps three things agreeing in one step: undici's global
 *     dispatcher, `proxyRouteFor()` (which `dsh-web-fetch-http` consults to pin a
 *     request to the dispatcher it validated), and the proxy environment names
 *     child processes inherit.
 *   - strategy `own`: the policy is SOCKS5 (the shipped seam rejects SOCKS by
 *     design), or that package is absent (older dsh). We install our own
 *     dispatcher: an `Agent` whose per-origin factory routes through the policy,
 *     with a hand-written SOCKS5 connector. A narrow `fetch` wrapper covers the
 *     one caller that would otherwise miss it — see {@link INTERCEPT_RULE}.
 *
 * INTERCEPT RULE — WHY THERE IS NO `fetch` WRAPPER
 * ------------------------------------------------
 * Node's built-in `fetch` carries its OWN undici copy (7.29.0 on the Node
 * 24.18.1 this harness runs). The harness ships a different one (8.11.2). The
 * two do not share a handler API:
 *
 *   - a dispatcher installed in the GLOBAL slot is adapted by Node, so a
 *     dispatcher of either generation works there — this is why
 *     `dsh-http-proxy` installs its agent in the slot and why dsh is proxied at
 *     all today;
 *   - a dispatcher passed EXPLICITLY as `init.dispatcher` is used raw, so a
 *     newer-generation dispatcher fails the built-in fetch with
 *     `UND_ERR_INVALID_ARG: invalid onRequestStart method`.
 *
 * Measured on this runtime (probe-dispatcher-placements): the global slot routes
 * http, https and SOCKS5 correctly for `Agent`, `Agent{factory}` and
 * `ProxyAgent` alike; an explicit 8.x dispatcher always fails; and
 * same-generation calls — `undici.fetch(url, { dispatcher })`, which is exactly
 * what `dsh-web-fetch-http` does — always work.
 *
 * A `fetch` wrapper would therefore have to attach an explicit dispatcher, which
 * is the one placement that cannot work across generations. So the switcher
 * steers the process through the global slot only, and the connectivity test uses
 * the same-instance `undici.fetch` instead of the built-in one.
 *
 * A consequence worth knowing: `dsh-web-fetch-http` pins a request to addresses
 * it validated, using its own agent, whenever `proxyRouteFor()` reports the URL
 * is not proxied. Under a delegated `http(s)` policy the route reports proxied,
 * so the web_fetch tool follows the policy. Under a SOCKS5 policy the shipped
 * seam refuses the URL, the route reports direct, and web_fetch keeps its pinned
 * direct agent — the one path a SOCKS proxy cannot cover without patching dsh.
 * It is recorded under Known limitations in the README.
 *
 * Graceful switching: a switch installs the new transport and then closes the
 * previous one with `close()` — never `destroy()`. Requests already in flight
 * (a streaming turn) finish on the transport that started them.
 *
 * TWO UNDICI COPIES
 * -----------------
 * Because a profile can hold more than one `undici`, this module resolves it
 * THROUGH `@deepseek-ai/dsh-http-proxy` whenever that package is present, so the
 * dispatcher we build and the dispatcher the harness installs come from one
 * instance. The plain `undici` specifier is only a fallback for a dsh version
 * that ships no proxy package at all.
 */
import { createRequire } from 'node:module'
import { createSocks5Connector, isLoopbackHost, matchesNoProxy, proxyDialUrl, describeProxy } from './proxy.js'

/** Loopback entries merged into every published bypass list, as the shipped seam does. */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']

/** The resolved undici module — exactly one copy per process, chosen once. */
let undiciCache = null

/** Where the cached instance came from, for the status view. */
let undiciSource = null

/** Whether this undici's `ProxyAgent` can tunnel SOCKS5 on its own (8.x can). */
let nativeSocks = false

/**
 * Whether the resolved undici speaks SOCKS5 itself.
 * @returns true when a `socks5://` URI can be handed straight to `ProxyAgent`.
 */
export function supportsNativeSocks() {
  return nativeSocks
}

/**
 * Resolve `undici`, preferring the instance the harness itself installed.
 *
 * See the module docstring: resolving through `@deepseek-ai/dsh-http-proxy` is
 * what keeps one process from mixing a dispatcher built by one undici copy with
 * a global slot owned by another.
 *
 * @returns the undici module namespace, cached after the first success.
 * @throws {Error} when neither route resolves (a broken install).
 */
export async function resolveUndici() {
  if (undiciCache !== null) return undiciCache
  const require = createRequire(import.meta.url)
  const failures = []

  /** Feature-detect SOCKS5 support, then cache the module. */
  const adopt = (mod, source) => {
    nativeSocks = detectNativeSocks(mod)
    undiciCache = mod
    undiciSource = source
    return undiciCache
  }

  try {
    const proxyPackage = require.resolve('@deepseek-ai/dsh-http-proxy/package.json')
    const hostRequire = createRequire(proxyPackage)
    return adopt(hostRequire('undici'), `dsh-http-proxy -> ${hostRequire.resolve('undici')}`)
  } catch (error) {
    failures.push(`through @deepseek-ai/dsh-http-proxy: ${error?.message ?? error}`)
  }

  try {
    return adopt(require('undici'), `direct -> ${require.resolve('undici')}`)
  } catch (error) {
    failures.push(`direct: ${error?.message ?? error}`)
  }

  throw new Error(`dsh-proxy-switcher: 无法解析 'undici'。已尝试 — ${failures.join('; ')}`)
}

/**
 * Whether a `socks5://` URI can be handed to this module's `ProxyAgent`.
 *
 * Constructing the agent performs no I/O, so this is a safe probe; undici 7
 * rejects the URI with an `InvalidArgumentError` and undici 8 accepts it and
 * dispatches to its own `Socks5ProxyAgent`.
 *
 * @param mod - the undici module namespace.
 * @returns true when native SOCKS5 tunnelling is available.
 */
function detectNativeSocks(mod) {
  if (typeof mod.ProxyAgent !== 'function') return false
  try {
    const probe = new mod.ProxyAgent({ uri: 'socks5://127.0.0.1:1' })
    Promise.resolve(probe.close()).catch(() => {})
    return true
  } catch {
    return false
  }
}

/**
 * The already-resolved undici module.
 * @returns the module namespace.
 * @throws {Error} when {@link resolveUndici} has not succeeded yet.
 */
export function undiciModule() {
  if (undiciCache === null) {
    throw new Error('dsh-proxy-switcher: 尚未解析 undici —— 请先 await resolveUndici()')
  }
  return undiciCache
}

/** Which undici copy is in use, for diagnostics. */
export function undiciOrigin() {
  return undiciSource
}

/**
 * The resolved undici's own version, read from its package metadata because the
 * module namespace does not always expose one.
 * @returns the version string, or null when it cannot be read.
 */
export function undiciVersion() {
  if (undiciCache === null) return null
  try {
    const require = createRequire(import.meta.url)
    const proxyPackage = require.resolve('@deepseek-ai/dsh-http-proxy/package.json')
    const hostRequire = createRequire(proxyPackage)
    return hostRequire('undici/package.json').version ?? null
  } catch {
    try {
      return createRequire(import.meta.url)('undici/package.json').version ?? null
    } catch {
      return null
    }
  }
}

/** Every proxy environment name this module writes, lowercase first. */
const ENV_NAMES = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'all_proxy', 'ALL_PROXY',
  'no_proxy', 'NO_PROXY',
]

/**
 * A resolved policy, in the shape both strategies understand.
 * @typedef {object} TransitPolicy
 * @property {'direct'|'proxied'} kind
 * @property {object|null} spec - the normalised proxy spec, when a single proxy serves both schemes.
 * @property {string|undefined} httpProxy - dial URL for `http:` origins, when env-expressible.
 * @property {string|undefined} httpsProxy - dial URL for `https:` origins, when env-expressible.
 * @property {string} noProxy - the effective bypass list.
 * @property {string} source - 'direct' | 'system' | 'custom', for diagnostics.
 * @property {string} label - a masked, human-readable description.
 * @property {boolean} socks - true when the only route is a SOCKS5 tunnel.
 */

/**
 * Build the direct policy.
 * @param {string} noProxy - bypass list to publish.
 * @returns {TransitPolicy}
 */
export function directPolicy(noProxy = LOOPBACK_NO_PROXY.join(',')) {
  return { kind: 'direct', spec: null, httpProxy: undefined, httpsProxy: undefined, noProxy, source: 'direct', label: '直连（不使用代理）', socks: false }
}

/**
 * Build a policy for one HTTP(S) proxy serving both schemes.
 * @param {object} spec - normalised proxy spec.
 * @param {string} noProxy - bypass list.
 * @param {string} source - 'system' | 'custom'.
 * @returns {TransitPolicy}
 */
export function httpPolicy(spec, noProxy, source) {
  const url = proxyDialUrl(spec)
  return {
    kind: 'proxied', spec,
    httpProxy: url, httpsProxy: url,
    noProxy, source, label: describeProxy(spec).url, socks: false,
  }
}

/**
 * Build a policy for a SOCKS5 proxy.
 * @param {object} spec - normalised spec with protocol `socks5`.
 * @param {string} noProxy - bypass list.
 * @param {string} source - 'system' | 'custom'.
 * @returns {TransitPolicy}
 */
export function socksPolicy(spec, noProxy, source) {
  return {
    kind: 'proxied', spec,
    httpProxy: undefined, httpsProxy: undefined,
    noProxy, source, label: describeProxy(spec).url, socks: true,
  }
}

/**
 * Merge a caller's bypass list with the mandatory loopback entries.
 * @param {...(string|undefined)} lists - raw `no_proxy` strings.
 * @returns the merged list, without duplicates.
 */
export function mergeNoProxy(...lists) {
  const seen = new Set()
  for (const list of lists) {
    for (const entry of String(list ?? '').split(/[\s,]+/)) {
      const trimmed = entry.trim()
      if (trimmed) seen.add(trimmed)
    }
  }
  for (const entry of LOOPBACK_NO_PROXY) seen.add(entry)
  return [...seen].join(',')
}

/**
 * Whether a URL is exempt from the policy's proxy.
 * @param {URL} url - the destination.
 * @param {TransitPolicy} policy - the policy in force.
 * @returns true when the request must go direct.
 */
export function bypasses(url, policy) {
  if (isLoopbackHost(url.hostname)) return true
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80)
  return matchesNoProxy(url.hostname, port, policy.noProxy)
}

/**
 * Owns the process's outbound transport. One instance per process; the caller
 * (the switcher) decides when the policy changes.
 */
export class TransportController {
  /**
   * @param options.logger - sink for installation diagnostics.
   */
  constructor(options = {}) {
    this.logger = options.logger ?? console
    /** Capability probe results, filled by {@link detect}. */
    this.capabilities = { undici: true, dshHttpProxy: false, dshHttpProxyVersion: null, dshHttpProxyError: null }
    /** Whether {@link detect} has run; {@link apply} runs it on demand. */
    this.detected = false
    /** Which strategy the last successful apply used. */
    this.strategy = 'none'
    /** The policy currently installed. */
    this.policy = null
    /** The dispatcher that was global before this plugin touched anything. */
    this.bootDispatcher = null
    /** The dispatcher an install left global, so restore can verify it moved back. */
    this.installedDispatcher = null
    /** The proxy environment exactly as it was before this plugin touched it. */
    this.bootEnv = null
    /** The disposer returned by the shipped seam, when delegating. */
    this.delegateDispose = null
    /** Our own dispatcher, when not delegating. */
    this.ownDispatcher = null
    this.installedAt = null
    this.lastSwitchMs = null
    this.switchCount = 0
    this.diagnostics = []
  }

  /**
   * Discover which strategies this process can use.
   *
   * `undici` is an optional peer: resolving it is what decides whether the plugin
   * can do anything at all. The shipped proxy package is optional by design,
   * because only dsh 0.2+ carries it.
   * @returns the capability record.
   */
  async detect() {
    try {
      await resolveUndici()
      this.capabilities.undici = typeof undiciModule().Agent === 'function'
      this.capabilities.undiciSource = undiciOrigin()
      this.capabilities.undiciVersion = undiciVersion()
      this.capabilities.nativeSocks5 = supportsNativeSocks()
    } catch (error) {
      this.capabilities.undici = false
      this.capabilities.undiciError = String(error?.message ?? error)
    }
    try {
      const mod = await import('@deepseek-ai/dsh-http-proxy')
      this.dshHttpProxy = mod
      this.capabilities.dshHttpProxy = typeof mod.installProxyFromEnvironment === 'function'
      try {
        const pkg = await import('@deepseek-ai/dsh-http-proxy/package.json', { with: { type: 'json' } })
        this.capabilities.dshHttpProxyVersion = pkg.default?.version ?? null
      } catch {
        this.capabilities.dshHttpProxyVersion = null
      }
    } catch (error) {
      this.dshHttpProxy = null
      this.capabilities.dshHttpProxy = false
      this.capabilities.dshHttpProxyError = String(error?.message ?? error)
    }
    this.detected = true
    return this.capabilities
  }

  /**
   * Which strategy a policy would use, without applying it.
   * @param {TransitPolicy} policy - the candidate policy.
   * @returns {'delegate'|'own'}
   */
  strategyFor(policy) {
    if (this.capabilities.dshHttpProxy !== true) return 'own'
    // The shipped seam accepts only http(s) proxy URLs; SOCKS5 is refused by
    // design, so a SOCKS policy must use our own connector.
    if (policy.socks) return 'own'
    return 'delegate'
  }

  /**
   * Apply a policy to the process.
   *
   * Any previously installed transport is closed afterwards with `close()`, so
   * in-flight requests drain on the transport that started them.
   *
   * @param {TransitPolicy} policy - the policy to install.
   * @param options.restoreFirst - force a restore before installing (default true).
   * @returns the strategy used.
   */
  async apply(policy, options = {}) {
    const started = Date.now()
    // Capability detection is lazy so a caller cannot get the fallback strategy
    // by forgetting to await detect() first.
    if (!this.detected) await this.detect()
    if (options.restoreFirst !== false) await this.restore({ quiet: true })
    this.captureBootState()

    const strategy = this.strategyFor(policy)
    this.diagnostics = []
    const report = (message) => {
      this.diagnostics.push(String(message))
      this.logger.warn?.(`dsh-proxy-switcher: 代理策略提示: ${message}`)
    }

    if (strategy === 'delegate') {
      this.delegateDispose = await this.dshHttpProxy.installProxyFromEnvironment(envLookupFor(policy), report)
    } else {
      const { setGlobalDispatcher } = undiciModule()
      this.ownDispatcher = createOwnDispatcher(policy)
      setGlobalDispatcher(this.ownDispatcher)
      this.writeEnv(policy)
    }
    // Remember what the install left global, so restore can tell whether the
    // unwind actually moved it back.
    this.installedDispatcher = undiciModule().getGlobalDispatcher()

    this.strategy = strategy
    this.policy = policy
    this.installedAt = Date.now()
    this.lastSwitchMs = this.installedAt - started
    this.switchCount += 1
    return strategy
  }

  /**
   * Give the process back its launch transport and environment.
   * Restores the original `fetch` first so nothing can pick up a half-torn-down
   * policy, then unwinds the installed transport.
   * @param options.quiet - skip the log line.
   */
  async restore(options = {}) {
    if (this.strategy === 'none') return
    const previous = this.ownDispatcher
    const installedByUs = this.installedDispatcher
    this.ownDispatcher = null
    this.installedDispatcher = null
    if (this.delegateDispose) {
      const dispose = this.delegateDispose
      this.delegateDispose = null
      try {
        await dispose()
      } catch (error) {
        this.logger.warn?.(`dsh-proxy-switcher: 无法撤销委托的代理策略: ${error?.message ?? error}`)
      }
    }
    if (previous) {
      try {
        await previous.close()
      } catch {
        // Closing an already-closed agent is not an error worth reporting.
      }
    }
    // Safety net: a dispatcher we closed must never be left as the process
    // transport, or every later request would fail on a dead pool. This can only
    // happen if an unwind did not move the slot back, so reinstall the launch
    // dispatcher rather than leave the process unable to reach the network.
    const { Agent, getGlobalDispatcher, setGlobalDispatcher } = undiciModule()
    if (installedByUs !== null && getGlobalDispatcher() === installedByUs) {
      this.logger.warn?.('dsh-proxy-switcher: 委托包把自己的 dispatcher 留在了全局槽位；正在恢复启动时的传输')
      if (this.bootDispatcher !== null && this.bootDispatcher !== installedByUs) {
        setGlobalDispatcher(this.bootDispatcher)
      } else {
        setGlobalDispatcher(new Agent())
      }
    }
    this.restoreEnv()
    this.strategy = 'none'
    this.policy = null
    this.installedAt = null
    if (options.quiet !== true) this.logger.info?.('dsh-proxy-switcher: 已收到恢复请求；启动时的传输已恢复')
  }

  /** Snapshot the launch dispatcher and environment exactly once. */
  captureBootState() {
    if (this.bootDispatcher === null) this.bootDispatcher = undiciModule().getGlobalDispatcher()
    if (this.bootEnv === null) {
      this.bootEnv = {}
      for (const name of [...ENV_NAMES, 'NODE_USE_ENV_PROXY']) this.bootEnv[name] = process.env[name]
    }
  }

  // -------------------------------------------------------------- environment

  /**
   * Publish the policy through the proxy environment names, which is how
   * consumers that read an environment rather than a dispatcher — `node:http`'s
   * `proxyEnv`, and every spawned child (pnpm, curl, git) — see the same answer.
   *
   * A SOCKS value is published for the tools that understand it, and
   * `NODE_USE_ENV_PROXY` is withheld for as long as it stands: Node parses
   * `HTTP_PROXY`/`HTTPS_PROXY` before running a child program and exits on a
   * scheme it cannot use, so leaving the flag set would stop every Node child
   * from starting.
   *
   * @param {TransitPolicy} policy - the policy being installed.
   */
  writeEnv(policy) {
    if (policy.kind === 'direct') {
      for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
      process.env.no_proxy = process.env.NO_PROXY = policy.noProxy
      return
    }
    const url = policy.socks ? proxyDialUrl(policy.spec) : policy.httpProxy
    for (const name of ENV_NAMES) Reflect.deleteProperty(process.env, name)
    process.env.http_proxy = process.env.HTTP_PROXY = url
    process.env.https_proxy = process.env.HTTPS_PROXY = url
    process.env.all_proxy = process.env.ALL_PROXY = url
    process.env.no_proxy = process.env.NO_PROXY = policy.noProxy
    if (policy.socks) Reflect.deleteProperty(process.env, 'NODE_USE_ENV_PROXY')
  }

  /** Put every proxy environment name back the way it was before this plugin ran. */
  restoreEnv() {
    if (this.bootEnv === null) return
    for (const [name, value] of Object.entries(this.bootEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }

  // ------------------------------------------------------------------ wrapping

  // ------------------------------------------------------------------- status

  /**
   * What the transport layer is doing right now, for the status payload.
   * @returns a JSON-safe snapshot with no credentials.
   */
  status() {
    return {
      strategy: this.strategy,
      capabilities: this.capabilities,
      policyKind: this.policy?.kind ?? null,
      policySource: this.policy?.source ?? null,
      policyLabel: this.policy?.label ?? '',
      socks: this.policy?.socks ?? false,
      switchCount: this.switchCount,
      lastSwitchMs: this.lastSwitchMs,
      installedAt: this.installedAt ? new Date(this.installedAt).toISOString() : null,
      diagnostics: this.diagnostics,
      globalDispatcherIsOurs: this.ownDispatcher !== null
        ? undiciModule().getGlobalDispatcher() === this.ownDispatcher
        : this.delegateDispose !== null,
    }
  }
}

/**
 * Build a dispatcher that routes by a fixed policy: an `Agent` whose per-origin
 * factory returns the right transport for that origin, so bypass entries and
 * scheme differences are decided per request by the same matcher the status view
 * reports.
 *
 * @param {TransitPolicy} policy - the policy to route by.
 * @returns an undici dispatcher.
 */
export function createOwnDispatcher(policy) {
  const { Agent, Pool, ProxyAgent } = undiciModule()
  // A proxy-free policy has no URI to hand `ProxyAgent`, so every origin gets a
  // plain pool. Without this branch the factory falls through to
  // `ProxyAgent({ uri: undefined })`, which throws
  // `InvalidArgumentError: Proxy uri is mandatory` and surfaces as
  // `UND_ERR_INVALID_ARG` on the request.
  if (policy.kind !== 'proxied') {
    return new Agent({ factory: (origin, options) => new Pool(origin, options) })
  }
  return new Agent({
    factory(origin, options) {
      const url = origin instanceof URL ? origin : new URL(origin.toString())
      if (bypasses(url, policy)) return new Pool(url.origin, options)
      if (policy.socks) {
        // undici 8 tunnels SOCKS5 through its own Socks5ProxyAgent, which knows
        // the protocol better than a hand-rolled connector and shares the
        // instance that owns the global slot. Only an older undici (7.x) needs
        // the connector below.
        if (supportsNativeSocks()) return new ProxyAgent({ ...options, uri: proxyDialUrl(policy.spec) })
        return new Agent({
          ...options,
          connect: createSocks5Connector({
            proxyHost: policy.spec.host,
            proxyPort: policy.spec.port,
            username: policy.spec.username,
            password: policy.spec.password,
            timeout: options?.connect?.timeout ?? 15000,
          }),
        })
      }
      return new ProxyAgent({ ...options, uri: policy.httpProxy ?? policy.httpsProxy })
    },
  })
}

/**
 * Adapt a policy to the `EnvLookup` the shipped proxy package expects.
 *
 * Only the names that package reads are answered, and a proxy-free policy
 * answers nothing, which is what makes it install its direct dispatcher.
 *
 * @param {TransitPolicy} policy - the policy to express as an environment.
 * @returns an object with `get(name)`.
 */
export function envLookupFor(policy) {
  const values = policy.kind === 'direct'
    ? { no_proxy: policy.noProxy, NO_PROXY: policy.noProxy }
    : {
        http_proxy: policy.httpProxy, HTTP_PROXY: policy.httpProxy,
        https_proxy: policy.httpsProxy, HTTPS_PROXY: policy.httpsProxy,
        no_proxy: policy.noProxy, NO_PROXY: policy.noProxy,
      }
  return {
    get(name) {
      const value = values[name]
      return value === undefined || value === '' ? undefined : { value }
    },
  }
}

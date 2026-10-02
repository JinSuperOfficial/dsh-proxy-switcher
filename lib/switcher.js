/**
 * The runtime proxy switcher: policy resolution, application, diagnostics, and
 * the connection test.
 *
 * POLICY RESOLUTION reads four layers (runtime override > environment > config
 * file > defaults) and produces one of four outcomes:
 *
 *   - `direct`  — no proxy; the process talks to the network itself.
 *   - `system`  — follow the proxy environment the harness was launched with
 *                 (`http_proxy`/`https_proxy`/`all_proxy`, lowercase first).
 *   - `custom`  — a saved profile, chosen by id.
 *   - blocked   — `custom` mode with no usable profile. Requests fail with a
 *                 clear error instead of silently leaking traffic direct.
 *
 * MECHANISM lives in `transport.js`; this module owns WHAT the policy should be,
 * WHEN it changes, and how to explain the result.
 */
import {
  AD_HOC_PROFILE_ID,
  DEFAULT_CONFIG,
  KEEP_SECRET,
  mergeConfigPatch,
  materializeProfile,
  readConfigFile,
  readSystemProxy,
  redactConfig,
  resolveConfigPath,
  resolveLayers,
  writeConfigFile,
} from './config.js'
import { describeProxy, normalizeProxySpec, redactProxyUrl } from './proxy.js'
import {
  TransportController,
  createOwnDispatcher,
  directPolicy,
  httpPolicy,
  mergeNoProxy,
  resolveUndici,
  socksPolicy,
  undiciModule,
} from './transport.js'

/** Marker on every error this plugin raises deliberately. */
export const PROXY_ERROR_NAME = 'ProxySwitcherError'

/** A configuration problem the request cannot be sent under. */
export class ProxySwitcherError extends Error {
  /**
   * @param message - human-facing explanation.
   * @param code - stable machine code for the UI and tests.
   */
  constructor(message, code = 'proxy-error') {
    super(message)
    this.name = PROXY_ERROR_NAME
    this.code = code
  }
}

/** Transport error codes that indicate the PROXY failed, not the origin. */
const PROXY_FAILURE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EPROTO', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CLOSED', 'ERR_SOCKET_CONNECTION_TIMEOUT',
])

/**
 * Walk an error's `cause` chain collecting transport codes.
 * @param error - the rejection.
 * @param out - accumulator.
 * @param depth - recursion guard.
 * @returns the set of codes found.
 */
export function collectErrorCodes(error, out = new Set(), depth = 0) {
  if (error == null || depth > 8) return out
  if (typeof error.code === 'string') out.add(error.code)
  if (typeof error.errno === 'string') out.add(error.errno)
  if (error.cause && error.cause !== error) collectErrorCodes(error.cause, out, depth + 1)
  return out
}

/**
 * Render an error and its cause chain into one short, credential-free line.
 * @param error - the rejection or message.
 * @returns the display string.
 */
export function describeError(error) {
  if (error == null) return '未知错误'
  const codes = [...collectErrorCodes(error)]
  const head = error instanceof Error ? error.message : String(error)
  const suffix = codes.length > 0 ? ` [${codes.join(', ')}]` : ''
  return `${redactProxyUrl(head)}${suffix}`
}

/** Owns the effective outbound proxy policy for one dsh process. */
export class ProxySwitcher {
  /**
   * @param options.logger - a logger with info/warn/error methods.
   * @param options.configPath - override for the config file path.
   * @param options.seed - bundle-level seed values, above defaults and below the file.
   * @param options.transport - an injected TransportController (tests).
   */
  constructor(options = {}) {
    this.logger = options.logger ?? console
    this.configPath = resolveConfigPath(options.configPath)
    this.seed = options.seed ?? {}
    this.transport = options.transport ?? new TransportController({ logger: this.logger })
    /** Layer 1: values the settings page or command applied to THIS process only. */
    this.runtimeOverride = null
    /** Set when the automatic fallback engaged; cleared by any explicit apply. */
    this.fallbackActive = false
    this.lastError = null
    this.lastErrorAt = null
    this.lastSuccessAt = null
    this.appliedAt = null
    this.consecutiveProxyFailures = 0
    this.proxiedRequestCount = 0
    this.history = []
    this.configLoadError = null
    this.appliedPolicy = null
    this.ready = false
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Probe capabilities and install the persisted policy.
   * @returns a promise resolved once the first policy is in force.
   */
  async start() {
    await this.transport.detect()
    this.loadConfigFromDisk()
    const { config } = this.effectiveConfig()
    if (config.enabled) await this.applyPolicy()
    else await this.transport.restore({ quiet: true })
    this.ready = true
    this.appliedAt = Date.now()
    this.record('info', '代理切换器已启动')
    return this.status()
  }

  /** Restore the launch transport and release everything. */
  async stop() {
    await this.transport.restore({ quiet: true })
    this.record('info', '代理切换器已停止；已恢复启动时的传输')
    this.ready = false
  }

  // ------------------------------------------------------------------ config

  /** Read the config file into the base layer. */
  loadConfigFromDisk() {
    const loaded = readConfigFile(this.configPath)
    this.fileConfig = loaded.config
    this.configFileExists = loaded.exists
    this.configLoadError = loaded.error
    if (loaded.error) this.logger.warn?.(`dsh-proxy-switcher: ${loaded.error}`)
    return loaded
  }

  /**
   * Merge all four layers.
   * @returns `{ config, sources }`.
   */
  effectiveConfig() {
    if (this.fileConfig === undefined) this.loadConfigFromDisk()
    return resolveLayers({ ...this.seed, ...this.fileConfig }, { runtime: this.runtimeOverride })
  }

  /**
   * Persist a patch, then (by default) make it the effective policy at once.
   * @param patch - incoming document; an omitted password is preserved.
   * @param options.apply - set false to persist without applying.
   * @returns a promise for the resolution result.
   */
  async saveConfig(patch, options = {}) {
    const current = this.fileConfig ?? readConfigFile(this.configPath).config
    const merged = mergeConfigPatch(current, patch)
    writeConfigFile(this.configPath, merged)
    this.fileConfig = merged
    this.configFileExists = true
    this.configLoadError = null
    // The file is now authoritative for these fields, so a stale in-process
    // override must not keep winning over what the user just saved.
    if (this.runtimeOverride !== null) {
      this.runtimeOverride = null
    }
    this.fallbackActive = false
    this.consecutiveProxyFailures = 0
    const result = this.effectiveConfig()
    if (options.apply !== false) await this.applyPolicy()
    return result
  }

  /**
   * Apply a runtime-only override (this process, not persisted).
   * @param override - partial: enabled / mode / activeProfile / noProxy / url.
   * @returns a promise for the resolution result.
   */
  async applyRuntime(override) {
    const next = { ...(this.runtimeOverride ?? {}) }
    for (const [key, value] of Object.entries(override ?? {})) {
      if (value !== undefined) next[key] = value
    }
    this.runtimeOverride = next
    this.fallbackActive = false
    this.consecutiveProxyFailures = 0
    const result = this.effectiveConfig()
    await this.applyPolicy()
    return result
  }

  /**
   * Drop the runtime override so the environment/file layers win again.
   * @returns a promise for the resolution result.
   */
  async clearRuntimeOverride() {
    this.runtimeOverride = null
    this.fallbackActive = false
    const result = this.effectiveConfig()
    await this.applyPolicy()
    return result
  }

  // ----------------------------------------------------------------- policy

  /**
   * Resolve the config into a transport policy.
   * @param config - the effective config.
   * @returns `{ policy }` or `{ policy: null, error }` when the config cannot be used.
   */
  resolvePolicy(config) {
    if (!config.enabled) return { policy: directPolicy(mergeNoProxy(config.noProxy)), reason: '代理已关闭（enabled=false）' }
    if (this.fallbackActive) {
      return {
        policy: directPolicy(mergeNoProxy(config.noProxy)),
        reason: `连续 ${this.consecutiveProxyFailures} 次代理失败后自动回退`,
        fellBack: true,
      }
    }
    if (config.mode === 'direct') return { policy: directPolicy(mergeNoProxy(config.noProxy)), reason: 'mode=direct（直连）' }

    if (config.mode === 'system') {
      const system = readSystemProxy()
      const noProxy = mergeNoProxy(system.noProxy, config.noProxy)
      if (system.spec == null) return { policy: directPolicy(noProxy), reason: '未配置系统 / 环境变量代理' }
      if (system.spec.protocol === 'socks5') return { policy: socksPolicy(system.spec, noProxy, 'system'), reason: '环境变量 SOCKS5 代理' }
      return { policy: httpPolicy(system.spec, noProxy, 'system'), reason: '环境变量代理' }
    }

    const profile = config.profiles.find((entry) => entry.id === config.activeProfile)
    const materialized = materializeProfile(profile, process.env)
    if (materialized.spec == null) {
      // The English lead is kept verbatim: it is the wording the acceptance
      // suite matches on, and it names the condition exactly.
      const message = `no usable proxy is selected: ${materialized.error}`
      if (config.onMissingProfile === 'direct') {
        return { policy: directPolicy(mergeNoProxy(config.noProxy)), reason: `${message} — onMissingProfile=direct（直接放行）` }
      }
      return {
        policy: null,
        error: new ProxySwitcherError(
          `${message}。请在「设置 → Proxy」中选择一个代理，或把 onMissingProfile 设为 "direct"。`,
          'proxy-not-configured',
        ),
        reason: message,
      }
    }
    const noProxy = mergeNoProxy(profile?.noProxy, config.noProxy)
    const source = profile?.id === AD_HOC_PROFILE_ID ? 'env' : 'custom'
    const policy = materialized.spec.protocol === 'socks5'
      ? socksPolicy(materialized.spec, noProxy, source)
      : httpPolicy(materialized.spec, noProxy, source)
    return { policy, reason: `配置 ${profile?.id ?? '（无）'}`, profileId: profile?.id ?? null }
  }

  /**
   * Resolve and install the effective policy.
   * @returns a promise for the installed policy, or null when the config blocks.
   */
  async applyPolicy() {
    const { config } = this.effectiveConfig()
    const resolved = this.resolvePolicy(config)
    if (resolved.policy == null) {
      // Blocked configuration: keep the launch transport rather than guessing,
      // and surface the reason so the settings page can explain it.
      this.appliedPolicy = null
      this.lastError = resolved.reason
      this.lastErrorAt = Date.now()
      this.record('error', resolved.reason)
      return null
    }
    await this.transport.apply(resolved.policy)
    this.appliedPolicy = resolved.policy
    this.appliedAt = Date.now()
    this.record('info', `已应用 ${resolved.policy.kind === 'direct' ? '直连' : resolved.policy.label}（${resolved.reason}）`)
    return resolved.policy
  }

  /**
   * Re-resolve the policy from all four layers and install it again.
   *
   * This is how a change to the LAUNCH environment (`http_proxy` and friends)
   * reaches a running process in `system` mode: the installed transport is a
   * policy snapshot — that is the shipped seam's design, and it is what keeps one
   * source of truth — so picking up a new environment value is an explicit
   * re-apply rather than an implicit per-request read.
   *
   * @returns a promise for the installed policy, or null when the config blocks.
   */
  async reapply() {
    this.loadConfigFromDisk()
    const policy = await this.applyPolicy()
    this.appliedAt = Date.now()
    return policy
  }

  // ------------------------------------------------------------------ status

  /**
   * The status the settings page renders and `/proxy status` prints.
   * @returns a JSON-safe snapshot with no credentials.
   */
  status() {
    const { config, sources } = this.effectiveConfig()
    const resolved = this.resolvePolicy(config)
    const profile = config.profiles.find((entry) => entry.id === config.activeProfile) ?? null
    const system = readSystemProxy()
    const transport = this.transport.status()
    return {
      ready: this.ready,
      enabled: config.enabled,
      configuredMode: config.mode,
      mode: resolved.fellBack ? 'direct' : config.mode,
      effectiveKind: resolved.policy?.kind === 'proxied' ? 'proxied' : 'direct',
      effectiveProxy: resolved.policy?.kind === 'proxied' ? resolved.policy.label : '',
      effectiveSource: resolved.policy?.source ?? null,
      viaSocks: resolved.policy?.socks === true,
      reason: resolved.reason,
      blocked: resolved.policy == null,
      blockReason: resolved.policy == null ? resolved.reason : null,
      fellBack: this.fallbackActive === true,
      activeProfile: config.activeProfile,
      activeProfileName: profile?.name ?? null,
      noProxy: resolved.policy?.noProxy ?? '',
      configPath: this.configPath,
      configFileExists: this.configFileExists === true,
      configLoadError: this.configLoadError,
      sources,
      systemProxy: {
        url: system.spec ? describeProxy(system.spec).url : '',
        allProxy: system.allProxy ?? '',
        httpProxy: system.httpProxy ?? '',
        httpsProxy: system.httpsProxy ?? '',
        noProxy: system.noProxy ?? '',
        nodeUseEnvProxy: system.nodeUseEnvProxy ?? '',
      },
      transport,
      requestCount: this.proxiedRequestCount,
      consecutiveProxyFailures: this.consecutiveProxyFailures,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      appliedAt: this.appliedAt ? new Date(this.appliedAt).toISOString() : null,
      history: this.history.slice(-25),
      runtimeOverride: this.runtimeOverride,
    }
  }

  /** The redacted config document for the settings form. */
  publicConfig() {
    return redactConfig(this.effectiveConfig().config)
  }

  /** Append one credential-free history entry and mirror it to the logger. */
  record(level, message) {
    const entry = {
      at: new Date().toISOString(),
      level,
      mode: this.appliedPolicy?.kind === 'proxied' ? this.appliedPolicy.label : 'direct',
      message: redactProxyUrl(String(message)),
    }
    this.history.push(entry)
    const limit = this.effectiveConfig().config.historyLimit
    if (limit === 0) this.history = []
    else if (this.history.length > limit) this.history.splice(0, this.history.length - limit)
    if (level === 'error') this.logger.error?.(`dsh-proxy-switcher: ${entry.message}`)
    else if (level === 'warn') this.logger.warn?.(`dsh-proxy-switcher: ${entry.message}`)
    else this.logger.info?.(`dsh-proxy-switcher: ${entry.message}`)
    return entry
  }

  // -------------------------------------------------------------------- test

  /**
   * Probe connectivity through a candidate policy WITHOUT changing the live one.
   * The probe uses a throwaway dispatcher built from the candidate, so a slow or
   * broken candidate cannot disturb the transport real requests are using.
   *
   * @param candidate - `{ mode, profileId, url, protocol, host, port, username, password, noProxy }`.
   * @param options.probeUrl - override the configured probe endpoint.
   * @param options.timeoutMs - override the configured timeout.
   * @returns a structured, credential-free result.
   */
  async testConnection(candidate = {}, options = {}) {
    const { config } = this.effectiveConfig()
    const probeUrl = options.probeUrl || config.probeUrl
    const timeoutMs = Math.min(120_000, Number(options.timeoutMs ?? config.timeoutMs) || DEFAULT_CONFIG.timeoutMs)

    const resolved = this.resolveCandidate(candidate, config)
    if (resolved.error) {
      return { ok: false, probeUrl, target: resolved.label ?? '', via: resolved.via ?? '', message: resolved.error, errorCode: 'candidate-invalid', ms: 0 }
    }

    // The transport module owns dispatcher construction; ask it for a policy and
    // build a standalone one so nothing here touches the installed transport.
    const policy = resolved.policy
    const controller = new TransportController({ logger: { warn: () => {}, info: () => {}, error: () => {} } })
    await controller.detect()
    const standalone = createStandaloneDispatcher(policy)
    // The probe goes through the SAME undici instance that built the dispatcher,
    // never the built-in `fetch`: Node's built-in fetch carries its own undici
    // generation and rejects an explicitly passed newer-generation dispatcher
    // with UND_ERR_INVALID_ARG. This mirrors what dsh-web-fetch-http does.
    const probeFetch = undiciModule().fetch ?? fetch
    const started = Date.now()
    try {
      const response = await probeFetch(probeUrl, {
        dispatcher: standalone,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      })
      const ms = Date.now() - started
      const ok = response.status < 500
      // Drain so the socket is released before the probe closes its transport.
      try { await response.arrayBuffer() } catch { /* body size is irrelevant here */ }
      return {
        ok,
        probeUrl,
        target: policy.label,
        via: resolved.via,
        status: response.status,
        ms,
        message: ok
          ? `已连通，耗时 ${ms}ms（HTTP ${response.status}）`
          : `已连通到该地址，但它返回了 HTTP ${response.status}`,
        errorCode: null,
        transport: controller.strategyFor(policy),
      }
    } catch (error) {
      const ms = Date.now() - started
      return {
        ok: false,
        probeUrl,
        target: policy.label,
        via: resolved.via,
        status: null,
        ms,
        message: explainTestFailure(error, policy),
        errorCode: [...collectErrorCodes(error)][0] ?? error?.name ?? '未知',
        detail: describeError(error),
        transport: controller.strategyFor(policy),
      }
    } finally {
      Promise.resolve(standalone.close()).catch(() => {})
    }
  }

  /**
   * Turn a test candidate into a policy.
   * @param candidate - the request body from the settings page.
   * @param config - the effective config, for profile lookup.
   * @returns `{ policy, via }` or `{ error, via }`.
   */
  resolveCandidate(candidate, config) {
    if (candidate.url) {
      const spec = safeSpec(candidate.url)
      if (spec == null) return { error: `无法解析代理 URL ${JSON.stringify(redactProxyUrl(candidate.url))}`, via: 'ad-hoc' }
      const noProxy = mergeNoProxy(candidate.noProxy, config.noProxy)
      return { policy: spec.protocol === 'socks5' ? socksPolicy(spec, noProxy, 'custom') : httpPolicy(spec, noProxy, 'custom'), via: 'ad-hoc' }
    }
    if (candidate.host) {
      // A draft profile may name an environment variable instead of carrying a
      // password; resolve it here so "Test this proxy" exercises the same
      // credential the applied policy would use.
      const draft = { ...candidate }
      if (!draft.password && draft.passwordEnv) {
        const fromEnv = process.env[draft.passwordEnv]
        if (typeof fromEnv === 'string' && fromEnv !== '') draft.password = fromEnv
        else return { error: `配置中引用了 ${draft.passwordEnv}，但 dsh 的环境中未设置该变量`, via: 'draft' }
      }
      const spec = safeSpec(draft)
      if (spec == null) return { error: '该代理配置没有可用的主机', via: 'draft' }
      const noProxy = mergeNoProxy(draft.noProxy, config.noProxy)
      return { policy: spec.protocol === 'socks5' ? socksPolicy(spec, noProxy, 'custom') : httpPolicy(spec, noProxy, 'custom'), via: 'draft' }
    }

    const mode = candidate.mode ?? config.mode
    if (config.enabled === false || mode === 'direct') return { policy: directPolicy(mergeNoProxy(config.noProxy)), via: 'direct' }
    if (mode === 'system') {
      const system = readSystemProxy()
      if (system.spec == null) return { error: '未配置系统 / 环境变量代理（http_proxy、https_proxy、all_proxy 均未设置）', via: 'system' }
      const noProxy = mergeNoProxy(system.noProxy, config.noProxy)
      return { policy: system.spec.protocol === 'socks5' ? socksPolicy(system.spec, noProxy, 'system') : httpPolicy(system.spec, noProxy, 'system'), via: 'system' }
    }
    const id = candidate.profileId ?? config.activeProfile
    const profile = config.profiles.find((entry) => entry.id === id)
    if (profile == null) return { error: `未找到配置 ${JSON.stringify(id)}`, via: 'profile' }
    const materialized = materializeProfile(profile, process.env)
    if (materialized.spec == null) return { error: materialized.error, via: 'profile' }
    const noProxy = mergeNoProxy(profile.noProxy, config.noProxy)
    return {
      policy: materialized.spec.protocol === 'socks5'
        ? socksPolicy(materialized.spec, noProxy, 'custom')
        : httpPolicy(materialized.spec, noProxy, 'custom'),
      via: `profile ${profile.id}`,
    }
  }
}

/** `normalizeProxySpec` that returns null instead of throwing. */
function safeSpec(input) {
  try {
    return normalizeProxySpec(input)
  } catch {
    return null
  }
}

/**
 * A throwaway dispatcher for one probe.
 *
 * {@link createOwnDispatcher} already builds a per-origin agent from a policy
 * without installing anything process-wide, which is exactly what a side-effect
 * free probe needs — so the probe reuses it rather than growing a second
 * dispatcher builder.
 *
 * @param policy - the candidate policy.
 * @returns a fresh dispatcher the caller must close.
 */
function createStandaloneDispatcher(policy) {
  return createOwnDispatcher(policy)
}

/** Turn a transport failure into advice a user can act on. */
export function explainTestFailure(error, policy) {
  const codes = [...collectErrorCodes(error)]
  const proxied = policy?.kind === 'proxied'
  const where = proxied ? `代理 ${policy.label}` : '直连连接'
  // The English markers below are kept inline on purpose: they are the phrases
  // the acceptance suite matches on, and they are the terms a user will find in
  // the underlying Node/undici error.
  if (error?.name === 'TimeoutError' || codes.includes('UND_ERR_CONNECT_TIMEOUT') || codes.includes('ETIMEDOUT')) {
    return `连接 ${where} 超时（timed out）——请确认它已启动，且本机可以访问它。`
  }
  if (codes.includes('ECONNREFUSED')) return `连接被 ${where} 拒绝（connection refused）——该地址和端口上没有服务在监听。`
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) {
    return proxied
      ? `无法解析代理主机（DNS）：${describeProxy(policy.spec).url}`
      : `无法解析探测目标主机（DNS）——当前网络无法直连（DNS resolve failed）。`
  }
  if (/SOCKS5/i.test(String(error?.message))) return String(error.message)
  if (codes.includes('UND_ERR_SOCKET') || codes.includes('ECONNRESET')) {
    return `经由 ${where} 的连接被重置（reset）——代理可能拒绝该主机，或网络对其有阻断。`
  }
  if (codes.includes('CERT') || /certificate/i.test(String(error?.message))) return `经由 ${where} 时出现 TLS 证书问题（certificate）`
  return describeError(error)
}

export { KEEP_SECRET }

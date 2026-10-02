/**
 * dsh-proxy-switcher — host half.
 *
 * Mounts one process-wide outbound proxy policy that can be changed while dsh is
 * running. See README.md for the mechanism, and `transport.js` for why a global
 * undici dispatcher — not a `fetch` wrapper — is the hot-switch point.
 *
 * The plugin is additive and reversible:
 *   - it registers one HTTP route prefix and, when the services exist, one human
 *     command and one Cordis service;
 *   - it never edits dsh's own files or configuration;
 *   - on unload it restores the launch dispatcher and the launch proxy
 *     environment exactly, so disabling the row leaves dsh as it was.
 *
 * Nothing here throws into the host: a failure to start the switcher is logged
 * and reported through the plugin's own status, never propagated into boot.
 */
import { ProxySwitcher } from './switcher.js'
import { BASE_PATH, createHandler } from './routes.js'
import { DEFAULT_PROBE_URL } from './config.js'

/** Cordis plugin name; the loader row's `name` resolves this package. */
export const name = 'dsh-proxy-switcher'

/** Required services: none. Everything optional is acquired with `ctx.inject`. */
export const inject = []

/**
 * Mount the switcher.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - bundle-level seed values (lowest priority above the defaults).
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const switcher = new ProxySwitcher({
    logger,
    ...(config.configPath ? { configPath: config.configPath } : {}),
    seed: seedFromConfig(config),
  })

  // Serialize lifecycle transitions: a start that is still in flight must finish
  // before a stop runs, or a reload could leave the process with no dispatcher.
  let lifecycle = Promise.resolve()
  ctx.effect(() => {
    lifecycle = lifecycle
      .then(() => switcher.start())
      .then((status) => {
        logger.info?.(
          `dsh-proxy-switcher: 已就绪（mode=${status.configuredMode}, `
          + `proxy=${status.effectiveProxy || '无'}, strategy=${status.transport.strategy}）`,
        )
      })
      .catch((error) => {
        logger.error?.(`dsh-proxy-switcher: 启动失败: ${error?.message ?? error}`)
      })
    return () => {
      lifecycle = lifecycle
        .then(() => switcher.stop())
        .catch((error) => {
          logger.warn?.(`dsh-proxy-switcher: 停止时未能干净退出: ${error?.message ?? error}`)
        })
    }
  }, 'dsh-proxy-switcher: lifecycle')

  // ---- settings-page transport -------------------------------------------
  // Acquired through ctx.inject rather than a module-level `inject` entry: a
  // profile with no web server (a TUI profile) must still load this plugin, and
  // ctx.inject parks only this child fiber instead of the whole plugin.
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () => webCtx.webServer.register({
          kind: 'prefix',
          path: BASE_PATH,
          handler: createHandler(switcher, { logger }),
        }),
        'dsh-proxy-switcher: settings API',
      )
    })
  } catch (error) {
    logger.warn?.(`dsh-proxy-switcher: 没有可用的 web 服务，设置页面已禁用: ${error?.message ?? error}`)
  }

  // ---- /proxy command -----------------------------------------------------
  try {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.effect(
        () => commandCtx.commands.register({
          name: 'proxy',
          description: '查看或更改当前运行的 dsh 的出站代理（status | on | off | direct | system | use <id> | temp <id> | test [id]）',
          handler: (invocation) => runProxyCommand(switcher, invocation),
        }),
        'dsh-proxy-switcher: /proxy command',
      )
    })
  } catch (error) {
    logger.warn?.(`dsh-proxy-switcher: /proxy 命令不可用: ${error?.message ?? error}`)
  }

  // ---- plugin API for other plugins --------------------------------------
  // Other plugins (and the cordis inspect tools) can read or move the policy
  // without knowing about the HTTP surface.
  const api = {
    status: () => switcher.status(),
    config: () => switcher.publicConfig(),
    /** Persist a partial config and apply it. */
    configure: (patch) => switcher.saveConfig(patch),
    /** Apply a partial override to this process only. */
    applyRuntime: (patch) => switcher.applyRuntime(patch),
    /** Drop the process-only override. */
    reset: () => switcher.clearRuntimeOverride(),
    /** Probe a candidate without applying it. */
    test: (candidate, options) => switcher.testConnection(candidate, options),
    /** The underlying instance, for advanced use. */
    switcher,
  }
  try {
    ctx.provide('proxySwitcher', api)
  } catch (error) {
    logger.warn?.(`dsh-proxy-switcher: 无法发布 proxySwitcher 服务: ${error?.message ?? error}`)
  }
}

/**
 * Translate the bundle's `config` block into the switcher's seed layer.
 * Unknown keys are ignored rather than rejected, so a config written for a newer
 * version still loads.
 *
 * @param config - the raw config block.
 * @returns a partial config for the seed layer.
 */
function seedFromConfig(config) {
  const seed = {}
  if (['direct', 'system', 'custom'].includes(config.mode)) seed.mode = config.mode
  if (typeof config.activeProfile === 'string' && config.activeProfile) seed.activeProfile = config.activeProfile
  if (typeof config.noProxy === 'string') seed.noProxy = config.noProxy
  if (typeof config.probeUrl === 'string' && config.probeUrl) seed.probeUrl = config.probeUrl
  if (Number.isFinite(Number(config.timeoutMs))) seed.timeoutMs = Number(config.timeoutMs)
  if (typeof config.enabled === 'boolean') seed.enabled = config.enabled
  if (typeof config.onMissingProfile === 'string') seed.onMissingProfile = config.onMissingProfile
  if (config.fallbackMode === 'direct' || config.fallbackMode === 'off') {
    seed.fallback = { mode: config.fallbackMode, failureThreshold: Number(config.fallbackFailureThreshold) || 3 }
  }
  if (Array.isArray(config.profiles)) seed.profiles = config.profiles
  return seed
}

/**
 * Handle one `/proxy` invocation.
 *
 * The command is the non-GUI surface for the same operations, so it reports the
 * same facts the settings page shows and never prints a credential.
 *
 * @param switcher - the switcher instance.
 * @param invocation - the command invocation.
 * @returns a `CommandResult`.
 */
async function runProxyCommand(switcher, invocation) {
  const raw = String(invocation?.rawInput ?? '').trim()
  const [verb = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
  const argument = rest[0]

  try {
    switch (verb) {
      case 'status': {
        const status = switcher.status()
        if (status.blocked) {
          return { kind: 'error', text: `代理配置不可用：${status.blockReason}` }
        }
        return {
          kind: 'success',
          text: [
            `proxy mode      : ${status.configuredMode}${status.enabled ? '' : '（已禁用 — 直连）'}`,
            `effective       : ${status.effectiveKind === 'proxied' ? status.effectiveProxy : '直连（不使用代理）'}`,
            `via             : ${status.reason}`,
            `transport       : ${status.transport.strategy}${status.viaSocks ? ' (SOCKS5)' : ''}`,
            `active profile  : ${status.activeProfile ?? '（无）'}`,
            `no_proxy        : ${status.noProxy || '（空）'}`,
            `config file     : ${status.configPath}${status.configFileExists ? '' : '（尚未创建）'}`,
            status.lastError ? `last error      : ${status.lastError}` : 'last error      : 无',
          ].join('\n'),
        }
      }
      case 'on':
        await switcher.saveConfig({ enabled: true })
        return { kind: 'success', text: '已启用代理（已保存）。' }
      case 'off':
        await switcher.saveConfig({ enabled: false })
        return { kind: 'success', text: '已禁用代理——当前运行的 dsh 现在直连（已保存）。' }
      case 'direct':
        await switcher.saveConfig({ enabled: true, mode: 'direct' })
        return { kind: 'success', text: '已切换为直连（已保存）。' }
      case 'system':
        await switcher.saveConfig({ enabled: true, mode: 'system' })
        return { kind: 'success', text: '已切换为系统 / 环境变量代理（已保存）。' }
      case 'use': {
        if (!argument) return { kind: 'error', text: '用法：/proxy use <profile-id>。可用 id 见 /proxy status。' }
        const config = switcher.publicConfig()
        const profile = config.profiles.find((entry) => entry.id === argument)
        if (!profile) {
          const ids = config.profiles.map((entry) => entry.id).join(', ') || '（无已保存的代理）'
          return { kind: 'error', text: `没有名为 "${argument}" 的代理配置。已保存的代理：${ids}` }
        }
        await switcher.saveConfig({ enabled: true, mode: 'custom', activeProfile: profile.id })
        return { kind: 'success', text: `已切换为 "${profile.name}"（${profile.maskedUrl}）——已保存。` }
      }
      case 'temp': {
        if (!argument) return { kind: 'error', text: '用法：/proxy temp <profile-id|direct|system>' }
        if (argument === 'direct' || argument === 'system') {
          await switcher.applyRuntime({ enabled: true, mode: argument })
          return { kind: 'success', text: `已仅对本进程应用 ${argument.toUpperCase()}（未保存）。` }
        }
        const config = switcher.publicConfig()
        const profile = config.profiles.find((entry) => entry.id === argument)
        if (!profile) return { kind: 'error', text: `没有名为 "${argument}" 的代理配置。` }
        await switcher.applyRuntime({ enabled: true, mode: 'custom', activeProfile: profile.id })
        return { kind: 'success', text: `已仅对本进程应用 "${profile.name}"（未保存）。` }
      }
      case 'test': {
        const candidate = !argument ? {}
          : argument === 'direct' || argument === 'system' ? { mode: argument }
          : { profileId: argument }
        const result = await switcher.testConnection(candidate)
        const text = [
          `probe           : ${result.probeUrl}`,
          `target          : ${result.target}`,
          `result          : ${result.ok ? '成功' : '失败'} — ${result.message}`,
        ].join('\n')
        return { kind: result.ok ? 'success' : 'error', text }
      }
      default:
        return {
          kind: 'error',
          text: `未知的 /proxy 子命令 "${verb}"。可用：status | on | off | direct | system | use <id> | temp <id> | test [id]`,
        }
    }
  } catch (error) {
    return { kind: 'error', text: `/proxy ${verb} 执行失败：${error?.message ?? error}` }
  }
}

/** Re-exported so a test or another plugin can build a switcher without the GUI. */
export { ProxySwitcher, DEFAULT_PROBE_URL }

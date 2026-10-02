/**
 * Acceptance tests for the whole switcher: configuration in, real network
 * behaviour out.
 *
 * These drive the same object the plugin mounts — `ProxySwitcher` — through the
 * exact operations the settings page performs, and assert the traffic actually
 * moved. Every destination is a name that never resolves, so a request can only
 * succeed by leaving through the fake proxy that answers it.
 *
 * The list of assertions maps onto the agreed acceptance criteria:
 *   1. switch "use a proxy" on and off from configuration,
 *   2. choose direct / system / a saved proxy,
 *   3. direct mode behaves as the launch transport did,
 *   4. a new proxy takes effect with no restart,
 *   5. the status reports the mode and the proxy address,
 *   6. a broken configuration produces a clear, actionable error,
 *   7. the saved mode is what a restart restores,
 *   8. stopping the switcher leaves the process as it was.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHttpProxy, startOrigin } from './helpers/fake-proxy.mjs'
import { ProxySwitcher } from '../lib/switcher.js'
import { KEEP_SECRET } from '../lib/config.js'

const UNRESOLVABLE = 'http://example.invalid/probe'

/** Do a real request and report the body, or a tagged failure. */
async function bodyOf(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    return await response.text()
  } catch (error) {
    return `<error:${error?.cause?.code ?? error?.name}>`
  }
}

/** A logger that records nothing but keeps the plugin's noise out of test output. */
const quietLogger = { info() {}, warn() {}, error() {} }

/** Build a switcher backed by a throwaway config file. */
function makeSwitcher(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshps-accept-'))
  const configPath = join(dir, 'proxy-switcher.json')
  const switcher = new ProxySwitcher({ logger: quietLogger, configPath, ...extra })
  return { switcher, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('acceptance 1,3,4,5: enable a proxy, apply it live, then go direct again', async () => {
  const proxy = await startHttpProxy({ tag: 'via-acceptance-proxy' })
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()

    // A saved profile, saved exactly as the settings page would save it.
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      noProxy: 'localhost',
      profiles: [{ id: 'p1', name: 'Test proxy', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
      activeProfile: 'p1',
    })

    // (4) It took effect immediately: the very next request leaves through it.
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-acceptance-proxy')

    // (5) The status reports the mode and the address, with no credentials.
    const status = switcher.status()
    assert.equal(status.configuredMode, 'custom')
    assert.equal(status.enabled, true)
    assert.equal(status.effectiveKind, 'proxied')
    assert.equal(status.effectiveProxy, `http://127.0.0.1:${proxy.port}`)
    assert.equal(status.activeProfileName, 'Test proxy')
    assert.equal(status.transport.strategy, 'delegate')

    // (3) Direct mode: no proxy is reachable any more.
    await switcher.saveConfig({ enabled: true, mode: 'direct' })
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'direct mode must not reach the proxy')
    assert.equal(switcher.status().effectiveKind, 'direct')

    // (1) The master switch off is direct too.
    await switcher.saveConfig({ enabled: true, mode: 'custom', activeProfile: 'p1' })
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-acceptance-proxy', 're-enabling must work after direct')
    await switcher.saveConfig({ enabled: false })
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'disabling the proxy must go direct')
    assert.equal(switcher.status().enabled, false)
  } finally {
    await switcher.stop()
    cleanup()
    await proxy.close()
  }
})

test('acceptance 2: direct / system / saved proxy are all selectable', async () => {
  const proxy = await startHttpProxy({ tag: 'via-system-env' })
  const origin = await startOrigin()
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()

    // system: follows the ambient proxy environment.
    const savedEnv = { ...process.env }
    process.env.http_proxy = `http://127.0.0.1:${proxy.port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    delete process.env.all_proxy
    delete process.env.ALL_PROXY
    process.env.no_proxy = 'localhost'
    try {
      await switcher.saveConfig({ enabled: true, mode: 'system', profiles: [] })
      assert.equal(await bodyOf(UNRESOLVABLE), 'via-system-env', 'system mode must follow the environment')
      assert.equal(switcher.status().effectiveSource, 'system')

      // The installed transport follows a policy SNAPSHOT — that is the shipped
      // seam's design, and the reason there is one source of truth — so an edited
      // environment value arrives through an explicit re-apply.
      process.env.http_proxy = 'http://127.0.0.1:1'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
      assert.equal(await bodyOf(UNRESOLVABLE), 'via-system-env', 'a policy snapshot must not shift under our feet')

      await switcher.reapply()
      assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'reapply() must pick up the rotated environment value')
    } finally {
      for (const key of ['http_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy']) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
    }

    // A local origin proves the direct transport is genuinely usable afterwards.
    await switcher.saveConfig({ enabled: true, mode: 'direct' })
    assert.equal(await bodyOf(origin.url), 'via-origin', 'direct mode must still reach normal origins')
  } finally {
    await switcher.stop()
    cleanup()
    await proxy.close()
    await origin.close()
  }
})

test('acceptance 6: an unusable configuration fails loudly and explains itself', async () => {
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    await switcher.saveConfig({ enabled: true, mode: 'custom', profiles: [], activeProfile: null })

    const status = switcher.status()
    assert.equal(status.blocked, true)
    assert.match(status.blockReason, /no usable proxy is selected/)
    assert.match(switcher.lastError, /no usable proxy is selected/)

    // The default posture refuses rather than silently leaking traffic direct.
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/)

    // onMissingProfile=direct turns the refusal into a documented fallback.
    await switcher.saveConfig({ onMissingProfile: 'direct' })
    const relaxed = switcher.status()
    assert.equal(relaxed.blocked, false)
    assert.equal(relaxed.effectiveKind, 'direct')
  } finally {
    await switcher.stop()
    cleanup()
  }
})

test('acceptance 6b: a broken proxy is reported with an actionable message', async () => {
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    // Port 9 is the discard port: nothing listens there.
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 'dead',
      timeoutMs: 3000,
      profiles: [{ id: 'dead', name: 'Dead proxy', protocol: 'http', host: '127.0.0.1', port: 9 }],
    })
    const result = await switcher.testConnection({ profileId: 'dead' })
    assert.equal(result.ok, false)
    assert.match(result.message, /connection refused|timed out|reset/i)
    assert.equal(result.target, 'http://127.0.0.1:9')

    // A profile naming an unset environment variable says exactly that.
    await switcher.saveConfig({
      profiles: [{ id: 'envpw', name: 'Needs env', protocol: 'http', host: '127.0.0.1', port: 3128, passwordEnv: 'NOT_SET_ANYWHERE' }],
    })
    const missing = await switcher.testConnection({ profileId: 'envpw' })
    assert.equal(missing.ok, false)
    assert.match(missing.message, /NOT_SET_ANYWHERE/)
  } finally {
    await switcher.stop()
    cleanup()
  }
})

test('acceptance 7: the saved mode is what a restart restores', async () => {
  const proxy = await startHttpProxy({ tag: 'via-persisted' })
  const dir = mkdtempSync(join(tmpdir(), 'dshps-restart-'))
  const configPath = join(dir, 'proxy-switcher.json')
  try {
    const first = new ProxySwitcher({ logger: quietLogger, configPath })
    await first.start()
    await first.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 'saved',
      profiles: [{ id: 'saved', name: 'Saved', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
    })
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-persisted')
    // The temporary switch must NOT be what persists.
    await first.applyRuntime({ mode: 'direct' })
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'the runtime override applies to this process')
    await first.stop()

    // The persisted document still describes the saved proxy.
    const document = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(document.mode, 'custom')
    assert.equal(document.activeProfile, 'saved')

    // A fresh instance — a restart — comes back on the saved proxy.
    const second = new ProxySwitcher({ logger: quietLogger, configPath })
    await second.start()
    assert.equal(second.status().effectiveProxy, `http://127.0.0.1:${proxy.port}`)
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-persisted', 'a restart must restore the saved proxy')
    await second.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await proxy.close()
  }
})

test('acceptance 8: stopping the switcher leaves the launch transport in place', async () => {
  const proxy = await startHttpProxy({ tag: 'via-temp' })
  const origin = await startOrigin()
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 'p',
      profiles: [{ id: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
    })
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-temp')

    await switcher.stop()
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/, 'the proxy must be gone after stop')
    assert.equal(await bodyOf(origin.url), 'via-origin', 'the transport must still work after stop')
  } finally {
    await switcher.stop()
    cleanup()
    await proxy.close()
    await origin.close()
  }
})

test('a runtime override is process-only, and clearing it restores the file layer', async () => {
  const proxy = await startHttpProxy({ tag: 'via-file-layer' })
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 'p',
      profiles: [{ id: 'p', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
    })

    await switcher.applyRuntime({ mode: 'direct' })
    assert.equal(switcher.status().runtimeOverride.mode, 'direct')
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/)

    await switcher.clearRuntimeOverride()
    assert.equal(switcher.status().runtimeOverride, null)
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-file-layer', 'clearing the override returns to the saved proxy')
  } finally {
    await switcher.stop()
    cleanup()
    await proxy.close()
  }
})

test('the environment layer beats the file, and DSH_PROXY_SWITCHER_URL wins outright', async () => {
  const proxy = await startHttpProxy({ tag: 'via-env-url' })
  const { switcher, cleanup } = makeSwitcher()
  const saved = { ...process.env }
  try {
    await switcher.start()
    await switcher.saveConfig({ enabled: true, mode: 'direct' })
    assert.match(await bodyOf(UNRESOLVABLE), /^<error:/)

    process.env.DSH_PROXY_SWITCHER_URL = `http://127.0.0.1:${proxy.port}`
    // The environment is read per resolution, so a reload is enough — no restart.
    switcher.loadConfigFromDisk()
    await switcher.applyPolicy()
    assert.equal(switcher.status().configuredMode, 'custom')
    assert.equal(await bodyOf(UNRESOLVABLE), 'via-env-url', 'DSH_PROXY_SWITCHER_URL must take effect live')
  } finally {
    if (saved.DSH_PROXY_SWITCHER_URL === undefined) delete process.env.DSH_PROXY_SWITCHER_URL
    else process.env.DSH_PROXY_SWITCHER_URL = saved.DSH_PROXY_SWITCHER_URL
    await switcher.stop()
    cleanup()
    await proxy.close()
  }
})

test('a stored password survives a save that does not retype it', async () => {
  const proxy = await startHttpProxy({ tag: 'via-password' })
  const { switcher, configPath, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 'pw',
      profiles: [{ id: 'pw', protocol: 'http', host: '127.0.0.1', port: proxy.port, username: 'u', password: 'stored-secret' }],
    })
    // The browser never receives it...
    const publicView = switcher.publicConfig()
    assert.equal(publicView.profiles[0].password, '')
    assert.equal(JSON.stringify(publicView).includes('stored-secret'), false)

    // ...and sending the sentinel back keeps it.
    await switcher.saveConfig({ profiles: [{ id: 'pw', protocol: 'http', host: '127.0.0.1', port: proxy.port, username: 'u', password: KEEP_SECRET }] })
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).profiles[0].password, 'stored-secret')
  } finally {
    await switcher.stop()
    cleanup()
    await proxy.close()
  }
})

test('the persisted file never becomes a place a credential leaks into a log line', async () => {
  const { switcher, cleanup } = makeSwitcher()
  try {
    await switcher.start()
    await switcher.saveConfig({
      enabled: true,
      mode: 'custom',
      activeProfile: 's',
      profiles: [{ id: 's', protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'user', password: 'hunter2' }],
    })
    const serialised = JSON.stringify(switcher.status())
    assert.equal(serialised.includes('hunter2'), false, 'status must never carry a password')
    assert.equal(serialised.includes('user:***@'), true, 'the masked form is what the status reports')
    const error = new (class extends Error {
      constructor() { super('failed to reach http://user:hunter2@127.0.0.1:1080'); this.code = 'ECONNREFUSED' }
    })()
    switcher.record('warn', error.message)
    assert.equal(JSON.stringify(switcher.status().history).includes('hunter2'), false, 'history must be redacted')
  } finally {
    await switcher.stop()
    cleanup()
  }
})

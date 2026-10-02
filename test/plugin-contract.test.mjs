/**
 * Contract tests for the two plugin halves.
 *
 * A dsh restart is the only way to load a real plugin into a live harness, so
 * these drive `lib/index.js` and `lib/client.js` against a fake Cordis context
 * and a fake browser module loader. They are what catches "the plugin mounts but
 * does nothing" — an undeclared slot parks silently forever, and a factory that
 * throws costs the whole page.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startHttpProxy } from './helpers/fake-proxy.mjs'

/** A Cordis-like context good enough for the host half's apply(). */
function fakeHostContext() {
  const state = { routes: [], commands: [], provided: new Map(), effects: [], disposers: [] }
  const make = (overrides = {}) => {
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      effect(fn, label) {
        const result = fn()
        state.effects.push(label)
        const dispose = typeof result === 'function' ? result : () => {}
        state.disposers.push(dispose)
        return () => { void dispose() }
      },
      inject(names, callback) {
        const child = make()
        state.injected = [...(state.injected ?? []), ...names]
        state.effects.push(`inject(${names.join(',')})`)
        callback(child)
      },
      provide(name, value) {
        state.provided.set(name, value)
        state.disposers.push(() => state.provided.delete(name))
        return () => state.provided.delete(name)
      },
      ...overrides,
    }
    return ctx
  }
  const root = make()
  // Services the plugin acquires through ctx.inject.
  root.__state = state
  return { ctx: root, state, makeChild: make }
}

test('the host half exports the Cordis plugin contract', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-proxy-switcher')
  assert.deepEqual(mod.inject, [], 'nothing is mandatory, so a profile without a web server still loads it')
  assert.equal(typeof mod.apply, 'function')
})

test('the host half mounts a route, a command and a service, and unmounts cleanly', async () => {
  const mod = await import('../lib/index.js')
  const state = { routes: [], commands: [], provided: new Map(), effects: [], disposers: [] }
  const configPath = join(mkdtempSync(join(tmpdir(), 'dshps-host-')), 'proxy-switcher.json')

  /** A child context wired to the shared recorder. */
  const child = () => ({
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      const result = fn()
      state.effects.push(label)
      const dispose = typeof result === 'function' ? result : () => {}
      state.disposers.push(dispose)
      return () => { void dispose() }
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => { state.routes = state.routes.filter((r) => r !== route) }
      },
    },
    commands: {
      register(definition) {
        state.commands.push(definition)
        return () => { state.commands = state.commands.filter((c) => c !== definition) }
      },
    },
  })

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn, label) {
      const result = fn()
      state.effects.push(label)
      const dispose = typeof result === 'function' ? result : () => {}
      state.disposers.push(dispose)
      return () => { void dispose() }
    },
    inject(names, callback) { callback(child()) },
    provide(name, value) {
      state.provided.set(name, value)
      return () => state.provided.delete(name)
    },
  }

  try {
    mod.apply(ctx, { configPath })
    // Let the serialized lifecycle (start -> ready) settle.
    await new Promise((resolve) => setTimeout(resolve, 400))

    assert.equal(state.routes.length, 1, 'exactly one route prefix must be registered')
    assert.equal(state.routes[0].kind, 'prefix')
    assert.equal(state.routes[0].path, '/dsh-proxy-switcher')
    assert.equal(typeof state.routes[0].handler, 'function')

    assert.equal(state.commands.length, 1)
    assert.equal(state.commands[0].name, 'proxy')
    assert.equal(typeof state.commands[0].handler, 'function')

    assert.equal(state.provided.has('proxySwitcher'), true, "other plugins must be able to reach the API")
    const api = state.provided.get('proxySwitcher')
    assert.equal(typeof api.status, 'function')
    assert.equal(typeof api.configure, 'function')
    assert.equal(typeof api.test, 'function')
    // The service is usable without the web surface.
    const status = api.status()
    assert.equal(status.ready, true)
    assert.equal(typeof status.effectiveKind, 'string')
    assert.equal(status.configPath, configPath)

    // The command reports the same facts the page shows, with no credentials.
    const result = await state.commands[0].handler({ rawInput: ' status', commandId: 'c1', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /proxy mode/)
    assert.match(result.text, /effective/)
    const bad = await state.commands[0].handler({ rawInput: ' nonsense', commandId: 'c2', signal: new AbortController().signal })
    assert.equal(bad.kind, 'error')
  } finally {
    for (const dispose of state.disposers) {
      try { await dispose() } catch { /* teardown must not throw */ }
    }
  }
  assert.equal(state.routes.length, 0, 'unloading must remove the route')
})

test('the host half’s route handler enforces same-origin and answers every action', async () => {
  const { createHandler, isAuthorized, sendJson } = await import('../lib/routes.js')
  const proxy = await startHttpProxy({ tag: 'via-route-test' })
  const configPath = join(mkdtempSync(join(tmpdir(), 'dshps-route-')), 'proxy-switcher.json')
  const { ProxySwitcher } = await import('../lib/switcher.js')
  const switcher = new ProxySwitcher({ logger: { info() {}, warn() {}, error() {} }, configPath })
  await switcher.start()
  const handler = createHandler(switcher, { logger: { info() {}, warn() {}, error() {} } })

  /** Minimal IncomingMessage/ServerResponse doubles. */
  function call(method, path, body, headers = {}) {
    const request = {
      method,
      url: path,
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...headers },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    }
    let status = 0
    let payload = ''
    const response = {
      writeHead(code) { status = code },
      end(text) { payload = text ?? '' },
    }
    return handler(request, response).then(() => ({ status, json: payload === '' ? null : JSON.parse(payload) }))
  }

  try {
    // Same-origin policy.
    assert.equal(isAuthorized({ headers: { host: '127.0.0.1:3080' } }), true, 'a loopback caller with no Origin is allowed')
    assert.equal(isAuthorized({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } }), false)
    assert.equal(isAuthorized({ headers: { host: 'example.com' } }), false, 'a non-loopback authority is refused')

    const state = await call('GET', '/dsh-proxy-switcher/state')
    assert.equal(state.status, 200)
    assert.equal(typeof state.json.status, 'object')
    assert.equal(typeof state.json.config, 'object')

    const forbidden = await call('GET', '/dsh-proxy-switcher/state', undefined, { origin: 'http://evil.example' })
    assert.equal(forbidden.status, 403)

    const applied = await call('POST', '/dsh-proxy-switcher/apply', {
      persist: true,
      config: {
        enabled: true, mode: 'custom', activeProfile: 'r',
        profiles: [{ id: 'r', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
      },
    })
    assert.equal(applied.status, 200)
    assert.equal(applied.json.persisted, true)
    assert.equal(applied.json.status.effectiveProxy, `http://127.0.0.1:${proxy.port}`)

    // The applied policy is real: the fake proxy answers.
    const response = await fetch('http://example.invalid/x', { signal: AbortSignal.timeout(6000) })
    assert.equal(await response.text(), 'via-route-test')

    const tested = await call('POST', '/dsh-proxy-switcher/test', { candidate: {} })
    assert.equal(tested.status, 200)
    assert.equal(typeof tested.json.ok, 'boolean', 'a failed probe is a 200 with ok=false, not a transport error')

    const reapplied = await call('POST', '/dsh-proxy-switcher/reapply', {})
    assert.equal(reapplied.status, 200)

    const reset = await call('POST', '/dsh-proxy-switcher/reset', {})
    assert.equal(reset.status, 200)

    const unknown = await call('GET', '/dsh-proxy-switcher/nonsense')
    assert.equal(unknown.status, 404)

    const nonsense = await call('POST', '/dsh-proxy-switcher/apply', 'not-an-object')
    // A body of the wrong shape is ignored rather than fatal: the settings page
    // must not be able to brick the process transport with a bad payload.
    assert.equal(nonsense.status, 200)
    assert.equal(nonsense.json.status.configPath, configPath)
  } finally {
    await switcher.stop()
    await proxy.close()
  }
})

test('the client half is a classic script registering a synchronous factory', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id:\s*"dsh-proxy-switcher"/)
  // Only the platform seed words may be required.
  const required = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(required)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('the client half registers a Proxy page on the settings.section slot', async () => {
  const profileDir = process.env.DSH_PROFILE_DIR
    ?? `${process.env.DSH_HOME ?? join(homedir(), '.dsh')}/profiles/desktop`
  const require = createRequire(`${profileDir}/package.json`)

  // A fake loader sink that captures the factory exactly as the shell would.
  let handoff = null
  const registrations = []
  const injects = []
  const seed = {
    react: require('react'),
    // A stand-in for the real primitives: the page must not depend on their
    // internals, only on the four components it uses.
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: (props) => require('react').createElement('button', props, props.children),
      StateDot: (props) => require('react').createElement('span', { 'data-state': props.state }),
      Input: (props) => require('react').createElement('input', props),
      Toast: () => null,
    },
  }
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { handoff = value } },
  }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // eslint-disable-next-line no-new-func -- the bundle is a classic script by design
  new Function('window', 'require', source)(globalThis.window, (spec) => {
    if (!(spec in seed)) throw new Error(`unexpected require("${spec}")`)
    return seed[spec]
  })

  assert.notEqual(handoff, null, 'the script must register a factory')
  assert.equal(handoff.id, 'dsh-proxy-switcher')
  assert.equal(typeof handoff.factory, 'function')

  const exports = handoff.factory((spec) => {
    if (!(spec in seed)) throw new Error(`unexpected require("${spec}")`)
    return seed[spec]
  })
  assert.equal(exports.name, 'dsh-proxy-switcher')
  assert.deepEqual(exports.inject, ['slots'], 'only the slot registry is required')

  /** A slot registry double that records the registration. */
  const ctx = {
    logger: { warn() {}, info() {} },
    slots: {
      inject(key, callback) {
        injects.push(key)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.deepEqual(injects, ['settings.section'], 'the page must wait for the declared slot')
  assert.equal(registrations.length, 1)
  const { options, component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'proxy')
  assert.equal(typeof options.order, 'number')
  assert.equal(options.label(), 'Proxy')
  assert.equal(typeof component, 'function', 'the registration must carry a component')
  assert.equal(typeof options.inject(), 'object')

  // Rendering the component must not throw. It renders its loading state here
  // because effects do not run under renderToString; the point is that it is a
  // valid function component with a working seed-require path.
  const { renderToString } = require('react-dom/server')
  const html = renderToString(require('react').createElement(component, {}))
  assert.match(html, /Loading proxy settings|Proxy settings unavailable|dshps-root/)
})

test('a missing UI primitive degrades to a no-op instead of breaking the page', async () => {
  let handoff = null
  globalThis.window = { __ModuleLoader__: { load: (value) => { handoff = value } } }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  new Function('window', 'require', source)(globalThis.window, () => { throw new Error('no seed') })
  const exports = handoff.factory(() => { throw new Error('no seed') })
  const warnings = []
  exports.apply({ logger: { warn: (m) => warnings.push(String(m)) } })
  assert.equal(warnings.some((w) => /react is unavailable/.test(w)), true)
})
